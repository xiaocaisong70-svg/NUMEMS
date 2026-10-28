import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserAdapter } from '../seat-executor/browser.mjs';
import { OfficialPageError,officialDiagnostic } from '../seat-executor/official-readiness.mjs';
const execute = promisify(execFile);
const dedicatedObservations=new WeakSet();
// Process-local provenance, intentionally absent from JSON, cloud payloads and
// IAB snapshots. Only a completed dedicated adapter read can acquire it.
export const isDedicatedObservation=snapshot=>Boolean(snapshot&&typeof snapshot==='object'&&dedicatedObservations.has(snapshot));

export function validateDesktopProof(proof, expected) {
  if (!/^NUMEMS-Agentless-[a-zA-Z0-9-]+$/.test(expected ?? '') ||
      proof?.isolated !== true || proof.desktop !== expected ||
      !proof.inputDesktop || proof.inputDesktop === proof.desktop ||
      proof.windowStation?.toLowerCase() !== 'winsta0')
    throw new Error('无法证明浏览器与用户桌面隔离；禁止启动有界面浏览器。');
  return proof;
}

export async function assertDesktop(config, {env=process.env, platform=process.platform, run=execute,timeoutMs=20000}={}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>20000)throw new Error('Invalid desktop verification budget.');
  if (config.browserMode === 'headless' && config.headless === true)
    return {mode:'headless',isolated:false};
  if (platform !== 'win32' || config.browserMode !== 'isolated_desktop' || config.headless !== false)
    throw new Error('有界面浏览器仅能通过 Windows 隔离桌面启动器运行。');
  if (!/^NUMEMS-Agentless-[a-zA-Z0-9-]+$/.test(env.NUMEMS_DESKTOP_NAME ?? ''))
    throw new Error('缺少有效的隔离桌面宿主；禁止在普通桌面启动浏览器。');
  const powershell = path.join(env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  let stdout;
  try {
    ({stdout} = await run(powershell, ['-NoProfile','-NonInteractive','-File',
      path.join(import.meta.dirname,'desktop-probe.ps1')],
      {windowsHide:true, timeout:timeoutMs, env}));
  } catch (error) {
    let proof;try{proof=JSON.parse(error.stdout?.trim().replace(/^\uFEFF/,''));}catch{}
    // Only the exact native input-desktop failure is transient. An invalid
    // isolation proof, command timeout or other failure remains unclassified.
    if(proof?.error==='desktop_isolation_unverified' && proof.reason==='input_desktop_unavailable')
      error.failureCode='browser_unavailable';
    throw error;
  }
  return validateDesktopProof(JSON.parse(stdout.trim().replace(/^\uFEFF/,'')),env.NUMEMS_DESKTOP_NAME);
}

/** Keeps normal browser rendering while refusing any launch on the user's desktop. */
export class AgentlessBrowser extends BrowserAdapter {
  async observe(options) {
    const snapshot=await super.observe(options);
    if(snapshot&&typeof snapshot==='object')dedicatedObservations.add(snapshot);
    return snapshot;
  }
  async desktopProofForLaunch(options) {return assertDesktop(this.config,options);}
  async open({timeoutMs=30000}={}) {
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new Error('Invalid standard browser startup budget.');
    if(this.context || this.page)return super.open({timeoutMs});
    const now=this.readOnlyWaitControls?.now??Date.now;
    const deadline=Math.min(this.readOnlyWaitControls?.deadlineAt??Infinity,now()+timeoutMs);
    const remaining=()=>Math.max(0,Math.floor(deadline-now()));
    const guard=async()=>{
      await this.beforeOfficialRead('page');
      if(remaining()<=0)throw new OfficialPageError('隔离桌面核验已达到本次启动预算，未启动浏览器。','browser_unavailable',
        officialDiagnostic({stage:'page',state:'loading',expectedUrl:this.url()}));
    };
    await guard();
    this.desktopProof=await this.desktopProofForLaunch({timeoutMs:Math.min(20000,remaining())});
    await guard();
    return super.open({timeoutMs:Math.min(30000,remaining())});
  }
  set onExternalAction(handler) {this.actionHandler = handler;}
  get onExternalAction() {
    return async () => {
      const remaining=await this.beforeOfficialRead('page');
      await this.desktopProofForLaunch({timeoutMs:Math.max(1,Math.min(20000,remaining))});
      await this.beforeOfficialRead('page');
      return this.actionHandler?.();
    };
  }
}
