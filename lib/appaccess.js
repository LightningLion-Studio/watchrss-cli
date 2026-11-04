const account=require('./account'),http=require('./http'),device=require('./device'),crypto=require('./crypto'),storage=require('./storage');
async function issueDeviceAccess(){
 const s=account.getUsableSession();if(!s)throw Object.assign(new Error('请运行 watchrss --login'),{code:'login_required'});
 const backend=require('../config').backendBaseUrl;
 const sessionHash=crypto.sha256Hex(s.accessToken),cached=storage.readJSON('cli-access.json',null);
 if(cached && cached.backend===backend && cached.userId===s.userId && cached.sessionHash===sessionHash && cached.expiresAt>require('./clock').now()+30000)return cached;
 await crypto.initializeRandom();
 const licenseDeviceId=device.deviceId(),devicePublicKey=device.publicKeyPem();
 const c=(await http.request({method:'POST',path:'/functions/v1/account/phone-authorizations/challenge',bearer:s.accessToken,body:{purpose:'claim',licenseDeviceId}})).data;
 const requestHash=crypto.sha256LengthPrefixedHex(['cli-access',licenseDeviceId,devicePublicKey,sessionHash]);
 const possession=device.possessionProof('claim',c.challengeId,c.nonce,requestHash);
 const data=(await http.request({method:'POST',path:'/functions/v1/account/cli/access',bearer:s.accessToken,body:{licenseDeviceId,devicePublicKey,possession}})).data;
 if(!data.cliAccessToken?.startsWith('wrc_') || !(data.expiresAt>require('./clock').now()))throw new Error('CLI 凭证响应无效');
 const current=account.getUsableSession();if(!current||current.userId!==s.userId||current.accessToken!==s.accessToken)throw Object.assign(Error('登录会话已变更'),{code:'cloud_session_changed'});
 const saved={...data,backend,sessionHash,userId:s.userId};storage.writeJSON('cli-access.json',saved);return saved;
}
const issuing=new Map();
function ensureDeviceAccess(){
 const s=account.getUsableSession();if(!s)return Promise.reject(Object.assign(Error('请先登录'),{code:'login_required'}));
 const id=[require('../config').backendBaseUrl,s.userId,crypto.sha256Hex(s.accessToken)].join(':');if(issuing.has(id))return issuing.get(id);
 let task;task=issueDeviceAccess().finally(()=>{if(issuing.get(id)===task)issuing.delete(id);});issuing.set(id,task);return task;
}
async function request(options){
 const s=account.getUsableSession();if(!s)throw Object.assign(new Error('请先登录'),{code:'login_required'});
 const scope=require('./cloud-scope'),ctx=scope.current(),mutation=require('./cloud-write').epochWrite(options),contentWrite=scope.contentWrite(options);let contentHeaders={};
 if((mutation&&!scope.load(s.userId))||(contentWrite&&!scope.content(s.userId)))await require('./sync').bootstrap();
 scope.check(ctx);const epoch=mutation?scope.load(s.userId)?.libraryEpoch:null;
 if(mutation)contentHeaders={...scope.headers(s.userId),'x-watchrss-cloud-device-id':options.extraHeaders?.['x-watchrss-cloud-device-id']||device.deviceId(),...(contentWrite?scope.contentHeaders(s.userId):{})};
 for(let i=0;i<2;i++){
  const auth=await ensureDeviceAccess();
  scope.check(ctx);if(epoch&&scope.load(s.userId)?.libraryEpoch!==epoch)throw Object.assign(Error('资料库已重置，请重新恢复'),{code:'NEEDS_RECOVERY'});try{const response=await http.request({...options,bearer:s.accessToken,extraHeaders:{...options.extraHeaders,...contentHeaders,'x-watchrss-cli-authorization':`Bearer ${auth.cliAccessToken}`} });scope.check(ctx);return response;}
  catch(e){if(i || !['cli_access_invalid','cli_access_expired'].includes(e.code))throw e;const cached=storage.readJSON('cli-access.json',null);if(cached?.cliAccessToken===auth.cliAccessToken)storage.deleteFile('cli-access.json');}
 }
}
module.exports={request,ensureDeviceAccess};
