// The mini-program operates on cloud indices. Cached metadata is a projection,
// never a reason to upload a legacy whole-body relay library on a UI action.
const account=require('./account');
const library=require('./library');
const storage=require('./storage');
const sync=require('./sync');
const snapshot=require('./snapshot');
const payload=require('./payload');
const device=require('./device');
const util=require('./util');
const records=require('./cloud-records');
const exchangeClient=require('./cloud-exchange');
let exchangeScheduler=null,exchangeScheduleOwner=null;
const rss=require('./rss');
const storageUpgrade=require('./cloud-storage-upgrade');
function opsPath(){const session=account.getUsableSession();return sync.scopedStatePath('operations',session.userId);}
let operationsPath=null;
let operations=null,sequence=Date.now(),running=null,visible=false,poll=null,retry=null,lastRead=0,lastOwner=null;
let lastContexts=[],lastHeadsSignature=null,lastFullRead=0,retryAttempt=0,accessPause=null;
let sessionGeneration=0,runningScope=null;
const formatPauses=new Map();
function formatIdentity(userId){return{app:require('../config').appVersionHeader||'unknown',write:require('./cloud-overlay').localEnabled(),generation:require('./cloud-scope').content?.(userId)?.contentGeneration||null};}
function formatPaused(userId){const path=sync.scopedStatePath('format-write-pause',userId),value=formatPauses.get(path)||storage.readJSON(path,null);if(!value)return false;formatPauses.set(path,value);const now=formatIdentity(userId);return value.app===now.app&&value.write===now.write&&value.generation===now.generation;}
function pauseFormat(userId){const path=sync.scopedStatePath('format-write-pause',userId),value=formatIdentity(userId),previous=formatPauses.get(path);formatPauses.set(path,value);if(JSON.stringify(previous)!==JSON.stringify(value))try{storage.writeJSON(path,value);}catch(_){}clearTimeout(retry);retry=null;emit('upgrade_required','请升级到最新版本以继续同步',false,{code:'cloud_format_upgrade_required',upgradeRequired:true,editPending:true,retryable:false});}
function isCurrent(scope){const s=account.getUsableSession();return s && scope && scope.generation===sessionGeneration && (scope.lifecycle===undefined||scope.lifecycle===sync.cloudLifecycle()) && s.userId===scope.userId && (!scope.backendBaseUrl||scope.backendBaseUrl===require('./cloud-scope').backend());}
function assertCurrent(scope){if(!isCurrent(scope)){const now=account.getUsableSession();if(!now)throw Object.assign(Error('登录已过期，请重新登录'),{code:'invalid_session'});const same=now&&scope&&now.userId===scope.userId&&(!scope.backendBaseUrl||scope.backendBaseUrl===require('./cloud-scope').backend());throw Object.assign(Error(same?'同步已暂停，返回后将重新连接':'账号已切换，请重新登录'),{code:same?'cloud_operation_cancelled':'cloud_session_changed'});}if(scope.contentGeneration!==undefined&&scope.contentGeneration!==require('./cloud-scope').content(scope.userId)?.contentGeneration)throw require('./cloud-scope').rebuildError();}
const ACCESS_RECHECK_MS=5*60*1000;
function denied(error){return error && (error.status===403 || ['cloud_not_readable','cloud_membership_required'].includes(error.code));}
function paused(){const session=account.getUsableSession();return accessPause && session && accessPause.scopeKey===ownerScopeKey() && accessPause.userId===session.userId && accessPause.accessToken===session.accessToken && Date.now()<accessPause.until;}
const listeners=new Set();let status={phase:'idle',message:'正在连接云端资料库',revision:0};
function currentSession(){
  const session=account.getUsableSession();
  if(!session){const routes=require('./session-route');if(typeof routes.checkCurrent==='function')routes.checkCurrent();}
  return session;
}
function ownerScopeKey(){return sync.scopedStatePath('namespace',owner());}
function owner(){const session=currentSession();if(!session)throw new Error('请先登录账号');return session.userId;}
function load(){const path=opsPath();if(!operations||operationsPath!==path){operationsPath=path;operations=(storage.readMap||storage.readJSON)(path,{})||{};}return operations;}
function persist(){storage.writeJSON(opsPath(),load());}
function emit(phase,message,changed=false,details={}){const probe=require('./longtask');if(probe.mark)probe.mark('cloud.'+phase);status={...details,phase,message,revision:status.revision+(changed?1:0)};for(const listener of listeners)listener(status);}
function subscribe(listener){listeners.add(listener);listener(status);return()=>listeners.delete(listener);}
function note(intent){
  const userId=owner(),key=`${userId}:${intent.type}:${intent.id}:${intent.kind || ''}`,previous=load()[key];
  const value=Object.assign({},intent,{userId,sequence:++sequence});load()[key]=value;
  try{if(storage.patchMap)storage.patchMap(opsPath(),key,value);else persist();}catch(error){if(previous)operations[key]=previous;else delete operations[key];throw error;}
  return{key,previous,sequence:value.sequence};
}
function cancel(ticket){if(!ticket || !load()[ticket.key] || load()[ticket.key].sequence!==ticket.sequence)return;if(ticket.previous)operations[ticket.key]=ticket.previous;else delete operations[ticket.key];if(storage.patchMap)storage.patchMap(opsPath(),ticket.key,ticket.previous||null);else persist();}
function applyIntent(intent){
  if(intent.type==='progress'){library.updateReadingPosition(intent.id,intent.progress,intent.positionBytes||0);return;}
  if(intent.type==='article')library.toggleSavedState(intent.id,intent.kind,intent.value);
  else if(intent.type==='pin')library.pinSource(intent.id,intent.value);
  else if(intent.type==='delete-source')library.softDeleteSource(intent.id);
  else if(intent.type==='source-original')library.setSourceOriginal(intent.id,intent.value);
  else if(intent.type==='order-source')library.setSourceOrder(intent.id,intent.value);
  else if(intent.type==='order-article')library.setArticleOrder(intent.id,intent.kind,intent.value);
  else if(intent.type==='delete-article')library.softDeleteArticle(intent.id);
  else if(intent.type==='delete-book')library.softDeleteBook(intent.id);
}
function pending(userId){return Object.values(load()).filter(item=>item.userId===userId);}
function assertOwner(userId){if(owner()!==userId)throw new Error('账号已切换，请重新登录');}
async function commitIntents(userId,committed,check=()=>assertOwner(userId)){
 const sequences=new Set(committed.map(item=>item.sequence)),path=opsPath();let deadline=Date.now()+4;
 for(const [key,value]of Object.entries(load())){
  check();if(value.userId!==userId||!sequences.has(value.sequence)||load()[key]?.sequence!==value.sequence)continue;
  if(storage.patchMap)storage.patchMap(path,key,null);delete operations[key];
  if(Date.now()>=deadline){await util.tick();check();deadline=Date.now()+4;}
 }
 if(!storage.patchMap)persist();
}
async function replayIntents(scope,intents){let deadline=Date.now()+4;for(const intent of intents){assertCurrent(scope);applyIntent(intent);if(Date.now()>=deadline){await util.tick();assertCurrent(scope);deadline=Date.now()+4;}}}

