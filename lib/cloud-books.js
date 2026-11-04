// R44 cloud framing: identical JSONL packages inside WRSS or direct logical objects.
const books=require('./books'),sync=require('./sync'),scope=require('./cloud-scope'),snapshot=require('./snapshot'),util=require('./util'),crypto=require('./crypto'),http=require('./http'),storage=require('./storage');
const diagnostics=require('./book-diagnostics'),budget=require('./storage-budget');
let referenceBatch=null;
function name(bookId){return 'books/'+bookId+'.jsonl';}
function validDescriptor(value,object){if(!value||object.name!==name(value.bookId)||value.packagePath!==object.name||!/^([a-f0-9]{64})$/.test(value.bookId)||value.bookId!==books.id(value.fingerprint,value.instanceId)||!Number.isInteger(value.chapterCount)||value.chapterCount<1)throw Object.assign(Error('书包身份无效'),{code:'cloud_book_invalid'});}
async function optionsFor(context,userId,{bookId,reading=false,check:callerCheck=()=>{}}={}){
 require('./cloud-format').assertRead(context.manifest,'manifest');
 const owner=scope.contentCurrent(),epoch=scope.load(userId)?.libraryEpoch;if(owner.userId!==userId)throw Object.assign(Error('账号已切换'),{code:'cloud_session_changed'});
 const check=()=>{callerCheck();scope.check(owner);if(scope.load(userId)?.libraryEpoch!==epoch)throw Object.assign(Error('云资料库已重置'),{code:'NEEDS_RECOVERY'});};
 if(context.manifest.settings?.libraryEpoch&&context.manifest.settings.libraryEpoch!==epoch)throw Object.assign(Error('云快照纪元不匹配'),{code:'NEEDS_RECOVERY'});
 const key=sync.getAccountKey(userId,context.head.keyVersion)||await sync.refreshAccountKey(userId,context.head.keyVersion);if(!key)throw Object.assign(Error('缺少书包密钥'),{code:'cloud_key_version_missing'});
 const network=require('./cloud-download').session({check}),checked=network.check;
 const seriesCache=new WeakMap(),seriesFor=d=>{if(!seriesCache.has(d))seriesCache.set(d,crypto.sha256Hex(d.chunks.map(c=>c.ciphertextSha256).join(':')));return seriesCache.get(d);},chunkIndex=new Map();for(const d of context.manifest.objects)if(d.chunks?.length){const series=seriesFor(d);d.chunks.forEach((c,index)=>chunkIndex.set(c.ciphertextSha256,{index,series}));}
 // A reused ciphertext may belong to several books. Its retention hint must
 // use the active book's order and series, while references may cover the head.
 if(bookId){const book=context.manifest.objects.find(d=>d.privateBook?.bookId===bookId),target=book?.entryRef?context.manifest.objects.find(d=>d.name===book.entryRef.object):book||context.manifest.objects.find(d=>d.name===sync.OBJ.PRIVATE_LIBRARY);if(target?.chunks){const series=seriesFor(target);target.chunks.forEach((c,index)=>chunkIndex.set(c.ciphertextSha256,{index,series}));}}
 const pending=new Map(),references=new Map(),touched=new Set();let batch=null;
 async function batchReferences(){checked();if(chunkIndex.size>4096)return;const id=JSON.stringify([owner.userDataPath,owner.id,epoch,owner.contentGeneration,owner.cacheRevision,context.head.id]);
  // Only one head is retained. Reuse its 15-minute server URLs for five minutes;
  // per-object readers must not repeat thousands of signing RPCs on that head.
  let entry=referenceBatch;if(!entry||entry.id!==id||entry.until<Date.now()){entry={id,until:Infinity};entry.promise=sync.snapshotDownload(context.head.id).then(remote=>{entry.until=Date.now()+300000;return remote.chunks;}).catch(error=>{if(referenceBatch===entry)referenceBatch=null;throw error;});referenceBatch=entry;}
  const rows=await entry.promise;checked();for(const target of rows)if(chunkIndex.has(target.sha256))references.set(target.sha256,target);
 }
 async function reference(chunk){let target=references.get(chunk.ciphertextSha256);if(!target){const remote=await sync.snapshotDownload(context.head.id,{chunk:chunk.ciphertextSha256});checked();target=remote.chunks.find(c=>c.sha256===chunk.ciphertextSha256);if(target)references.set(target.sha256,target);}if(!target||target.sizeBytes!==chunk.ciphertextBytes||typeof target.signedUrl!=='string')throw Error('书包块无效');return target;}
 async function load(chunk){checked();const file='cache/remote-chunks/'+owner.id+'/'+chunk.ciphertextSha256;
  const position=chunkIndex.get(chunk.ciphertextSha256);let bytes;try{bytes=await storage.readBytesAsync(file);}catch(error){checked();if(!['local_storage_changed','local_storage_read_failed'].includes(error.code))throw error;}checked();
  if(bytes&&(bytes.length!==chunk.ciphertextBytes||await crypto.sha256HexAsync(bytes,checked)!==chunk.ciphertextSha256)){storage.deleteFile(file);bytes=null;}
  if(bytes){if(!touched.has(file)){if(position)budget.range(file,{bookId,...position},{persist:reading});if(reading)budget.touch(file);touched.add(file);}return bytes;}
  return network.run(chunk.ciphertextBytes,async register=>{for(let attempt=0;attempt<2;attempt++){const target=await reference(chunk);checked();let task;try{const result=await http.request({path:target.signedUrl,useBaseUrl:false,responseType:'arraybuffer',onTask:t=>{task=t;register(t);}});checked();bytes=new Uint8Array(result.data);if(bytes.length!==target.sizeBytes||await crypto.sha256HexAsync(bytes,checked)!==chunk.ciphertextSha256)throw Error('书包传输校验失败');break;}catch(error){checked();if(attempt||![401,403].includes(error.status))throw error;references.delete(chunk.ciphertextSha256);}finally{network.release(task);}}
   checked();try{const written=await storage.writeBytesAsync(file,bytes);checked();if(!written)throw budget.full();if(!touched.has(file)){if(position)budget.range(file,{bookId,...position},{persist:reading});if(reading)budget.touch(file);touched.add(file);}}catch(error){checked();if(error.code==='local_storage_changed'&&storage.exists(file))return bytes;if(!budget.quota(error))throw error;if(!reading)throw error;}return bytes;
  });
 }
 function loadChunk(chunk){checked();const sha=chunk.ciphertextSha256;if(!pending.has(sha))pending.set(sha,load(chunk).finally(()=>pending.delete(sha)));return pending.get(sha);}
 return{key,check:checked,loadChunk,manifest:context.manifest,batchReferences(){if(!batch)batch=batchReferences().catch(error=>{batch=null;throw error;});return batch;},async drain(){await Promise.allSettled([...pending.values(),...(batch?[batch]:[])]);},close(){network.close();try{check();if(bookId&&touched.size)budget.flushRanges?.();}catch(_){}key.fill(0);references.clear();},onRead:({indices,descriptor})=>{if(reading&&bookId&&indices.length)budget.focus(bookId,indices[0],seriesFor(descriptor));}};
}
async function objectText(context,object,userId){
 if(object.originalBytes>32*1024*1024)throw Error('书包过大');const options=await optionsFor(context,userId,{reading:true});let source;const hash=crypto.createSha256(),requested=new Set();
 // Catalogs use the same bounded pipeline without signing an entire large head.
 options.loadChunk.prefetch=(descriptor,index)=>{for(const chunk of descriptor.chunks.slice(index+1,index+5)){if(requested.has(chunk.ciphertextSha256))continue;requested.add(chunk.ciphertextSha256);options.loadChunk(chunk).catch(()=>{});}};
 try{source=await require('./snapshot-range').open({...options,descriptor:object});const parts=[];let carry=new Uint8Array(0);
  for(let at=0;at<source.size;at+=65536){options.check();const raw=await source.read(at,Math.min(source.size,at+65536));hash.update(raw);const bytes=util.bytesConcat([carry,raw]);let end=bytes.length;if(at+raw.length<source.size){let start=end-1;while(start>=0&&(bytes[start]&192)===128)start--;if(start>=0&&bytes[start]>=192){const count=bytes[start]<224?2:bytes[start]<240?3:4;if(end-start<count)end=start;}}parts.push(await require('./storage-async').utf8Strict(bytes.subarray(0,end),options.check));carry=bytes.slice(end);}
  if(carry.length||object.contentSha256&&hash.hex()!==object.contentSha256)throw Error('书包内容校验失败');options.check();return parts.join('');
 }finally{source?.close();hash.destroy();options.close();await options.drain();}
}
const jobs=new Map();let background=Promise.resolve();
function catalogPath(object){return 'cache/book-seek/'+scope.current().id+'/'+object.privateBook.bookId+'-catalog-'+(object.contentSha256||crypto.sha256Hex(JSON.stringify(object.entryRef||object.chunks)))+'.json';}
async function readCatalog(context,object,userId){const catalog=require('./book-catalog'),file=catalogPath(object);let value=await storage.readJSONAsync(file,null);if(value)try{const text=await require('./cooperative').stringify(value.catalog);if(await crypto.sha256HexAsync(text)!==value.checksum)throw Error('目录缓存无效');return catalog.validate(value.catalog,object);}catch(_){}const descriptor=context.manifest.objects.find(d=>d.name===catalog.name(object.privateBook.bookId));if(!descriptor)return null;if(descriptor.originalBytes>catalog.MAX_CATALOG)throw Object.assign(Error('书目录过大'),{code:'cloud_book_invalid'});value=catalog.validate(JSON.parse(await objectText(context,descriptor,userId)),object);return value;}
function seedCatalog(object,source,catalog){if(!catalog)return;const file='cache/book-seek/'+scope.current().id+'/'+object.privateBook.bookId+'.json';storage.writeJSON(file,{version:1,size:source.size,source:source.identity+':'+source.identity,fingerprint:object.privateBook.fingerprint,positions:catalog.positions,chapters:{}});}
function queueBook(context,object,userId,notify=()=>{}){const id=scope.current().userDataPath+':'+scope.current().id+':'+context.head.id+':'+object.name;if(jobs.has(id)&&['queued','running','complete'].includes(jobs.get(id).status))return;if(jobs.size>=256)for(const [key,value]of jobs)if(!['queued','running'].includes(value.status)){jobs.delete(key);break;}const owner=scope.contentCurrent(),epoch=scope.load(userId)?.libraryEpoch;let cancelled=false;
 const check=()=>{scope.check(owner);if(cancelled)throw Object.assign(Error('同步已取消'),{code:'cloud_operation_cancelled'});if(scope.load(userId)?.libraryEpoch!==epoch)throw Object.assign(Error('云资料库已重置'),{code:'NEEDS_RECOVERY'});const state=books.load().books[object.privateBook.bookId];if(state?.deleted)throw Object.assign(Error('书已删除'),{code:'cloud_book_deleted'});};
 const job={cancel(){cancelled=true;job.options?.close();},status:'queued',error:null};jobs.set(id,job);
 background=background.catch(()=>{}).then(async()=>{let source,options;try{check();await new Promise(resolve=>setTimeout(resolve,250));check();if(noLiveBody(object.privateBook)){job.status='complete';return;}job.status='running';
  // An immutable original already on this device needs no network round trip.
  // Verify it incrementally; retirement/corruption falls back to remote chunks.
  let localCatalog=null;if(!object.entryRef){try{const relative=require('./library').bookStoragePath(object.name),local=require('./book-stream').localRange(relative,check);if(local)localCatalog=await require('./book-catalog').scan(local,object.privateBook,{check,contentSha256:object.contentSha256});}catch(error){check();}}
  if(localCatalog){await books.acceptRemote(object.privateBook,localCatalog,check);check();job.status='complete';try{notify(object.privateBook.bookId,{verified:true});}catch(_){}return;}
  options=job.options=await optionsFor(context,userId,{bookId:object.privateBook.bookId,check});
  // The current endpoint signs the entire head. Use it only in background;
  // the first readable range never waits for thousands of signatures.
  await options.batchReferences();check();const requested=new Set();options.loadChunk.prefetch=(descriptor,index)=>{for(const c of descriptor.chunks.slice(index+1,index+5)){if(requested.has(c.ciphertextSha256))continue;requested.add(c.ciphertextSha256);options.loadChunk(c).catch(()=>{});}};
  source=await require('./snapshot-range').open({...options,descriptor:object,deferBookVerification:true});const catalog=await require('./book-catalog').scan(source,object.privateBook,{check,contentSha256:object.contentSha256});check();
  // Legacy lengths are learned from authenticated/decompressed chunks.
  const d=object.entryRef||object.encoding==='gzip'?null:object;catalog.lengths=d?source.sizes.slice():[];
  if(d){require('./book-catalog').validate(catalog,object);const text=await require('./cooperative').stringify(catalog,check);await storage.writeJSONAsync(catalogPath(object),{catalog,checksum:await crypto.sha256HexAsync(text,check)},{check});}
  check();await books.acceptRemote(object.privateBook,catalog,check);check();job.status='complete';try{notify(object.privateBook.bookId,{verified:true});}catch(_){}
 }catch(error){job.status='stopped';job.error=error.code||'cloud_book_body_missing';}finally{source?.close();options?.close();await options?.drain();job.options=null;}});
}
function cancelPrefetch(){referenceBatch=null;for(const job of jobs.values())if(['queued','running'].includes(job.status))job.cancel();}
function backgroundStatus(){return [...jobs.values()].map(({status,error})=>({status,error}));}
async function waitForPrefetch(){await background;return backgroundStatus();}
// Deletions are grow-only. An authenticated local state with no live chapter
// needs no original-body restoration, but remains a book (not a book deletion).
function noLiveBody(value){
 const current=value&&books.load().books[value.bookId];
 return !!current&&current.fingerprint===value.fingerprint&&current.chapterCount===value.chapterCount&&
  (current.deleted||current.deletedChapters.length===current.chapterCount&&current.deletedChapters.every((n,i)=>n===i+1));
}
async function restore(contexts,userId,{onReadable=()=>{}}={}){
 const deferredBooks=[];let deferred=false;
 const warnings=[],ready=new Set(),owner=scope.contentCurrent(),epoch=scope.load(userId)?.libraryEpoch,path=scope.path('book-abandoned',userId),saved=storage.readJSON(path,null),abandoned=saved&&saved.libraryEpoch===epoch?saved.objects||{}:{};
 const checked=()=>{scope.check(owner);if(scope.load(userId)?.libraryEpoch!==epoch)throw Object.assign(Error('云资料库已重置'),{code:'NEEDS_RECOVERY'});};
 const objectId=(context,name)=>crypto.sha256Hex(context.head.id+'\n'+name);
 function report(context,name,error,bookId){const key=objectId(context,name);if(abandoned[key])return;if(['cloud_book_invalid','cloud_private_archive_invalid'].includes(error.code)){scope.check(owner);abandoned[key]=true;storage.writeJSON(path,{libraryEpoch:epoch,objects:abandoned});}warnings.push({bookId,code:error.code||'cloud_book_body_missing'});}

 for(const context of contexts){checked();if(context.manifest.settings?.libraryEpoch&&context.manifest.settings.libraryEpoch!==epoch)throw Object.assign(Error('云快照纪元不匹配'),{code:'NEEDS_RECOVERY'});if(require('./cloud-overlay').marked(context.manifest)&&!context.overlayView){warnings.push({code:'cloud_overlay_invalid'});continue;}if(!require('./cloud-format').readable(context.manifest,'manifest')){warnings.push({code:'cloud_format_upgrade_required'});continue;}context.bookIds=context.bookIds||[];
 for(const object of context.manifest.objects){const decision=context.overlayView?.get('book\n'+object.privateBook?.bookId);if(decision&&(decision.conflict||decision.entry.object===null||decision.context?.head.id!==context.head.id))continue;if(!require('./cloud-format').readable(object,'descriptor'))continue;if(!object.name.startsWith('books/')||!object.name.endsWith('.jsonl')||abandoned[objectId(context,object.name)])continue;
 try{validDescriptor(object.privateBook,object);const value=object.privateBook;if(value.lifecycle&&books.lifecycleOrder(value,books.load().books[value.bookId]||{})>0){await books.acceptRemote(value,null,checked,{deferPersist:true});deferred=true;}const existing=books.load().books[value.bookId];if(noLiveBody(value)){ready.add(value.bookId);if(!context.bookIds.includes(value.bookId))context.bookIds.push(value.bookId);continue;}if(existing&&existing.chapterCount!==value.chapterCount)throw Object.assign(Error('书目录不符'),{code:'cloud_book_invalid'});if(object.originalBytes>1024*1024||storage.exists('state/storage-projection-reset.json')){const catalog=await readCatalog(context,object,userId);checked();await books.acceptRemote(value,catalog,checked,{deferPersist:true});deferred=true;onReadable(value.bookId);ready.add(value.bookId);if(!context.bookIds.includes(value.bookId))context.bookIds.push(value.bookId);deferredBooks.push([context,object,userId]);continue;}const relative=require('./library').bookStoragePath(name(value.bookId)),mapping=books.load().chapters[value.bookId],evicted=existing&&mapping&&Object.keys(mapping).length===value.chapterCount&&!storage.exists(relative);const cached=evicted?null:await books.packageTextAsync(value.bookId);if(!evicted&&(cached===null||!existing||!mapping||Object.keys(mapping).length!==value.chapterCount)){const text=cached===null?await objectText(context,object,userId):cached;await books.acceptAsync(text,value);}budget.confirm(relative,{snapshotId:context.head.id,bookId:value.bookId});ready.add(value.bookId);if(!context.bookIds.includes(value.bookId))context.bookIds.push(value.bookId);
 }catch(error){if(['cloud_content_rebuild_required','NEEDS_RECOVERY','cloud_session_changed'].includes(error.code))throw error;report(context,object.name,error,object.privateBook?.bookId);}}
 const descriptor=context.manifest.objects.find(o=>o.name===sync.OBJ.PRIVATE_LIBRARY);if(!descriptor)continue;
 if(context.booksRestored){for(const id of context.bookIds)ready.add(id);for(const object of context.rangeBooks||[])if(!noLiveBody(object.privateBook))deferredBooks.push([context,object,userId]);continue;}
 const options=await optionsFor(context,userId);try{if(descriptor.originalBytes>1024*1024){let source;try{source=await require('./snapshot-range').open({...options,descriptor});const zip=await require('./private-archive').zipDirectory(source.read.bind(source),source.size),headBytes=await zip.entry('manifest.json'),head=headBytes&&JSON.parse(await require('./storage-async').utf8Strict(headBytes,options.check));if(head?.format!=='watchrss-library-backup'||![1,2,3].includes(head.version))throw Object.assign(Error('归档目录无效'),{code:'cloud_private_archive_invalid'});const bytes=await zip.entry('books.json');if(bytes){const catalog=JSON.parse(await require('./storage-async').utf8Strict(bytes,options.check));if(!Array.isArray(catalog))throw Object.assign(Error('归档目录无效'),{code:'cloud_private_archive_invalid'});for(const value of catalog){options.check();const decision=context.overlayView?.get('book\n'+value.bookId);if(decision)continue;const path=name(value.bookId);validDescriptor(value,{name:path});if(noLiveBody(value)){ready.add(value.bookId);if(!context.bookIds.includes(value.bookId))context.bookIds.push(value.bookId);continue;}const entry=await zip.entryRange(path);if(!entry)throw Object.assign(Error('归档书包缺失'),{code:'cloud_book_invalid'});const object={name:path,privateBook:value,originalBytes:entry.size,encodedBytes:entry.size,encoding:'identity',entryRef:{object:descriptor.name,entryPath:path,encoding:'identity'},features:{incompat:['r48.entry-ref.v1'],roCompat:[]}};await books.acceptRemote(value,null,options.check,{deferPersist:true});deferred=true;onReadable(value.bookId);ready.add(value.bookId);if(!context.bookIds.includes(value.bookId))context.bookIds.push(value.bookId);if(!context.rangeBooks)context.rangeBooks=[];if(!context.rangeBooks.some(d=>d.name===object.name))context.rangeBooks.push(object);deferredBooks.push([context,object,userId]);}}context.booksRestored=true;continue;}finally{source?.close();}}const packages=await require('./private-archive').readBooks({...options,descriptor,skipBook:value=>{validDescriptor(value,{name:name(value.bookId)});if(!noLiveBody(value))return false;ready.add(value.bookId);if(!context.bookIds.includes(value.bookId))context.bookIds.push(value.bookId);return true;}})||[];let complete=true;
 for(const item of packages){const decision=context.overlayView?.get('book\n'+item.value?.bookId);if(decision)continue;if(item.error){report(context,'wrss:'+String(item.value?.packagePath||item.value?.bookId),item.error,item.value?.bookId);if(!['cloud_book_invalid','cloud_private_archive_invalid'].includes(item.error.code))complete=false;continue;}await books.acceptAsync(item.text,item.value);budget.confirm(require('./library').bookStoragePath(name(item.value.bookId)),{snapshotId:context.head.id,bookId:item.value.bookId});ready.add(item.value.bookId);if(!context.bookIds.includes(item.value.bookId))context.bookIds.push(item.value.bookId);}context.booksRestored=complete;
 }catch(error){if(['cloud_content_rebuild_required','NEEDS_RECOVERY','cloud_session_changed'].includes(error.code))throw error;report(context,descriptor.name,error);}finally{options.close();}
 }
 if(deferred)await require('./library').commitCloudIndexAsync(checked);else await books.materializeAsync();checked();for(const args of deferredBooks)if(!noLiveBody(args[1].privateBook))queueBook(...args,onReadable);return{warnings,readyBookIds:[...ready]};
}
function membership(article,db=books.load(),trace){
 const known=books.member(article,db);if(known){diagnostics.record(trace,'membership',true,'mapped',{books:Object.keys(db.books).length},known);return known;}
 // Imported metadata may use the canonical R44 ID while the local alias map
 // still contains the old URL ID. Bind by the authenticated book + ordinal.
 for(const state of Object.values(db.books)){
  const n=state.chapterCount===1?1:books.ordinal(article);
  if(n>0&&n<=state.chapterCount&&article.articleId===books.articleId(state.bookId,n)){diagnostics.record(trace,'membership',true,'canonical',{chapters:state.chapterCount,ordinal:n},state);return{bookId:state.bookId,chapterIndex:n};}
 }
 diagnostics.record(trace,'membership',false,'missing',{books:Object.keys(db.books).length,ordinal:books.ordinal(article)});
 return null;
}
function readerOwner(){const owner=scope.current();return()=>scope.check({...owner,lifecycle:undefined});}
async function localReaderAsync(article,{isClosed=()=>false,diagnostics:trace}={}){
 if(books.prepare)await books.prepare();
 const db=books.load(),m=membership(article,db,trace);if(!m)return null;
 const stateOwner=scope.current(),checkOwner=readerOwner(),state=db.books[m.bookId];
 const check=()=>{checkOwner();if(isClosed())throw Object.assign(Error('阅读已关闭'),{code:'reader_closed'});const s=books.load().books[m.bookId];if(s&&(s.deleted||s.deletedChapters.includes(m.chapterIndex)))throw Object.assign(Error('该章节已删除'),{code:'cloud_book_chapter_deleted'});};
 check();const stream=require('./book-stream'),relative=require('./library').bookStoragePath('books/'+state.bookId+'.jsonl'),range=stream.localRange(relative,check);diagnostics.record(trace,'local-book',!!range,range?'selected':'missing',{chapters:state.chapterCount,ordinal:m.chapterIndex},state);if(!range)return null;
 const packageRevision=storage.revision(relative),originalAvailable=()=>storage.exists(relative)&&storage.revision(relative)===packageRevision;
 // Preserve only actually requested local ranges, not another full package.
 // They let the visible window survive the one-time legacy-file retirement.
 const localScan=range.scan.bind(range);range.scan=async(a,b)=>{if(!originalAvailable())throw Object.assign(Error('本机范围缓存已更新'),{code:'local_range_evicted'});const bytes=await localScan(a,b);if(!originalAvailable())throw Object.assign(Error('本机范围缓存已更新'),{code:'local_range_evicted'});return bytes;};
 const localRead=range.read.bind(range),segments=new Map(),series='local:'+range.identity,cachePrefix='cache/local-book-ranges/'+stateOwner.id+'/'+state.bookId+'/'+crypto.sha256Hex(range.identity)+'/';
 range.read=async(a,b)=>{check();if(originalAvailable()){const bytes=await localRead(a,b);if(!originalAvailable())throw Object.assign(Error('本机范围缓存已更新'),{code:'local_range_evicted'});{const file=cachePrefix+a+'-'+b;budget.focus(state.bookId,Math.floor(a/8192),series);try{const written=await storage.writeBytesAsync(file,bytes);check();if(written){budget.range(file,{bookId:state.bookId,index:Math.floor(a/8192),series},{persist:false});segments.delete(a);segments.set(a,{end:b,file,sha:crypto.sha256Hex(bytes)});while(segments.size>8)segments.delete(segments.keys().next().value);}}catch(error){check();/* Optional range persistence never invalidates source bytes. */}}return bytes;}
  const output=new Uint8Array(b-a);let at=a;while(at<b){const hit=[...segments].find(([start,v])=>start<=at&&v.end>at);if(!hit)throw Object.assign(Error('本机范围缓存已回收'),{code:'local_range_evicted'});const [start,entry]=hit,bytes=await storage.readBytesAsync(entry.file);check();if(!bytes||bytes.length!==entry.end-start||crypto.sha256Hex(bytes)!==entry.sha)throw Object.assign(Error('本机范围缓存已回收'),{code:'local_range_evicted'});const end=Math.min(b,entry.end);output.set(bytes.subarray(at-start,end-start),at-a);at=end;}budget.focus(state.bookId,Math.floor(a/8192),series);return output;
 };
 const release=budget.reading(state.bookId);budget.touch(relative);let local;
 try{local=await stream.open({range,expected:state,chapterIndex:m.chapterIndex,indexPath:'cache/book-seek/'+scope.current().id+'/'+state.bookId+'.json',check,onClose:release,sibling:next=>{check();return localReaderAsync(next);}});}catch(error){release();check();if(!originalAvailable()){try{const contexts=await require('./cloud-reader').storageContexts(stateOwner.userId,check);return await remoteReader(contexts,article,stateOwner.userId,{isClosed,diagnostics:trace});}catch(failure){if(['network_error','timeout'].includes(failure.code))throw Object.assign(Error('请联网后继续阅读这本书'),{code:'reader_book_online_required',cause:failure});throw failure;}}throw error;}
 // A legacy full package can disappear during this reader's lifetime. Reopen
 // the same authenticated chapter remotely; page offsets belong to each source.
 let remote=null,pending=null,closed=false;
 async function fallback(){check();if(closed)throw Object.assign(Error('阅读已关闭'),{code:'reader_closed'});if(remote)return remote;if(!pending)pending=(async()=>{try{const contexts=await require('./cloud-reader').storageContexts(stateOwner.userId,check),next=await remoteReader(contexts,article,stateOwner.userId,{isClosed:()=>closed||isClosed(),diagnostics:trace});check();if(!next)throw Object.assign(Error('请联网后继续阅读这本书'),{code:'reader_book_online_required'});if(closed){next.close();throw Object.assign(Error('阅读已关闭'),{code:'reader_closed'});}remote=next;local.close();return next;}catch(error){if(['network_error','timeout'].includes(error.code))throw Object.assign(Error('请联网后继续阅读这本书'),{code:'reader_book_online_required',cause:error});throw error;}})().finally(()=>pending=null);return pending;}
 async function invoke(method,page){check();let reader=remote||local;if(reader===local&&!originalAvailable()&&method==='preparePage'&&page>=local.knownPages)reader=await fallback();try{if(reader===remote&&reader.preparePage)await reader.preparePage(page);return reader[method]?await reader[method](page):undefined;}catch(error){check();if(reader===local&&!originalAvailable()){reader=await fallback();if(reader.preparePage)await reader.preparePage(page);return reader[method]?reader[method](page):undefined;}throw error;}}
 return{get knownPages(){return(remote||local).knownPages;},get totalPages(){return(remote||local).totalPages;},get estimatedPages(){return(remote||local).estimatedPages;},get totalPagesKnown(){return(remote||local).totalPagesKnown;},hasMore(page){return(remote||local).hasMore(page);},hint:local.hint,sibling(next){return(remote||local).sibling?.(next);},preparePage:page=>invoke('preparePage',page),read:page=>invoke('read',page),close(){if(closed)return;closed=true;local.close();remote?.close();}};
}
const localReader=localReaderAsync;
function matchBook(article,value,db,trace){
 const known=membership(article,db,trace);if(known){const hit=known.bookId===value.bookId;diagnostics.record(trace,'match-book',hit,hit?'mapped':'foreign-book',{chapters:value.chapterCount},value);return hit?known:null;}
 const n=value.chapterCount===1?1:books.ordinal(article);
 if(!n||n>value.chapterCount){diagnostics.record(trace,'match-book',false,'ordinal',{ordinal:n,chapters:value.chapterCount},value);return null;}
 const canonical=article.articleId===books.articleId(value.bookId,n),source=books.isLegacy(article)&&(value.sourceUrl===article.rssSourceUrl||value.sourceUrl===article.url),hit=canonical||source;
 diagnostics.record(trace,'match-book',hit,canonical?'canonical':source?'source':'no-match',{ordinal:n,chapters:value.chapterCount,canonical:Number(canonical),legacy:Number(books.isLegacy(article)),sourceMatch:Number(!!source)},value);
 return hit?{bookId:value.bookId,chapterIndex:n}:null;
}
async function remoteReader(contexts,article,userId,{isClosed=()=>false,diagnostics:trace}={}){
 const db=books.load(),stream=require('./book-stream');let failed=null;
 for(const context of contexts){
  const readable=require('./cloud-format').readable(context.manifest,'manifest');diagnostics.record(trace,'manifest',readable,readable?'selected':'unreadable',{objects:context.manifest.objects.length});if(!readable)continue;
  const direct=context.manifest.objects.filter(o=>o.privateBook&&matchBook(article,o.privateBook,db,trace));
  const archives=context.manifest.objects.filter(o=>o.name===sync.OBJ.PRIVATE_LIBRARY&&['identity','gzip','gzip-chunks-v1'].includes(o.encoding));
  diagnostics.record(trace,'remote',!!(direct.length+archives.length),'selected',{direct:direct.length,archives:archives.length});
  for(const object of direct.concat(archives)){
   const readable=require('./cloud-format').readable(object,'descriptor');diagnostics.record(trace,'descriptor',readable,readable?'selected':'unreadable',{bytes:object.originalBytes},object.privateBook);if(!readable)continue;
   let source=null,options=null;
   try{
    options=await optionsFor(context,userId,{bookId:object.privateBook?.bookId||membership(article,db)?.bookId,reading:true,check:()=>{if(isClosed())throw Object.assign(Error('阅读已关闭'),{code:'reader_closed'});}});const oldCheck=options.check;
    options.check=()=>{oldCheck();if(isClosed())throw Object.assign(Error('阅读已关闭'),{code:'reader_closed'});};
    const catalog=object.privateBook&&!object.entryRef?await readCatalog(context,object,userId):null;source=await require('./snapshot-range').open({descriptor:object,manifest:context.manifest,...options,lengths:catalog?.lengths||[],deferBookVerification:true,close:()=>options.close()});if(catalog)seedCatalog(object,source,catalog);diagnostics.record(trace,'remote',!!source,source?'opened':'unsupported');if(!source){options.close();continue;}
    let value=object.privateBook,range=source,m=value&&matchBook(article,value,db,trace);
    if(value)validDescriptor(value,object);
    else{
     const zip=await require('./private-archive').zipDirectory(source.read.bind(source),source.size),manifestBytes=await zip.entry('manifest.json');
     const manifest=manifestBytes&&JSON.parse(util.bytesToUtf8(manifestBytes)),valid=manifest?.format==='watchrss-library-backup'&&[1,2,3].includes(manifest.version);diagnostics.record(trace,'archive',valid,valid?'opened':'unsupported',{version:manifest?.version,count:zip.entries.size});if(!valid)throw stream.invalid();
     const catalogBytes=zip.entries.has('books.json')?await zip.entry('books.json'):null;
     const catalog=catalogBytes?JSON.parse(util.bytesToUtf8(catalogBytes)):[];if(!Array.isArray(catalog))throw stream.invalid();
     value=catalog.find(v=>matchBook(article,v,db,trace));m=value&&matchBook(article,value,db,trace);diagnostics.record(trace,'catalog',!!value,value?'selected':'missing',{books:catalog.length},value);
     if(value){const path=name(value.bookId);validDescriptor(value,{name:path});range=await zip.entryRange(path);if(!range)throw stream.invalid();}
     else if(zip.entries.has('articles.json')){
      const rows=JSON.parse(util.bytesToUtf8(await zip.entry('articles.json'))),row=require('./private-archive').findArticle(rows,article,trace);
      const textName=row&&'bodies/'+crypto.sha256Hex(row.articleId)+'.txt';
      if(row){const textValid=row.contentTextEntry===textName,text=textValid?await zip.entryRange(textName):null;diagnostics.record(trace,'body',!!(text&&text.size),text&&text.size?'text':textValid?'empty':'invalid-path',{bytes:text?.size||0});if(text&&text.size){const root=source;return stream.plain({range:text,check:options.check,onClose:()=>root.close()});}
       // Some old EPUB chapters have only HTML. Convert that chapter, never
       // articles.json previews or an entire book, and retain owner fences.
       const htmlName='bodies/'+crypto.sha256Hex(row.articleId)+'.html';
       if(row.contentHtmlEntry===htmlName){const bytes=await zip.entry(htmlName);if(bytes){const online=require('./online-reader'),body=online.toText({contentHtml:await require('./storage-async').utf8Strict(bytes,options.check)});diagnostics.record(trace,'body',!!body.trim(),body.trim()?'html':'empty',{bytes:bytes.length,textLength:body.length});if(body.trim()){const local=online.local(body),read=local.read,close=local.close,root=source;local.read=page=>{options.check();return read.call(local,page);};local.close=()=>{close.call(local);root.close();};return local;}}else diagnostics.record(trace,'body',false,'missing');}else diagnostics.record(trace,'body',false,'invalid-path');
      }
     }else diagnostics.record(trace,'alias',false,'missing',{rows:0});
    }
    const decision=context.overlayView?.get('book\n'+value?.bookId),excluded=decision&&(decision.conflict||decision.entry.object===null||decision.context?.head.id!==context.head.id||object.name!==decision.entry.object);diagnostics.record(trace,'overlay',!excluded,excluded?'deleted':'selected');if(excluded){source.close();continue;}
    if(!value||!m){diagnostics.record(trace,'remote',false,'no-match');source.close();continue;}
    const check=()=>{options.check();const s=books.load().books[value.bookId];if(s&&(s.deleted||s.deletedChapters.includes(m.chapterIndex)))throw Object.assign(Error('该章节已删除'),{code:'cloud_book_chapter_deleted'});};
    check();const root=source,relative=require('./library').bookStoragePath(name(value.bookId)),release=budget.reading(value.bookId);budget.touch(relative);
    let reader;try{reader=await stream.open({range:{...range,identity:source.identity+':'+range.identity},expected:value,chapterIndex:m.chapterIndex,indexPath:'cache/book-seek/'+scope.current().id+'/'+value.bookId+'.json',check,onClose:()=>{release();root.close();},sibling:next=>{check();return remoteReader([context],next,userId);}});}catch(error){release();throw error;}
    diagnostics.record(trace,'remote',true,'opened',{chapters:value.chapterCount,ordinal:m.chapterIndex},value);return reader;
   }catch(error){diagnostics.error(trace,'remote',error);if(source)source.close();else if(options)options.close();if(['invalid_session','cloud_session_changed','cloud_operation_cancelled','cloud_content_rebuild_required','NEEDS_RECOVERY','reader_closed','cloud_format_upgrade_required'].includes(error.code))throw error;failed=error;}
  }
 }
 if(failed)throw Object.assign(Error('导入正文暂时无法打开，原备份已保留'),{code:['cloud_entry_missing','network_error','timeout'].includes(failed.code)?failed.code:'reader_book_invalid',...(failed.status?{status:failed.status}:{}),cause:failed});diagnostics.record(trace,'remote',false,'missing',{count:contexts.length});return null;
}

