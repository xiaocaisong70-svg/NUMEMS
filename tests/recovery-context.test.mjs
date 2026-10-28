import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {restartReadonlyContext,publishRecoveryIncident} from '../scripts/agentless/recovery-context.mjs';
import {PortalClient,PortalReadUnavailable} from '../scripts/seat-executor/portal-client.mjs';
import {BrowserAdapter} from '../scripts/seat-executor/browser.mjs';
import {AgentlessBrowser,assertDesktop} from '../scripts/agentless/browser.mjs';

const config=Object.freeze({siteUrl:'https://portal.example/',workspaceId:'workspace',adminEmail:'owner@example.com',
  browserMode:'isolated_desktop',headless:false,browserChannel:'msedge',profile:'D:/fixture/dedicated-profile'});
const diagnostic=state=>({version:1,stage:'members_navigation',state,
  expectedUrl:'https://admin.openai.com/workspace/workspace/members',observedAt:new Date(0).toISOString()});
async function fixture(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-context-recovery-')),journalFile=path.join(dir,'op.json');
  t.after(async()=>{await unlink(journalFile).catch(e=>{if(e.code!=='ENOENT')throw e;});await rmdir(dir);});
  let instant=0,stop=false;const calls=[],oldContext={id:'old'},newContext={id:'new',newPage:async()=>{}};
  const plan={workspaceId:config.workspaceId,administrator:config.adminEmail,enabled:true,testOnly:false,
    busy:false,lease:null,globalFailureCode:'browser_unavailable',globalFailureId:'failure-1',browserRecovery:{eligible:true}};
  const browser={config,context:oldContext,async close(){calls.push('close');this.context=null;},
    async open(options){calls.push(['open',options]);this.context=newContext;}};
  const portal={context:oldContext,async call(name,args,options){calls.push(['status',this.context.id,options]);
    assert.equal(name,'seat_portal_status');assert.deepEqual(args,{});return {plan:structuredClone(plan)};},
    rebindContext(context){calls.push(['rebind',context.id]);this.context=context;}};
  const args={portal,browser,config,journalFile,failureId:'failure-1',deadlineAt:90000,budgetMs:90000,now:()=>instant,shouldStop:async()=>stop};
  return {args,plan,calls,browser,portal,newContext,advance:ms=>{instant+=ms;},stop:()=>{stop=true;},
    journal:async value=>writeFile(journalFile,JSON.stringify(value))};
}

test('one ordinary context restart preserves configuration and revalidates the rebound portal',async t=>{
  const f=await fixture(t);assert.equal(await restartReadonlyContext(f.args),true);
  assert.deepEqual(f.calls.map(x=>Array.isArray(x)?x[0]:x),['status','close','open','rebind','status']);
  assert.equal(f.calls[0][1],'old');assert.equal(f.calls.at(-1)[1],'new');
  assert.deepEqual(f.calls[2][1],{timeoutMs:30000});assert.equal(f.browser.config,config);
  for(const status of f.calls.filter(x=>Array.isArray(x)&&x[0]==='status'))assert.equal(status[2].deadlineAt,90000);
});

test('claims, unsettled journals, active fault tickets and mismatched cloud identity block restart',async t=>{
  const cases=[p=>{p.lease={id:'claim'};},p=>{p.busy=true;},p=>{p.workspaceId='other';},p=>{p.administrator='other@example.com';},
    p=>{p.enabled=false;},p=>{p.testOnly=true;},p=>{p.globalFailureId='new-fault';},p=>{p.globalFailureCode='unknown';},
    p=>{p.browserRecovery.eligible=false;},...['pending','active','uncertain'].map(phase=>p=>{p.faultRescue={phase};})];
  for(const change of cases){const f=await fixture(t);change(f.plan);assert.equal(await restartReadonlyContext(f.args),false);
    assert.equal(f.calls.includes('close'),false);}
  for(const journal of [{phase:'claimed'},{phase:'attempting'},{phase:'settled',lease:{id:'lease'}},{phase:'settled',receipt:{outcome:'unknown'}}]){
    const f=await fixture(t);await f.journal(journal);assert.equal(await restartReadonlyContext(f.args),false);assert.deepEqual(f.calls,[]);
  }
});

