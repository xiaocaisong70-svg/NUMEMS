import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rename,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {atomicJson,readJson} from '../scripts/agentless/journal.mjs';
const busy=code=>Object.assign(new Error('synthetic rename busy'),{code});
async function fixture(t){const directory=await mkdtemp(path.join(os.tmpdir(),'numems-json-busy-'));
  t.after(async()=>{const r=path.relative(os.tmpdir(),directory);assert.ok(r&&!r.startsWith('..')&&!path.isAbsolute(r));await rm(directory,{recursive:true,force:true});});
  const file=path.join(directory,'evidence.json');await writeFile(file,JSON.stringify({phase:'original',lease:'retained'}));return{directory,file};}

test('transient Windows rename conflicts retry one immutable temp and preserve the complete old target until atomic commit',async t=>{
  const f=await fixture(t),paths=[],delays=[],contents=[];let ms=0;
  const value={phase:'completing',operationId:'original-operation',nested:{evidence:'verified'}};
  await atomicJson(f.file,value,{platform:'win32',now:()=>ms,sleep:async n=>{delays.push(n);ms+=n;},
    renameFile:async(tmp,file)=>{paths.push([tmp,file]);contents.push(await readFile(tmp,'utf8'));
      assert.deepEqual(await readJson(file),{phase:'original',lease:'retained'});
      if(paths.length<=3)throw busy(['EPERM','EACCES','EBUSY'][paths.length-1]);await rename(tmp,file);}});
  assert.equal(paths.length,4);assert.equal(new Set(paths.map(p=>p[0])).size,1);
  assert.ok(paths.every(p=>p[1]===f.file));assert.equal(new Set(contents).size,1);
  assert.deepEqual(delays,[10,20,40]);assert.deepEqual(await readJson(f.file),value);
  assert.deepEqual(await readdir(f.directory),['evidence.json']);
});

test('persistent Windows sharing denial is bounded and retains original target plus the same complete temp as evidence',async t=>{
  const f=await fixture(t),error=busy('EPERM'),paths=[],delays=[];let ms=0;
  await assert.rejects(atomicJson(f.file,{phase:'new-evidence'},{platform:'win32',now:()=>ms,
    sleep:async n=>{delays.push(n);ms+=n;},renameFile:async(tmp,file)=>{paths.push([tmp,file]);throw error;}}),e=>e===error);
  assert.equal(paths.length,7);assert.equal(new Set(paths.map(p=>p[0])).size,1);
  assert.equal(delays.reduce((n,x)=>n+x,0),430);assert.ok(ms<500);
  assert.deepEqual(await readJson(f.file),{phase:'original',lease:'retained'});
  assert.deepEqual(await readJson(paths[0][0]),{phase:'new-evidence'});
  assert.equal((await readdir(f.directory)).length,2);
});

test('non-sharing errors and non-Windows platforms never retry or replace/delete the old target',async t=>{
  for(const [platform,code] of [['win32','ENOENT'],['win32','EIO'],['win32','EXDEV'],['linux','EPERM'],['darwin','EBUSY']]){
    const f=await fixture(t),error=busy(code);let attempts=0;
    await assert.rejects(atomicJson(f.file,{kept:'temp'},{platform,renameFile:async()=>{attempts++;throw error;},
      sleep:async()=>assert.fail('unexpected retry')}),e=>e===error);
    assert.equal(attempts,1);assert.deepEqual(await readJson(f.file),{phase:'original',lease:'retained'});
    assert.equal((await readdir(f.directory)).length,2);
  }
});

test('elapsed I/O time or an overslept timer cannot admit another rename beyond the 500ms retry window',async t=>{
  for(const scenario of ['io-budget-used','timer-overslept','clock-regressed']){
    const f=await fixture(t),error=busy('EBUSY');let attempts=0,ms=0,sleeps=0;
    await assert.rejects(atomicJson(f.file,{kept:'temp'},{platform:'win32',now:()=>ms,
      renameFile:async()=>{attempts++;if(scenario==='io-budget-used')ms=495;throw error;},
      sleep:async()=>{sleeps++;ms=scenario==='clock-regressed'?-1:501;}}),e=>e===error);
    assert.equal(attempts,1);assert.equal(sleeps,scenario==='io-budget-used'?0:1);
    assert.deepEqual(await readJson(f.file),{phase:'original',lease:'retained'});
  }
});

test('concurrent producers keep separate immutable temps; busy retries are commit-only and do not promise CAS or writer ordering',async t=>{
  const f=await fixture(t),paths=new Map(),firstWrites=new Set(),commits=[];
  const options={platform:'win32',sleep:async()=>{},renameFile:async(tmp,file)=>{
    const payload=await readJson(tmp),prior=paths.get(payload.writer);if(prior)assert.equal(tmp,prior);else paths.set(payload.writer,tmp);
    const current=await readJson(file);assert.ok(current.phase==='original'||['A','B'].includes(current.writer));
    if(!firstWrites.has(tmp)){firstWrites.add(tmp);throw busy('EPERM');}
    await rename(tmp,file);commits.push(payload.writer);
  }};
  await Promise.all(['A','B'].map(writer=>atomicJson(f.file,{writer,payload:'x'.repeat(4096)},options)));
  assert.equal(paths.size,2);assert.equal(new Set(paths.values()).size,2);assert.equal(commits.length,2);
  const final=await readJson(f.file);assert.ok(['A','B'].includes(final.writer));assert.equal(final.payload,'x'.repeat(4096));
  assert.deepEqual(await readdir(f.directory),['evidence.json']);
});
