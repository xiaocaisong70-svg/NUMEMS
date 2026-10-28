import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createState,transition,PROTECTED_OWNER_EMAIL,AUTHORIZED_TEST_EMAIL} from '../lib/seat-engine.ts';
import {compactHistory,HISTORY_LIMITS,rehydrateHistory} from '../lib/history-policy.ts';
import {persistHistoryCas,readHistoryPage,archivedRequestKey,HISTORY_INSERT_SQL} from '../lib/history-store.ts';
import {restoreV11History} from '../lib/history-rollback.ts';
import {enforceRequestRate,RequestRateError} from '../lib/request-rate-policy.ts';
import vm from 'node:vm';
import ts from 'typescript';
import * as engine from '../lib/seat-engine.ts';
import * as reminder from '../lib/reminder-policy.ts';
import * as access from '../lib/portal-access.ts';
import * as historyStore from '../lib/history-store.ts';
import * as ratePolicy from '../lib/request-rate-policy.ts';
import * as recoveryControl from '../lib/recovery-control.ts';

const at='2026-10-28T00:00:00.000Z';
const owner={userId:'owner',email:PROTECTED_OWNER_EMAIL,isAdmin:true};
const alice={userId:'alice',email:'alice@example.com',isAdmin:false};
const bob={userId:'bob',email:'bob@example.com',isAdmin:false};
const stamp=n=>new Date(Date.parse(at)+n*1000).toISOString();
function request(n,status='completed',actor=alice){return{id:`req_${String(n).padStart(5,'0')}`,userId:actor.userId,email:actor.email,
  name:actor.userId,reason:'history test',hours:1,status,createdAt:stamp(n),updatedAt:stamp(n),requestKey:'key-'+n};}
function fixture(n=200){const s=createState(at);s.config.whitelist=[alice.email,bob.email];
  s.requests=Array.from({length:n},(_,i)=>request(i));
  s.notices=Array.from({length:n*4},(_,i)=>({id:'notice_'+i,key:`req_${Math.floor(i/4)}:test:${stamp(i)}`,
    requestId:request(Math.floor(i/4)).id,userId:alice.userId,email:alice.email,type:'test',title:'test',message:'test',createdAt:stamp(i),status:'pending'}));
  s.audit=Array.from({length:n*4},(_,i)=>({id:'audit_'+i,at:stamp(i),actor:owner.email,action:'test'}));return s;}

