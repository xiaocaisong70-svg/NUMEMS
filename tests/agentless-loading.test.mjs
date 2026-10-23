// Local static fixtures only: every browser request is intercepted before navigation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {BrowserAdapter} from '../scripts/seat-executor/browser.mjs';
import {validateConfig,ADMIN} from '../scripts/agentless/config.mjs';

const origin = 'http://127.0.0.1:18766';
const row = (email = ADMIN, role = '所有者') => `<tr><td>${email === ADMIN ? 'Owner（你）' : 'Staff'}<br>${email}</td><td>角色类型<br>${role}</td><td>席位类型<br>高级</td></tr>`;
const card = (assigned = 1, available = 3, hidden = false) => `<section ${hidden ? 'hidden' : ''}><b>4</b><br><span>高级席位</span><dl><dt>已分配</dt><dd>${assigned}</dd><dt>可用</dt><dd>${available}</dd></dl></section>`;
const pageHtml = ({cards = '', rows = '', busy = false, empty = false, script = ''} = {}) => `<!doctype html><html><head><meta charset="utf-8"></head><body>
<button aria-label="当前选择：My Workspace">My Workspace</button>
<button role="tab" aria-selected="true">用户</button>
<div id="cards">${cards}</div>
<table aria-busy="${busy}"><thead><tr><th>邮箱</th><th>角色</th><th>席位</th></tr></thead><tbody>${rows}</tbody></table>
<p id="empty" ${empty ? '' : 'hidden'}>无结果</p>
<script>${script}</script></body></html>`;

test('official data readiness is bounded and never accepts a loading skeleton as an empty list', async t => {
  const browser = await chromium.launch({channel:'msedge', headless:true});
  async function fixture(body, run) {
    const context = await browser.newContext();
    await context.route('**/*', route => {
      assert.equal(new URL(route.request().url()).origin, origin, 'fixture must never contact a real account');
      return route.fulfill({status:200, contentType:'text/html', body});
    });
    const page = await context.newPage();
    const adapter = new BrowserAdapter(validateConfig(), {page, fixtureOrigin:origin});
    try {await page.goto(adapter.url()); await run(adapter, page);}
    finally {await context.close();}
  }
  try {
    await t.test('capacity waits for actual numbers and ignores hidden duplicate cards', async () => {
      await fixture(pageHtml({cards:card('', '') + card(1, 3, true), script:`
        setTimeout(() => document.querySelector('#cards section:not([hidden])').outerHTML=${JSON.stringify(card())}, 250);
      `}), async adapter => {
        assert.deepEqual(await adapter.capacity(), {total:4, assigned:1, available:3});
      });
    });
    await t.test('identical visible capacity cards are still ambiguous', async () => {
      await fixture(pageHtml({cards:card() + card()}), async adapter => {
        await assert.rejects(adapter.capacity(), /无法唯一确定/);
      });
    });
    await t.test('loaded inconsistent capacity fails strict arithmetic validation', async () => {
      await fixture(pageHtml({cards:card(4, 3)}), async adapter => {
        await assert.rejects(adapter.capacity(), /无法严格读取/);
      });
    });
    await t.test('busy table with stale empty text waits for real member rows', async () => {
      await fixture(pageHtml({busy:true, empty:true, script:`
        setTimeout(() => {document.querySelector('tbody').innerHTML=${JSON.stringify(row())};
          document.querySelector('table').setAttribute('aria-busy','false');document.querySelector('#empty').hidden=true;}, 250);
      `}), async adapter => {
        assert.deepEqual((await adapter.rows()).map(item => item.email), [ADMIN]);
      });
    });
    await t.test('partial list containing a blank skeleton row waits for that row', async () => {
      await fixture(pageHtml({rows:row() + '<tr id="pending"><td></td><td></td><td></td></tr>', script:`
        setTimeout(() => document.querySelector('#pending').outerHTML=${JSON.stringify(row('staff@example.com', '成员'))}, 250);
      `}), async adapter => {
        assert.deepEqual((await adapter.rows()).map(item => item.email), [ADMIN, 'staff@example.com']);
      });
    });
    await t.test('header-only table waits until an explicit empty state arrives', async () => {
      await fixture(pageHtml({script:`setTimeout(() => document.querySelector('#empty').hidden=false, 250);`}), async adapter => {
        assert.deepEqual(await adapter.rows(), []);
      });
    });
    await t.test('loaded member role ambiguity is never weakened by readiness wait', async () => {
      await fixture(pageHtml({rows:row(ADMIN, '未知角色')}), async adapter => {
        await assert.rejects(adapter.rows(), /成员行角色或席位类型不明确/);
      });
    });
    await t.test('permanent headers time out without returning an empty list', async () => {
      await fixture(pageHtml(), async adapter => {
        const started = Date.now();
        await assert.rejects(adapter.rows(), error => error.failureCode === 'browser_unavailable');
        assert.ok(Date.now() - started < 30_000, 'loading wait must remain bounded');
      });
    });
  } finally {await browser.close();}
});
