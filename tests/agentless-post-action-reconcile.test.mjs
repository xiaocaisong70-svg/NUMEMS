import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,unlink,rmdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runBatch} from '../scripts/agentless/core.mjs';
import {validateConfig,ADMIN,WORKSPACE} from '../scripts/agentless/config.mjs';
import {Journal,readJson} from '../scripts/agentless/journal.mjs';
import {InventoryMismatchError} from '../scripts/seat-executor/browser.mjs';

const now='2026-10-28T04:00:00.000Z',email='controlled-fixture@example.com';
const unavailable=()=>Object.assign(new Error('fixture loading'),{failureCode:'browser_unavailable'});
async function fixture(t,kind='remove') {
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-post-action-reconcile-'));
  const journalFile=path.join(dir,'operation.json'),journal=new Journal(journalFile);
  t.after(async()=>{await unlink(journalFile).catch(e=>{if(e.code!=='ENOENT')throw e;});await rmdir(dir);});
  const config=validateConfig({liveActions:true,legacyCheckerDisabled:true,mailMode:'in_app'});
  const item={id:'req_fixture_1',email,removalReason:'expired'};
  const lease={id:'op_fixture_1',token:'fixture-only-operation-token',kind,targetId:item.id,email,
    originalPresence:kind==='remove'?'member':'absent'};
  const plan={workspaceId:WORKSPACE,administrator:ADMIN,enabled:true,busy:false,lease:null,
    invites:kind==='invite'?[item]:[],removals:kind==='remove'?[item]:[],awaitingAcceptance:[],blockedOperations:[]};
  const members=new Set(kind==='remove'?[email]:[]),invites=new Set(),calls=[],clicks=[],pauses=[];
  const snapshot=()=>({workspaceId:WORKSPACE,workspaceName:'My Workspace',accountEmail:ADMIN,
    complete:true,totalSeats:4,seatLabel:'高级',observedAt:now,
    pageUrl:`https://admin.openai.com/workspace/${WORKSPACE}/members`,
    members:[{email:ADMIN,role:'owner',seatLabel:'高级'},...Array.from(members,email=>({email,role:'member',seatLabel:'高级'}))],
    invites:Array.from(invites,email=>({email,role:'member',seatLabel:'高级'}))});
  const portal={call:async(name,args)=>{
    calls.push({name,args:structuredClone(args)});
    if(name==='process_seat_queue')return {mailMode:'in_app'};
    if(name==='claim_seat_operation'){plan.busy=true;plan.lease=structuredClone(lease);}
    if(name==='complete_seat_operation') {
      assert.equal(args.operationId,lease.id);assert.equal(args.token,lease.token);
      if(args.outcome==='verified'||args.outcome==='joined') {
        plan.busy=false;plan.lease=null;plan.invites=[];plan.removals=[];
      } else {plan.globalFailureCode=args.failureCode;plan.lastError='fixture failure retained';}
    }
    return {plan:structuredClone(plan)};
  }};
  const browser={observe:async()=>snapshot(),
    async remove(target){await this.onExternalAction();clicks.push(['remove',target]);members.delete(target);invites.delete(target);},
    async invite(target){await this.onExternalAction();clicks.push(['invite',target]);invites.add(target);return now;}};
  const run=()=>runBatch({portal,browser,config,journal,clock:()=>new Date(now),maxItems:1,
    pause:async ms=>pauses.push(ms)});
  return {config,lease,plan,browser,portal,journal,journalFile,snapshot,calls,clicks,pauses,run};
}

test('one invite or removal click is completed on the original lease after bounded incomplete post-action reads',async t=>{
  for(const kind of ['remove','invite']) {
  const f=await fixture(t,kind);let reads=0;
  f.browser.observe=async()=>{
    reads++;
    if(reads===3||reads===5)throw unavailable();
    if(reads===4)throw new InventoryMismatchError({total:4,assigned:2,available:2},1,0);
    return f.snapshot();
  };
  const result=await f.run();
  assert.equal(reads,6);assert.deepEqual(f.pauses,[1000,3000]);assert.deepEqual(f.clicks,[[kind,email]]);
  assert.equal(result.actions[0].outcome,'verified');
  const completed=f.calls.filter(c=>c.name==='complete_seat_operation');
  assert.equal(completed.length,1);assert.equal(completed[0].args.operationId,f.lease.id);
  assert.equal(completed[0].args.outcome,'verified');assert.equal(f.plan.lease,null);
  const j=await readJson(f.journalFile);assert.equal(j.phase,'settled');assert.equal(j.postActionReconcile.attempt,3);
  assert.equal(j.postActionReconcile.classification,'complete_read');
  }
});