async function migrate(){return books.migrate({readBody:async article=>{const reader=await require('./cloud-reader').open(article,require('./online-reader').toText,{archiveOnly:true});if(!reader)return null;try{const parts=[];for(let i=0;i<reader.totalPages;i++)parts.push(await reader.read(i));return parts.join('');}finally{reader.close();}}});}
async function publish({scope:owner,contexts=[],manual=false,readyBookIds=[],checkBackground=()=>{}}){
 const writerScope=scope.contentCurrent();if(writerScope.userId!==owner.userId)throw Object.assign(Error('账号已切换'),{code:'cloud_session_changed'});
 const checked=()=>{scope.check(writerScope);checkBackground();};checked();
 const own=contexts.find(c=>c.head.sourceDeviceId===require('./device').deviceId());if(own)require('./cloud-format').assertWrite(own.manifest,'manifest');
 const db=books.load(),ready=new Set(readyBookIds);
 const missing=Object.values(db.books).filter(s=>!s.deleted&&!ready.has(s.bookId)),removed=(own?.manifest.objects||[]).filter(o=>o.privateBook&&db.books[o.privateBook.bookId]?.deleted).map(o=>o.name),objects=[],warnings=[];
 for(const s of missing){checked();try{const text=await books.packageTextAsync(s.bookId);checked();if(text===null){if(db.chapters[s.bookId])throw Error('missing');continue;}objects.push({name:name(s.bookId),bytes:await require('./storage-async').utf8Encode(text,checked),compress:true,chunkBytes:9000,utf8Aligned:true,contentSha256:await crypto.sha256HexAsync(text,checked),privateBook:books.descriptor(s)});}catch(error){if(error.code==='cloud_foreground_pending')throw error;warnings.push({bookId:s.bookId,code:error.code||'cloud_book_body_missing'});}}
 if(!objects.length&&!removed.length)return{uploaded:false,pending:!!warnings.length,warnings,readyBookIds:[...ready]};
 const elapsed=Date.now()-new Date(own?.head.completedAt||0).getTime();if(!manual&&own&&elapsed<600000)return{uploaded:false,pending:true,retryAfter:600000-elapsed,warnings,readyBookIds:[...ready]};
 const chapterIds=Object.values(db.chapters).flatMap(mapping=>Object.values(mapping).flat()),reader=require('./cloud-reader');
 const prefixes=chapterIds.map(articleId=>{const n=reader.objectName({articleId});return n.slice(0,n.lastIndexOf('/')+1);});
 checked();const published=await reader.publish(null,'',null,owner.userId,false,null,null,()=>{},{locked:true,backgroundCheck:checkBackground,bookObjects:objects,removePrefixes:removed.concat(prefixes),overlayDeletions:Object.values(db.books).filter(s=>s.deleted).map(s=>({kind:'book',id:s.bookId,changedAt:s.deletedAt}))});for(const object of objects){budget.confirm(require('./library').bookStoragePath(object.name),{snapshotId:published,bookId:object.privateBook.bookId});ready.add(object.privateBook.bookId);}
 return{uploaded:true,pending:!!warnings.length,warnings,readyBookIds:[...ready]};
}
// Existing installations have no storage ledger. Establish receipts from live,
// authenticated ready heads before low-space admission, without full book I/O.
async function confirmLocalCaches(check=()=>{}){
 const library=require('./library'),db=books.load(),articles=library.listArticleViews().filter(a=>a.__bodyFile);if(!Object.keys(db.books).length&&!articles.length)return;
 const owner=scope.contentCurrent(),userId=owner.userId,checked=()=>{check();scope.check(owner);},contexts=await require('./cloud-reader').storageContexts(userId,checked);
 function book(value,context,objectName){const local=db.books[value.bookId],decision=context.overlayView?.get('book\n'+value.bookId);if(decision&&(decision.conflict||decision.entry.object===null||decision.context?.head.id!==context.head.id||decision.entry.object!==objectName))return;if(!local||local.fingerprint!==value.fingerprint||local.chapterCount!==value.chapterCount)return;validDescriptor(value,{name:name(value.bookId)});checked();budget.confirm(library.bookStoragePath(name(value.bookId)),{snapshotId:context.head.id,bookId:value.bookId});}
 for(const context of contexts){checked();if(!require('./cloud-format').readable(context.manifest,'manifest'))continue;const confirmedChunks=['cloud/manifests/'+context.head.id,'cloud/'+scope.current().id+'/manifests/'+context.head.id].filter(file=>storage.exists(file));let inspected=0;for(const chunk of snapshot.allChunks(context.manifest)){const file='cloud/chunks/'+chunk.ciphertextSha256;if(storage.exists(file))confirmedChunks.push(file);if(++inspected%32===0){await require('./cooperative').turn();checked();}}budget.confirmMany(confirmedChunks,{snapshotId:context.head.id});for(const object of context.manifest.objects){if(!require('./cloud-format').readable(object,'descriptor'))continue;if(object.privateBook){validDescriptor(object.privateBook,object);book(object.privateBook,context,object.name);}
  for(const article of articles){const decision=context.overlayView?.get('article\n'+article.articleId);if(decision&&(decision.conflict||decision.entry.object===null||decision.context?.head.id!==context.head.id||decision.entry.object!==object.name))continue;if(object.name===require('./cloud-reader').objectName(article)){checked();budget.confirm(article.__bodyFile,{snapshotId:context.head.id});}}
 }
 const descriptor=context.manifest.objects.find(o=>o.name===sync.OBJ.PRIVATE_LIBRARY);if(!descriptor)continue;
 const options=await optionsFor(context,userId);let source;try{source=await require('./snapshot-range').open({...options,descriptor});const zip=await require('./private-archive').zipDirectory(source.read.bind(source),source.size),manifestBytes=await zip.entry('manifest.json'),head=manifestBytes&&JSON.parse(util.bytesToUtf8(manifestBytes));if(head?.format!=='watchrss-library-backup'||![1,2,3].includes(head.version))continue;const bytes=await zip.entry('books.json');if(!bytes)continue;const catalog=JSON.parse(util.bytesToUtf8(bytes));if(!Array.isArray(catalog))continue;for(const value of catalog)if(zip.entries.has(name(value.bookId)))book(value,context,descriptor.name);
 }finally{if(source)source.close();options.key.fill(0);}
 }
 checked();
}
module.exports={cancelPrefetch,backgroundStatus,waitForPrefetch,optionsFor,confirmLocalCaches,remoteReader,membership,readerOwner,localReaderAsync,restore,publish,migrate,localReader,objectText,validDescriptor};

// One CLI command owns these jobs until its profile lock is released.
module.exports.finishCommand=async function({cancel=false}={}){if(cancel)cancelPrefetch();try{return await waitForPrefetch();}finally{jobs.clear();}};
