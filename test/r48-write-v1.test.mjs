import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const home=fs.mkdtempSync(join(tmpdir(),'wrss-r48-write-'));process.env.WATCHRSS_HOME=home;
const {default:overlay}=await import('../lib/cloud-overlay.js'),{default:format}=await import('../lib/cloud-format.js'),{default:snapshot}=await import('../lib/snapshot.js'),{default:util}=await import('../lib/util.js'),{default:crypto}=await import('../lib/crypto.js');
const dir=new URL('./fixtures/r48-write-v1/',import.meta.url),load=n=>JSON.parse(fs.readFileSync(new URL(n+'.json',dir),'utf8'));
const miniPath=new URL('../../WatchRSS_WeChat/miniprogram/lib/cloud-overlay.js',import.meta.url),mini=fs.existsSync(miniPath)?(await import(miniPath)).default:null;
await crypto.initializeRandom();test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
test('Node 22 production codec reads shared mixed overlay and exact HTML/TXT bytes, keeps old feature gate and raw tokens',async()=>{
 const v=load('mixed-manifest'),key=util.hexDecode(v.accountKeyHex),manifest=snapshot.decryptManifest(key,v.snapshotId,util.hexDecode(v.encryptedManifestHex)),blobs=new Map(v.blobs.map(b=>[b.descriptor.chunks[0].ciphertextSha256,util.hexDecode(b.blobHex)])),options={manifest,key,check:()=>{},loadChunk:async c=>blobs.get(c.ciphertextSha256)},index=await overlay.load(options);assert.deepEqual(index,v.overlay);assert.equal(util.bytesToUtf8(await overlay.encode(index.entries)),v.overlayUtf8);assert.equal(rawText(manifest),v.manifestUtf8);
 const article=await overlay.readArticle(options,index.entries[1]);assert.equal(article.contentText,v.expected.editedTextUtf8);assert.equal(article.contentHtml,v.expected.editedHtmlUtf8);if(mini){assert.equal(overlay.articleName(article.articleId),mini.articleName(article.articleId));assert.deepEqual(await overlay.packArticle({...article,updatedAt:100},article.contentText),await mini.packArticle({...article,updatedAt:100},article.contentText));}
 const old=format.features(manifest,'manifest',true,[]);assert.equal(old.read,'opaque');assert.equal(old.write,false);assert.equal(format.capabilities().cloudFormatR48WriteV1,false);assert.equal(format.capabilities().cloudFormatMigrationR48V1,false);
 const next=await snapshot.create({accountKey:key,keyVersion:1,sourceDeviceId:'node-fixture',deviceSequence:2,previousManifest:manifest,carryForwardObjects:manifest.objects,logicalObjects:[]});assert.equal(Object.keys(next.newCiphertextChunks).length,0);assert(rawText(next.manifest).includes(v.expected.unknownDescriptorRawUtf8));
});
function rawText(v){return format.raw.stringify(v);}
test('Node writer creates validated entryRef without new ciphertext and refuses chains or an unchecked opt-in',async()=>{
 const v=load('entry-ref'),key=util.hexDecode(v.accountKeyHex),base={objects:[v.archiveDescriptor],keyVersion:1};
 await assert.rejects(snapshot.create({accountKey:key,keyVersion:1,sourceDeviceId:'fixture',deviceSequence:1,previousManifest:base,carryForwardObjects:base.objects,logicalObjects:[v.descriptor]}),e=>e.code==='cloud_format_write_disabled');
 const made=await snapshot.create({accountKey:key,keyVersion:1,sourceDeviceId:'fixture',deviceSequence:1,previousManifest:base,carryForwardObjects:base.objects,logicalObjects:[v.descriptor],allowEntryReferences:true});assert.equal(Object.keys(made.newCiphertextChunks).length,0);const bytes=await snapshot.restoreObjects(key,made.manifest,()=>util.hexDecode(v.archiveBlobHex));assert.equal(util.hexEncode(bytes[v.descriptor.name]),v.expectedEntryHex);
 for(const x of v.invalid){if(x.id==='missing-entry')await assert.rejects(snapshot.restoreObjects(key,{...made.manifest,objects:[v.archiveDescriptor,x.descriptor]},()=>util.hexDecode(v.archiveBlobHex)));else assert.throws(()=>format.validateDescriptor(x.descriptor,made.manifest),x.id);}
});
test('Node consumes accepted output while migration remains off; user edits create account chunks without an R_out envelope',async()=>{
 const v=load('object-key'),key=util.hexDecode(v.accountKeyHex),manifest={objects:[v.descriptor],keyVersion:1},restored=await snapshot.restoreObjects(key,manifest,()=>util.hexDecode(v.outputChunkBlobHex));assert.equal(util.hexEncode(restored[v.descriptor.name]),v.outputPlaintextHex);const root=format.root(key,v.descriptor);assert.equal(util.hexEncode(root),v.outputRootHex);for(const output of [root,new Uint8Array(root)])await assert.rejects(snapshot.create({accountKey:output,keyVersion:1,sourceDeviceId:'fixture',deviceSequence:2,logicalObjects:[{name:'new.txt',bytes:new Uint8Array([1])}]}),e=>e.code==='cloud_format_write_disabled');root.fill(0);
 const made=await snapshot.create({accountKey:key,keyVersion:1,sourceDeviceId:'fixture',deviceSequence:2,previousManifest:manifest,logicalObjects:[{name:v.descriptor.name,bytes:util.utf8ToBytes('edited under account key'),compress:false}]});assert(!made.manifest.objects[0].objectKeyEnvelope);assert.equal(Object.keys(made.newCiphertextChunks).length,1);assert.equal(format.capabilities().cloudFormatMigrationR48V1,false);
});
test('Node overlay clocks and same-name descriptor conflicts agree with mini; bounded closed schema rejects unsafe mutations',async()=>{
 const v=load('overlay-cases'),entry=v.index.entries[1],descriptor={name:entry.object,encoding:'identity',originalBytes:0,encodedBytes:0,chunks:[]},a={manifest:{objects:[descriptor]},index:{...v.index,entries:[entry]}},b={manifest:{objects:[{...descriptor,contentSha256:'f'.repeat(64)}]},index:a.index};const merged=overlay.merge([a,b]);assert.equal(merged.conflicts.length,1);assert.equal(merged.conflicts[0].inputs.length,2);if(mini)assert.equal(mini.merge([a,b]).conflicts.length,1);assert.equal(overlay.merge([a,{...a,index:{...a.index,entries:[{...entry,object:null}]}}]).selected.get(overlay.key(entry)).entry.object,null);
 for(const e of [{...entry,id:'\ud800'},{...entry,changedAt:2**53},{...entry,extra:1},{...entry,sourceDeviceId:'bad\n'},{...entry,object:'../x'}])assert.throws(()=>overlay.validate({...v.index,entries:[e]}));await assert.rejects(overlay.decode(new Uint8Array(v.limits.decodedIndexBytes+1)));
});
test('all pinned WriteV1 nested vectors remain byte-identical to authoritative shared inputs',()=>{const hashes=load('hashes');for(const [name,hash]of Object.entries(hashes)){const bytes=fs.readFileSync(new URL(name,dir));assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);const original=new URL('../../.codex-tmp/cloud-v2/vectors/r48-write-v1/'+name,import.meta.url);if(fs.existsSync(original))assert.deepEqual(bytes,fs.readFileSync(original));}});

test('Node and mini producers reject unreadable metadata and malformed original Unicode before encryption',async()=>{
 const article={articleId:'bounded-original',url:'watchrss://import/bounded',title:'title',contentText:'original'};
 for(const codec of [overlay,mini].filter(Boolean)){
  for(const mutation of [{title:'x'.repeat(12*1024*1024+1)},{title:{}},{articleId:'x'.repeat(1025)},{contentText:'broken\ud800'},{contentHtml:42}])await assert.rejects(codec.packArticle({...article,...mutation}),e=>e.code==='cloud_overlay_type_pending');
  const run=codec.beginPublication();run.reserve();run.plan(2,[{sizeBytes:100}]);run.progress({uploaded:100,done:1});run.phase('complete');run.finish(Object.assign(Error('secret-body-and-key'),{code:'ENOSPC'}));const result=codec.diagnostics().recent.at(-1);assert.equal(result.code,'storage_full');assert.equal(result.successfulPutBytes,100);assert.equal(result.outcome,'failed');assert(!JSON.stringify(result).includes('secret-body-and-key'));assert.equal(codec.diagnostics().active.length,0);
 }
});
