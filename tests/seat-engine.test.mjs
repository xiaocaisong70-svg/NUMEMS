import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, transition, viewState, PROTECTED_OWNER_EMAIL } from '../lib/seat-engine.ts';
const NOW = '2026-10-20T00:00:00.000Z';
const owner = { userId: 'owner', email: PROTECTED_OWNER_EMAIL, isAdmin: true };
const alice = { userId: 'a', email: 'alice@example.com', isAdmin: false };
const bob = { userId: 'b', email: 'bob@example.com', isAdmin: false };
const carol = { userId: 'c', email: 'carol@example.com', isAdmin: false };
const at = hours => new Date(Date.parse(NOW) + hours * 3600000).toISOString();
const act = (state, command, actor = owner, time = NOW) => transition(state, actor, command, time);
const apply = (state, actor = alice, hours = 1, time = NOW) => act(state, { type: 'apply', name: actor.userId, reason: '项目研发', hours }, actor, time);
function configured({ verified = true, enabled = true, seats = 2 } = {}) {
  let state = act(createState(NOW), { type: 'configure', config: { totalSeats: seats, workspaceId: 'workspace-1', automationEnabled: enabled, whitelist: [alice.email, bob.email, carol.email] } });
  if (verified) state = act(state, { type: 'sync_inventory', members: [{ email: owner.email, role: 'owner' }] });
  return state;
}
function activate(state, id, time = NOW) {
  state = act(state, { type: 'confirm_invited', id }, owner, time);
  return act(state, { type: 'confirm_active', id }, owner, time);
}
test('deep copying, validation and identity guardrails', () => {
  const initial = configured(), original = structuredClone(initial);
  const state = apply(initial);
  assert.deepEqual(initial, original); assert.notEqual(state.config, initial.config);
  assert.equal(state.requests[0].status, 'queued');
  assert.throws(() => apply(state), /重复/);
  assert.throws(() => apply(initial, { ...alice, email: 'outsider@example.com' }), /名单/);
  assert.throws(() => apply(initial, alice, 8), /申请小时数/);
  assert.throws(() => apply(initial, owner), /保留/);
  assert.throws(() => act(initial, { type: 'tick' }, alice), /管理员/);
  assert.throws(() => act(initial, { type: 'configure', config: { inventoryVerified: true } }), /盘点状态/);
});
test('normalized whitelist and protected owner email', () => {
  assert.equal(PROTECTED_OWNER_EMAIL, 'xiaocaisong70@gmail.com');
  let state = act(createState(NOW), { type: 'configure', config: { whitelist: [' ALICE@EXAMPLE.COM ', alice.email, owner.email] } });
  assert.deepEqual(state.config.whitelist, [alice.email]);
  state = apply(state, { ...alice, email: ' ALICE@EXAMPLE.COM ' });
  assert.equal(state.requests[0].email, alice.email);
});
test('allocation needs verified inventory, workspace and enabled automation', () => {
  for (const settings of [{ verified: false }, { enabled: false }]) {
    const state = apply(configured(settings));
    assert.equal(act(state, { type: 'tick' }).requests[0].status, 'queued');
  }
  let state = act(createState(NOW), { type: 'configure', config: { automationEnabled: true, whitelist: [alice.email] } });
  state = apply(state);
  assert.equal(act(state, { type: 'tick' }).requests[0].status, 'queued');
});
test('FIFO capacity and tick idempotency', () => {
  let state = apply(configured()); state = apply(state, bob, 1, at(0.01));
  state = act(state, { type: 'tick' }, owner, at(0.02));
  assert.deepEqual(state.requests.map(r => r.status), ['pending_invite', 'queued']);
  assert.equal(viewState(state, owner).aggregate.usedSeats, 2);
  assert.deepEqual(act(state, { type: 'tick' }, owner, at(0.03)), state);
  assert.equal(new Set(state.notices.map(n => n.key)).size, state.notices.length);
});
test('expiry retains capacity until explicit removal confirmation', () => {
  let state = apply(configured()); const id = state.requests[0].id;
  state = activate(act(state, { type: 'tick' }), id); state = apply(state, bob);
  state = act(state, { type: 'tick' }, owner, at(1));
  assert.deepEqual(state.requests.map(r => r.status), ['pending_removal', 'queued']);
  assert.equal(viewState(state, owner).aggregate.availableSeats, 0);
  state = act(state, { type: 'confirm_removed', id }, owner, at(1.1));
  state = act(state, { type: 'tick' }, owner, at(1.2));
  assert.deepEqual(state.requests.map(r => r.status), ['completed', 'pending_invite']);
  assert.throws(() => act(state, { type: 'confirm_active', id }), /待接受/);
});
test('invitation timeout retains reserved capacity and rejects stale accept confirmations', () => {
  let state = apply(configured()); const id = state.requests[0].id;
  state = act(act(state, { type: 'tick' }), { type: 'confirm_invited', id }); state = apply(state, bob);
  assert.throws(() => act(state, { type: 'confirm_active', id }, owner, at(24)), /到期/);
  state = act(state, { type: 'tick' }, owner, at(24));
  assert.deepEqual(state.requests.map(r => r.status), ['pending_removal', 'queued']);
  assert.equal(state.notices.filter(n => n.type === 'invitation_expired').length, 1);
  assert.deepEqual(act(state, { type: 'tick' }, owner, at(25)), state);
});
test('30-minute reminder boundary, stale reminder cancellation and bounded renewals', () => {
  let state = apply(configured(), alice, 3); const id = state.requests[0].id;
  state = activate(act(state, {type:'tick'}), id);
  assert.equal(state.requests[0].expiresAt, at(3));
  state = act(state, {type:'tick'}, owner, at(2.49));
  assert.equal(state.notices.filter(n => n.type === 'expiry_30m').length, 0);
  state = act(state, {type:'tick'}, owner, at(2.5));
  assert.equal(state.notices.filter(n => n.type === 'expiry_30m').length, 1);
  assert.deepEqual(act(state, {type:'tick'}, owner, at(2.6)), state);
  assert.throws(() => act(apply(state, bob, 1, at(2.6)), {type:'renew', id, hours:3}, alice, at(2.6)), /排队/);
  state = act(state, {type:'renew', id, hours:3, requestKey:'renew-1'}, alice, at(2.6));
  assert.equal(state.requests[0].expiresAt, at(5.6));
  assert.equal(state.notices.find(n => n.type === 'expiry_30m').status, 'cancelled');
  assert.deepEqual(act(state, {type:'renew', id, hours:3, requestKey:'renew-1'}, alice, at(2.6)), state);
  assert.throws(() => act(state, {type:'renew', id, hours:4}, alice, at(2.7)), /小时数/);
  assert.throws(() => act(state, {type:'renew', id, hours:1}, alice, at(2.7)), /更长/);
  state = act(state, {type:'tick'}, owner, at(5.1));
  const notices = state.notices.filter(n => n.type === 'expiry_30m');
  assert.equal(notices.length, 2); assert.notEqual(notices[0].key, notices[1].key);
});

