// Read-only release verification; no runtime or network calls.
import {readFile, lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const releases = new Map([
  ['agentless-v5','bee319c270dc845aa0748b7a8bfc26c8ab17696f'],
  ['agentless-v5-watchdog-20261025','d6013c85ec821abfd83c5890c3a0e0f61833ab7a'],
  ['agentless-v6','4f3a325fcde294aa8956a49108911510b0734e1f'],
]);
const requested=process.argv[2]??'agentless-v6';
if(process.argv.length>3 || !releases.has(requested))throw new Error('Unknown release; use a documented fixed release tag.');
const manifest = JSON.parse(await readFile(path.join(root, `releases/${requested}/manifest.json`), 'utf8'));
if (manifest.schemaVersion !== 1 || manifest.release !== requested ||
    manifest.source?.commit !== releases.get(requested) || !Array.isArray(manifest.files) || !manifest.files.length) {
  throw new Error('Unsupported or invalid release manifest');
}
const failures = [];
const seen = new Set();
for (const entry of manifest.files) {
  const relative = entry.path;
  const absolute = typeof relative === 'string' ? path.resolve(root, relative) : root;
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      relative.split('/').some(part => part === '..' || part === '.' || !part) ||
      !absolute.startsWith(root + path.sep) || seen.has(relative)) {
    failures.push({path: relative, reason: 'invalid path'});
    continue;
  }
  seen.add(relative);
  try {
    if (!(await lstat(absolute)).isFile()) throw new Error('not a regular file');
    const data = await readFile(absolute);
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (data.length !== entry.bytes || sha256 !== entry.sha256) failures.push({path: relative, reason: 'hash or size mismatch'});
  } catch (error) {
    failures.push({path: relative, reason: error.code ?? error.message});
  }
}
console.log(JSON.stringify({verified: failures.length === 0, release: manifest.release,
  sourceCommit: manifest.source.commit, checkedFiles: manifest.files.length,
  manifestSelfExcluded: true, ...(failures.length ? {failures} : {})}, null, 2));
if (failures.length) process.exitCode = 1;
