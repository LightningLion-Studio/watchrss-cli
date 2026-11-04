// 云同步主循环：与 Android_WatchRSS_Phone PhoneCloudSyncService 同语义
// S8: metadata writes use records; private originals use cloud-reader.
// Legacy relay/RSS snapshots remain read-only recovery inputs.
const http = require('./http');
const util = require('./util');
const crypto = require('./crypto');
const storage = require('./storage');
const snapshot = require('./snapshot');
const payload = require('./payload');
const library = require('./library');
const envelope = require('./envelope');
const recovery = require('./recovery');
const account = require('./account');
const appaccess = require('./appaccess');
const device = require('./device');
const cloudScope=require('./cloud-scope'),v2=require('./cloud-v2'),cloudKeys=require('./cloud-keys');

const OBJ = {
  LIBRARY_SYNC: 'library-sync.json',
  RSS_STATE: 'rss-state.json',
  NOTES_STATE: 'notes-state.json',
  NOTES_ARCHIVE: 'notes-assets.zip',
  PRIVATE_LIBRARY: 'private-library.wrss',
};

// Read-only compatibility baseline. New RSS entries are fetched from the public
// pool; new user state is restored from records. Bodies are requested on demand.
const INDEX_OBJECTS = [OBJ.RSS_STATE];
// 按需取私有/导入文章正文所需的中继对象
const RELAY_OBJECTS = [OBJ.LIBRARY_SYNC];

// ---------- 云同步本地状态（对应 PhoneCloudStateStore） ----------

function loadState() {
  return Object.assign({
    deviceSequence: 0,
    appliedFull: {},
    appliedState: {},
    lastContentHashFull: null,
    lastContentHashState: null,
    lastParentHeads: null,
    retentionDays: 30,
    lastSuccessfulAt: 0,
  },storage.readJSON(cloudScope.path('sync'),null)||{});
}

function saveState(state) {
  storage.writeJSON(cloudScope.path('sync'), state);
}

function nextSequence(state, serverSequence) {
  const next = Math.max(state.deviceSequence || 0, serverSequence || 0) + 1;
  state.deviceSequence = next;
  // A reservation consumes the sequence even if a later upload fails.
  saveState(state);
  return next;
}

function appliedSequence(state, deviceId, full) {
  const map = full ? state.appliedFull : state.appliedState;
  return map[deviceId] || 0;
}

function markApplied(state, deviceId, sequence, full) {
  const map = full ? state.appliedFull : state.appliedState;
  map[deviceId] = Math.max(map[deviceId] || 0, sequence);
}

function lastContentHash(state, full) {
  return full ? state.lastContentHashFull : state.lastContentHashState;
}

function markUploaded(state, contentHash, parentHeads, full) {
  if (full) state.lastContentHashFull = contentHash;
  else state.lastContentHashState = contentHash;
  state.lastParentHeads = parentHeads;
}

// ---------- 账号主密钥 / 云同步设备密钥 ----------

function getAccountKey(userId,version){return cloudKeys.get(userId,version);}
function saveAccountKey(userId,version,keyBytes){cloudKeys.accept(userId,new Map([[version,keyBytes]]));}
function currentKeyVersion(userId){return cloudKeys.current(userId);}
function hasAccountKey(userId){return !!userId && currentKeyVersion(userId)>0;}
function clearCloudScope(userId,{dropIdentity=false,logout=false}={}){cloudKeys.lockUser(userId);cloudScope.clear(userId);if(logout)storage.removeTree(`keys/${userId}`);else if(dropIdentity){for(const dir of [cloudScope.keys(userId),`keys/${userId}`])for(const name of storage.listDir(dir))if(name.startsWith('deviceKey_'))storage.deleteFile(dir+'/'+name);}manifestMemory.clear();}
function verifiedVersions(userId){return cloudKeys.versions(userId);}
function trustInfo(userId){return cloudScope.load(userId);}
function scopedStatePath(kind,userId){return cloudScope.path(kind,userId);}
function assertUploadOwner(){return library.assertUploadOwner();}

// 云同步用 P-256 设备密钥（对应手机端 Android Keystore 中的设备密钥）
function deviceKeyPath(userId, deviceId) {
  return `${cloudScope.keys(userId)}/deviceKey_${crypto.sha256Hex(deviceId)}.json`;
}

function getDeviceKeyPair(userId, deviceId) {
  const legacy=`keys/${userId}/deviceKey_${deviceId.slice(0,16)}.json`;
  const current=storage.readJSON(deviceKeyPath(userId, deviceId),null);
  const stored=current || storage.readJSON(legacy,null);
  // Persist only a legacy migration. A normal bootstrap is a read of this key.
  if(stored){if(!current)storage.writeJSON(deviceKeyPath(userId,deviceId),stored);storage.deleteFile(legacy);}
  if (stored && stored.privHex && stored.spkiHex) {
    return { privateKey: util.hexDecode(stored.privHex), spki: util.hexDecode(stored.spkiHex), publicKeyUncompressed: util.hexDecode(stored.pubHex) };
  }
  const keypair = crypto.generateP256KeyPair();
  storage.writeJSON(deviceKeyPath(userId, deviceId), {
    privHex: util.hexEncode(keypair.privateKey),
    spkiHex: util.hexEncode(keypair.spki),
    pubHex: util.hexEncode(keypair.publicKeyUncompressed),
  });
  return { privateKey: keypair.privateKey, spki: keypair.spki, publicKeyUncompressed: keypair.publicKeyUncompressed };
}

function devicePublicKeySpkiBase64(userId, deviceId) {
  return util.base64PaddedEncode(getDeviceKeyPair(userId, deviceId).spki);
}

// ---------- HTTP 客户端 ----------

