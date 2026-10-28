import path from 'node:path';
import { readFile } from 'node:fs/promises';

export const root = path.resolve(import.meta.dirname, '../..');
export const runtimeDir = path.join(root, '.sites-runtime/agentless');
export const configPath = path.join(runtimeDir, 'config.json');
export const SITE_URL = 'https://numems-seat-portal-agentless.workspace-026021.chatgpt.site/';
export const ADMIN = 'xiaocaisong70@gmail.com';
export const WORKSPACE = 'cd01c344-8ff9-41fd-a750-f7b30af9a7c9';
export const TASK_NAME = 'NUMEMS-Agentless';

export function validateConfig(input = {}) {
  const c = { siteUrl: SITE_URL, adminEmail: ADMIN, workspaceId: WORKSPACE,
    workspaceName: 'My Workspace', workspaceSlug: 'my-workspace',
    totalSeats: 4, reservedSeats: 1, seatLabel: '高级',
    profile: path.join(runtimeDir, 'browser'), browserChannel: 'msedge', headless: true,
    browserMode: 'headless',
    pollSeconds: 15, officialReconcileSeconds: 120, maxItems: 6, mailMode: 'in_app', liveActions: false,
    legacyCheckerDisabled: false, ...input };
  if (new URL(c.siteUrl).href !== SITE_URL || c.adminEmail !== ADMIN ||
      c.workspaceId !== WORKSPACE || c.workspaceName !== 'My Workspace' ||
      c.workspaceSlug !== 'my-workspace' || c.totalSeats !== 4 || c.reservedSeats !== 1 || c.seatLabel !== '高级')
    throw new Error('站点、工作空间、管理员或席位配置不匹配。');
  if (!['in_app', 'relay'].includes(c.mailMode) || typeof c.liveActions !== 'boolean' ||
      typeof c.legacyCheckerDisabled !== 'boolean' || typeof c.headless !== 'boolean' ||
      !['msedge', 'chrome', ''].includes(c.browserChannel) ||
      !['headless', 'isolated_desktop'].includes(c.browserMode) ||
      (c.browserMode === 'headless' && c.headless !== true) ||
      (c.browserMode === 'isolated_desktop' && c.headless !== false) ||
      !Number.isInteger(c.pollSeconds) || c.pollSeconds < 10 || c.pollSeconds > 300 ||
      !Number.isInteger(c.officialReconcileSeconds) || c.officialReconcileSeconds < 120 || c.officialReconcileSeconds > 3600 ||
      !Number.isInteger(c.maxItems) || c.maxItems < 1 || c.maxItems > 20)
    throw new Error('无 Agent 执行器配置无效；到期提醒仅支持网页或独立 relay。');
  c.profile = path.resolve(root, c.profile);
  const rel = path.relative(runtimeDir, c.profile);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error('必须使用本副本的独立登录档案。');
  return Object.freeze(c);
}
export async function loadConfig() {
  try { return validateConfig(JSON.parse(await readFile(configPath, 'utf8'))); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return validateConfig(); }
}
