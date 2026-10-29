// Ephemeral headless browser, static loopback fixtures, and all requests intercepted.
// No persistent profile, real account, official request, invitation or member change.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {BrowserAdapter} from '../scripts/seat-executor/browser.mjs';
import {validateConfig} from '../scripts/agentless/config.mjs';

const fixtureOrigin='http://127.0.0.1:41999';
const button=(label='当前选择：My Workspace',style='')=>`<button aria-label="${label}" style="${style}">My Workspace</button>`;
const modal=background=>`<!doctype html><html><head><meta charset="utf-8"></head><body>
<main aria-hidden="true">${background}</main>
<div role="dialog" aria-modal="true">My Workspace 普通成员操作</div></body></html>`;

test('modal background workspace guard remains strict without relying on the accessibility tree',async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true,timeout:20_000});
  const context=await browser.newContext({serviceWorkers:'block'});
  const page=await context.newPage();page.setDefaultTimeout(1000);
  let body=modal(button());const unexpected=[];
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==fixtureOrigin){unexpected.push(url.origin);await route.abort('blockedbyclient');return;}
    await route.fulfill({status:200,contentType:'text/html',body});
  });
  const config=validateConfig();
  const adapter=new BrowserAdapter(config,{page,fixtureOrigin});
  const load=async content=>{body=content;await page.goto(adapter.url(),{waitUntil:'domcontentloaded'});};
  try {
    await t.test('visible workspace selector survives an aria-hidden modal background',async()=>{
      await load(modal(button()));
      assert.equal(await page.getByRole('button',{name:'当前选择：My Workspace',exact:true}).count(),0);
      assert.equal(await page.getByRole('button',{name:'当前选择：My Workspace',exact:true,includeHidden:true}).filter({visible:true}).count(),1);
      await assert.doesNotReject(adapter.guard());
    });
    await t.test('CSS-hidden or duplicate selectors are still rejected',async()=>{
      for(const background of [button(undefined,'display:none'),button()+button()]){
        await load(modal(background));
        await assert.rejects(adapter.guard(),/工作空间选择器/);
      }
    });
    await t.test('a workspace whose name only contains the target is rejected',async()=>{
      await load(modal(button('当前选择：My Workspace Other')));
      await assert.rejects(adapter.guard(),/工作空间选择器/);
    });
    await t.test('English exact selector is supported',async()=>{
      await load(modal(button('Current selection: My Workspace')));
      await assert.doesNotReject(adapter.guard());
    });
    for(const prefix of ['选择全局设置、ChatGPT 工作空间或 Ads 账户。当前选择：','选择 ChatGPT 工作空间或 Ads 账户。当前选择：']){
      for(const withModal of [false,true])await t.test(`full console label stays exact and unique (${prefix}, modal ${withModal})`,async()=>{
        const render=background=>withModal?modal(background):`<!doctype html><html><head><meta charset="utf-8"></head><body><h1>My Workspace</h1>${background}</body></html>`;
        const label=`${prefix}My Workspace，ChatGPT 工作空间`;
        await load(render(button(label)));
        await assert.doesNotReject(adapter.guard());
        for(const background of [button(`${prefix}My Workspace Other，ChatGPT 工作空间`),
          button(`${prefix}My Workspace，Ads 账户`),button(label)+button(label),button(label,'display:none')]){
          await load(render(background));
          await assert.rejects(adapter.guard(),/工作空间选择器/);
        }
      });
    }
    await t.test('URL and workspace content guards are unchanged',async()=>{
      await load(modal(button()));
      await page.goto(`${fixtureOrigin}/workspace/wrong/members`);
      await assert.rejects(adapter.guard(),/非目标工作空间/);
      await load('<html><body><button aria-label="当前选择：Other Workspace">Other Workspace</button></body></html>');
      await assert.rejects(adapter.guard(),/工作空间名称不匹配/);
    });
    await t.test('Owner and administrator targets remain protected before any action',async()=>{
      const before={complete:true,workspaceId:config.workspaceId,workspaceName:config.workspaceName,
        accountEmail:config.adminEmail,totalSeats:config.totalSeats,seatLabel:config.seatLabel,
        observedAt:new Date().toISOString(),pageUrl:`https://admin.openai.com/workspace/${config.workspaceId}/members`,
        members:[{email:config.adminEmail,role:'owner',seatLabel:config.seatLabel},
          {email:'admin-fixture@example.com',role:'admin',seatLabel:config.seatLabel}],invites:[]};
      let externalActions=0;adapter.onExternalAction=()=>{externalActions++;};
      await assert.rejects(adapter.remove(config.adminEmail,before),/受保护账号/);
      await assert.rejects(adapter.remove('admin-fixture@example.com',before),/Owner 或管理员/);
      assert.equal(externalActions,0);
    });
    assert.deepEqual(unexpected,[]);
  } finally {await context.close();await browser.close();}
});
