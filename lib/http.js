'use strict';
function normalizeError(status,body){const code=typeof body?.error==='string'?body.error:'http_error',detail=body?.detail||body?.message||code;return Object.assign(Error(typeof detail==='string'?detail:`HTTP ${status}`),{status,code,detail:typeof detail==='string'?detail:undefined});}
function safeURL(value){const u=new URL(value);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw Object.assign(Error('后端和对象地址必须使用 HTTPS'),{code:'invalid_backend_url'});if(u.username||u.password)throw Error('URL 凭据不受支持');return u;}
// Only reads and exact-byte PUTs are transport-idempotent. Ambiguous POSTs
// return to the durable intent/upload-plan owner, rather than being replayed.
function retryDelay(attempt,retryAfter){
 const seconds=Number(retryAfter),date=Date.parse(retryAfter||'');
 const advised=retryAfter!==null&&retryAfter!==undefined&&Number.isFinite(seconds)?Math.max(0,seconds*1000):Number.isFinite(date)?Math.max(0,date-require('./clock').now()):0;
 // A longer server cooldown exceeds this call's budget and returns to caller;
 // never shorten Retry-After just to fit our 30s exponential backoff cap.
 return Math.max(advised,Math.min(30000,500*2**attempt+Math.floor(Math.random()*250)));
}
async function request({method='GET',path,body=null,bearer=null,extraHeaders={},useBaseUrl=true,responseType='text',contentType=null,timeout=60000,onTask}){
 const controller=new AbortController(),cancelled=()=>{if(controller.signal.aborted)throw Object.assign(Error('同步已取消'),{code:'cloud_operation_cancelled'});};
 onTask?.({abort:()=>controller.abort()});
 const config=require('../config'),base=safeURL(config.backendBaseUrl);
 if(useBaseUrl&&(!path.startsWith('/')||path.startsWith('//')))throw Error('Invalid backend route');
 const url=useBaseUrl?safeURL(base.toString().replace(/\/$/,'')+path):safeURL(path);
 const headers=useBaseUrl?{accept:'application/json',apikey:config.supabaseAnonKey,'x-watchrss-app-version':config.appVersionHeader,...extraHeaders}:{};
 require('./cloud-write').assertEpoch({method,path,useBaseUrl},headers);
 if(bearer&&useBaseUrl)headers.authorization=`Bearer ${bearer}`;
 const binary=body instanceof ArrayBuffer||ArrayBuffer.isView(body);
 if(body!==null)headers['content-type']=contentType||(binary?'application/octet-stream':'application/json');
 const scope=require('./cloud-scope'),current=require('./account').getUsableSession();
 const retryContext=!useBaseUrl&&current?scope.contentCurrent():current?.accessToken===bearer?(scope.contentWrite({method,path})?scope.contentCurrent():scope.current()):null;
 const canRetry=['GET','HEAD','PUT'].includes(method)||(method==='POST'&&path==='/functions/v1/cloud/bootstrap'),started=performance.now(),encoded=body===null?undefined:binary?body:JSON.stringify(body);
 for(let attempt=0;;attempt++){
  let res;
  try{
   cancelled();
   if(retryContext)scope.check(retryContext);
   res=await fetch(url,{method,headers,body:encoded,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(Math.max(1,Math.ceil(timeout-(performance.now()-started))))])});
   if(useBaseUrl&&res.ok)require('./clock').observe(res.headers.get('date'));
   if(!res.ok){let data;try{data=await res.json();}catch{}const e=normalizeError(res.status,data);if(useBaseUrl&&path==='/functions/v1/cloud/sync/exchange')e.exchange=data;e.requestId=res.headers.get('x-request-id');e.retryAfterMs=retryDelay(attempt,res.headers.get('retry-after'));throw e;}
   const data=responseType==='arraybuffer'?await res.arrayBuffer():res.status===204?null:await res.json();if(retryContext)scope.check(retryContext);return{status:res.status,data,headers:res.headers};
  }catch(error){
   cancelled();
   const e=typeof error.code==='string'?error:Object.assign(Error(error.message),{code:'network_error',status:0,cause:error,transportCode:error.cause?.code});
   const transient=e.code==='network_error'||e.status===429||e.status>=500,delay=e.retryAfterMs||retryDelay(attempt,null);
   e.retryAfterMs=delay;
   if(!canRetry||!transient||attempt>=2||performance.now()-started+delay>=timeout)throw e;
   // Recheck identity/generation before replaying any authenticated mutation.
   await require('node:timers/promises').setTimeout(delay,undefined,{signal:controller.signal}).catch(error=>{cancelled();throw error;});
   if(retryContext)scope.check(retryContext);
  }
 }
}
async function putObject(upload,bytes,{timeout=300000}={}){
 if(!upload||upload.transport!=='epoch-proxy')throw Object.assign(Error('上传协议不受支持'),{code:'cloud_upload_transport_required'});
 if(typeof upload.reservationId!=='string'||!upload.reservationId||upload.reservationId.length>128)throw Object.assign(Error('上传预留无效'),{code:'upload_reservation_invalid'});
 if(upload.contentScope)require('./cloud-scope').check(upload.contentScope);
 if(upload.alreadyUploaded===true){if(!upload.contentScope)throw Object.assign(Error('上传证明已过期'),{code:'upload_reservation_invalid'});return{status:200,reused:true};}
 return require('./appaccess').request({method:'PUT',path:'/functions/v1/cloud/uploads/'+encodeURIComponent(upload.reservationId),body:bytes,contentType:'application/octet-stream',timeout,...(upload.r48WriteV1?{extraHeaders:{'x-watchrss-r48-write-v1':'1'}}:{})});
}
module.exports={request,putObject,normalizeError,retryDelay,download:(path,{timeout=120000}={})=>request({path,useBaseUrl:false,responseType:'arraybuffer',timeout})};
