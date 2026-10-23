import { loadConfig } from './config.mjs';
import { openNormalEdge } from '../seat-executor/human-login.mjs';
const c=await loadConfig();
await openNormalEdge(c.profile,`https://admin.openai.com/workspace/${c.workspaceId}/members?workspace=my-workspace`,c.siteUrl);
console.log('请本人在普通 Edge 专用窗口登录两个站点，再关闭该窗口。密码和验证码不交给程序。');
