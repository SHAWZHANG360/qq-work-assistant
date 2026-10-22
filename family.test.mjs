import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFamilyMembers} from './family-members.mjs';
import {createFamilyApplication} from './family-application.mjs';

function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'qq-family-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
const settings=()=>({async initialize(){},getSettings:()=>({textModel:'deepseek-flash',imageModel:'deepseek-flash',reasoningEffort:'none'}),getSnapshot:()=>({settings:{},models:[]}),async save(){}});
const result=(title,deadline=null)=>({summary:title,relevance:'direct',actions:[{title,deadline,calendarStart:null,calendarEnd:null,owner:'',location:'',needsConfirmation:false}],questions:[],notes:[]});
async function waitFor(fn,timeout=2500){const end=Date.now()+timeout;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('condition timeout');}
function fixture(t,{dataDir=temp(t),...overrides}={}) {
  if(!fs.existsSync(path.join(dataDir,'owner.json')))fs.writeFileSync(path.join(dataDir,'owner.json'),JSON.stringify({openid:'test-admin',pairedAt:'2026-01-01T00:00:00Z'}));
  const replies=[],pushes=[],calls=[],clients=[];let seq=0,inFlight=0,maxConcurrent=0;
  class Client {constructor(options){this.options=options;clients.push(this);}start(){this.options.onStatus({state:'connected',message:'test'});}stop(){}async reply(p){replies.push(p);}async push(p){pushes.push(p);}}
  const app=createFamilyApplication({appId:'987654321',sharingEnabled:true,dataDir,preferences:{ownerProfile:{name:'ADMIN-ONLY-PROFILE'},relevanceKeywords:['ADMIN-ONLY-KEYWORD']},Client,
    secrets:{load:async()=>'test-only-secret-long-enough',exists:()=>true},formatAnalysis:r=>r.summary,
    settingsFactory:settings,documentFactory:()=>({}),analyze:async(input,options)=>{calls.push({input,preferences:structuredClone(options.preferences)});inFlight++;maxConcurrent=Math.max(maxConcurrent,inFlight);await new Promise(r=>setTimeout(r,15));inFlight--;options.onUsage({inputTokens:10,outputTokens:5,cachedInputTokens:0});return result(input.text);},...overrides});
  t.after(()=>app.stop());
  const message=(senderId,text,id='test-'+(++seq))=>({senderId,text,id,timestamp:new Date().toISOString()});
  const send=(sender,text,id)=>app.receive(message(sender,text,id));
  async function join(sender,label=sender) {
    await send('test-admin','/invite '+label);
    const code=replies.at(-1).content.match(/加入 ([A-Za-z0-9_-]{24})/)[1];
    await send(sender,'加入 '+code);
    const id=replies.at(-1).content.match(/申请编号 ([a-f0-9]{8})/)[1];
    await send('test-admin','/approve '+id);return id;
  }
  return {app,dataDir,replies,pushes,calls,clients,send,message,join,maxConcurrent:()=>maxConcurrent};
}

test('registry caps family at 3, requires approval, expires invites and blocks replay',t=>{
  const dataDir=temp(t);let now=1000;const m=createFamilyMembers({dataDir,adminId:'test-admin',now:()=>now});
  const invite=m.invite('i1','test-family');assert.ok(invite.code);
  assert.equal(m.invite('i1','duplicate').duplicate,true);
  now+=900001;assert.equal(m.join('j1','test-1',invite.code).invalid,true);
  for(let n=0;n<3;n++){const i=m.invite('i'+(n+10),'family-'+n);const j=m.join('j'+n,'user-'+n,i.code);assert.equal(j.member.status,'pending');assert.equal(m.active().length,n);m.approve('a'+n,j.member.id);}
  assert.equal(m.active().length,3);assert.ok(m.invite('fourth','family4').error);
  const a=m.active()[0];m.revoke('revoke',a.id);assert.equal(m.active().length,2);assert.ok(m.invite('new','new family').code);
  const raw=fs.readFileSync(path.join(dataDir,'family-members.json'),'utf8');assert.ok(!raw.includes(invite.code));
  fs.unlinkSync(path.join(dataDir,'family-members.json'));
  assert.throws(()=>createFamilyMembers({dataDir,adminId:'test-admin'}),/登记丢失/);
});