function clientRequest({ method, path, body, binary = false,extraHeaders:customHeaders={} }) {
  const extraHeaders={...customHeaders,...(method!=='GET'&&path!=='/functions/v1/cloud/bootstrap'?cloudScope.headers():{})};
  return appaccess.request({method,path,body:body===undefined?null:body,extraHeaders,responseType:binary?'arraybuffer':'text'});
}
async function bootstrap({allowRevoked=false}={}) {
  const ctx=cloudScope.current();const staged=cloudKeys.legacy(ctx.userId);for(const key of staged.values())key.fill(0);await crypto.initializeRandom();cloudScope.check(ctx);
  const res=await clientRequest({method:'POST',path:'/functions/v1/cloud/bootstrap',body:{}});cloudScope.check(ctx);
  const data=res.data,observed=cloudScope.observe(ctx.userId,data);
  const result={...data,member:data.member||{plan:'free',readable:true,writable:true},devices:Array.isArray(data.devices)?data.devices:[],keyEnvelopes:Array.isArray(data.keyEnvelopes)?data.keyEnvelopes:[]};
  const own=result.devices.find(d=>d.deviceId===device.deviceId());
  if(own&&own.revokedAt){clearCloudScope(ctx.userId,{dropIdentity:true});if(!allowRevoked)throw v2.error('cloud_device_revoked');return{...result,ownDeviceRevoked:true};}
  if(observed.changed)throw v2.error('NEEDS_RECOVERY');
  // Legacy users publish their complete held chain before any key can be used.
  if(!data.keyCommitments.length&&!observed.requireApproval&&!observed.needsRecovery){const pair=getDeviceKeyPair(ctx.userId,device.deviceId());let candidates;
    try{candidates=cloudKeys.legacyCandidates(ctx.userId,device.deviceId(),result,pair);if(candidates.size)Object.assign(result,await migrateLegacyKeys(ctx,result,candidates));}
    finally{pair.privateKey.fill(0);if(candidates)for(const key of candidates.values())key.fill(0);}
  }
  // A bootstrap always consumes newly issued envelopes, including rotations.
  try{resolveAccountKey(ctx.userId,device.deviceId(),result);}catch(error){if(error.code!=='NEEDS_RECOVERY')throw error;}
  return result;
}

// R19/R21: first publication requires every key in the visible min..max range,
// including intermediate versions absent from the sparse server-visible set.
async function migrateLegacyKeys(ctx,boot,candidates){
  const visible=new Set();
  // Newer bootstrap also includes versions known only through old snapshots or
  // records (R26); envelopes alone can understate the historical range.
  if(boot.legacyKeyVersions!==undefined){if(!Array.isArray(boot.legacyKeyVersions)||boot.legacyKeyVersions.some(version=>!Number.isInteger(version)||version<=0))throw v2.error('cloud_key_migration_required');for(const version of boot.legacyKeyVersions)visible.add(version);}
  for(const row of boot.keyEnvelopes||[]){const env=row.envelope||row;if(row.revokedAt||env.revokedAt)continue;if(!Number.isInteger(env.keyVersion)||env.keyVersion<=0)throw v2.error('cloud_key_migration_required');visible.add(env.keyVersion);}
  const versions=Array.from(candidates.keys()).sort((a,b)=>a-b);
  const visibleVersions=Array.from(visible).sort((a,b)=>a-b);
  if(!visibleVersions.length||!versions.length||versions[0]!==visibleVersions[0]||versions[versions.length-1]!==visibleVersions[visibleVersions.length-1]||versions.some((version,i)=>version<=boot.keyVersionFloor||(i&&version!==versions[i-1]+1)))return{...boot,legacyMigrationPending:true};
  const commitments=versions.map((version,i)=>{const commitment=v2.commitment(candidates.get(version),ctx.userId,boot.libraryEpoch,version);return{keyVersion:version,commitment,rotationProof:i?v2.rotationProof(candidates.get(versions[i-1]),ctx.userId,boot.libraryEpoch,version,commitment):null};});
  try{await clientRequest({method:'POST',path:'/functions/v1/cloud/keys/commitments',body:{deviceId:device.deviceId(),commitments}});}
  catch(error){if(error.code!=='key_version_exists')throw error;}
  cloudScope.check(ctx);
  // A POST acknowledgement alone does not authorize deleting durable old keys.
  const fresh=(await clientRequest({method:'POST',path:'/functions/v1/cloud/bootstrap',body:{}})).data;cloudScope.check(ctx);
  if(fresh.libraryEpoch!==boot.libraryEpoch){cloudScope.observe(ctx.userId,fresh);throw v2.error('NEEDS_RECOVERY');}
  const own=(fresh.devices||[]).find(row=>row.deviceId===device.deviceId());
  if(own&&own.revokedAt){clearCloudScope(ctx.userId,{dropIdentity:true});throw v2.error('cloud_device_revoked');}
  cloudScope.observe(ctx.userId,fresh);
  if(!fresh.keyCommitments.length)return{...fresh,legacyMigrationPending:true};
  cloudKeys.accept(ctx.userId,candidates);
  return fresh;
}

async function reregisterOwnDevice(confirmed){
  if(confirmed!==true)throw v2.error('cloud_device_reregistration_confirmation_required');
  const ctx=cloudScope.current(),boot=await bootstrap({allowRevoked:true});cloudScope.check(ctx);
  const own=(boot.devices||[]).find(row=>row.deviceId===device.deviceId());
  if(own&&!own.revokedAt){await clientRequest({method:'POST',path:`/functions/v1/cloud/devices/${encodeURIComponent(device.deviceId())}/revoke`,body:{},extraHeaders:cloudScope.headers(ctx.userId)});cloudScope.check(ctx);}
  clearCloudScope(ctx.userId,{dropIdentity:true});cloudScope.requireApproval(ctx.userId);
  await registerDevice(device.deviceId(),'WatchRSS CLI');cloudScope.check(ctx);
  return{registered:true,needsRecovery:true};
}

