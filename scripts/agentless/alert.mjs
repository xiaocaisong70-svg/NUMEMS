import { randomUUID } from 'node:crypto';
import { readJson,atomicJson } from './journal.mjs';

// No chat/Agent fallback. Persist once, optionally deliver to an administrator HTTPS webhook.
export async function notifyFailure(file,{code='unknown',detail='执行器已暂停，请检查本机状态和门户租约。'},
  {env=process.env,fetcher=fetch}={}) {
  let notice=await readJson(file);
  if(notice && !notice.resolvedAt) return {state:notice.delivery,id:notice.id};
  notice={id:randomUUID(),code,detail,createdAt:new Date().toISOString(),delivery:'local_only'};
  await atomicJson(file,notice);
  if(!env.NUMEMS_ALERT_URL) return {state:notice.delivery,id:notice.id};
  const u=new URL(env.NUMEMS_ALERT_URL);
  if(u.protocol!=='https:' || u.username || u.password || u.hash || !env.NUMEMS_ALERT_TOKEN)
    throw new Error('管理员告警网关配置无效。');
  notice.delivery='attempting';await atomicJson(file,notice);
  try {
    const r=await fetcher(u,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.NUMEMS_ALERT_TOKEN}`,
        'Idempotency-Key':notice.id},body:JSON.stringify(notice)});
    if(!r.ok) throw new Error('Alert receipt missing');
    notice.delivery='accepted';
  } catch {notice.delivery='uncertain';}
  await atomicJson(file,notice);
  return {state:notice.delivery,id:notice.id};
}
