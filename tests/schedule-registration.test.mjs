import test from 'node:test';
import assert from 'node:assert/strict';
import {registerRunningSchedule} from '../scripts/agentless/main.mjs';
import {runBatch} from '../scripts/agentless/core.mjs';
import {validateConfig} from '../scripts/agentless/config.mjs';
const config=validateConfig({liveActions:true,legacyCheckerDisabled:true});
const healthy=()=>({workspaceId:config.workspaceId,administrator:config.adminEmail,enabled:true,testOnly:false,
  busy:false,lease:null,lastError:null,globalFailureCode:null,invites:[],removals:[],awaitingAcceptance:[],
  blockedOperations:[],reminders:[],receipts:[]});
test('an empty queue registers only its local schedule without official browser navigation',async()=>{
  const calls=[];const portal={call:async(name,args)=>{calls.push({name,args});return name==='process_seat_queue'?{mailMode:config.mailMode}:{plan:healthy()};}};
  const browser={observe:async()=>{throw new Error('An empty queue must not navigate official pages for schedule registration');}};
  const result=await runBatch({portal,browser,config});assert.equal(result.mode,'idle');
  assert.equal(await registerRunningSchedule({portal,config}),true);
  assert.equal(calls.at(-1).name,'record_codex_schedule');
  assert.equal(calls.at(-1).args.scheduleId,'local:seat-executor:NUMEMS-Agentless');
});
test('schedule metadata never bypasses formal mode, identity, lease or global fault guards',async()=>{
  for(const patch of [{enabled:false},{testOnly:true},{busy:true},{lease:{}},{lastError:'held'},
      {globalFailureCode:'unknown'},{workspaceId:'other'},{administrator:'other@example.com'}]){
    let writes=0;const portal={call:async name=>{if(name==='record_codex_schedule')writes++;return {plan:{...healthy(),...patch}};}};
    assert.equal(await registerRunningSchedule({portal,config}),false);assert.equal(writes,0);
  }
});
