import {AppServerClient} from '../app-server-client.mjs';

const finalStates=new Set(['completed','interrupted','failed']);
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,240}$/.test(value);
function iso(value) {
  const milliseconds=typeof value==='number'&&Number.isFinite(value)?value*(value<1e12?1000:1):Date.parse(value);
  return Number.isFinite(milliseconds)?new Date(milliseconds).toISOString():null;
}
function terminalTurnEvidence(turn,observedAt) {
  const startedAt=iso(turn.startedAt),completedAt=iso(turn.completedAt);
  // A separately connected App Server can reconstruct an actively executing
  // desktop turn as `interrupted` with no completedAt. The status enum alone
  // is not a termination receipt. Require the persisted completion timestamp
  // on every linked turn, never infer it from thread/notLoaded or queue absence.
  const ended=finalStates.has(turn.status)&&startedAt!==null&&completedAt!==null&&
    Date.parse(completedAt)>=Date.parse(startedAt)&&Date.parse(completedAt)<=observedAt;
  return {turnId:turn.id,status:turn.status,startedAt,completedAt,ended};
}

/** Only server-returned userMessage.clientId binds a queued submission to a
 * turn. Missing queue entries, thread.status and an agent-authored ACK are not
 * evidence that a model has stopped. This function never reads message text. */
export function faultRescueTurnProof(response,{threadId,clientUserMessageId,queuedId},now=new Date()) {
  const thread=response?.thread??response;
  if(!safeId(threadId)||!safeId(clientUserMessageId)||thread?.id!==threadId||!Array.isArray(thread.turns))
    return {confirmed:false,reason:'thread_evidence_invalid'};
  const matches=[];
  for(const turn of thread.turns)for(const item of turn.items??[])
    if(item.type==='userMessage'&&item.clientId===clientUserMessageId)matches.push({turn,item});
  if(matches.length!==1)return {confirmed:false,reason:matches.length?'client_message_ambiguous':'client_message_not_found'};
  let {turn,item}=matches[0];const linkedTurnId=turn.id,visited=new Set(),chain=[turn];
  let rootId=turn.rootTurnId??item.rootTurnId;
  while(rootId&&rootId!==turn.id) {
    if(!safeId(rootId)||visited.has(rootId)||visited.size>=8)return {confirmed:false,reason:'root_turn_link_invalid'};
    visited.add(rootId);
    const parents=thread.turns.filter(value=>value.id===rootId);
    if(parents.length!==1)return {confirmed:false,reason:'root_turn_not_found'};
    turn=parents[0];chain.push(turn);rootId=turn.rootTurnId;
  }
  if(!safeId(turn.id)||!safeId(linkedTurnId)||typeof turn.status!=='string')
    return {confirmed:false,reason:'turn_evidence_invalid'};
  const users=(turn.items??[]).filter(x=>x.type==='userMessage');
  const terminalChain=chain.map(value=>terminalTurnEvidence(value,now.getTime()));
  // Continuations can keep the same root while the original client-bearing
  // turn already has a completion receipt. Include every observed descendant.
  const familyIds=new Set(chain.map(value=>value.id));let changed=true;
  while(changed) {changed=false;for(const candidate of thread.turns)if(!familyIds.has(candidate.id)&&
    familyIds.has(candidate.rootTurnId)){familyIds.add(candidate.id);changed=true;}}
  const terminalFamily=thread.turns.filter(value=>familyIds.has(value.id)).map(value=>terminalTurnEvidence(value,now.getTime()));
  return {kind:'codex_turn_state',confirmed:true,stopped:terminalFamily.every(value=>value.ended),
    threadId,clientUserMessageId,queuedId:queuedId??null,turnId:turn.id,linkedTurnId,
    status:turn.status,observedAt:now.toISOString(),source:'app_server_thread_read',
    startedAt:iso(turn.startedAt),completedAt:iso(turn.completedAt),
    terminalEvidence:'status_and_completed_at',terminalChain,terminalFamily,
    exclusiveTurn:turn.itemsView!=='summary'&&turn.itemsView!=='notLoaded'&&turn.id===linkedTurnId&&
      users.length===1&&users[0].clientId===clientUserMessageId};
}

/** The authorized chat may have hundreds of megabytes of rollout history.
 * Official summary pagination avoids full-history hydration and tool bodies.
 * Summary items prove a positive exact client-id link, but cannot prove that
 * the turn contains no other messages; therefore they never allow interrupt.
 * Missing links within the finite window remain unconfirmed, never released. */
