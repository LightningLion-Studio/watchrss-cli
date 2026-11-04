// Reader objects live inside the existing E2E encrypted snapshot protocol.
// Reading downloads only the manifest and the requested encrypted UTF-8 chunk.
const sync = require('./sync');
const http = require('./http');
const snapshot = require('./snapshot');
const crypto = require('./crypto');
const util = require('./util');
const gzip = require('./gzip');
const payload = require('./payload');
const account = require('./account');
const device = require('./device');
const library = require('./library');
const records=require('./cloud-records');
const cloudScope=require('./cloud-scope');
const appaccess=require('./appaccess');
const envelope=require('./envelope');
const CHUNK_BYTES = 9000;
const evolution=require('./cloud-format');
const diagnostics=require('./book-diagnostics');
const storage=require('./storage'),BODY_RETRY_MIN=60000,BODY_RETRY_MAX=86400000,BODY_WARNING_INTERVAL=86400000;
function privateArticle(article){
 const out={};for(const field of ['articleId','url','title','siteName','excerpt','imageUrl','contentHash','importedAt','updatedAt','rssSourceUrl','rssSourceTitle','independentSaved','independentChangedAt','independentSortOrder','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder'])if(article[field]!==undefined)out[field]=article[field];return out;
}
function objectName(article) {
  // Version by metadata hash: edited phone content must not reuse old reader text.
  return `reader/${crypto.sha256Hex(article.articleId).slice(0,32)}/${crypto.sha256Hex(String(article.contentHash || article.updatedAt || '')).slice(0,32)}.txt`;
}
function readerCandidates(article){if(!require('./rss-cloud').isPublic(article))return[article];const value=library.canonicalRssArticle(article);return[value,...library.legacyRssArticleIds(value.articleId).map(articleId=>({...value,articleId}))];}
function overlayOptions(context,userId){
 const value=context.value||context.manifest,owner=cloudScope.contentCurrent(),epoch=cloudScope.load(userId)?.libraryEpoch;
 const check=()=>{cloudScope.check(owner);if(owner.userId!==userId||cloudScope.load(userId)?.libraryEpoch!==epoch||value.settings?.libraryEpoch&&value.settings.libraryEpoch!==epoch)throw evolution.error('NEEDS_RECOVERY');};
 const key=sync.getAccountKey(userId,context.head.keyVersion);if(!key)throw evolution.error('cloud_key_version_missing');
 return{manifest:value,key,check,loadChunk:async chunk=>{check();const remote=await sync.snapshotDownload(context.head.id,{chunk:chunk.ciphertextSha256});check();const row=remote.chunks.find(r=>r.sha256===chunk.ciphertextSha256);if(!row||row.sizeBytes!==chunk.ciphertextBytes)throw evolution.error('cloud_entry_missing');return binary(row.signedUrl,chunk.ciphertextSha256,row.sizeBytes);}};
}
async function overlayInputs(contexts,userId){
 const overlay=require('./cloud-overlay'),inputs=[];
 for(const context of contexts){const value=context.value||context.manifest;if(!overlay.marked(value)&&!value.objects?.some(d=>d.name===overlay.NAME))continue;
  const options=overlayOptions(context,userId);try{const index=await overlay.load(options);options.check();inputs.push({context,manifest:value,index});}finally{options.key.fill(0);}
 }
 if(inputs.length){const options=overlayOptions(inputs[0].context,userId);try{await require('./storage-async').writeJSON(cloudScope.path('r48-overlay',userId),{generation:cloudScope.content(userId)?.contentGeneration,heads:inputs.map(i=>({id:i.context.head.id,index:i.index}))},{check:options.check});}finally{options.key.fill(0);}}
 return inputs;
}
async function overlayMetadata(contexts,userId,backing=[]){
 const overlay=require('./cloud-overlay'),inputs=await overlayInputs(contexts,userId),merged=overlay.merge(inputs),rows=backing.slice(),warnings=[];
 for(const context of contexts)context.overlayView=merged.selected;
 for(const selected of merged.selected.values()){
  const e=selected.entry;if(e.kind!=='article')continue;
  if(selected.conflict){warnings.push({articleId:e.id,code:'cloud_overlay_conflict'});continue;}
  if(e.object===null){for(let i=rows.length-1;i>=0;i--)if(rows[i].articleId===e.id)rows.splice(i,1);continue;}
  const options=overlayOptions(selected.context,userId);try{const article=await overlay.readArticle(options,e);for(let i=rows.length-1;i>=0;i--)if(rows[i].articleId===e.id)rows.splice(i,1);rows.push({...privateArticle({...article,independentSaved:false,independentChangedAt:0,independentSortOrder:0,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,importedAt:0,updatedAt:0}),__privateBodyMetadata:true,__privateBodyClock:e.changedAt,__privateBodyTracked:true});selected.context.privateMetadata=(selected.context.privateMetadata||[]).filter(a=>a.articleId!==e.id).concat(privateArticle(article));}catch(error){options.check();for(let i=0;i<rows.length;i++)if(rows[i].articleId===e.id)rows[i]={...rows[i],__privateBodyMetadata:true,__privateBodyFallback:true,__privateBodyClock:0,__privateBodyTracked:true};warnings.push({articleId:e.id,code:error.code||'cloud_entry_missing'});}finally{options.key.fill(0);}
 }
 return{rows,warnings,merged};
}
async function binary(url, sha, size) {
  if (!(size > 0 && size <= 17 * 1024 * 1024)) throw new Error('云端阅读块大小无效');
  const res = await http.request({ path: url, useBaseUrl: false, responseType: 'arraybuffer' });
  const bytes = new Uint8Array(res.data);
  if (bytes.length !== size || await crypto.sha256HexAsync(bytes) !== sha) throw new Error('云端正文校验失败，请重试');
  return bytes;
}
async function manifest(head, userId) {
  const owner=cloudScope.contentCurrent(),epoch=cloudScope.load(userId)?.libraryEpoch;
  const check=()=>{cloudScope.check(owner);if(epoch!==undefined&&cloudScope.load(userId)?.libraryEpoch!==epoch)throw Object.assign(Error('云资料库已重置'),{code:'NEEDS_RECOVERY'});};
  const key = sync.getAccountKey(userId, head.keyVersion)||await sync.refreshAccountKey(userId,head.keyVersion);
  const remote = await sync.snapshotDownload(head.id, {manifestOnly:true});
  const bytes = await binary(remote.manifestSignedUrl, head.manifestSha256, head.manifestSizeBytes);
  check();const value=await snapshot.decryptManifestAsync(key,head.id,bytes,head,check);
  if(epoch!==undefined&&value.settings&&value.settings.libraryEpoch&&value.settings.libraryEpoch!==epoch)throw Object.assign(Error('云快照纪元不匹配'),{code:'NEEDS_RECOVERY'});
  return {head,key,remote,check,value};
}
function wrapReaderKey(accountKey,readerKey,name) {
  const salt=crypto.randomBytes(16),nonce=crypto.randomBytes(12);
  const key=crypto.hkdfSha256(accountKey,salt,'watchrss/cloud/reader-key/v1',32);
  const cipher=crypto.aesGcmEncrypt(key,nonce,readerKey,util.utf8ToBytes(`watchrss-reader-key-v1:${name}`));
  return{version:1,saltBase64:util.base64PaddedEncode(salt),nonceBase64:util.base64PaddedEncode(nonce),ciphertextBase64:util.base64PaddedEncode(cipher)};
}
function unwrapReaderKey(accountKey,descriptor) {
  const envelope=descriptor.readerKeyEnvelope;if(!envelope)return accountKey;
  if(envelope.version!==1)throw new Error('云端阅读密钥版本不支持');
  const salt=util.base64Decode(envelope.saltBase64),nonce=util.base64Decode(envelope.nonceBase64);
  if(salt.length!==16 || nonce.length!==12)throw new Error('云端阅读密钥格式错误');
  const key=crypto.hkdfSha256(accountKey,salt,'watchrss/cloud/reader-key/v1',32);
  const root=crypto.aesGcmDecrypt(key,nonce,util.base64Decode(envelope.ciphertextBase64),util.utf8ToBytes(`watchrss-reader-key-v1:${envelope.scope || descriptor.name}`));
  if(root.length!==32)throw new Error('云端阅读密钥格式错误');return evolution.readOnlyRoot(root);
}
function chunkReader(context, descriptor) {
  evolution.assertRead(context.value||{objects:[descriptor]},'manifest');evolution.assertRead(descriptor,'descriptor');
  let closed=false;const readerKey=snapshot.objectRoot(context.key,descriptor);
  const owner=account.getUsableSession();
  return {
    totalPages: descriptor.chunks.length,
    get estimatedPages(){return this.totalPages;},
    hint: '加密云端分段阅读，仅在内存保留最近三段',
    sibling(article){
      const current=account.getUsableSession();
      if(closed||!owner||!current||current.userId!==owner.userId||current.accessToken!==owner.accessToken)return null;
      const key=sync.getAccountKey(current.userId,context.head.keyVersion);
      if(!key||key.length!==context.key.length||key.some((byte,i)=>byte!==context.key[i]))return null;
      // objectName includes the exact articleId and current contentHash/version.
      // An edited chapter cannot reuse a stale descriptor from this snapshot.
      const names=new Set(readerCandidates(article).map(objectName)),next=context.value&&context.value.objects.find(o=>names.has(o.name));
      return next&&['gzip-chunks-v1','identity'].includes(next.encoding)&&Array.isArray(next.chunks)&&next.chunks.length?chunkReader(context,next):null;
    },
    async read(page) {
      if(context.check)context.check();if(owner&&account.getUsableSession()?.userId!==owner.userId)throw Object.assign(Error('账号已切换'),{code:'cloud_session_changed'});
      const chunk = descriptor.chunks[page];
      if (!chunk || chunk.ciphertextBytes > CHUNK_BYTES + 1024) throw new Error('云端阅读块无效');
      if (closed) throw new Error('阅读已关闭');
      // Request a signature for exactly one chunk; never sign the whole book.
      const remote = await sync.snapshotDownload(context.head.id, {chunk:chunk.ciphertextSha256});
      if(context.check)context.check();
      const target = remote.chunks.find(c => c.sha256 === chunk.ciphertextSha256);
      if (closed) throw new Error('阅读已关闭');
      if (!target || target.sizeBytes !== chunk.ciphertextBytes) throw new Error('云端阅读块无效');
      const bytes = await binary(target.signedUrl, chunk.ciphertextSha256, target.sizeBytes);
      if(context.check)context.check();
      const plain = await snapshot.decryptChunkAsync(readerKey,chunk,bytes,()=>{if(closed)throw Error('阅读已关闭');if(context.check)context.check();});
      const raw = descriptor.encoding === 'gzip-chunks-v1' ? await gzip.gunzipAsync(plain,()=>{if(closed)throw Error('阅读已关闭');if(context.check)context.check();}) : plain;
      if (raw.length > CHUNK_BYTES) throw new Error('云端阅读块过大');
      return util.bytesToUtf8(raw);
    },
    close(){closed=true;if(readerKey!==context.key)readerKey.fill(0);},
  };
}
async function publish(article, text, context, userId, includeIndex=false,migration=null,book=null,onPhase=()=>{},options={}) {
  // A foreground import can wait behind an existing library restore. Keep the
  // writer lock, but expose that wait and the authenticated preparation stages.
  let preparation=null,preparationTimer=null;
  const stopPreparation=()=>{clearInterval(preparationTimer);preparationTimer=null;preparation=null;};
  const preparePhase=message=>{if(!options.bookObjects)return;preparation={message,at:Date.now()};onPhase(message);if(!preparationTimer)preparationTimer=setInterval(()=>{if(preparation)onPhase(`${preparation.message}（已用 ${Math.floor((Date.now()-preparation.at)/1000)} 秒）`);},1000);};
  const run=async () => {
    let completing=false,completed=false;
    const ownedKeys=new Set();const ownKey=key=>{if(key)ownedKeys.add(key);return key;};const readManifest=async head=>{const value=await manifest(head,userId);ownKey(value.key);return value;};
    const diagnostic=!migration&&require('./cloud-overlay').localEnabled()?require('./cloud-overlay').beginPublication():null;
    try{
    const publicationToken=account.getUsableSession()?.accessToken,publicationScope=cloudScope.contentCurrent(),publicationEpoch=cloudScope.load(userId)?.libraryEpoch;
    const assertAccount = () => {
      if(options.check)options.check();
      cloudScope.check(publicationScope);
      if(publicationEpoch!==undefined&&cloudScope.load(userId)?.libraryEpoch!==publicationEpoch)throw Object.assign(Error('云资料库已重置'),{code:'NEEDS_RECOVERY'});
      const current = account.getUsableSession();
      if (!current || current.userId !== userId || current.accessToken!==publicationToken) throw new Error('账号已切换，请重新登录');
      if(!completing&&!completed&&options.backgroundCheck)options.backgroundCheck();
    };
    assertAccount();
    const deviceId = device.deviceId();
    preparePhase('正在连接云端');
    const boot = await sync.bootstrap();
    sync.assertUploadOwner();
    const verified=sync.resolveAccountKey(userId,deviceId,boot);
    preparePhase('正在核对云端快照目录');
    const heads = await sync.snapshotHeads();
    const own = heads.find(h => h.sourceDeviceId === deviceId);
    // Preserve the current device's complete manifest. Never overwrite a newer head
    // using the manifest observed before waiting for the sync writer lock.
    preparePhase('正在验证云端快照');
    let base = own ? await readManifest(own) : null;
    if (!base) {
      const newest = heads.filter(h => !String(h.sourceDeviceId || '').startsWith('reader-migration-') && sync.getAccountKey(userId,h.keyVersion)).sort((a,b) => new Date(b.completedAt)-new Date(a.completedAt))[0];
      if (newest) base = await readManifest(newest);
      else {
        const keyInfo = sync.resolveAccountKey(userId,deviceId,boot);
        base = { key:ownKey(new Uint8Array(keyInfo.accountKey)), head:{keyVersion:keyInfo.keyVersion}, value:{objects:[],observedHeads:{}} };
      }
    }
    const version = verified.keyVersion;
    evolution.assertWrite(base.value,'manifest');
    if(!migration&&!require('./cloud-overlay').localEnabled())for(const head of heads)if(head.id!==base.head.id&&!String(head.sourceDeviceId||'').startsWith('reader-migration-')){const peer=await readManifest(head);evolution.assertWrite(peer.value,'manifest');if(require('./cloud-overlay').marked(peer.value))throw require('./cloud-overlay').invalid('cloud_format_write_disabled');}
    if(base.head.keyVersion!==version){if(base.value.objects.length)throw evolution.error();base={...base,key:ownKey(new Uint8Array(verified.accountKey)),head:{...base.head,keyVersion:version}};}
    preparePhase('正在核对设备密钥');
    const knownDevice=(boot.devices||[]).find(d=>d.deviceId===deviceId&&!d.revokedAt);
    const needsRegistration=typeof sync.needsFormatDeclaration!=='function'||sync.needsFormatDeclaration(deviceId,knownDevice)||!knownDevice?.attestation||knownDevice.attestationKeyVersion!==version||!(knownDevice.capabilities?.rssRecordsVersion>=1);
    if(needsRegistration)await sync.registerDevice(deviceId, '小程序 · 本机');
    await sync.ensureOwnDeviceEnvelope(userId, deviceId, base.key, version,boot.keyEnvelopes);
    const state = sync.loadState();
    const server = (boot.devices || []).find(d => d.deviceId === deviceId);
    const name = article?objectName(article):'';
    const entries=options.bookObjects?[]:book?book.entries:[{article,text}];
    let recordScope;
    if(includeIndex){
      preparePhase('正在核对逐条同步格式');
      recordScope={...cloudScope.contentCurrent(),accessToken:publicationToken,libraryEpoch:cloudScope.load(userId)?.libraryEpoch};let status=await records.status(recordScope);assertAccount();
      if(!status.enabled)status=await require('./cloud-storage-upgrade').request({scope:recordScope,force:true});
      assertAccount();
      if(!status.enabled)throw Object.assign(Error('请先启用逐条云同步后重试导入'),{code:'cloud_records_consent_required'});
    }
    const overlay=require('./cloud-overlay'),useOverlay=!migration&&overlay.localEnabled();let overlayPlan=null;
    if(overlay.marked(base.value)&&!useOverlay)throw overlay.invalid('cloud_format_write_disabled');
    if(useOverlay){
      preparePhase('正在核对私有内容目录');
      await overlay.assertEnabled();assertAccount();
      const peers=[base];for(const head of heads)if(head.id!==base.head.id&&!String(head.sourceDeviceId||'').startsWith('reader-migration-')){const peer=await readManifest(head);evolution.assertWrite(peer.value,'manifest');if(peer.head.keyVersion!==version&&peer.value.objects.length)throw evolution.error();peers.push(peer);}
      let inputs;try{inputs=await overlayInputs(peers,userId);}finally{for(const peer of peers)if(peer!==base)peer.key.fill(0);}
      const deletions=[...(options.overlayDeletions||[])];
      for(const id of options.removedSavedIds||[]){const a=library.getArticleView?library.getArticleView(id):library.getArticle(id);if(!a)throw overlay.invalid('cloud_overlay_clock_pending');deletions.push({kind:'article',id,changedAt:Math.max(a.deletedAt||0,a.favoriteChangedAt||0,a.watchLaterChangedAt||0)});}
      const selectedBodies=overlay.merge(inputs);if(selectedBodies.conflicts.length)throw overlay.invalid('cloud_overlay_conflict');
      // An old archive may carry HTML even when the local reader cached only
      // rendered text. Recover the authenticated original, never convert it to
      // a TXT-only replacement merely because that cache lost the HTML field.
      for(const entry of entries)if(!entry.article.contentHtml){const selected=selectedBodies.selected.get('article\n'+entry.article.articleId);if(selected?.descriptor?.contentSha256===await crypto.sha256HexAsync(await overlay.packArticle(entry.article,entry.text,assertAccount),assertAccount))continue;for(const peer of peers){const descriptor=peer.value.objects.find(d=>d.name===sync.OBJ.PRIVATE_LIBRARY);if(!descriptor)continue;const read=overlayOptions(peer,userId);try{const original=await require('./private-archive').readOriginal({...read,descriptor},{articleId:entry.article.articleId});if(original?.contentHtml){if(String(entry.text)!==original.contentText&&String(entry.text)!==require('./online-reader').toText(original))throw overlay.invalid('cloud_overlay_type_pending');entry.article={...entry.article,contentHtml:original.contentHtml,contentText:original.contentText};break;}}finally{read.key.fill(0);}}}
      const objects=(options.bookObjects||[]).map(object=>({...object,changedAt:object.changedAt||require('./books').load().books[object.privateBook?.bookId]?.updatedAt}));
      overlayPlan=await overlay.prepare({manifest:base.value,inputs,articles:entries,objects,deletions,sourceDeviceId:deviceId,check:assertAccount});
      if(overlayPlan.unchanged){diagnostic?.phase('unchanged');return base.head.id;}
    }
    const entryHashes=new Map(),logicalObjects=overlayPlan?overlayPlan.logicalObjects:[...(options.bookObjects||[])];if(!overlayPlan&&!migration&&!options.bookObjects)for(const entry of entries){assertAccount();const bytes=await require('./storage-async').utf8Encode(entry.text,assertAccount),hash=await crypto.sha256HexAsync(bytes,assertAccount);entryHashes.set(entry.article,hash);logicalObjects.push({name:objectName(entry.article),bytes,compress:true,chunkBytes:CHUNK_BYTES,utf8Aligned:true,contentSha256:hash,privateArticle:privateArticle(entry.article)});}
    const migrated=migration?Object.assign({},migration.descriptor,{readerKeyEnvelope:wrapReaderKey(base.key,migration.key,name)}):null;
    const replaced = new Set(logicalObjects.map(o => o.name));
    const readerPrefixes=overlayPlan?[]:entries.flatMap(entry=>readerCandidates(entry.article).map(value=>{const path=objectName(value);return path.slice(0,path.lastIndexOf('/')+1);}));
    for(const d of base.value.objects)if((replaced.has(d.name)||readerPrefixes.concat(options.removePrefixes||[]).some(prefix=>d.name.startsWith(prefix)))&&!evolution.assess(d,'descriptor').write)throw evolution.error();
    async function commitMetadata(){
      if(!includeIndex)return;
      const scope=recordScope;assertAccount();
      // Import confirmation owns only this import. Other UI operations are
      // acknowledged by the records driver, with their captured intent sequence.
      const articles=entries.map(entry=>entry.article);
      const sources=book&&book.source?[book.source]:[];
      const anchor=sync.getAccountKey(userId,sync.trustInfo(userId).keyCommitments[0].keyVersion);
      try{const result=await records.push({scope,keyVersion:version,key:base.key,anchorKey:anchor,articles,sources,books:options.books||[],bookReading:options.bookReading||[],bookIds:(options.books||[]).map(s=>s.bookId),entitiesOnly:true,deferSavedCleanup:true,onStage:stage=>{const phases={loading:'正在读取导入同步状态',encoding:'正在加密导入记录',submitting:'正在提交导入记录',saving:'正在保存导入确认'};if(phases[stage])preparePhase(phases[stage]);}});assertAccount();if(result.editPending)throw evolution.error();if(result.unsupported)throw Object.assign(Error('逐条云同步暂不可用'),{code:'cloud_records_unavailable'});}finally{if(anchor)anchor.fill(0);}
    }
    // R40: a failed records write cannot publish a dependent private snapshot.
    preparePhase('正在保存导入记录');
    await commitMetadata();
    // Current ready cloud head is authenticated even if all local caches are gone.
    // Unchanged content requires neither a manifest nor a body PUT.
    const existingBodies=new Map(base.value.objects.filter(object=>!object.readerKeyEnvelope).map(object=>[object.name,object.contentSha256]));
    const savedBefore=base.head.sourceDeviceId===deviceId&&base.value.settings&&base.value.settings.miniSavedArticleIds||[];
    const savedNow=options.savedIds||savedBefore;
    if(!overlayPlan&&!migration&&(!options.bookObjects||options.bookObjects.every(object=>base.value.objects.some(old=>old.name===object.name&&old.privateBook?.fingerprint===object.privateBook.fingerprint&&old.privateBook?.instanceId===object.privateBook.instanceId&&JSON.stringify(old.privateBook?.lifecycle||null)===JSON.stringify(object.privateBook.lifecycle||null))))&&!(options.removePrefixes||[]).some(prefix=>base.value.objects.some(object=>object.name.startsWith(prefix)))&&entries.every(entry=>existingBodies.get(objectName(entry.article))===entryHashes.get(entry.article))&&JSON.stringify(savedBefore)===JSON.stringify(savedNow)){
      return base.head.id;
    }
    stopPreparation();
    if(options.bookObjects){onPhase(options.books?.some(book=>book.chapterCount>1)?'正在生成阅读目录':'正在准备分段阅读');for(const bookObject of options.bookObjects){const companion=await require('./book-catalog').object(bookObject,assertAccount);if(!companion)continue;const previous=base.value.objects.find(d=>d.name===companion.name);if(previous)evolution.assertWrite(previous,'descriptor');logicalObjects.push(companion);replaced.add(companion.name);if(overlayPlan)overlayPlan.carryForwardObjects=overlayPlan.carryForwardObjects.filter(d=>d.name!==companion.name);}}
    let lastPreparationAt=0;
    const createInput = {
      accountKey: base.key, keyVersion: version, sourceDeviceId: deviceId,
      deviceSequence: 0,
      logicalObjects,
      previousManifest:base.value,
      carryForwardObjects:overlayPlan?overlayPlan.carryForwardObjects:base.value.objects.filter(o=>![sync.OBJ.RSS_STATE,sync.OBJ.LIBRARY_SYNC].includes(o.name)&&!replaced.has(o.name)&&!readerPrefixes.some(prefix=>o.name.startsWith(prefix))&&!(options.removePrefixes||[]).some(prefix=>o.name.startsWith(prefix))).concat(migrated?[migrated]:[]),
      ...(overlayPlan?{features:overlayPlan.features,allowEntryReferences:true}:{}),
      settings:{snapshotContentLayout:3,libraryEpoch:cloudScope.load(userId)?.libraryEpoch,miniSavedArticleIds:savedNow},
      parentHeads: base.head.id ? { [base.head.sourceDeviceId]: base.head.id } : {},
      observedHeads: Object.assign({}, base.value.observedHeads, base.head.id ? { [base.head.sourceDeviceId]: base.head.deviceSequence } : {}),
      check:assertAccount,...(options.storeChunk?{storeChunk:options.storeChunk}:{}),
      ...(options.bookObjects?{onProgress:p=>{
        if(!p.name.startsWith('books/'))return;
        const at=Date.now();if(p.processedBytes&&p.processedBytes!==p.originalBytes&&at-lastPreparationAt<100)return;lastPreparationAt=at;
        const mb=n=>(n/(1024*1024)).toFixed(2);
        onPhase(`正在压缩并加密正文（${mb(p.processedBytes)} / ${mb(p.originalBytes)} MB，${p.chunks} 个分块）`);
      }}:{}),
    };
    let created,reservation,serverSequence=server?server.lastSequence:0;
    for(let attempt=0;attempt<3;attempt++){
      createInput.deviceSequence=sync.nextSequence(state,serverSequence);
      if(options.resetChunks){await options.resetChunks();assertAccount();}
      created=await snapshot.create(createInput);assertAccount();if(options.bookObjects)require('./import-limits').validateSnapshot(created);
      onPhase('正在申请云端上传空间…',25);
      diagnostic?.phase('reserve');
      // Preparation and a sequence-conflict retry can outlive a capability
      // observation. Never admit another reservation using that old permit.
      if(overlayPlan){await overlay.assertEnabled();assertAccount();}
      try{diagnostic?.reserve();reservation=await sync.reserveSnapshot(created);break;}
      catch(error){
        assertAccount();
        if(attempt===2||error.status!==409||!['conflict','invalid_device_sequence'].includes(error.code))throw error;
        const fresh=await sync.bootstrap();assertAccount();
        const own=(fresh.devices||[]).find(row=>row.deviceId===deviceId);
        serverSequence=Math.max(serverSequence,own?own.lastSequence:0);
      }
    }
    const migrationUploads=[];
    const migratedHashes=new Set(migrated?migrated.chunks.map(c=>c.ciphertextSha256):[]);
    const directTargets=reservation.missingObjects.filter(target=>{
      if(migration && target.kind==='chunk' && migratedHashes.has(target.sha256)){migrationUploads.push(target.reservationId);return false;}return true;
    });
    diagnostic?.plan(logicalObjects.length,directTargets);diagnostic?.phase('upload');
    await require('./upload-plan').stage(created,directTargets);
    await require('./reader-upload').uploadObjects(directTargets,target=>target.kind==='manifest'?created.encryptedManifest:created.newCiphertextChunks[target.sha256]||options.loadChunk?.(target.sha256),{
      assertActive:assertAccount,
      onProgress:p=>{require('./upload-plan').progress(created.manifest.snapshotId,p);diagnostic?.progress(p);onPhase(require('./reader-upload').progressText(p),25+Math.floor(70*(p.totalBytes?p.uploaded/p.totalBytes:1)));},
    });
    if(migrationUploads.length)await appaccess.request({method:'POST',path:`/functions/v1/cloud/reader-migrations/${migration.jobId}/upload`,body:{snapshotId:created.manifest.snapshotId,reservationIds:migrationUploads},timeout:120000});
    assertAccount();
    onPhase('上传完成，正在校验并保存目录…',97);
    diagnostic?.phase('complete');
    if(overlayPlan){await overlay.assertEnabled();assertAccount();}
    // Once completion starts, finish its owner-fenced acknowledgement before
    // handing off. Preparation and immutable PUTs can stop at earlier boundaries.
    completing=true;
    await sync.completeSnapshot(created.manifest.snapshotId, snapshot.allChunks(created.manifest).map(c => c.ciphertextSha256),{r48WriteV1:!!overlayPlan});
    completed=true;completing=false;assertAccount();
    require('./upload-plan').complete(created.manifest.snapshotId);
    sync.storeManifest(created.manifest.snapshotId, created.encryptedManifest, true);
    // Do not clear pending UI edits until the records driver acknowledges them.
    return created.manifest.snapshotId;
    }catch(error){diagnostic?.finish(error);throw error;}finally{diagnostic?.finish();for(const key of ownedKeys)key.fill(0);}
  };
  let retriedPlan=false;
  const work=async()=>{for(;;){try{return await run();}catch(error){
   const lost=error.status===404&&['upload_reservation_not_found','snapshot_not_found'].includes(error.code)||error.status===400&&error.code==='reservation_expired';
   if(!lost||retriedPlan)throw error;retriedPlan=true;await sync.bootstrap();
  }}};
  if(!options.locked)preparePhase('正在等待云端同步完成');
  try{return await (options.locked?work():sync.cloudExclusive(work,{priority:'foreground'}));}finally{stopPreparation();}
}
function assertOwner(userId){const current=account.getUsableSession();if(!current || current.userId!==userId)throw new Error('账号已切换，请重新登录');}
const BULK_PATH='/functions/v1/cloud/reader-migrations/bulk';
async function migrationStatus(){return (await appaccess.request({method:'GET',path:BULK_PATH})).data || {phase:'none'};}
function activeJob(job){return job && ['queued','converting','uploading'].includes(job.phase);}
function progressText(job){
 if(job.phase==='queued')return job.queuePosition>1?`后台转换排队中，前方约 ${job.queuePosition-1} 个任务；可离开本页…`:'已加入后台转换队列，离开本页后仍会继续…';
 if(job.phase==='uploading')return `已转换 ${job.converted || 0} 篇，正在保存加密分段 ${job.chunksUploaded || 0}/${job.chunksTotal || 0}；可返回目录…`;
 return `后台转换账号旧备份：${job.sourcesDone || 0}/${job.sourcesTotal || 0}，已转换 ${job.converted || 0} 篇；可返回目录…`;
}
async function waitMigration(job,userId,onPhase,isClosed){
 while(activeJob(job)){
  assertOwner(userId);if(isClosed())throw Object.assign(new Error('已离开阅读页，云端转换仍会继续'),{code:'reader_migration_background'});
  onPhase(progressText(job));const delay=job.phase==='queued'?Math.min(15000,2500+Math.max(0,(job.queuePosition || 1)-1)*250):2000;await new Promise(resolve=>setTimeout(resolve,Math.round(delay*(0.8+Math.random()*0.4))));job=await migrationStatus();
 }
 assertOwner(userId);
 if(job.phase==='failed')throw Object.assign(new Error('旧备份转换未完成，原备份已保留'),{code:job.errorCode || 'reader_migration_failed'});
 if(!['complete','partial'].includes(job.phase))throw Object.assign(new Error('转换任务已中断，点击重试可重新发起'),{code:'reader_migration_expired'});
 return job;
}
async function startMigrationAttempt(contexts,userId,onPhase,approved=false,trace){
 for(const c of contexts){evolution.assertWrite(c.value,'manifest');for(const d of c.value.objects){evolution.assertWrite(d,'descriptor');if(d.entryRef||d.objectKeyEnvelope)throw evolution.error();}}
 onPhase('需要授权转换账号旧备份，即将打开确认窗口…');
 diagnostics.record(trace,'consent',false,'prompt',{count:contexts.length});
 if(!approved)throw Object.assign(Error('请先在手机或小程序授权旧备份转换'),{code:'reader_migration_consent_required'});
 const approval={confirm:true};
 if(!approval || !approval.confirm)throw Object.assign(new Error('已取消转换，原备份未改变'),{code:'reader_migration_declined'});
 assertOwner(userId);onPhase('正在创建后台转换任务…');
 const boot=await sync.bootstrap(),own=device.deviceId(),info=sync.resolveAccountKey(userId,own,boot);
 sync.assertUploadOwner();
 const virtual=`reader-migration-${crypto.sha256Hex(own).slice(0,24)}-v${info.keyVersion}`;
 // R14: only the physical installation is registered/attested here. The bulk
 // endpoint owns the restricted virtual identity and insert-only self envelope.
 const physical=(boot.devices||[]).find(row=>row.deviceId===own&&!row.revokedAt);
 await sync.registerDevice(own,physical&&physical.displayName||'小程序 · 本机');
 await sync.ensureOwnDeviceEnvelope(userId,own,info.accountKey,info.keyVersion,boot.keyEnvelopes);
 const root=crypto.randomBytes(32),salt=crypto.randomBytes(16),nonce=crypto.randomBytes(12),idBytes=crypto.randomBytes(16),hex=util.hexEncode(idBytes);
 const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
 const scope=`batch:${id}`,readerKeyEnvelope=Object.assign(wrapReaderKey(info.accountKey,root,scope),{scope});
 const mk=crypto.hkdfSha256(info.accountKey,salt,snapshot.manifestInfo(id),32),sources=[],seen=new Set();
 try{
  for(const context of contexts){
   // Native archives contain bodies even when library-sync.json is metadata-only.
   for(const name of [sync.OBJ.PRIVATE_LIBRARY,sync.OBJ.LIBRARY_SYNC]){
    const descriptor=context.value.objects.find(object=>object.name===name);if(!descriptor)continue;
    const signature=descriptor.chunks.map(c=>c.ciphertextSha256).join(':');if(seen.has(signature))continue;seen.add(signature);
    sources.push({consentVersion:'reader-cloud-memory-v1',snapshotId:context.head.id,articleId:'*',objectName:'reader/bulk',encoding:descriptor.encoding,originalBytes:descriptor.originalBytes,outputKeyBase64:util.base64PaddedEncode(root),chunks:descriptor.chunks.map(chunk=>({ciphertextSha256:chunk.ciphertextSha256,plaintextSha256:chunk.plaintextSha256,ciphertextBytes:chunk.ciphertextBytes,plaintextBytes:chunk.plaintextBytes,saltBase64:chunk.saltBase64,nonceBase64:chunk.nonceBase64,keyBase64:util.base64PaddedEncode(crypto.hkdfSha256(context.key,util.base64Decode(chunk.saltBase64),'watchrss/cloud/chunk/v1',32))}))});
   }
  }
  if(!sources.length)throw Object.assign(new Error('云端旧备份未找到正文对象'),{code:'reader_migration_article_missing'});
  assertOwner(userId);
  const body={manifestVersion:3,consentVersion:'reader-cloud-memory-all-v1',sourceDeviceId:virtual,keyVersion:info.keyVersion,snapshotId:id,manifestKeyBase64:util.base64PaddedEncode(mk),manifestSaltBase64:util.base64PaddedEncode(salt),manifestNonceBase64:util.base64PaddedEncode(nonce),readerKeyEnvelope,sources};
  const grant=()=>appaccess.request({method:'POST',path:BULK_PATH,timeout:30000,extraHeaders:{'x-watchrss-cloud-device-id':own},body});
  try{return(await grant()).data;}
  catch(error){
   // Existing virtual envelopes are intentionally hidden from bootstrap. Probe
   // without a fresh randomized envelope so reuse cannot cause a key conflict.
   if(error.code!=='reader_device_envelope_required')throw error;
   assertOwner(userId);
   const pair=sync.getDeviceKeyPair(userId,own);
   try{body.deviceEnvelope={...envelope.createDeviceEnvelope({accountKey:info.accountKey,userId,recipientDeviceId:virtual,recipientPublicKeyUncompressed:pair.publicKeyUncompressed,keyVersion:info.keyVersion}),recipientType:'device',recipientDeviceId:virtual,createdByDeviceId:own};}
   finally{pair.privateKey.fill(0);}
   return(await grant()).data;
  }
 }finally{root.fill(0);mk.fill(0);info.accountKey.fill(0);for(const source of sources){source.outputKeyBase64='';for(const chunk of source.chunks)chunk.keyBase64='';}}
}
function startMigration(contexts,userId,onPhase,trace){
 let attempt=0;
 return sync.withContentRebuild(async()=>{
  if(attempt++){contexts=[];for(const head of await sync.snapshotHeads())if(sync.getAccountKey(userId,head.keyVersion))contexts.push(await manifest(head,userId));}
  return startMigrationAttempt(contexts,userId,onPhase,attempt>1,trace);
 });
}
async function open(article,toText,options={}) {
 const trace=Object.prototype.hasOwnProperty.call(options,'diagnostics')?options.diagnostics:diagnostics.begin(article,options);
 try{return await openTracked(article,toText,{...options,diagnostics:trace});}
 catch(error){diagnostics.error(trace,'cloud',error);if(true&&['network_error','timeout'].includes(error.code)){const m=require('./books').member(article);if(require('./books').isLegacy(article)||m&&!storage.exists(library.bookStoragePath('books/'+m.bookId+'.jsonl')))throw Object.assign(Error('请联网后继续阅读这本书'),{code:'reader_book_online_required',cause:error});}throw error;}
}
async function openTracked(article,toText,{onPhase=()=>{},isClosed=()=>false,speculative=false,archiveOnly=false,diagnostics:trace}={}) {
 const session=account.getUsableSession();if(!session)throw new Error('请先登录账号');const userId=session.userId;
 {const cached=await require('./cloud-books').localReaderAsync(article,{isClosed,diagnostics:trace});if(cached)return cached;}
 article=library.canonicalRssArticle(article);const candidates=readerCandidates(article),names=new Set(candidates.map(objectName));
 await sync.bootstrap();
 const contexts=[];
 async function findReader(){
  const heads=(await sync.snapshotHeads()).filter(h=>sync.getAccountKey(userId,h.keyVersion)).sort((a,b)=>new Date(b.createdAt || b.completedAt || 0)-new Date(a.createdAt || a.completedAt || 0));
  diagnostics.record(trace,'cloud',!!heads.length,'selected',{count:heads.length});
  for(const head of heads){assertOwner(userId);if(isClosed())throw Error('阅读已关闭');const context=await manifest(head,userId);assertOwner(userId);if(isClosed())throw Error('阅读已关闭');contexts.push(context);}
  const overlay=require('./cloud-overlay'),inputs=await overlayInputs(contexts,userId),merged=overlay.merge(inputs);for(const c of contexts)c.overlayView=merged.selected;const selection=candidates.map(a=>merged.selected.get('article\n'+a.articleId)).find(Boolean);
  diagnostics.record(trace,'overlay',!!selection&&!selection.conflict,selection?'selected':'missing');
  if(selection&&!selection.conflict){if(selection.entry.object===null)throw Object.assign(Error('该原文已从私有归档移除'),{code:'cloud_private_body_deleted'});const options=overlayOptions(selection.context,userId);try{const value=await overlay.readArticle(options,selection.entry),local=require('./online-reader').local(toText(value)),read=local.read;local.read=page=>{options.check();return read.call(local,page);};return local;}catch(error){diagnostics.error(trace,'overlay',error);options.check();if(['cloud_session_changed','cloud_operation_cancelled','NEEDS_RECOVERY','cloud_content_rebuild_required'].includes(error.code))throw error;}finally{options.key.fill(0);}}
  for(const context of contexts){if(!evolution.readable(context.value,'manifest'))continue;const descriptor=context.value.objects.find(o=>names.has(o.name));if(descriptor&&evolution.readable(descriptor,'descriptor')){if(descriptor.entryRef||descriptor.objectKeyEnvelope||descriptor.encoding==='gzip'||descriptor.chunks?.some(c=>c.plaintextBytes>CHUNK_BYTES)){const range=await require('./snapshot-range').open({descriptor,manifest:context.value,key:context.key,check:context.check,loadChunk:async chunk=>{const remote=await sync.snapshotDownload(context.head.id,{chunk:chunk.ciphertextSha256});context.check();const target=remote.chunks.find(c=>c.sha256===chunk.ciphertextSha256);if(!target)throw evolution.error('cloud_entry_missing');return binary(target.signedUrl,chunk.ciphertextSha256,target.sizeBytes);}});return require('./book-stream').plain({range,check:context.check,onClose:()=>range.close()});}if(['gzip-chunks-v1','identity'].includes(descriptor.encoding)&&descriptor.chunks.length)return chunkReader(context,descriptor);}}
  return null;
 }
 let reader=await findReader();diagnostics.record(trace,'cloud',!!reader,reader?'opened':'missing');if(reader)return reader;
 let importedArchivesChecked=false;
 {reader=await require('./cloud-books').remoteReader(contexts.map(c=>({head:c.head,manifest:c.value,overlayView:c.overlayView})),article,userId,{isClosed,diagnostics:trace});if(reader)return reader;importedArchivesChecked=require('./merge').isImportedContentUrl(article.url)||require('./merge').isImportedContentUrl(article.rssSourceUrl);}
 // remoteReader already covered JSONL, legacy TXT and HTML for imports. A
 // second ZIP pass cannot discover a different row and only re-downloads it.
 if(!speculative&&!importedArchivesChecked)for(const context of contexts){
  if(!evolution.readable(context.value,'manifest'))continue;
  const descriptor=context.value.objects.find(object=>object.name===sync.OBJ.PRIVATE_LIBRARY);if(!descriptor||descriptor.originalBytes<22)continue;
  for(const candidate of candidates){
  const text=await require('./private-archive').readBody({descriptor,manifest:context.value,key:context.key,check:()=>{context.check();if(isClosed())throw Error('阅读已关闭');},loadChunk:async chunk=>{const selected=await sync.snapshotDownload(context.head.id,{chunk:chunk.ciphertextSha256});context.check();const remote=selected.chunks.find(row=>row.sha256===chunk.ciphertextSha256);if(!remote||remote.sizeBytes!==chunk.ciphertextBytes)throw Error('云端阅读块无效');return binary(remote.signedUrl,chunk.ciphertextSha256,remote.sizeBytes);}},candidate,toText);
  if(text){const local=require('./online-reader').local(text),read=local.read;local.read=page=>{context.check();return read.call(local,page);};return local;}
  }
 }
 if(archiveOnly){diagnostics.record(trace,'migration',false,'archive-only');return null;}
 if(require('./rss-cloud').isPublic(article))throw Object.assign(Error('收藏原文尚未备份'),{code:'reader_private_unavailable'});
 if(speculative){diagnostics.record(trace,'migration',false,'speculative');throw Object.assign(Error('正文尚未分段，跳过预加载'),{code:'reader_not_segmented'});}
 for(const context of contexts){evolution.assertRead(context.value,'manifest');for(const d of context.value.objects){evolution.assertRead(d,'descriptor');if(d.entryRef||d.objectKeyEnvelope)throw evolution.error();}}
 diagnostics.record(trace,'migration',false,'fallback',{count:contexts.length});
 let job=await migrationStatus();
 diagnostics.record(trace,'migration',activeJob(job),activeJob(job)?'queued':'missing');
 if(!activeJob(job))job=await startMigration(contexts,userId,onPhase,trace);
 const finished=await waitMigration(job,userId,onPhase,isClosed);
 onPhase('转换已保存，正在打开加密分段…');reader=await findReader();
 if(reader){if(finished.phase==='partial')reader.hint+='；部分旧正文未转换，可稍后重试，原备份保留';return reader;}
 throw Object.assign(new Error('已转换可用正文，但备份中没有本文内容，请在手机 App 中确认正文已备份'),{code:'reader_migration_article_missing'});
}
async function archiveMetadata(context,userId){
 evolution.assertRead(context.manifest,'manifest');
 const descriptor=context.manifest.objects.find(object=>object.name===sync.OBJ.PRIVATE_LIBRARY);if(!descriptor||descriptor.originalBytes<22)return[];
 const owner=cloudScope.contentCurrent(),epoch=cloudScope.load(userId)?.libraryEpoch;
 const check=()=>{cloudScope.check(owner);if(cloudScope.load(userId)?.libraryEpoch!==epoch)throw Object.assign(Error('云资料库已重置'),{code:'NEEDS_RECOVERY'});};
 if(context.manifest.settings&&context.manifest.settings.libraryEpoch&&context.manifest.settings.libraryEpoch!==epoch)throw Object.assign(Error('云快照纪元不匹配'),{code:'NEEDS_RECOVERY'});
 const key=sync.getAccountKey(userId,context.head.keyVersion);if(!key)throw Object.assign(Error('缺少正文密钥'),{code:'cloud_key_version_missing'});
 try{return await require('./private-archive').readMetadata({descriptor,manifest:context.manifest,key,check,loadChunk:async chunk=>{const selected=await sync.snapshotDownload(context.head.id,{chunk:chunk.ciphertextSha256});check();const remote=selected.chunks.find(row=>row.sha256===chunk.ciphertextSha256);if(!remote||remote.sizeBytes!==chunk.ciphertextBytes)throw Error('云端阅读块无效');return binary(remote.signedUrl,chunk.ciphertextSha256,remote.sizeBytes);}})||[];}finally{key.fill(0);}
}
async function syncSaved({scope,contexts=[],manual=false,checkBackground=()=>{}}){
 checkBackground();
 const policy=require('./rss-cloud'),own=device.deviceId(),userId=scope.userId,writerScope=cloudScope.contentCurrent();
 if(writerScope.userId!==userId)throw Error('账号已切换');
 const ownContext=contexts.find(context=>context.head.sourceDeviceId===own);
 if(ownContext)evolution.assertWrite(ownContext.manifest,'manifest');
 const before=ownContext&&ownContext.manifest.settings&&ownContext.manifest.settings.miniSavedArticleIds||[];
 const saved=library.listArticleViews().filter(article=>policy.isPublic(article)&&!article.deleted&&(article.favoriteSaved||article.watchLaterSaved));
 const ids=saved.map(article=>article.articleId).sort(),currentObjects=ownContext&&ownContext.manifest.objects||[];
 const missing=saved.filter(article=>!currentObjects.some(object=>(object.name===objectName(article)||object.name===require('./cloud-overlay').articleName(article.articleId)&&(ownContext.privateMetadata||[]).some(a=>a.articleId===article.articleId&&a.contentHash===article.contentHash)))&&!contexts.some(context=>context.head.keyVersion===sync.currentKeyVersion(userId)&&(context.privateMetadata||[]).some(value=>library.canonicalRssArticleId(value.articleId)===article.articleId&&value.contentHash===article.contentHash)));
 const removed=[...new Set(before.filter(id=>!ids.includes(library.canonicalRssArticleId(id))))];
 if(require('./cloud-overlay').localEnabled())for(const context of contexts)for(const a of context.privateMetadata||[]){const local=library.getArticleView?library.getArticleView(a.articleId):library.getArticle(a.articleId);if(local&&(local.deleted||policy.isPublic(local)&&!local.favoriteSaved&&!local.watchLaterSaved)&&Math.max(local.favoriteChangedAt||0,local.watchLaterChangedAt||0,local.deletedAt||0)>0&&!removed.includes(a.articleId)&&context.overlayView?.get('article\n'+a.articleId)?.entry.object!==null)removed.push(a.articleId);}
 const retryPath=cloudScope.path('saved-body-retries',userId),epoch=cloudScope.load(userId)?.libraryEpoch;
 const stored=storage.readJSON(retryPath,null),retries=stored&&stored.libraryEpoch===epoch&&stored.entries&&typeof stored.entries==='object'&&!Array.isArray(stored.entries)?Object.assign(Object.create(null),stored.entries):Object.create(null);
 let previousRetries=JSON.stringify(retries);const missingIds=new Set(missing.map(article=>article.articleId));
 for(const id of Object.keys(retries))if(!missingIds.has(id))delete retries[id];
 const persistRetries=()=>{cloudScope.check(writerScope);if(cloudScope.load(userId)?.libraryEpoch!==epoch)throw Object.assign(Error('云资料库已重置'),{code:'NEEDS_RECOVERY'});const serialized=JSON.stringify(retries);if(serialized!==previousRetries){storage.writeJSON(retryPath,{libraryEpoch:epoch,entries:retries});previousRetries=serialized;}};
 persistRetries();
 const readySavedArticleIds=saved.filter(article=>!missing.includes(article)).map(article=>article.articleId);
 if(true)for(const a of saved.filter(a=>!missing.includes(a))){const context=contexts.find(c=>c.manifest?.objects?.some(o=>o.name===objectName(a))||(c.privateMetadata||[]).some(v=>library.canonicalRssArticleId(v.articleId)===a.articleId&&v.contentHash===a.contentHash));const file=library.getArticleView(a.articleId)?.__bodyFile;if(context&&file)require('./storage-budget').confirm(file,{snapshotId:context.head.id});}
 if(!missing.length&&!removed.length)return{uploaded:false,pending:false,readySavedArticleIds};
 const completedAt=ownContext?new Date(ownContext.head.completedAt||ownContext.head.createdAt||0).getTime():0;
 const wait=completedAt+600000-Date.now();if(!manual&&wait>0)return{uploaded:false,pending:true,retryAfter:wait,readySavedArticleIds,pendingSavedArticleIds:missing.map(article=>article.articleId)};
 const entries=[],warnings=[],pendingSavedArticleIds=[];let nextAttemptAt=Infinity;
 for(const article of missing){
  cloudScope.check(writerScope);checkBackground();
  const now=Date.now(),fingerprint=crypto.sha256Hex(JSON.stringify([article.contentHash||'',article.url,article.rssSourceUrl]));
  const prior=retries[article.articleId],retry=prior&&prior.fingerprint===fingerprint?prior:null;
  if(prior&&!retry)delete retries[article.articleId];
  const local=(library.getArticleAsync?await library.getArticleAsync(article.articleId):library.getArticle(article.articleId))||article;
  if(!manual&&!library.hasBody(local)&&retry&&Number(retry.nextAttemptAt)>now){pendingSavedArticleIds.push(article.articleId);nextAttemptAt=Math.min(nextAttemptAt,now+Math.min(BODY_RETRY_MAX,retry.nextAttemptAt-now));continue;}
  try{
   const filled=(await require('./body').ensureArticleBody(local)).article;cloudScope.check(writerScope);checkBackground();
   const text=require('./online-reader').toText(filled);if(!text.trim())throw Object.assign(Error('收藏原文暂未取得，更改已保留'),{code:'cloud_saved_body_missing'});
   if(require('./cloud-overlay').localEnabled())await require('./cloud-overlay').packArticle({...article,...filled},text,()=>{cloudScope.check(writerScope);checkBackground();});
   entries.push({article:{...article,...filled},text});delete retries[article.articleId];
  }catch(error){
   cloudScope.check(writerScope);
   if(['cloud_foreground_pending','cloud_content_rebuild_required','NEEDS_RECOVERY','client_upgrade_required','cloud_key_commitment_mismatch','cloud_key_version_stale','cloud_library_owner_choice_required'].includes(error.code))throw error;
   const attempts=Math.min(32,(Number(retry?.attempts)||0)+1),at=Date.now(),delay=Math.min(BODY_RETRY_MAX,BODY_RETRY_MIN*Math.pow(2,attempts-1));
   const notify=!retry||!retry.lastWarningAt||at-retry.lastWarningAt>=BODY_WARNING_INTERVAL;
   retries[article.articleId]={fingerprint,attempts,nextAttemptAt:at+delay,lastWarningAt:notify?at:retry.lastWarningAt,code:error.code||'cloud_saved_body_missing'};
   pendingSavedArticleIds.push(article.articleId);nextAttemptAt=Math.min(nextAttemptAt,at+delay);
   if(notify)warnings.push({articleId:article.articleId,title:article.title,code:error.code||'cloud_saved_body_missing'});
  }
 }
 persistRetries();checkBackground();
 if(entries.length||removed.length){
  const removePrefixes=removed.flatMap(id=>[library.canonicalRssArticleId(id),...library.legacyRssArticleIds(id)].map(value=>'reader/'+crypto.sha256Hex(value).slice(0,32)+'/'));
  // Failed originals keep their previous body descriptors and saved-ID membership.
  const savedIds=ids.filter(id=>!pendingSavedArticleIds.includes(id)||before.some(old=>library.canonicalRssArticleId(old)===id));
  const published=await publish(entries[0]&&entries[0].article,entries[0]&&entries[0].text,null,userId,false,null,{entries,source:null},()=>{},{locked:true,backgroundCheck:checkBackground,removePrefixes,savedIds,removedSavedIds:removed});
  // publish returns only after completeSnapshot has succeeded on the server.
  if(true)for(const entry of entries){const current=library.getArticleView(entry.article.articleId),file=entry.article.__bodyFile;if(file&&current?.__bodyFile===file&&current.contentHash===entry.article.contentHash)require('./storage-budget').confirm(file,{snapshotId:published});}
  readySavedArticleIds.push(...entries.map(entry=>entry.article.articleId));
 }
 return{uploaded:!!(entries.length||removed.length),pending:!!pendingSavedArticleIds.length,warnings,pendingSavedArticleIds,readySavedArticleIds,deferredSavedCount:pendingSavedArticleIds.length,retryAfter:Number.isFinite(nextAttemptAt)?Math.max(1000,nextAttemptAt-Date.now()):undefined};
}
async function publishBook(entries,source,userId,onPhase){
 const books=require('./books'),fingerprint=await books.fingerprintAsync(entries.map(e=>({title:e.article.title||'',contentText:e.text,contentHtml:e.article.contentHtml||null,url:e.article.url||''}))),pendingPath=library.bookStoragePath('books/'+books.id(fingerprint)+'.jsonl');
 const existing=books.load().books[books.id(fingerprint)];if(existing)books.assertImportReadable(existing);
 require('./pending-payloads').add(pendingPath,'book-import');const release=require('./storage-budget').hold(storage.resolvePath(pendingPath));
 try{const s=await books.registerAsync(entries,source),text=await books.packageTextAsync(s.bookId);
 books.assertImportReadable(s);
 const descriptor=books.descriptor(s),oldPrefixes=entries.map(entry=>{const name=objectName(entry.article);return name.slice(0,name.lastIndexOf('/')+1);});
 const db=await books.captureAsync(entries.map(e=>e.article));
 const bytes=util.utf8ToBytes(text);
 const result=await publish(null,'',null,userId,true,null,null,onPhase,{bookObjects:[{name:descriptor.packagePath,bytes,compress:true,chunkBytes:require('./import-limits').bookChunkBytes(bytes.length),utf8Aligned:true,contentSha256:crypto.sha256Hex(text),privateBook:descriptor}],books:[s],bookReading:Object.values(db.reading).filter(r=>r.bookId===s.bookId),removePrefixes:oldPrefixes});
 await books.materializeAsync(s.bookId);if(true)require('./storage-budget').confirm(library.bookStoragePath(descriptor.packagePath),{snapshotId:result,bookId:s.bookId});return result;
 }finally{release();}
}
async function publishBookStream(prepared,userId,onPhase,check=()=>{}){
 const books=require('./books'),files=require('./import-files'),s=books.streamCandidate(prepared.book);check();
 if(s.deleted)throw Object.assign(Error('该书已删除，不能通过旧内容包恢复'),{code:'cloud_book_deleted'});
 const descriptor=books.descriptor(s),packed=prepared.package;
 const object={name:descriptor.packagePath,size:packed.size,contentSha256:packed.contentSha256,compress:true,chunkBytes:require('./import-limits').bookChunkBytes(packed.size),utf8Aligned:true,privateBook:descriptor,changedAt:s.updatedAt,
  async *stream(){const source=await files.open(packed.filePath,check);try{yield* files.bytes(source);}finally{await source.close();}}};
 // reserveSnapshot needs every chunk descriptor before any PUT. Spool only
 // ciphertext until reservation; three upload workers load one small blob each.
 const result=await publish(null,'',null,userId,true,null,null,onPhase,{bookObjects:[object],books:[s],bookReading:Object.values(books.load().reading).filter(r=>r.bookId===s.bookId),removePrefixes:prepared.entries.map(e=>{const name=objectName(e.article);return name.slice(0,name.lastIndexOf('/')+1);}),check,
  resetChunks:()=>prepared.stage.release?.(),storeChunk:(d,blob)=>prepared.stage.put(d.ciphertextSha256,blob),loadChunk:hash=>prepared.stage.get(hash)});
 check();if(prepared.stage.release)await prepared.stage.release();check();
 const budget=true?require('./storage-budget'):null,remoteOnly=storage.getMode()==='cloud'&&!!(budget&&prepared.stage.remove&&budget.overBudget());
 // complete is durable: release the full package before writing registry/index
 // metadata under pressure. The unchanged range reader can open the cloud copy.
 if(remoteOnly)await prepared.stage.remove('package');check();books.commitStream(prepared,check,{remoteOnly});if(budget){budget.confirm(library.bookStoragePath(descriptor.packagePath),{snapshotId:result,bookId:s.bookId});budget.trim();}return result;
}
// Refresh only authenticated manifests for first-upgrade storage admission.
// No book body is restored; callers can grant cache receipts for exact identities.
async function storageContexts(userId,check=()=>{}){
 const contexts=[];try{await sync.bootstrap();check();for(const head of await sync.snapshotHeads()){check();if(!sync.getAccountKey(userId,head.keyVersion))continue;contexts.push(await manifest(head,userId));check();}
  const inputs=await overlayInputs(contexts,userId),merged=require('./cloud-overlay').merge(inputs);check();return contexts.map(c=>({head:c.head,manifest:c.value,overlayView:merged.selected}));
 }finally{for(const c of contexts)c.key.fill(0);}
}
module.exports={storageContexts,overlayOptions,overlayInputs,overlayMetadata,archiveMetadata,syncSaved,startMigration,open,publish,publishBook,publishBookStream,objectName,chunkReader,wrapReaderKey,unwrapReaderKey,CHUNK_BYTES,migrationStatus,progressText};
