import test from 'node:test';
import assert from 'node:assert/strict';
import {PortalClient} from '../scripts/seat-executor/portal-client.mjs';
import {validateConfig} from '../scripts/agentless/config.mjs';

const config=validateConfig({browserMode:'isolated_desktop',headless:false});
function fixture({initial=401,restored=true,email=config.adminEmail,challenge=false,accountChoice=false,labelCount=1,choiceCount=1}={}) {
  let address=config.siteUrl,signins=0,reads=0,posts=0,choices=0;
  const page={url:()=>address,async goto(url){address=url;if(url.includes('/signin-with-chatgpt'))signins++;},
    async waitForURL(predicate){if(challenge)throw new Error('auth required');address=accountChoice && !choices?'https://auth.openai.com/choose-an-account':config.siteUrl;assert.ok(predicate(new URL(address)));},
    getByText(text,options){
      assert.equal(text,config.adminEmail);assert.equal(options.exact,true);
      const control={filter(){return this;},count:async()=>choiceCount,async click(){choices++;}};
      return {filter(){return this;},async waitFor(){if(!labelCount)throw new Error('no administrator account');},
        count:async()=>labelCount,locator:()=>control};
    },
    async evaluate(_fn,body){
      if(body){posts++;return {status:200,body:{id:body.id,result:{content:[{type:'text',text:'{"plan":{}}'}]}}};}
      reads++;
      return signins && restored ? {status:200,body:{access:'allowed',user:{email}}} :
        {status:initial,body:{access:initial===401?'signin_required':'forbidden'}};
    }};
  return {page,client:new PortalClient({newPage:async()=>page},config),counts:()=>({signins,reads,posts}),choices:()=>choices};
}
test('isolated portal may resume only its normal existing sign-in before reading state',async()=>{
  const f=fixture();await f.client.call('seat_portal_status');
  assert.deepEqual(f.counts(),{signins:1,reads:2,posts:1});
});
test('existing account selection is exact, unique and revalidates the returned identity',async()=>{
  const f=fixture({accountChoice:true});await f.client.call('seat_portal_status');
  assert.equal(f.choices(),1);assert.equal(f.counts().posts,1);
  for(const options of [{labelCount:0},{labelCount:2},{choiceCount:0},{choiceCount:2},
    {email:'wrong@example.com'}]){
    const bad=fixture({accountChoice:true,...options});await assert.rejects(bad.client.call('process_seat_queue'));
    assert.equal(bad.counts().posts,0);
    assert.equal(bad.choices(),options.email?1:0);
  }
});
test('no repeated sign-in, credential entry or action when session/identity is invalid',async()=>{
  for(const options of [{restored:false},{email:'someone@example.com'},{challenge:true},{initial:403}]){
    const f=fixture(options);await assert.rejects(f.client.call('process_seat_queue'));
    assert.equal(f.counts().posts,0);assert.ok(f.counts().signins<=1);
    if(options.restored===false){await assert.rejects(f.client.call('process_seat_queue'));assert.equal(f.counts().signins,1);}
    if(options.initial===403)assert.equal(f.counts().signins,0);
  }
});
