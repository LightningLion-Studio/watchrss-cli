// Optional fields on the existing capability response; no new service endpoint.
const MiB=1024*1024;
const DEFAULTS={enabled:true,maxFileBytes:64*MiB,maxTextBytes:96*MiB,maxPackageBytes:32*MiB};
function policy(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))value={};
 const out={...DEFAULTS,enabled:value.enabled!==false};
 for(const key of ['maxFileBytes','maxTextBytes','maxPackageBytes'])if(Number.isSafeInteger(value[key])&&value[key]>0&&value[key]<=512*MiB)out[key]=value[key];
 out.maxPackageBytes=Math.min(out.maxPackageBytes,DEFAULTS.maxPackageBytes);
 if(!out.enabled)return{enabled:false,maxFileBytes:8*MiB,maxTextBytes:12*MiB,maxPackageBytes:32*MiB};return out;
}
async function current(){const caps=await require('./sync').formatCapabilities();return policy(caps.streamImport);}
module.exports={DEFAULTS,policy,current};
