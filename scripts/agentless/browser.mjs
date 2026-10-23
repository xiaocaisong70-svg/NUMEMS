import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserAdapter } from '../seat-executor/browser.mjs';
const execute = promisify(execFile);

export function validateDesktopProof(proof, expected) {
  if (!/^NUMEMS-Agentless-[a-zA-Z0-9-]+$/.test(expected ?? '') ||
      proof?.isolated !== true || proof.desktop !== expected ||
      !proof.inputDesktop || proof.inputDesktop === proof.desktop ||
      proof.windowStation?.toLowerCase() !== 'winsta0')
    throw new Error('无法证明浏览器与用户桌面隔离；禁止启动有界面浏览器。');
  return proof;
}

export async function assertDesktop(config, {env=process.env, platform=process.platform, run=execute}={}) {
  if (config.browserMode === 'headless' && config.headless === true)
    return {mode:'headless',isolated:false};
  if (platform !== 'win32' || config.browserMode !== 'isolated_desktop' || config.headless !== false)
    throw new Error('有界面浏览器仅能通过 Windows 隔离桌面启动器运行。');
  if (!/^NUMEMS-Agentless-[a-zA-Z0-9-]+$/.test(env.NUMEMS_DESKTOP_NAME ?? ''))
    throw new Error('缺少有效的隔离桌面宿主；禁止在普通桌面启动浏览器。');
  const powershell = path.join(env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const {stdout} = await run(powershell, ['-NoProfile','-NonInteractive','-File',
    path.join(import.meta.dirname,'desktop-probe.ps1')],
    {windowsHide:true, timeout:20_000, env});
  return validateDesktopProof(JSON.parse(stdout.trim().replace(/^\uFEFF/,'')),env.NUMEMS_DESKTOP_NAME);
}

/** Keeps normal browser rendering while refusing any launch on the user's desktop. */
export class AgentlessBrowser extends BrowserAdapter {
  async open() {
    if (!this.context && !this.page) this.desktopProof = await assertDesktop(this.config);
    return super.open();
  }
  set onExternalAction(handler) {this.actionHandler = handler;}
  get onExternalAction() {
    return async () => {
      await assertDesktop(this.config);
      return this.actionHandler?.();
    };
  }
}