const r48Declarations=new Set();
function declarationId(deviceId){const ctx=cloudScope.current();return [ctx.id,ctx.userDataPath,cloudScope.load(ctx.userId)?.libraryEpoch,currentKeyVersion(ctx.userId),deviceId,JSON.stringify(require('./cloud-format').capabilities())].join(':');}
function needsFormatDeclaration(deviceId,knownDevice){if(knownDevice&&knownDevice.deviceId===deviceId&&!knownDevice.revokedAt&&Object.entries(require('./cloud-format').capabilities()).every(([name,value])=>knownDevice.capabilities?.[name]===value))return false;return !r48Declarations.has(declarationId(deviceId));}
// Discovery is truthful; writer additionally requires explicit local opt-in.
async function formatCapabilities(){try{const r=await clientRequest({method:'GET',path:'/functions/v1/cloud/format-capabilities'}),d=r.data;if(!d||d.protocol!=='watchrss-content-evolution'||d.version!==1)throw require('./cloud-format').error('cloud_format_invalid');return{...d,phaseA:{cloudFormatR48ReadV1:d.phaseA?.cloudFormatR48ReadV1===true,cloudFormatR48WriteV1:d.phaseA?.cloudFormatR48WriteV1===true,cloudArticleProvenanceReadV1:d.phaseA?.cloudArticleProvenanceReadV1===true,cloudArticleProvenanceWriteV1:d.phaseA?.cloudArticleProvenanceWriteV1===true},phaseB:{cloudFormatMigrationR48V1:false},workerSession:null};}catch(e){if(e.status===404)return{protocol:'watchrss-content-evolution',version:1,phaseA:{cloudFormatR48ReadV1:false,cloudFormatR48WriteV1:false,cloudArticleProvenanceReadV1:false,cloudArticleProvenanceWriteV1:false},phaseB:{cloudFormatMigrationR48V1:false},features:{incompat:[],roCompat:[]},workerSession:null};throw e;}}
async function registerDevice(deviceId, displayName) {
  const registrationId=declarationId(deviceId);
  const userId = account.getUsableSession().userId;
  const version=currentKeyVersion(userId),key=version?getAccountKey(userId,version):null;
  const proof=key?{attestation:v2.attest(key,userId,cloudScope.load(userId).libraryEpoch,deviceId,getDeviceKeyPair(userId,deviceId).spki),attestationKeyVersion:version}:{};if(key)key.fill(0);
  await clientRequest({
    method: 'POST',
    path: '/functions/v1/cloud/devices/register',
    body: {
      ...proof,
      deviceId,
      platform: 'phone', // 云端加密设备分类；访问使用独立小程序凭证，不占用手机授权容量
      displayName,
      publicKeySpki: devicePublicKeySpkiBase64(userId, deviceId),
      keyVersion: currentKeyVersion(userId) || 1,
      capabilities: {
        ...require('./cloud-format').capabilities(),
        snapshotSchema: 2,
        rssRecordsVersion: 1,
        cloudRelay: true,
        settings: false,
        credentialEnvelopes: false,
      },
    },
  });
  r48Declarations.add(registrationId);while(r48Declarations.size>64)r48Declarations.delete(r48Declarations.values().next().value);
}

// 后端 StoreKeyEnvelopeRequest：平铺字段（recipient_type/algorithm/… camelCase）
async function storeKeyEnvelope(kind, recipientDeviceId, createdByDeviceId, env) {
  await clientRequest({
    method: 'POST',
    path: '/functions/v1/cloud/key-envelopes',
    body: {
      recipientType: kind,
      recipientDeviceId: kind === 'device' ? recipientDeviceId : null,
      keyVersion: env.keyVersion,
      algorithm: env.algorithm,
      wrappedKeyBase64: env.wrappedKeyBase64,
      nonceBase64: env.nonceBase64,
      ephemeralPublicKeySpki: env.ephemeralPublicKeySpki || null,
      createdByDeviceId,
    },
  });
}

async function snapshotHeads() {
  const ctx=cloudScope.contentCurrent();const res = await clientRequest({ method: 'GET', path: '/functions/v1/cloud/snapshots/heads' });cloudScope.observeContent(ctx.userId,res.data);cloudScope.check(ctx);
  return Array.isArray(res.data.heads) ? res.data.heads : [];
}

async function snapshotHistory(offset = 0) {
  const ctx=cloudScope.contentCurrent();
  const res = await clientRequest({ method: 'GET', path: `/functions/v1/cloud/snapshots/heads?history=true&limit=50&offset=${offset}` });
  cloudScope.observeContent(ctx.userId,res.data);cloudScope.check(ctx);
  if (!Object.prototype.hasOwnProperty.call(res.data, 'nextOffset')) throw new Error('历史快照功能需要更新云服务');
  return { heads: Array.isArray(res.data.heads) ? res.data.heads : [], nextOffset: res.data.nextOffset };
}

async function deleteSnapshot(snapshotId) {
  await clientRequest({ method: 'DELETE', path: `/functions/v1/cloud/snapshots/${encodeURIComponent(snapshotId)}` });
}

async function snapshotDownload(snapshotId, options = {}) {
  const query = options.manifestOnly ? '?manifestOnly=true' : options.chunk ? `?chunk=${encodeURIComponent(options.chunk)}` : '';
  const res = await clientRequest({ method: 'GET', path: `/functions/v1/cloud/snapshots/${encodeURIComponent(snapshotId)}${query}` });
  const data = res.data;
  return {
    head: data.snapshot,
    manifestSignedUrl: data.snapshot.manifestSignedUrl,
    chunks: Array.isArray(data.chunks) ? data.chunks : [],
  };
}

async function reserveSnapshot(created) {
  assertUploadOwner();
  const version=currentKeyVersion(cloudScope.current().userId);if(created.manifest.keyVersion!==version)throw v2.error('cloud_key_version_stale');
  const state = loadState();
  const chunkList = snapshot.allChunks(created.manifest);
  const r48WriteV1=require('./cloud-overlay').marked(created.manifest);
  const res = await clientRequest({
    method: 'POST',
    path: '/functions/v1/cloud/snapshots/reserve',
    ...(r48WriteV1?{extraHeaders:{'x-watchrss-r48-write-v1':'1'}}:{}),
    body: {
      contentLayout:3,
      snapshotId: created.manifest.snapshotId,
      sourceDeviceId: created.manifest.sourceDeviceId,
      deviceSequence: created.manifest.deviceSequence,
      keyVersion: created.manifest.keyVersion,
      manifest: {
        sha256: crypto.sha256Hex(created.encryptedManifest),
        sizeBytes: created.encryptedManifest.length,
      },
      parentHeads: created.manifest.parentHeads,
      observedHeads: created.manifest.observedHeads,
      retentionDays: state.retentionDays || null,
      chunks: chunkList.map((c) => ({ sha256: c.ciphertextSha256, sizeBytes: c.ciphertextBytes })),
    },
  });
  const data = res.data;
  return {
    snapshotId: data.snapshotId,
    reservedBytes: Number(data.reservedBytes || 0),
    missingObjects: Array.isArray(data.missingObjects) ? data.missingObjects.map(target=>r48WriteV1?{...target,r48WriteV1:true}:target) : [],
  };
}

