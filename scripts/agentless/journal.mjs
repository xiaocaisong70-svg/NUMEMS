import { readFile,writeFile,rename,mkdir,open,unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {performance} from 'node:perf_hooks';

const WINDOWS_RENAME_BUSY_CODES=new Set(['EPERM','EACCES','EBUSY']);
const WINDOWS_RENAME_RETRY_DELAYS=[10,20,40,80,120,160];
const WINDOWS_RENAME_RETRY_BUDGET_MS=500;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** Windows may briefly deny an atomic replace while a reader holds the target.
 * Retry only this immutable temp-file commit, never the producer/business
 * operation. This is not CAS: callers still need their existing ownership
 * guards. A permanent failure retains both the old file and original temp. */
async function commitJson(tmp,file,{platform=process.platform,renameFile=rename,sleep=pause,now=()=>performance.now()}={}) {
  const started=now();let attempts=0;
  for(;;) {
    try {await renameFile(tmp,file);return;}
    catch(error) {
      if(platform!=='win32'||!WINDOWS_RENAME_BUSY_CODES.has(error.code)||attempts>=WINDOWS_RENAME_RETRY_DELAYS.length)throw error;
      const elapsed=now()-started,delay=WINDOWS_RENAME_RETRY_DELAYS[attempts++];
      if(!Number.isFinite(elapsed)||elapsed<0||elapsed+delay>=WINDOWS_RENAME_RETRY_BUDGET_MS)throw error;
      await sleep(delay);
      const afterWait=now()-started;
      if(!Number.isFinite(afterWait)||afterWait<0||afterWait>=WINDOWS_RENAME_RETRY_BUDGET_MS)throw error;
    }
  }
}

export async function atomicJson(file,value,commitOptions) {
  await mkdir(path.dirname(file),{recursive:true});
  const tmp=`${file}.${randomUUID()}.tmp`;
  await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  await commitJson(tmp,file,commitOptions);
}
export async function readJson(file) {
  try { return JSON.parse(await readFile(file,'utf8')); }
  catch(e) { if(e.code === 'ENOENT') return null; throw e; }
}
export class Journal {
  constructor(file) {this.file=file;}
  async reconcile(plan) {
    const j=await readJson(this.file);
    if(!j || j.phase === 'settled' && j.lease==null && j.receipt==null && j.submission==null) return;
    if(j.lease?.id && plan.receipts?.some(r=>r.id === j.lease.id)) {await this.settled();return;}
    const hold=plan.blockedOperations?.find(h=>h.operation.id === j.lease?.id);
    if(hold && ['mail_delivery','member_action','approval_required'].includes(hold.code) &&
       !plan.busy && !plan.globalFailureCode) {await this.settled();return;}
    throw new Error('本地保留未完成办理日志。需核对原租约和官方证据，禁止重复点击。');
  }
  async update(patch) {await atomicJson(this.file,{...await readJson(this.file),...patch,updatedAt:new Date().toISOString()});}
  async prepare(target) {await atomicJson(this.file,{phase:'claiming',target,createdAt:new Date().toISOString()});}
  async claimed(lease) {await this.update({phase:'claimed',lease});}
  async cancelUnsentPreparation(target,reason) {
    const j=await readJson(this.file);
    if(j?.phase!=='claiming'||j.lease!=null||j.receipt!=null||j.submission!=null ||
        !['stop_requested','budget_exhausted'].includes(reason) ||
        ['kind','targetId','email'].some(key=>j.target?.[key]!==target?.[key]))
      throw new Error('Only an exact local preparation before the claim RPC can be cancelled.');
    await this.update({phase:'settled',preparationCancelled:{target,reason,at:new Date().toISOString()}});
  }
  async submitted({operationId,token,kind,email,invitationSentAt}) {
    const j=await readJson(this.file),sent=Date.parse(invitationSentAt);
    if(j?.phase!=='attempting'||j.lease?.id!==operationId||j.lease?.token!==token||kind!=='invite'||
        j.lease.kind!==kind||j.lease.email!==email||!Number.isFinite(sent)||!Number.isFinite(Date.parse(j.lease.claimedAt))||sent<Date.parse(j.lease.claimedAt) ||
        j.submission && j.submission.invitationSentAt!==invitationSentAt)
      throw new Error('Invitation submission must match the original attempting lease.');
    await this.update({submission:{operationId,kind,email,invitationSentAt}});
  }
  async settleUnsentClaim(target,proof) {
    const j=await readJson(this.file);
    if(j?.phase!=='claiming' || j.lease!=null || j.receipt!=null || j.submission!=null ||
      !target || !['invite','remove'].includes(target.kind) ||
      ['kind','targetId','email'].some(key=>j.target?.[key]!==target[key]) ||
      proof?.stage!=='identity' || proof.requestedOperation!=='claim_seat_operation' ||
      proof.requestNotSent!==true || proof.readOnly!==true || !['timeout','network'].includes(proof.reason))
      throw new Error('Cannot settle a claim unless the matching RPC was proven not sent.');
    await this.update({phase:'settled',claimNotSent:{proof,target,at:new Date().toISOString()}});
  }
  async attempting() {await this.update({phase:'attempting'});}
  async evidence(receipt) {await this.update({phase:'completing',receipt});}
  async settled() {await this.update({phase:'settled',lease:undefined,receipt:undefined,submission:undefined});}
}
export async function acquireLock(file) {
  await mkdir(path.dirname(file),{recursive:true});
  let handle;
  try {handle=await open(file,'wx',0o600);}
  catch(e) {if(e.code === 'EEXIST') throw new Error('已有执行器或遗留锁；核对进程前不得并行运行。');throw e;}
  await handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
  return async()=>{await handle.close();await unlink(file);};
}
