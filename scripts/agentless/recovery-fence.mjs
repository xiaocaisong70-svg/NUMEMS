// Data-only ownership gates. Routine execution never imports a model client.
import {readJson} from './journal.mjs';
import {finishedFaultRescueEvidence} from './fault-rescue-ownership.mjs';
export const cloudRecoveryOwned=plan=>['pending','active','uncertain'].includes(plan?.faultRescue?.phase);
export async function localRecoveryOwned(file) {
  const r=await readJson(file);
  if(r==null)return false;
  // Corrupt, incomplete, sending and ambiguous records all keep the fence.
  return !finishedFaultRescueEvidence(r);
}
