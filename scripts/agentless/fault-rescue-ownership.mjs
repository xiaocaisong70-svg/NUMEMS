// Data-only ownership checks. No process, browser or model client is imported.
import {isStoppedFaultRescueProof} from './fault-rescue-proof.mjs';

const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,240}$/.test(value);
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const outcomes=new Set(['recovered','unresolved','needs_human','handled']);
export const faultRescueIdentity=r=>({threadId:r?.threadId,clientUserMessageId:r?.clientId,queuedId:r?.queuedId??null});

export function stoppedFaultRescueEvidence(r,{now=Date.now(),maxAgeMs=Infinity}={}) {
  const proof=Object.hasOwn(r??{},'terminalRevalidationProof')?r.terminalRevalidationProof:r?.agentProof;
  return isStoppedFaultRescueProof(proof,faultRescueIdentity(r),{now,maxAgeMs})?proof:null;
}

/** A completed status enum or an old agentStopped boolean is not a receipt.
 * Never-dispatched records are produced only before the permanent dispatch
 * witness permits enqueue; a dispatched record always needs actual completion
 * timestamps for its whole linked turn family. */
export function finishedFaultRescueEvidence(r,{now=Date.now()}={}) {
  if(r?.version!==1||r.phase!=='finished'||r.agentStopped!==true||!outcomes.has(r.outcome)||
      !safeId(r.failureId)||!safeId(r.clientId)||!safeId(r.threadId)||!stamp(r.createdAt))return false;
  if(!r.dispatchStartedAt&&r.notDispatched===true) {
    if(/^server_refused_[a-z_]{1,50}$/.test(r.reason??''))return true;
    const p=r.agentProof;
    return r.reason==='cancelled_before_dispatch'&&p?.kind==='not_dispatched'&&p.stopped===true&&
      p.source==='local_dispatch_cancelled'&&p.clientUserMessageId===r.clientId&&stamp(p.observedAt)&&
      Date.parse(p.observedAt)>=Date.parse(r.createdAt)&&Date.parse(p.observedAt)<=now;
  }
  return safeId(r.ticket?.id)&&stoppedFaultRescueEvidence(r,{now})!==null;
}
