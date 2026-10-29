// Synthetic lifecycle receipts for offline tests; never reads an app session.
export function completedRescueProof(record,{startedAt=record.createdAt,completedAt=record.updatedAt??startedAt,
  observedAt=completedAt,turnId='turn-fixture',...extra}={}) {
  const node={turnId,status:'completed',startedAt,completedAt,ended:true};
  return {kind:'codex_turn_state',source:'app_server_thread_read',confirmed:true,stopped:true,
    threadId:record.threadId,clientUserMessageId:record.clientId,queuedId:record.queuedId??null,
    turnId,linkedTurnId:turnId,status:node.status,startedAt,completedAt,observedAt,
    terminalEvidence:'status_and_completed_at',terminalChain:[{...node}],terminalFamily:[{...node}],...extra};
}
