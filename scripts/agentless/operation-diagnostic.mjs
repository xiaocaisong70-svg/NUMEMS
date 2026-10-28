// Fixed, non-sensitive UI stages only. Never persist provider text, selectors,
// body content, URLs, cookies or raw error stacks from an external page.
import {REMOVE_OPERATION_STAGES} from '../seat-executor/browser.mjs';
import {safeOfficialDiagnostic} from '../seat-executor/official-readiness.mjs';

export function safeOperationDiagnostic(error) {
  const seen=new Set();
  for(let current=error,depth=0;current instanceof Error && depth<8 && !seen.has(current);current=current.cause,depth++) {
    seen.add(current);
    const d=current.operationDiagnostic;
    if(d?.kind!=='remove' || !REMOVE_OPERATION_STAGES.includes(d.stage) ||
        !['timeout','other'].includes(d.category) || typeof d.observedAt!=='string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(d.observedAt) ||
        !Number.isFinite(Date.parse(d.observedAt)))continue;
    return {kind:'remove',stage:d.stage,category:d.category,observedAt:new Date(d.observedAt).toISOString()};
  }
}

export function safeRuntimeDiagnostics(error) {
  const operationDiagnostic=safeOperationDiagnostic(error),seen=new Set();
  let officialFailure;
  for(let current=error,depth=0;current instanceof Error && depth<8 && !seen.has(current);current=current.cause,depth++) {
    seen.add(current);officialFailure=safeOfficialDiagnostic(current);if(officialFailure)break;
  }
  return {...(operationDiagnostic?{operationDiagnostic}:{}),...(officialFailure?{officialFailure}:{})};
}
