import './test-root.cjs';
// 快照编解码：round-trip / 跨块 / carry-forward / 校验失败路径 / 布局 KAT
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes as nodeRandomBytes} from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const snapshot = require('../lib/snapshot.js');
const cryptoLib = require('../lib/crypto.js');
const util = require('../lib/util.js');

const accountKey = cryptoLib.randomBytes(32);

// 1) 大对象跨 4MiB 块 + gzip-chunks-v1
{
  const big = cryptoLib.randomBytes(4 * 1024 * 1024 + 12345);
  const small = util.utf8ToBytes('hello snapshot');
  const created = await snapshot.create({
    accountKey,
    keyVersion: 1,
    sourceDeviceId: 'dev-a',
    deviceSequence: 1,
    logicalObjects: [
      { name: 'library-sync.json', bytes: small, compress: true },
      { name: 'big-object.bin', bytes: big, compress: true },
    ],
  });
  const manifest = created.manifest;
  assert.equal(manifest.format, 'watchrss-cloud-snapshot');
  assert.equal(manifest.schemaVersion, 2);
  const bigDesc = manifest.objects.find((o) => o.name === 'big-object.bin');
  assert.equal(bigDesc.chunks.length, 2, '跨 4MiB 产生 2 块');
  assert.equal(bigDesc.encoding, 'gzip-chunks-v1');
  const loader = (sha) => created.newCiphertextChunks[sha];
  const restored = await snapshot.restoreObjects(accountKey, manifest, loader);
  assert.ok(Buffer.from(restored['big-object.bin']).equals(big));
  assert.ok(Buffer.from(restored['library-sync.json']).equals(small));

  // 布局 KAT：分块 blob = WRSSCC2 + salt16 + nonce12 + ct + tag16
  const blob = created.newCiphertextChunks[bigDesc.chunks[0].ciphertextSha256];
  assert.ok(util.bytesEqual(blob.slice(0, 7), util.utf8ToBytes('WRSSCC2')));
  assert.equal(blob.length, 7 + 16 + 12 + bigDesc.chunks[0].plaintextBytes + 16);

  // manifest blob 布局
  assert.ok(util.bytesEqual(created.encryptedManifest.slice(0, 7), util.utf8ToBytes('WRSSCM3')));
  assert.equal(created.encryptedManifest.length, 7 + 16 + 12 + 16 + util.utf8ToBytes(JSON.stringify(manifest)).length);
}

// 2) identity 编码
{
  const bytes = cryptoLib.randomBytes(1000);
  const created = await snapshot.create({
    accountKey, keyVersion: 1, sourceDeviceId: 'dev-a', deviceSequence: 1,
    logicalObjects: [{ name: 'identity.bin', bytes, compress: false }],
  });
  const manifest = created.manifest;
  assert.equal(manifest.objects[0].encoding, 'identity');
  assert.equal(manifest.objects[0].encodedBytes, 1000);
  const restored = await snapshot.restoreObjects(accountKey, manifest, (sha) => created.newCiphertextChunks[sha]);
  assert.ok(Buffer.from(restored['identity.bin']).equals(bytes));
}

// 3) carry-forward 复用（明文相同的块不重新加密）
{
  const content = util.utf8ToBytes(JSON.stringify({ x: 'same-content', pad: 'y'.repeat(2000) }));
  const first = await snapshot.create({
    accountKey, keyVersion: 1, sourceDeviceId: 'dev-a', deviceSequence: 1,
    logicalObjects: [{ name: 'library-sync.json', bytes: content, compress: true }],
  });
  const second = await snapshot.create({
    accountKey, keyVersion: 1, sourceDeviceId: 'dev-a', deviceSequence: 2,
    logicalObjects: [{ name: 'library-sync.json', bytes: content, compress: true }],
    previousManifest: first.manifest,
  });
  assert.equal(Object.keys(second.newCiphertextChunks).length, 0, '相同明文块应全部复用，无新加密块');
  assert.deepEqual(second.manifest.objects[0].chunks, first.manifest.objects[0].chunks, '描述符逐字段一致');
}

// 4) 错误密钥必须失败
{
  const created = await snapshot.create({
    accountKey, keyVersion: 1, sourceDeviceId: 'dev-a', deviceSequence: 1,
    logicalObjects: [{ name: 'x.json', bytes: util.utf8ToBytes('{"a":1}'), compress: true }],
  });
  assert.throws(() => snapshot.decryptManifest(cryptoLib.randomBytes(32), created.manifest.snapshotId, created.encryptedManifest));
  const loader = (sha) => created.newCiphertextChunks[sha];
  const wrongManifest = snapshot.decryptManifest(accountKey, created.manifest.snapshotId, created.encryptedManifest);
  await assert.rejects(snapshot.restoreObjects(cryptoLib.randomBytes(32), wrongManifest, loader));
}

// 5) 块完整性校验（篡改盐值/哈希必须失败）
{
  const created = await snapshot.create({
    accountKey, keyVersion: 1, sourceDeviceId: 'dev-a', deviceSequence: 1,
    logicalObjects: [{ name: 'x.json', bytes: util.utf8ToBytes('{"a":1}'), compress: false }],
  });
  const desc = created.manifest.objects[0].chunks[0];
  const tampered = util.base64Decode(desc.saltBase64).slice();
  tampered[0] ^= 0xff;
  const loader = () => created.newCiphertextChunks[desc.ciphertextSha256];
  const manifest = Object.assign({}, created.manifest, {
    objects: [Object.assign({}, created.manifest.objects[0], {
      chunks: [Object.assign({}, desc, { saltBase64: util.base64Encode(tampered) })],
    })],
  });
  await assert.rejects(snapshot.restoreObjects(accountKey, manifest, loader));
}

// 6) 空对象
{
  const created = await snapshot.create({
    accountKey, keyVersion: 1, sourceDeviceId: 'dev-a', deviceSequence: 1,
    logicalObjects: [{ name: 'empty.bin', bytes: new Uint8Array(0), compress: true }],
  });
  assert.equal(created.manifest.objects[0].chunks.length, 0);
  const restored = await snapshot.restoreObjects(accountKey, created.manifest, (sha) => created.newCiphertextChunks[sha]);
  assert.equal(restored['empty.bin'].length, 0);
}

console.log('快照编解码测试全部通过');

test('multi-MiB RSS indexes use small independently encrypted chunks and restore exactly',async()=>{
 const bytes=util.utf8ToBytes(JSON.stringify({format:'watchrss-rss-state',version:1,articles:[{articleId:'synthetic',title:util.base64Encode(nodeRandomBytes(5*1024*1024))+'中文🙂'}],sources:[]}));
 const key=cryptoLib.randomBytes(32);
 const created=await snapshot.create({accountKey:key,keyVersion:1,sourceDeviceId:'index-test',deviceSequence:1,logicalObjects:[{name:'rss-state.json',bytes,compress:true}]});
 const descriptor=created.manifest.objects[0];assert(descriptor.chunks.length>40);
 assert(descriptor.chunks.every(c=>c.ciphertextBytes<=128*1024+512));
 const restored=await snapshot.restoreObjects(key,created.manifest,hash=>created.newCiphertextChunks[hash]);
 assert.deepEqual(restored['rss-state.json'],bytes);
});
