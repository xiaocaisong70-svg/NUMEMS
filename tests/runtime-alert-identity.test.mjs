import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {runtimeIncidentKey,notifyFailure} from '../scripts/agentless/alert.mjs';
test('distinct unknown runtime faults own separate incidents; outer-handler repetition keeps the original ID and no raw error payload',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-alert-identity-'));
  try {
    const file=path.join(directory,'alert.json'),a=new Error('fixture health check failed'),b=new Error('fixture scheduler check failed');
    const first=await notifyFailure(file,{code:'unknown',incidentKey:runtimeIncidentKey(a)},{env:{}});
    const repeated=await notifyFailure(file,{code:'unknown',incidentKey:runtimeIncidentKey(a)},{env:{}});
    const other=await notifyFailure(file,{code:'unknown',incidentKey:runtimeIncidentKey(b)},{env:{}});
    assert.equal(first.id,repeated.id);assert.notEqual(first.id,other.id);
    const raw=await readFile(file,'utf8');assert.equal(JSON.parse(raw).incidents.length,2);
    assert.ok(!raw.includes(a.message)&&!raw.includes(b.message));
  } finally {await rm(directory,{recursive:true,force:true});}
});
