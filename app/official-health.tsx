import {ShieldCheck} from 'lucide-react';

export default function OfficialHealth({observedAt,stale,admin}:{observedAt?:string|null;stale?:boolean;admin?:boolean}) {
  return <div className={stale&&admin?'admin-notice':'bottom-note'} role={stale&&admin?'alert':stale?'status':undefined}>
    <ShieldCheck size={15}/>
    官方名单核对：{observedAt?new Date(observedAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'尚无有效记录'}
    {stale?' · 核对已超时，网页状态等待同步':' · 已同步最近核对结果'}
    {admin&&<span>{stale?' · 请检查执行器状态与官方登录；页面暂时不能证明成员办理正常。':''} · 空闲时约每 2 分钟只读核对；官方后台发生的变更将在下次成功核对后同步。</span>}
  </div>;
}
