// Runs the real jobs and MCP route source with in-memory state and provider spies.
// No listener, browser, production database, account or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as engine from '../lib/seat-engine.ts';
import * as bridge from '../lib/codex-bridge.ts';
import * as reminder from '../lib/reminder-policy.ts';
import * as officialIdle from '../lib/official-idle-state.ts';
import * as historyRollback from '../lib/history-rollback.ts';

const root=path.resolve(import.meta.dirname,'..');
const initial='2026-10-26T06:00:00.000Z';
const owner={userId:'owner',email:engine.PROTECTED_OWNER_EMAIL,isAdmin:true};
const alice={userId:'alice',email:'alice@example.com',isAdmin:false};
const bob={userId:'bob',email:'bob@example.com',isAdmin:false};
function load(relative,deps,DateClass) {
  const filename=path.join(root,relative);
  const output=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,
  }}).outputText;
  const module={exports:{}};
  const scope={module,exports:module.exports,Date:DateClass,Response,Request,URL,crypto:globalThis.crypto,
    structuredClone,require:name=>{
      if(!Object.hasOwn(deps,name))throw new Error('Unexpected dependency: '+name);
      return deps[name];
    }};
  vm.runInNewContext(output,scope,{filename});
  return module.exports;
}
function fixture(mode='in_app') {
  let now=Date.parse(initial),actor=owner,writes=0,validated=0,deliveries=0;
  class Clock extends Date {
    constructor(...args){super(...(args.length?args:[now]));}
    static now(){return now;}
  }
  let state=engine.createState(initial);
  const at=()=>new Date(now).toISOString();
  const command=(who,action)=>{state=engine.transition(state,who,action,at());return state;};
  command(owner,{type:'configure',config:{totalSeats:2,workspaceId:bridge.TARGET_WORKSPACE_ID,
    automationEnabled:true,whitelist:[alice.email,bob.email]}});
  command(owner,{type:'sync_inventory',members:[{email:owner.email,role:'owner'}]});
  state.codex={enabled:true,testOnly:false,mailEnabled:mode==='relay',receipts:[]};
  const env={REMINDER_DELIVERY_MODE:mode,REMINDER_WEBHOOK_URL:'https://relay.example.test',
    REMINDER_WEBHOOK_TOKEN:'test-only',PORTAL_PUBLIC_URL:'https://portal.example.test'};
  const service={schedulerActor:{...owner,userId:'system:scheduler'},currentActor:async()=>actor,
    readState:async()=>({state,revision:state.revision}),
    mutateState:async transform=>{writes++;state=transform(structuredClone(state));return state;}};
  const jobs=load('lib/jobs.ts',{'cloudflare:workers':{env},'./portal-service':service,
    './seat-engine':engine,'./reminder-policy':reminder,'./reminder-relay':{
      validateRelay(){validated++;},async deliverReminders(){deliveries++;},
    }},Clock);
  const route=load('app/mcp/route.ts',{'cloudflare:workers':{env},'@/lib/portal-service':service,
    '@/lib/jobs':jobs,'@/lib/codex-bridge':bridge,'@/lib/seat-engine':engine,
    '@/lib/reminder-policy':reminder,'@/lib/history-rollback':historyRollback,'@/lib/official-idle-state':officialIdle},Clock);
  const post=(name='refresh_seat_queue',args={},headers={})=>route.POST(new Request('https://portal.example.test/api/codex',{
    method:'POST',headers:{'content-type':'application/json',origin:'https://portal.example.test',...headers},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}),
  }));
  return {jobs,route,post,command,at,advance(seconds){now+=seconds*1000;},setActor(value){actor=value;},
    get state(){return state;},get counts(){return {writes,validated,deliveries};},
    apply(who=alice,hours=1){return command(who,{type:'apply',name:who.userId,reason:'offline test',hours});},
    activate(id){command(owner,{type:'confirm_invited',id});command(owner,{type:'confirm_active',id});}};
}

test('pure queue refresh allocates FIFO once and retains a cloud heartbeat',async()=>{
  const f=fixture();f.apply();f.advance(1);f.apply(bob);
  const first=await f.jobs.refreshSeatQueue();
  assert.deepEqual(f.state.requests.map(r=>r.status),['pending_invite','queued']);
  assert.equal(first.pendingInvites,1);assert.equal(first.queued,1);assert.equal(first.mailMode,'in_app');
  assert.equal(first.lastTickAt,f.at());assert.equal(f.state.runtime.lastTickAt,f.at());
  const ids=f.state.requests.map(r=>r.operationId);const notices=structuredClone(f.state.notices);
  await f.jobs.refreshSeatQueue();
  assert.deepEqual(f.state.requests.map(r=>r.operationId),ids);assert.deepEqual(f.state.notices,notices);
  assert.equal(f.counts.validated,0);assert.equal(f.counts.deliveries,0);
});