test('changed local security settings cannot trigger a new browser launch',async t=>{
  const f=await fixture(t);f.browser.config={...config,headless:true};
  assert.equal(await restartReadonlyContext(f.args),false);assert.deepEqual(f.calls,[]);
});

test('a stop, new journal, changed failure or ticket arriving during reconnect prevents successful handoff',async t=>{
  for(const kind of ['stop','journal','failure','ticket']) {
    const f=await fixture(t),close=f.browser.close.bind(f.browser);
    f.browser.close=async()=>{await close();
      if(kind==='stop')f.stop();
      if(kind==='journal')await f.journal({phase:'claimed'});
      if(kind==='failure')f.plan.globalFailureId='new-fault';
      if(kind==='ticket')f.plan.faultRescue={phase:'pending'};
    };
    assert.equal(await restartReadonlyContext(f.args),false);
    if(['stop','journal'].includes(kind))assert.equal(f.calls.some(x=>Array.isArray(x)&&x[0]==='open'),false);
    assert.ok(f.calls.every(x=>!Array.isArray(x)||['status','open','rebind'].includes(x[0])));
  }
});

test('shared restart deadline clips launch and rejects late cloud proof',async t=>{
  const f=await fixture(t),call=f.portal.call.bind(f.portal);let reads=0;
  f.portal.call=async(...args)=>{const result=await call(...args);f.advance(++reads===1?85000:5000);return result;};
  assert.equal(await restartReadonlyContext(f.args),false);
  assert.deepEqual(f.calls.find(x=>Array.isArray(x)&&x[0]==='open')[1],{timeoutMs:5000});
  const stopped=await fixture(t);stopped.advance(90000);assert.equal(await restartReadonlyContext(stopped.args),false);assert.deepEqual(stopped.calls,[]);
});

test('desktop proof and inherited browser launch share the supplied startup budget',async()=>{
  let instant=0,launches=0;const original=BrowserAdapter.prototype.open;
  BrowserAdapter.prototype.open=async options=>{launches++;assert.deepEqual(options,{timeoutMs:3000});return 'fixture-page';};
  try {
    const browser=new AgentlessBrowser(config);browser.readOnlyWaitControls={now:()=>instant,deadlineAt:8000};
    browser.desktopProofForLaunch=async options=>{assert.deepEqual(options,{timeoutMs:5000});instant+=2000;return {isolated:true};};
    assert.equal(await browser.open({timeoutMs:5000}),'fixture-page');assert.equal(launches,1);
    const expired=new AgentlessBrowser(config);expired.readOnlyWaitControls={now:()=>instant,deadlineAt:7000};
    expired.desktopProofForLaunch=async()=>{instant+=5000;return {isolated:true};};
    await assert.rejects(expired.open({timeoutMs:5000}),error=>error.failureCode==='browser_unavailable');assert.equal(launches,1);
  } finally {BrowserAdapter.prototype.open=original;}
});

test('bounded native desktop proof remains hidden and validates unchanged isolation evidence',async()=>{
  const name='NUMEMS-Agentless-bounded-test',proof={desktop:name,inputDesktop:'Default',windowStation:'WinSta0',isolated:true};
  let commands=0;
  assert.deepEqual(await assertDesktop(config,{platform:'win32',env:{NUMEMS_DESKTOP_NAME:name},timeoutMs:3456,
    run:async(_exe,args,options)=>{commands++;assert.equal(options.windowsHide,true);assert.equal(options.timeout,3456);
      assert.ok(args.includes('-NonInteractive'));return {stdout:JSON.stringify(proof)};}}),proof);
  assert.equal(commands,1);
});

