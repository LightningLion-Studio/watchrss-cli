// 加密云快照编解码：与 Android_WatchRSS_Phone CloudSnapshotCodec.kt 逐字节一致
// 分块 blob:  WRSSCC2 + salt(16) + nonce(12) + AES-256-GCM(明文+tag)
//   key = HKDF(ikm=accountKey, salt, info="watchrss/cloud/chunk/v1")
//   AAD = "watchrss-cloud-chunk-v1:<plaintextSha256hex>"
// 清单 blob:  WRSSCM3 + salt(16) + nonce(12) + AES-256-GCM(manifest JSON+tag)
//   key = HKDF(ikm=accountKey, salt, info="watchrss/cloud/manifest/v2/<snapshotId>")
//   WRSSCM2 with unbound v1 info remains read-only compatible (SPEC R4).
//   AAD = "watchrss-cloud-manifest-v2:<snapshotId>"
// 对象编码:  4MiB 原始切片逐片 gzip (gzip-chunks-v1) 或 identity
const crypto = require('./crypto');
const util = require('./util');
const gzip = require('./gzip');
const evolution=require('./cloud-format'),raw=evolution.raw,provenance=new WeakMap();
function scopeKey(key,version){return JSON.stringify([evolution.reuseScope(),version,crypto.sha256Hex(key)]);}
function remember(manifest,key,owner=scopeKey(key,manifest.keyVersion)){for(const d of manifest.objects||[])provenance.set(d,owner);return manifest;}

const SCHEMA_VERSION = 2;
const CHUNK_BYTES = 4 * 1024 * 1024;
// Keep index PUTs small on mobile runtimes; the existing chunk codec is unchanged.
const INDEX_CHUNK_BYTES = 128 * 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const CHUNK_MAGIC = util.utf8ToBytes('WRSSCC2');
const MANIFEST_MAGIC = util.utf8ToBytes('WRSSCM3');
const LEGACY_MANIFEST_MAGIC=util.utf8ToBytes('WRSSCM2');
const CHUNK_INFO = 'watchrss/cloud/chunk/v1';
const LEGACY_MANIFEST_INFO='watchrss/cloud/manifest/v1';
function manifestInfo(snapshotId){return 'watchrss/cloud/manifest/v2/'+snapshotId;}
const OBJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._\/-]{0,127}$/;

function manifestAad(snapshotId) {
  return util.utf8ToBytes(`watchrss-cloud-manifest-v2:${snapshotId}`);
}

function chunkAad(plaintextHash) {
  return util.utf8ToBytes(`watchrss-cloud-chunk-v1:${plaintextHash}`);
}

function chunkHeaderSize() {
  return CHUNK_MAGIC.length + SALT_BYTES + NONCE_BYTES;
}

