import test from 'node:test';import assert from 'node:assert/strict';
import path from 'node:path';import os from 'node:os';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {verifyBackup,rollbackV13,optionsFromArgs,localRollbackGate,nativeRollbackGate,cloudRollbackGate,V13_BACKUP} from '../scripts/agentless/rollback-v13.mjs';
const backup='D:/codexspace/reports/agentless-before-v14-20261028',now=Date.now();
const at=new Date(now).toISOString(),hash=b=>createHash('sha256').update(b).digest('hex');
const native=async()=>({supported:true,processes:[],tasks:[{name:'NUMEMS-Agentless',state:'Disabled'}]});
const cloudReport=()=>({command:'rollback-status',startedAt:at,finishedAt:at,success:true,modelCalls:0,
  result:{revision:10,schedulerEnabled:false,memberEnabled:false,busy:false,holds:0,faultRescue:null,incompatiblePending:1}});
async function fixture() {
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-v14-rollback-test-')),target=path.join(directory,'target'),archive=path.join(directory,'archive');
  const manifest=await verifyBackup(backup);await mkdir(target,{recursive:true});
  for(const item of manifest.files){const to=path.join(target,...item.path.split('/'));await mkdir(path.dirname(to),{recursive:true});await copyFile(path.join(backup,'canonical',...item.path.split('/')),to);}
  const runtime=path.join(target,'.sites-runtime','agentless');await mkdir(path.join(runtime,'browser'),{recursive:true});
  const config={siteUrl:'https://numems-seat-portal-agentless.workspace-026021.chatgpt.site/',adminEmail:'xiaocaisong70@gmail.com',
    workspaceId:'cd01c344-8ff9-41fd-a750-f7b30af9a7c9',profile:path.join(runtime,'browser'),liveActions:true,customPreserved:'keep',faultRescue:{enabled:true}};
  const save=async(name,value)=>writeFile(path.join(runtime,name),JSON.stringify(value));
  await save('config.json',config);await save('stop-result.json',{state:'stopped',modelCalls:0,startedAt:at,finishedAt:at});
  await save('operation.json',{phase:'settled',updatedAt:at});await save('host-desktop.json',{state:'exited',processId:12345});
  await save('fault-rescue.json',{version:1,phase:'finished',agentStopped:true,outcome:'unresolved',ticket:{id:'rescue_test',token:'synthetic-preserved-secret'}});
  await writeFile(path.join(runtime,'browser','synthetic-cookie.dat'),'fabricated-cookie-bytes');
  const options={targetRoot:target,backupDir:path.resolve(backup),archiveDir:archive,apply:true,verifyCloud:true};
  const deps={native,cloud:async()=>cloudReport(),now:()=>now};
  return {directory,target,archive,runtime,manifest,options,deps,save,async close(){const relative=path.relative(os.tmpdir(),directory);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(directory,{recursive:true,force:true});}};
}
test('canonical V13 manifest, Git blobs, byte counts and bundle are pinned',async()=>{
  const manifest=await verifyBackup(backup);assert.equal(manifest.files.length,300);assert.equal(manifest.sourceCommit,V13_BACKUP.commit);
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-v14-corrupt-backup-'));
  try{await copyFile(path.join(backup,'manifest.json'),path.join(dir,'manifest.json'));await copyFile(path.join(backup,'source-v13.bundle'),path.join(dir,'source-v13.bundle'));
    await mkdir(path.join(dir,'canonical'));await writeFile(path.join(dir,'canonical','.gitignore'),'tampered');await assert.rejects(()=>verifyBackup(dir),/hash verification/);
    await writeFile(path.join(dir,'manifest.json'),'{}');await assert.rejects(()=>verifyBackup(dir),/manifest hash mismatch/);
  }finally{assert.ok(path.relative(os.tmpdir(),dir).startsWith('numems-v14-'));await rm(dir,{recursive:true,force:true});}
});
test('default check never writes or opens browser; apply needs explicit roots and fresh cloud verification',async()=>{
  assert.equal(optionsFromArgs([]).apply,false);assert.throws(()=>optionsFromArgs(['--apply']),/explicit/);
  assert.throws(()=>optionsFromArgs(['--check','--check']),/Duplicate/);
  const f=await fixture();try{const before=await readFile(path.join(f.runtime,'config.json'));let called=0;
    const report=await rollbackV13({...f.options,apply:false,verifyCloud:false},{...f.deps,cloud:async()=>{called++;throw new Error('must not run');}});
    assert.equal(report.requiresFreshCloudProof,true);assert.equal(report.changed,false);assert.equal(called,0);
    assert.deepEqual(await readFile(path.join(f.runtime,'config.json')),before);await assert.rejects(()=>lstat(f.archive),/ENOENT/);
    await assert.rejects(()=>rollbackV13({...f.options,targetRoot:'relative'},f.deps),/Absolute/);
    await assert.rejects(()=>rollbackV13({...f.options,archiveDir:path.join(f.target,'archive')},f.deps),/disjoint/);
  }finally{await f.close();}
});
test('local lock, unsettled journal, stale stop and active/uncertain rescue block without erasing evidence',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.runtime,'worker.lock'),'uncertain lock');await assert.rejects(()=>localRollbackGate(f.target,now),/Worker lock/);
    assert.equal(await readFile(path.join(f.runtime,'worker.lock'),'utf8'),'uncertain lock');await rm(path.join(f.runtime,'worker.lock'));
    await f.save('operation.json',{phase:'completing',lease:{id:'original',token:'retain'}});await assert.rejects(()=>localRollbackGate(f.target,now),/Unsettled/);
    await f.save('operation.json',{phase:'settled'});
    for(const rescue of [{version:1,phase:'pending'},{version:1,phase:'uncertain'},{version:1,phase:'finished',agentStopped:false}]) {
      await f.save('fault-rescue.json',rescue);await assert.rejects(()=>localRollbackGate(f.target,now),/fault rescue/);
      assert.deepEqual(JSON.parse(await readFile(path.join(f.runtime,'fault-rescue.json'),'utf8')),rescue);
    }
    await f.save('fault-rescue.json',null);await f.save('stop-result.json',{state:'stopped',modelCalls:0,startedAt:'2000-01-01',finishedAt:'2000-01-01'});
    await assert.rejects(()=>localRollbackGate(f.target,now),/fresh graceful-stop/);
  }finally{await f.close();}
});
test('native host PID, owned descendants, enabled scheduler and incomplete proof are fail-closed',()=>{
  const root=path.resolve('D:/target');
  assert.throws(()=>nativeRollbackGate({supported:false},root,null),/unavailable/);
  assert.throws(()=>nativeRollbackGate({supported:true,processes:[{processId:42,commandLine:'edge'}],tasks:[]},root,{processId:42}),/native browser host/);
  assert.throws(()=>nativeRollbackGate({supported:true,processes:[{processId:43,commandLine:root+' scripts/main.mjs'},{processId:44,parentProcessId:43,commandLine:'edge'}],tasks:[]},root,null),/still alive/);
  assert.throws(()=>nativeRollbackGate({supported:true,processes:[],tasks:[{name:'NUMEMS-Agentless',state:'Ready'}]},root,null),/Disable/);
  for(const patch of [{success:false},{finishedAt:'2000-01-01'},{result:{...cloudReport().result,busy:true}},{result:{...cloudReport().result,schedulerEnabled:true}},
    {result:{...cloudReport().result,faultRescue:{phase:'uncertain'}}},{result:{...cloudReport().result,faultRescue:{phase:'unrecognized'}}}])
    assert.throws(()=>cloudRollbackGate({...cloudReport(),...patch},now,now),/cloud rollback proof/);
  assert.equal(cloudRollbackGate(cloudReport(),now,now).revision,10);
});
test('staged rollback restores all 300 bytes, archives extra source and preserves runtime/browser/receipt evidence',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.target,'scripts','agentless','main.mjs'),'v14 changed source');
    const extra=path.join(f.target,'scripts','agentless','new-v14-extra.mjs');await writeFile(extra,'v14 extra preserved');
    const before=await Promise.all(['operation.json','fault-rescue.json','browser/synthetic-cookie.dat'].map(p=>readFile(path.join(f.runtime,p))));
    const report=await rollbackV13(f.options,f.deps);assert.equal(report.files,300);assert.equal(report.state,'restored_stopped');assert.equal(report.extrasArchived,1);
    for(const item of f.manifest.files)assert.equal(hash(await readFile(path.join(f.target,...item.path.split('/')))),item.sha256,item.path);
    assert.equal(await readFile(path.join(f.archive,'before','scripts','agentless','main.mjs'),'utf8'),'v14 changed source');
    assert.equal(await readFile(path.join(f.archive,'moved-extras','scripts','agentless','new-v14-extra.mjs'),'utf8'),'v14 extra preserved');
    await assert.rejects(()=>lstat(extra),/ENOENT/);const config=JSON.parse(await readFile(path.join(f.runtime,'config.json'),'utf8'));
    assert.equal(config.faultRescue,undefined);assert.equal(config.liveActions,false);assert.equal(config.customPreserved,'keep');
    const after=await Promise.all(['operation.json','fault-rescue.json','browser/synthetic-cookie.dat'].map(p=>readFile(path.join(f.runtime,p))));assert.deepEqual(after,before);
    await assert.rejects(()=>lstat(path.join(f.runtime,'rollback-v13.lock')),/ENOENT/);
  }finally{await f.close();}
});
test('interrupted file replacement stays stopped, retains full staging/preimages and never claims success',async()=>{
  const f=await fixture();try{
    await assert.rejects(()=>rollbackV13(f.options,{...f.deps,beforeReplace:async()=>{throw new Error('synthetic disk failure');}}),/evidence preserved/);
    const progress=JSON.parse(await readFile(path.join(f.archive,'rollback-progress.json'),'utf8'));assert.equal(progress.state,'partial_stopped');
    assert.equal(JSON.parse(await readFile(path.join(f.runtime,'config.json'),'utf8')).liveActions,false);
    assert.ok((await lstat(path.join(f.runtime,'rollback-v13.lock'))).isFile());
    for(const item of f.manifest.files)assert.equal(hash(await readFile(path.join(f.archive,'staging-v13',...item.path.split('/')))),item.sha256);
    assert.equal(JSON.parse(await readFile(path.join(f.runtime,'fault-rescue.json'),'utf8')).ticket.token,'synthetic-preserved-secret');
  }finally{await f.close();}
});
test('handled fallback requires verified cloud downgrade before source restore and archives original outcome',async()=>{
  const f=await fixture();try {
    const rescue={version:1,phase:'finished',agentStopped:true,outcome:'handled',ticket:{id:'rescue_test'}};
    await f.save('fault-rescue.json',rescue);let prepared=0;
    const deps={...f.deps,cloud:async()=>({...cloudReport(),result:{...cloudReport().result,
      faultRescue:{phase:'finished',outcome:prepared?'unresolved':'handled'}}}),prepareCloud:async(root,revision)=>{
        assert.equal(root,f.target);assert.equal(revision,10);prepared++;
      }};
    const check=await rollbackV13({...f.options,apply:false},deps);assert.equal(check.requiresV13OutcomeNormalization,true);assert.equal(prepared,0);
    const result=await rollbackV13(f.options,deps);assert.equal(result.state,'restored_stopped');assert.equal(prepared,1);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.archive,'fault-rescue.before.json'),'utf8')),rescue);
    assert.equal(JSON.parse(await readFile(path.join(f.runtime,'fault-rescue.json'),'utf8')).outcome,'unresolved');
  }finally{await f.close();}
});