export async function readFaultRescueTurnProof(request,identity,{pageSize=8,maxPages=25,maxMetadataBytes=1_000_000,
  clock=()=>new Date()}={}) {
  if(!safeId(identity?.threadId)||!safeId(identity?.clientUserMessageId)||
    !Number.isInteger(pageSize)||pageSize<1||pageSize>20||!Number.isInteger(maxPages)||maxPages<1||maxPages>50||
    !Number.isInteger(maxMetadataBytes)||maxMetadataBytes<1024||maxMetadataBytes>2_000_000)
    return {confirmed:false,reason:'pagination_configuration_invalid'};
  const meta=await request('thread/read',{threadId:identity.threadId,includeTurns:false});
  if(meta?.thread?.id!==identity.threadId||(meta.thread.turns?.length??0)!==0)
    return {confirmed:false,reason:'thread_metadata_invalid'};
  const turns=[],ids=new Set(),cursors=new Set();let cursor,firstPageFingerprint;
  const fingerprint=page=>JSON.stringify(page.data.map(t=>({id:t.id,rootTurnId:t.rootTurnId,status:t.status,
    startedAt:t.startedAt,completedAt:t.completedAt,itemsView:t.itemsView,
    users:t.items?.filter(i=>i.type==='userMessage').map(i=>({id:i.id,clientId:i.clientId,rootTurnId:i.rootTurnId}))})));
  for(let pages=1;pages<=maxPages;pages++) {
    const page=await request('thread/turns/list',{threadId:identity.threadId,limit:pageSize,
      itemsView:'summary',sortDirection:'desc',...(cursor?{cursor}:{})});
    if(!page||!Array.isArray(page.data)||page.data.length>pageSize)
      return {confirmed:false,reason:'turn_page_invalid'};
    if(pages===1)firstPageFingerprint=fingerprint(page);
    for(const turn of page.data) {
      if(!safeId(turn?.id)||ids.has(turn.id)||turn.itemsView!=='summary'||!Array.isArray(turn.items))
        return {confirmed:false,reason:'turn_summary_invalid'};
      ids.add(turn.id);
      // Do not retain content, errors, tool output, images or unknown fields.
      const users=turn.items.filter(item=>item.type==='userMessage').map(item=>({type:'userMessage',
        id:item.id,clientId:item.clientId,...(item.rootTurnId?{rootTurnId:item.rootTurnId}:{})}));
      if(users.some(item=>!safeId(item.id)||item.clientId!=null&&!safeId(item.clientId)))
        return {confirmed:false,reason:'user_metadata_invalid'};
      turns.push({id:turn.id,status:turn.status,rootTurnId:turn.rootTurnId,itemsView:'summary',
        startedAt:turn.startedAt,completedAt:turn.completedAt,items:users});
    }
    if(Buffer.byteLength(JSON.stringify(turns))>maxMetadataBytes)
      return {confirmed:false,reason:'turn_metadata_budget_exceeded'};
    const proof=faultRescueTurnProof({thread:{id:identity.threadId,turns}},identity,clock());
    if(proof.confirmed||!['client_message_not_found','root_turn_not_found'].includes(proof.reason)) {
      if(proof.stopped) {
        const head=await request('thread/turns/list',{threadId:identity.threadId,limit:pageSize,itemsView:'summary',sortDirection:'desc'});
        if(!Array.isArray(head?.data)||head.data.length>pageSize||fingerprint(head)!==firstPageFingerprint)
          return {...proof,stopped:false,reason:'turn_head_changed',readMethod:'thread/turns/list',itemsCoverage:'summary',pagesRead:pages};
      }
      return {...proof,headRevalidated:proof.stopped===true,readMethod:'thread/turns/list',itemsCoverage:'summary',pagesRead:pages};
    }
    if(page.nextCursor==null)return {...proof,readMethod:'thread/turns/list',pagesRead:pages};
    if(typeof page.nextCursor!=='string'||!page.nextCursor||page.nextCursor.length>10_000||cursors.has(page.nextCursor))
      return {confirmed:false,reason:'turn_cursor_invalid'};
    cursors.add(page.nextCursor);cursor=page.nextCursor;
  }
  return {confirmed:false,reason:'turn_search_budget_exceeded'};
}

/** Reuses the existing hidden protocol process. It never calls a portal tool,
 * starts a thread or performs inference except the explicit enqueue method. */
export class FaultRescueClient extends AppServerClient {
  request(method,params) {
    if(!['initialize','thread/read','thread/turns/list','thread/queue/list','thread/queue/add','turn/interrupt'].includes(method)||
      method==='thread/read'&&params?.includeTurns!==false||method==='thread/turns/list'&&params?.itemsView!=='summary')
      throw new Error('Fault rescue protocol is limited to queue and exact turn lifecycle evidence.');
    return super.request(method,params);
  }
  async observeTurnState(identity) {
    return readFaultRescueTurnProof((...args)=>this.request(...args),identity);
  }
  async interruptTrackedTurn(identity,proof) {
    if(proof?.kind!=='codex_turn_state'||proof.source!=='app_server_thread_read'||proof.confirmed!==true||proof.stopped!==false||proof.exclusiveTurn!==true||
       proof.threadId!==identity.threadId||proof.clientUserMessageId!==identity.clientUserMessageId||!safeId(proof.turnId))
      throw new Error('Only an exactly linked exclusive rescue turn can be interrupted.');
    return this.request('turn/interrupt',{threadId:identity.threadId,turnId:proof.turnId});
  }
}
