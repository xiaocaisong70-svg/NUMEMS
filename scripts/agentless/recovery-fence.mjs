// Data-only ownership gates. Routine execution never imports a model client.
import {readJson} from './journal.mjs';
export const cloudRecoveryOwned=plan=>['pending','active','uncertain'].includes(plan?.faultRescue?.phase);
export async function localRecoveryOwned(file) {
  const r=await readJson(file);
  if(r==null)return false;
  // Corrupt, incomplete, sending and ambiguous records all keep the fence.
  return !(r.version===1 && r.phase==='finished' && r.agentStopped===true &&
    ['recovered','unresolved','needs_human'].includes(r.outcome) && typeof r.ticket?.id==='string');
}