test('corrupt registry or changed admin cannot reset access; profiles are bounded',t=>{
  const dataDir=temp(t),m=createFamilyMembers({dataDir,adminId:'test-admin'});
  const code=m.invite('i','family').code,member=m.join('j','family-id',code).member;
  m.approve('a',member.id);
  assert.ok(m.profile('p','family-id',{name:'a\n',college:'',department:''}).error);
  assert.throws(()=>createFamilyMembers({dataDir,adminId:'other-admin'}),/登记损坏/);
  const p=path.join(dataDir,'family-members.json');fs.writeFileSync(p,'{}');
  assert.throws(()=>createFamilyMembers({dataDir,adminId:'test-admin'}),/登记损坏/);
});

test('one QQ connection, isolated records and usage, no admin profile leakage, no outsider writes',async t=>{
  const f=fixture(t);await f.app.restore();
  const ownerBefore=fs.readFileSync(path.join(f.dataDir,'owner.json'));
  const originalFiles=fs.readdirSync(f.dataDir);
  await f.send('stranger','/today');await f.send('stranger','/invite stranger');await f.send('stranger','加入 AAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(f.replies.length,0);assert.deepEqual(fs.readdirSync(f.dataDir),originalFiles);
  const memberId=await f.join('family-1');await f.join('family-2');await f.join('family-3');
  assert.equal(f.clients.length,1);
  await f.send('family-1','/approve '+memberId);assert.match(f.replies.at(-1).content,/只有管理员/);
  await f.send('family-1','/profile 家人甲|单位甲|部门甲');
  await f.send('test-admin','ADMIN-RECORD','same-id');await f.send('family-1','FAMILY-RECORD','same-id');
  await waitFor(()=>f.replies.some(x=>x.senderId==='family-1'&&x.content.includes('本条用量')));
  assert.equal(f.calls.length,2);assert.equal(f.maxConcurrent(),1);
  assert.equal(f.calls.find(x=>x.input.text==='FAMILY-RECORD').preferences.ownerProfile.name,'家人甲');
  assert.ok(!JSON.stringify(f.calls.find(x=>x.input.text==='FAMILY-RECORD')).includes('ADMIN-ONLY'));
  assert.ok(!JSON.stringify(f.app.state()).includes('FAMILY-RECORD'));
  assert.equal(f.app.state().usage.today.totalTokens,15);
  assert.equal(f.app.state().family.usageByMember.find(x=>x.id===memberId).today.totalTokens,15);
  await f.send('family-1','/today');assert.match(f.replies.at(-1).content,/FAMILY-RECORD/);assert.doesNotMatch(f.replies.at(-1).content,/ADMIN-RECORD/);
  await f.send('test-admin','/today');assert.doesNotMatch(f.replies.at(-1).content,/FAMILY-RECORD/);
  await f.send('family-2','/usage');assert.match(f.replies.at(-1).content,/0 token/);
  await f.send('family-1','取消提醒');assert.match(f.replies.at(-1).content,/已取消 1 条/);
  assert.equal(f.app.state().reminders[0].status,'pending');
  const memberDir=path.join(f.dataDir,'family-users',memberId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(memberDir,'reminders.json'))).items[0].status,'cancelled');
  const before=f.calls.length;await f.send('test-admin','/revoke '+memberId);await f.send('family-1','BLOCKED-AFTER-REVOKE');assert.equal(f.calls.length,before);
  assert.deepEqual(fs.readFileSync(path.join(f.dataDir,'owner.json')),ownerBefore);
  assert.ok(fs.existsSync(path.join(memberDir,'model-usage.json')));
  const raw=fs.readdirSync(path.join(memberDir,'messages')).map(n=>fs.readFileSync(path.join(memberDir,'messages',n),'utf8')).join('');
  assert.doesNotMatch(raw,/加入 |\/profile|ADMIN-RECORD|BLOCKED-AFTER-REVOKE/);
});

