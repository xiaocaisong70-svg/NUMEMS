// Actual JSON-RPC route + production mutateState, with in-memory SQLite D1.
// The retry clock is synthetic; no network or real member action occurs.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import * as engine from '../lib/seat-engine.ts';
import * as bridge from '../lib/codex-bridge.ts';
import * as policy from '../lib/reminder-policy.ts';
import * as access from '../lib/portal-access.ts';
import * as history from '../lib/history-store.ts';
import * as rate from '../lib/request-rate-policy.ts';
import * as officialIdle from '../lib/official-idle-state.ts';
import * as historyRollback from '../lib/history-rollback.ts';
import * as recoveryControl from '../lib/recovery-control.ts';
import {ADMIN,WORKSPACE} from '../scripts/agentless/config.mjs';

const require=createRequire(import.meta.url), ts=require('typescript');
const compile=async p=>ts.transpileModule(await readFile(new URL(p,import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;

async function exercise(useFreshClock,wrongTarget=false,checkAuth=false){
  let ms=Date.parse('2026-10-27T10:00:00.000Z');
  class FakeDate extends Date {constructor(...args){super(...(args.length?args:[ms]));}static now(){return ms;}}
  const now=()=>new Date(ms).toISOString();
  const owner={userId:'owner',email:ADMIN,isAdmin:true};
  const person={userId:'person',email:'person@example.com',isAdmin:false};
  const observation={workspaceId:WORKSPACE,accountEmail:ADMIN,complete:true,totalSeats:4,
    pageUrl:`https://admin.openai.com/workspace/${WORKSPACE}/members`,observedAt:now(),
    members:[{email:ADMIN,role:'owner'}],invites:[]};
  let state=bridge.observeWorkspace(engine.createState(now()),observation,now());
  state=engine.transition(state,owner,{type:'configure',config:{automationEnabled:true,whitelist:[person.email]}},now());
  state.codex.enabled=true;state.codex.testOnly=false;state.codex.mailEnabled=false;
  state=engine.transition(state,person,{type:'apply',name:'Person',reason:'work',hours:1},now());
  state=engine.transition(state,owner,{type:'tick'},now());
  const requestId=state.requests[0].id;
  state=bridge.claimOperation(state,'invite',requestId,'test-token',now());
  const op=state.codex.lease;
  ms+=1000;state=bridge.completeOperation(state,{operationId:op.id,token:op.token,outcome:'uncertain',
    failureCode:'unknown',detail:'程序办理未完成；保留原租约和证据，不自动重做外部动作。'},now());
  // Preserve a legacy stored incident for testing the explicit recovery RPC.
  delete state.codex.operationFailureOrigin;
  ms+=1000;observation.observedAt=now();observation.members.push({email:person.email,role:'member'});
  state=bridge.completeOperation(state,{operationId:op.id,token:op.token,outcome:'verified',observation},now());
  ms+=1000;observation.observedAt=now();
  const failureId=bridge.workPlan(state,now()).globalFailureId;
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE portal_state (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)');
  db.prepare('INSERT INTO portal_state VALUES (?,?,?)').run('main',0,JSON.stringify(state));
  let conflicts=0;
  const binding={prepare(query){let args=[];return {bind(...v){args=v;return this;},
    async first(){return db.prepare(query).get(...args)??null;},async run(){
      if(query.startsWith('UPDATE portal_state') && conflicts++===0){
        db.prepare('UPDATE portal_state SET revision=revision+1 WHERE id=?').run('main');
        ms+=61_000;
      }
      const result=db.prepare(query).run(...args);return {meta:{changes:Number(result.changes)}};
    }};}};
  const ctx=vm.createContext({Request,Response,TextEncoder,URL,crypto:webcrypto,console,Date:FakeDate,structuredClone});
  const env={DB:binding,REMINDER_DELIVERY_MODE:'in_app'};
  const make=(exports)=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context:ctx});
  let currentUser=owner;
  const base={'cloudflare:workers':{env},'@/app/chatgpt-auth':{getChatGPTUser:async()=>currentUser},
    '@/lib/seat-engine':engine,'@/lib/codex-bridge':bridge,'@/lib/reminder-policy':policy,'@/lib/portal-access':access,
    './seat-engine':engine,'./reminder-policy':policy,'./portal-access':access,
    './recovery-control':recoveryControl,'./history-store':history,'./request-rate-policy':rate,'@/lib/recovery-control':recoveryControl,'@/lib/history-rollback':historyRollback,'@/lib/official-idle-state':officialIdle,
    '@/lib/jobs':{runJobs:async()=>({}),refreshSeatQueue:async()=>({})}};
  const service=new vm.SourceTextModule(await compile('../lib/portal-service.ts'),{context:ctx});
  await service.link(spec=>{if(!base[spec])throw new Error(`Unexpected service import ${spec}`);return make(base[spec]);});
  await service.evaluate();
  let routeCode=await compile('../app/mcp/route.ts');
  if(!useFreshClock){
    const original=routeCode;
    routeCode=routeCode.replace('args.decision === "resume_verified_operation" ? new Date().toISOString() : now','now');
    assert.notEqual(routeCode,original,'negative control must reproduce the original fixed clock');
  }
  const route=new vm.SourceTextModule(routeCode,{context:ctx});
  await route.link(spec=>spec==='@/lib/portal-service'?service:base[spec]?make(base[spec]):Promise.reject(new Error(`Unexpected route import ${spec}`)));
  await route.evaluate();
  try {
    const req=new Request('https://qa.invalid/mcp',{method:'POST',headers:{origin:'https://qa.invalid','content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'review_seat_failure',arguments:{
        decision:'resume_verified_operation',expectedFailureId:failureId,expectedTargetId:wrongTarget?'req_wrong_same_email':requestId,operationId:op.id,observation}}})});
    const response=await route.namespace.POST(req),body=await response.json();
    assert.equal(body.result.isError===true,useFreshClock || wrongTarget);
    assert.equal(conflicts,wrongTarget?0:useFreshClock?1:2);
    const saved=JSON.parse(db.prepare('SELECT document FROM portal_state WHERE id=?').get('main').document);
    assert.equal(saved.codex.globalFailureCode,useFreshClock || wrongTarget?'unknown':undefined);
    if(checkAuth) {
      const key={failureId,targetId:requestId,operationId:op.id};
      const request=origin=>new Request('https://qa.invalid/mcp',{method:'POST',headers:{origin,'content-type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'verified_review_receipt',arguments:key}})});
      const before=db.prepare('SELECT revision FROM portal_state WHERE id=?').get('main').revision;
      let answer=await route.namespace.POST(request('https://qa.invalid'));
      const admin=await answer.json();assert.equal(admin.result.isError,undefined);
      const content=JSON.parse(admin.result.content[0].text);assert.equal(content.receipt.operationId,op.id);
      currentUser=person;answer=await route.namespace.POST(request('https://qa.invalid'));
      assert.equal((await answer.json()).result.isError,true);
      currentUser=null;answer=await route.namespace.POST(request('https://qa.invalid'));
      assert.equal((await answer.json()).result.isError,true);
      currentUser=owner;answer=await route.namespace.POST(request('https://evil.invalid'));
      assert.equal(answer.status,403);
      assert.equal(db.prepare('SELECT revision FROM portal_state WHERE id=?').get('main').revision,before);
    }
  } finally {db.close();}
}
test('CAS retry after 60 seconds rejects the original official snapshot',()=>exercise(true));
test('negative control: fixed request time incorrectly accepts an expired snapshot',()=>exercise(false));
test('wrong local request ID cannot clear another request for the same email',()=>exercise(true,true));
test('review receipt is read-only and rejects anonymous, staff and cross-origin calls',()=>exercise(false,false,true));
