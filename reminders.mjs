import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {uniqueActions,readableTime,sourceTimePassed} from './action-brief.mjs';
const STATUSES=new Set(['pending','sending','sent','failed','unknown','cancelled']);
export function createReminders({dataDir,now=()=>Date.now()}) {
  const file=path.join(dataDir,'reminders.json');
  let items=[];
  if(fs.existsSync(file)) {
    const d=JSON.parse(fs.readFileSync(file,'utf8'));
    if(d.version!==1||!Array.isArray(d.items)||!d.items.every(x=>x&&typeof x.id==='string'&&typeof x.jobId==='string'&&typeof x.owner==='string'&&Array.isArray(x.titles)&&x.titles.every(t=>typeof t==='string')&&Number.isFinite(Date.parse(x.dueAt))&&STATUSES.has(x.status)))throw new Error('提醒记录损坏，请恢复备份。');
    items=d.items;
  }
  function save(){fs.writeFileSync(file+'.tmp',JSON.stringify({version:1,items},null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file)}
  // A crash after sending can leave delivery ambiguous. Never resend blindly.
  if(items.some(x=>x.status==='sending')){items=items.map(x=>x.status==='sending'?{...x,status:'unknown',error:'发送途中重启，送达状态待核对'}:x);save()}
  let busy=false;
  return {
    schedule({jobId,owner,receivedAt,actions}) {
      if(typeof owner!=='string'||!owner||!Number.isFinite(Date.parse(receivedAt)))throw new TypeError('Invalid reminder owner/time');
      const groups=new Map();
      for(const a of uniqueActions(actions)) {
        if([a.deadline,a.calendarStart].some(x=>sourceTimePassed(x,now())))continue;
        const exact=[a.deadline,a.calendarStart].filter(x=>typeof x==='string'&&x.includes('T')&&Number.isFinite(Date.parse(x))).map(Date.parse);
        const defaultTime=!exact.length;
        const due=defaultTime?Date.parse(receivedAt)+3*3600_000:Math.min(...exact);
        if(!defaultTime&&due<=now())continue;
        const dueAt=new Date(due).toISOString();
        const key=dueAt+'|'+defaultTime;
        const group=groups.get(key)??{dueAt,defaultTime,titles:[]};group.titles.push(a.title);groups.set(key,group);
      }
      for(const g of groups.values()) {
        const id=createHash('sha256').update(jobId+'|'+g.dueAt+'|'+g.defaultTime).digest('hex');
        if(!items.some(x=>x.id===id))items.push({...g,id,jobId,owner,status:'pending',createdAt:new Date(now()).toISOString()});
      }
      save();return items.filter(x=>x.jobId===jobId).map(x=>({...x}));
    },
    forJob(jobId){return items.filter(x=>x.jobId===jobId).map(x=>({...x}))},
    snapshot(){return items.map(({owner,...x})=>({...x}))},
    list(owner){
      const all=items.filter(x=>x.owner===owner&&['pending','failed','unknown'].includes(x.status)).sort((a,b)=>Date.parse(a.dueAt)-Date.parse(b.dueAt));
      if(!all.length)return '暂无待提醒事项。';
      return all.slice(0,10).map((x,i)=>`${i+1}. ${x.titles.join('；').slice(0,100)}\n${readableTime(x.dueAt)} · ${x.status==='pending'?'待提醒':x.status==='failed'?'未送达（平台或网络限制）':'送达状态待核对'}`).join('\n');
    },
    cancel(owner){let n=0;for(const x of items)if(x.owner===owner&&x.status==='pending'){x.status='cancelled';n++}if(n)save();return n},
    async dispatch({owner,connected,send}) {
      if(busy||!owner||!connected)return;
      busy=true;
      try{
        for(const x of items.filter(x=>x.owner===owner&&x.status==='pending'&&Date.parse(x.dueAt)<=now())){
          if(x.status!=='pending')continue;
          x.status='sending';save();
          try{
            const content='【该处理了】\n'+x.titles.map((t,i)=>`${i+1}. ${t}`).join('\n').slice(0,1200)+(x.defaultTime?'\n这是收到通知后3小时的处理提醒，不是原通知截止时间。':'');
            await send(owner,content);
            x.status='sent';x.sentAt=new Date(now()).toISOString();delete x.error;
          }catch(e){
            x.status=Number.isSafeInteger(e?.status)?'failed':'unknown';
            x.error=x.status==='failed'?'平台拒绝提醒，未自动重试':'发送结果不明，未自动重试';
            if(Number.isSafeInteger(e?.code))x.code=e.code;
          }
          save();
        }
      }finally{busy=false}
    },
  };
}
