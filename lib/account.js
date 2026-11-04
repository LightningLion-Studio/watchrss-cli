const storage=require('./storage'),http=require('./http'),{createHash}=require('node:crypto');
function loadSession(){return storage.readJSON('session.json',null);}
function getUsableSession(){const s=loadSession();return s && s.expiresAt>require('./clock').now()?s:null;}
function saveSession(s){if(!s.userId || !s.accessToken)throw new Error('登录响应无效');const normalized={...s,expiresAt:Number(s.expiresAt)||require('./clock').now()+Number(s.expiresIn)*1000};storage.writeJSON('session.json',normalized);return normalized;}
function owner(s){return createHash('sha256').update(require('../config').backendBaseUrl+':'+s.userId+':'+s.accessToken).digest('hex');}
function invalidateSession(error,s){
 const current=loadSession();
 if(error.status===401&&['invalid_session','mfa_login_required'].includes(error.code)&&current?.accessToken===s.accessToken){
  for(const path of ['session.json','cli-access.json','membership-cache.json'])storage.deleteFile(path);
 }
}
async function refreshProfile(){
 const s=getUsableSession();if(!s)throw Object.assign(Error('请运行 watchrss --login'),{code:'login_required'});
 let data;try{data=(await http.request({path:'/functions/v1/account/profile',bearer:s.accessToken})).data;}
 catch(error){invalidateSession(error,s);throw error;}
 const current=getUsableSession();
 if(!current||current.userId!==s.userId||current.accessToken!==s.accessToken)throw Object.assign(Error('账号已切换，请重新操作'),{code:'account_changed'});
 if(data?.userId!==s.userId||typeof data.phoneMasked!=='string'||!data.phoneMasked.includes('*'))throw Object.assign(Error('账号信息响应无效'),{code:'invalid_account_profile'});
 // Keep every token, expiry and local owner marker; only refresh the label.
 return saveSession({...current,phoneMasked:data.phoneMasked,pendingPhoneChange:phoneNotice(data.pendingPhoneChange)});
}
function phoneNotice(p){
 if(p==null)return null;if(typeof p.appealId!=='string'||!['cooling','ready'].includes(p.status)||!Number.isFinite(p.effectiveAt)||typeof p.phoneMasked!=='string'||!p.phoneMasked.includes('*'))throw Object.assign(Error('账号安全提示无效'),{code:'invalid_account_profile'});
 const d=new Date(p.effectiveAt),label=`${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日`;
 return{appealId:p.appealId,status:p.status,effectiveAt:p.effectiveAt,phoneMasked:p.phoneMasked,cancellable:p.cancellable===true,message:`手机号将于${label}变更，如非本人操作请联系支持`};
}
async function cancelPhoneAppeal(id){
 if(!/^[A-Za-z0-9-]{1,128}$/.test(id))throw Error('换绑请求无效');const expected=getUsableSession();if(!expected)throw Object.assign(Error('请先登录'),{code:'login_required'});
 const r=await http.request({method:'POST',path:'/functions/v1/account/phone/appeals/'+id+'/cancel',body:{},bearer:expected.accessToken});
 const current=getUsableSession();if(!current||current.userId!==expected.userId||current.accessToken!==expected.accessToken)throw Object.assign(Error('账号已切换'),{code:'account_changed'});
 if(r.data?.status!=='cancelled')throw Error('取消结果尚未确认，请刷新核对');return refreshProfile();
}
async function entitlement({offline=false,preferCached=false}={}){
 const s=getUsableSession();if(!s)throw Object.assign(new Error('请运行 watchrss --login'),{code:'login_required'});
 if(offline||preferCached){
  const cached=storage.readJSON('membership-cache.json',null);
  if(cached && cached.owner===owner(s) && cached.validUntil>require('./clock').now())return cached.member;
  if(offline)throw Object.assign(new Error('会员本地凭据已过期，请联网验证'),{code:'membership_check_required'});
 }
 let member;
 try{member=(await http.request({path:'/functions/v1/account/entitlement',bearer:s.accessToken})).data;}
 catch(error){if([401,402,403].includes(error.status))storage.deleteFile('membership-cache.json');invalidateSession(error,s);throw error;}
 const expires=member.expiresAt?Date.parse(member.expiresAt):Infinity;
 if(!member.active || !member.readable || !member.writable || (!Number.isFinite(expires)&&expires!==Infinity)){storage.deleteFile('membership-cache.json');return member;}
 storage.writeJSON('membership-cache.json',{owner:owner(s),member,validUntil:Math.min(require('./clock').now()+24*3600000,s.expiresAt,expires)});
 return member;
}
async function requireMember(write=false,options={}){const m=await entitlement(options);if(!m.active || !m.readable || !m.writable)throw Object.assign(new Error('需要有效的云同步会员'),{code:'cloud_membership_required'});return m;}
module.exports={loadSession,getUsableSession,saveSession,entitlement,requireMember,refreshProfile,cancelPhoneAppeal,phoneNotice};
