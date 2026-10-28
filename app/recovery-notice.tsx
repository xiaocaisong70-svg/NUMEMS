import {ShieldCheck} from 'lucide-react';

export type RecoveryConnection={memberPaused?:boolean;lastDeliveryError?:string|null;browserRecovering?:boolean;
  recoveryProgress?:{phase?:string;at?:string}|null;faultRescue?:{phase?:string;outcome?:string}|null};
export default function RecoveryNotice({connection,admin}:{connection?:RecoveryConnection;admin:boolean}) {
  if(!connection?.memberPaused&&!connection?.lastDeliveryError)return null;
  const phase=connection.recoveryProgress?.phase;
  const owned=connection.faultRescue&&['pending','uncertain'].includes(connection.faultRescue.phase??'');
  let title='自动办理需要核查',message=connection.lastDeliveryError||'成员办理暂缓，申请与队列顺序保留；核对恢复后继续办理。';
  if(connection.browserRecovering||phase==='auto_recovery'||phase==='security_check') {
    title='官方安全检查暂未通过';message='程序会有限尝试恢复，目前没有证据表明必须手动真人认证。申请与队列顺序保留，席位实际回收并核对后才会转派。';
  }
  if(owned||phase==='waiting_codex') {
    title=connection.faultRescue?.phase==='uncertain'?'故障诊断结果尚未确认':'正在进行一次故障诊断';
    message='已暂缓新的成员写入，避免重复邀请或移除。诊断会话结束并通过官方状态核对后，普通程序才会继续办理。';
  }
  if(phase==='review_required') {
    title='自动恢复尚未完成';message='目前未确认需要手动真人认证；故障记录和原任务已保留，程序不会盲目重复邀请或移除。';
  }
  if(phase==='interaction_required') {
    title='官方页面显示需要交互的验证控件';message=admin
      ?'请在执行器指定的专用会话查看官方提示并按要求操作。不要向系统发送密码或验证码；完成后程序会重新核对。'
      :'等待管理员处理官方页面提示。申请顺序保留，确认回收前不会把占用的席位分配给下一人。';
  }
  if(phase==='login_required') {
    title='管理员登录已失效';message=admin?'请在指定的专用会话重新登录；程序不会代填密码或确认新的权限。':'等待管理员恢复登录，申请和队列顺序保留。';
  }
  return <div role="alert" className="admin-notice"><ShieldCheck size={20}/><div><strong>{title}</strong><p>{message}</p></div></div>;
}
