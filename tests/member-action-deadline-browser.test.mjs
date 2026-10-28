// All browser traffic is intercepted with static fixtures. No official account,
// real invite, live network, administrator profile or permission is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {BrowserAdapter} from '../scripts/seat-executor/browser.mjs';
import {validateConfig,ADMIN} from '../scripts/agentless/config.mjs';

const html=`<!doctype html><meta charset="utf-8"><body>
<button aria-label="当前选择：My Workspace">My Workspace</button>
<section><b>4</b><br><span>高级席位</span><dl><dt>已分配</dt><dd>1</dd><dt>可用</dt><dd>3</dd></dl></section>
<button role="tab" aria-selected="true">用户</button><button role="tab" aria-selected="false">待处理的邀请</button>
<button aria-label="邀请成员" onclick="document.getElementById('overlay').innerHTML=document.getElementById('template').innerHTML">邀请成员</button>
<table><thead><tr><th>邮箱</th><th>角色</th><th>席位</th></tr></thead><tbody><tr>
<td>Owner（你）<br>${ADMIN}</td><td>角色类型<br>所有者</td><td>席位类型<br>高级</td></tr></tbody></table>
<div id="overlay"></div><template id="template"><div role="dialog"><h2>邀请团队成员</h2>
<input aria-label="电子邮箱"><button aria-label="席位类型">高级</button><button aria-label="角色类型">成员</button>
<button onclick="window.fixtureSend()">发送邀请</button></div></template></body>`;

for(const stage of ['after_commit','before_send'])test(`bounded real DOM invitation ${stage} preserves one-shot semantics`,async()=>{
  const native=await chromium.launch({channel:'msedge',headless:true}),context=await native.newContext(),page=await context.newPage();
  let offset=0,sends=0,intents=0;const committed=[];
  await page.exposeFunction('fixtureSend',()=>{sends++;});
  await context.route('**/*',route=>{assert.equal(new URL(route.request().url()).origin,'https://admin.openai.com');
    return route.fulfill({status:200,contentType:'text/html',body:html});});
  const config={...validateConfig(),liveActions:true},adapter=new BrowserAdapter(config,{page});
  adapter.onExternalAction=async()=>{intents++;if(stage==='before_send')offset=60000;};
  adapter.onExternalActionCommitted=async receipt=>{committed.push(receipt);offset=60000;};
  const before={complete:true,workspaceId:config.workspaceId,workspaceName:config.workspaceName,accountEmail:ADMIN,totalSeats:4,
    seatLabel:'高级',observedAt:new Date().toISOString(),pageUrl:adapter.url(),members:[{email:ADMIN,role:'owner',seatLabel:'高级'}],invites:[]};
  try {
    await assert.rejects(adapter.invite('fixture@example.com',before,{budgetMs:30000,now:()=>Date.now()+offset}),error=>error.failureCode==='browser_unavailable');
    assert.equal(intents,1);assert.equal(sends,stage==='after_commit'?1:0);assert.equal(committed.length,stage==='after_commit'?1:0);
    if(committed.length){assert.equal(committed[0].kind,'invite');assert.equal(committed[0].email,'fixture@example.com');
      assert.ok(Date.parse(committed[0].invitationSentAt)>=Date.parse(before.observedAt));}
    assert.equal(adapter.readOnlyWaitControls,undefined);
  } finally {await context.close();await native.close();}
});