// logicalObjects: [{ name, bytes: Uint8Array, compress: bool }]
// carried: 上一份 manifest 的对象描述符数组（原样携带，不重新加密）
async function create({
  accountKey,
  keyVersion,
  sourceDeviceId,
  deviceSequence,
  logicalObjects,
  parentHeads = {},
  observedHeads = {},
  previousManifest = null,
  carryForwardObjects = [],
  snapshotId = null,
  createdAtMillis = Date.now(),
  settings = {},
  features = undefined,
  allowEntryReferences = false,
  storeChunk = null,
  check = () => {},
  onProgress = () => {},
}) {
  if (accountKey.length !== KEY_BYTES) throw new Error('账号主密钥必须为256位');
  evolution.assertAccountWriteRoot(accountKey);
  if (!(keyVersion > 0)) throw new Error('账号密钥版本无效');
  if (!sourceDeviceId) throw new Error('设备标识不能为空');
  if (!(deviceSequence > 0)) throw new Error('设备快照序列无效');

  const owner=scopeKey(accountKey,keyVersion);
  if(previousManifest)evolution.assertWrite(previousManifest,'manifest');
  for(const object of logicalObjects){if(object.objectKeyEnvelope||object.entryRef&&!allowEntryReferences)throw evolution.error('cloud_format_write_disabled');const prior=previousManifest?.objects.find(d=>d.name===object.name);if(prior)evolution.assertWrite(prior,'descriptor');}
  const retained=(previousManifest?.objects||[]).filter(d=>!evolution.assess(d,'descriptor').write&&!carryForwardObjects.some(c=>c.name===d.name)&&!logicalObjects.some(c=>c.name===d.name));
  carryForwardObjects=carryForwardObjects.concat(retained);
  for(const d of carryForwardObjects.slice())if(d.entryRef&&evolution.readable(d,'descriptor')){if(logicalObjects.some(o=>o.name===d.entryRef.object))throw evolution.error();if(!carryForwardObjects.some(o=>o.name===d.entryRef.object)){const target=previousManifest?.objects.find(o=>o.name===d.entryRef.object);if(!target)throw evolution.error('cloud_format_invalid');carryForwardObjects.push(target);}}
  for(const d of carryForwardObjects)if(!evolution.readable(d,'descriptor')&&!Array.isArray(d.chunks)||d.chunks!==undefined&&!Array.isArray(d.chunks))throw evolution.error();
  for(const d of carryForwardObjects)if(provenance.has(d)&&provenance.get(d)!==owner)throw evolution.error('cloud_object_reuse_scope_mismatch');
  const names = logicalObjects.map((o) => o.name).concat(carryForwardObjects.map((o) => o.name));
  if(names.length>1024)throw evolution.error('cloud_overlay_capacity_pending');
  if (new Set(names).size !== names.length) throw new Error('云快照对象名称重复');

  const reusableByPlaintextHash = {};
  if (previousManifest) {
    for (const descriptor of previousManifest.objects || []) {
      if(descriptor.entryRef||descriptor.readerKeyEnvelope||descriptor.objectKeyEnvelope||!evolution.assess(descriptor,'descriptor').write||provenance.get(descriptor)!==owner||previousManifest.keyVersion!==keyVersion)continue;
      for (const chunk of descriptor.chunks || []) {
        reusableByPlaintextHash[chunk.plaintextSha256] = chunk;
      }
    }
  }

  const newChunks = {}; // ciphertextSha256 -> Uint8Array
  const objectDescriptors = [];
  for (const object of logicalObjects) {
    if (!OBJECT_NAME_PATTERN.test(object.name)) throw new Error(`云快照对象名称无效：${object.name}`);
    if(object.entryRef){if(object.bytes!==undefined)throw evolution.error('cloud_format_invalid');evolution.validateDescriptor(object,{objects:carryForwardObjects.concat(logicalObjects)});objectDescriptors.push(object);continue;}
    check();const bytes = object.stream?null:new Uint8Array(object.bytes);
    const originalBytes=object.stream?object.size:bytes.length;
    if(!Number.isSafeInteger(originalBytes)||originalBytes<0)throw new Error('云快照对象长度无效');
    const priorDescriptor=previousManifest?.objects.find(d=>d.name===object.name);
    if(!priorDescriptor?.readerKeyEnvelope&&!priorDescriptor?.objectKeyEnvelope&&!priorDescriptor?.entryRef&&priorDescriptor?.contentSha256===(object.stream?object.contentSha256:await crypto.sha256HexAsync(bytes))&&priorDescriptor.originalBytes===originalBytes&&provenance.get(priorDescriptor)===owner){objectDescriptors.push(raw.merge(priorDescriptor,{...(object.privateArticle?{privateArticle:object.privateArticle}:{}),...(object.privateBook?{privateBook:object.privateBook,...(object.privateBook.lifecycle||object.privateBook.instanceId?{features:{incompat:[...new Set([...(priorDescriptor?.features?.incompat||[]),'book-lifecycle.v1'])],roCompat:priorDescriptor?.features?.roCompat||[]}}:{})}:{})}));continue;}
    const descriptors = [];
    let encodedBytes = 0;
    let processedBytes = 0;
    onProgress({name:object.name,processedBytes,originalBytes,chunks:0});
    const chunkSize = object.chunkBytes || (object.name === 'rss-state.json' ? INDEX_CHUNK_BYTES : CHUNK_BYTES);
    if (!Number.isInteger(chunkSize) || chunkSize < 256 || chunkSize > CHUNK_BYTES) throw new Error('云快照分块大小无效');
    for await (const raw of objectChunks(object,bytes,chunkSize,check)) {
      check();await util.tick();check();
      const plaintext = object.compress ? await gzip.gzipAsync(raw) : raw;
      encodedBytes += plaintext.length;
      const plaintextHash = await crypto.sha256HexAsync(plaintext);
      const old=previousManifest?.objects.find(d=>d.name===object.name);
      const reused = old&&old.encoding===(object.compress?'gzip-chunks-v1':'identity')?reusableByPlaintextHash[plaintextHash]:null;
      if (reused) {
        descriptors.push(reused);
      } else {
        const salt = crypto.randomBytes(SALT_BYTES);
        const nonce = crypto.randomBytes(NONCE_BYTES);
        const key = crypto.hkdfSha256(accountKey, salt, CHUNK_INFO, KEY_BYTES);
        let ciphertext;try{ciphertext=await crypto.aesGcmEncryptAsync(key,nonce,plaintext,chunkAad(plaintextHash));}finally{key.fill(0);}
        const blob = util.bytesConcat([CHUNK_MAGIC, salt, nonce, ciphertext]);
        const descriptor = {
          plaintextSha256: plaintextHash,
          ciphertextSha256: await crypto.sha256HexAsync(blob),
          plaintextBytes: plaintext.length,
          ciphertextBytes: blob.length,
          saltBase64: util.base64PaddedEncode(salt),
          nonceBase64: util.base64PaddedEncode(nonce),
        };
        if(storeChunk)await storeChunk(descriptor,blob);else newChunks[descriptor.ciphertextSha256] = blob;
        check();
        descriptors.push(descriptor);
      }
      processedBytes+=raw.length;
      onProgress({name:object.name,processedBytes,originalBytes,chunks:descriptors.length});
    }
    const prior=previousManifest?.objects.find(d=>d.name===object.name);
    objectDescriptors.push(raw.merge(prior,{readerKeyEnvelope:undefined,objectKeyEnvelope:undefined,entryRef:undefined,
      ...(prior?.features?{features:{incompat:prior.features.incompat.filter(f=>!['r48.object-key.v1','r48.entry-ref.v1'].includes(f)),roCompat:prior.features.roCompat}}:{}),
      contentSha256:object.contentSha256||undefined,
      ...(object.privateArticle?{privateArticle:object.privateArticle}:{}),
      ...(object.privateBook?{privateBook:object.privateBook,...(object.privateBook.lifecycle||object.privateBook.instanceId?{features:{incompat:[...new Set([...(prior?.features?.incompat||[]).filter(f=>!['r48.object-key.v1','r48.entry-ref.v1'].includes(f)),'book-lifecycle.v1'])],roCompat:prior?.features?.roCompat||[]}}:{})}:{}),
      name: object.name,
      encoding: object.compress ? 'gzip-chunks-v1' : 'identity',
      originalBytes,
      encodedBytes,
      chunks: descriptors,
    }));
  }

  const manifest = raw.merge(previousManifest,{
    format: 'watchrss-cloud-snapshot',
    schemaVersion: SCHEMA_VERSION,
    snapshotId: snapshotId || randomSnapshotId(),
    sourceDeviceId,
    deviceSequence,
    keyVersion,
    createdAtMillis,
    parentHeads,
    observedHeads,
    objects: carryForwardObjects.concat(objectDescriptors),
    settings,
    credentialEnvelopes: previousManifest?.credentialEnvelopes||{},
    ...(features?{features:raw.merge(previousManifest?.features,features)}:{}),
  });
  if(manifest.objects.some(d=>d.name==='private/overlay-v1.json')&&!(manifest.features?.incompat||[]).includes('r48.private-overlay.v1'))throw evolution.error('cloud_format_invalid');
  evolution.assertWrite(manifest,'manifest');
  if(scopeKey(accountKey,keyVersion)!==owner)throw evolution.error('cloud_object_reuse_scope_mismatch');
  remember(manifest,accountKey,owner);

  for(const d of manifest.objects)if(evolution.readable(d,'descriptor'))evolution.validateDescriptor(d,manifest);
  const encryptedManifest = await encryptManifestAsync(accountKey, manifest);
  return { manifest, encryptedManifest, newCiphertextChunks: newChunks };
}

