// Fully intercepted loopback fixtures. No real account, request, or member action.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {BrowserAdapter} from '../scripts/seat-executor/browser.mjs';
import {validateConfig,ADMIN} from '../scripts/agentless/config.mjs';

const origin='http://127.0.0.1:18790';
const target='retention-fixture@example.com';
function html({gapMs=600,keepText='保留付费席位',extraKeep=false,keepCloses=true}={}) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <button aria-label="当前选择：My Workspace">My Workspace</button>
  <button role="tab" aria-selected="true">用户</button><button role="tab" aria-selected="false">待处理的邀请</button>
  <table><thead><tr><th>名称</th><th>角色</th><th>席位类型</th><th>操作</th></tr></thead><tbody>
  <tr><td>Owner（你）<br>${ADMIN}</td><td>角色类型<br>所有者</td><td>席位类型<br>高级</td><td></td></tr>
  <tr id="target"><td>Fixture<br>${target}</td><td>角色类型<br>成员</td><td>席位类型<br>高级</td><td><button aria-label="打开 Fixture 的操作" onclick="menu()">操作</button></td></tr>
  </tbody></table><div id="overlay"></div>
  <script>
  const overlay=document.querySelector('#overlay');
  function menu(){overlay.innerHTML='<div role="menu"><button role="menuitem" onclick="firstDialog()">移除成员</button></div>';}
  async function firstDialog(){await window.fixtureClick('menu_remove');overlay.innerHTML='<div role="dialog">My Workspace<button onclick="confirmFirst()">从工作空间中移除</button></div>';}
  async function confirmFirst(){
    await window.fixtureClick('first_confirm');overlay.innerHTML='';
    setTimeout(()=>{overlay.innerHTML='<div role="dialog">My Workspace<button onclick="keepPaid()">${keepText}</button>${extraKeep?'<button onclick="keepPaid()">保留付费席位</button>':''}</div>';},${gapMs});
  }
  async function keepPaid(){
    await window.fixtureClick('keep_paid');
    ${keepCloses?"document.querySelector('#target').remove();overlay.innerHTML='';":""}
  }
  </script></body></html>`;
}

async function fixture(options,run) {
  const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true,timeout:20000});
  const context=await browser.newContext({serviceWorkers:'block'});
  const events=[];
  await context.route('**/*',async route=>{
    assert.equal(new URL(route.request().url()).origin,origin);
    await route.fulfill({status:200,contentType:'text/html',body:html(options)});
  });
  const page=await context.newPage();page.setDefaultTimeout(1500);
  await page.exposeFunction('fixtureClick',async kind=>{assert.ok(['menu_remove','first_confirm','keep_paid'].includes(kind));events.push(kind);});
  const config=validateConfig();
  const adapter=new BrowserAdapter(config,{page,fixtureOrigin:origin});
  const before={complete:true,workspaceId:config.workspaceId,workspaceName:config.workspaceName,
    accountEmail:config.adminEmail,totalSeats:config.totalSeats,seatLabel:config.seatLabel,
    members:[{email:ADMIN,role:'owner',seatLabel:config.seatLabel},{email:target,role:'member',seatLabel:config.seatLabel}],
    invites:[],observedAt:new Date().toISOString(),pageUrl:`https://admin.openai.com/workspace/${config.workspaceId}/members`};
  try {await run({adapter,before,page,events});}
  finally {await context.close();await browser.close();}
}

test('member removal waits across the first-dialog gap and commits only after keep-paid click',async()=>{
  await fixture({gapMs:600},async({adapter,before,page,events})=>{
    await adapter.remove(target,before);
    assert.deepEqual(events,['menu_remove','first_confirm','keep_paid']);
    assert.equal(await page.locator('#target').count(),0,'business removal is committed only after retention confirmation');
    assert.equal(await page.getByRole('dialog').count(),0);
  });
});

test('ambiguous paid-seat retention controls fail closed before choosing either button',async()=>{
  await fixture({gapMs:100,extraKeep:true},async({adapter,before,page,events})=>{
    await assert.rejects(adapter.remove(target,before),error=>{
      assert.deepEqual(Object.keys(error.operationDiagnostic).sort(),['category','kind','observedAt','stage']);
      assert.equal(error.operationDiagnostic.kind,'remove');
      assert.equal(error.operationDiagnostic.stage,'retention_wait');
      assert.equal(error.operationDiagnostic.category,'other');
      assert.ok(Number.isFinite(Date.parse(error.operationDiagnostic.observedAt)));
      return true;
    });
    assert.deepEqual(events,['menu_remove','first_confirm']);
    assert.equal(await page.locator('#target').count(),1);
  });
});

test('a reduction-only dialog times out without reducing paid seats or repeating the remove click',async()=>{
  await fixture({gapMs:100,keepText:'减少付费席位'},async({adapter,before,page,events})=>{
    await assert.rejects(adapter.remove(target,before),error=>{
      const d=error.operationDiagnostic;
      assert.equal(d.kind,'remove');assert.equal(d.stage,'retention_wait');assert.equal(d.category,'timeout');
      assert.equal(Object.values(d).some(value=>String(value).includes(target)),false);
      assert.match(d.observedAt,/Z$/);return true;
    });
    assert.deepEqual(events,['menu_remove','first_confirm']);
    assert.equal(await page.locator('#target').count(),1);
  });
});

test('Owner and administrator protection remains before any removal menu action',async()=>{
  await fixture({},async({adapter,before,events})=>{
    await assert.rejects(adapter.remove(ADMIN,before),error=>{
      assert.equal(error.operationDiagnostic.stage,'permission');return /保护/.test(error.message);
    });
    const adminSnapshot={...before,members:before.members.map(person=>person.email===target?{...person,role:'admin'}:person)};
    await assert.rejects(adapter.remove(target,adminSnapshot),error=>{
      assert.equal(error.operationDiagnostic.stage,'permission');return /Owner|管理员/.test(error.message);
    });
    assert.deepEqual(events,[]);
  });
});

test('a read-only diagnostic property never replaces the original provider exception',async()=>{
  const config=validateConfig();
  const adapter=new BrowserAdapter(config);
  adapter.permit=()=>{};
  const original=Object.assign(new Error('fixture provider error'),{failureCode:'browser_unavailable'});
  Object.defineProperty(original,'operationDiagnostic',{value:Object.freeze({fixture:true}),writable:false});
  adapter.load=async()=>{throw original;};
  await assert.rejects(adapter.remove(target,{members:[{email:target}],invites:[]}),error=>error===original);
});