test('persistent incomplete reads stop after three catch observations and retain unknown original lease',async t=>{
  const f=await fixture(t);let reads=0;
  f.browser.observe=async()=>{if(++reads>2)throw unavailable();return f.snapshot();};
  await assert.rejects(f.run(),error=>error.failureCode==='unknown');
  assert.equal(reads,6);assert.deepEqual(f.pauses,[1000,3000]);assert.equal(f.clicks.length,1);
  assert.equal(f.plan.globalFailureCode,'unknown');assert.deepEqual(f.plan.lease,f.lease);
  const completed=f.calls.filter(c=>c.name==='complete_seat_operation');
  assert.equal(completed.length,1);assert.equal(completed[0].args.outcome,'uncertain');
  assert.equal(completed[0].args.failureCode,'unknown');
  const j=await readJson(f.journalFile);assert.equal(j.phase,'attempting');assert.deepEqual(j.lease,f.lease);
  assert.equal(j.receipt,undefined);assert.equal(j.postActionReconcile.attempt,3);
});

test('new admin target in a returned snapshot is fatal and never accepted as a verified invitation',async t=>{
  const f=await fixture(t,'invite');let reads=0;
  f.browser.observe=async()=>{
    reads++;
    if(reads===3)throw unavailable();
    if(reads===4)return {...f.snapshot(),invites:[],members:[
      {email:ADMIN,role:'owner',seatLabel:'高级'},{email,role:'admin',seatLabel:'高级'}]};
    return f.snapshot();
  };
  await assert.rejects(f.run(),error=>error.failureCode==='role_mismatch');
  assert.equal(reads,4);assert.deepEqual(f.pauses,[]);assert.deepEqual(f.clicks,[['invite',email]]);
  const completed=f.calls.filter(c=>c.name==='complete_seat_operation');
  assert.equal(completed.length,1);assert.equal(completed[0].args.failureCode,'role_mismatch');
  assert.equal(completed[0].args.observation,undefined);assert.deepEqual(f.plan.lease,f.lease);
});

test('new login, workspace, role, capacity and unknown read errors never receive another read',async t=>{
  for(const failureCode of ['login_expired','workspace_mismatch','role_mismatch','capacity_mismatch',undefined]) {
    const f=await fixture(t);let reads=0;
    f.browser.observe=async()=>{
      reads++;
      if(reads===3)throw unavailable();
      if(reads===4)throw Object.assign(new Error('fatal fixture observation'),failureCode?{failureCode}:{});
      return f.snapshot();
    };
    await assert.rejects(f.run(),error=>error.failureCode===(failureCode??'unknown'));
    assert.equal(reads,4);assert.deepEqual(f.pauses,[]);assert.equal(f.clicks.length,1);
    assert.equal(f.plan.globalFailureCode,failureCode??'unknown');assert.deepEqual(f.plan.lease,f.lease);
  }
});

test('completion RPC with unknown result is submitted only once and retains the original local receipt bytes',async t=>{
  for(const reconciled of [false,true]) {
  const f=await fixture(t);let reads=0,submitted;
  f.browser.observe=async()=>{reads++;if(reconciled&&reads===3)throw unavailable();return f.snapshot();};
  const call=f.portal.call;
  f.portal.call=async(name,args)=>{
    if(name==='complete_seat_operation') {
      f.calls.push({name,args:structuredClone(args)});submitted=structuredClone(args);
      throw new Error('fixture completion response lost');
    }
    return call(name,args);
  };
  await assert.rejects(f.run(),error=>error.failureCode==='unknown'&&/回执写入未确认/.test(error.message));
  assert.equal(reads,reconciled?4:3);assert.deepEqual(f.pauses,[]);assert.equal(f.clicks.length,1);
  assert.equal(f.calls.filter(c=>c.name==='complete_seat_operation').length,1);
  const j=await readJson(f.journalFile);assert.equal(j.phase,'completing');assert.deepEqual(j.receipt,submitted);
  assert.deepEqual(j.lease,f.lease);assert.deepEqual(f.plan.lease,f.lease);
  }
});

test('the original safe operation stage survives a replacement read error without mutating either error',async t=>{
  const f=await fixture(t);let reads=0;
  const diagnostic={kind:'remove',stage:'dialogs_closed',category:'timeout',observedAt:now};
  const original=Object.freeze(Object.assign(new Error('fixture action wait'),{
    operationDiagnostic:Object.freeze({...diagnostic,body:'must not persist',token:'must not persist'})}));
  const readError=Object.freeze(Object.assign(new Error('fixture observation failure'),{
    operationDiagnostic:Object.freeze({kind:'invalid',stage:'secret-value'})}));
  const remove=f.browser.remove;
  f.browser.remove=async function(target){await remove.call(this,target);throw original;};
  f.browser.observe=async()=>{reads++;if(reads===3)throw unavailable();if(reads===4)throw readError;return f.snapshot();};
  await assert.rejects(f.run(),error=>{
    assert.equal(error.failureCode,'unknown');assert.equal(error.cause,readError);
    assert.deepEqual(error.operationDiagnostic,diagnostic);return true;
  });
  assert.equal(reads,4);assert.deepEqual(f.pauses,[1000]);assert.equal(f.clicks.length,1);
  const j=await readJson(f.journalFile);assert.deepEqual(j.operationDiagnostic,diagnostic);
  assert.equal(j.postActionReconcile.classification,'unknown');
  assert.equal(j.phase,'attempting');assert.deepEqual(j.lease,f.lease);
  assert.equal(readError.operationDiagnostic.kind,'invalid');
});
