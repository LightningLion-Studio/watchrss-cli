// 账号主密钥信封：与 Android_WatchRSS_Phone CloudKeyEnvelopeCodec.kt 一致
// 恢复信封：HKDF(ikm=32B恢复熵, salt=sha256(userId)原始字节, info=watchrss/recovery-envelope/v{keyVersion})
// 设备信封：ECDH P-256 原始X + HKDF(ikm=SS, salt=sha256(userId)原始字节, info=watchrss/device-envelope/v{keyVersion}/{deviceId})
// GCM AAD 统一为 watchrss-account-key:{userId}:{keyVersion}:{recipient}
const crypto = require('./crypto');
const util = require('./util');

const RECOVERY_ALGORITHM = 'HKDF-SHA256+A256GCM';
const DEVICE_ALGORITHM = 'P-256+HKDF-SHA256+A256GCM';

function userIdSalt(userId) {
  // salt = sha256(userId 字符串) 的原始 32 字节
  return util.hexDecode(crypto.sha256Hex(util.utf8ToBytes(userId)));
}

function envelopeAad(userId, keyVersion, recipient) {
  return util.utf8ToBytes(`watchrss-account-key:${userId}:${keyVersion}:${recipient}`);
}

function validateAccountKey(key) {
  if (!(key && key.length === 32)) throw new Error('账号主密钥必须为256位');
}

// ---- 恢复信封 ----
function createRecoveryEnvelope({ accountKey, userId, keyVersion, recoveryEntropy }) {
  validateAccountKey(accountKey);
  if (recoveryEntropy.length !== 32) throw new Error('恢复密钥熵必须为256位');
  const nonce = crypto.randomBytes(12);
  const wrappingKey = crypto.hkdfSha256(
    recoveryEntropy,
    userIdSalt(userId),
    `watchrss/recovery-envelope/v${keyVersion}`,
    32
  );
  const wrapped = crypto.aesGcmEncrypt(wrappingKey, nonce, accountKey, envelopeAad(userId, keyVersion, 'recovery'));
  return {
    algorithm: RECOVERY_ALGORITHM,
    keyVersion,
    wrappedKeyBase64: util.base64PaddedEncode(wrapped),
    nonceBase64: util.base64PaddedEncode(nonce),
  };
}

function unwrapRecoveryEnvelope(envelope, userId, recoveryEntropy) {
  if (envelope.algorithm !== RECOVERY_ALGORITHM) throw new Error('恢复密钥信封算法不受支持');
  const wrappingKey = crypto.hkdfSha256(
    recoveryEntropy,
    userIdSalt(userId),
    `watchrss/recovery-envelope/v${envelope.keyVersion}`,
    32
  );
  const accountKey = crypto.aesGcmDecrypt(
    wrappingKey,
    util.base64Decode(envelope.nonceBase64),
    util.base64Decode(envelope.wrappedKeyBase64),
    envelopeAad(userId, envelope.keyVersion, 'recovery')
  );
  validateAccountKey(accountKey);
  return accountKey;
}

// ---- 设备信封 ----
function createDeviceEnvelope({ accountKey, userId, recipientDeviceId, recipientPublicKeyUncompressed, keyVersion }) {
  validateAccountKey(accountKey);
  const ephemeral = crypto.generateP256KeyPair();
  const sharedSecret = crypto.p256SharedSecretX(ephemeral.privateKey, recipientPublicKeyUncompressed);
  const nonce = crypto.randomBytes(12);
  const wrappingKey = crypto.hkdfSha256(
    sharedSecret,
    userIdSalt(userId),
    `watchrss/device-envelope/v${keyVersion}/${recipientDeviceId}`,
    32
  );
  const wrapped = crypto.aesGcmEncrypt(wrappingKey, nonce, accountKey, envelopeAad(userId, keyVersion, recipientDeviceId));
  return {
    algorithm: DEVICE_ALGORITHM,
    keyVersion,
    wrappedKeyBase64: util.base64PaddedEncode(wrapped),
    nonceBase64: util.base64PaddedEncode(nonce),
    ephemeralPublicKeySpki: util.base64PaddedEncode(ephemeral.spki),
  };
}

function unwrapDeviceEnvelope(envelope, userId, recipientDeviceId, recipientPrivateKey) {
  if (envelope.algorithm !== DEVICE_ALGORITHM) throw new Error('设备密钥信封算法不受支持');
  if (!envelope.ephemeralPublicKeySpki) throw new Error('设备密钥信封缺少临时公钥');
  const ephemeralSpki = util.base64Decode(envelope.ephemeralPublicKeySpki);
  const ephemeralPub = crypto.publicKeyUncompressedFromSpki(ephemeralSpki);
  const sharedSecret = crypto.p256SharedSecretX(recipientPrivateKey, ephemeralPub);
  const wrappingKey = crypto.hkdfSha256(
    sharedSecret,
    userIdSalt(userId),
    `watchrss/device-envelope/v${envelope.keyVersion}/${recipientDeviceId}`,
    32
  );
  const accountKey = crypto.aesGcmDecrypt(
    wrappingKey,
    util.base64Decode(envelope.nonceBase64),
    util.base64Decode(envelope.wrappedKeyBase64),
    envelopeAad(userId, envelope.keyVersion, recipientDeviceId)
  );
  validateAccountKey(accountKey);
  return accountKey;
}

module.exports = {
  RECOVERY_ALGORITHM,
  DEVICE_ALGORITHM,
  createRecoveryEnvelope,
  unwrapRecoveryEnvelope,
  createDeviceEnvelope,
  unwrapDeviceEnvelope,
};
