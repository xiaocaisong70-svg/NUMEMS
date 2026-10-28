// Production RPC and production mutateState with a SQLite-backed D1 adapter.
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';import {webcrypto} from 'node:crypto';
import * as engine from '../lib/seat-engine.ts';import * as bridge from '../lib/codex-bridge.ts';
import * as policy from '../lib/reminder-policy.ts';import * as access from '../lib/portal-access.ts';
const require=createRequire(import.meta.url),ts=require('typescript');
const compile=async p=>ts.transpileModule(await readFile(new URL(p,import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
test('slow CAS retry cannot clear an operation fault using the now-expired completion snapshot',async()=>{
  let ms=Date.parse('2026-10-27T10:00:00Z');const now=()=>new Date(ms).toISOString();
  class FakeDate extends Date{constructor(...args){super(...(args.length?args:[ms]));}static now(){return ms;}}
  const owner={userId:'owner',email:engine.PROTECTED_OWNER_EMAIL,isAdmin:true};
  const person={userId:'person',email:'person@example.com',isAdmin:false};
  const snapshot={workspaceId:bridge.TARGET_WORKSPACE_ID,accountEmail:owner.email,complete:true,totalSeats:4,
    observedAt:now(),pageUrl:`https://admin.openai.com/workspace/${bridge.TARGET_WORKSPACE_ID}/members`,
    members:[{email:owner.email,role:'owner'}],invites:[]};
  let state=bridge.observeWorkspace(engine.createState(now()),snapshot,now());
  state=engine.transition(state,owner,{type:'configure',config:{automationEnabled:true,whitelist:[person.email]}},now());
  state.codex.enabled=true;state.codex.testOnly=false;state.codex.mailEnabled=false;
  state=engine.transition(state,person,{type:'apply',name:'Person',reason:'work',hours:1},now());
  state=engine.transition(state,owner,{type:'tick'},now());
  state=bridge.claimOperation(state,'invite',state.requests[0].id,'test-token',now());const op=state.codex.lease;
  ms+=1000;state=bridge.completeOperation(state,{operationId:op.id,token:op.token,outcome:'uncertain',failureCode:'unknown',
    detail:'程序办理未完成；保留原租约和证据，不自动重做外部动作。'},now());
  ms+=1000;snapshot.observedAt=now();snapshot.members.push({email:person.email,role:'member'});
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE portal_state(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL)');
  db.prepare('INSERT INTO portal_state VALUES(?,?,?)').run('main',0,JSON.stringify(state));let conflicts=0;
  const DB={prepare(sql){let args=[];return{bind(...v){args=v;return this;},async first(){return db.prepare(sql).get(...args)??null;},
    async run(){if(sql.startsWith('UPDATE portal_state')&&conflicts++===0){db.prepare('UPDATE portal_state SET revision=revision+1 WHERE id=?').run('main');ms+=61_000;}
      const r=db.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}};}};}};
  const ctx=vm.createContext({Request,Response,TextEncoder,URL,crypto:webcrypto,console,Date:FakeDate,structuredClone});
  const make=values=>new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context:ctx});
  const base={'cloudflare:workers':{env:{DB,REMINDER_DELIVERY_MODE:'in_app'}},'@/app/chatgpt-auth':{getChatGPTUser:async()=>owner},
    '@/lib/seat-engine':engine,'@/lib/codex-bridge':bridge,'@/lib/reminder-policy':policy,'@/lib/portal-access':access,
    './seat-engine':engine,'./reminder-policy':policy,'./portal-access':access,'@/lib/jobs':{runJobs:async()=>({}),refreshSeatQueue:async()=>({})}};
  const service=new vm.SourceTextModule(await compile('../lib/portal-service.ts'),{context:ctx});
  await service.link(s=>make(base[s]));await service.evaluate();
  const route=new vm.SourceTextModule(await compile('../app/mcp/route.ts'),{context:ctx});
  await route.link(s=>s==='@/lib/portal-service'?service:make(base[s]));await route.evaluate();
  try{
    const req=new Request('https://qa.invalid/mcp',{method:'POST',headers:{origin:'https://qa.invalid','content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'complete_seat_operation',arguments:{operationId:op.id,token:op.token,outcome:'verified',observation:snapshot}}})});
    const body=await(await route.namespace.POST(req)).json();assert.equal(body.result.isError,true);assert.equal(conflicts,1);
    const saved=JSON.parse(db.prepare('SELECT document FROM portal_state WHERE id=?').get('main').document);
    assert.equal(saved.codex.globalFailureCode,'unknown');assert.equal(saved.codex.lease.id,op.id);
    assert.equal(saved.codex.receipts.some(r=>r.id===op.id),false);
  }finally{db.close();}
});
