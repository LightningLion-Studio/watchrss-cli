// license 设备身份：与手机端 LicenseDeviceIdentity 同形
// deviceId = 64 位 hex（本机随机 32B 的 SHA-256），P-256 密钥对持久化
const crypto = require('./crypto');
const util = require('./util');
const storage = require('./storage');

const IDENTITY_PATH = 'identity.json';

function loadOrCreate() {
  let identity = storage.readJSONCached(IDENTITY_PATH, null);
  if (identity && identity.deviceId && identity.privKeyHex) {
    return identity;
  }
  const random = crypto.randomBytes(32);
  const deviceId = crypto.sha256Hex(random);
  const keypair = crypto.generateP256KeyPair();
  identity = {
    deviceId,
    privKeyHex: util.hexEncode(keypair.privateKey),
    pubSpkiHex: util.hexEncode(keypair.spki),
  };
  storage.writeJSON(IDENTITY_PATH, identity);
  return identity;
}

function deviceId() {
  return loadOrCreate().deviceId;
}

function publicKeyPem() {
  const identity = loadOrCreate();
  return crypto.spkiToPem(util.hexDecode(identity.pubSpkiHex));
}

function privateKey() {
  const identity = loadOrCreate();
  return util.hexDecode(identity.privKeyHex);
}

// possession 签名：challenge/nonce 消息 + 长度前缀 requestHash
function possessionProof(purpose, challengeId, nonce, requestHash) {
  const message = [
    'watchrss-device-possession-v1',
    purpose,
    challengeId,
    nonce,
    deviceId(),
    requestHash,
  ].join('\n');
  const signature = crypto.signP256DerBase64Url(util.utf8ToBytes(message), privateKey());
  return { challengeId, nonce, signature };
}

module.exports = {
  loadOrCreate,
  deviceId,
  publicKeyPem,
  privateKey,
  possessionProof,
};
