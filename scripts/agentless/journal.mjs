import { readFile,writeFile,rename,mkdir,open,unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export async function atomicJson(file,value) {
  await mkdir(path.dirname(file),{recursive:true});
  const tmp=`${file}.${randomUUID()}.tmp`;
  await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  await rename(tmp,file);
}
export async function readJson(file) {
  try { return JSON.parse(await readFile(file,'utf8')); }
  catch(e) { if(e.code === 'ENOENT') return null; throw e; }
}
export class Journal {
  constructor(file) {this.file=file;}
  async reconcile(plan) {
    const j=await readJson(this.file);
    if(!j || j.phase === 'settled') return;
    if(j.lease?.id && plan.receipts?.some(r=>r.id === j.lease.id)) {await this.settled();return;}
    const hold=plan.blockedOperations?.find(h=>h.operation.id === j.lease?.id);
    if(hold && ['mail_delivery','member_action','approval_required'].includes(hold.code) &&
       !plan.busy && !plan.globalFailureCode) {await this.settled();return;}
    throw new Error('本地保留未完成办理日志。需核对原租约和官方证据，禁止重复点击。');
  }
  async update(patch) {await atomicJson(this.file,{...await readJson(this.file),...patch,updatedAt:new Date().toISOString()});}
  async prepare(target) {await atomicJson(this.file,{phase:'claiming',target,createdAt:new Date().toISOString()});}
  async claimed(lease) {await this.update({phase:'claimed',lease});}
  async settleUnsentClaim(target,proof) {
    const j=await readJson(this.file);
    if(j?.phase!=='claiming' || j.lease!=null || j.receipt!=null ||
      !target || !['invite','remove'].includes(target.kind) ||
      ['kind','targetId','email'].some(key=>j.target?.[key]!==target[key]) ||
      proof?.stage!=='identity' || proof.requestedOperation!=='claim_seat_operation' ||
      proof.requestNotSent!==true || proof.readOnly!==true || !['timeout','network'].includes(proof.reason))
      throw new Error('Cannot settle a claim unless the matching RPC was proven not sent.');
    await this.update({phase:'settled',claimNotSent:{proof,target,at:new Date().toISOString()}});
  }
  async attempting() {await this.update({phase:'attempting'});}
  async evidence(receipt) {await this.update({phase:'completing',receipt});}
  async settled() {await this.update({phase:'settled',lease:undefined,receipt:undefined});}
}
export async function acquireLock(file) {
  await mkdir(path.dirname(file),{recursive:true});
  let handle;
  try {handle=await open(file,'wx',0o600);}
  catch(e) {if(e.code === 'EEXIST') throw new Error('已有执行器或遗留锁；核对进程前不得并行运行。');throw e;}
  await handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
  return async()=>{await handle.close();await unlink(file);};
}
