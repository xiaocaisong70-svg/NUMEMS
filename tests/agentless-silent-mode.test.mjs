import test from 'node:test';
import assert from 'node:assert/strict';
import {validateConfig} from '../scripts/agentless/config.mjs';
import {assertDesktop,validateDesktopProof,AgentlessBrowser} from '../scripts/agentless/browser.mjs';
import {hostArguments} from '../scripts/agentless/host.mjs';

test('headed mode cannot be selected without explicit desktop isolation',()=>{
  assert.throws(()=>validateConfig({headless:false}));
  assert.throws(()=>validateConfig({browserMode:'isolated_desktop'}));
  assert.equal(validateConfig({browserMode:'isolated_desktop',headless:false}).headless,false);
  assert.equal(validateConfig().headless,true);
});

test('native desktop proof rejects forged environment and active input desktop',async()=>{
  const name='NUMEMS-Agentless-test';
  const proof={desktop:name,inputDesktop:'Default',windowStation:'WinSta0',isolated:true};
  assert.equal(validateDesktopProof(proof,name),proof);
  for(const change of [{desktop:'Default'},{inputDesktop:name},{inputDesktop:''},{isolated:false},
    {windowStation:'Service-0x0-3e7$'}]) assert.throws(()=>validateDesktopProof({...proof,...change},name));
  assert.throws(()=>validateDesktopProof(proof,'Default'));
  const config=validateConfig({browserMode:'isolated_desktop',headless:false});
  await assert.rejects(assertDesktop(config,{platform:'linux'}));
  let hidden=false;
  const run=async(_exe,args,opts)=>{
    hidden=opts.windowsHide;assert.ok(args.includes('-NonInteractive'));
    return {stdout:JSON.stringify({...proof,desktop:'Default'})};
  };
  await assert.rejects(assertDesktop(config,{platform:'win32',env:{NUMEMS_DESKTOP_NAME:name},run}));
  assert.equal(hidden,true);
});

test('desktop verification happens before the external-action journal callback',async()=>{
  const adapter=new AgentlessBrowser(validateConfig({browserMode:'isolated_desktop',headless:false}));
  let wrote=false;adapter.onExternalAction=async()=>{wrote=true;};
  const previous=process.env.NUMEMS_DESKTOP_NAME;
  delete process.env.NUMEMS_DESKTOP_NAME;
  try {await assert.rejects(adapter.onExternalAction());assert.equal(wrote,false);}
  finally {if(previous!==undefined)process.env.NUMEMS_DESKTOP_NAME=previous;}
});

test('hidden entry permits only fixed modes and validated administrator arguments',()=>{
  const node='C:\\Program Files\\nodejs\\node.exe';
  const args=hostArguments(['admin','test-expire','req_example_1'],node);
  assert.equal(args[args.indexOf('-NodeExe')+1],node);
  assert.equal(args[args.indexOf('-WindowStyle')+1],'Hidden');
  assert.ok(args.includes('req_example_1'));
  assert.ok(hostArguments(['admin','rollback-status'],node).includes('rollback-status'));
  assert.ok(hostArguments(['admin','prepare-v11-rollback','23'],node).includes('23'));
  for(const id of ['-1','1;bad','1.2','9007199254740992','req_23'])
    assert.throws(()=>hostArguments(['admin','prepare-v11-rollback',id],node));
  for(const input of [[],['run','anything'],['probe','admin'],['admin','x'],
    ['admin','status','req_1'],['admin','test-expire'],['admin','test-expire','req_1;malicious'],
    ['admin','test-expire','req_1','extra']]) assert.throws(()=>hostArguments(input,node));
});
