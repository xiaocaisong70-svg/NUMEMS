import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { edgeCandidates, edgeLaunchArguments } from "../scripts/seat-executor/human-login.mjs";

test("normal Edge finds system installations without using a daily profile", () => {
  const candidates = edgeCandidates({
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    PROGRAMFILES: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
  });
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every(value => value.endsWith(path.join("Microsoft", "Edge", "Application", "msedge.exe"))));
});

test("normal Edge login uses only the dedicated profile and HTTPS pages", () => {
  const profile = path.resolve(".sites-runtime", "seat-executor", "browser");
  const args = edgeLaunchArguments(profile, "https://admin.openai.com/workspace/123/members", "https://example.chatgpt.site/");
  assert.deepEqual(args, [
    `--user-data-dir=${profile}`, "--no-first-run", "--new-window",
    "https://admin.openai.com/workspace/123/members", "https://example.chatgpt.site/",
  ]);
  assert.ok(!args.some(value => /remote-debugging|automation|disable-web-security/i.test(value)));
  assert.throws(() => edgeLaunchArguments(profile, "http://admin.openai.com/", "https://example.chatgpt.site/"));
});