function boundedPortal({identityEmail=config.adminEmail,identityDuration=0,rpcDuration=0,initialLocation=config.siteUrl}={}) {
  let instant=0,location=initialLocation;const limits=[],rpcBodies=[],navigations=[];
  const page={url:()=>location,async goto(address,options){navigations.push(options.timeout);location=address;},
    async evaluate(fn,body){return vm.runInNewContext(`(${fn.toString()})(__body)`,{__body:body,
      AbortSignal:{timeout:milliseconds=>({milliseconds})},fetch:async(address,options)=>{
        limits.push(options.signal.milliseconds);
        if(address==='/api/portal'){instant+=identityDuration;return {status:200,json:async()=>({access:'allowed',user:{email:identityEmail}})};}
        instant+=rpcDuration;const request=JSON.parse(options.body);rpcBodies.push(request);
        return {status:200,json:async()=>({id:request.id,result:{content:[{type:'text',text:'{"plan":{}}'}]}})};
      }});}};
  return {client:new PortalClient({newPage:async()=>page},config),page,limits,rpcBodies,navigations,now:()=>instant};
}

test('rebound context discards cached page and verifies new identity before posting status',async()=>{
  const f=boundedPortal(),bad=boundedPortal({identityEmail:'wrong@example.com'});
  await f.client.call('seat_portal_status');assert.equal(f.rpcBodies.length,1);
  f.client.sessionRestoreAttempted=true;f.client.rebindContext({newPage:async()=>bad.page});
  assert.equal(f.client.page,undefined);assert.equal(f.client.sessionRestoreAttempted,false);
  await assert.rejects(f.client.call('seat_portal_status'),/身份不符/);assert.equal(bad.rpcBodies.length,0);
});

test('status deadline bounds navigation, identity and RPC without leaking controls to the server',async()=>{
  const f=boundedPortal({identityDuration:2000,initialLocation:'about:blank'});
  await f.client.call('seat_portal_status',{}, {deadlineAt:7000,now:f.now});
  assert.deepEqual(f.navigations,[7000]);assert.deepEqual(f.limits,[7000,5000]);
  assert.deepEqual(Object.keys(f.rpcBodies[0]).sort(),['id','jsonrpc','method','params']);
  assert.equal('_readTimeoutMs' in f.rpcBodies[0],false);
});

test('late read proof is not accepted; expired identity sends no RPC; mutations reject deadline options',async()=>{
  const identity=boundedPortal({identityDuration:7000});
  await assert.rejects(identity.client.call('seat_portal_status',{}, {deadlineAt:5000,now:identity.now}),error=>
    error instanceof PortalReadUnavailable && error.metadata.stage==='identity' && error.metadata.requestNotSent);
  assert.equal(identity.rpcBodies.length,0);
  const rpc=boundedPortal({rpcDuration:6000});
  await assert.rejects(rpc.client.call('seat_portal_status',{}, {deadlineAt:5000,now:rpc.now}),error=>
    error instanceof PortalReadUnavailable && error.metadata.stage==='status' && !error.metadata.requestNotSent);
  assert.equal(rpc.rpcBodies.length,1);
  const write=boundedPortal();await assert.rejects(write.client.call('claim_seat_operation',{}, {deadlineAt:5000,now:write.now}),/read deadline/);
  assert.equal(write.rpcBodies.length,0);assert.deepEqual(write.limits,[]);
});

test('incident publisher cannot turn automatic generic or historical checks into manual requests',async()=>{
  const calls=[],portal={call:async(name,args)=>{calls.push({name,args});}};
  for(const event of [{phase:'automatic',classification:'interaction_required',diagnostic:diagnostic('interaction_required')},
    {phase:'exhausted',classification:'security_check',diagnostic:diagnostic('challenge')}]){
    assert.deepEqual(await publishRecoveryIncident(portal,{failureId:'fault',...event}),{published:true});
    assert.equal(calls.at(-1).args.phase,'security_check');assert.equal(calls.at(-1).args.diagnostic.state,'challenge');
  }
  await publishRecoveryIncident(portal,{failureId:'fault',phase:'interaction_required',classification:'interaction_required',diagnostic:diagnostic('interaction_required')});
  assert.equal(calls.at(-1).args.phase,'interaction_required');
  await publishRecoveryIncident(portal,{failureId:'fault',phase:'fatal',classification:'login_required',diagnostic:diagnostic('login')});
  assert.equal(calls.at(-1).args.phase,'login_required');
  assert.ok(calls.every(c=>c.name==='record_recovery_progress'));
});
