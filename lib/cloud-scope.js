// The only persistent cloud trust root is scoped by backend URL and user ID.
const storage=require('./storage'),crypto=require('./crypto'),config=require('../config');
const lifecycles=new Map();let cachedBackend='',cachedBackendId='';
function backendId(){const value=backend();if(cachedBackend!==value){cachedBackend=value;cachedBackendId=crypto.sha256Hex(value).slice(0,32);}return cachedBackendId;}
function lifecycle(userId){const id=storage.root+':'+backendId()+'/'+userId;return lifecycles.get(id)||0;}
function backend(){return String(config.backendBaseUrl).replace(/\/+$/,'');}
function scope(userId){if(!userId||!/^[a-zA-Z0-9_-]{1,128}$/.test(userId))throw Object.assign(Error('账号身份无效'),{code:'cloud_scope_invalid'});return{userId,userDataPath:storage.root,lifecycle:lifecycle(userId),backendBaseUrl:backend(),id:backendId()+'/'+userId};}
function current(){const session=require('./account').getUsableSession();if(!session)throw Object.assign(Error('登录已过期，请重新登录'),{code:'invalid_session'});return scope(session.userId);}
function contentCurrent(){const ctx=current();const value=content(ctx.userId);return {...ctx,contentGeneration:value?.contentGeneration,cacheRevision:value?.cacheRevision};}
function path(kind,userId){const ctx=userId?scope(userId):current();return `state/cloud-v2/${ctx.id}/${kind}.json`;}
function keys(userId){const ctx=scope(userId);return `keys/${userId}/${ctx.id.split('/')[0]}`;}
const invalidated=new Set();
function volatileId(userId){return storage.root+':'+scope(userId||current().userId).id;}
function load(userId){const data=storage.readJSONCached(path('trust',userId),null);return data&&invalidated.has(volatileId(userId))?{...data,needsRecovery:true,requireApproval:true}:data;}
function check(ctx){const now=current();if(now.id!==ctx.id||ctx.userDataPath!==undefined&&now.userDataPath!==ctx.userDataPath)throw Object.assign(Error('账号或服务已变更，请重新操作'),{code:'cloud_session_changed'});if(ctx.lifecycle!==undefined&&now.lifecycle!==ctx.lifecycle)throw Object.assign(Error('操作已暂停，返回后将重新连接'),{code:'cloud_operation_cancelled'});if(ctx.contentGeneration!==undefined&&ctx.contentGeneration!==content(now.userId)?.contentGeneration)throw rebuildError();if(ctx.cacheRevision!==undefined&&ctx.cacheRevision!==content(now.userId)?.cacheRevision)throw rebuildError();}
function clear(userId,reason='NEEDS_RECOVERY'){
 const old=load(userId);invalidated.add(volatileId(userId));for(const callback of clearHandlers)callback(scope(userId).id);
 // R20: trust invalidation must preserve the still-registered device identity.
 for(const name of storage.listDir(keys(userId)))if(!name.startsWith('deviceKey_'))storage.deleteFile(keys(userId)+'/'+name);
 storage.removeTree('cloud/'+scope(userId).id);
 for(const name of ['sync','library','records','operations','quarantine','latest-manifest','storage-upgrade','before-restore','saved-body-retries','records-checkpoint','exchange','r48-overlay','format-write-pause'])storage.deleteFile(path(name,userId));
 if(old)storage.writeJSON(path('trust',userId),{...old,needsRecovery:true,reason});
}

