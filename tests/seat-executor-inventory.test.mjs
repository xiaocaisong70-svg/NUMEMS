import test from "node:test";
import assert from "node:assert/strict";
import { BrowserAdapter, parseCapacity, parseRow } from "../scripts/seat-executor/browser.mjs";
import { validateConfig } from "../scripts/seat-executor/config.mjs";
import { validateObservation, presence, assertOrdinary } from "../scripts/seat-executor/inventory.mjs";
import { reminderText } from "../scripts/seat-executor/gmail-mailer.mjs";

const config = validateConfig({});
const officialUrl = `https://admin.openai.com/workspace/${config.workspaceId}/members?workspace=my-workspace&tab=invites`;
const owner = { email: config.adminEmail, role: "owner", seatLabel: "高级" };
const member = { email: "worker@example.com", role: "member", seatLabel: "高级" };
const invitation = { email: "invited@example.com", role: "member", seatLabel: "高级" };
const observation = () => ({ complete: true, workspaceId: config.workspaceId,
  workspaceName: config.workspaceName, accountEmail: config.adminEmail,
  totalSeats: 4, seatLabel: "高级", observedAt: new Date().toISOString(),
  pageUrl: officialUrl, members: [owner, member], invites: [invitation] });

test("reads the exact Business premium seat card and ordinary member row", () => {
  assert.deepEqual(parseCapacity("4\n高级席位\n已分配\n3\n可用\n1", "高级"),
    { total: 4, assigned: 3, available: 1 });
  assert.throws(() => parseCapacity("4\n高级席位\n已分配\n3\n可用\n2", "高级"));
  assert.deepEqual(parseRow(["D\ndencil\n1053411860@qq.com", "角色类型\n成员",
    "席位类型\n高级", "2026年10月15日"], "高级"),
  { email: "1053411860@qq.com", role: "member", seatLabel: "高级", self: false });
  assert.throws(() => parseRow(["unknown@example.com", "席位类型\n高级"], "高级"));
});

test("snapshot accepts either possible assigned-seat count for pending invitations", async () => {
  const page = { url: () => officialUrl };
  for (const assigned of [2, 3]) {
    const adapter = new BrowserAdapter(config, { page });
    adapter.load = async tab => { adapter.currentTab = tab; };
    adapter.capacity = async () => ({ total: 4, assigned, available: 4 - assigned });
    adapter.rows = async () => adapter.currentTab === "members"
      ? [{ ...owner, self: true }, { ...member, self: false }]
      : [{ ...invitation, self: false }];
    assert.equal((await adapter.snapshot()).invites.length, 1);
  }
  const adapter = new BrowserAdapter(config, { page });
  adapter.load = async tab => { adapter.currentTab = tab; };
  adapter.capacity = async () => ({ total: 4, assigned: 4, available: 0 });
  adapter.rows = async () => adapter.currentTab === "members"
    ? [{ ...owner, self: true }, { ...member, self: false }]
    : [{ ...invitation, self: false }];
  await assert.rejects(adapter.snapshot(), /席位已分配数不一致/);
});

test("workspace evidence protects identity, roles, seat count and recency", () => {
  assert.equal(validateObservation(observation(), config).members.length, 2);
  assert.equal(presence(observation(), invitation.email), "invite");
  assert.equal(presence(observation(), invitation.email.toUpperCase()), "invite");
  assert.throws(() => assertOrdinary(observation(), config.adminEmail.toUpperCase(),
    { config: { protectedEmails: [config.adminEmail] } }));
  const duplicate = observation(); duplicate.invites.push({ ...member });
  assert.throws(() => validateObservation(duplicate, config), /重复/);
  const stale = observation(); stale.observedAt = new Date(Date.now() - 61_000).toISOString();
  assert.throws(() => validateObservation(stale, config), /时效/);
  const foreign = observation(); foreign.workspaceId = "different-workspace";
  assert.throws(() => validateObservation(foreign, config), /工作空间/);
});

test("live configuration cannot redirect the workspace, seat type or login profile", () => {
  assert.throws(() => validateConfig({ workspaceSlug: "another-workspace" }));
  assert.throws(() => validateConfig({ seatLabel: "标准" }));
  assert.throws(() => validateConfig({ profile: "C:\\Users\\Public\\shared-browser" }));
  assert.throws(() => validateConfig({ siteUrl: "https://visitor@numems-seat-portal.workspace-026021.chatgpt.site/" }));
  assert.throws(() => validateConfig({ liveActions: true, mailMode: "codex" }));
});

test("mail text requires an exact expiry, unique notification ID and safe subject", () => {
  const message = reminderText({ id: "notice_12345", title: "到期提醒" },
    "2026-10-21T03:07:29.742Z", config.siteUrl);
  assert.match(message.subject, /\[NUMEMS:notice_12345\]/);
  assert.match(message.text, /2026-10-21T03:07:29.742Z/);
  assert.throws(() => reminderText({ id: "notice_12345", title: "提醒\r\nBcc: victim@example.com" },
    "2026-10-21T03:07:29.742Z", config.siteUrl));
  assert.throws(() => reminderText({ id: "notice_12345", title: "提醒" },
    "tomorrow", config.siteUrl));
  assert.throws(() => reminderText({ id: "notice_12345", title: "提醒" },
    "2026-10-21T03:07:29.742Z", "https://name@example.com/"));
});
