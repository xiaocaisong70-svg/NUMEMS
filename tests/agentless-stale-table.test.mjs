// Ephemeral headless browser and fully intercepted loopback HTML; no real account or action.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {BrowserAdapter} from '../scripts/seat-executor/browser.mjs';
import {validateConfig,ADMIN} from '../scripts/agentless/config.mjs';

const origin='http://127.0.0.1:18767';
const staff='staff@example.com';
const memberHeaders='<tr><th>名称</th><th>角色</th><th>席位类型</th><th>添加日期</th></tr>';
const inviteHeaders='<tr><th>电子邮箱</th><th>邀请日期</th><th>角色</th><th>席位类型</th></tr>';
const row=(email,role='成员',self=false)=>`<tr><td>Person${self?'（你）':''}<br>${email}</td><td>角色类型<br>${role}</td><td>席位类型<br>高级</td><td>2026年10月22日</td></tr>`;
const owner=()=>row(ADMIN,'所有者',true);
const html=({tab='members',count='',headers=memberHeaders,rows='',empty=false,extra='',script=''}={})=>`<!doctype html><html><head><meta charset="utf-8"></head><body>
<button aria-label="当前选择：My Workspace">My Workspace</button>
<button id="members" role="tab" aria-selected="${tab==='members'}">${tab==='members'&&count!==''?'活跃成员'+count:'用户'}</button>
<button id="invites" role="tab" aria-selected="${tab==='invites'}">待处理的邀请${tab==='invites'?count:''}</button>
<table><thead>${headers}</thead><tbody>${rows}</tbody></table><p id="empty" ${empty?'':'hidden'}>无结果</p>${extra}
<script>${script}</script></body></html>`;
const replaceRows=(rows,headers=memberHeaders)=>`document.querySelector('thead').innerHTML=${JSON.stringify(headers)};document.querySelector('tbody').innerHTML=${JSON.stringify(rows)};document.querySelector('#empty').hidden=true;`;

test('only two individually safe but changing snapshots are transient',async()=>{
  const config=validateConfig();
  const owner={email:ADMIN,role:'owner',seatLabel:config.seatLabel};
  const member={email:staff,role:'member',seatLabel:config.seatLabel};
  const snapshot=(overrides={})=>({complete:true,workspaceId:config.workspaceId,
    workspaceName:config.workspaceName,accountEmail:ADMIN,totalSeats:config.totalSeats,
    seatLabel:config.seatLabel,members:[owner],invites:[member],
    observedAt:new Date().toISOString(),
    pageUrl:`https://admin.openai.com/workspace/${config.workspaceId}/members`,...overrides});
  async function observe(a,b){
    const adapter=new BrowserAdapter(config);let calls=0;
    adapter.snapshot=async()=>calls++===0?a:b;
    return adapter.observe();
  }
  await assert.rejects(observe(snapshot(),snapshot({members:[owner,member],invites:[]})),
    error=>error.failureCode==='browser_unavailable');
  for(const unsafe of [{totalSeats:5},{accountEmail:staff},{workspaceId:'wrong'},
    {members:[{...owner,role:'admin'}]}]){
    await assert.rejects(observe(snapshot(),snapshot(unsafe)),
      error=>error.failureCode!=='browser_unavailable');
  }
  assert.deepEqual((await observe(snapshot(),snapshot())).invites,[member]);
});

test('row readiness rejects stale cross-tab contents and retains exact Owner identity',async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true,timeout:20_000});
  async function fixture(body,tab,run){
    const context=await browser.newContext({serviceWorkers:'block'});
    await context.route('**/*',async route=>{
      assert.equal(new URL(route.request().url()).origin,origin);
      await route.fulfill({status:200,contentType:'text/html',body});
    });
    const page=await context.newPage();page.setDefaultTimeout(2000);
    const adapter=new BrowserAdapter(validateConfig(),{page,fixtureOrigin:origin});
    try {await page.goto(adapter.url(tab));await run(adapter,page);}
    finally {await context.close();}
  }
  try {
    await t.test('selected members waits for stale invitation columns to be replaced',async()=>{
      await fixture(html({headers:inviteHeaders,rows:row(staff),script:`setTimeout(()=>{${replaceRows(owner())}},250);`}),
        'members',async adapter=>{assert.deepEqual((await adapter.rows({requireOwner:true})).map(r=>r.email),[ADMIN]);});
    });
    await t.test('configured Owner must gain its own self marker before acceptance',async()=>{
      await fixture(html({rows:row(ADMIN,'所有者'),script:`setTimeout(()=>{${replaceRows(owner())}},250);`}),
        'members',async adapter=>{assert.equal((await adapter.rows({requireOwner:true}))[0].self,true);});
    });
    await t.test('another self account or wrong configured role is rejected immediately',async()=>{
      for(const rows of [row(staff,'所有者',true),row(ADMIN,'管理员',true)]){
        await fixture(html({rows}),'members',async adapter=>{
          const started=Date.now();
          await assert.rejects(adapter.rows({requireOwner:true}),error=>error.failureCode==='role_mismatch');
          assert.ok(Date.now()-started<5000);
        });
      }
    });
    await t.test('invite count one forbids a transient empty table',async()=>{
      await fixture(html({tab:'invites',count:1,headers:inviteHeaders,empty:true,
        script:`setTimeout(()=>{${replaceRows(row(staff),inviteHeaders)}},250);`}),
        'invites',async adapter=>{assert.deepEqual((await adapter.rows()).map(r=>r.email),[staff]);});
    });
    await t.test('invites wait for stale member self row to disappear',async()=>{
      await fixture(html({tab:'invites',count:1,rows:owner(),
        script:`setTimeout(()=>{${replaceRows(row(staff),inviteHeaders)}},250);`}),
        'invites',async adapter=>{assert.deepEqual((await adapter.rows()).map(r=>r.email),[staff]);});
    });
    await t.test('completed list must match an explicit tab total',async()=>{
      await fixture(html({tab:'invites',count:2,headers:inviteHeaders,rows:row(staff)}),'invites',async adapter=>{
        await assert.rejects(adapter.rows(),error=>error.failureCode==='browser_unavailable');
      });
    });
    await t.test('Owner on a later page is verified after reading all pages',async()=>{
      const following=owner()+row('second@example.com');
      await fixture(html({count:3,rows:row(staff),extra:'<button id="next" aria-label="下一页" onclick="advance()">下一页</button>',
        script:`function advance(){${replaceRows(following)}document.querySelector('#next').disabled=true;}`}),
        'members',async adapter=>{
          const rows=await adapter.rows({requireOwner:true});
          assert.deepEqual(rows.map(r=>r.email),[staff,ADMIN,'second@example.com']);
          assert.equal(rows.filter(r=>r.self).length,1);
        });
    });
    await t.test('missing self marker remains a bounded failure, never first-Owner fallback',async()=>{
      await fixture(html({rows:row(ADMIN,'所有者')}),'members',async adapter=>{
        const started=Date.now();
        await assert.rejects(adapter.rows({requireOwner:true}),error=>error.failureCode==='browser_unavailable');
        assert.ok(Date.now()-started<30_000);
      });
    });
  } finally {await browser.close();}
});
