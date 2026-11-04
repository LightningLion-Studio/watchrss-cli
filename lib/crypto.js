// 密码学核心：P-256（ECDSA + ECDH）、HKDF-SHA256、AES-256-GCM、随机数
// 与 Rust/Android 端互操作性已通过 Node 独立实现交叉验证（tests/crypto.test.mjs）
const { p256, sha256, hmac, gcm } = require('../vendor/noble-crypto');
const util = require('./util');

let randomKey = null;
let randomValue = null;
let randomInit = null;

function hmacBytes(key, data) {
  return hmac(sha256, key, data);
}

function updateRandomGenerator(seed) {
  // NIST HMAC-DRBG (SHA-256) update, seeded only from a platform CSPRNG.
  const zero = new Uint8Array([0]);
  const one = new Uint8Array([1]);
  randomKey = hmacBytes(randomKey, util.bytesConcat([randomValue, zero, seed]));
  randomValue = hmacBytes(randomKey, randomValue);
  if (seed && seed.length) {
    randomKey = hmacBytes(randomKey, util.bytesConcat([randomValue, one, seed]));
    randomValue = hmacBytes(randomKey, randomValue);
  }
}

function getPlatformRandomValues(length) {return Promise.resolve(new Uint8Array(require('node:crypto').randomBytes(length)));}

function initializeRandom() {
  const webCrypto = typeof globalThis !== 'undefined' && globalThis.crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') return Promise.resolve();
  if (randomKey && randomValue) return Promise.resolve();
  if (randomInit) return randomInit;
  randomInit = getPlatformRandomValues(32).then((seed) => {
    randomKey = new Uint8Array(32);
    randomValue = new Uint8Array(32).fill(1);
    updateRandomGenerator(seed);
    seed.fill(0);
  }).catch((err) => {
    randomInit = null;
    throw err;
  });
  return randomInit;
}

// 注意：Web Crypto getRandomValues 单次上限 65536 字节，需分块填充
function randomBytes(length) {
  const webCrypto = typeof globalThis !== 'undefined' && globalThis.crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    const out = new Uint8Array(length);
    const LIMIT = 65536;
    for (let offset = 0; offset < length; offset += LIMIT) {
      webCrypto.getRandomValues(out.subarray(offset, Math.min(length, offset + LIMIT)));
    }
    return out;
  }
  if (!randomKey || !randomValue) throw new Error('安全随机数尚未初始化');
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 32) {
    randomValue = hmacBytes(randomKey, randomValue);
    out.set(randomValue.subarray(0, Math.min(32, length - offset)), offset);
  }
  updateRandomGenerator(new Uint8Array(0));
  return out;
}

function sha256Hex(input) {
  const bytes = typeof input === 'string' ? util.utf8ToBytes(input) : new Uint8Array(input);
  return util.hexEncode(sha256(bytes));
}

// Callers own the digest and must destroy it on cancellation as well as success.
function createSha256() {
  const digest=sha256.create();
  return {update(bytes){digest.update(bytes);return this;},hex(){return util.hexEncode(digest.digest());},destroy(){digest.destroy();}};
}

// 与 Rust 端 hash_fields / Kotlin devicePossessionRequestHash 完全一致：
// 每字段写入 8 字节大端长度 + 字段 UTF-8 字节，顺序接入同一个 SHA-256
function sha256LengthPrefixedHex(fields) {
  const digest = sha256.create();
  for (const field of fields) {
    const bytes = util.utf8ToBytes(String(field));
    const len = new Uint8Array(8);
    let value = BigInt(bytes.length);
    for (let i = 7; i >= 0; i -= 1) {
      len[i] = Number(value & 0xffn);
      value >>= 8n;
    }
    digest.update(len);
    digest.update(bytes);
  }
  return util.hexEncode(digest.digest());
}

function hmacSha256(key, data) {
  const keyBytes = typeof key === 'string' ? util.utf8ToBytes(key) : new Uint8Array(key);
  const dataBytes = typeof data === 'string' ? util.utf8ToBytes(data) : new Uint8Array(data);
  return hmac(sha256, keyBytes, dataBytes);
}

// RFC 5869 HKDF-SHA256（extract + expand）
function hkdfSha256(ikm, salt, info, length) {
  if (!(length >= 1 && length <= 255 * 32)) throw new Error('HKDF输出长度无效');
  const ikmBytes = typeof ikm === 'string' ? util.utf8ToBytes(ikm) : new Uint8Array(ikm);
  const saltBytes = typeof salt === 'string' ? util.utf8ToBytes(salt) : new Uint8Array(salt);
  const infoBytes = typeof info === 'string' ? util.utf8ToBytes(info) : new Uint8Array(info);
  const prk = saltBytes.length > 0 ? hmacSha256(saltBytes, ikmBytes) : hmacSha256(new Uint8Array(32), ikmBytes);
  const blocks = [];
  let previous = new Uint8Array(0);
  let counter = 1;
  for (;;) {
    const input = util.bytesConcat([previous, infoBytes, new Uint8Array([counter])]);
    previous = hmacSha256(prk, input);
    blocks.push(previous);
    if (blocks.reduce((s, b) => s + b.length, 0) >= length) break;
    counter += 1;
    if (counter > 255) throw new Error('HKDF expand 溢出');
  }
  return util.bytesConcat(blocks).slice(0, length);
}

