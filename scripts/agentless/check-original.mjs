import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root} from './config.mjs';
const baseline=JSON.parse(fs.readFileSync(path.join(root,'outputs/original-baseline.json'),'utf8'));
const changed=[];
for(const [name,hash] of Object.entries(baseline.files)) {
  const file=path.resolve(baseline.source,name);
  if(!file.startsWith(path.resolve(baseline.source)+path.sep))throw new Error('Invalid baseline path');
  if(!fs.existsSync(file) || createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash)changed.push(name);
}
console.log(JSON.stringify({checked:Object.keys(baseline.files).length,changed}));
if(changed.length)process.exitCode=1;