async function* objectChunks(object,bytes,size,check){
 if(!object.stream){for(let at=0;at<bytes.length;){let end=Math.min(bytes.length,at+size);if(object.utf8Aligned&&end<bytes.length)while(end>at&&(bytes[end]&192)===128)end--;yield bytes.slice(at,end);at=end;}return;}
 // One chunk plus UTF-8 lookahead, independent of source delivery boundaries.
 const buffer=new Uint8Array(size+4),hash=crypto.createSha256();let used=0,total=0;
 try{for await(const piece of object.stream()){
  check();if(!(piece instanceof Uint8Array)||piece.length>65536)throw Error('流式对象读取范围无效');hash.update(piece);total+=piece.length;if(total>object.size)throw Error('流式对象长度不符');
  for(let at=0;at<piece.length;){const count=Math.min(buffer.length-used,piece.length-at);buffer.set(piece.subarray(at,at+count),used);at+=count;used+=count;
   if(used>size){let end=size;if(object.utf8Aligned)while(end>0&&(buffer[end]&192)===128)end--;if(!end)throw Error('流式对象 UTF-8 边界无效');yield buffer.slice(0,end);buffer.copyWithin(0,end,used);used-=end;}
  }
 }
 if(total!==object.size||object.contentSha256&&hash.hex()!==object.contentSha256)throw Error('流式对象内容校验失败');
 if(used)yield buffer.slice(0,used);
 }finally{hash.destroy();buffer.fill(0);}
}