function aesGcmEncrypt(key, nonce, plaintext, aad = new Uint8Array(0)) {
  const { encrypt } = gcm(key, nonce, aad);
  return encrypt(plaintext); // 返回 ciphertext || tag(16B)
}

function aesGcmDecrypt(key, nonce, ciphertextWithTag, aad = new Uint8Array(0)) {
  const { decrypt } = gcm(key, nonce, aad);
  return decrypt(ciphertextWithTag); // tag 校验失败会抛错
}

// ---------- P-256 ----------

// X.509 SubjectPublicKeyInfo 固定前缀（P-256 + 未压缩点，共 26 字节 + 65 字节点）
const SPKI_PREFIX = new Uint8Array([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
  0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03,
  0x42, 0x00,
]);

function generateP256KeyPair() {
  const privateKey = p256.utils.randomPrivateKey(randomBytes(48));
  const publicKeyUncompressed = p256.getPublicKey(privateKey, false);
  const spki = util.bytesConcat([SPKI_PREFIX, publicKeyUncompressed]);
  return { privateKey, publicKeyUncompressed, spki, spkiPem: spkiToPem(spki) };
}

function spkiToPem(spkiBytes) {
  // PEM 使用标准 base64（带填充），与 Java Base64.getEncoder() 一致
  let b64 = util.base64Encode(spkiBytes);
  const pad = (4 - (b64.length % 4)) % 4;
  b64 += '='.repeat(pad);
  const lines = b64.match(/.{1,64}/g) || [];
  return '-----BEGIN PUBLIC KEY-----\n' + lines.join('\n') + '\n-----END PUBLIC KEY-----';
}

function pemToSpki(pem) {
  const clean = String(pem).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  return util.base64Decode(clean);
}

// Android 端 SHA256withECDSA 的等价实现：先 SHA-256 再对摘要签名，输出 DER，
// base64url 无填充编码（Rust 端 Signature::from_der + URL_SAFE_NO_PAD 验证）
function signP256DerBase64Url(messageBytes, privateKey) {
  const digest = sha256(new Uint8Array(messageBytes));
  const sig = p256.sign(digest, privateKey, { lowS: true });
  return util.base64UrlEncode(sig.toDERRawBytes());
}

function signP256CompactBase64(message, privateKey) {
  return util.base64PaddedEncode(p256.sign(sha256(new Uint8Array(message)),privateKey,{lowS:true}).toCompactRawBytes());
}
function verifyP256Compact(message, signature, spki) {
  try { return p256.verify(signature,sha256(new Uint8Array(message)),publicKeyUncompressedFromSpki(spki),{lowS:false}); }
  catch (_) { return false; }
}

// ECDH 原始 X 坐标（32B），与 Android KeyAgreement ECDH 输出一致
function p256SharedSecretX(privateKey, publicKeyUncompressed) {
  const point = p256.getSharedSecret(privateKey, publicKeyUncompressed, false);
  return point.slice(1, 33);
}

function publicKeyUncompressedFromSpki(spkiBytes) {
  const bytes = new Uint8Array(spkiBytes);
  if (bytes.length !== 91) throw new Error('SPKI 公钥格式无效');
  for (let i = 0; i < SPKI_PREFIX.length; i += 1) {
    if (bytes[i] !== SPKI_PREFIX[i]) throw new Error('SPKI 公钥格式无效');
  }
  if (bytes[26] !== 0x04) throw new Error('仅支持未压缩 P-256 公钥');
  return bytes.slice(26, 91);
}

module.exports = {
  initializeRandom,
  randomBytes,
  sha256Hex,
  createSha256,
  sha256LengthPrefixedHex,
  hmacSha256,
  hkdfSha256,
  aesGcmEncrypt,
  aesGcmDecrypt,
  generateP256KeyPair,
  spkiToPem,
  pemToSpki,
  signP256DerBase64Url,
  signP256CompactBase64,
  verifyP256Compact,
  p256SharedSecretX,
  publicKeyUncompressedFromSpki,
  SPKI_PREFIX,
};

const taskProbe=require('./longtask');if(taskProbe.instrument)taskProbe.instrument(module.exports,'crypto');

