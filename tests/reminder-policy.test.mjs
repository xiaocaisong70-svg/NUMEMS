import test from 'node:test';
import assert from 'node:assert/strict';
import {createState, transition, viewState, PROTECTED_OWNER_EMAIL} from '../lib/seat-engine.ts';
import {applyReminderPolicy, reminderMode, expiryReminder} from '../lib/reminder-policy.ts';
import {setBridgeMode, workPlan, claimOperation} from '../lib/codex-bridge.ts';
const now='2026-10-23T06:00:00.000Z';
const owner={userId:'owner',email:PROTECTED_OWNER_EMAIL,isAdmin:true};
const employee={userId:'employee',email:'staff@example.com',isAdmin:false};
function active() {
  let s=createState(now);
  s.config.whitelist=[employee.email];s.config.inventoryVerified=true;
  s.requests=[{id:'req_fixture',...employee,name:'Staff',reason:'test',hours:1,status:'active',
    createdAt:now,updatedAt:now,expiresAt:'2026-10-23T06:30:00.000Z'}];
  s.codex={enabled:true,testOnly:false,mailEnabled:true,receipts:[]};
  return applyReminderPolicy(s,'in_app');
}
test('web-only delivery retains deduplicated notices, denies mail claims and keeps employee isolation',()=>{
  let s=transition(active(),owner,{type:'tick'},now);
  s=transition(s,owner,{type:'tick'},now);
  const notices=s.notices.filter(n=>n.type==='expiry_30m');assert.equal(notices.length,1);
  assert.equal(notices[0].status,'pending');assert.equal(workPlan(s,now).reminders.length,0);
  assert.throws(()=>claimOperation(s,'mail',notices[0].id,'token',now),/网页提醒/);
  assert.equal(viewState(s,employee,now).notices.length,1);
  assert.equal(viewState(s,{...employee,userId:'other',email:'other@example.com'},now).notices.length,0);
  const renewed=transition(s,employee,{type:'renew',id:'req_fixture',hours:2},now);
  assert.equal(renewed.notices[0].status,'cancelled');
  assert.equal(expiryReminder(renewed.requests[0],Date.parse(now)),null);
});
test('web-only live enable still requires actual invite and removal evidence; relay also requires mail evidence',()=>{
  const s=active();assert.throws(()=>setBridgeMode(s,true,now),/真实邀请/);
  s.codex.inviteVerifiedAt=now;assert.throws(()=>setBridgeMode(s,true,now),/真实邀请/);
  s.codex.removalVerifiedAt=now;assert.equal(setBridgeMode(s,true,now).codex.enabled,true);
  assert.equal(s.codex.mailVerifiedAt,undefined);
  assert.throws(()=>setBridgeMode(applyReminderPolicy(s,'relay'),true,now),/邮件/);
});
test('30-minute banner follows server time, hides stale/expired/released records, never invents mail receipts',()=>{
  const r=active().requests[0],t=Date.parse(now);
  assert.equal(expiryReminder(r,t-1),null);assert.equal(expiryReminder(r,t).seconds,1800);
  assert.equal(expiryReminder(r,t+1800000),null);assert.equal(expiryReminder(r,t,true),null);
  assert.equal(expiryReminder({...r,status:'pending_removal'},t),null);
  assert.equal(expiryReminder({...r,expiresAt:'invalid'},t),null);
  assert.equal(reminderMode(undefined),'in_app');assert.equal(reminderMode('codex'),'in_app');
  const s=active();s.codex.lease={id:'unresolved',kind:'mail'};s.codex.mailChannelError='unknown delivery';
  const changed=applyReminderPolicy(s,'in_app');assert.deepEqual(changed.codex.lease,s.codex.lease);
  assert.equal(changed.codex.mailChannelError,'unknown delivery');assert.equal(changed.codex.mailVerifiedAt,undefined);
});