function randomSnapshotId() {
  const bytes = crypto.randomBytes(16);
  const hex = util.hexEncode(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function manifestToPlainText(manifest) {
  return util.utf8ToBytes(raw.stringify(manifest));
}

function encryptManifest(accountKey, manifest, {salt=crypto.randomBytes(SALT_BYTES),nonce=crypto.randomBytes(NONCE_BYTES)}={}) {
  evolution.assertAccountWriteRoot(accountKey);
  if(salt.length!==SALT_BYTES||nonce.length!==NONCE_BYTES)throw Error('清单盐或 nonce 长度无效');
  const key = crypto.hkdfSha256(accountKey, salt, manifestInfo(manifest.snapshotId), KEY_BYTES);
  const ciphertext = crypto.aesGcmEncrypt(key, nonce, manifestToPlainText(manifest), manifestAad(manifest.snapshotId));
  return util.bytesConcat([MANIFEST_MAGIC, salt, nonce, ciphertext]);
}

function decryptManifest(accountKey, snapshotId, encryptedManifest, head) {
  if (accountKey.length !== KEY_BYTES) throw new Error('账号主密钥必须为256位');
  const bytes = new Uint8Array(encryptedManifest);
  const header = MANIFEST_MAGIC.length + SALT_BYTES + NONCE_BYTES;
  if (bytes.length < header + 16) throw new Error('云快照清单损坏');
  const legacy=util.bytesEqual(bytes.slice(0, MANIFEST_MAGIC.length), LEGACY_MANIFEST_MAGIC);
  if(!legacy&&!util.bytesEqual(bytes.slice(0,MANIFEST_MAGIC.length),MANIFEST_MAGIC))throw new Error('不是腕上RSS加密云快照');
  const salt = bytes.slice(MANIFEST_MAGIC.length, MANIFEST_MAGIC.length + SALT_BYTES);
  const nonce = bytes.slice(MANIFEST_MAGIC.length + SALT_BYTES, header);
  const ciphertext = bytes.slice(header);
  const key = crypto.hkdfSha256(accountKey,salt,legacy?LEGACY_MANIFEST_INFO:manifestInfo(snapshotId),KEY_BYTES);
  const plaintext = crypto.aesGcmDecrypt(key, nonce, ciphertext, manifestAad(snapshotId));
  const text=util.bytesToUtf8(plaintext);if(!util.bytesEqual(plaintext,util.utf8ToBytes(text)))throw evolution.error('cloud_format_invalid');
  const manifest = raw.parse(text);
  if (manifest.format !== 'watchrss-cloud-snapshot') throw new Error('不是腕上RSS云快照');
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw evolution.error();
  if (manifest.snapshotId !== snapshotId) throw new Error('云快照标识不匹配');
  if(head)validateHead(manifest,head);
  if(!evolution.readable(manifest,'manifest'))return manifest;
  if(!Array.isArray(manifest.objects)||new Set(manifest.objects.map(d=>d.name)).size!==manifest.objects.length)throw evolution.error('cloud_format_invalid');
  for(const d of manifest.objects)if(evolution.readable(d,'descriptor'))evolution.validateDescriptor(d,manifest);
  return remember(manifest,accountKey);
}
function validateHead(manifest,head){
  if(manifest.snapshotId!==head.id||manifest.sourceDeviceId!==head.sourceDeviceId||manifest.deviceSequence!==head.deviceSequence||manifest.keyVersion!==head.keyVersion)throw Object.assign(Error('云快照清单与 head 不一致'),{code:'cloud_snapshot_head_mismatch'});
  if(String(head.sourceDeviceId).startsWith('reader-migration-')&&(!Array.isArray(manifest.objects)||manifest.objects.some(object=>typeof object.name!=='string'||!object.name.startsWith('reader/'))))throw Object.assign(Error('正文转换快照含不支持的对象'),{code:'reader_migration_object_invalid'});
}

// chunkLoader: (ciphertextSha256) => Uint8Array（本地缓存或远端下载后的加密块）
async function restoreObjects(accountKey, manifest, chunkLoader, onPhase) {
  evolution.assertRead(manifest,'manifest');
  const out = {},done=new Map();
  async function restore(descriptor){
    if(done.has(descriptor.name))return done.get(descriptor.name);
    evolution.assertRead(descriptor,'descriptor');evolution.validateDescriptor(descriptor,manifest);
    if(descriptor.entryRef){const source=manifest.objects.find(d=>d.name===descriptor.entryRef.object),bytes=await restore(source),zip=await require('./private-archive').zipDirectory(async(a,b)=>bytes.slice(a,b),bytes.length),body=await zip.entry(descriptor.entryRef.entryPath,32*1024*1024);if(!body)throw evolution.error('cloud_entry_missing');if(body.length!==descriptor.originalBytes)throw evolution.error('cloud_format_invalid');done.set(descriptor.name,body);return body;}
    const root=objectRoot(accountKey,descriptor),chunks=[];try{let completed=0;for(const chunk of descriptor.chunks){if(onPhase)onPhase('decrypting',`正在解密索引 ${++completed}/${descriptor.chunks.length}`);await util.tick();chunks.push(await decryptChunkAsync(root,chunk,await chunkLoader(chunk.ciphertextSha256)));}
    if(chunks.reduce((n,c)=>n+c.length,0)!==descriptor.encodedBytes)throw Error('云快照对象长度不匹配');if(onPhase)onPhase('decompressing','正在解压索引');await util.tick();let restored;
    if(descriptor.encoding==='gzip-chunks-v1'){const raw=[];for(const c of chunks)raw.push(await gzip.gunzipAsync(c));restored=util.bytesConcat(raw);}
    else if(descriptor.encoding==='gzip')restored=await gzip.gunzipAsync(util.bytesConcat(chunks));else if(descriptor.encoding==='identity')restored=util.bytesConcat(chunks);else throw evolution.error();
    if(restored.length!==descriptor.originalBytes||descriptor.contentSha256&&await crypto.sha256HexAsync(restored)!==descriptor.contentSha256)throw Error('云快照对象恢复校验失败');done.set(descriptor.name,restored);return restored;
    }finally{if(root!==accountKey)root.fill(0);}
  }
  for(const descriptor of manifest.objects)if(evolution.readable(descriptor,'descriptor'))out[descriptor.name]=await restore(descriptor);
  return out;
}
function objectRoot(accountKey,descriptor){
 evolution.assertRead(descriptor,'descriptor');if(descriptor.objectKeyEnvelope)return evolution.root(accountKey,descriptor);
 if(descriptor.readerKeyEnvelope){const e=descriptor.readerKeyEnvelope;if(e.version!==1||descriptor.objectKeyEnvelope)throw evolution.error('cloud_format_invalid');const salt=util.base64Decode(e.saltBase64),nonce=util.base64Decode(e.nonceBase64);if(salt.length!==16||nonce.length!==12)throw evolution.error('cloud_format_invalid');const key=crypto.hkdfSha256(accountKey,salt,'watchrss/cloud/reader-key/v1',32);try{const root=crypto.aesGcmDecrypt(key,nonce,util.base64Decode(e.ciphertextBase64),util.utf8ToBytes('watchrss-reader-key-v1:'+(e.scope||descriptor.name)));if(root.length!==32)throw evolution.error('cloud_format_invalid');return evolution.readOnlyRoot(root);}finally{key.fill(0);}}
 return accountKey;
}

function decryptChunk(accountKey, descriptor, blob) {
  const bytes = new Uint8Array(blob);
  if (bytes.length !== descriptor.ciphertextBytes) throw new Error('加密块长度不匹配');
  if (crypto.sha256Hex(bytes) !== descriptor.ciphertextSha256) throw new Error('加密块哈希不匹配');
  const header = chunkHeaderSize();
  if (bytes.length < header + 16) throw new Error('加密块损坏');
  if (!util.bytesEqual(bytes.slice(0, CHUNK_MAGIC.length), CHUNK_MAGIC)) throw new Error('加密块格式无效');
  const salt = bytes.slice(CHUNK_MAGIC.length, CHUNK_MAGIC.length + SALT_BYTES);
  const nonce = bytes.slice(CHUNK_MAGIC.length + SALT_BYTES, header);
  if (!util.bytesEqual(salt, util.base64Decode(descriptor.saltBase64))) throw new Error('加密块盐值不匹配');
  if (!util.bytesEqual(nonce, util.base64Decode(descriptor.nonceBase64))) throw new Error('加密块随机数不匹配');
  const key = crypto.hkdfSha256(accountKey, salt, CHUNK_INFO, KEY_BYTES);
  const plaintext = crypto.aesGcmDecrypt(key, nonce, bytes.slice(header), chunkAad(descriptor.plaintextSha256));
  if (plaintext.length !== descriptor.plaintextBytes) throw new Error('加密块明文长度不匹配');
  if (crypto.sha256Hex(plaintext) !== descriptor.plaintextSha256) throw new Error('加密块明文哈希不匹配');
  return plaintext;
}

function allChunks(manifest) {
  const seen = {};
  const out = [];
  for (const descriptor of manifest.objects || []) {
    for (const chunk of descriptor.chunks || []) {
      if (!seen[chunk.ciphertextSha256]) {
        seen[chunk.ciphertextSha256] = true;
        out.push(chunk);
      }
    }
  }
  return out;
}

module.exports = {
  objectRoot,manifestToPlainText,validateHead,manifestInfo,encryptManifest,
  SCHEMA_VERSION,
  CHUNK_BYTES,
  create,
  decryptManifest,
  restoreObjects,
  decryptChunk,
  allChunks,
  CHUNK_MAGIC,
  MANIFEST_MAGIC,
};

async function decryptChunkAsync(accountKey, descriptor, blob,check=()=>{}) {
  const bytes = new Uint8Array(blob);
  if (bytes.length !== descriptor.ciphertextBytes) throw new Error('加密块长度不匹配');
  if (await crypto.sha256HexAsync(bytes,check) !== descriptor.ciphertextSha256) throw new Error('加密块哈希不匹配');
  const header = chunkHeaderSize();
  if (bytes.length < header + 16) throw new Error('加密块损坏');
  if (!util.bytesEqual(bytes.slice(0, CHUNK_MAGIC.length), CHUNK_MAGIC)) throw new Error('加密块格式无效');
  const salt = bytes.slice(CHUNK_MAGIC.length, CHUNK_MAGIC.length + SALT_BYTES);
  const nonce = bytes.slice(CHUNK_MAGIC.length + SALT_BYTES, header);
  if (!util.bytesEqual(salt, util.base64Decode(descriptor.saltBase64))) throw new Error('加密块盐值不匹配');
  if (!util.bytesEqual(nonce, util.base64Decode(descriptor.nonceBase64))) throw new Error('加密块随机数不匹配');
  const key = crypto.hkdfSha256(accountKey, salt, CHUNK_INFO, KEY_BYTES);
  let plaintext;try{plaintext = await crypto.aesGcmDecryptAsync(key, nonce, bytes.subarray(header), chunkAad(descriptor.plaintextSha256),check);
  }finally{key.fill(0);}
  check();if (plaintext.length !== descriptor.plaintextBytes) throw new Error('加密块明文长度不匹配');
  if (await crypto.sha256HexAsync(plaintext,check) !== descriptor.plaintextSha256) throw new Error('加密块明文哈希不匹配');
  return plaintext;
}

module.exports.decryptChunkAsync=decryptChunkAsync;

async function decryptManifestAsync(accountKey, snapshotId, encryptedManifest, head,check=()=>{}) {
  if (accountKey.length !== KEY_BYTES) throw new Error('账号主密钥必须为256位');
  const bytes = new Uint8Array(encryptedManifest);
  const header = MANIFEST_MAGIC.length + SALT_BYTES + NONCE_BYTES;
  if (bytes.length < header + 16) throw new Error('云快照清单损坏');
  const legacy=util.bytesEqual(bytes.slice(0, MANIFEST_MAGIC.length), LEGACY_MANIFEST_MAGIC);
  if(!legacy&&!util.bytesEqual(bytes.slice(0,MANIFEST_MAGIC.length),MANIFEST_MAGIC))throw new Error('不是腕上RSS加密云快照');
  const salt = bytes.slice(MANIFEST_MAGIC.length, MANIFEST_MAGIC.length + SALT_BYTES);
  const nonce = bytes.slice(MANIFEST_MAGIC.length + SALT_BYTES, header);
  const ciphertext = bytes.slice(header);
  const key = crypto.hkdfSha256(accountKey,salt,legacy?LEGACY_MANIFEST_INFO:manifestInfo(snapshotId),KEY_BYTES);
  let plaintext;try{plaintext=await crypto.aesGcmDecryptAsync(key,nonce,ciphertext,manifestAad(snapshotId),check);}finally{key.fill(0);}
  let byteAt=0;const text=await require('./storage-async').utf8(plaintext,check);for(let at=0;at<text.length;){let end=Math.min(text.length,at+8192);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;const bytes=util.utf8ToBytes(text.slice(at,end));if(!util.bytesEqual(bytes,plaintext.subarray(byteAt,byteAt+bytes.length)))throw evolution.error('cloud_format_invalid');byteAt+=bytes.length;at=end;await util.tick();check();}if(byteAt!==plaintext.length)throw evolution.error('cloud_format_invalid');plaintext.fill(0);
  const manifest = await raw.parseAsync(text,check);
  if (manifest.format !== 'watchrss-cloud-snapshot') throw new Error('不是腕上RSS云快照');
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw evolution.error();
  if (manifest.snapshotId !== snapshotId) throw new Error('云快照标识不匹配');
  if(head)validateHead(manifest,head);
  if(!evolution.readable(manifest,'manifest'))return manifest;
  if(!Array.isArray(manifest.objects)||new Set(manifest.objects.map(d=>d.name)).size!==manifest.objects.length)throw evolution.error('cloud_format_invalid');
  for(const d of manifest.objects){check();if(evolution.readable(d,'descriptor'))evolution.validateDescriptor(d,manifest);await util.tick();}
  return remember(manifest,accountKey);
}
module.exports.decryptManifestAsync=decryptManifestAsync;

async function encryptManifestAsync(accountKey,manifest,{salt=crypto.randomBytes(SALT_BYTES),nonce=crypto.randomBytes(NONCE_BYTES),check=()=>{}}={}){
 evolution.assertAccountWriteRoot(accountKey);if(salt.length!==SALT_BYTES||nonce.length!==NONCE_BYTES)throw Error('清单盐或 nonce 长度无效');
 const text=await raw.stringifyAsync(manifest,check),plain=await require('./storage-async').utf8Encode(text,check),key=crypto.hkdfSha256(accountKey,salt,manifestInfo(manifest.snapshotId),KEY_BYTES);
 try{return util.bytesConcat([MANIFEST_MAGIC,salt,nonce,await crypto.aesGcmEncryptAsync(key,nonce,plain,manifestAad(manifest.snapshotId),check)]);}finally{key.fill(0);plain.fill(0);}
}
module.exports.encryptManifestAsync=encryptManifestAsync;
