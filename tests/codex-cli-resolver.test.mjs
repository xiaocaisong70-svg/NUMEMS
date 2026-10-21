import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCodexCli } from "../scripts/codex-cli-resolver.mjs";

async function fixture(t) {
  const localAppData = await mkdtemp(path.join(tmpdir(), "numems-codex-cli-"));
  t.after(() => rm(localAppData, { recursive: true, force: true }));
  const bin = path.join(localAppData, "OpenAI", "Codex", "bin");
  await mkdir(bin, { recursive: true });
  return { localAppData, async add(release) {
    const directory = path.join(bin, release);
    await mkdir(directory, { recursive: true });
    const cli = path.join(directory, "codex.exe");
    await writeFile(cli, "test executable");
    return cli;
  } };
}

test("an existing configured Codex CLI wins over rotated app releases", async t => {
  const files = await fixture(t);
  const configured = await files.add("configured");
  await files.add("newer");
  assert.equal(await resolveCodexCli(configured, files), configured);
});

test("a removed release falls back to the sole current desktop Codex CLI", async t => {
  const files = await fixture(t);
  const current = await files.add("current");
  const removed = path.join(files.localAppData, "OpenAI", "Codex", "bin", "removed", "codex.exe");
  assert.equal(await resolveCodexCli(removed, files), current);
  assert.equal(await resolveCodexCli(undefined, files), current);
});

test("missing or ambiguous desktop executables fail closed", async t => {
  const files = await fixture(t);
  const stale = path.join(files.localAppData, "old", "codex.exe");
  await assert.rejects(resolveCodexCli(stale, files), /found 0 current executables/);
  await files.add("first");
  await files.add("second");
  await assert.rejects(resolveCodexCli(stale, files), /found 2 current executables/);
  await assert.rejects(resolveCodexCli("relative/codex.exe", files), /absolute codex\.exe/);
});
