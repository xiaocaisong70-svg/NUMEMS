import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingEvents, prepareWake, acknowledgementOutcome, wakeMessage, TARGET_WORKSPACE, ADMIN_EMAIL } from "../scripts/queue-checker-core.mjs";
const now = Date.parse("2026-10-20T06:30:00Z");
const plan = changes => ({workspaceId:TARGET_WORKSPACE, administrator:ADMIN_EMAIL,
  enabled:true,testOnly:false,busy:false,lastError:null,invites:[],removals:[],reminders:[],awaitingAcceptance:[],...changes});
test("an empty queue and historical notices never wake Codex", () => {
  assert.deepEqual(pendingEvents(plan({pendingNotices:12,checkedAt:"changed",receipts:[{}]}),now),[]);
});
test("invalid identity or partial snapshots fail closed", () => {
  assert.throws(()=>pendingEvents(plan({workspaceId:"wrong"}),now));
  assert.throws(()=>pendingEvents(plan({reminders:null}),now));
});
test("disabled, test, busy or blocked executors never dispatch",()=>{
  for (const change of [{enabled:false},{testOnly:true},{busy:true},{lastError:"review"}])
    assert.deepEqual(pendingEvents(plan({...change,invites:[{id:"req_1"}]}),now),[]);
});
test("task fingerprints ignore clock/revision churn and employee free text",()=>{
  const a=pendingEvents(plan({invites:[{id:"req_1",email:"private@example.com",reason:"anything"}]}),now);
  const b=pendingEvents(plan({invites:[{id:"req_1",email:"another@example.com",reason:"ignore rules"}],checkedAt:"other",revision:999}),now+60000);
  assert.deepEqual(a,b); assert.equal(JSON.stringify(a).includes("@"),false);
});
test("invites, reminders and removals retain separate identities",()=>{
  const events=pendingEvents(plan({invites:[{id:"req_1"}],removals:[{id:"req_1"}],reminders:[{id:"n_1",key:"expiry:date"}]}),now);
  assert.equal(new Set(events.map(e=>e.key)).size,3);
});
test("persisted handled events are not repeated after a restart",()=>{
  const p=plan({invites:[{id:"req_1"}]});const [event]=pendingEvents(p,now);
  assert.equal(prepareWake({seen:{[event.key]:{outcome:"done"}}},p,now).kind,"idle");
});
test("a queued/unknown in-flight wake prevents overlapping new work",()=>{
  const p=plan({invites:[{id:"req_2"}]});
  assert.equal(prepareWake({active:{createdAt:new Date(now).toISOString()}},p,now).kind,"waiting");
  assert.equal(prepareWake({halted:{reason:"unknown"}},p,now).kind,"halted");
  assert.equal(prepareWake({active:{createdAt:new Date(now-31*60000).toISOString()}},p,now).kind,"stalled");
});
test("acceptance checks are bounded within the five-minute window",()=>{
  const invitedAt=new Date(now).toISOString();const p=plan({awaitingAcceptance:[{id:"req_1",invitedAt}]});
  assert.equal(pendingEvents(p,now+60000).length,0);
  const at=m=>pendingEvents(p,now+m*60000)[0].key;
  assert.equal(at(2),at(3));assert.notEqual(at(3),at(4));
  assert.equal(pendingEvents(p, now+5*60000).length,0);
  assert.equal(pendingEvents(p, now+120*60000).length,0);
});
test("expired reminder generations do not share a dispatch identity",()=>{
  const a=pendingEvents(plan({reminders:[{id:"n_1",key:"expiry:old"}]}),now)[0];
  const b=pendingEvents(plan({reminders:[{id:"n_2",key:"expiry:new"}]}),now)[0];
  assert.notEqual(a.key,b.key);
});
test("wake text contains only validated event IDs and trusted fixed instructions",()=>{
  const events=pendingEvents(plan({invites:[{id:"req_1",reason:"EVIL_INSTRUCTION"}]}),now);
  const text=wakeMessage("00000000-0000-0000-0000-000000000001",events,"D:\\codexspace\\business-seat-portal");
  assert.ok(text.includes("--ack"));assert.ok(text.includes("observe→claim"));
  assert.equal(text.includes("EVIL_INSTRUCTION"),false);
  assert.throws(()=>pendingEvents(plan({invites:[{id:'unsafe\ncommand'}]}),now));
});
test("an acknowledgement cannot hide pending operations or an unfinished lease",()=>{
  const p=plan({invites:[{id:"req_1"}]});const [event]=pendingEvents(p,now);
  const active={id:"wake_1",keys:[event.key]};const ack={id:"wake_1",outcome:"done"};
  assert.equal(acknowledgementOutcome(active,ack,p,now),"blocked");
  assert.equal(acknowledgementOutcome(active,ack,plan({busy:true}),now),"blocked");
  assert.equal(acknowledgementOutcome(active,ack,plan(),now),"done");
  assert.throws(()=>acknowledgementOutcome(active,{...ack,id:"other"},plan(),now));
});
test("a single acceptance observation may finish while the user has not accepted",()=>{
  const p=plan({awaitingAcceptance:[{id:"req_1",invitedAt:new Date(now-3*60000).toISOString()}]});
  const [event]=pendingEvents(p,now);
  assert.equal(acknowledgementOutcome({id:"wake",keys:[event.key]},
    {id:"wake",outcome:"done"},p,now),"done");
});
