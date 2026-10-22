// CI-only systemd smoke entry: synthetic configuration, no network transports.
import fs from 'node:fs';
import path from 'node:path';
import { startAssistant } from './main.mjs';
import { createReminders } from './reminders.mjs';
import assert from 'node:assert/strict';
const replies=[];
class MockClient {
  constructor(options) { this.options=options; }
  start() { this.options.onStatus({state:'connected',message:'CI mock transport'}); }
  stop() {} async reply(value) {replies.push(value);} async push() {}
}
const config=JSON.parse(fs.readFileSync(path.join(process.env.CREDENTIALS_DIRECTORY,'assistant-config'),'utf8'));
const runtime=await startAssistant({config,dataDir:'/var/lib/qq-work-assistant',
  pythonExecutable:'/opt/qq-work-assistant/.venv/bin/python',Client:MockClient,
  provider:{analyzeMessage:async()=>({summary:'CI synthetic result',relevance:'direct',actions:[],questions:[],notes:[]})}});
if (!runtime.application.state().bound) {
  await runtime.application.receive({id:'ci-only-binding',senderId:'ci-only-owner',timestamp:new Date().toISOString(),text:runtime.application.state().pairingCommand});
}
if(config.sharingEnabled){
  const send=(senderId,text)=>runtime.application.receive({id:crypto.randomUUID(),senderId,text,timestamp:new Date().toISOString()});
  if(!runtime.application.state().family.members.length){
    await send('ci-only-owner','/invite CI friend');
    const code=replies.at(-1).content.match(/加入 ([A-Za-z0-9_-]{24})/)[1];
    await send('ci-only-friend','加入 '+code);
    const id=runtime.application.state().family.members[0].id;
    await send('ci-only-owner','/approve '+id);
  }
  await send('ci-only-friend','/usage');assert.equal(replies.at(-1).senderId,'ci-only-friend');
  const before=replies.length;await send('ci-only-outsider','/today');assert.equal(replies.length,before);
  assert.equal(runtime.application.state().family.members[0].status,'active');
}
// A synthetic future reminder exercises preservation across the upgrade.
const reminders=createReminders({dataDir:'/var/lib/qq-work-assistant'});
if(!reminders.forJob('ci-only-reminder').length)reminders.schedule({jobId:'ci-only-reminder',owner:'ci-only-owner',receivedAt:new Date().toISOString(),actions:[{title:'CI synthetic reminder',deadline:'2099-01-01T12:00:00+08:00',calendarStart:null,owner:null,location:null}]});
process.once('SIGTERM',async()=>{await runtime.close(); process.exit(0);});
