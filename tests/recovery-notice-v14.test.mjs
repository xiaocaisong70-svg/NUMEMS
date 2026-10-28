import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url),module={exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../app/recovery-notice.tsx',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,
  {module,exports:module.exports,require});
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const render=(ticket,phase='waiting_codex')=>renderToStaticMarkup(React.createElement(module.exports.default,
  {admin:true,connection:{memberPaused:true,faultRescue:ticket,recoveryProgress:{phase}}}));
test('execution fallback is distinguished from readonly diagnosis and actual script health',()=>{
  const ticket={scope:'approved_member_ops',phase:'pending',expiresAt:'2099-01-01T00:00:00Z'};
  assert.match(render(ticket),/已交给备用通道办理/);
  assert.match(render(ticket),/只有实际邀请或回收确认成功/);
  assert.match(render({...ticket,phase:'finished',outcome:'handled'},'review_required'),/专用脚本通道仍在恢复检查/);
});
test('expired or unknown fallback never promises success or repeated writes',()=>{
  const ticket={scope:'approved_member_ops',phase:'pending',expiresAt:'2020-01-01T00:00:00Z'};
  assert.match(render(ticket),/备用办理时限已到/);
  assert.match(render(ticket),/不会因超时就重复/);
  assert.match(render({...ticket,phase:'uncertain'}),/备用办理结果待核对/);
  assert.doesNotMatch(render(ticket),/已完成真人/);
});
