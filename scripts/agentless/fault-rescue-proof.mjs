// Data-only lifecycle validation. Importing this module never starts a process,
// loads a browser, calls a connector or performs model inference.
const finalStates=new Set(['completed','interrupted','failed']);
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,240}$/.test(value);
function time(value) {return typeof value==='string'&&value?Date.parse(value):NaN;}
export function isStoppedFaultRescueProof(proof,identity,{now=new Date(),maxAgeMs=Infinity}={}) {
  const current=now instanceof Date?now.getTime():typeof now==='number'?now:Date.parse(now);
  const observed=time(proof?.observedAt);
  if(proof?.kind!=='codex_turn_state'||proof.source!=='app_server_thread_read'||proof.confirmed!==true||
    proof.stopped!==true||proof.terminalEvidence!=='status_and_completed_at'||
    !safeId(identity?.threadId)||!safeId(identity?.clientUserMessageId)||
    proof.threadId!==identity.threadId||proof.clientUserMessageId!==identity.clientUserMessageId||
    (identity.queuedId!=null&&proof.queuedId!==identity.queuedId)||!safeId(proof.turnId)||!safeId(proof.linkedTurnId)||
    !Number.isFinite(current)||!Number.isFinite(observed)||observed>current||current-observed>maxAgeMs||
    !Array.isArray(proof.terminalChain)||proof.terminalChain.length<1||proof.terminalChain.length>9||
    !Array.isArray(proof.terminalFamily)||proof.terminalFamily.length<proof.terminalChain.length||
    proof.terminalFamily.length>1000||proof.terminalChain[0].turnId!==proof.linkedTurnId||
    proof.terminalChain.at(-1).turnId!==proof.turnId||
    (proof.readMethod==='thread/turns/list'&&proof.headRevalidated!==true))return false;
  const validNode=node=>safeId(node?.turnId)&&node.ended===true&&finalStates.has(node.status)&&
    Number.isFinite(time(node.startedAt))&&Number.isFinite(time(node.completedAt))&&
    time(node.completedAt)>=time(node.startedAt)&&time(node.completedAt)<=observed;
  if(!proof.terminalChain.every(validNode)||!proof.terminalFamily.every(validNode))return false;
  const family=new Map(proof.terminalFamily.map(node=>[node.turnId,node]));
  if(family.size!==proof.terminalFamily.length||new Set(proof.terminalChain.map(x=>x.turnId)).size!==proof.terminalChain.length||
    !proof.terminalChain.every(node=>JSON.stringify(node)===JSON.stringify(family.get(node.turnId))))return false;
  const root=proof.terminalChain.at(-1);
  return proof.status===root.status&&proof.startedAt===root.startedAt&&proof.completedAt===root.completedAt;
}
