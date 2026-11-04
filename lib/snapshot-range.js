// Authenticated logical ranges over existing snapshot objects. A bounded LRU
// retains reader-owned chunks; unknown gzip lengths are discovered from the
// nearer end before requesting the intersecting range.
const snapshot=require('./snapshot'),gzip=require('./gzip'),crypto=require('./crypto'),storage=require('./storage');
const metadata=new Map();
function invalid(){return Object.assign(Error('云端导入正文分块校验异常'),{code:'reader_book_invalid'});}
function create({descriptor,key,loadChunk,check=()=>{},close=()=>{},lengths=[],onRead=()=>{}}){
 const format=require('./cloud-format');format.assertRead(descriptor,'descriptor');format.validateDescriptor(descriptor);
 if(!['identity','gzip-chunks-v1'].includes(descriptor.encoding))return null;
 const accountKey=key;key=snapshot.objectRoot(accountKey,descriptor);
 const identity=crypto.sha256Hex(descriptor.chunks.map(c=>c.ciphertextSha256).join(':')),file='cache/book-range/'+identity+'.json',cacheId=storage.root+':'+identity;
 let sizes=lengths.length?lengths.slice():metadata.get(cacheId);
 if(!sizes){sizes=lengths.slice();{const value=storage.readJSON(file,null);if(value&&Array.isArray(value.sizes)&&value.sizes.length<=descriptor.chunks.length&&value.sizes.every(n=>n===null||Number.isSafeInteger(n)&&n>=0&&n<=4*1024*1024)&&value.checksum===crypto.sha256Hex(JSON.stringify(value.sizes)))sizes=value.sizes.map(n=>n===null?undefined:n);}metadata.set(cacheId,sizes);while(metadata.size>8)metadata.delete(metadata.keys().next().value);}
 const persist=()=>{if(true)try{storage.writeJSON(file,{sizes,checksum:crypto.sha256Hex(JSON.stringify(sizes))});}catch(_){}};
 // Plaintext belongs to this reader only. LRU bounds: four chunks / 12 MiB.
 // Clear every retained block on close, including late in-flight responses.
 const cache=new Map(),pending=new Map();let cacheBytes=0,closed=false;
 const checked=()=>{check();if(closed)throw invalid();};
 function retain(i,bytes){cache.set(i,bytes);cacheBytes+=bytes.length;while(cache.size>4||cacheBytes>12*1024*1024){const first=cache.keys().next().value,old=cache.get(first);cache.delete(first);cacheBytes-=old.length;old.fill(0);}}
 async function chunk(i){checked();if(cache.has(i)){const bytes=cache.get(i);cache.delete(i);cache.set(i,bytes);return bytes;}
  if(pending.has(i))return pending.get(i);const task=(async()=>{const meta=descriptor.chunks[i];if(!meta||meta.ciphertextBytes>17*1024*1024)throw invalid();loadChunk.prefetch?.(descriptor,i);const encrypted=await loadChunk(meta);checked();const plain=await snapshot.decryptChunkAsync(key,meta,encrypted,checked);let raw=plain;
   try{if(descriptor.encoding==='gzip-chunks-v1'){if(plain.length<18)throw invalid();const v=new DataView(plain.buffer,plain.byteOffset,plain.byteLength),size=v.getUint32(plain.length-4,true);if(size>4*1024*1024)throw invalid();raw=await gzip.gunzipAsync(plain,checked);}
    checked();if(raw.length>4*1024*1024||sizes[i]!==undefined&&sizes[i]!==raw.length)throw invalid();if(sizes[i]===undefined){sizes[i]=raw.length;persist();}retain(i,raw);return raw;
   }catch(error){raw.fill(0);throw error;}finally{if(raw!==plain)plain.fill(0);}
  })().finally(()=>pending.delete(i));pending.set(i,task);return task;
 }
 let reading=Promise.resolve();
 async function readRange(start,end){
  checked();if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>descriptor.originalBytes||end-start>16*1024*1024)throw invalid();const out=new Uint8Array(end-start);if(!out.length)return out;
  // ZIP EOCD/directory are at the tail. Discover lengths backwards there;
  // gzip chunk lengths cannot be inferred from their compressed byte lengths.
  const sizeOf=i=>descriptor.encoding==='identity'?descriptor.chunks[i].plaintextBytes:sizes[i];
  let prefix=0,suffix=descriptor.originalBytes;
  for(let i=0;i<descriptor.chunks.length&&prefix<end;i++){const n=sizeOf(i);if(n===undefined)break;prefix+=n;}
  for(let i=descriptor.chunks.length-1;i>=0&&suffix>start;i--){const n=sizeOf(i);if(n===undefined)break;suffix-=n;}
  // Existing length metadata wins over geometric proximity. Switching to the
  // tail halfway through sequential reading would fetch the unread half-book.
  const reverse=Math.max(0,suffix-start)<Math.max(0,end-prefix),selected=[];let offset=reverse?descriptor.originalBytes:0,written=0;
  const usedIndices=new Set();const copy=(raw,item)=>{checked();usedIndices.add(item.i);const a=Math.max(start,item.base),b=Math.min(end,item.base+item.size);out.set(raw.subarray(a-item.base,b-item.base),a-start);written+=b-a;};
  for(let i=reverse?descriptor.chunks.length-1:0;reverse?i>=0&&offset>start:i<descriptor.chunks.length&&offset<end;i+=reverse?-1:1){
   let size=sizeOf(i),raw;if(size===undefined){raw=await chunk(i);size=raw.length;}
   const base=reverse?offset-size:offset;if(base<0||base+size>descriptor.originalBytes)throw invalid();
   if(base<end&&base+size>start){const item={i,base,size};if(raw)copy(raw,item);else selected.push(item);}offset=reverse?base:base+size;
  }
  // Only intersecting chunks are prefetched, at most two at a time. Copy on
  // completion so LRU eviction cannot zero a not-yet-copied result.
  for(let at=0;at<selected.length;at+=2)await Promise.all(selected.slice(at,at+2).map(async item=>{copy(await chunk(item.i),item);}));
  checked();if(written!==out.length)throw invalid();onRead({indices:[...usedIndices].sort((a,b)=>a-b),descriptor});return out;
 }
 return{identity,size:descriptor.originalBytes,sizes,read(start,end){const task=reading.then(()=>readRange(start,end));reading=task.catch(()=>{});return task;},close(){if(closed)return;closed=true;for(const bytes of cache.values())bytes.fill(0);cache.clear();cacheBytes=0;if(key!==accountKey)key.fill(0);close();}};
}
async function open(options){
 const {descriptor:d,manifest,key,loadChunk,check=()=>{},close=()=>{}}=options,format=require('./cloud-format');
 if(manifest)format.assertRead(manifest,'manifest');format.assertRead(d,'descriptor');format.validateDescriptor(d,manifest);
 if(d.entryRef){const target=manifest.objects.find(o=>o.name===d.entryRef.object),source=await open({...options,descriptor:target,close});try{const zip=await require('./private-archive').zipDirectory(source.read.bind(source),source.size),entry=await zip.entryRange(d.entryRef.entryPath);if(!entry)throw format.error('cloud_entry_missing');if(entry.size!==d.originalBytes)throw format.error('cloud_format_invalid');
 // Book rendering authenticates each intersecting chunk before releasing it.
 // Its stored-entry CRC is checked on contiguous EOF or explicit verify();
 // eager verification would download the entire book before its first page.
 if(!options.deferBookVerification||!d.privateBook)await entry.verify();check();return{...entry,identity:source.identity+':'+entry.identity,close:()=>source.close()};}catch(error){source.close();throw error;}}
 const source=create(options);if(source)return source;
 if(d.encoding==='gzip'){
  const encoded=create({...options,descriptor:{...d,encoding:'identity',originalBytes:d.encodedBytes}});if(!encoded)throw format.error();
  const table=Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0;});
  let decoder,at=0,rawAt=0,last=null,done=false,closed=false,crc=-1,active=null,failed=null,reading=Promise.resolve();
  function take(bytes,start){if(!active)return;const a=Math.max(active.a,start),b=Math.min(active.b,start+bytes.length);if(b>a){active.out.set(bytes.subarray(a-start,b-start),a-active.a);active.copied+=b-a;}}
  function reset(){at=rawAt=0;last=null;done=false;crc=-1;decoder=new(require('../vendor/fflate-browser').Gunzip)((bytes,final)=>{if(bytes.length>128*1024||rawAt+bytes.length>d.originalBytes)throw invalid();take(bytes,rawAt);last={start:rawAt,bytes};rawAt+=bytes.length;for(const b of bytes)crc=(crc>>>8)^table[(crc^b)&255];done=final;});}reset();
  async function readRange(a,b){check();if(closed||!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<a||b>d.originalBytes)throw invalid();if(a<rawAt&&(!last||a<last.start))reset();const out=new Uint8Array(b-a);active={a,b,out,copied:0};try{if(last)take(last.bytes,last.start);let deadline=Date.now()+4;while(rawAt<b&&!done){if(Date.now()>=deadline){await require('./cooperative').turn();check();deadline=Date.now()+4;}const end=Math.min(encoded.size,at+64);if(end===at)throw invalid();const bytes=await encoded.read(at,end);at=end;try{decoder.push(bytes,end===encoded.size);}catch(_){throw invalid();}if(done){const trailer=await encoded.read(encoded.size-8,encoded.size),v=new DataView(trailer.buffer,trailer.byteOffset,trailer.byteLength);if(rawAt!==d.originalBytes||v.getUint32(4,true)!==rawAt||v.getUint32(0,true)!==((crc^-1)>>>0))throw invalid();}}check();if(active.copied!==out.length)throw invalid();return out;}finally{active=null;}}
  return{size:d.originalBytes,identity:encoded.identity+':gzip',read(a,b){const task=reading.then(()=>{if(failed)throw failed;return readRange(a,b);}).catch(error=>{if(error.code==='reader_book_invalid')failed=error;throw error;});reading=task.catch(()=>{});return task;},close(){if(closed)return;closed=true;if(last)last.bytes.fill(0);last=null;decoder=null;encoded.close();}};
 }

 throw format.error();
}
module.exports={create,open};
