// Convenience entry point; routine scheduled runs use run-hidden.vbs directly.
// No browser, model, shell interpolation, or fallback to the interactive desktop.
import path from 'node:path';
import {spawn} from 'node:child_process';

export function hostArguments(args,node=process.execPath) {
  const [mode,command,id,...extra]=args;
  const commands=['status','observe','prepare-test','release-test','test-reminder','test-expire',
    'enable-live','disable','reconcile','recover-browser','resolve-alert','resume-test-invite','review-test-workspace','review-live-workspace'];
  const withId=['release-test','test-reminder','test-expire'];
  if(!['probe','once','run','admin'].includes(mode) || extra.length ||
    (mode!=='admin' && (command!==undefined || id!==undefined)) ||
    (mode==='admin' && (!commands.includes(command) ||
      (withId.includes(command) ? !/^req_[a-zA-Z0-9_]+$/.test(id??'') : id!==undefined))))
    throw new Error('用法：host.mjs probe|once|run|admin <管理员命令> [已登记测试申请ID]');
  return ['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',
    path.join(import.meta.dirname,'isolated-desktop.ps1'),'-NodeExe',node,'-Mode',mode,
    ...(mode==='admin'?['-AdminCommand',command]:[]),...(id?['-RequestId',id]:[])];
}

if(process.argv[1] && path.resolve(process.argv[1])===import.meta.filename) {
  if(process.platform!=='win32') throw new Error('隔离宿主仅支持 Windows。');
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawn(powershell,hostArguments(process.argv.slice(2)),{windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  const halt=()=>child.kill();
  process.once('SIGINT',halt);process.once('SIGTERM',halt);
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  child.on('exit',code=>{process.off('SIGINT',halt);process.off('SIGTERM',halt);process.exitCode=code??1;});
}
