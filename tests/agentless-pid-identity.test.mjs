import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {processGate,verifiedReusedIdentity} from '../scripts/agentless/watchdog.mjs';

const previous='2020-10-27T09:26:24.000Z';
const current='2020-10-27T09:56:07.000Z';
const identity={pid:13372,imageName:'SearchFilterHost.exe',createdAt:current};
const now=Date.parse('2020-10-27T10:10:00Z');
const lock={pid:13372,at:previous};
const host={processId:13372,checkedAt:previous};
const denied=()=>{throw Object.assign(new Error('inaccessible'),{code:'EPERM'});};

test('PID reuse requires matching PID, clearly newer creation, and different image',()=>{
  assert.equal(verifiedReusedIdentity(identity,13372,previous,now),true);
  for(const patch of [{pid:13373},{imageName:'node.exe'},{imageName:'NODE.EXE'},
    {imageName:''},{imageName:'system'},{createdAt:previous},
    {createdAt:'2020-10-27T09:26:26.000Z'},{createdAt:'2020-10-28T00:00:00Z'},
    {createdAt:'invalid'}])
    assert.equal(verifiedReusedIdentity({...identity,...patch},13372,previous,now),false,JSON.stringify(patch));
  for(const at of [undefined,null,'2020-10-27','invalid'])
    assert.equal(verifiedReusedIdentity(identity,13372,at,now),false);
});

test('gate accepts metadata-proven reuse even when signal says inaccessible',async()=>{
  const result=await processGate({host,lock},denied,async()=>identity);
  assert.equal(result.clear,true);
});

test('gate retains denial if either host or lock lacks complete valid proof',async()=>{
  for(const [input,inspect] of [
    [{host:{...host,checkedAt:null},lock},async()=>identity],
    [{host,lock:{...lock,at:'2020-10-27T09:57:00Z'}},async()=>identity],
    [{host,lock},async()=>({ ...identity,imageName:'node.exe'})],
    [{host,lock},async()=>null],
    [{host,lock},async()=>{throw new Error('WMI unavailable');}],
  ]) assert.equal((await processGate(input,denied,inspect)).clear,false);
});

test('Windows mutex-side validator also requires the same conservative proof',
  {skip:process.platform!=='win32'},()=>{
    const source=path.resolve(import.meta.dirname,'../scripts/agentless/pid-identity.ps1').replaceAll("'","''");
    const script=`. '${source}'\n`+
      `$p=@{pid=13372;imageName='SearchFilterHost.exe';createdAt='2020-10-27T09:56:07Z'}\n`+
      `$ok=Test-NumemsReusedIdentity $p 13372 '${previous}'\n`+
      `$p.imageName='node.exe';$same=Test-NumemsReusedIdentity $p 13372 '${previous}'\n`+
      `$p.imageName='SearchFilterHost.exe';$near=Test-NumemsReusedIdentity $p 13372 '2020-10-27T09:56:06Z'\n`+
      `@{ok=$ok;same=$same;near=$near}|ConvertTo-Json -Compress`;
    const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const result=JSON.parse(execFileSync(ps,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8'}).trim());
    assert.deepEqual(result,{ok:true,same:false,near:false});
});
