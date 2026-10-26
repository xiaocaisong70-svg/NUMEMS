import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,readJson} from './journal.mjs';

export const STOP_FILE='stop-request.json';
const LOCK_FILE='worker.lock';
function identity(value) {
  if(!value || !Number.isSafeInteger(value.pid) || value.pid<=0 ||
      typeof value.at!=='string' || !Number.isFinite(Date.parse(value.at)))
    throw new Error('执行器锁身份无效；未删除锁，也未强制停止进程。');
  return {pid:value.pid,at:value.at};
}
const same=(a,b)=>a.pid===b.pid && a.at===b.at;
function request(value) {
  if(value?.version!==1 || typeof value.id!=='string' || !/^[0-9a-f-]{36}$/i.test(value.id) ||
    typeof value.requestedAt!=='string' || !Number.isFinite(Date.parse(value.requestedAt)))
    throw new Error('本机停机请求无效，已停止继续办理。');
  identity(value.target);
  return value;
}

/** A request targets one exact lock incarnation. Startup never unlinks a stop file:
 * deleting a stale file could erase a new concurrent request. Old targets are ignored. */
export class GracefulStopControl {
  constructor(directory,lock,{watchdogStartedAt=null}={}) {
    this.file=path.join(directory,STOP_FILE);this.target=identity(lock);
    if(watchdogStartedAt!==null && (typeof watchdogStartedAt!=='string' || !Number.isFinite(Date.parse(watchdogStartedAt))))
      throw new Error('Watchdog startup timestamp invalid; stopped.');
    this.watchdogStartedAt=watchdogStartedAt;
    this.ignoredStaleRequest=false;this.requestId=null;
  }
  async requested() {
    const value=await readJson(this.file);
    if(!value)return false;
    const stop=request(value);
    if(this.watchdogStartedAt && Date.parse(stop.requestedAt)>=Date.parse(this.watchdogStartedAt)) {
      this.requestId=stop.id;return true;
    }
    if(!same(stop.target,this.target)){this.ignoredStaleRequest=true;return false;}
    this.requestId=stop.id;return true;
  }
}

/** No cancellation or race against an in-flight operation: the complete batch,
 * including its receipt, settles (or throws) before a stop request is checked. */
export async function runGracefulBatch(run,shouldStop) {
  if(await shouldStop())return {ran:false,stopped:true};
  const result=await run();
  return {ran:true,result,stopped:await shouldStop()};
}

export async function requestGracefulStop({directory,timeoutMs=300_000,
  now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),pollMs=250}) {
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>600_000 ||
    !Number.isSafeInteger(pollMs) || pollMs<1 || pollMs>1000)
    throw new Error('停机等待时间必须为 1000–600000 毫秒。');
  const started=now(),deadline=started+timeoutMs,lockFile=path.join(directory,LOCK_FILE);
  // acquireLock creates the file before writing its identity; tolerate only that
  // short initialization window. Invalid/stale locks are never deleted here.
  const readLock=async()=>{
    try {const lock=await readJson(lockFile);return lock?identity(lock):null;}
    catch(error){
      if(now()-started<Math.min(5000,timeoutMs) && error instanceof SyntaxError)return undefined;
      throw error;
    }
  };
  let target;
  while(target===undefined){
    target=await readLock();
    if(target===undefined)await pause(Math.min(pollMs,Math.max(1,deadline-now())));
  }
  if(!target)return {state:'already_stopped',modelCalls:0};
  const stop={version:1,id:randomUUID(),target,requestedAt:new Date(now()).toISOString()};
  await atomicJson(path.join(directory,STOP_FILE),stop);
  while(true){
    const current=await readLock();
    if(current===null)return {state:'stopped',requestId:stop.id,targetPid:target.pid,
      waitedMs:now()-started,modelCalls:0};
    if(current && !same(current,target))
      throw new Error('等待时执行器实例已改变；没有停止新实例，请核对后重新请求。');
    if(now()>=deadline)
      throw new Error('等待正常停机超时；停机请求仍有效，未杀进程、未删除锁或取消租约。');
    await pause(Math.min(pollMs,deadline-now()));
  }
}