async function freshUploadUrl(target) {
  const id=target&&target.reservationId;
  if(typeof id!=='string'||!id||id.length>128)throw v2.error('upload_reservation_invalid');
  const ctx=cloudScope.contentCurrent();const res=await clientRequest({method:'POST',path:`/functions/v1/cloud/uploads/${encodeURIComponent(id)}/refresh`,body:{},...(target.r48WriteV1?{extraHeaders:{'x-watchrss-r48-write-v1':'1'}}:{})});
  cloudScope.check(ctx);
  if(!res.data||(res.data.reservationId!==undefined&&res.data.reservationId!==id))throw v2.error('upload_reservation_invalid');
  if(res.data.transport!==undefined&&res.data.transport!=='epoch-proxy')throw v2.error('cloud_upload_transport_required');
  if(res.data.alreadyUploaded===true)return{transport:'epoch-proxy',reservationId:id,alreadyUploaded:true,contentScope:ctx,...(target.r48WriteV1?{r48WriteV1:true}:{})};
  if(res.data.transport!=='epoch-proxy')throw v2.error('cloud_upload_transport_required');
  return{...res.data,reservationId:id,contentScope:ctx,...(target.r48WriteV1?{r48WriteV1:true}:{})};
}

async function completeSnapshot(snapshotId, chunkHashes,{r48WriteV1=false}={}) {
  await clientRequest({
    method: 'POST',
    path: '/functions/v1/cloud/snapshots/complete',
    ...(r48WriteV1?{extraHeaders:{'x-watchrss-r48-write-v1':'1'}}:{}),
    body: { snapshotId, chunkHashes },
  });
}

async function acknowledge(snapshotId, deviceId) {
  await clientRequest({
    method: 'POST',
    path: `/functions/v1/cloud/snapshots/${encodeURIComponent(snapshotId)}/ack`,
    body: { deviceId, result: 'applied' },
  });
}

// ---------- 分块 / 清单本地缓存 ----------

function loadChunk(sha) {
  return storage.readBytes(`cloud/chunks/${sha}`);
}

function storeChunk(sha, bytes) {
  storage.writeBytes(`cloud/chunks/${sha}`, bytes);
}

// Confirmed remote manifests are optional caches, never a condition of success.
const manifestMemory=new Map();
function clearManifestMemory(id){for(const name of manifestMemory.keys())if(name.startsWith(id+':'))manifestMemory.delete(name);}
cloudScope.setClearHandler(clearManifestMemory);cloudScope.setContentClearHandler(clearManifestMemory);
function loadManifest(snapshotId) {
  if(manifestMemory.has(cloudScope.current().id+':'+snapshotId))return manifestMemory.get(cloudScope.current().id+':'+snapshotId);
  return storage.readBytes(`cloud/${cloudScope.current().id}/manifests/${snapshotId}`);
}
function storeManifest(snapshotId, bytes, markAsLocalHead) {
  require('./manifest-cache').store(snapshotId,bytes);const cacheId=cloudScope.current().id+':'+snapshotId;manifestMemory.delete(cacheId);manifestMemory.set(cacheId,bytes);
  let total=Array.from(manifestMemory.values()).reduce((sum,b)=>sum+b.length,0);
  while(manifestMemory.size>4 || total>8*1024*1024){const id=manifestMemory.keys().next().value;total-=manifestMemory.get(id).length;manifestMemory.delete(id);}
  // Native sync can re-fetch the latest manifest from the server after restart.
  if(markAsLocalHead){try{storage.writeJSON(cloudScope.path('latest-manifest'),{snapshotId});}catch(_){/* derived pointer */}}
}

function loadLatestManifest() {
  const ref = storage.readJSON(cloudScope.path('latest-manifest'), null);
  if (!ref) return null;
  const bytes = loadManifest(ref.snapshotId);
  if (!bytes) return null;
  return { snapshotId: ref.snapshotId, bytes };
}

// 下载远端对象（签名 URL，二进制）
async function downloadObject(signedUrl, expectedSha, expectedSize, memoryOnly=false) {
  const res = memoryOnly ? await http.request({path:signedUrl,useBaseUrl:false,responseType:'arraybuffer',timeout:120000}) : await http.download(signedUrl);
  let bytes;
  if (res.data instanceof ArrayBuffer) {
    bytes = new Uint8Array(res.data);
  } else if (res.data) {
    // Buffer / Uint8Array（Node 测试路径）
    bytes = new Uint8Array(res.data);
  } else {
    throw Object.assign(Error('下载未返回二进制'),{code:'cloud_download_invalid'});
  }
  if (expectedSize && bytes.length !== expectedSize) throw new Error('云对象大小不匹配');
  if (expectedSha && await crypto.sha256HexAsync(bytes) !== expectedSha) throw new Error('云对象哈希不匹配');
  return bytes;
}

// ---------- 密钥解析 ----------

// 返回 { accountKey, keyVersion, source }；无密钥且无可用信封时抛 NEEDS_RECOVERY
function resolveAccountKey(userId,deviceId,bootstrapData){return cloudKeys.resolve(userId,deviceId,bootstrapData,getDeviceKeyPair(userId,deviceId));}
async function refreshAccountKey(userId,version){const existing=getAccountKey(userId,version);if(existing)return existing;await bootstrap();return getAccountKey(userId,version);}

