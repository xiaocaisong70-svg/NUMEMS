import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {BrowserAdapter,CapacityCardUnavailable} from '../scripts/seat-executor/browser.mjs';
import {safeOfficialDiagnostic} from '../scripts/seat-executor/official-readiness.mjs';
import {validateConfig,ADMIN} from '../scripts/agentless/config.mjs';

const origin='http://127.0.0.1:18767';
const body=card=>`<!doctype html><html><head><meta charset="utf-8"></head><body>
<button aria-label="当前选择：My Workspace">My Workspace</button>
<button role="tab" aria-selected="true">用户</button>
${card}
<table><thead><tr><th>邮箱</th><th>角色</th><th>席位</th></tr></thead>
<tbody><tr><td>Owner（你）<br>${ADMIN}</td><td>角色类型<br>所有者</td><td>席位类型<br>高级</td></tr></tbody></table>
</body></html>`;
const bad='<section><p>无法加载席位信息</p><button onclick="alert(\'clicked\')">重试</button></section>';
const good='<section><b>4</b><br><span>高级席位</span><dl><dt>已分配</dt><dd>1</dd><dt>可用</dt><dd>3</dd></dl></section>';

test('recognized official capacity failure reloads one read-only page, never clicks retry',async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    for(const persistent of [false,true]) await t.test(persistent?'persistent failure remains blocked':'fresh valid capacity after one reload',async()=>{
      const context=await browser.newContext();let visits=0,dialogs=0;
      await context.route('**/*',route=>{
        const request=route.request();assert.equal(new URL(request.url()).origin,origin);
        assert.equal(request.method(),'GET');visits++;
        return route.fulfill({status:200,contentType:'text/html',body:body(visits===1 || persistent?bad:good)});
      });
      const page=await context.newPage();page.on('dialog',dialog=>{dialogs++;void dialog.dismiss();});
      const adapter=new BrowserAdapter(validateConfig(),{page,fixtureOrigin:origin});
      try {
        await page.goto(adapter.url());
        assert.equal(await page.getByText(/^无法加载席位信息[。.]?$/).filter({visible:true}).count(),1,'notice visible');
        assert.equal(await page.getByRole('button',{name:/^(?:重试|Retry)$/i}).filter({visible:true}).count(),1,'one retry control');
        if(persistent)await assert.rejects(adapter.capacity(),error=>error instanceof CapacityCardUnavailable && error.failureCode==='browser_unavailable' &&
          safeOfficialDiagnostic(error)?.state==='capacity_unavailable' && safeOfficialDiagnostic(error)?.stage==='capacity');
        else assert.deepEqual(await adapter.capacity(),{total:4,assigned:1,available:3});
        assert.equal(visits,2);assert.equal(dialogs,0);
      } finally {await context.close();}
    });
    await t.test('a stale visible capacity card beside the error is never accepted',async()=>{
      const context=await browser.newContext();let visits=0;
      await context.route('**/*',route=>{visits++;return route.fulfill({status:200,contentType:'text/html',body:body(visits===1?bad+good:good)});});
      const page=await context.newPage();const adapter=new BrowserAdapter(validateConfig(),{page,fixtureOrigin:origin});
      try {await page.goto(adapter.url());assert.deepEqual(await adapter.capacity(),{total:4,assigned:1,available:3});assert.equal(visits,2);}
      finally {await context.close();}
    });
    await t.test('ambiguous retry controls and security challenges never trigger reload',async()=>{
      for(const card of [bad+'<button>重试</button>',bad+'<p>安全验证</p>']) {
        const context=await browser.newContext();let visits=0;
        await context.route('**/*',route=>{visits++;return route.fulfill({status:200,contentType:'text/html',body:body(card)});});
        const page=await context.newPage();const adapter=new BrowserAdapter(validateConfig(),{page,fixtureOrigin:origin});
        try {
          await page.goto(adapter.url());
          // Avoid a real 25 s wait on the deliberate challenge; exiting the
          // first pause verifies that no navigation or action occurred.
          page.waitForTimeout=async()=>{throw new Error('bounded fixture pause');};
          await assert.rejects(adapter.capacity(),/重试控件不唯一|bounded fixture pause/);
          assert.equal(visits,1);
        } finally {await context.close();}
      }
    });
  } finally {await browser.close();}
});

test('capacity retry is exact and bounded; unrelated errors do not navigate',async()=>{
  for(const error of [new Error('capacity ambiguous'),Object.assign(new Error('sign in'),{failureCode:'login_expired'}),
      Object.assign(new Error('wrong workspace'),{failureCode:'workspace_mismatch'})]) {
    const adapter=new BrowserAdapter(validateConfig(),{page:{}});let loads=0;
    adapter.capacityOnce=async()=>{throw error;};adapter.guard=async()=>{};adapter.load=async()=>{loads++;};
    await assert.rejects(adapter.capacity(),candidate=>candidate===error);assert.equal(loads,0);
  }
});
