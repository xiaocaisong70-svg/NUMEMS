// Executes the evaluate callbacks against an isolated VM fetch stub. No browser,
// administrator session, real HTTP request, member change or secret is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {PortalClient,PortalReadUnavailable,PortalQueueUnavailable} from '../scripts/seat-executor/portal-client.mjs';

const config={siteUrl:'https://portal.example/',adminEmail:'admin@example.com',browserMode:'isolated_desktop'};
const allowed={access:'allowed',user:{email:config.adminEmail}};
const transport=(name='TimeoutError',message='signal timed out')=>Object.assign(new Error(message),{name});
const reply=(body=allowed,status=200,jsonError=null)=>({status,async json(){if(jsonError)throw jsonError;return body;}});
function fixture({identities=[reply()],rpc=null,browserMode=config.browserMode,challenge=false,
  initialLocation=config.siteUrl,gotoError=null}={}) {
  const counts={identity:0,rpc:0,signin:0},operations=[],navigations=[];let location=initialLocation;
  const page={url:()=>location,
    async goto(address){navigations.push(address);if(gotoError)throw gotoError;location=address;if(address.includes('/signin-with-chatgpt'))counts.signin++;},
    async waitForURL(predicate){if(challenge)throw new Error('security verification required');location=config.siteUrl;assert.ok(predicate(new URL(location)));},
    async evaluate(fn,body){
      return vm.runInNewContext(`(${fn.toString()})(__body)`,{__body:body,
        AbortSignal:{timeout:milliseconds=>({milliseconds})},
        fetch:async(url,options)=>{
          if(url==='/api/portal') {
            assert.equal(options.signal.milliseconds,20_000);counts.identity++;
            const value=identities[Math.min(counts.identity-1,identities.length-1)];
            if(value instanceof Error)throw value;return value;
          }
          assert.equal(url,'/api/codex');assert.equal(options.method,'POST');
          assert.equal(options.signal.milliseconds,30_000);counts.rpc++;
          const request=JSON.parse(options.body);operations.push(request.params.name);
          if(rpc instanceof Error)throw rpc;
          if(rpc)return rpc;
          return reply({id:request.id,result:{content:[{type:'text',text:'{"plan":{"busy":false}}'}]}});
        }});
    }};
  const client=new PortalClient({newPage:async()=>page},{...config,browserMode},['review_seat_failure']);
  return {client,page,counts,operations,navigations};
}
const typed=metadata=>error=>{
  assert.ok(error instanceof PortalReadUnavailable);
  assert.equal(error.failureCode,'portal_read_unavailable');
  assert.deepEqual(error.metadata,metadata);assert.equal(Object.isFrozen(error.metadata),true);
  return true;
};