// Recovery entropy is kept only as authenticated ciphertext under the local account key.
function savedWordsPath(userId){return `${cloudScope.keys(userId)}/recovery-words.json`;}
function saveRecoveryWords(userId,words,keyVersion){
  const entropy=recovery.decode(words),accountKey=getAccountKey(userId,keyVersion);
  if(!accountKey){entropy.fill(0);throw Error('本机尚未授权');}
  const nonce=crypto.randomBytes(12),aad=util.utf8ToBytes(`watchrss-recovery-words-v1:${userId}:${keyVersion}`);
  const key=crypto.hkdfSha256(accountKey,new Uint8Array(32),'watchrss-local-recovery-words-v1',32);
  try{storage.writeJSON(savedWordsPath(userId),{version:1,keyVersion,nonce:util.base64Encode(nonce),ciphertext:util.base64Encode(crypto.aesGcmEncrypt(key,nonce,entropy,aad))});}
  finally{entropy.fill(0);accountKey.fill(0);key.fill(0);}
}
function hasSavedRecoveryWords(userId){const saved=storage.readJSON(savedWordsPath(userId),null);if(!saved||saved.version!==1)return false;const key=getAccountKey(userId,saved.keyVersion);if(!key)return false;key.fill(0);return true;}
function readRecoveryWords(userId){
  const saved=storage.readJSON(savedWordsPath(userId),null);if(!saved||saved.version!==1)throw Error('本机未保存原始恢复词');
  const accountKey=getAccountKey(userId,saved.keyVersion);if(!accountKey)throw Error('本机尚未授权');
  const key=crypto.hkdfSha256(accountKey,new Uint8Array(32),'watchrss-local-recovery-words-v1',32);let entropy;
  try{entropy=crypto.aesGcmDecrypt(key,util.base64Decode(saved.nonce),util.base64Decode(saved.ciphertext),util.utf8ToBytes(`watchrss-recovery-words-v1:${userId}:${saved.keyVersion}`));return recovery.encode(entropy);}
  finally{accountKey.fill(0);key.fill(0);if(entropy)entropy.fill(0);}
}

// 24 词恢复（对应 recoverWithWords）
async function recoverWithWords(userId,words,bootstrapData){
  const ctx=cloudScope.current();if(ctx.userId!==userId)throw v2.error('cloud_session_changed');
  cloudScope.observe(userId,bootstrapData);
  const entropy=recovery.decode(words),recovered=new Map();
  try{for(const stored of bootstrapData.keyEnvelopes.filter(e=>e.recipientType==='recovery'&&!e.revokedAt)){const env=stored.envelope||stored;try{recovered.set(env.keyVersion,envelope.unwrapRecoveryEnvelope(env,userId,entropy));}catch(_){/* Distinct rotation words cannot unlock this version. */}}
    if(!recovered.size)throw v2.error('NEEDS_RECOVERY');
    if(!bootstrapData.keyCommitments.length){const fresh=await migrateLegacyKeys(ctx,bootstrapData,recovered);cloudScope.check(ctx);if(!fresh.keyCommitments.length)throw v2.error('cloud_key_migration_required');}
    const version=cloudKeys.accept(userId,recovered);cloudKeys.cacheVerified(userId);saveRecoveryWords(userId,words,Math.max(...recovered.keys()));return{accountKey:getAccountKey(userId,version),keyVersion:version};
  }finally{entropy.fill(0);for(const key of recovered.values())key.fill(0);}
}

// 首台设备：生成账号主密钥 + 恢复词（对应 prepareFirstDevice）
function hasExistingCloudSetup(bootstrapData) {
  const active=value=>value && typeof value==='object' && !value.revokedAt && !(value.envelope && value.envelope.revokedAt);
  return !!((bootstrapData.keyCommitments||[]).length||(bootstrapData.legacyKeyVersions||[]).length) || (bootstrapData.keyEnvelopes || []).some(active) || (bootstrapData.devices || []).some(active);
}
function setupRecoveryRequired() {
  return Object.assign(new Error('账号已有云设备或密钥，请恢复原密钥助记词，或请求已授权设备批准'),{code:'NEEDS_RECOVERY'});
}
function prepareFirstDevice(userId, bootstrapData) {
  cloudScope.observe(userId,bootstrapData);
  if (hasExistingCloudSetup(bootstrapData)) throw setupRecoveryRequired();
  const accountKey = crypto.randomBytes(32);
  const generated = recovery.generate();
  const env = envelope.createRecoveryEnvelope({
    accountKey,
    userId,
    keyVersion: (bootstrapData.keyVersionFloor||0)+1,
    recoveryEntropy: generated.entropy,
  });
  generated.entropy.fill(0);
  return { accountKey, keyVersion: env.keyVersion, libraryEpoch:bootstrapData.libraryEpoch,words: generated.words, envelope: env };
}

function sameKey(left,right) {
  if(!left || !right || left.length!==right.length)return false;
  let difference=0;for(let i=0;i<left.length;i++)difference|=left[i]^right[i];return difference===0;
}
function recoveryMatchesSetup(stored,userId,setup) {
  if(!stored || typeof stored!=='object')return false;
  const env=stored.envelope || stored;
  if(env.keyVersion!==setup.keyVersion || stored.revokedAt)return false;
  let entropy,key;
  try{entropy=recovery.decode(setup.words);key=envelope.unwrapRecoveryEnvelope(env,userId,entropy);return sameKey(key,setup.accountKey);}
  catch(_){return false;}finally{if(entropy)entropy.fill(0);if(key)key.fill(0);}
}

// No usable local key is published until both remote envelopes have succeeded.
// A response lost after recovery upload can re-enter using the same words/key;
// an unrelated recovery envelope must never be mistaken for our completed setup.
async function activateFirstDevice(userId,deviceId,setup){
 if(!setup||!setup.accountKey)throw v2.error('cloud_setup_invalid');
 const prepared={...setup,accountKey:new Uint8Array(setup.accountKey),words:Array.isArray(setup.words)?setup.words.slice():setup.words};
 try{return await activatePreparedDevice(userId,deviceId,prepared);}finally{prepared.accountKey.fill(0);if(Array.isArray(prepared.words))prepared.words.fill('');}
}
async function activatePreparedDevice(userId,deviceId,setup){
 const ctx=cloudScope.current();if(ctx.userId!==userId)throw v2.error('cloud_session_changed');
 if(!setup||!recoveryMatchesSetup(setup.envelope,userId,setup))throw v2.error('cloud_setup_invalid');
 const boot=await bootstrap();cloudScope.check(ctx);
 if(setup.libraryEpoch!==boot.libraryEpoch||setup.keyVersion<=boot.keyVersionFloor)throw setupRecoveryRequired();
 const commitment=v2.commitment(setup.accountKey,userId,boot.libraryEpoch,setup.keyVersion),row=boot.keyCommitments.find(row=>row.keyVersion===setup.keyVersion);
 if(row&&!v2.equal(row.commitment,commitment))throw setupRecoveryRequired();
 const own=boot.devices.find(d=>d.deviceId===deviceId&&!d.revokedAt);
 if(!own){await registerDevice(deviceId,'WatchRSS CLI');cloudScope.check(ctx);}
 if(!row){if(boot.keyCommitments.length||boot.keyEnvelopes.length||(boot.legacyKeyVersions||[]).length)throw setupRecoveryRequired();
   const pair=getDeviceKeyPair(userId,deviceId),env=envelope.createDeviceEnvelope({accountKey:setup.accountKey,userId,recipientDeviceId:deviceId,recipientPublicKeyUncompressed:pair.publicKeyUncompressed,keyVersion:setup.keyVersion});
   const shape=(type,e)=>({...e,recipientType:type,recipientDeviceId:type==='device'?deviceId:null,createdByDeviceId:deviceId});
   await clientRequest({method:'POST',path:'/functions/v1/cloud/keys/rotate',body:{deviceId,keyVersion:setup.keyVersion,commitment,rotationProof:null,recoveryEnvelope:shape('recovery',setup.envelope),deviceEnvelope:shape('device',env)}});cloudScope.check(ctx);
 }
 const fresh=await bootstrap();cloudScope.check(ctx);
 if(!fresh.keyCommitments.some(row=>row.keyVersion===setup.keyVersion&&v2.equal(row.commitment,commitment)))throw setupRecoveryRequired();
 cloudKeys.accept(userId,new Map([[setup.keyVersion,setup.accountKey]]));saveRecoveryWords(userId,setup.words,setup.keyVersion);
 try{await registerDevice(deviceId,'WatchRSS CLI');return{activated:true,selfAttestationPending:false};}catch(_){return{activated:true,selfAttestationPending:true};}
}

