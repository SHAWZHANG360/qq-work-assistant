import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { validateConfig } from './config.mjs';
import { startAssistant } from './main.mjs';
import { createStore } from './store.mjs';

const config = { appId:'987654321', qqAppSecret:'test-only-qq-secret-value', deepseekApiKey:'test-only-ai-key-value', name:'示例姓名', organization:'示例单位', department:'' };
function tmp(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-generic-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir;
}
async function freePort() {
  const socket=createServer(); await new Promise(r=>socket.listen(0,'127.0.0.1',r));
  const port=socket.address().port; await new Promise(r=>socket.close(r)); return port;
}
test('configuration rejects missing keys, injected fields and whitespace credentials',()=>{
  for(const patch of [{appId:''},{appId:12345},{qqAppSecret:' test-only-secret '},{deepseekApiKey:''},{extra:'secret'},{name:'a\n'}])
    assert.throws(()=>validateConfig({...config,...patch}));
  assert.equal(validateConfig(config).appId,'987654321');
});
test('expired pairing code cannot bind and missing persisted owner fails closed',t=>{
  const dir=tmp(t), store=createStore(dir), old=store.ensurePairingCode();
  const file=path.join(dir,'pairing.json');
  fs.writeFileSync(file,JSON.stringify({code:old,createdAt:new Date(Date.now()-16*60*1000).toISOString()}));
  const msg=text=>({id:crypto.randomUUID(),senderId:'test-owner',timestamp:new Date().toISOString(),text});
  assert.equal(store.handleMessage(msg(`绑定 ${old}`)).paired,false);
  assert.equal(store.getOwner(),null);
  const code=store.ensurePairingCode(); assert.notEqual(code,old);
  assert.equal(store.handleMessage(msg(`绑定 ${code}`)).paired,true);
  fs.unlinkSync(path.join(dir,'owner.json'));
  assert.throws(()=>createStore(dir),/身份文件丢失/);
});
test('fresh main entry starts with custom AppID, binds and hides keys; POST requires origin',async t=>{
  const dir=tmp(t), port=await freePort(); let calls=0;
  class Client {
    constructor(options){assert.equal(options.appId,config.appId); this.options=options;}
    start(){this.options.onStatus({state:'connected',message:'test connected'});}
    stop(){} async reply(){}
  }
  const runtime=await startAssistant({config,dataDir:dir,pythonExecutable:process.execPath,port,Client,documentStore:{},
    provider:{analyzeMessage:async()=>{calls++; return {summary:'测试通过',relevance:'direct',actions:[],questions:[],notes:[]};}}});
  t.after(()=>runtime.close());
  const base=`http://127.0.0.1:${port}`;
  const page=await (await fetch(base)).text();
  const token=/const token='([a-f0-9]+)'/.exec(page)[1];
  const headers={'X-Local-Token':token,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/state')).status,403);
  let state=await (await fetch(base+'/api/state',{headers})).json();
  assert.equal(state.bound,false); assert.equal(state.appId,config.appId);
  assert.equal(JSON.stringify(state).includes(config.qqAppSecret),false);
  assert.equal(JSON.stringify(state).includes(config.deepseekApiKey),false);
  assert.equal((await fetch(base+'/api/test',{method:'POST',headers,body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/test',{method:'POST',headers:{...headers,Origin:'https://example.org'},body:'{}'})).status,403);
  assert.equal(calls,0);
  await runtime.application.receive({id:'pair',senderId:'test-owner',timestamp:new Date().toISOString(),text:state.pairingCommand});
  state=runtime.application.state(); assert.equal(state.bound,true); assert.equal(state.pairingCommand,null);
  const result=await fetch(base+'/api/test',{method:'POST',headers:{...headers,Origin:base},body:'{}'});
  assert.equal(result.status,200); assert.equal(calls,1);
});
test('occupied port prevents even constructing a QQ client',async t=>{
  const dir=tmp(t), port=await freePort(), blocker=createServer();
  await new Promise(r=>blocker.listen(port,'127.0.0.1',r)); t.after(()=>new Promise(r=>blocker.close(r)));
  let constructed=false;
  await assert.rejects(startAssistant({config,dataDir:dir,pythonExecutable:process.execPath,port,Client:class{constructor(){constructed=true;}}}),{code:'EADDRINUSE'});
  assert.equal(constructed,false); assert.equal(fs.existsSync(path.join(dir,'pairing.json')),false);
});
