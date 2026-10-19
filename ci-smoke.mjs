// CI-only systemd smoke entry: synthetic configuration, no network transports.
import fs from 'node:fs';
import path from 'node:path';
import { startAssistant } from './main.mjs';
class MockClient {
  constructor(options) { this.options=options; }
  start() { this.options.onStatus({state:'connected',message:'CI mock transport'}); }
  stop() {} async reply() {}
}
const config=JSON.parse(fs.readFileSync(path.join(process.env.CREDENTIALS_DIRECTORY,'assistant-config'),'utf8'));
const runtime=await startAssistant({config,dataDir:'/var/lib/qq-work-assistant',
  pythonExecutable:'/opt/qq-work-assistant/.venv/bin/python',Client:MockClient,
  provider:{analyzeMessage:async()=>({summary:'CI synthetic result',relevance:'direct',actions:[],questions:[],notes:[]})}});
process.once('SIGTERM',async()=>{await runtime.close(); process.exit(0);});
