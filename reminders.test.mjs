import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createReminders} from './reminders.mjs';
import {formatActionBrief,sourceTimePassed} from './action-brief.mjs';
const start=Date.parse('2026-10-22T10:00:00+08:00');
const action=(title,deadline=null)=>({title,deadline,calendarStart:null,owner:null,location:null});
function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-reminders-'));
  t.after(()=>{assert.ok(dataDir.startsWith(os.tmpdir()+path.sep));fs.rmSync(dataDir,{recursive:true,force:true})});
  let clock=start;
  const create=()=>createReminders({dataDir,now:()=>clock});
  const schedule=(r,actions=[action('填写表格')],jobId='test')=>r.schedule({jobId,owner:'self',receivedAt:new Date(start).toISOString(),actions});
  return {create,schedule,dataDir,advance:n=>clock+=n};
}
test('missing time groups actions at receipt +3h, persists and does not send early or to strangers',async t=>{
  const f=fixture(t);let r=f.create();f.schedule(r,[action('填写表格'),action('准备材料')]);
  assert.equal(r.snapshot().length,1);assert.equal(r.snapshot()[0].dueAt,'2026-10-22T05:00:00.000Z');
  r=f.create();let sent=0;const send=async(owner,body)=>{assert.equal(owner,'self');assert.match(body,/填写表格/);sent++};
  await r.dispatch({owner:'self',connected:true,send});assert.equal(sent,0);
  f.advance(3*3600000);
  await r.dispatch({owner:'stranger',connected:true,send});await r.dispatch({owner:'self',connected:false,send});assert.equal(sent,0);
  await r.dispatch({owner:'self',connected:true,send});await r.dispatch({owner:'self',connected:true,send});assert.equal(sent,1);
  r=f.create();f.schedule(r);await r.dispatch({owner:'self',connected:true,send});assert.equal(sent,1);
  assert.equal(r.snapshot()[0].status,'sent');assert.ok(!('owner' in r.snapshot()[0]));
});
test('date-only uses fallback but exact source time is preserved; past exact times are skipped',t=>{
 const f=fixture(t),r=f.create();f.schedule(r,[action('日期','2026-10-25'),action('时刻','2026-10-23T09:00:00+08:00'),action('已过期','2026-10-21T09:00:00+08:00')]);
 assert.equal(r.snapshot().length,2);assert.equal(r.snapshot()[0].defaultTime,true);assert.equal(r.snapshot()[1].dueAt,'2026-10-23T01:00:00.000Z');
});
test('cancelled reminders stay cancelled on restart and commands cannot affect another owner',async t=>{
 const f=fixture(t);let r=f.create();f.schedule(r);assert.equal(r.cancel('stranger'),0);assert.equal(r.cancel('self'),1);
 r=f.create();f.schedule(r);f.advance(4*3600000);await r.dispatch({owner:'self',connected:true,send:()=>assert.fail('cancelled sent')});assert.equal(r.snapshot()[0].status,'cancelled');
});
test('expired source times are visibly marked and never become three-hour reminders',t=>{
 const f=fixture(t),r=f.create();const actions=[action('过期时刻','2026-10-22T09:59:00+08:00'),action('过期日期','2026-10-21')];
 f.schedule(r,actions);assert.equal(r.snapshot().length,0);
 const brief=formatActionBrief({actions,notes:[]},{now:start});
 assert.match(brief,/2026-10-22 09:59（时间已过）/);assert.match(brief,/2026-10-21（时间已过）/);assert.doesNotMatch(brief,/3小时/);
 assert.equal(sourceTimePassed('2026-10-22',start),false);
 assert.equal(sourceTimePassed('2026-10-22',Date.parse('2026-10-22T16:00:00Z')),true);
 assert.equal(sourceTimePassed('2026-10-22T03:00:00Z',start),false);
});
test('future exact source time is displayed, while missing clock time uses receipt +3h',t=>{
 const f=fixture(t),r=f.create(),actions=[action('开会','2026-10-22T12:00:00+08:00')];
 f.schedule(r,actions);const text=formatActionBrief({actions,notes:[]},{now:start,reminders:r.snapshot()});
 assert.match(text,/提醒：2026-10-22 12:00/);assert.doesNotMatch(text,/时间已过|3小时/);
 const r2=f.create();f.schedule(r2,[action('今日任务','2026-10-22')],'today');
 assert.equal(r2.forJob('today')[0].dueAt,'2026-10-22T05:00:00.000Z');
});
test('cancellation during a send prevents later queued items from being sent',async t=>{
 const f=fixture(t),r=f.create();f.schedule(r);f.schedule(r,[action('第二项')],'test2');f.advance(4*3600000);let n=0;
 await r.dispatch({owner:'self',connected:true,send:async()=>{n++;r.cancel('self')}});assert.equal(n,1);
});
test('API rejection is failed and network ambiguity is unknown, never recorded as delivered or retried',async t=>{
 for(const definite of [true,false]){
 const f=fixture(t),r=f.create();f.schedule(r);f.advance(4*3600000);let n=0;
 const send=async()=>{n++;throw Object.assign(new Error('private response'),definite?{status:403,code:123}:{})};
 await r.dispatch({owner:'self',connected:true,send});await r.dispatch({owner:'self',connected:true,send});assert.equal(n,1);
 assert.equal(r.snapshot()[0].status,definite?'failed':'unknown');assert.doesNotMatch(JSON.stringify(r.snapshot()),/private response/);
 }
});
test('interrupted sends become unknown on restart instead of being duplicated',t=>{
 const f=fixture(t),r=f.create();f.schedule(r);const file=path.join(f.dataDir,'reminders.json');const d=JSON.parse(fs.readFileSync(file));d.items[0].status='sending';fs.writeFileSync(file,JSON.stringify(d));assert.equal(f.create().snapshot()[0].status,'unknown');
});
test('brief starts with actionable conditional task, omits missing fields and keeps reminder distinct from deadline',t=>{
 const f=fixture(t),r=f.create(),a=action('查看博士名单；若没有自己，填写个人信息汇总表');f.schedule(r,[a]);
 const text=formatActionBrief({actions:[a,a],notes:[],questions:['是否在名单中？']},{reminders:r.snapshot()});
 assert.match(text,/^【要做】查看博士名单/);assert.match(text,/提醒：2026-10-22 13:00（默认收到后3小时，非截止时间）/);
 assert.doesNotMatch(text,/负责人|时间待确认|另有|日志|需确认/);assert.equal(text.match(/填写/g).length,1);
});
