import {ShieldCheck} from 'lucide-react';

export type RecoveryConnection={memberPaused?:boolean;lastDeliveryError?:string|null;browserRecovering?:boolean;
  recoveryProgress?:{phase?:string;at?:string}|null;faultRescue?:{phase?:string;outcome?:string;scope?:string;expiresAt?:string}|null};
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
    if(connection.faultRescue?.scope==='approved_member_ops') {
      const expires=Date.parse(connection.faultRescue.expiresAt??'');
      const expired=Number.isFinite(expires)&&expires<=Date.now();
      title=connection.faultRescue.phase==='uncertain'?'备用办理结果待核对':expired?'备用办理时限已到':'已交给备用通道办理';
      message=expired
        ?'已停止领取新的操作；原操作结果和执行权仍需核实。不会因超时就重复发送邀请、重复移除或把尚未回收的席位转派。'
        :'备用通道仅办理本轮已批准的有限任务，并逐项核对官方结果。只有实际邀请或回收确认成功，申请状态与可分配席位才会更新。';
    }
  }
  if(phase==='review_required') {
    title='自动恢复尚未完成';message='目前未确认需要手动真人认证；故障记录和原任务已保留，程序不会盲目重复邀请或移除。';
    if(connection.faultRescue?.outcome==='handled') {
      title='本轮备用办理已结案';
      message='已核实的任务已更新；专用脚本通道仍在恢复检查中。备用办理有次数与时间上限，未完成任务继续保留，不能视为已邀请或已回收。';
    }
  }
  if(phase==='fallback_exhausted') {
    title='备用办理已达到本轮限额';
    message='为避免反复唤醒模型，系统已停止追加备用任务。未完成申请和席位占用仍保留，普通程序继续有限恢复检查；管理员可查看故障记录。';
  }
  if(phase==='fallback_timeout') {
    title='备用办理时限已到';
    message='不再授予新的成员操作权限；系统正在核对原操作和执行权。超时不代表席位已回收，结果未确认前不会重复办理或释放容量。';
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
