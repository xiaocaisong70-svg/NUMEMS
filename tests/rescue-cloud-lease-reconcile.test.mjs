import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {reconcileRescueReadOnly} from '../scripts/agentless/rescue-readonly.mjs';
import {atomicJson,readJson} from '../scripts/agentless/journal.mjs';
import {validateConfig} from '../scripts/agentless/config.mjs';

async function fixture(t,{authorized=true}={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-rescue-cloud-lease-'));
  t.after(async()=>{const rel=path.relative(os.tmpdir(),directory);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));await rm(directory,{recursive:true,force:true});});
  const config=validateConfig({liveActions:true}),journalFile=path.join(directory,'operation.json'),instant=Date.now(),at=ms=>new Date(instant+ms).toISOString();
  const target={kind:'remove',targetId:'req_approved',email:'fixture@example.com',requestUpdatedAt:at(-10000)};
  const ticket={scope:'approved_member_ops',failureId:'codex_original',ticket:{id:'rescue_0123456789abcdef0123456789abcdef',
    failureId:'codex_original',scope:'approved_member_ops',phase:'pending',targets:[target]}};
  let plan={workspaceId:config.workspaceId,administrator:config.adminEmail,enabled:true,testOnly:false,busy:true,globalFailureCode:'browser_unavailable',
    globalFailureId:'codex_original',lastError:'ordinary channel blocked',receipts:[],blockedOperations:[],
    faultRescue:{...ticket.ticket},lease:{id:'op_original_rescue',token:'fixture-protected-lease-token',kind:'remove',targetId:target.targetId,email:target.email,
      claimedAt:at(-5000),status:authorized?'uncertain':'claimed',originalPresence:'member',rescueId:ticket.ticket.id,rescueFailureId:ticket.failureId,
      rescueRequestUpdatedAt:target.requestUpdatedAt,...(authorized?{actionAuthorizedAt:at(-3000)}:{})}};
  const snapshot={complete:true,workspaceId:config.workspaceId,workspaceName:config.workspaceName,accountEmail:config.adminEmail,
    totalSeats:4,seatLabel:config.seatLabel,observedAt:at(0),pageUrl:`https://admin.openai.com/workspace/${config.workspaceId}/members`,
    members:[{email:config.adminEmail,role:'owner',seatLabel:config.seatLabel}],invites:[]};
  const calls=[],reads=[];
  const portal={async call(name,args){calls.push({name,args});
    if(name==='complete_seat_operation'){plan={...plan,busy:false,lease:null,receipts:[{id:args.operationId}]};}
    if(name==='review_seat_failure')plan={...plan,lastError:null,globalFailureCode:null,globalFailureId:null,officialObservedAt:args.observation.observedAt};
    return {plan:structuredClone(plan)};}};
  const browser={async observe(){reads.push('dedicated');return structuredClone(snapshot);},async invite(){assert.fail('never replay invite');},async remove(){assert.fail('never replay removal');}};
  await atomicJson(journalFile,{phase:'settled'});
  const args={portal,browser,config,journalFile,ticket};
  return {args,portal,browser,journalFile,calls,reads,ticket,snapshot,get plan(){return plan;},set plan(value){plan=value;}};
}

test('a cloud-only authorized rescue lease can finish by dedicated official proof, without another action',async t=>{
  const f=await fixture(t);assert.equal((await reconcileRescueReadOnly(f.args)).healthy,true);
  assert.equal(f.reads.length,2,'one original-op read and a separate dedicated-channel health read');
  const complete=f.calls.filter(c=>c.name==='complete_seat_operation');assert.equal(complete.length,1);assert.equal(complete[0].args.outcome,'verified');
  assert.equal(complete[0].args.operationId,'op_original_rescue');assert.equal((await readJson(f.journalFile)).phase,'settled');
  assert.ok(f.calls.every(c=>!['claim_seat_operation','claim_rescue_operation','authorize_rescue_action'].includes(c.name)));
});

test('an exact rescue lease which never received authorization can only submit not_started evidence',async t=>{
  const f=await fixture(t,{authorized:false});f.snapshot.members.push({email:'fixture@example.com',role:'member',seatLabel:f.args.config.seatLabel});
  assert.equal((await reconcileRescueReadOnly(f.args)).healthy,true);
  assert.equal(f.calls.find(c=>c.name==='complete_seat_operation').args.outcome,'not_started');
});

test('foreign IDs, targets and original leases are never adopted into the ordinary journal',async t=>{
  for(const change of [f=>{f.plan={...f.plan,lease:{...f.plan.lease,rescueId:'rescue_another'}};},
    f=>{f.ticket.ticket.targets=[{...f.ticket.ticket.targets[0],targetId:'req_foreign'}];},
    f=>{f.plan={...f.plan,lease:{...f.plan.lease,rescueFailureId:'new_fault'}};}]) {
    const f=await fixture(t);change(f);await assert.rejects(reconcileRescueReadOnly(f.args),/原租约/);
    assert.equal(f.reads.length,0);assert.equal((await readJson(f.journalFile)).phase,'settled');
    assert.equal(f.calls.some(c=>c.name==='complete_seat_operation'),false);
  }
});