function database(initial){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_bored_stick.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0001_chilly_squirrel_girl.sql',import.meta.url),'utf8').replaceAll('--> statement-breakpoint',''));
  sqlite.prepare('INSERT INTO portal_state VALUES(?,?,?)').run('main',0,JSON.stringify(initial));
  let failArchive=false,beforeBatch;
  const api={prepare(sql){let params=[];return{bind(...v){params=v;return this;},
    async first(){return sqlite.prepare(sql).get(...params)??null;},
    async all(){return{results:sqlite.prepare(sql).all(...params)};},
    async run(){if(failArchive&&sql===HISTORY_INSERT_SQL)throw new Error('archive unavailable');const r=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(r.changes)}};}};},
    async batch(operations){await beforeBatch?.();sqlite.exec('BEGIN');try{const results=[];for(const op of operations)results.push(await op.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  return {api,sqlite,close(){sqlite.close();},failArchive(){failArchive=true;},beforeBatch(fn){beforeBatch=fn;}};
}

async function serviceModule(db,actor=alice){
  const ctx=vm.createContext({Request,Response,URL,TextEncoder,Date,structuredClone,console});
  const dependencies={'cloudflare:workers':{env:{DB:db.api,REMINDER_DELIVERY_MODE:'in_app'}},
    '@/app/chatgpt-auth':{getChatGPTUser:async()=>actor},'./seat-engine':engine,'./portal-access':access,
    './reminder-policy':reminder,'./history-store':historyStore,'./recovery-control':recoveryControl,'./request-rate-policy':ratePolicy};
  const module=new vm.SourceTextModule(ts.transpileModule(readFileSync(new URL('../lib/portal-service.ts',import.meta.url),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,{context:ctx});
  await module.link(name=>new vm.SyntheticModule(Object.keys(dependencies[name]),function(){
    for(const[k,v]of Object.entries(dependencies[name]))this.setExport(k,v);},{context:ctx}));
  await module.evaluate();return module.namespace;
}

test('terminal history leaves a bounded hot document with no lost records',()=>{
  const old=fixture(700),{state,rows}=compactHistory(old,old);
  assert.equal(state.requests.length,HISTORY_LIMITS.requests);assert.equal(state.notices.length,HISTORY_LIMITS.notices);
  assert.equal(state.audit.length,HISTORY_LIMITS.audit);
  assert.equal(rows.filter(r=>r.kind==='request').length+state.requests.length,old.requests.length);
  assert.equal(rows.filter(r=>r.kind==='notice').length+state.notices.length,old.notices.length);
  assert.equal(rows.filter(r=>r.kind==='audit').length+state.audit.length,old.audit.length);
  assert.deepEqual(rehydrateHistory(state,rows),old);
});

test('all live requests and unsettled request, mail notice and fault provenance survive compaction',()=>{
  const old=fixture(200),pinned=old.requests[0];old.requests.push(request(201,'queued'),request(202,'active'));
  old.codex={enabled:true,testOnly:false,receipts:[],globalFailureCode:'unknown',lastError:'unknown',
    lease:{id:'op',kind:'mail',requestId:pinned.id,targetId:old.notices[0].id,email:pinned.email},
    operationFailureOrigin:{requestId:old.requests[1].id}};
  old.audit[0]={id:'fault',at,actor:owner.email,action:'codex_workspace_blocked',requestId:pinned.id};
  old.audit[1]={id:'verified',at:stamp(1),actor:owner.email,action:'codex_verified_invite',requestId:pinned.id};
  const {state}=compactHistory(old,old);
  assert.ok(state.requests.some(r=>r.id===pinned.id));assert.ok(state.requests.some(r=>r.id===old.requests[1].id));
  assert.equal(state.requests.filter(r=>['queued','active'].includes(r.status)).length,2);
  assert.ok(state.notices.some(n=>n.id===old.notices[0].id));assert.deepEqual(state.codex,old.codex);
  assert.equal(state.audit.length,502);assert.ok(state.audit.some(a=>a.id==='fault'));assert.ok(state.audit.some(a=>a.id==='verified'));
  assert.throws(()=>rehydrateHistory(state,[]),/未结案/);
});

test('a long-lived renewed request does not pin obsolete notices forever',()=>{
  const old=fixture(1),active=old.requests[0];active.status='active';active.expiresAt=stamp(9000);
  old.notices=Array.from({length:2000},(_,i)=>({id:'notice_'+i,key:`${active.id}:renewed:${stamp(i)}`,requestId:active.id,
    userId:alice.userId,email:alice.email,type:'renewed',title:'test',message:'test',createdAt:stamp(i),status:'pending'}));
  old.notices.unshift({id:'current',key:`${active.id}:expiry_30m:${active.expiresAt}`,requestId:active.id,userId:alice.userId,email:alice.email,
    type:'expiry_30m',title:'current',message:'current',createdAt:at,status:'pending'});
  const {state,rows}=compactHistory(old,old);
  assert.equal(state.requests[0].status,'active');assert.equal(state.notices.length,501);
  assert.ok(state.notices.some(n=>n.id==='current'));assert.equal(rows.filter(r=>r.kind==='notice').length,1500);
});

test('audit entries displaced by the legacy 1000 cap are archived in the same write',()=>{
  const previous=fixture(300),next=structuredClone(previous);next.audit=next.audit.slice(-1000);
  const {state,rows}=compactHistory(previous,next);assert.equal(state.audit.length,500);
  assert.equal(rows.filter(r=>r.kind==='audit').length,700);
});

test('one bulk transition emitting more than 1000 new audit events loses none before SQLite archival',async()=>{
  const previous=createState(at);
  previous.requests=Array.from({length:1000},(_,i)=>request(i,'queued',{userId:'staff-'+i,email:`staff${i}@example.com`,isAdmin:false}));
  previous.config.whitelist=previous.requests.map(r=>r.email);
  const next=transition(previous,owner,{type:'configure',config:{whitelist:[]}},stamp(1001));
  assert.equal(next.requests.filter(r=>r.status==='cancelled').length,1000);
  assert.equal(next.audit.length,1001);assert.equal(new Set(next.audit.map(a=>a.id)).size,1001);
  const db=database(previous);try{
    const saved=await persistHistoryCas(db.api,previous,next,0);assert.equal(saved.committed,true);
    const live=JSON.parse(db.sqlite.prepare('SELECT document FROM portal_state').get().document);
    const archived=db.sqlite.prepare("SELECT id FROM portal_history WHERE kind='audit'").all();
    assert.equal(live.audit.length,500);assert.equal(archived.length,501);
    assert.deepEqual(new Set([...live.audit,...archived].map(a=>a.id)),new Set(next.audit.map(a=>a.id)));
  }finally{db.close();}
});

test('archive inserts and current-state CAS commit atomically in real SQLite D1 semantics',async()=>{
  const previous=fixture(),db=database(previous);try{
    const result=await persistHistoryCas(db.api,previous,previous,0);assert.equal(result.committed,true);
    const saved=JSON.parse(db.sqlite.prepare('SELECT document FROM portal_state').get().document);
    assert.equal(saved.requests.length,150);assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM portal_history WHERE kind='request'").get().n,50);
    assert.equal(db.sqlite.prepare('SELECT revision FROM portal_state').get().revision,1);
  }finally{db.close();}
});

test('a stale CAS archives nothing and cannot overwrite a concurrent new request',async()=>{
  const previous=fixture(),db=database(previous);try{
    const concurrent=structuredClone(previous);concurrent.requests.push(request(999,'queued',bob));
    db.beforeBatch(()=>db.sqlite.prepare('UPDATE portal_state SET revision=revision+1,document=?').run(JSON.stringify(concurrent)));
    const result=await persistHistoryCas(db.api,previous,previous,0);assert.equal(result.committed,false);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM portal_history').get().n,0);
    assert.equal(JSON.parse(db.sqlite.prepare('SELECT document FROM portal_state').get().document).requests.at(-1).email,bob.email);
  }finally{db.close();}
});

test('archive insertion error leaves the entire current document and revision intact',async()=>{
  const previous=fixture(),db=database(previous);try{db.failArchive();
    await assert.rejects(persistHistoryCas(db.api,previous,previous,0),/archive unavailable/);
    assert.equal(db.sqlite.prepare('SELECT document FROM portal_state').get().document,JSON.stringify(previous));
    assert.equal(db.sqlite.prepare('SELECT revision FROM portal_state').get().revision,0);
  }finally{db.close();}
});

test('keyset archive pages never leak another employee or same-email different account',async()=>{
  const previous=fixture(240);previous.requests.push(...Array.from({length:10},(_,i)=>request(1000+i,'completed',bob)),
    request(900,'completed',{...alice,userId:'other-alice'}));const db=database(previous);try{
    await persistHistoryCas(db.api,previous,previous,0);
    const seen=[];let cursor;do{const page=await readHistoryPage(db.api,alice,'request',cursor,17);
      assert.ok(page.items.every(r=>r.email===alice.email&&r.userId===alice.userId));
      seen.push(...page.items.map(r=>r.id));cursor=page.nextCursor;}while(cursor);
    assert.equal(seen.length,new Set(seen).size);assert.equal(seen.length,101);
    await assert.rejects(readHistoryPage(db.api,alice,'audit'),/管理员/);
    await assert.rejects(readHistoryPage(db.api,owner,'request','malformed'),/游标/);
    await assert.rejects(readHistoryPage(db.api,owner,'request',null,101),/参数/);
  }finally{db.close();}
});

test('archive idempotency keys remain scoped to the original employee identity',async()=>{
  const previous=fixture(),db=database(previous);try{
    await persistHistoryCas(db.api,previous,previous,0);
    assert.equal((await archivedRequestKey(db.api,alice,'key-0')).id,request(0).id);
    assert.equal(await archivedRequestKey(db.api,bob,'key-0'),null);
    assert.equal(await archivedRequestKey(db.api,{...alice,userId:'another'},'key-0'),null);
  }finally{db.close();}
});

test('a CAS retry rechecks an archive miss after another writer moves the same idempotency key',async()=>{
  const previous=fixture(),db=database(previous);try{
    let raced=false;db.beforeBatch(async()=>{
      if(raced)return;raced=true;
      const saved=await persistHistoryCas(db.api,previous,previous,0);assert.equal(saved.committed,true);
    });
    const service=await serviceModule(db);
    await service.runCommand(alice,{type:'apply',name:'Alice',reason:'network retry',hours:1,requestKey:'key-0'});
    const saved=JSON.parse(db.sqlite.prepare('SELECT document FROM portal_state').get().document);
    assert.equal(raced,true);assert.equal(saved.requests.filter(r=>r.status==='queued').length,0);
    assert.equal(saved.requests.length,150);assert.equal(saved.requestRates,undefined);
    assert.equal((await archivedRequestKey(db.api,alice,'key-0')).id,request(0).id);
  }finally{db.close();}
});

test('history service rejects anonymous and revoked employees before exposing any archive page',async()=>{
  const previous=fixture(),db=database(previous);try{
    await persistHistoryCas(db.api,previous,previous,0);
    assert.equal((await(await serviceModule(db,null)).portalHistory('request')).access,'signin_required');
    const state=JSON.parse(db.sqlite.prepare('SELECT document FROM portal_state').get().document);state.config.whitelist=[];
    db.sqlite.prepare('UPDATE portal_state SET revision=revision+1,document=?').run(JSON.stringify(state));
    const blocked=await(await serviceModule(db)).portalHistory('request');assert.equal(blocked.access,'not_authorized');assert.equal(blocked.page,null);
  }finally{db.close();}
});

test('V11 rollback rehydrates CURRENT records, keeps the archive, preserves new queued work and rejects stale revisions',async()=>{
  const previous=fixture(),db=database(previous);try{
    await persistHistoryCas(db.api,previous,previous,0);
    const current=JSON.parse(db.sqlite.prepare('SELECT document FROM portal_state').get().document);
    current.requests.push(request(9999,'queued',bob));current.codex={enabled:false,testOnly:false,receipts:[]};
    db.sqlite.prepare('UPDATE portal_state SET revision=2,document=?').run(JSON.stringify(current));
    await assert.rejects(restoreV11History(db.api,1),/状态已变化/);
    const result=await restoreV11History(db.api,2);assert.equal(result.prepared,true);assert.equal(result.requests,201);
    const restored=JSON.parse(db.sqlite.prepare('SELECT document FROM portal_state').get().document);
    assert.ok(restored.requests.some(r=>r.id===request(9999).id&&r.status==='queued'));
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM portal_history').get().n,650);
    assert.equal(new Set(restored.requests.map(r=>r.id)).size,201);
    assert.deepEqual(rehydrateHistory(restored,[]),restored);
  }finally{db.close();}
});

test('V11 rollback refuses an enabled scheduler or unresolved lease',async()=>{
  for(const codex of [{enabled:true,receipts:[]},{enabled:false,receipts:[],lease:{id:'op'}}]){
    const previous=fixture(1);previous.codex=codex;const db=database(previous);try{
      await assert.rejects(restoreV11History(db.api,0),/停用/);assert.equal(db.sqlite.prepare('SELECT revision FROM portal_state').get().revision,0);
    }finally{db.close();}
  }
});

test('V11 rollback refuses pending V12 whitelist revocation instead of converting it to member removal',async()=>{
  const previous=fixture(1);previous.requests[0].status='pending_removal';previous.requests[0].removalReason='whitelist_revoked';
  previous.codex={enabled:false,receipts:[]};
  assert.throws(()=>rehydrateHistory(previous,[]),/白名单撤邀/);
  const db=database(previous);try{
    await assert.rejects(restoreV11History(db.api,0),/白名单撤邀/);
    assert.equal(db.sqlite.prepare('SELECT revision FROM portal_state').get().revision,0);
  }finally{db.close();}
});

test('apply/cancel storms hit a deterministic budget, duplicate idempotent retries are free',()=>{
  let state=createState(at);state.config.whitelist=[alice.email];
  for(let i=0;i<12;i++){
    const command={type:'apply',name:'Alice',reason:'rate test',hours:1,requestKey:'request-'+i};
    let next=transition(state,alice,command,stamp(i));enforceRequestRate(state,next,alice,command,stamp(i));state=next;
    next=transition(state,alice,command,stamp(i));enforceRequestRate(state,next,alice,command,stamp(i));
    assert.equal(next.requestRates[0].appliesHour,i+1);
    state=transition(next,alice,{type:'cancel',id:next.requests.at(-1).id},stamp(i));
  }
  const command={type:'apply',name:'Alice',reason:'rate test',hours:1};
  assert.throws(()=>enforceRequestRate(state,transition(state,alice,command,stamp(100)),alice,command,stamp(100)),RequestRateError);
  const nextAt=new Date(Date.parse(at)+3600000).toISOString();
  const next=transition(state,alice,command,nextAt);enforceRequestRate(state,next,alice,command,nextAt);
  assert.equal(next.requestRates[0].appliesHour,1);assert.equal(next.requestRates[0].appliesDay,13);
});

test('rate counters expire by healthy time window and do not retain removed whitelist identities',()=>{
  const previous=createState(at);previous.config.whitelist=[alice.email];previous.requestRates=[
    {email:bob.email,hour:1,day:1,appliesHour:10,appliesDay:10,renewalsHour:0},
    {email:alice.email,hour:1,day:1,appliesHour:12,appliesDay:60,renewalsHour:0}];
  const cmd={type:'apply',name:'Alice',reason:'valid',hours:1};const next=transition(previous,alice,cmd,at);
  enforceRequestRate(previous,next,alice,cmd,at);assert.equal(next.requestRates.length,1);assert.equal(next.requestRates[0].appliesDay,1);
});

test('day limit and renewal-hour limit reject writes before changing the saved rate state',()=>{
  const previous=createState(at);previous.config.whitelist=[alice.email];
  const hour=Math.floor(Date.parse(at)/3600000),day=Math.floor(Date.parse(at)/86400000);
  previous.requestRates=[{email:alice.email,hour,day,appliesHour:0,appliesDay:60,renewalsHour:12}];
  const next=structuredClone(previous);next.revision++;
  assert.throws(()=>enforceRequestRate(previous,next,alice,{type:'apply'},at),RequestRateError);
  assert.throws(()=>enforceRequestRate(previous,next,alice,{type:'renew'},at),RequestRateError);
  assert.equal(previous.requestRates[0].appliesDay,60);assert.equal(previous.requestRates[0].renewalsHour,12);
});
