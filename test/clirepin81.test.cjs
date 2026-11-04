const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
process.env.WATCHRSS_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'watchrss-clirepin81-'));
const books=require('../lib/books'),records=require('../lib/cloud-records'),snapshot=require('../lib/snapshot'),format=require('../lib/cloud-format'),raw=require('../lib/json-raw'),crypto=require('../lib/crypto'),util=require('../lib/util');
const key=new Uint8Array(32).fill(7),userId='clirepin81-synthetic';
test.after(()=>fs.rmSync(process.env.WATCHRSS_HOME,{recursive:true,force:true}));
function state(extra={}){const fingerprint='b'.repeat(64);return{bookId:books.id(fingerprint),fingerprint,title:'synthetic',chapterCount:2,deletedChapters:[],deleted:false,deletionClock:0,deletedAt:0,updatedAt:1,sourceDeviceId:'fixture',...extra};}
const lifecycle={generation:1,operationId:'a'.repeat(32),startedAt:2};
const create=extra=>snapshot.create({accountKey:key,keyVersion:1,sourceDeviceId:'fixture',deviceSequence:1,...extra});
const upgrade=e=>e.code==='cloud_format_upgrade_required'&&e.upgradeRequired&&e.editPending;
test('CLIREPIN81 known lifecycle records retain identity and feature markers; restored state defeats stale deletions',()=>{
 const stale=state({deleted:true,deletedChapters:[1],deletedAt:1,deletionClock:1}),restored=state({lifecycle,updatedAt:2});
 assert.deepEqual(books.merge(stale,restored),restored);assert.deepEqual(books.merge(restored,stale),restored);
 assert.deepEqual(books.merge(restored,{...restored,deletedChapters:[2],deletionClock:3}).deletedChapters,[2]);
 for(const value of [restored,state({instanceId:'c'.repeat(32),bookId:books.id(restored.fingerprint,'c'.repeat(32))})]){
  const encoded=records.encode({userId,key,keyVersion:1,kind:'book',value,nonce:new Uint8Array(12)}),decoded=records.decode({userId,key,...encoded});
  assert.deepEqual(decoded.value,value);assert.deepEqual(JSON.parse(decoded.retained.raw).features,{incompat:['book-lifecycle.v1'],roCompat:[]});
  assert.equal(decoded.retained.policy.write,true);assert.deepEqual(records.decode({userId,key,...records.encode({userId,key,keyVersion:1,kind:'book',value,retained:decoded.retained,nonce:new Uint8Array(12).fill(1)})}).value,value);
 }
 assert.equal(records.canonical('book',state()).features,undefined);
});
test('CLIREPIN81 lifecycle descriptors attach feature markers on fresh publication and unchanged-body reuse',async()=>{
 await crypto.initializeRandom();const original=state(),name=books.descriptor(original).packagePath,bytes=util.utf8ToBytes('synthetic immutable original'),contentSha256=crypto.sha256Hex(bytes);
 const first=await create({logicalObjects:[{name,bytes,contentSha256,privateBook:books.descriptor(original)}]}),previous=snapshot.decryptManifest(key,first.manifest.snapshotId,first.encryptedManifest);
 const next=await create({deviceSequence:2,previousManifest:previous,logicalObjects:[{name,bytes,contentSha256,privateBook:books.descriptor(state({lifecycle}))}]});
 assert.deepEqual(next.manifest.objects[0].features,{incompat:['book-lifecycle.v1'],roCompat:[]});assert.deepEqual(next.manifest.objects[0].chunks,previous.objects[0].chunks);assert.equal(Object.keys(next.newCiphertextChunks).length,0);
 const copied=state({instanceId:'c'.repeat(32),bookId:books.id(original.fingerprint,'c'.repeat(32))}),copy=await create({logicalObjects:[{name:books.descriptor(copied).packagePath,bytes,privateBook:books.descriptor(copied)}]});
 assert.deepEqual(copy.manifest.objects[0].features,{incompat:['book-lifecycle.v1'],roCompat:[]});
});
test('CLIREPIN81 unsupported lifecycle scope preserves authenticated manifest bytes and refuses reads/writes',async()=>{
 const made=await create({logicalObjects:[]}),text=raw.stringify(raw.merge(made.manifest,{features:{incompat:['book-lifecycle.v1'],roCompat:[]}})),encrypted=snapshot.encryptManifest(key,raw.parse(text)),decoded=snapshot.decryptManifest(key,made.manifest.snapshotId,encrypted);
 assert.equal(raw.stringify(decoded),text);assert.equal(format.assess(decoded,'manifest').read,'opaque');assert.throws(()=>format.assertWrite(decoded,'manifest'),upgrade);
 await assert.rejects(create({previousManifest:decoded,logicalObjects:[]}),upgrade);await assert.rejects(snapshot.restoreObjects(key,decoded,()=>assert.fail('opaque manifests cannot fetch bodies')),upgrade);
});
test('CLIREPIN81 a client without lifecycle support retains opaque record ciphertext and durable pending edits across restart',async()=>{
 // Exercise the actual record client with the pre-extension capability set.
 // Current mini/CLI support this marker on records/descriptors, not manifests.
 const oldFormat={...format,features:(value,type,limits)=>format.features(value,type,limits,[])};
 const box={module:{exports:{}},require:name=>name==='./cloud-format'?oldFormat:require('../lib/'+name.slice(2))};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/cloud-records.js'),'utf8'),box);
 const oldRecords=box.module.exports,encoded=records.encode({userId,key,keyVersion:1,kind:'book',value:state({lifecycle}),nonce:new Uint8Array(12)}),row={...encoded,revision:'1',tombstone:false};delete row.hash;
 let saved=null,posts=0,applied=0;const scope={userId},ports={account:{getUsableSession:()=>scope},statePath:()=> 'fixture',storage:{readJSON:(_p,f)=>saved?structuredClone(saved):f,writeJSON:(_p,value)=>{saved=structuredClone(value);}},request:async options=>{assert.equal(options.method,'GET');return{data:{formatVersion:1,items:options.path.includes('after=0')?[row]:[],cursor:'1',headRevision:'1',hasMore:false}};}};
 const decoded=oldRecords.decode({userId,key,...encoded});assert.equal(decoded.retained.policy.read,'opaque');assert.equal(decoded.retained.policy.write,false);assert.throws(()=>oldRecords.encode({userId,key,keyVersion:1,kind:'book',value:state(),retained:decoded.retained}),upgrade);
 await oldRecords.createClient(ports).pull({scope,keyForVersion:()=>key,apply:()=>{applied++;}});assert.equal(applied,0);assert.deepEqual(saved.unknown[row.recordId].envelope,row.envelope);
 ports.request=async options=>{posts++;assert.fail('opaque record must not be submitted: '+options.method);};
 const result=await oldRecords.createClient(ports).push({scope,keyVersion:1,key,books:[state({lifecycle,title:'local pending edit'})],bookIds:[state().bookId],readyBookIds:[state().bookId]});
 assert(result.editPending&&result.upgradeRequired);assert.equal(posts,0);assert.deepEqual(saved.unknown[row.recordId].envelope,row.envelope);assert(saved.editPending.length);
});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function prefetchFixture({noBody=false}={}){
 const events=[],started=deferred(),scan=deferred(),download=deferred(),owner={userDataPath:'fixture',id:'fixture',userId},value=state({deletedChapters:noBody?[1,2]:[]}),chunk={ciphertextSha256:'hash',ciphertextBytes:1},object={name:'books/fixture.jsonl',privateBook:value,chunks:[chunk]},context={head:{id:'head',keyVersion:1},manifest:{objects:[object]}};
 let locked=true,timers=0;const event=value=>{assert(locked,'background work escaped command lock');events.push(value);};
 const modules={
  books:{load:()=>({books:{[value.bookId]:value}}),acceptRemote:async()=>event('accept')},sync:{getAccountKey:()=>new Uint8Array(32),snapshotDownload:async()=>({chunks:[{sha256:'hash',sizeBytes:1,signedUrl:'https://fixture.invalid'}]})},
  'cloud-scope':{current:()=>owner,contentCurrent:()=>owner,load:()=>({libraryEpoch:'epoch'}),check:()=>event('check')},snapshot:{},util:{},crypto:{sha256Hex:()=> 'series',sha256HexAsync:async()=> 'hash'},
  http:{request:async options=>{event('download');options.onTask({abort:()=>event('abort')});started.resolve();await download.promise;event('download-settled');throw Object.assign(Error('cancelled'),{code:'cloud_operation_cancelled'});}},
  storage:{readBytesAsync:async()=>null},'book-diagnostics':{},'storage-budget':{},'cloud-format':{assertRead(){}},'cloud-download':require('../lib/cloud-download'),library:{bookStoragePath:n=>n},'book-stream':{localRange:()=>null},
  'snapshot-range':{open:async options=>{options.loadChunk(chunk).catch(()=>{});return{sizes:[1],close:()=>event('source-close')};}},
  'book-catalog':{scan:async()=>{await scan.promise;event('scan-settled');throw Object.assign(Error('cancelled'),{code:'cloud_operation_cancelled'});}},
 };
 const box={module:{exports:{}},require:name=>{const result=modules[name.slice(2)];if(!result)throw Error('unexpected module '+name);return result;},setTimeout:callback=>{timers++;queueMicrotask(callback);}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/cloud-books.js'),'utf8')+'\nmodule.exports.queueBook=queueBook;',box);
 const api=box.module.exports;return{api,events,started,scan,download,queue:()=>api.queueBook(context,object,userId),unlock:()=>{locked=false;},get timers(){return timers;}};
}
test('CLIREPIN81 cancelled queued prefetch schedules no delay or I/O and leaves no jobs',async()=>{
 const f=prefetchFixture();f.queue();await f.api.finishCommand({cancel:true});assert.equal(f.timers,0);assert.equal(f.events.includes('download'),false);assert.equal(f.api.backgroundStatus().length,0);f.unlock();await new Promise(setImmediate);
});
test('CLIREPIN81 no-live-body branch completes without opening originals or starting downloads',async()=>{
 const f=prefetchFixture({noBody:true});f.queue();const result=await f.api.finishCommand();assert.equal(result[0].status,'complete');assert.equal(f.timers,1);assert.equal(f.events.includes('download'),false);f.unlock();await new Promise(setImmediate);
});
test('CLIREPIN81 cancellation drains running lookahead before command unlock',async()=>{
 const f=prefetchFixture();f.queue();await f.started.promise;let finished=false;const drain=f.api.finishCommand({cancel:true}).then(()=>{finished=true;});f.scan.resolve();await new Promise(setImmediate);assert(f.events.includes('abort'));assert(!finished,'detached range lookahead still owns the command lock');
 f.download.resolve();await drain;assert(f.events.includes('download-settled'));assert.equal(f.api.backgroundStatus().length,0);f.unlock();await new Promise(setImmediate);
});
test('CLIREPIN81 Node task cancellation aborts body reads and retry backoff without another fetch',async()=>{
 const http=require('../lib/http'),native=global.fetch;
 try{
  let task,bodyStarted=deferred();global.fetch=async(_url,{signal})=>({ok:true,status:200,headers:new Headers(),arrayBuffer:()=>{bodyStarted.resolve();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const pending=http.request({path:'https://fixture.invalid/body',useBaseUrl:false,responseType:'arraybuffer',onTask:t=>{task=t;}});await bodyStarted.promise;task.abort();await assert.rejects(pending,e=>e.code==='cloud_operation_cancelled');
  let calls=0;const retryStarted=deferred();global.fetch=async()=>{calls++;return{ok:false,status:503,headers:new Headers({'retry-after':'30'}),json:async()=>{retryStarted.resolve();return{error:'temporary'};}};};
  const retry=http.request({path:'https://fixture.invalid/retry',useBaseUrl:false,onTask:t=>{task=t;}});await retryStarted.promise;await new Promise(setImmediate);task.abort();await assert.rejects(retry,e=>e.code==='cloud_operation_cancelled');assert.equal(calls,1);
 }finally{global.fetch=native;}
});
