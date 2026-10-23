// Read-only acceptance probe. No queue tick, claim, invitation, removal or email.
import path from 'node:path';
import {loadConfig,validateConfig,runtimeDir} from './config.mjs';
import {AgentlessBrowser} from './browser.mjs';
import {PortalClient} from '../seat-executor/portal-client.mjs';
import {atomicJson,acquireLock} from './journal.mjs';

const config=validateConfig({...await loadConfig(),browserMode:'isolated_desktop',headless:false,liveActions:false});
const report={checkedAt:new Date().toISOString(),mode:'isolated_desktop',modelCalls:0,
  realInvitesSent:0,realMembersRemoved:0,realMailSent:0,portalVerified:false,officialVerified:false};
const file=path.join(runtimeDir,'isolated-probe.json');
const browser=new AgentlessBrowser(config);
const readTrace=[];
const maskEmail=value=>value.replace(/([^\s<>@]{0,2})[^\s<>@]*@([^\s<>@]+\.[^\s<>@]+)/g,'$1***@$2');
const readRows=browser.rows.bind(browser);
browser.rows=async(...args)=>{
  const rows=await readRows(...args);
  const tables=browser.page.getByRole('table').filter({visible:true});
  const url=new URL(browser.page.url());
  readTrace.push({at:new Date().toISOString(),stage:'rows',path:url.pathname,tab:url.searchParams.get('tab'),
    selectedTabs:await browser.page.getByRole('tab').evaluateAll(nodes=>nodes.filter(node=>node.getAttribute('aria-selected')==='true').map(node=>node.textContent?.trim())),
    headers:await tables.getByRole('columnheader').allInnerTexts(),
    rows:rows.map(row=>({email:maskEmail(row.email),role:row.role,self:row.self,configuredAdmin:row.email===config.adminEmail})),
    visibleRowText:(await tables.getByRole('row').allInnerTexts()).map(maskEmail)});
  return rows;
};
const readSnapshot=browser.snapshot.bind(browser);
browser.snapshot=async()=>{
  const startedAt=new Date().toISOString();
  try {
    const value=await readSnapshot();
    readTrace.push({at:new Date().toISOString(),startedAt,stage:'snapshot',totalSeats:value.totalSeats,
      members:value.members.map(({email,role})=>({email:maskEmail(email),role})),
      invites:value.invites.map(({email,role})=>({email:maskEmail(email),role}))});
    return value;
  } catch(error) {readTrace.push({at:new Date().toISOString(),startedAt,stage:'snapshot_failed',message:error.message});throw error;}
};
let release;
try {
  release=await acquireLock(path.join(runtimeDir,'worker.lock'));
  await browser.open();report.desktop=browser.desktopProof;
  // Check independently so a portal sign-in error does not hide the official result.
  try {
    const snapshot=await browser.observe();
    report.officialVerified=true;
    report.inventory={totalSeats:snapshot.totalSeats,members:snapshot.members.length,invites:snapshot.invites.length};
  } catch(error) {
    report.officialFailure={code:error.failureCode??'unknown',message:error.message};
    // Local-only diagnostics of already rendered UI. Never cookies, storage or auth tokens.
    await atomicJson(path.join(runtimeDir,'probe-official-ui.json'),{
      checkedAt:new Date().toISOString(),text:(await browser.page.locator('body').innerText()).slice(0,15000),
      workspaceButtons:await browser.page.getByRole('button',{includeHidden:true}).filter({visible:true}).evaluateAll((nodes,name)=>
        nodes.map(node=>({ariaLabel:node.getAttribute('aria-label')??'',text:(node.innerText??'').trim(),
          labelledBy:(node.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean)
            .map(id=>document.getElementById(id)?.textContent??'').join(' ').trim()}))
          .filter(value=>Object.values(value).some(text=>text.includes(name)))
          .map(value=>Object.fromEntries(Object.entries(value).map(([key,text])=>[key,text
            .replace(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/g,'[redacted-email]').slice(0,500)]))),config.workspaceName)
    }).catch(()=>{});
  }
  try {
    const client=new PortalClient(browser.context,config);
    const status=await client.call('seat_portal_status');
    report.portalVerified=true;
    report.portal={enabled:status.plan?.enabled,testOnly:status.plan?.testOnly,busy:status.plan?.busy};
  } catch(error) {
    report.portalFailure={message:error.message};
    const page=browser.context.pages().at(-1);
    if(page) {const location=new URL(page.url());report.portalFailure.location=location.origin+location.pathname;}
    if(page && new URL(page.url()).origin===new URL(config.siteUrl).origin) {
      report.portalIdentity=await page.evaluate(async()=>{
        const r=await fetch('/api/portal',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(20_000)});
        const b=await r.json();
        return {httpStatus:r.status,access:b.access,userEmail:b.user?.email,role:b.user?.role,
          signInLink:!!document.querySelector('a[href^="/signin-with-chatgpt"]')};
      }).catch(()=>({unavailable:true}));
    }
  }
  report.passed=report.officialVerified && report.portalVerified;
} catch(error) {report.passed=false;report.failure={message:error.message};}
finally {
  await browser.close().catch(()=>{});
  if(release) await release();
  report.finishedAt=new Date().toISOString();
  await atomicJson(path.join(runtimeDir,'probe-readiness.json'),{checkedAt:report.checkedAt,finishedAt:report.finishedAt,reads:readTrace});
  await atomicJson(file,report);
}
process.exitCode=report.passed?0:2;
