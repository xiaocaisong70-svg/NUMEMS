// Read-only verification of the fixed agentless-v5 export; no runtime or network calls.
import {readFile, lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'releases/agentless-v5/manifest.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || manifest.release !== 'agentless-v5' ||
    manifest.source?.commit !== 'bee319c270dc845aa0748b7a8bfc26c8ab17696f' || !Array.isArray(manifest.files)) {
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
