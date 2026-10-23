// All official-origin requests are intercepted with static fixtures. No real account is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {BrowserAdapter} from '../scripts/seat-executor/browser.mjs';
import {validateConfig,ADMIN} from '../scripts/agentless/config.mjs';

function html({members,invites,tab,selectorRole,delay=0,formTitle='邀请加入 My Workspace',seatCommits=true}) {
  const rows=(tab==='invites'?invites:members).map(email=>`<tr><td>${email===ADMIN?'Owner（你）':'Staff'}<br>${email}</td><td>角色类型<br>${email===ADMIN?'所有者':'成员'}</td><td>席位类型<br>高级</td><td><button aria-label="打开 ${email} 的操作" onclick="menu('${email}')">操作</button></td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><button aria-label="当前选择：My Workspace">My Workspace</button>
  <section><b>${4}</b><br><span>高级席位</span><dl><dt>已分配</dt><dd>${members.length+invites.length}</dd><dt>可用</dt><dd>${4-members.length-invites.length}</dd></dl></section>
  <button role="tab" aria-selected="${tab==='members'}">用户</button><button role="tab" aria-selected="${tab==='invites'}">待处理的邀请</button>
  <button aria-label="邀请成员" onclick="later(inviteDialog)">邀请成员</button>
  <table><thead><tr><th>邮箱</th><th>角色</th><th>席位</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>${rows?'':'<p>无结果</p>'}
  <div id="overlay"></div><script>
  const overlay=document.getElementById('overlay');let target='';const tab='${tab}';
  function later(action){setTimeout(action,${delay});}
  function inviteDialog(){overlay.innerHTML='<div role="dialog"><h2>${formTitle}</h2><input aria-label="电子邮箱" id="email"><span role="${selectorRole}" aria-label="席位类型" id="seat" onclick="options()">标准</span><span role="${selectorRole}" aria-label="${delay?'角色 成员':'角色类型'}">成员</span><button onclick="send()">发送邀请</button></div>';}
  function options(){later(()=>{const d=document.createElement('div');d.id='options';d.setAttribute('role','dialog');d.innerHTML='<div role="option" onclick="selectSeat()">高级</div>';document.body.append(d);});}
  function selectSeat(){if(${seatCommits})document.getElementById('seat').textContent='高级';later(()=>document.getElementById('options').remove());}
  async function send(){await window.fixtureAction('invite',document.getElementById('email').value);overlay.innerHTML='';}
  function menu(email){target=email;later(()=>{overlay.innerHTML='<div role="menu"><button role="menuitem" onclick="later(confirmDialog)">'+(tab==='members'?'移除成员':'撤销邀请')+'</button></div>';});}
  function confirmDialog(){overlay.innerHTML='<div role="dialog">My Workspace<button onclick="removeTarget()">'+(tab==='members'?'从工作空间中移除':'撤销邀请')+'</button></div>';}
  async function removeTarget(){await window.fixtureAction(tab==='members'?'remove':'revoke',target);overlay.innerHTML=tab==='members'?'<div role="dialog"><button onclick="keep()">保留付费席位</button></div>':'';}
  function keep(){overlay.innerHTML='';}
  </script></body></html>`;
}

for(const [selectorRole,delay] of [['combobox',0],['button',0],['button',350]]) test(`official UI fixture: invitation, pending revoke, member removal (${selectorRole}, delay ${delay})`,async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(3000);
  let members=[ADMIN],invites=[],formTitle=delay?'邀请团队成员':'邀请加入 My Workspace',seatCommits=true;const clicks=[];
  await page.exposeFunction('fixtureAction',(kind,email)=>{
    assert.notEqual(email,ADMIN);clicks.push({kind,email});
    if(kind==='invite')invites.push(email);
    if(kind==='remove')members=members.filter(x=>x!==email);
    if(kind==='revoke')invites=invites.filter(x=>x!==email);
  });
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    assert.equal(u.origin,'https://admin.openai.com','fixture must never request real network');
    await route.fulfill({status:200,contentType:'text/html',body:html({members,invites,selectorRole,delay,formTitle,seatCommits,
      tab:u.searchParams.get('tab')==='invites'?'invites':'members'})});
  });
  const adapter=new BrowserAdapter({...validateConfig(),liveActions:true},{page});
  const target='fixture@example.com';let intent=0;adapter.onExternalAction=async()=>{intent++;};
  try {
    let snap=await adapter.observe();assert.equal(snap.members.length,1);
    await adapter.invite(target,snap);snap=await adapter.observe();assert.equal(snap.invites[0].email,target);
    await adapter.remove(target,snap);assert.equal((await adapter.observe()).invites.length,0);
    members.push(target);snap=await adapter.observe();await adapter.remove(target,snap);
    assert.deepEqual((await adapter.observe()).members.map(x=>x.email),[ADMIN]);
    assert.equal(intent,3);assert.deepEqual(clicks.map(c=>c.kind),['invite','revoke','remove']);
    await assert.rejects(adapter.remove(ADMIN,await adapter.observe()),/保护/);
    if(delay){
      seatCommits=false;
      await assert.rejects(adapter.invite(target,await adapter.observe()),/最终席位类型/);
      assert.equal(clicks.length,3,'uncommitted seat choice never sends');
      formTitle='邀请加入 Other Workspace';
      await assert.rejects(adapter.invite(target,await adapter.observe()),/邀请工作空间不匹配/);
      assert.equal(clicks.length,3,'wrong dialog never sends');
    }
  } finally {await context.close();await browser.close();}
});
