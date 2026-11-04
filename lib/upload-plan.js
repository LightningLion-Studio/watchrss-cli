// Node-only durable encrypted uploads. Never persist bearer tokens or plaintext
// bodies, and never reuse a reservation across account/epoch/content generations.
const storage=require('./storage'),scope=require('./cloud-scope'),util=require('./util');
function indexPath(){return scope.path('upload-plans');}
function payloadPath(id,name){return scope.path('upload-plans').replace(/\.json$/,'')+'/'+id+'/'+name;}
function load(){return storage.readJSON(indexPath(),{});}
function discard(id){const plans=load();delete plans[id];storage.writeJSON(indexPath(),plans);storage.removeTree(payloadPath(id,'').replace(/\/$/,''));}
function complete(id){if(load()[id])discard(id);}
// Publish a durable plan only after its encrypted payloads and directory entries
// have reached the filesystem. Progress remains a hint and is never PUT proof.
async function syncFiles(names,check){const fs=require('node:fs/promises'),path=require('node:path'),dirs=new Set();
 for(const name of names){check();const file=storage.location(name),handle=await fs.open(file,'r');try{await handle.sync();}finally{await handle.close();}let dir=path.dirname(file);for(;;){dirs.add(dir);if(dir===storage.root)break;const parent=path.dirname(dir);if(parent===dir)throw Error('Invalid upload plan directory');dir=parent;}}
 for(const dir of [...dirs].sort((a,b)=>b.length-a.length)){check();const handle=await fs.open(dir,'r');try{await handle.sync();}finally{await handle.close();}}check();
}
async function stage(created,targets){const ctx=scope.contentCurrent(),id=created.manifest.snapshotId,key=created.manifest.keyVersion;const previous=load()[id];if(previous)return;
 // Ciphertext is durable before its tiny plan is published atomically.
 const initialIndex=storage.location(indexPath()),check=()=>{scope.check(ctx);if(storage.location(indexPath())!==initialIndex)throw Object.assign(Error('Upload storage scope changed'),{code:'cloud_session_changed'});},root=scope.path('upload-plans',ctx.userId).replace(/\.json$/,'')+'/'+id+'/',files=[root+'manifest'];
 await storage.writeBytesAsync(files[0],created.encryptedManifest,{check});
 for(const [hash,bytes]of Object.entries(created.newCiphertextChunks)){check();const name=root+hash;files.push(name);await storage.writeBytesAsync(name,bytes,{check});}
 await syncFiles(files,check);
 check();const plans=load();plans[id]={id,r48WriteV1:require('./cloud-overlay').marked(created.manifest),scope:ctx,libraryEpoch:scope.load(ctx.userId)?.libraryEpoch,sourceDeviceId:created.manifest.sourceDeviceId,keyVersion:key,deviceSequence:created.manifest.deviceSequence,targets,chunkHashes:require('./snapshot').allChunks(created.manifest).map(c=>c.ciphertextSha256),progress:{uploaded:0,totalBytes:targets.reduce((n,t)=>n+t.sizeBytes,0)}};const index=indexPath();storage.writeJSON(index,plans);await syncFiles([index],check);
}
function progress(id,value){const plans=load();if(!plans[id])return;plans[id].progress=value;storage.writeJSON(indexPath(),plans);if(process.env.WATCHRSS_PROGRESS==='1')process.stderr.write(JSON.stringify({event:'upload-progress',snapshotId:id,...value})+'\n');}
function status(){return Object.values(load()).map(({id,keyVersion,deviceSequence,progress})=>({snapshotId:id,keyVersion,deviceSequence,progress}));}
async function resume(){const plans=load();if(!Object.keys(plans).length)return{resumed:0};const sync=require('./sync');return sync.cloudExclusive(async()=>{const boot=await sync.bootstrap(),ctx=scope.contentCurrent();let resumed=0,discarded=0,pending=0,upgradeRequired=false;
 for(const plan of Object.values(plans)){
  if(plan.scope.id!==ctx.id||plan.scope.contentGeneration!==ctx.contentGeneration||plan.libraryEpoch!==boot.libraryEpoch||plan.keyVersion!==sync.currentKeyVersion(ctx.userId)||plan.sourceDeviceId!==require('./device').deviceId()){discard(plan.id);discarded++;continue;}
  const formatPin={app:require('../config').appVersionHeader,write:require('./cloud-overlay').localEnabled()};if(plan.formatUpgradePin&&plan.formatUpgradePin.app===formatPin.app&&plan.formatUpgradePin.write===formatPin.write){pending++;upgradeRequired=true;continue;}
  const heads=await sync.snapshotHeads();if(heads.some(h=>h.id===plan.id)){complete(plan.id);resumed++;continue;}if(heads.some(h=>h.sourceDeviceId===plan.sourceDeviceId&&h.deviceSequence>=plan.deviceSequence)){discard(plan.id);discarded++;continue;}
  try{if(plan.r48WriteV1)await require('./cloud-overlay').assertEnabled();const bytes=storage.readBytes(payloadPath(plan.id,'manifest'));if(!bytes)throw Object.assign(Error('Pending ciphertext not available'),{code:'upload_plan_incomplete'});
   await require('./reader-upload').uploadObjects(plan.targets,t=>t.kind==='manifest'?bytes:storage.readBytes(payloadPath(plan.id,t.sha256)),{assertActive:()=>scope.check(ctx),onProgress:p=>progress(plan.id,p)});
   if(plan.r48WriteV1)await require('./cloud-overlay').assertEnabled();
   await sync.completeSnapshot(plan.id,plan.chunkHashes,{r48WriteV1:!!plan.r48WriteV1});complete(plan.id);resumed++;
  }catch(e){if(e.code==='cloud_format_upgrade_required'){const current=load();if(current[plan.id]){current[plan.id].formatUpgradePin=formatPin;storage.writeJSON(indexPath(),current);}pending++;upgradeRequired=true;continue;}if(['cloud_format_write_disabled','r48_write_feature_disabled'].includes(e.code)){pending++;continue;}if(e.code==='upload_plan_incomplete'||e.status===404&&['upload_reservation_not_found','snapshot_not_found'].includes(e.code)||e.status===400&&e.code==='reservation_expired'){discard(plan.id);discarded++;continue;}throw e;}
 }
 return{resumed,discarded,pending,...(upgradeRequired?{upgradeRequired:true,code:'cloud_format_upgrade_required',retryable:false}:{})};});}
scope.setContentClearHandler(id=>{const p='state/cloud-v2/'+id+'/upload-plans';storage.deleteFile(p+'.json');storage.removeTree(p);});
module.exports={stage,progress,complete,status,resume};