async function storeDeviceEnvelopeForSelf(userId, deviceId, accountKey, keyVersion) {
  const keypair = getDeviceKeyPair(userId, deviceId);
  const env = envelope.createDeviceEnvelope({
    accountKey,
    userId,
    recipientDeviceId: deviceId,
    recipientPublicKeyUncompressed: keypair.publicKeyUncompressed,
    keyVersion,
  });
  await storeKeyEnvelope('device', deviceId, deviceId, env);
}

// 后端 reserve 约束：账号必须存在 recovery 信封 + 本设备 device 信封（同 keyVersion），
// 否则 403 cloud_device_key_not_authorized。恢复密钥/首台设备激活后必须自存设备信封。
function ownDeviceEnvelopeMarkerPath(userId, deviceId, keyVersion) {
  return `${cloudScope.keys(userId)}/deviceEnvelope_v${keyVersion}_${deviceId.slice(0, 16)}.json`;
}

async function ensureOwnDeviceEnvelope(userId, deviceId, accountKey, keyVersion,knownEnvelopes=null) {
  const trust=cloudScope.load(userId),row=trust&&trust.keyCommitments.find(row=>row.keyVersion===keyVersion);
  if(!row||!v2.equal(v2.commitment(accountKey,userId,trust.libraryEpoch,keyVersion),row.commitment)){cloudScope.clear(userId);throw v2.error('NEEDS_RECOVERY');}
  if(Array.isArray(knownEnvelopes)) {
    if(knownEnvelopes.some(stored=>{const e=stored.envelope || stored;return stored.recipientType==='device' && stored.recipientDeviceId===deviceId && e.keyVersion===keyVersion && !stored.revokedAt;}))return;
  } else {const fresh=await bootstrap();return ensureOwnDeviceEnvelope(userId,deviceId,accountKey,keyVersion,fresh.keyEnvelopes);}
  const keypair = getDeviceKeyPair(userId, deviceId);
  const env = envelope.createDeviceEnvelope({
    accountKey,
    userId,
    recipientDeviceId: deviceId,
    recipientPublicKeyUncompressed: keypair.publicKeyUncompressed,
    keyVersion,
  });
  await storeKeyEnvelope('device', deviceId, deviceId, env);

}

function authenticatedDevices(userId,boot){
  const accepted=[],needsApproval=[];
  for(const target of boot.devices||[]){if(target.revokedAt||String(target.deviceId).startsWith('reader-migration-'))continue;let key;
    try{key=getAccountKey(userId,target.attestationKeyVersion);if(!key||!v2.equal(target.attestation,v2.attest(key,userId,boot.libraryEpoch,target.deviceId,v2.spki(target.publicKeySpki))))throw v2.error('cloud_device_attestation_invalid');accepted.push({...target});}
    catch(_){needsApproval.push(target.deviceId);}finally{if(key)key.fill(0);}
  }
  return{accepted,needsApproval};
}
async function repairDeviceEnvelopes(userId,boot){
  const ctx=cloudScope.current();if(ctx.userId!==userId)throw v2.error('cloud_session_changed');
  resolveAccountKey(userId,device.deviceId(),boot);
  const result=authenticatedDevices(userId,boot),failures=[];
  for(const target of result.accepted)for(const version of verifiedVersions(userId)){
    cloudScope.check(ctx);
    if((boot.keyEnvelopes||[]).some(row=>row.recipientType==='device'&&row.recipientDeviceId===target.deviceId&&(row.envelope||row).keyVersion===version&&!row.revokedAt))continue;
    const key=getAccountKey(userId,version);try{if(!key)throw v2.error('NEEDS_RECOVERY');const env=envelope.createDeviceEnvelope({accountKey:key,userId,recipientDeviceId:target.deviceId,recipientPublicKeyUncompressed:crypto.publicKeyUncompressedFromSpki(v2.spki(target.publicKeySpki)),keyVersion:version});await storeKeyEnvelope('device',target.deviceId,device.deviceId(),env);cloudScope.check(ctx);}
    catch(error){cloudScope.check(ctx);if(['NEEDS_RECOVERY','cloud_key_commitment_mismatch','client_upgrade_required','cloud_device_revoked','device_revoked'].includes(error.code))throw error;if(error.code!=='key_envelope_exists')failures.push({deviceId:target.deviceId,keyVersion:version,reason:error.code||'cloud_envelope_repair_failed'});}
    finally{if(key)key.fill(0);}
  }
  return{needsApproval:result.needsApproval.filter(id=>id!==device.deviceId()),failures};
}

// ---------- pull / apply ----------