async function sha256HexAsync(input,check=()=>{}){
 const hash=sha256.create(),cpu=require('./cooperative');let deadline=Date.now()+4;
 try{if(typeof input==='string'){for(let i=0;i<input.length;){let end=Math.min(input.length,i+8192);if(end<input.length&&/[\uD800-\uDBFF]/.test(input[end-1]))end--;check();require('./longtask').run('cpu.SHA256',end-i,()=>hash.update(util.utf8ToBytes(input.slice(i,end))));i=end;if(Date.now()>=deadline){await cpu.turn();check();deadline=Date.now()+4;}}}
 else{const bytes=new Uint8Array(input);for(let i=0;i<bytes.length;i+=16384){check();require('./longtask').run('cpu.SHA256',Math.min(16384,bytes.length-i),()=>hash.update(bytes.subarray(i,i+16384)));if(Date.now()>=deadline){await cpu.turn();check();deadline=Date.now()+4;}}}check();return util.hexEncode(hash.digest());}finally{hash.destroy();}
}
// The same AES-256-GCM bytes as noble.gcm, split only at full AES/GHASH blocks.
// Authentication completes before any plaintext is released to the caller.
async function aesGcmAsync(decrypt,key,nonce,input,aad=new Uint8Array(0),check=()=>{}){
 if(nonce.length!==12)throw Error('Async GCM requires a 96-bit nonce');
 let deadline=Date.now()+4;
 const {ctr,ghash}=require('../vendor/noble-crypto'),cpu=require('./cooperative'),secret=new Uint8Array(key),zero=new Uint8Array(16),counter=new Uint8Array(16);counter.set(nonce);counter[15]=1;
 const auth=ctr(secret,zero).encrypt(zero),mask=ctr(secret,counter).encrypt(zero),data=decrypt?input.subarray(0,input.length-16):input;
 if(decrypt&&input.length<16){secret.fill(0);auth.fill(0);mask.fill(0);throw Error('aes/gcm: invalid ciphertext');}
 const h=ghash.create(auth,data.length+aad.length),out=new Uint8Array(data.length+(decrypt?0:16));let success=false;
 try{
  for(let at=0;at<aad.length;at+=16384){check();require('./longtask').run('cpu.GCM.AAD',Math.min(16384,aad.length-at),()=>h.update(aad.subarray(at,at+16384)));if(Date.now()>=deadline){await cpu.turn();check();deadline=Date.now()+4;}}
  for(let at=0;at<data.length;at+=16384){check();require('./longtask').run('cpu.GCM.block',Math.min(16384,data.length-at),()=>{new DataView(counter.buffer).setUint32(12,2+at/16,false);const block=data.subarray(at,at+16384),value=ctr(secret,counter).encrypt(block);out.set(value,at);h.update(decrypt?block:value);value.fill(0);});if(Date.now()>=deadline){await cpu.turn();check();deadline=Date.now()+4;}}
  check();const lengths=new Uint8Array(16),v=new DataView(lengths.buffer);v.setUint32(0,Math.floor(aad.length/0x20000000),false);v.setUint32(4,(aad.length*8)>>>0,false);v.setUint32(8,Math.floor(data.length/0x20000000),false);v.setUint32(12,(data.length*8)>>>0,false);h.update(lengths);const tag=h.digest();for(let i=0;i<16;i++)tag[i]^=mask[i];
  if(decrypt){if(!util.bytesEqual(tag,input.subarray(input.length-16)))throw Error('aes/gcm: invalid ghash tag');}else out.set(tag,data.length);tag.fill(0);success=true;return out;
 }finally{if(!success)out.fill(0);secret.fill(0);auth.fill(0);mask.fill(0);counter.fill(0);h.destroy();}
}
Object.assign(module.exports,{sha256HexAsync,aesGcmEncryptAsync:(key,nonce,input,aad,check)=>aesGcmAsync(false,key,nonce,input,aad,check),aesGcmDecryptAsync:(key,nonce,input,aad,check)=>aesGcmAsync(true,key,nonce,input,aad,check)});
async function hashLP4Async(strings,check=()=>{}){
 const digest=sha256.create(),cpu=require('./cooperative');let deadline=Date.now()+4;try{for(const text of strings){const length=await cpu.run(util.utf8ByteLengthSteps(text),'cpu.UTF8.length',check),prefix=new Uint8Array(4);new DataView(prefix.buffer).setUint32(0,length,false);digest.update(prefix);
  for(let at=0;at<text.length;){let end=Math.min(text.length,at+8192);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;check();require('./longtask').run('cpu.book.SHA256',end-at,()=>digest.update(util.utf8ToBytes(text.slice(at,end))));at=end;if(Date.now()>=deadline){await cpu.turn();check();deadline=Date.now()+4;}}}
 check();return util.hexEncode(digest.digest());}finally{digest.destroy();}
}
module.exports.hashLP4Async=hashLP4Async;
