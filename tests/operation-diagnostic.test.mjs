import test from 'node:test';
import assert from 'node:assert/strict';
import {safeOperationDiagnostic,safeRuntimeDiagnostics} from '../scripts/agentless/operation-diagnostic.mjs';
import {OfficialPageError,officialDiagnostic} from '../scripts/seat-executor/official-readiness.mjs';
const stamp='2026-10-28T04:00:00.000Z';
test('original member-stage diagnostic survives wrapping without retaining provider text',()=>{
  const source=Object.assign(new Error('private@example.com secret selector'),{operationDiagnostic:{
    kind:'remove',stage:'retention_wait',category:'timeout',observedAt:stamp,body:'private@example.com',token:'private'}});
  const outer=new Error('held',{cause:new Error('wrapped',{cause:source})});
  assert.deepEqual(safeOperationDiagnostic(outer),{kind:'remove',stage:'retention_wait',category:'timeout',observedAt:stamp});
  assert.equal(JSON.stringify(safeOperationDiagnostic(outer)).includes('private'),false);
});

test('wrapped official loading failures retain only the fixed safe diagnostic fields',()=>{
  const expectedUrl='https://admin.openai.com/workspace/00000000-0000-4000-8000-000000000001/members?secret=private';
  const source=new OfficialPageError('private@example.com','browser_unavailable',officialDiagnostic({
    stage:'capacity',state:'loading',expectedUrl,at:Date.parse(stamp)}));
  const wrapper=new Error('held',{cause:source});
  const saved=safeRuntimeDiagnostics(wrapper);
  assert.equal(saved.officialFailure.stage,'capacity');assert.equal(saved.officialFailure.state,'loading');
  assert.equal(JSON.stringify(saved).includes('private'),false);
  assert.deepEqual(safeRuntimeDiagnostics(new Error('ordinary')),{});
});
test('unknown stages, arbitrary provider classifications, invalid timestamps and plain objects are discarded',()=>{
  for(const patch of [{kind:'invite'},{stage:'private@example.com'},{category:'secret'},{observedAt:'not a date'},{observedAt:'2026-10-28T04:00:00Z'}]){
    const error=Object.assign(new Error('held'),{operationDiagnostic:{kind:'remove',stage:'retention_wait',category:'timeout',observedAt:stamp,...patch}});
    assert.equal(safeOperationDiagnostic(error),undefined);
  }
  assert.equal(safeOperationDiagnostic({operationDiagnostic:{kind:'remove',stage:'retention_wait',category:'timeout',observedAt:stamp}}),undefined);
  const cycle=new Error('cycle');cycle.cause=cycle;assert.equal(safeOperationDiagnostic(cycle),undefined);
});