async function pullHead(userId, deviceId, head, accountKey, onProgress, wanted = INDEX_OBJECTS, {memoryOnly=false,onPhase}={}) {
  // A current authenticated head + matching cached ciphertext is sufficient
  // when none of the requested logical objects exist (v3 metadata lives in records).
  const cachedBytes=loadManifest(head.id);
  if(cachedBytes && crypto.sha256Hex(cachedBytes)===head.manifestSha256 && cachedBytes.length===head.manifestSizeBytes){
    const cached=await snapshot.decryptManifestAsync(accountKey,head.id,cachedBytes,head);
    if(!wanted.length || !cached.objects.some(object=>wanted.includes(object.name)))return {manifest:cached,objects:{}};
  }else if(cachedBytes){manifestMemory.delete(cloudScope.current().id+':'+head.id);storage.deleteFile(require('./manifest-cache').file(head.id));}
  if(onPhase)onPhase('manifest','正在读取索引清单');
  const download=await snapshotDownload(head.id,{manifestOnly:true});
  let manifestBytes = loadManifest(head.id);
  if (!manifestBytes) {
    manifestBytes = await downloadObject(download.manifestSignedUrl, head.manifestSha256, head.manifestSizeBytes,memoryOnly);
    storeManifest(head.id, manifestBytes, false);
  }
  const manifest = await snapshot.decryptManifestAsync(accountKey, head.id, manifestBytes,head);
  const evolution=require('./cloud-format');
  if(!evolution.readable(manifest,'manifest'))return{manifest,objects:{},formatStatus:evolution.assess(manifest,'manifest')};
  const chunkUrls = {};
  for (const chunk of download.chunks) chunkUrls[chunk.sha256] = chunk;

  // 需要的对象（默认仅索引）
  const wantedSet = new Set(wanted);
  for(const d of manifest.objects)if(wantedSet.has(d.name)&&evolution.readable(d,'descriptor')&&d.entryRef)wantedSet.add(d.entryRef.object);
  const neededChunks = [];
  const seen = new Set();
  for (const descriptor of manifest.objects) {
    if (!wantedSet.has(descriptor.name)||!evolution.readable(descriptor,'descriptor')) continue;
    for (const chunk of descriptor.chunks||[]) {
      if (!seen.has(chunk.ciphertextSha256)) {
        seen.add(chunk.ciphertextSha256);
        neededChunks.push(chunk);
      }
    }
  }
  let downloadedBytes = 0;
  const transient=new Map();
  let chunkNumber=0;
  for(const chunk of neededChunks){
    if(onPhase)onPhase('downloading',`正在下载索引 ${++chunkNumber}/${neededChunks.length}`);
    let bytes=loadChunk(chunk.ciphertextSha256);
    if(!bytes){
      let remote=chunkUrls[chunk.ciphertextSha256];
      if(!remote){const selected=await snapshotDownload(head.id,{chunk:chunk.ciphertextSha256});remote=selected.chunks.find(c=>c.sha256===chunk.ciphertextSha256);}
      if(!remote)throw new Error(`云快照缺少加密块 ${chunk.ciphertextSha256}`);
      bytes=await downloadObject(remote.signedUrl,chunk.ciphertextSha256,chunk.sizeBytes,memoryOnly);
      if(!memoryOnly)storeChunk(chunk.ciphertextSha256,bytes);
      downloadedBytes+=bytes.length;
      if(onProgress)onProgress(chunk.ciphertextSha256,downloadedBytes);
    }
    transient.set(chunk.ciphertextSha256,bytes);
  }
  await util.tick();
  const selectedManifest=evolution.raw.merge(manifest,{objects:manifest.objects.filter(o=>wantedSet.has(o.name))});
  const objects=await snapshot.restoreObjects(accountKey,selectedManifest,sha=>{
    const bytes=transient.get(sha);if(!bytes)throw new Error(`本地缺少加密块 ${sha}`);return bytes;
  },onPhase);
  if(memoryOnly){
    // Evict only reconstructible ciphertext referenced by this ready server head.
    // Uncommitted local chunks, account keys and local operation journals stay intact.
    storeManifest(head.id,manifestBytes,false);
    if(typeof storage.listDir==='function' && typeof storage.deleteFile==='function'){
      const confirmed=new Set((manifest.objects || []).flatMap(o=>(o.chunks || []).map(c=>c.ciphertextSha256)));
      let removed=0;
      for(const name of storage.listDir('cloud/chunks')){
        if(/^[a-f0-9]{64}$/.test(name) && confirmed.has(name)){storage.deleteFile(`cloud/chunks/${name}`);if(++removed%16===0)await util.tick();}
      }
      if(/^[a-f0-9-]{36}$/i.test(head.id))storage.deleteFile(`cloud/manifests/${head.id}`);
    }
  }
  return { manifest, objects, downloadedBytes };
}

// 按需拉取最新可解密快照的中继库（library-sync.json），用于私有/导入文章的正文
async function downloadRelayLibrary(userId, deviceId, onProgress) {
  if (!account.getUsableSession()) throw new Error('请先登录账号');
  const heads = (await snapshotHeads()).filter((h) => getAccountKey(userId, h.keyVersion));
  if (heads.length === 0) throw new Error('暂无可解密的云快照');
  heads.sort((a, b) => b.deviceSequence - a.deviceSequence);
  const head = heads[0];
  const pulled = await pullHead(userId, deviceId, head, getAccountKey(userId, head.keyVersion), onProgress, RELAY_OBJECTS);
  if (!pulled.objects[OBJ.LIBRARY_SYNC]) throw new Error('该快照不含中继库对象');
  return payload.parseLibrarySync(pulled.objects[OBJ.LIBRARY_SYNC]);
}

// 应用拉取到的对象到本地库
function applyPulledObjects(objects) {
  let changed = false;
  let rssPending = 0;
  let createdStubs = 0;
  if (objects[OBJ.LIBRARY_SYNC]) {
    const relay = payload.parseLibrarySync(objects[OBJ.LIBRARY_SYNC]);
    const relaySources = relay.rssSources.map((s) => Object.assign({}, s, { __syncedSettingsIncluded: true }));
    const mergedSources = library.mergeSources(relaySources);
    const mergedArticles = library.mergeArticles(relay.articles);
    changed = changed || mergedSources > 0 || mergedArticles > 0;
  }
  if (objects[OBJ.RSS_STATE]) {
    const state = payload.parseRssState(objects[OBJ.RSS_STATE]);
    library.mergeSources(
      state.sources.map((s) => Object.assign({}, s, { __syncedSettingsIncluded: true }))
    );
    const result = library.applyRssStates(state.articles);
    rssPending = result.pending;
    createdStubs = result.created;
    changed = changed || result.applied > 0 || result.created > 0;
  }
  return { changed, rssPending, createdStubs };
}