test('pending member cannot analyze; replayed old commands do not grant access',async t=>{
  const f=fixture(t);await f.app.restore();await f.send('test-admin','/invite 家人');
  const code=f.replies.at(-1).content.match(/加入 ([A-Za-z0-9_-]{24})/)[1];
  await f.send('family-1','加入 '+code);const id=f.app.state().family.members[0].id;
  await f.send('family-1','NOT-ALLOWED-YET');assert.equal(f.calls.length,0);
  await f.app.receive({...f.message('test-admin','/approve '+id),timestamp:new Date(Date.now()-300000).toISOString()});
  assert.equal(f.app.state().family.members[0].status,'pending');
  await f.send('test-admin','/approve '+id);await f.send('family-1','ALLOWED');
  await waitFor(()=>f.replies.some(x=>x.senderId==='family-1'&&x.content.includes('本条用量')));assert.equal(f.calls.length,1);
});

test('restart preserves owner files, family identity, profiles and per-user history',async t=>{
  const f=fixture(t);await f.app.restore();const memberId=await f.join('family-1');
  await f.send('family-1','/profile 家人名|-|-');await f.send('family-1','PERSISTED');
  await waitFor(()=>f.replies.some(x=>x.senderId==='family-1'&&x.content.includes('本条用量')));
  f.app.stop();const dir=path.join(f.dataDir,'family-users',memberId);
  const files=['owner.json','model-usage.json','reminders.json'];const before=files.map(n=>fs.readFileSync(path.join(dir,n)));
  const next=fixture(t,{dataDir:f.dataDir});await next.app.restore();
  files.forEach((n,i)=>assert.deepEqual(fs.readFileSync(path.join(dir,n)),before[i]));
  await next.send('family-1','/today');assert.match(next.replies.at(-1).content,/PERSISTED/);
  await next.send('family-1','/profile');assert.match(next.replies.at(-1).content,/家人名/);
  assert.equal(next.calls.length,0);
});

test('turning sharing off blocks members without changing saved member state; on restores access',async t=>{
  const f=fixture(t);await f.app.restore();const id=await f.join('family-1');f.app.stop();
  const registry=path.join(f.dataDir,'family-members.json'),before=fs.readFileSync(registry);
  const off=fixture(t,{dataDir:f.dataDir,sharingEnabled:false});await off.app.restore();
  await off.send('family-1','/today');await off.send('family-1','PRIVATE-WHILE-OFF');assert.equal(off.replies.length,0);assert.equal(off.calls.length,0);
  await off.send('test-admin','/invite new');assert.match(off.replies.at(-1).content,/共享并重启/);assert.deepEqual(fs.readFileSync(registry),before);
  off.app.stop();const on=fixture(t,{dataDir:f.dataDir});await on.app.restore();await on.send('family-1','/help');assert.match(on.replies.at(-1).content,/自己的/);
  assert.equal(on.app.state().family.members[0].id,id);
});

test('due reminders use their own recipient and revocation disables future sends',async t=>{
  const f=fixture(t);await f.app.restore();const memberId=await f.join('family-1');f.app.stop();
  const reminder=(title,owner)=>({version:1,items:[{id:'test-reminder',jobId:'test-job',owner,titles:[title],dueAt:new Date(Date.now()-1000).toISOString(),defaultTime:false,status:'pending'}]});
  fs.writeFileSync(path.join(f.dataDir,'reminders.json'),JSON.stringify(reminder('ADMIN-REMINDER','test-admin')));
  const dir=path.join(f.dataDir,'family-users',memberId);
  fs.writeFileSync(path.join(dir,'reminders.json'),JSON.stringify(reminder('FAMILY-REMINDER','family-1')));
  const next=fixture(t,{dataDir:f.dataDir});await next.app.restore();
  await waitFor(()=>next.pushes.length===2,35000);
  assert.deepEqual(next.pushes.map(x=>x.senderId).sort(),['family-1','test-admin']);
  assert.match(next.pushes.find(x=>x.senderId==='family-1').content,/FAMILY-REMINDER/);
  assert.doesNotMatch(next.pushes.find(x=>x.senderId==='family-1').content,/ADMIN-REMINDER/);
  assert.equal(next.calls.length,0);
  next.app.stop();
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'reminders.json')));saved.items[0].status='pending';fs.writeFileSync(path.join(dir,'reminders.json'),JSON.stringify(saved));
  const registry=createFamilyMembers({dataDir:f.dataDir,adminId:'test-admin'});registry.revoke('disable',memberId);
  const last=fixture(t,{dataDir:f.dataDir});await last.app.restore();assert.equal(last.app.state().family.usageByMember.length,0);
  await last.send('family-1','取消提醒');assert.equal(last.replies.length,0);assert.equal(last.pushes.length,0);
});

