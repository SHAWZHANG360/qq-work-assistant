import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';

export const validSender = x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(x) && !['.','..'].includes(x);
const hash = x => createHash('sha256').update(x).digest('hex');
const validLabel = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 24 && !/[\x00-\x1f\x7f]/.test(x);
const profileKeys = ['name','college','department'];
const emptyProfile = () => ({name:'',college:'',department:''});
function validProfile(p) {return p && Object.keys(p).length === 3 && profileKeys.every(k => typeof p[k] === 'string' && p[k].length <= 80 && !/[\x00-\x1f\x7f]/.test(p[k]));}
function atomic(file, value) {
  const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  let fd;
  try {fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);}
  finally {if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

export function createFamilyMembers({dataDir, adminId, now=()=>Date.now()}) {
  if(!validSender(adminId))throw new Error('管理员身份无效。');
  const file=path.join(dataDir,'family-members.json'), marker=path.join(dataDir,'family-enabled.json');
  const usersDir=path.join(dataDir,'family-users');
  let state;
  if(fs.existsSync(file)) state=JSON.parse(fs.readFileSync(file,'utf8'));
  else {
    if(fs.existsSync(marker)||fs.existsSync(usersDir))throw new Error('家庭成员登记丢失，禁止重建，请恢复备份。');
    state={version:1,adminHash:hash(adminId),maxFamily:3,members:[],invites:[],receipts:[]};
    atomic(file,state);
  }
  const validMember=m=>m && /^[a-f0-9]{8}$/.test(m.id) && validSender(m.senderId) && m.senderId!==adminId && validLabel(m.label) && ['pending','active','revoked'].includes(m.status) && validProfile(m.profile);
  if(state.version!==1||state.adminHash!==hash(adminId)||state.maxFamily!==3||!Array.isArray(state.members)||!state.members.every(validMember)||new Set(state.members.map(m=>m.id)).size!==state.members.length||new Set(state.members.map(m=>m.senderId)).size!==state.members.length||state.members.filter(m=>m.status!=='revoked').length>3||!Array.isArray(state.invites)||state.invites.length>3||!state.invites.every(i=>i && /^[a-f0-9]{64}$/.test(i.hash)&&validLabel(i.label)&&Number.isFinite(i.expiresAt))||!Array.isArray(state.receipts)||state.receipts.length>2000||!state.receipts.every(x=>/^[a-f0-9]{64}$/.test(x)))throw new Error('家庭成员登记损坏，已拒绝开放访问。');
  if(state.members.filter(m=>m.status!=='revoked').length+state.invites.filter(i=>i.expiresAt>now()).length>3)throw new Error('家庭成员名额登记损坏，已拒绝开放访问。');
  if(!fs.existsSync(marker))atomic(marker,{version:1,enabled:true});
  const safe=m=>m?structuredClone(m):null;
  function transaction(eventId, change) {
    const key=hash(eventId);if(state.receipts.includes(key))return {duplicate:true};
    const next=structuredClone(state);next.invites=next.invites.filter(i=>i.expiresAt>now());
    const result=change(next);
    next.receipts=[...next.receipts,key].slice(-2000);atomic(file,next);state=next;return result;
  }
  const used=s=>s.members.filter(m=>m.status!=='revoked').length+s.invites.length;
  return {
    get:sender=>safe(state.members.find(m=>m.senderId===sender)),
    byId:id=>safe(state.members.find(m=>m.id===id)),
    active:()=>state.members.filter(m=>m.status==='active').map(safe),
    summary:()=>({maxFamily:3,members:state.members.map(({id,label,status})=>({id,label,status})),pendingInvites:state.invites.filter(i=>i.expiresAt>now()).length}),
    invite(eventId,label) {
      if(!validLabel(label))return {error:'请输入 1–24 字的家人称呼，例如 /invite 家人一。'};
      return transaction(eventId,s=>{
        if(used(s)>=3)return {error:'最多 3 位家人；待确认申请和有效邀请也占名额。可用 /family 查看，/revoke 编号 停用，/cancel-invites 撤销未使用邀请。'};
        const code=randomBytes(18).toString('base64url');s.invites.push({hash:hash(code),label:label.trim(),expiresAt:now()+15*60_000});return {code};
      });
    },
    cancelInvites:eventId=>transaction(eventId,s=>{const count=s.invites.length;s.invites=[];return {count};}),
    join(eventId,sender,code) {
      if(!validSender(sender)||sender===adminId||typeof code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(code))return {invalid:true};
      if(!state.members.some(m=>m.senderId===sender&&m.status!=='revoked')&&!state.invites.some(i=>i.hash===hash(code)&&i.expiresAt>now()))return {invalid:true};
      return transaction(eventId,s=>{
        const member=s.members.find(m=>m.senderId===sender);
        if(member && member.status!=='revoked')return {member:safe(member)};
        const index=s.invites.findIndex(i=>i.hash===hash(code));
        if(index<0)return {invalid:true};
        const invite=s.invites.splice(index,1)[0];
        if(s.members.filter(m=>m.status!=='revoked').length>=3)return {invalid:true};
        // Revoked identities are retained as tombstones; their old data is never reassigned.
        if(member)return {error:'此账号已停用，请联系管理员；本版不自动重新启用旧身份。'};
        const record={id:randomBytes(4).toString('hex'),senderId:sender,label:invite.label,status:'pending',profile:emptyProfile(),requestedAt:new Date(now()).toISOString()};
        while(s.members.some(m=>m.id===record.id))record.id=randomBytes(4).toString('hex');
        s.members.push(record);return {member:safe(record)};
      });
    },
    approve:(eventId,id)=>transaction(eventId,s=>{
      const m=s.members.find(m=>m.id===id);
      if(!m||m.status==='revoked')return {error:'没有这个待确认申请；请先发送 /family。'};
      if(m.status==='active')return {member:safe(m)};
      m.status='active';m.approvedAt=new Date(now()).toISOString();return {member:safe(m)};
    }),
    revoke:(eventId,id)=>transaction(eventId,s=>{
      const m=s.members.find(m=>m.id===id);if(!m)return {error:'没有这个家人编号。'};
      m.status='revoked';m.revokedAt=new Date(now()).toISOString();return {member:safe(m)};
    }),
    profile:(eventId,sender,p)=>{
      if(!validProfile(p))return {error:'格式：/profile 姓名|单位|部门；每项最多 80 字，留空填 -。'};
      return transaction(eventId,s=>{const m=s.members.find(m=>m.senderId===sender&&m.status==='active');if(!m)return {error:'尚未获准使用。'};m.profile=p;return {member:safe(m)};});
    },
    directory(member) {
      const stored=state.members.find(m=>m.id===member.id&&m.senderId===member.senderId);
      if(!stored||stored.status!=='active')throw new Error('成员未启用。');
      if(fs.existsSync(usersDir)&&fs.lstatSync(usersDir).isSymbolicLink())throw new Error('成员目录不可为符号链接。');
      fs.mkdirSync(usersDir,{recursive:true,mode:0o700});
      const dir=path.join(usersDir,stored.id);
      if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())throw new Error('成员目录不可为符号链接。');
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
      const ownerFile=path.join(dir,'owner.json');
      if(fs.existsSync(ownerFile)) {if(JSON.parse(fs.readFileSync(ownerFile,'utf8')).openid!==stored.senderId)throw new Error('成员数据与身份不匹配。');}
      else {
        if(fs.readdirSync(dir).length)throw new Error('成员身份文件丢失，禁止覆盖旧数据。');
        atomic(ownerFile,{openid:stored.senderId,pairedAt:stored.approvedAt});
      }
      return dir;
    },
  };
}
