import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

async function regularExecutable(candidate) {
  try { return (await lstat(candidate)).isFile(); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

// Codex desktop puts each app release in its own bin/<release>/codex.exe.
// A saved release path can disappear after an update. Never choose a release
// by date or sort order: multiple live candidates require human review.
export async function resolveCodexCli(configured, { localAppData = process.env.LOCALAPPDATA } = {}) {
  if (configured !== undefined && configured !== null && configured !== "") {
    if (typeof configured !== "string" || !path.isAbsolute(configured) ||
        path.basename(configured).toLowerCase() !== "codex.exe")
      throw new Error("Configured Codex CLI path must be an absolute codex.exe path.");
    if (await regularExecutable(configured)) return configured;
  }
  if (typeof localAppData !== "string" || !path.isAbsolute(localAppData))
    throw new Error("Cannot locate Codex CLI: LOCALAPPDATA is unavailable.");
  const bin = path.join(localAppData, "OpenAI", "Codex", "bin");
  let entries;
  try { entries = await readdir(bin, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR")
      throw new Error("Cannot locate Codex CLI: desktop bin directory is missing.");
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(bin, entry.name, "codex.exe");
    if (await regularExecutable(candidate)) candidates.push(candidate);
  }
  if (candidates.length !== 1)
    throw new Error(`Cannot safely choose Codex CLI: found ${candidates.length} current executables.`);
  return candidates[0];
}