test('read failure type accepts only safe identity/status metadata combinations',()=>{
  const good={stage:'status',requestedOperation:'seat_portal_status',requestNotSent:false,readOnly:true,reason:'timeout'};
  assert.doesNotThrow(()=>new PortalReadUnavailable(good));
  for(const metadata of [null,{},
    {...good,stage:'write'}, {...good,requestedOperation:'claim_seat_operation'},
    {...good,requestNotSent:true}, {...good,readOnly:false}, {...good,reason:'unauthorized'},
    {...good,stage:'identity',requestNotSent:false}, {...good,requestedOperation:'../unsafe'}])
    assert.throws(()=>new PortalReadUnavailable(metadata),/Invalid portal read failure metadata/);
});
test('identity timeout before a write reports no RPC sent and never retries',async()=>{
  const f=fixture({identities:[transport()]});
  await assert.rejects(f.client.call('claim_seat_operation',{targetId:'req_example'}),typed({
    stage:'identity',requestedOperation:'claim_seat_operation',requestNotSent:true,readOnly:true,reason:'timeout'}));
  assert.deepEqual(f.counts,{identity:1,rpc:0,signin:0});
});
test('explicit portal.open has a safe identity-only operation name',async()=>{
  const f=fixture({identities:[transport('AbortError')]});
  await assert.rejects(f.client.open(),typed({stage:'identity',requestedOperation:'portal_identity',
    requestNotSent:true,readOnly:true,reason:'timeout'}));
  assert.equal(f.counts.rpc,0);
});
test('only status RPC timeout is classified as a pure read after sending',async()=>{
  const f=fixture({rpc:transport()});
  await assert.rejects(f.client.call('seat_portal_status'),typed({stage:'status',requestedOperation:'seat_portal_status',
    requestNotSent:false,readOnly:true,reason:'timeout'}));
  assert.deepEqual(f.counts,{identity:1,rpc:1,signin:0});
});
test('write RPC transport failure stays ambiguous and is not retried',async()=>{
  for(const name of ['claim_seat_operation','complete_seat_operation','process_seat_queue','observe_workspace',
    'defer_seat_operation','record_codex_schedule','review_seat_failure']) {
    const f=fixture({rpc:transport()});
    await assert.rejects(f.client.call(name),error=>!(error instanceof PortalReadUnavailable) && !error.failureCode);
    assert.deepEqual(f.counts,{identity:1,rpc:1,signin:0},name);
  }
});
test('network TypeErrors are recognized narrowly for identity and status reads',async()=>{
  for(const message of ['Failed to fetch','NetworkError when attempting to fetch resource.','Load failed']) {
    const identity=fixture({identities:[transport('TypeError',message)]});
    await assert.rejects(identity.client.call('seat_portal_status'),error=>
      error instanceof PortalReadUnavailable && error.metadata.stage==='identity' && error.metadata.reason==='network');
    const status=fixture({rpc:transport('TypeError',message)});
    await assert.rejects(status.client.call('seat_portal_status'),error=>
      error instanceof PortalReadUnavailable && error.metadata.stage==='status' && error.metadata.reason==='network');
    assert.equal(identity.counts.rpc,0);assert.equal(status.counts.rpc,1);
  }
  const invalid=fixture({identities:[transport('TypeError','Failed to parse URL')]});
  await assert.rejects(invalid.client.call('seat_portal_status'),error=>!(error instanceof PortalReadUnavailable));
});
test('timeout while reading an authenticated response body is still a read timeout',async()=>{
  for(const stage of ['identity','status']) {
    const f=fixture(stage==='identity'?{identities:[reply(allowed,200,transport('AbortError'))]}:
      {rpc:reply({},200,transport('AbortError'))});
    await assert.rejects(f.client.call('seat_portal_status'),error=>error instanceof PortalReadUnavailable && error.metadata.stage===stage);
  }
});
test('SSO second identity read preserves the typed timeout instead of a login failure',async()=>{
  const f=fixture({identities:[reply({access:'signin_required'},401),transport()]});
  await assert.rejects(f.client.call('complete_seat_operation'),typed({stage:'identity',requestedOperation:'complete_seat_operation',
    requestNotSent:true,readOnly:true,reason:'timeout'}));
  assert.deepEqual(f.counts,{identity:2,rpc:0,signin:1});
});
test('auth failures, account mismatch and SSO security validation remain nonrecoverable',async()=>{
  for(const options of [
    {identities:[reply({access:'signin_required'},401)],browserMode:'headless'},
    {identities:[reply({access:'forbidden'},403)]},
    {identities:[reply({access:'allowed',user:{email:'wrong@example.com'}})]},
    {identities:[reply({access:'signin_required'},401)],challenge:true},
    {identities:[reply({},401,transport())]},
    {identities:[reply({},403,transport())]},
  ]) {
    const f=fixture(options);
    await assert.rejects(f.client.call('seat_portal_status'),error=>!(error instanceof PortalReadUnavailable));
    assert.equal(f.counts.rpc,0);
  }
});
test('JSON/protocol failures and HTTP RPC errors cannot impersonate a read timeout',async()=>{
  const identity=fixture({identities:[reply({},200,new SyntaxError('invalid JSON'))]});
  await assert.rejects(identity.client.call('seat_portal_status'),error=>!(error instanceof PortalReadUnavailable));
  assert.equal(identity.counts.rpc,0);
  for(const rpc of [reply({},200,new SyntaxError('invalid JSON')),reply({},503),reply({},403),
    reply({id:999,result:{content:[{type:'text',text:'{}'}]}}),
    reply({id:1,result:{content:[{type:'text',text:'broken JSON'}]}})]) {
    const f=fixture({rpc});
    await assert.rejects(f.client.call('seat_portal_status'),error=>!(error instanceof PortalReadUnavailable));
    assert.equal(f.counts.rpc,1);
  }
});
test('unstructured evaluate failure remains unknown rather than being guessed from message text',async()=>{
  const f=fixture();f.page.evaluate=async()=>{throw transport('TimeoutError','page.evaluate: TimeoutError: signal timed out');};
  await assert.rejects(f.client.call('seat_portal_status'),error=>!(error instanceof PortalReadUnavailable));
});
test('pure queue failure type requires exactly the idempotent no-external-actions operation',()=>{
  const valid={stage:'queue_refresh',requestedOperation:'refresh_seat_queue',idempotent:true,noExternalActions:true,reason:'timeout'};
  const error=new PortalQueueUnavailable(valid);
  assert.equal(error.failureCode,'portal_queue_unavailable');assert.equal(Object.isFrozen(error.metadata),true);
  assert.deepEqual(error.metadata,valid);
  for(const metadata of [null,{}, {...valid,stage:'status'}, {...valid,requestedOperation:'process_seat_queue'},
    {...valid,idempotent:false}, {...valid,noExternalActions:false}, {...valid,reason:'unauthorized'}])
    assert.throws(()=>new PortalQueueUnavailable(metadata),/Invalid pure queue failure metadata/);
});
test('refreshQueue uses only the new pure RPC and never falls back or retries',async()=>{
  const success=fixture();
  assert.deepEqual(await success.client.refreshQueue(),{plan:{busy:false}});
  assert.deepEqual(success.operations,['refresh_seat_queue']);
  for(const fault of [transport(),transport('TypeError','Failed to fetch')]) {
    const f=fixture({rpc:fault});
    await assert.rejects(f.client.refreshQueue(),error=>{
      assert.ok(error instanceof PortalQueueUnavailable);
      assert.equal(error.failureCode,'portal_queue_unavailable');
      assert.deepEqual(error.metadata,{stage:'queue_refresh',requestedOperation:'refresh_seat_queue',
        idempotent:true,noExternalActions:true,reason:fault.name==='TypeError'?'network':'timeout'});
      return true;
    });
    assert.deepEqual(f.operations,['refresh_seat_queue']);assert.equal(f.counts.rpc,1);
  }
});
test('queue identity timeout is a read failure before RPC, not a queue response failure',async()=>{
  const f=fixture({identities:[transport()]});
  await assert.rejects(f.client.refreshQueue(),typed({stage:'identity',requestedOperation:'refresh_seat_queue',
    requestNotSent:true,readOnly:true,reason:'timeout'}));
  assert.deepEqual(f.operations,[]);assert.equal(f.counts.rpc,0);
});
test('queue response protocol errors cannot become transport recovery candidates',async()=>{
  for(const rpc of [reply({},403),reply({},503),reply({},200,new SyntaxError('invalid JSON'))]) {
    const f=fixture({rpc});
    await assert.rejects(f.client.refreshQueue(),error=>!(error instanceof PortalQueueUnavailable) && !(error instanceof PortalReadUnavailable));
    assert.deepEqual(f.operations,['refresh_seat_queue']);
  }
  for(const name of ['process_seat_queue','claim_seat_operation','complete_seat_operation']) {
    const f=fixture({rpc:transport()});
    await assert.rejects(f.client.call(name),error=>!(error instanceof PortalQueueUnavailable) && !(error instanceof PortalReadUnavailable));
    assert.deepEqual(f.operations,[name]);assert.equal(f.counts.rpc,1);
  }
});
test('initial read-only portal navigation timeout is safe before even a write RPC is sent',async()=>{
  const f=fixture({initialLocation:'about:blank',gotoError:transport('TimeoutError','page.goto: Timeout 30000ms exceeded')});
  await assert.rejects(f.client.call('claim_seat_operation'),typed({stage:'identity',requestedOperation:'claim_seat_operation',
    requestNotSent:true,readOnly:true,reason:'timeout'}));
  assert.deepEqual(f.navigations,[config.siteUrl]);
  assert.deepEqual(f.counts,{identity:0,rpc:0,signin:0});
});
test('only known initial navigation network codes qualify for recovery',async()=>{
  for(const code of ['ERR_CONNECTION_TIMED_OUT','ERR_NETWORK_CHANGED','ERR_INTERNET_DISCONNECTED',
    'ERR_CONNECTION_RESET','ERR_NAME_NOT_RESOLVED','ERR_CONNECTION_CLOSED','ERR_TIMED_OUT','ERR_FAILED']) {
    const f=fixture({initialLocation:'about:blank',gotoError:new Error(`page.goto: net::${code} at ${config.siteUrl}`)});
    await assert.rejects(f.client.refreshQueue(),typed({stage:'identity',requestedOperation:'refresh_seat_queue',
      requestNotSent:true,readOnly:true,reason:/TIMED_OUT$/.test(code)?'timeout':'network'}));
    assert.deepEqual(f.navigations,[config.siteUrl]);assert.equal(f.counts.rpc,0);
  }
});
test('initial navigation auth/certificate/closed-context/unknown failures stay fatal',async()=>{
  for(const failure of [new Error('net::ERR_CERT_AUTHORITY_INVALID'),new Error('Target page, context or browser has been closed'),
    new Error('Authentication failed'),new SyntaxError('bad navigation protocol'),new Error('Unknown navigation failure'),
    new Error('net::ERR_FAILED_EXTRA'),new Error('ERR_NETWORK_CHANGED without native prefix')]) {
    const f=fixture({initialLocation:'about:blank',gotoError:failure});
    await assert.rejects(f.client.call('seat_portal_status'),error=>error===failure && !(error instanceof PortalReadUnavailable));
    assert.equal(f.counts.rpc,0);assert.equal(f.counts.identity,0);
  }
  const success=fixture({initialLocation:'about:blank'});await success.client.call('seat_portal_status');
  assert.deepEqual(success.navigations,[config.siteUrl]);assert.equal(success.counts.rpc,1);
});