// S1/S4: metadata uses the same records driver as foreground actions. There is
// no second legacy whole-library snapshot publisher behind syncNow.
async function performSync(options={}) {
  const result=await require('./cloud-library').flush({force:!!options.manual});
  const value={...result,downloadedBytes:0,uploadedBytes:0,snapshotsApplied:0,snapshotSkipped:!result.snapshotUploaded};
  if(options.onPhase)options.onPhase({phase:result.pending?'saving':'complete',message:result.pending?'部分更改尚未提交':'云同步完成',...value});
  return value;
}

let inFlightSync = null;

// 同一时刻只跑一个云同步：页面操作、启动后台更新可共享同一个任务。
function syncNow(options = {}) {
  if (inFlightSync) return inFlightSync;
  inFlightSync = performSync(options).finally(() => {
    inFlightSync = null;
  });
  return inFlightSync;
}

// Serialize all snapshot writers, including online-reader format upgrades.
const cloudQueue=[],cloudForegroundHolds=new Set();let cloudRunning=false;
function heldCloudForeground(){
 const session=account.getUsableSession(),host=storage.root;
 for(const hold of cloudForegroundHolds)if(!session||hold.host!==host||hold.userId!==session.userId||hold.accessToken!==session.accessToken||hold.backend!==cloudScope.backend())cloudForegroundHolds.delete(hold);
 return cloudForegroundHolds.size>0;
}
function holdCloudForeground(){
 const session=account.getUsableSession();if(!session)return()=>{};
 const hold={host:storage.root,userId:session.userId,accessToken:session.accessToken,backend:cloudScope.backend()};cloudForegroundHolds.add(hold);let released=false;
 return()=>{if(released)return;released=true;cloudForegroundHolds.delete(hold);runCloudQueue();};
}
function cloudForegroundPending(){return heldCloudForeground()||cloudQueue.some(entry=>entry.foreground);}
function runCloudQueue(){
  if(cloudRunning||!cloudQueue.length)return;
  const foreground=cloudQueue.findIndex(entry=>entry.foreground);if(foreground<0&&heldCloudForeground())return;const entry=cloudQueue.splice(foreground<0?0:foreground,1)[0];
  cloudRunning=true;
  Promise.resolve().then(()=>withContentRebuild(entry.task)).then(entry.resolve,entry.reject).finally(()=>{cloudRunning=false;runCloudQueue();});
}
function cloudExclusive(task,{priority}={}) {
  return new Promise((resolve,reject)=>{cloudQueue.push({task,resolve,reject,foreground:priority==='foreground'});runCloudQueue();});
}

let contentOperation=null;
async function withContentRebuild(task){
 if(contentOperation)return task();
 const operation={retried:false},ctx=cloudScope.current();contentOperation=operation;
 try{for(;;){try{return await task();}catch(error){
  cloudScope.check({...ctx,contentGeneration:undefined});
  if(error.code!=='cloud_content_rebuild_required'||operation.retried)throw error;
  operation.retried=true;await module.exports.bootstrap();cloudScope.check({...ctx,contentGeneration:undefined});cloudScope.forceContentRebuild(ctx.userId);
 }}}finally{if(contentOperation===operation)contentOperation=null;}
}
const FRESH_INTERVAL_MS = 15 * 60 * 1000;

function lastSuccessfulAt() {
  return Number(loadState().lastSuccessfulAt || 0);
}

function needsRefresh(now = Date.now(), maxAgeMs = FRESH_INTERVAL_MS) {
  const state = loadState();
  const localLibraryMissing =
    !library.isDirty() &&
    library.listArticleViews({includeDeleted:true}).length === 0 &&
    library.listSources({ includeDeleted: true }).length === 0 &&
    Object.keys(state.appliedState || {}).length > 0;
  if (localLibraryMissing) return true;
  const last = lastSuccessfulAt();
  return !last || now - last >= maxAgeMs;
}

function syncIfStale(options = {}) {
  if (!needsRefresh(options.now, options.maxAgeMs)) {
    return Promise.resolve({ skippedFresh: true, lastSuccessfulAt: lastSuccessfulAt() });
  }
  return syncNow(options);
}

module.exports = {
  cloudExclusive,cloudForegroundPending,holdCloudForeground,withContentRebuild,
  sanitizeLegacyStorage:cloudKeys.sanitizeLegacyStorage,
  cloudLifecycle:()=>cloudScope.current().lifecycle,
  lockSessionKeys:userId=>{const id=userId||(account.loadSession()||{}).userId;if(id){cloudScope.suspend(id);cloudKeys.lockUser(id);}},
  reregisterOwnDevice,authenticatedDevices,repairDeviceEnvelopes,clearCloudScope,verifiedVersions,trustInfo,scopedStatePath,assertUploadOwner,refreshAccountKey,
  snapshotDownload,
  reserveSnapshot,
  freshUploadUrl,
  completeSnapshot,
  nextSequence,
  storeManifest,
  loadManifest,
  OBJ,
  INDEX_OBJECTS,
  RELAY_OBJECTS,
  downloadRelayLibrary,
  loadState,
  saveState,
  getAccountKey,
  saveAccountKey,
  currentKeyVersion,
  hasAccountKey,
  getDeviceKeyPair,
  bootstrap,
  needsFormatDeclaration,formatCapabilities,registerDevice,
  storeKeyEnvelope,
  snapshotHeads,
  snapshotHistory,
  deleteSnapshot,
  resolveAccountKey,
  recoverWithWords,
  saveRecoveryWords,hasSavedRecoveryWords,readRecoveryWords,
  prepareFirstDevice,
  hasExistingCloudSetup,
  activateFirstDevice,
  ensureOwnDeviceEnvelope,
  ownDeviceEnvelopeMarkerPath,
  pullHead,
  applyPulledObjects,
  syncNow,
  syncIfStale,
  lastSuccessfulAt,
  needsRefresh,
  FRESH_INTERVAL_MS,
  loadChunk,
  storeChunk,
};
