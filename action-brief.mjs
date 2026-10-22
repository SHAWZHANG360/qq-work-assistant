// QQ presentation only: source analysis and evidence remain intact.
const plain = x => String(x ?? '').replace(/[\r\n\t]+/g, ' ').trim();
const clip = (s,n) => Array.from(plain(s)).length>n?Array.from(plain(s)).slice(0,n-1).join('')+'…':plain(s);
export function readableTime(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return value;
  if (!Number.isFinite(Date.parse(value))) return '';
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
export function uniqueActions(actions) {
  const seen=new Set();
  return actions.filter(a=>{
    const key=JSON.stringify([plain(a.title),a.owner,a.deadline,a.calendarStart,a.location]);
    if(seen.has(key))return false;seen.add(key);return true;
  });
}
export function sourceTimePassed(value,now=Date.now()) {
  if(typeof value!=='string')return false;
  // A date without a clock time expires only after that local calendar day.
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value<readableTime(new Date(now).toISOString()).slice(0,10);
  return Number.isFinite(Date.parse(value))&&Date.parse(value)<now;
}
export function formatActionBrief(value,{ownerName,maxChars=400,maxActions=3,reminders=[],now=Date.now()}={}) {
  if(!value||!Array.isArray(value.actions)||!Array.isArray(value.notes))throw new TypeError('Invalid analysis');
  const actions=uniqueActions(value.actions).map((a,i)=>({a,i,t:Math.min(...[a.deadline,a.calendarStart].filter(Boolean).map(x=>Date.parse(x.length===10?x+'T23:59:59+08:00':x)),Infinity)})).sort((a,b)=>a.t-b.t||a.i-b.i).map(x=>x.a);
  const selected=actions.slice(0,maxActions);
  const lines=[];
  if(!selected.length)lines.push(/未提取到可读正文|正文尚未读取/.test([value.summary,...value.notes].join(' '))?'【要做】请重新发送可读附件或复制正文；当前未提取到可读正文。':'【要做】暂无明确待办。');
  else {
    if(selected.length>1)lines.push('【要做】');
    selected.forEach((a,i)=>{
      const owner=a.owner&&a.owner!==ownerName?`${clip(a.owner,14)}：`:'';
      lines.push(`${selected.length===1?'【要做】':`${i+1}. `}${owner}${clip(a.title,85)}`);
      const time=[];
      if(a.deadline)time.push(`截止：${readableTime(a.deadline)}${sourceTimePassed(a.deadline,now)?'（时间已过）':''}`);
      if(a.calendarStart)time.push(`时间：${readableTime(a.calendarStart)}${sourceTimePassed(a.calendarStart,now)?'（时间已过）':''}`);
      if(a.location)time.push(`地点：${clip(a.location,30)}`);
      if(time.length)lines.push(time.join('；'));
    });
  }
  const pending=reminders.filter(x=>x.status==='pending').sort((a,b)=>Date.parse(a.dueAt)-Date.parse(b.dueAt));
  if(pending.length){
    const r=pending[0];
    lines.push(`提醒：${readableTime(r.dueAt)}${r.defaultTime?'（默认收到后3小时，非截止时间）':''}${pending.length>1?'起，按各项时间提醒':''}`);
  }
  if(value.notes.some(x=>/文件文字提取不完整|附件仅部分可读|文件提取不完整/.test(x)))lines.push('注意：附件未读全，请核对原件。');
  else if(value.notes.some(x=>/图片文字存在识别不确定/.test(x)))lines.push('注意：图片有模糊文字，请核对原图。');
  else if(value.notes.some(x=>/正文尚未读取/.test(x)))lines.push('注意：附件尚未读取。');
  // Questions, counts and log footers belong in the full dashboard, not the reply.
  let out=lines.join('\n');
  if(Array.from(out).length>maxChars) {
    if(selected.length>1)return formatActionBrief({...value,actions:actions.slice(0,selected.length-1)},{ownerName,maxChars,maxActions,reminders,now});
    out=Array.from(out).slice(0,maxChars-1).join('')+'…';
  }
  return out;
}
