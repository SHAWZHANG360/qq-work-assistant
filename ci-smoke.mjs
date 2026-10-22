// CI-only systemd smoke entry: synthetic configuration, no network transports.
import fs from 'node:fs';
import path from 'node:path';
import { startAssistant } from './main.mjs';
import { createReminders } from './reminders.mjs';
class MockClient {
  constructor(options) { this.options=options; }
  start() { this.options.onStatus({state:'connected',message:'CI mock transport'}); }
  stop() {} async reply() {}
}
const config=JSON.parse(fs.readFileSync(path.join(process.env.CREDENTIALS_DIRECTORY,'assistant-config'),'utf8'));
const runtime=await startAssistant({config,dataDir:'/var/lib/qq-work-assistant',
  pythonExecutable:'/opt/qq-work-assistant/.venv/bin/python',Client:MockClient,
  provider:{analyzeMessage:async()=>({summary:'CI synthetic result',relevance:'direct',actions:[],questions:[],notes:[]})}});
if (!runtime.application.state().bound) {
  await runtime.application.receive({id:'ci-only-binding',senderId:'ci-only-owner',timestamp:new Date().toISOString(),text:runtime.application.state().pairingCommand});
}
// A synthetic future reminder exercises preservation across the upgrade.
const reminders=createReminders({dataDir:'/var/lib/qq-work-assistant'});
if(!reminders.forJob('ci-only-reminder').length)reminders.schedule({jobId:'ci-only-reminder',owner:'ci-only-owner',receivedAt:new Date().toISOString(),actions:[{title:'CI synthetic reminder',deadline:'2099-01-01T12:00:00+08:00',calendarStart:null,owner:null,location:null}]});
process.once('SIGTERM',async()=>{await runtime.close(); process.exit(0);});