test('images, attachment extraction and admin web uploads stay in their tenant',async t=>{
  const downloaded=[],readImages=[];
  const f=fixture(t,{
    documentFactory:dir=>({
      async prepare(id,files){downloaded.push({dir,id,kind:'doc'});return {documents:[{relativePath:'documents/test/1.txt',name:'test.txt',mimeType:'text/plain',size:10,text:'DOC-'+path.basename(dir),warnings:[]}],warnings:[],unreadAttachments:false};},
      async prepareLocal(id,files){downloaded.push({dir,id,kind:'local'});return {documents:[{relativePath:'documents/test/1.txt',name:'test.txt',mimeType:'text/plain',size:10,text:'WEB-ADMIN-ONLY',warnings:[]}],warnings:[],unreadAttachments:false};},
      async resolveDocuments(id,docs){return structuredClone(docs);},
    }),
    attachmentFactory:dir=>({
      async prepare(id,files){downloaded.push({dir,id,kind:'image'});return {images:[{relativePath:'images/test/1.png',mimeType:'image/png',size:10}],warnings:[],unreadAttachments:false};},
      async resolveImages(id,images){return images.map(i=>({...i,path:path.join(dir,i.relativePath)}));},
    }),
    recognizeImages:async(input,options)=>{readImages.push(input);options.onUsage({inputTokens:3,outputTokens:2});return {images:[{index:1,text:'IMAGE-TEXT',legibility:'clear',uncertainties:[]}]};},
  });
  await f.app.restore();const memberId=await f.join('family-1');
  const attachments=[{filename:'test.txt',content_type:'text/plain',url:'https://multimedia.nt.qq.com.cn/test'}, {filename:'test.png',content_type:'image/png',url:'https://multimedia.nt.qq.com.cn/image'}];
  await f.app.receive({...f.message('stranger','DENIED','same-attachment-id'),attachments});assert.equal(downloaded.length,0);
  for(const sender of ['test-admin','family-1'])await f.app.receive({...f.message(sender,sender,'same-attachment-id'),attachments});
  await waitFor(()=>f.replies.filter(x=>x.content.includes('本条用量')).length===2);
  const dirs=[f.dataDir,path.join(f.dataDir,'family-users',memberId)];
  for(const dir of dirs)assert.deepEqual(downloaded.filter(x=>x.dir===dir).map(x=>x.kind).sort(),['doc','image']);
  assert.equal(readImages.length,2);assert.ok(JSON.stringify(readImages[0]).includes(f.dataDir.replaceAll('\\','\\\\')));
  const family=f.calls.find(x=>x.input.text.includes('DOC-'+memberId));assert.ok(family);assert.ok(!family.input.text.includes('DOC-'+path.basename(f.dataDir)));
  assert.equal(f.app.state().usage.today.totalTokens,20);assert.equal(f.app.state().family.usageByMember[0].today.totalTokens,20);
  await f.app.uploadDocuments({requestId:'12345678-1234-1234-1234-123456789012',text:'web',files:[{name:'test.txt',base64:Buffer.from('test').toString('base64')}]});
  await waitFor(()=>f.calls.length===3);
  assert.equal(downloaded.find(x=>x.kind==='local').dir,f.dataDir);
  await f.send('family-1','/today');assert.doesNotMatch(f.replies.at(-1).content,/WEB-ADMIN-ONLY/);
  const before=f.calls.length;await f.send('family-1','加入 malformed-secret');assert.equal(f.calls.length,before);
  await f.app.receive({...f.message('family-1',''),messageType:101});
  assert.match(f.replies.at(-1).content,/逐页截图/);assert.doesNotMatch(f.replies.at(-1).content,/请在服务器/);
});