async function pullRecords(scope,options={}){
  if(typeof records.pull!=='function')return{enabled:false};
  const pendingRss=[];const anchor=anchorKey(scope.userId);try{const result=await records.pull({...options,shouldYield:()=>options.allowForegroundYield!==false&&!!sync.cloudForegroundPending?.(),scope,keyForVersion:version=>sync.getAccountKey(scope.userId,version),refreshKeys:version=>sync.refreshAccountKey(scope.userId,version),anchorKey:anchor,apply:async index=>{
    assertCurrent(scope);
    require('./intent-rebase').sources(index.sources,pending(scope.userId),library);
    const changed=await (library.applyCloudIndexAsync||library.applyCloudIndex)(index.articles,index.sources.map(source=>Object.assign({},source,{__syncedSettingsIncluded:true})),{deferPersist:true,check:()=>assertCurrent(scope)});
    const bookChanged=typeof library.bookStoragePath==='function'?await require('./books').applyAsync(index.books||[],index.bookReading||[]):false;
    pendingRss.push(...(index.rssStates||[]));return bookChanged||!!(index.rssStates||[]).length||changed;
  },commit:async()=>{
    assertCurrent(scope);
    // A durable projection write precedes either the final cursor or a handoff.
    // A failed commit leaves the cursor unchanged; replay is a CRDT merge.
    if(pendingRss.length&&typeof library.applyRssInteractions==='function')library.applyRssInteractions(pendingRss);
    if(library.commitCloudIndexAsync)await library.commitCloudIndexAsync(()=>assertCurrent(scope));else library.applyCloudIndex([],[],{requirePersist:true});
    pendingRss.length=0;
  }});if(result.yielded)throw foregroundYield();return result;}finally{if(anchor)anchor.fill(0);}
}
function anchorKey(userId){if(typeof sync.trustInfo!=='function')return undefined;const trust=sync.trustInfo(userId);return trust&&trust.keyCommitments.length?sync.getAccountKey(userId,trust.keyCommitments[0].keyVersion):undefined;}
function intentBlocked(intent,entities){
 if(!entities)return true;
 return entities.some(entity=>{
  if(entity.entityId===intent.id||entity.sourceUrl===intent.id)return true;
  if(entity.articleIdHash&&entity.articleIdHash===require('./crypto').sha256Hex(intent.id))return true;
  if(!entity.entityId||!['book','book-reading'].includes(entity.kind))return false;
  const books=require('./books'),book=books.load().books[entity.entityId];
  if(intent.id==='watchrss://book/'+entity.entityId||book?.sourceUrl===intent.id)return true;
  const item=library.getArticleView?library.getArticleView(intent.id):null;
  if(!item)return false;
  const member=books.member(item);
  return !!member&&member.bookId===entity.entityId||item.rssSourceUrl==='watchrss://book/'+entity.entityId||entity.chapterIndex&&item.articleId===books.articleId(entity.entityId,entity.chapterIndex);
 });
}
async function pushRecords(scope,keyInfo,deferSavedCleanup=false,privateState={}){
  if(typeof sync.assertUploadOwner==='function')sync.assertUploadOwner();
  for(let attempt=0;attempt<3;attempt++){
    assertCurrent(scope);
    const submitted=pending(scope.userId);
    if(attempt>0)await replayIntents(scope,submitted);
    const submittedRevision=library.dirtyRevision();
    try{
      const anchor=anchorKey(scope.userId);let result;
      try{result=await records.push({scope,keyVersion:keyInfo.keyVersion,key:keyInfo.accountKey,anchorKey:anchor,rssStates:typeof library.listRssInteractions==='function'?library.listRssInteractions():[],articles:library.listArticleViews({includeDeleted:true}),sources:library.listSources({includeDeleted:true}),deferSavedCleanup,shouldYield:()=>!!sync.cloudForegroundPending?.(),pendingSavedArticleIds:privateState.pendingSavedArticleIds||[],readySavedArticleIds:privateState.readySavedArticleIds,readyBookIds:privateState.readyBookIds||[],onAck:entities=>commitIntents(scope.userId,submitted.filter(intent=>intentBlocked(intent,entities)),()=>assertCurrent(scope)),onDelta:async options=>{const value=await pullRecords(scope,{...options,allowForegroundYield:false});scope.exchangeChanged=scope.exchangeChanged||!!value.changed;return value;}});}
      finally{if(anchor)anchor.fill(0);}
      if(result&&result.editPending){assertCurrent(scope);await commitIntents(scope.userId,submitted.filter(intent=>!intentBlocked(intent,result.pendingEntities)),()=>assertCurrent(scope));throw require('./cloud-format').error();}
      if(result && result.unsupported)throw Object.assign(new Error('云存储更新服务暂不可用，更改已保留，将稍后重试'),{code:'cloud_records_unavailable'});
      // R42: acknowledge exactly this records request's intents immediately.
      // A newer same-key intent queued in flight has a different sequence.
      assertCurrent(scope);await commitIntents(scope.userId,submitted,()=>assertCurrent(scope));library.clearDirty(submittedRevision);
      return result;
    }
    catch(error){
      if(!['cloud_record_conflict','cloud_record_rebase_required'].includes(error.code) || attempt===2)throw error;
      // Re-merge remote clocks, then replay durable local intent. Never retry a
      // conflicting ciphertext against a new revision without this merge.
      if(!error.deltaApplied&&error.code!=='cloud_record_rebase_required')await pullRecords(scope);assertCurrent(scope);
      await new Promise(resolve=>setTimeout(resolve,100*2**attempt+Math.floor(Math.random()*100)));assertCurrent(scope);
    }
  }
}
function foregroundYield(){return Object.assign(Error('前台导入优先'),{code:'cloud_foreground_pending'});}
function yieldForeground(scope){assertCurrent(scope);if(sync.cloudForegroundPending?.())throw foregroundYield();}
async function idleStage(scope){yieldForeground(scope);const ui=require('./interaction');if(!scope.manual&&ui.whenIdle)await ui.whenIdle();yieldForeground(scope);}
async function execute(scope) {
  const reset=storage.readJSON('state/storage-projection-reset.json',null);if(reset){lastRead=0;lastFullRead=0;lastHeadsSignature=null;lastContexts=[];}
  await idleStage(scope);
  assertCurrent(scope);
  if(library.prepareViews)await library.prepareViews();assertCurrent(scope);if(library.migrateProvenanceLegacy)await library.migrateProvenanceLegacy(()=>assertCurrent(scope));assertCurrent(scope);
  const userId=owner(),identity=device.deviceId();if(lastOwner!==ownerScopeKey()){lastRead=0;lastFullRead=0;lastHeadsSignature=null;lastContexts=[];lastOwner=ownerScopeKey();}library.ensureOwner();emit('loading','正在读取云端资料库');
  if(scope.exchange&&scope.exchange.close)scope.exchange.close();delete scope.exchange;
  let connection=null;
  if(typeof exchangeClient.open==='function'&&typeof records.checkpoint==='function')connection=await exchangeClient.open(scope,()=>records.checkpoint(scope));
  if(connection&&connection.enabled)scope.exchange=connection;
  const boot=connection&&connection.boot||await sync.bootstrap();scope.contentGeneration=typeof library.bookStoragePath==='function'?require('./cloud-scope').content(userId)?.contentGeneration:undefined;assertCurrent(scope);
  const keyInfo=connection&&connection.keyInfo||sync.resolveAccountKey(userId,identity,boot);
  let heads=[],snapshotError=connection&&connection.snapshotError||null,recordError=null;
  try{heads=scope.exchange?connection.heads:await sync.snapshotHeads();assertCurrent(scope);}catch(error){if(error.code==='cloud_foreground_pending')throw error;assertCurrent(scope);if(['cloud_content_rebuild_required','NEEDS_RECOVERY','client_upgrade_required'].includes(error.code))throw error;snapshotError=error;}
  if(snapshotError&&denied(snapshotError))throw snapshotError;
  const signature=heads.map(h=>`${h.sourceDeviceId}:${h.id}:${h.deviceSequence}`).sort().join('|');
  if(!reset&&scope.exchange&&connection.projectionValid&&!connection.resetRecords&&!library.isDirty()&&!pending(userId).length&&!require('./cloud-scope').content(userId)?.rebuildRequired&&!connection.checkpoint.needsPush&&!connection.checkpoint.quarantined&&connection.initial.formatVersion===1&&!connection.initial.items.length&&!connection.initial.hasMore&&connection.initial.cursor===connection.checkpoint.cursor){
    if(!boot.member.readable)throw Object.assign(Error('当前云会员不可读取资料库'),{code:'cloud_membership_required'});
    lastRead=Date.now();lastOwner=ownerScopeKey();lastHeadsSignature=signature;emit('ready','已连接云端资料库');
    return{readable:true,pending:false,snapshotUploaded:false,exchange:true,cached:true};
  }
  if(!boot.member.readable)throw Object.assign(new Error('当前云会员不可读取资料库'),{code:'cloud_membership_required'});
  {
    const ownDevice=(boot.devices || []).find(d=>d.deviceId===identity && !d.revokedAt);
    if((typeof sync.needsFormatDeclaration==='function'&&sync.needsFormatDeclaration(identity,ownDevice))||!ownDevice || !ownDevice.attestation || ownDevice.attestationKeyVersion!==keyInfo.keyVersion || (typeof records.status==='function' && !(ownDevice.capabilities && ownDevice.capabilities.rssRecordsVersion>=1))){
      await sync.registerDevice(identity,ownDevice && ownDevice.displayName || '小程序 · 本机');assertCurrent(scope);
      if(ownDevice)ownDevice.capabilities=Object.assign({},ownDevice.capabilities,{rssRecordsVersion:1,...require('./cloud-format').capabilities()});
    }
    assertCurrent(scope);await sync.ensureOwnDeviceEnvelope(userId,identity,keyInfo.accountKey,keyInfo.keyVersion,boot.keyEnvelopes);
  }
  let envelopeRepair={needsApproval:[],failures:[]};
  if(typeof sync.repairDeviceEnvelopes==='function'){envelopeRepair=await sync.repairDeviceEnvelopes(userId,boot);assertCurrent(scope);}
  assertCurrent(scope);const statePath=sync.scopedStatePath('library',userId);
  const state=storage.readJSON(statePath,null) || {deviceSequence:sync.loadState().deviceSequence || 0,appliedState:{},retentionDays:sync.loadState().retentionDays||30};
  state.appliedState=state.appliedState || {};const contexts=[];let changed=false;
  const cachedHeads=!snapshotError&&signature===lastHeadsSignature&&Date.now()-lastFullRead<120000&&!library.isDirty()&&!pending(userId).length;
  if(cachedHeads)contexts.push(...lastContexts);
  let headNumber=0;
  for(const head of (cachedHeads?[]:heads).slice().sort((a,b)=>new Date(a.completedAt)-new Date(b.completedAt))) {
    headNumber++;
    const progress=(phase,message)=>{assertCurrent(scope);emit(phase,`云端快照 ${headNumber}/${heads.length}：${message}`);};
    try{
    const key=sync.getAccountKey(userId,head.keyVersion)||await sync.refreshAccountKey(userId,head.keyVersion);assertCurrent(scope);if(!key)throw Object.assign(Error('缺少快照密钥版本'),{code:'cloud_key_version_missing'});
    const cached=sync.loadManifest(head.id);let manifest;
    const unseen=lastFullRead===0 || head.deviceSequence>(state.appliedState[head.sourceDeviceId] || 0);
    if(unseen || !cached) {
      const pulled=await sync.pullHead(userId,identity,head,key,null,unseen?sync.INDEX_OBJECTS:[],{memoryOnly:true,onPhase:progress});manifest=pulled.manifest;assertCurrent(scope);
      if(pulled.objects[sync.OBJ.RSS_STATE]) {
        progress('parsing','正在解析索引');await util.tick();assertCurrent(scope);
        await idleStage(scope);const index=payload.parseRssState(pulled.objects[sync.OBJ.RSS_STATE]);
        progress('merging',`正在合并 ${index.articles.length} 篇内容的索引`);await util.tick();assertCurrent(scope);
        changed=await (library.applyCloudIndexAsync||library.applyCloudIndex)(index.articles,index.sources.map(source=>Object.assign({},source,{__syncedSettingsIncluded:true})),{check:()=>assertCurrent(scope)})||changed;
      }
      if(require('./cloud-format').readable(manifest,'manifest'))state.appliedState[head.sourceDeviceId]=head.deviceSequence;
    } else {await idleStage(scope);manifest=snapshot.decryptManifestAsync?await snapshot.decryptManifestAsync(key,head.id,cached,head,()=>assertCurrent(scope)):snapshot.decryptManifest(key,head.id,cached,head);}
    contexts.push({head,manifest});
    }catch(error){if(error.code==='cloud_foreground_pending')throw error;assertCurrent(scope);if(['cloud_content_rebuild_required','NEEDS_RECOVERY','client_upgrade_required'].includes(error.code))throw error;snapshotError=error;}
  }
  assertCurrent(scope);
  // Keep the explicit records consent interaction. Declining retains local edits;
  // it never authorizes an old state-snapshot fallback.
  if(visible && typeof records.status==='function'){
    try{const upgrade=await storageUpgrade.request({scope,writable:true});assertCurrent(scope);if(upgrade.approved)emit('saving','正在更新云存储格式，原备份已保留');}catch(error){if(error.code==='cloud_foreground_pending')throw error;assertCurrent(scope);if(['cloud_content_rebuild_required','NEEDS_RECOVERY','client_upgrade_required'].includes(error.code))throw error;recordError=error;}
  }
  let recordState={enabled:false};
  try{await idleStage(scope);recordState=await pullRecords(scope,scope.exchange&&scope.exchange.resetRecords?{reset:true}:{});assertCurrent(scope);changed=changed||!!recordState.changed;}catch(error){if(error.code==='cloud_foreground_pending')throw error;assertCurrent(scope);if(['cloud_content_rebuild_required','NEEDS_RECOVERY','client_upgrade_required'].includes(error.code))throw error;recordError=error;}
  // Saved RSS metadata belongs to the private body, never to an article record.
  // Recover its locator after records, then overlay sourceId-bound user state.
  let savedMetadata=[];
  for(const context of contexts){
    if(!require('./cloud-format').readable(context.manifest,'manifest'))continue;
    if(typeof require('./cloud-reader').archiveMetadata!=='function'||!sync.OBJ.PRIVATE_LIBRARY||!context.manifest.objects.some(object=>object.name===sync.OBJ.PRIVATE_LIBRARY))continue;
    try{if(!context.privateMetadata)context.privateMetadata=await require('./cloud-reader').archiveMetadata(context,userId);assertCurrent(scope);savedMetadata.push(...context.privateMetadata);}
    catch(error){if(error.code==='cloud_foreground_pending')throw error;assertCurrent(scope);if(['cloud_content_rebuild_required','NEEDS_RECOVERY','client_upgrade_required'].includes(error.code))throw error;snapshotError=error;}
  }
  for(const {manifest}of contexts.filter(c=>require('./cloud-format').readable(c.manifest,'manifest')))for(const object of manifest.objects||[]){
    if(!require('./cloud-format').readable(manifest,'manifest')||!require('./cloud-format').readable(object,'descriptor'))continue;
    const value=object.privateArticle;
    if(value&&typeof value.articleId==='string'&&typeof value.url==='string'&&object.name===require('./cloud-reader').objectName(value))savedMetadata.push(value);
  }
  if(contexts.some(c=>require('./cloud-overlay').marked(c.manifest))){
    try{const resolved=await require('./cloud-reader').overlayMetadata(contexts,userId,savedMetadata);assertCurrent(scope);savedMetadata=resolved.rows;for(const warning of resolved.warnings){snapshotError=Object.assign(Error('部分私有原文待重试'),warning);for(const c of contexts)delete state.appliedState[c.head.sourceDeviceId];}}
    catch(error){if(error.code==='cloud_foreground_pending')throw error;assertCurrent(scope);snapshotError=error;for(const c of contexts)delete state.appliedState[c.head.sourceDeviceId];savedMetadata=[];}
  }
  if(savedMetadata.length){changed=await (library.applyCloudIndexAsync||library.applyCloudIndex)(savedMetadata,[],{requirePersist:true,check:()=>assertCurrent(scope)})||changed;if(typeof library.applyRssInteractions==='function')library.applyRssInteractions();}
  let bookState={warnings:[],readyBookIds:[]};
  if(typeof library.bookStoragePath==='function'){
    await idleStage(scope);bookState=await require('./cloud-books').restore(contexts,userId,{onReadable:(_id,{verified=false}={})=>{assertCurrent(scope);emit('ready',verified?'书目已更新':'书目可读，正文正在后台同步',true,{bookMetadataReady:true});}});assertCurrent(scope);
    const migrationWarnings=await require('./cloud-books').migrate();assertCurrent(scope);bookState.warnings.push(...migrationWarnings);
    for(const warning of bookState.warnings)for(const context of contexts)if(!warning.bookId||context.manifest.objects.some(o=>o.privateBook?.bookId===warning.bookId))delete state.appliedState[context.head.sourceDeviceId];
  }
  // Resolution only fetches channel entries; records use local R30 source keys.
  let sourceWarnings=[];
  if(scope.refreshPublic!==false&&lastFullRead===0&&typeof rss.refreshSources==='function'){
    try{const refreshed=await rss.refreshSources(library.listSources().filter(source=>!source.deleted&&!require('./merge').isImportedContentUrl(source.url)));assertCurrent(scope);sourceWarnings=refreshed&&refreshed.failures||[];}
    catch(error){if(error.code==='cloud_foreground_pending')throw error;assertCurrent(scope);if(['cloud_content_rebuild_required','NEEDS_RECOVERY','client_upgrade_required'].includes(error.code))throw error;sourceWarnings=[{error}];}
  }
  const committed=pending(userId);await replayIntents(scope,committed);
  let privateState={uploaded:false,pending:false},privateError=null;
  if(typeof sync.currentKeyVersion==='function'){keyInfo.keyVersion=sync.currentKeyVersion(userId);keyInfo.accountKey=sync.getAccountKey(userId,keyInfo.keyVersion);}
  // R40: reads above are independent. Confirm metadata writes before publishing
  // dependent private content; saved-index retirement waits until body complete.
  const skipRecordPush=!changed&&!library.isDirty()&&!pending(userId).length&&!recordState.needsPush&&!require('./cloud-scope').content(userId)?.rebuildRequired;
  if(recordState.enabled&&!recordError&&!skipRecordPush){try{await idleStage(scope);await pushRecords(scope,keyInfo,true,bookState);assertCurrent(scope);}catch(error){if(error.code==='cloud_foreground_pending')throw error;assertCurrent(scope);if((['cloud_content_rebuild_required','NEEDS_RECOVERY','client_upgrade_required','cloud_library_owner_choice_required'].includes(error.code)||error.code==='cloud_format_upgrade_required'&&error.status===426))throw error;recordError=error;}}
  if(recordState.enabled&&!recordError&&typeof sync.trustInfo==='function'&&typeof require('./cloud-reader').syncSaved==='function'){
    try{await idleStage(scope);privateState=await require('./cloud-reader').syncSaved({scope,contexts,manual:!!scope.manual,checkBackground:()=>yieldForeground(scope)});assertCurrent(scope);
      if(typeof library.bookStoragePath==='function'){
       if(require('./cloud-scope').content(scope.userId)?.rebuildRequired)emit('saving','云端内容已清空，正在从本机重新上传');
       const rebuilt=await require('./cloud-rebuild').publishPrivate({scope,contexts,checkBackground:()=>yieldForeground(scope)});assertCurrent(scope);
       privateState={...privateState,uploaded:privateState.uploaded||rebuilt.uploaded,pending:privateState.pending||rebuilt.pending,warnings:(privateState.warnings||[]).concat(rebuilt.warnings)};
       const publishedBooks=await require('./cloud-books').publish({scope,contexts,manual:!!scope.manual,readyBookIds:bookState.readyBookIds,checkBackground:()=>yieldForeground(scope)});assertCurrent(scope);
       privateState={...privateState,uploaded:privateState.uploaded||publishedBooks.uploaded,pending:privateState.pending||publishedBooks.pending||bookState.warnings.length>0,warnings:(privateState.warnings||[]).concat(bookState.warnings,publishedBooks.warnings||[]),readyBookIds:publishedBooks.readyBookIds,retryAfter:privateState.retryAfter||publishedBooks.retryAfter};
      }
    }
    catch(error){if(error.code==='cloud_foreground_pending')throw error;assertCurrent(scope);if((['cloud_content_rebuild_required','NEEDS_RECOVERY','client_upgrade_required','cloud_library_owner_choice_required'].includes(error.code)||error.code==='cloud_format_upgrade_required'&&error.status===426))throw error;privateError=error;}
    try{if(!skipRecordPush||privateState.uploaded||library.isDirty())await pushRecords(scope,keyInfo,!!privateError,privateState);assertCurrent(scope);}catch(error){if(error.code==='cloud_foreground_pending')throw error;assertCurrent(scope);if((['cloud_content_rebuild_required','NEEDS_RECOVERY','client_upgrade_required','cloud_library_owner_choice_required'].includes(error.code)||error.code==='cloud_format_upgrade_required'&&error.status===426))throw error;recordError=error;}
  }
  if(typeof library.bookStoragePath==='function'&&recordState.enabled&&!recordError&&!privateError&&!privateState.pending)require('./cloud-scope').finishContentRebuild(userId,scope.contentGeneration);
  const dirty=library.isDirty();let uploaded=!!privateState.uploaded;
  // S1: records are the only metadata writer, regardless of peer capabilities.
  // Failed/declined records never authorize a compatibility snapshot or clearing edits.
  const recordsOnly=recordState.enabled && !recordError;
  if(recordsOnly){changed=changed || committed.length>0 || dirty;}
  else if(!recordError)recordError=Object.assign(Error('请先启用逐条云同步，更改已保留'),{code:recordState.unsupported?'cloud_records_unavailable':'cloud_records_consent_required'});
  assertCurrent(scope);if(!recordError&&!privateError&&!privateState.pending&&!snapshotError)state.lastSuccessfulAt=Date.now();state.deviceSequence=Math.max(state.deviceSequence||0,sync.loadState().deviceSequence||0);try{sync.saveState(state);}catch(_){/* remote commit/read succeeded; optional applied-head cache */}try{storage.writeJSON(statePath,state);}catch(_){/* fetched again on cold start */}lastRead=Date.now();lastHeadsSignature=signature;if(!cachedHeads)lastFullRead=Date.now();if(!snapshotError)lastContexts=contexts;
  const stillPending=pending(userId).length>0 || library.isDirty() || privateState.pending || !!privateError;
  changed=changed||!!scope.exchangeChanged;
  if(scope.exchange&&!stillPending&&!recordError&&!snapshotError&&!recordState.quarantined&&!recordState.upgradeRequired){const checkpoint=await records.checkpoint(scope);await scope.exchange.markApplied(checkpoint.cursor);assertCurrent(scope);}

  if(snapshotError&&denied(snapshotError))throw snapshotError;
  const needsApproval=envelopeRepair.needsApproval||[],envelopeRepairErrors=envelopeRepair.failures||[];
  const objectReadOnly=recordError?.code==='cloud_format_upgrade_required'||privateError?.code==='cloud_format_upgrade_required';
  const degraded=!!(sourceWarnings.length||(privateState.warnings||[]).length||recordError||privateError||snapshotError||recordState.quarantined||envelopeRepairErrors.length);
  emit(objectReadOnly?'upgrade_required':degraded?'degraded':stillPending?'saving':'ready',objectReadOnly?'请升级到最新版本以继续同步':privateError?'私有原文暂未备份，更改已保留':bookState.warnings.length?'部分导入书暂未备份，其余已同步':(privateState.warnings||[]).some(w=>w.code==='cloud_local_original_missing')?'部分原文不在本机，已保留条目，请重新导入或从其他设备同步':(privateState.warnings||[]).length?`${privateState.warnings.length} 篇收藏原文暂未备份，其余已同步`:recordError?(recordError.recordFailure==='count_limit'?'记录数量已达上限，更改已保留':recordError.recordFailure==='quota'?'记录额度已满，更改已保留':recordError.recordFailure==='payload_limit'?'记录批次过大，更改已保留':'部分记录暂未同步，更改已保留'):sourceWarnings.length?`${sourceWarnings.length} 个频道暂未刷新，其他更改已同步`:envelopeRepairErrors.length?'部分设备信封暂未补发，其他通道继续同步':degraded?'部分云对象已隔离，其他通道继续同步':needsApproval.length?`${needsApproval.length} 台设备需要重新批准，其他通道继续同步`:stillPending?(privateState.deferredSavedCount?`${privateState.deferredSavedCount} 篇收藏原文待重试`:privateState.retryAfter?'稍后合并备份':'正在提交后续操作'):'已连接云端资料库',changed,{...(objectReadOnly?{code:'cloud_format_upgrade_required',retryable:false}:{}),editPending:recordError?.code==='cloud_format_upgrade_required'||privateError?.code==='cloud_format_upgrade_required',upgradeRequired:!!recordState.upgradeRequired||recordError?.code==='cloud_format_upgrade_required'||privateError?.code==='cloud_format_upgrade_required'||contexts.some(c=>!require('./cloud-format').assess(c.manifest,'manifest').write||c.manifest.objects.some(d=>!require('./cloud-format').assess(d,'descriptor').write)),needsApproval,envelopeRepairErrors,sourceWarnings,privateWarnings:privateState.warnings||[],deferredSavedCount:privateState.deferredSavedCount||0});
  if(reset&&!recordError&&!privateError&&!snapshotError&&storage.readJSON('state/storage-projection-reset.json',null)?.at===reset.at)storage.deleteFile('state/storage-projection-reset.json');
  return{readable:true,...(objectReadOnly?{upgradeRequired:true,readOnlyPending:true,retryable:false}:{}),sourceWarnings,privateWarnings:privateState.warnings||[],deferredSavedCount:privateState.deferredSavedCount||0,snapshotUploaded:uploaded,pending:stillPending,retryAfter:privateState.retryAfter||((recordError||privateError)?Math.min(60000,2000*Math.pow(2,Math.min(retryAttempt,5))):undefined),privateError:privateError&&(privateError.code||'cloud_private_failed'),needsApproval,envelopeRepairErrors,recordError:recordError&&(recordError.code||'cloud_record_failed'),snapshotError:snapshotError&&(snapshotError.code||'cloud_snapshot_failed')};
}
function flushNow(options={}){
  if(running && isCurrent(runningScope))return running;
  running=null;runningScope=null;
  if(options.force)accessPause=null;
  if(paused())return Promise.resolve({readable:false,pending:false,accessPaused:true});
  const session=currentSession();
  if(!session)return Promise.reject(new Error('请先登录账号'));
  if(formatPaused(session.userId)){pauseFormat(session.userId);return Promise.resolve({readable:true,pending:true,upgradeRequired:true,code:'cloud_format_upgrade_required',retryable:false});}
  const scope={lifecycle:typeof sync.cloudLifecycle==='function'?sync.cloudLifecycle():undefined,userId:session.userId,accessToken:session.accessToken,backendBaseUrl:typeof sync.trustInfo==='function'?require('./cloud-scope').backend():undefined,generation:sessionGeneration,manual:!!options.force,refreshPublic:options.refreshPublic!==false};
  let task;task=sync.cloudExclusive(()=>{delete scope.contentGeneration;const release=require('./storage-budget').lockProjections?.()||(()=>{});return execute(scope).finally(release);}).catch(error=>{
    if(!isCurrent(scope))throw error;
    if(error.code==='cloud_foreground_pending'){
      emit('loading','正在优先执行文件导入，云同步稍后继续',false,{yielded:true});
      return{readable:!!lastRead,pending:true,yielded:true,retryAfter:300};
    }
    const current=account.getUsableSession();
    if(session && current && session.userId===current.userId && session.accessToken===current.accessToken && denied(error)){
      accessPause={scopeKey:ownerScopeKey(),userId:session.userId,accessToken:session.accessToken,until:Date.now()+ACCESS_RECHECK_MS};
      clearTimeout(retry);retry=null;
      emit('no_access',['cloud_not_readable','cloud_membership_required'].includes(error.code)?'开通后即可使用云服务':'当前账号暂无云端访问权限，请到“我的”检查授权状态。');
    }else if(error.code==='cloud_format_upgrade_required'){pauseFormat(session.userId);}else if(['client_upgrade_required','NEEDS_RECOVERY','cloud_library_owner_choice_required'].includes(error.code)){accessPause={scopeKey:ownerScopeKey(),userId:session.userId,accessToken:session.accessToken,until:Number.MAX_SAFE_INTEGER};emit(error.code==='client_upgrade_required'?'upgrade_required':error.code==='NEEDS_RECOVERY'?'needs_recovery':'owner_choice_required',error.message);}else emit('error','连接失败：更改尚未提交到云端，将自动重试');
    throw error;
  }).finally(()=>{if(scope.exchange&&scope.exchange.close)scope.exchange.close();if(running===task){running=null;runningScope=null;}});
  running=task;runningScope=scope;const current=task;
  current.then(result=>{if(!isCurrent(scope))return;if([result.recordError,result.privateError,result.snapshotError].includes('cloud_format_upgrade_required')){clearTimeout(retry);retry=null;return;}if(result.recordError||result.privateError)retryAttempt++;else retryAttempt=0;clearTimeout(retry);retry=null;if(visible && result.pending&&!formatPaused(scope.userId))scheduleRetry(result.retryAfter||300);}).catch(()=>{if(isCurrent(scope) && visible && !paused()&&!formatPaused(scope.userId))scheduleRetry(Math.min(60000,2000*Math.pow(2,Math.min(retryAttempt++,5))));});return current;
}
function flush(options={}){
  const session=account.getUsableSession();
  if(!session||typeof exchangeClient.cachedEnabled!=='function'||!exchangeClient.cachedEnabled(session.userId))return flushNow(options);
  const key=ownerScopeKey()+':'+sessionGeneration;
  if(!exchangeScheduler||exchangeScheduleOwner!==key){if(exchangeScheduler)exchangeScheduler.close();exchangeScheduleOwner=key;exchangeScheduler=exchangeClient.createScheduler({run:flushNow});}
  return exchangeScheduler.enqueue(options);
}
function jitter(ms){return Math.round(ms*(0.8+Math.random()*0.4));}
function scheduleRetry(ms){clearTimeout(retry);retry=setTimeout(()=>{retry=null;if(visible && account.getUsableSession())flush().catch(()=>{});},jitter(ms));}
function schedulePoll(){if(!visible || poll)return;poll=setTimeout(()=>{poll=null;if(!visible)return;if(!retry && currentSession())refresh().catch(()=>{});schedulePoll();},jitter(20000));}
function refresh(options={}){if(running && isCurrent(runningScope))return running;if(!storage.readJSON('state/storage-projection-reset.json',null) && !options.force && lastOwner===ownerScopeKey() && Date.now()-lastRead<2000 && !library.isDirty() && !pending(owner()).length)return Promise.resolve({cached:true});return flush(options);}
function start(){visible=true;if(!currentSession())return;refresh().catch(()=>{});schedulePoll();}
function stop(){require('./cloud-books').cancelPrefetch?.();if(exchangeScheduler)exchangeScheduler.close();exchangeScheduler=null;exchangeScheduleOwner=null;visible=false;clearTimeout(poll);clearTimeout(retry);poll=null;retry=null;}
function resetSession(){stop();if(exchangeScheduler)exchangeScheduler.close();exchangeScheduler=null;exchangeScheduleOwner=null;if(exchangeClient.resetSession)exchangeClient.resetSession();sessionGeneration++;formatPauses.clear();running=null;runningScope=null;lastRead=0;lastOwner=null;lastHeadsSignature=null;lastContexts=[];lastFullRead=0;retryAttempt=0;accessPause=null;if(typeof records.resetSession==='function')records.resetSession();if(typeof storageUpgrade.resetSession==='function')storageUpgrade.resetSession();listeners.clear();status={phase:'idle',message:'',revision:0};}
const scopeStore=require('./cloud-scope');if(typeof scopeStore.setContentClearHandler==='function')scopeStore.setContentClearHandler(()=>{formatPauses.clear();lastRead=0;lastFullRead=0;lastHeadsSignature=null;lastContexts=[];lastOwner=null;});
module.exports={resetSession,note,cancel,flush,refresh,start,stop,subscribe,getStatus:()=>status};

const taskProbe=require('./longtask');if(taskProbe.instrument)taskProbe.instrument(module.exports,'cloud-library');
