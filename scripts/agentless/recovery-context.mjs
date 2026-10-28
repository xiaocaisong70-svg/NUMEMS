import {readJson} from './journal.mjs';
import {officialDiagnostic} from '../seat-executor/official-readiness.mjs';
const settled=j=>!j || j.phase==='settled' && j.lease==null && j.receipt==null && j.submission==null;
const planOf=value=>value.plan??value;
const browserSettings=c=>JSON.stringify(['profile','browserChannel','headless','browserMode','workspaceId','adminEmail',
  'workspaceName','workspaceSlug','totalSeats','reservedSeats','seatLabel','liveActions']
  .map(key=>[key,c?.[key]]));

/** A bounded standard-context reconnect only before a claim. Launch settings,
 * profile, security sandbox and desktop isolation remain exactly as configured. */
export async function restartReadonlyContext({portal,browser,config,journalFile,failureId,shouldStop=async()=>false,
  deadlineAt,budgetMs=30000,now=Date.now}) {
  if(!Number.isInteger(budgetMs)||budgetMs<1||budgetMs>120000 ||
      (deadlineAt!==undefined&&!Number.isFinite(deadlineAt)))throw new Error('Invalid standard-context reconnect budget.');
  const deadline=Math.min(deadlineAt??Infinity,now()+budgetMs),settings=browserSettings(config);
  const remaining=()=>Math.max(0,Math.floor(deadline-now()));
  const localSafe=async()=>remaining()>0 && !await shouldStop() && settled(await readJson(journalFile)) &&
    browser.config && browserSettings(browser.config)===settings;
  const check=async()=>{
    if(!await localSafe())return false;
    const p=planOf(await portal.call('seat_portal_status',{}, {deadlineAt:deadline,budgetMs:remaining(),now}));
    if(!await localSafe())return false;
    return p.workspaceId===config.workspaceId && p.administrator===config.adminEmail &&
      p.enabled===true && p.testOnly===false && !p.busy && !p.lease &&
      p.globalFailureCode==='browser_unavailable' && p.globalFailureId===failureId &&
      p.browserRecovery?.eligible===true && !['pending','active','uncertain'].includes(p.faultRescue?.phase);
  };
  if(!failureId || !await check())return false;
  if(typeof portal.rebindContext!=='function')throw new Error('Portal context rebinding is unavailable.');
  if(!await localSafe())return false;
  await browser.close();
  if(!await localSafe())return false;
  await browser.open({timeoutMs:Math.max(1,Math.min(30000,remaining()))});
  portal.rebindContext(browser.context);
  return check();
}

/** Informational progress cannot authorize actions or clear a failure. */
export async function publishRecoveryIncident(portal,event) {
  if(!event?.failureId)return {published:false};
  let diagnostic=event.diagnostic&&officialDiagnostic({...event.diagnostic,at:Date.parse(event.diagnostic.observedAt)});
  const human=event.phase==='interaction_required' && event.classification==='interaction_required' && diagnostic?.state==='interaction_required';
  const login=event.phase==='fatal' && event.classification==='login_required' && diagnostic?.state==='login';
  if(!human&&!login && diagnostic?.state==='interaction_required')diagnostic={...diagnostic,state:'challenge'};
  const phase=human?'interaction_required':login?'login_required':
    ['challenge','loading','network','capacity_unavailable'].includes(diagnostic?.state)?'security_check':'auto_recovery';
  try {
    await portal.call('record_recovery_progress',{expectedFailureId:event.failureId,phase,
      ...(diagnostic?{diagnostic}:{})});
    return {published:true};
  } catch {return {published:false};}
}