test('a possible rescue write with a still-present target keeps exact original lease and never retries UI',async t=>{
  const f=await fixture(t);f.snapshot.members.push({email:'fixture@example.com',role:'member',seatLabel:f.args.config.seatLabel});
  await assert.rejects(reconcileRescueReadOnly(f.args),/保留原租约/);
  const j=await readJson(f.journalFile);assert.equal(j.phase,'claimed');assert.equal(j.lease.id,'op_original_rescue');
  assert.equal(f.calls.some(c=>c.name==='complete_seat_operation'),false);
});

test('an ambiguous rescue completion keeps full local receipt and does not clear the dedicated-channel fault',async t=>{
  const f=await fixture(t),call=f.portal.call.bind(f.portal);let writes=0;
  f.portal.call=async(name,...args)=>{if(name==='complete_seat_operation'){writes++;throw new Error('response unknown');}return call(name,...args);};
  await assert.rejects(reconcileRescueReadOnly(f.args),/unknown/);assert.equal(writes,1);
  const j=await readJson(f.journalFile);assert.equal(j.phase,'completing');assert.equal(j.receipt.operationId,j.lease.id);
  assert.equal(f.calls.some(c=>c.name==='review_seat_failure'),false);assert.equal(f.plan.globalFailureCode,'browser_unavailable');
});

test('a retained invite submission time must match the exact original lease before reconciliation',async t=>{
  for(const valid of [true,false]) {
    const f=await fixture(t),lease={...f.plan.lease,kind:'invite',originalPresence:'absent'};
    f.ticket.ticket.targets[0].kind='invite';f.plan.faultRescue.targets[0].kind='invite';f.plan={...f.plan,lease};
    f.snapshot.invites=[{email:lease.email,role:'member',seatLabel:f.args.config.seatLabel}];
    const sentAt=new Date(Date.parse(lease.claimedAt)+1000).toISOString();
    await atomicJson(f.journalFile,{phase:'attempting',lease,submission:{operationId:valid?lease.id:'op_another',kind:'invite',email:lease.email,invitationSentAt:sentAt}});
    if(valid){assert.equal((await reconcileRescueReadOnly(f.args)).healthy,true);
      assert.equal(f.calls.find(c=>c.name==='complete_seat_operation').args.invitationSentAt,sentAt);}
    else {await assert.rejects(reconcileRescueReadOnly(f.args),/提交时间不能匹配/);
      assert.equal(f.calls.some(c=>c.name==='complete_seat_operation'),false);assert.equal((await readJson(f.journalFile)).phase,'attempting');}
  }
});

test('cloud-only rescue invitation uses the exact protected submission marker without guessing or replay',async t=>{
  for(const kind of ['valid','missing','foreign_client','foreign_operation','future','duplicate']) {
    const f=await fixture(t),lease={...f.plan.lease,kind:'invite',originalPresence:'absent'};
    f.ticket.clientId='numems-fault:own-client';f.ticket.queuedId='queue_own';
    f.ticket.ticket.targets[0].kind='invite';f.plan.faultRescue.targets[0].kind='invite';f.plan={...f.plan,lease};
    f.snapshot.invites=[{email:lease.email,role:'member',seatLabel:f.args.config.seatLabel}];
    const marker={rescueId:f.ticket.ticket.id,clientId:f.ticket.clientId,queuedId:f.ticket.queuedId,operationId:lease.id,
      targetId:lease.targetId,email:lease.email,kind:'invite',invitationSentAt:new Date(Date.parse(lease.claimedAt)+1000).toISOString(),recordedAt:new Date().toISOString()};
    if(kind==='foreign_client')marker.clientId='another_client';
    if(kind==='foreign_operation')marker.operationId='op_another';
    if(kind==='future')marker.invitationSentAt=new Date(Date.now()+60000).toISOString();
    if(kind!=='missing')await atomicJson(path.join(path.dirname(f.journalFile),'rescue-submissions.json'),{version:1,entries:kind==='duplicate'?[marker,{...marker}]:[marker]});
    if(kind==='valid') {
      assert.equal((await reconcileRescueReadOnly(f.args)).healthy,true);
      assert.equal(f.calls.find(c=>c.name==='complete_seat_operation').args.invitationSentAt,marker.invitationSentAt);
    }else{
      await assert.rejects(reconcileRescueReadOnly(f.args),/提交.*时间|提交标记/);
      assert.equal(f.calls.some(c=>c.name==='complete_seat_operation'),false);assert.equal(f.plan.lease.id,lease.id);
    }
  }
});