test('inventory imports fixed members and pending invitations without dropping occupancy', () => {
  let state = configured({ verified: false, seats: 4 });
  state = act(state, { type: 'sync_inventory', members: [{ email: owner.email, role: 'owner' }, { email: ' Alice@Example.com ', role: 'member' }, { email: alice.email, role: 'member' }, { email: bob.email, role: 'pending_invite' }] });
  assert.equal(state.requests.length, 2); assert.equal(state.requests[0].expiresAt, null);
  assert.deepEqual(state.config.existingEmails, [alice.email, bob.email]);
  assert.equal(viewState(state, owner).aggregate.usedSeats, 3);
  assert.deepEqual(act(state, { type: 'tick' }, owner, at(1000)), state);
  assert.throws(() => act(state, { type: 'sync_inventory', members: [] }), /首次成员盘点已完成/);
  assert.throws(() => act(state, { type: 'configure', config: { workspaceId: 'another' } }), /更换/);
  assert.throws(() => apply(state), /重复/);
  assert.equal(viewState(state, alice).requests.length, 1);
  state = act(state, { type: 'release', id: state.requests[0].id }, alice);
  assert.equal(state.requests[0].status, 'pending_removal');
});
test('owner count and overcapacity are conservatively handled', () => {
  const initial = configured({ verified: false });
  assert.throws(() => act(initial, { type: 'sync_inventory', members: [{ email: owner.email, role: 'owner' }, { email: alice.email, role: 'owner' }] }), /Owner/);
  const state = act(initial, { type: 'sync_inventory', members: [alice, bob, carol].map(u => ({ email: u.email, role: 'member' })) });
  assert.equal(state.requests.length, 3); assert.equal(state.config.automationEnabled, false);
  assert.equal(viewState(state, owner).aggregate.overCapacity, 2);
});
test('staff and anonymous views do not leak another email, reason, audit or whitelist', () => {
  let state = apply(configured({ seats: 3 })); state = apply(state, bob, 1, at(0.01));
  const view = viewState(state, bob);
  assert.equal(view.requests.length, 1); assert.equal(view.queuePosition, 2);
  assert.equal('audit' in view, false); assert.equal('whitelist' in view.config, false);
  assert.equal('existingEmails' in view.config, false); assert.equal('workspaceId' in view.config, false);
  assert.equal(JSON.stringify(view).includes(alice.email), false);
  assert.throws(() => act(state, { type: 'cancel', id: state.requests[0].id }, bob), /未找到/);
  assert.throws(() => act(state, { type: 'confirm_invited', id: state.requests[1].id }, bob), /管理员/);
  const forged = { ...bob, userId: alice.userId };
  assert.throws(() => act(state, { type: 'cancel', id: state.requests[0].id }, forged), /未找到/);
  assert.equal(viewState(state, forged).requests.length, 0);
  const anonymous = viewState(state, { userId: 'anonymous', email: '', isAdmin: false });
  assert.equal(anonymous.requests.length, 0); assert.equal(anonymous.notices.length, 0);
  view.requests[0].reason = 'changed'; assert.equal(state.requests[1].reason, '项目研发');
});
test('protected owner never auto-expires even when a corrupt lease exists', () => {
  let state = apply(configured()); state = act(state, { type: 'tick' });
  state.requests[0].email = owner.email; state.requests[0].status = 'active'; state.requests[0].expiresAt = NOW;
  assert.equal(act(state, { type: 'tick' }, owner, at(1)).requests[0].status, 'active');
  assert.throws(() => act(state, { type: 'release', id: state.requests[0].id }), /受保护/);
});
test('pure transforms retain audit until durable storage compaction and no-op revisions stay unchanged', () => {
  let state = createState(NOW);
  for (let i = 0; i < 1005; i++) state = act(state, { type: 'configure', config: { leaseHours: i % 2 ? 3 : 2 } });
  assert.equal(state.audit.length, 1005); assert.equal(new Set(state.audit.map(r => r.id)).size, 1005);
  assert.equal(act(state, { type: 'tick' }).revision, state.revision);
});