const clearHandlers=new Set();function setClearHandler(callback){clearHandlers.add(callback);}
function observe(userId,data){
 if(!data||typeof data.libraryEpoch!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(data.libraryEpoch))throw Object.assign(Error('请更新云服务与客户端'),{code:'client_upgrade_required',status:426});
 let rows;try{rows=require('./cloud-v2').commitments(data.keyCommitments,data.keyVersionFloor);}catch(_){clear(userId,'cloud_key_commitment_mismatch');throw Object.assign(Error('云密钥验证失败，请重新恢复或批准'),{code:'NEEDS_RECOVERY'});}
 const old=load(userId),changed=!!(old&&old.libraryEpoch!==data.libraryEpoch);
 if(changed)clear(userId,'library_epoch_mismatch');
 // A server cannot silently rewrite a previously observed immutable commitment.
 if(old&&!changed)for(const row of old.keyCommitments||[]){const next=rows.find(item=>item.keyVersion===row.keyVersion);if(!next||next.commitment!==row.commitment||next.rotationProof!==row.rotationProof){clear(userId,'cloud_key_commitment_mismatch');throw Object.assign(Error('云密钥验证失败，请重新恢复或批准'),{code:'NEEDS_RECOVERY'});}}
 const trust={libraryEpoch:data.libraryEpoch,keyVersionFloor:data.keyVersionFloor,keyCommitments:rows,needsRecovery:changed||!!(old&&old.needsRecovery),requireApproval:changed||!!(old&&old.requireApproval)};
 if(JSON.stringify(old)!==JSON.stringify(trust))storage.writeJSON(path('trust',userId),trust);const contentChanged=data.contentGeneration!==undefined?observeContent(userId,data).changed:false;return{...trust,changed,contentChanged};
}
function headers(userId){const trust=load(userId);if(!trust)throw Object.assign(Error('请先读取云资料库'),{code:'cloud_bootstrap_required'});return{'x-watchrss-library-epoch':trust.libraryEpoch};}
function suspend(userId){const id=volatileId(userId);lifecycles.set(id,(lifecycles.get(id)||0)+1);}
function requireApproval(userId){const trust=load(userId);storage.writeJSON(path('trust',userId),{...trust,requireApproval:true});}
function recovered(userId){const trust=load(userId);storage.writeJSON(path('trust',userId),{...trust,needsRecovery:false,requireApproval:false});invalidated.delete(volatileId(userId));}
// Content reset deliberately has no path to trust clearHandlers or key storage.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,contentHandlers=new Set();
function rebuildError(){return Object.assign(Error('云同步内容已清空，正在从本机重建'),{code:'cloud_content_rebuild_required',status:409});}
function content(userId){return storage.readJSONCached(path('content',userId),null);}
function clearContent(userId){
 const previous=storage.readJSON(path('sync',userId),null);
 for(const name of ['sync','library','records','quarantine','latest-manifest','saved-body-retries','book-abandoned','reservations','pending-upload','uploaded-fingerprints','records-checkpoint','exchange','r48-overlay','format-write-pause'])storage.deleteFile(path(name,userId));
 storage.writeJSON(path('sync',userId),{deviceSequence:previous?.deviceSequence||0,retentionDays:previous?.retentionDays||30});
 storage.removeTree('cloud/'+scope(userId).id);storage.removeTree('cloud/chunks'); // legacy ciphertext cache only, never local originals
 for(const callback of contentHandlers)callback(scope(userId).id);
 require('./library').markDirty();
}
function observeContent(userId,data){
 if(!data||!UUID.test(data.contentGeneration)||typeof data.contentEmpty!=='boolean'||!(data.contentClearedAt===null||typeof data.contentClearedAt==='string'))throw Object.assign(Error('请更新云服务与客户端'),{code:'client_upgrade_required',status:426});
 const prior=content(userId),changed=!!(prior&&prior.contentGeneration!==data.contentGeneration),reset=changed||data.contentEmpty&&(!prior||!prior.emptyHandled);
 const next={...prior,cacheRevision:(prior?.cacheRevision||0)+(reset?1:0),contentGeneration:data.contentGeneration,contentClearedAt:data.contentClearedAt,contentEmpty:data.contentEmpty,emptyHandled:data.contentEmpty||(!changed&&prior?.emptyHandled)||false,rebuildRequired:reset||!!prior?.rebuildRequired};
 // Reset remains repeatable after a failed cleanup or process death.
 if(reset)clearContent(userId);if(JSON.stringify(prior)!==JSON.stringify(next))storage.writeJSON(path('content',userId),next);return{...next,changed:reset};
}
function forceContentRebuild(userId){clearContent(userId);const value=content(userId);storage.writeJSON(path('content',userId),{...value,cacheRevision:(value?.cacheRevision||0)+1,rebuildRequired:true});}
function finishContentRebuild(userId,generation){const value=content(userId);if(value?.contentGeneration!==generation)throw rebuildError();storage.writeJSON(path('content',userId),{...value,rebuildRequired:false});}
function contentHeaders(userId){const value=content(userId);if(!value||!UUID.test(value.contentGeneration))throw Object.assign(Error('请先读取新版云同步信息'),{code:'client_upgrade_required',status:426});return{'x-watchrss-content-generation':value.contentGeneration};}
function contentRoute(route){return /^\/functions\/v1\/cloud\/(?:sync\/exchange(?:[?]|$)|records(?:[/?]|$)|snapshots(?:[/?]|$)|uploads(?:[/?]|$)|chunks\/missing(?:[?]|$)|reader-migrations(?:[/?]|$))/.test(route);}
function contentWrite({method='GET',path:route}){return !['GET','HEAD'].includes(method)&&contentRoute(route);}
function setContentClearHandler(callback){contentHandlers.add(callback);}
module.exports={contentCurrent,contentRoute,content,observeContent,clearContent,forceContentRebuild,finishContentRebuild,contentHeaders,contentWrite,rebuildError,setContentClearHandler,backend,scope,current,path,keys,load,clear,observe,headers,recovered,requireApproval,suspend,lifecycle,check,setClearHandler};
