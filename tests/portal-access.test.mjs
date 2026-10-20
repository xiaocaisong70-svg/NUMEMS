import test from "node:test";
import assert from "node:assert/strict";
import { portalAccess, requirePortalAccess, PortalAccessError } from "../lib/portal-access.ts";
import { createState, transition, viewState, PROTECTED_OWNER_EMAIL } from "../lib/seat-engine.ts";

const NOW = "2026-10-20T00:00:00.000Z";
const owner = { userId: "owner", email: PROTECTED_OWNER_EMAIL, isAdmin: true };
const returning = { userId: "same-site-user", email: "returning@example.com", isAdmin: false };
const other = { userId: "other", email: "other@example.com", isAdmin: false };
const config = { whitelist: [returning.email] };

test("anonymous and non-whitelisted accounts receive no portal access", () => {
  assert.equal(portalAccess(config, null), "signin_required");
  assert.equal(portalAccess(config, { ...returning, userId: "" }), "signin_required");
  assert.equal(portalAccess(config, other), "not_authorized");
  assert.throws(() => requirePortalAccess(config, null),
    error => error instanceof PortalAccessError && error.status === 401);
  assert.throws(() => requirePortalAccess(config, other),
    error => error instanceof PortalAccessError && error.status === 403);
});

test("verified email controls employee access independently of seat membership", () => {
  assert.equal(portalAccess(config, returning), "allowed");
  assert.equal(portalAccess(config, { ...returning, email: " RETURNING@EXAMPLE.COM " }), "allowed");
  assert.equal(portalAccess({ whitelist: [] }, owner), "allowed");
  // No workspace membership flag, active request, or paid seat is needed.
  assert.doesNotThrow(() => requirePortalAccess(config, returning));
});

test("removing an employee from the whitelist revokes portal operations immediately", () => {
  assert.equal(portalAccess(config, returning), "allowed");
  assert.throws(() => requirePortalAccess({ whitelist: [] }, returning), /访问权限/);
  assert.equal(portalAccess({ whitelist: [other.email] }, returning), "not_authorized");
});

test("a returned employee can apply again after seat reclamation and sees only own records", () => {
  let state = createState(NOW);
  const act = (actor, command, when = NOW) => {
    requirePortalAccess(state.config, actor);
    state = transition(state, actor, command, when);
  };
  act(owner, { type: "configure", config: {
    totalSeats: 2, reservedSeats: 1, workspaceId: "local-test-workspace",
    automationEnabled: true, whitelist: [returning.email, other.email],
  } });
  act(owner, { type: "sync_inventory", members: [{ email: owner.email, role: "owner" }] });
  act(returning, { type: "apply", name: "Returning", reason: "First use", hours: 1 });
  const firstId = state.requests[0].id;
  act(owner, { type: "tick" });
  act(owner, { type: "confirm_invited", id: firstId });
  act(owner, { type: "confirm_active", id: firstId });
  act(owner, { type: "tick" }, "2026-10-20T01:00:00.000Z");
  act(owner, { type: "confirm_removed", id: firstId }, "2026-10-20T01:00:01.000Z");
  assert.equal(state.requests[0].status, "completed");
  assert.equal(portalAccess(state.config, returning), "allowed");
  act(returning, { type: "apply", name: "Returning", reason: "Second use", hours: 3 },
    "2026-10-20T01:01:00.000Z");
  act(other, { type: "apply", name: "Other", reason: "Other person's work", hours: 1 },
    "2026-10-20T01:02:00.000Z");
  const mine = viewState(state, returning);
  assert.equal(mine.requests.length, 2);
  assert.ok(mine.requests.every(record => record.email === returning.email));
  assert.equal(mine.requests[1].status, "queued");
  assert.equal(mine.eligible, true);
  assert.equal(JSON.stringify(mine).includes(other.email), false);
  assert.equal("whitelist" in mine.config, false);
});