test('all snapshot Owners remain protected after later whitelist changes', () => {
  let state = configured({ verified: false, seats: 4 });
  state = act(state, { type: 'configure', config: { reservedSeats: 2 } });
  state = act(state, { type: 'sync_inventory', members: [{ email: owner.email, role: 'owner' }, { email: alice.email, role: 'owner' }] });
  assert.deepEqual(state.config.protectedEmails.sort(), [owner.email, alice.email].sort());
  assert.equal(state.requests.length, 0);
  state = act(state, { type: 'configure', config: { whitelist: [alice.email, bob.email] } });
  assert.deepEqual(state.config.whitelist, [bob.email]);
  assert.equal(viewState(state, alice).eligible, false);
  assert.throws(() => apply(state, alice), /保留/);
  assert.throws(() => act(state, { type: 'configure', config: { reservedSeats: 1 } }), /保留席位/);
  assert.throws(() => act(state, { type: 'configure', config: { protectedEmails: [] } }), /盘点状态/);
  state = apply(state, bob); state.requests[0].email = alice.email;
  state.requests[0].status = 'active'; state.requests[0].expiresAt = NOW;
  assert.equal(act(state, { type: 'tick' }, owner, at(1)).requests[0].status, 'active');
  assert.throws(() => act(state, { type: 'release', id: state.requests[0].id }), /受保护/);
});
test('same verified email on a different user ID cannot expose an old normal request', () => {
  const state = apply(configured());
  const differentPerson = { ...alice, userId: 'different-user' };
  const view = viewState(state, differentPerson);
  assert.equal(view.requests.length, 0); assert.equal(view.notices.length, 0); assert.equal(view.queuePosition, null);
  assert.throws(() => act(state, { type: 'cancel', id: state.requests[0].id }, differentPerson), /未找到/);
  const renamedEmail = { ...alice, email: 'new@example.com' };
  assert.equal(viewState(state, renamedEmail).requests.length, 0);
  assert.throws(() => act(state, { type: 'cancel', id: state.requests[0].id }, renamedEmail), /未找到/);
});
test('equal-millisecond requests preserve insertion order across revision digit boundaries', () => {
  let state = configured();
  for (let i = 0; i < 6; i++) state = act(state, { type: 'configure', config: { leaseHours: i % 2 ? 3 : 2 } });
  assert.equal(state.revision, 8);
  state = apply(state, alice); state = apply(state, bob);
  assert.equal(viewState(state, alice).queuePosition, 1);
  assert.equal(viewState(state, bob).queuePosition, 2);
  state = act(state, { type: 'tick' });
  assert.deepEqual(state.requests.map(r => r.status), ['pending_invite', 'queued']);
});
test('initial snapshot never changes a pending removal or counts an existing request twice', () => {
  let state = apply(configured({ verified: false, seats: 3 }));
  state.requests[0].status = 'active'; state.requests[0].expiresAt = at(24);
  state = act(state, { type: 'release', id: state.requests[0].id }, alice);
  const members = [{ email: owner.email, role: 'owner' }, { email: alice.email, role: 'member' }];
  const included = act(state, { type: 'sync_inventory', members });
  assert.equal(included.requests.length, 1); assert.equal(included.requests[0].status, 'pending_removal');
  assert.equal(viewState(included, owner).aggregate.usedSeats, 2);
  const absent = act(state, { type: 'sync_inventory', members: [members[0]] });
  assert.equal(absent.requests[0].status, 'pending_removal');
  assert.equal(viewState(absent, owner).aggregate.usedSeats, 2);
});

test('hourly application bounds and submission idempotency', () => {
  const initial = configured();
  for (const hours of [0, 4, 1.5, NaN]) assert.throws(() => apply(initial, alice, hours), /小时数/);
  const command = {type:'apply', name:'Alice', reason:'研发', hours:2, requestKey:'one-request'};
  const state = act(initial, command, alice);
  assert.deepEqual(act(state, command, alice), state);
});