test('pure expiry retains the seat until actual recovery and then advances the queue',async()=>{
  const f=fixture();f.apply();await f.jobs.refreshSeatQueue();const id=f.state.requests[0].id;
  f.activate(id);f.apply(bob);f.advance(3600);
  const due=await f.jobs.refreshSeatQueue();
  assert.equal(due.pendingRemovals,1);assert.equal(due.queued,1);
  assert.deepEqual(f.state.requests.map(r=>r.status),['pending_removal','queued']);
  await f.jobs.refreshSeatQueue();
  assert.equal(f.state.requests[0].status,'pending_removal');
  f.command(owner,{type:'confirm_removed',id});
  await f.jobs.refreshSeatQueue();
  assert.deepEqual(f.state.requests.map(r=>r.status),['completed','pending_invite']);
  assert.equal(f.counts.deliveries,0);
});

test('web reminder is deduplicated without inventing a delivery receipt',async()=>{
  const f=fixture();f.apply(alice,3);await f.jobs.refreshSeatQueue();f.activate(f.state.requests[0].id);
  f.advance(2.5*3600);
  await f.jobs.refreshSeatQueue();await f.jobs.refreshSeatQueue();
  const reminders=f.state.notices.filter(n=>n.type==='expiry_30m');
  assert.equal(reminders.length,1);assert.equal(reminders[0].status,'pending');
  assert.equal(reminders[0].sentAt,undefined);assert.equal(f.counts.deliveries,0);
});

test('relay mode refresh never validates or delivers; original runJobs still does',async()=>{
  const f=fixture('relay');f.apply(alice,3);await f.jobs.refreshSeatQueue();f.activate(f.state.requests[0].id);
  f.advance(2.5*3600);
  const result=await f.jobs.refreshSeatQueue();
  assert.equal(result.mailMode,'relay');assert.ok(f.state.notices.some(n=>n.type==='expiry_30m'));
  assert.deepEqual(f.counts,{writes:2,validated:0,deliveries:0});
  await f.jobs.runJobs();
  assert.equal(f.counts.validated,1);assert.equal(f.counts.deliveries,1);
});

test('MCP refresh returns jobs plus plan only after administrator authorization',async()=>{
  const f=fixture();f.apply();
  const response=await f.post();assert.equal(response.status,200);
  const rpc=await response.json();assert.equal(rpc.result.isError,undefined);
  const body=JSON.parse(rpc.result.content[0].text);
  assert.equal(body.pendingInvites,1);assert.equal(body.plan.administrator,owner.email);
  assert.equal(body.plan.invites[0].email,alice.email);assert.equal(f.counts.deliveries,0);
  for(const actor of [null,alice]){
    f.setActor(actor);const before=f.counts.writes;
    const denied=await (await f.post()).json();
    assert.equal(denied.result.isError,true);assert.match(denied.result.content[0].text,/管理员/);
    assert.equal(f.counts.writes,before);
  }
});

test('refresh rejects unrecognized arguments and cross-origin calls before queue mutation',async()=>{
  const f=fixture();
  for(const args of [{sendMail:true},[],null,'unexpected']){
    const result=await (await f.post('refresh_seat_queue',args)).json();
    assert.equal(result.result.isError,true);assert.match(result.result.content[0].text,/不接受参数/);
    assert.equal(f.counts.writes,0);
  }
  assert.equal((await f.post('refresh_seat_queue',{}, {origin:'https://foreign.example.test'})).status,403);
  assert.equal(f.counts.writes,0);
});

test('tool discovery marks refresh as a pure idempotent mutation rather than a read',async()=>{
  const f=fixture();
  const response=await f.route.POST(new Request('https://portal.example.test/mcp',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'}),
  }));
  const tools=(await response.json()).result.tools;
  const item=tools.find(t=>t.name==='refresh_seat_queue');
  assert.equal(item.annotations.readOnlyHint,false);assert.equal(item.annotations.idempotentHint,true);
  assert.equal(item.inputSchema.additionalProperties,false);assert.deepEqual(item.inputSchema.properties,{});
  assert.equal(f.counts.writes,0);assert.equal(f.counts.deliveries,0);
});
