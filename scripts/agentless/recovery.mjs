import {bridgeObservation} from '../seat-executor/inventory.mjs';
import {readJson} from './journal.mjs';
export async function recoverBrowser({portal,browser,journalFile,pause=ms=>new Promise(r=>setTimeout(r,ms))}) {
  for(const delay of [15000,30000,60000]) {
    const j=await readJson(journalFile);
    const p=(await portal.call('seat_portal_status')).plan;
    if(p.globalFailureCode!=='browser_unavailable' || !p.browserRecovery?.eligible ||
      p.busy || p.lease || (j && j.phase!=='settled')) return false;
    await pause(delay);
    try {
      const observation=bridgeObservation(await browser.observe());
      const result=await portal.call('review_seat_failure',{decision:'recover_browser',observation});
      const latest=result.plan??result;
      return !latest.lastError && !latest.globalFailureCode && !latest.busy && !latest.lease;
    } catch { /* Bounded, read-only recovery; never repeats an uncertain member action. */ }
  }
  return false;
}
