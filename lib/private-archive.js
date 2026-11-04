// Selective WRSS ZIP reads over authenticated logical archive ranges. No files
// are extracted and no complete archive is accumulated in memory.
const util=require('./util'),crypto=require('./crypto'),snapshot=require('./snapshot');
const inflate=require('../vendor/fflate-browser').inflateSync;
const diagnostics=require('./book-diagnostics');
const MAX_DIRECTORY=16*1024*1024,MAX_ENTRY=12*1024*1024;
function invalid(){return Object.assign(Error('私有归档格式或校验无效'),{code:'cloud_private_archive_invalid'});}
function view(bytes){return new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);}
const crcTable=Array.from({length:256},(_,i)=>{let n=i;for(let j=0;j<8;j++)n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;});
function crc32(bytes){let crc=-1;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^-1)>>>0;}
async function zipDirectory(read,size){
 if(!Number.isSafeInteger(size)||size<22||size>0xffffffff)throw invalid();
 const tail=await read(Math.max(0,size-65557),size),v=view(tail);let end=-1;
 for(let i=tail.length-22;i>=0;i--)if(v.getUint32(i,true)===0x06054b50&&i+22+v.getUint16(i+20,true)===tail.length){end=i;break;}
 if(end<0||v.getUint16(end+4,true)||v.getUint16(end+6,true)||v.getUint16(end+8,true)!==v.getUint16(end+10,true))throw invalid();
 const count=v.getUint16(end+10,true),length=v.getUint32(end+12,true),offset=v.getUint32(end+16,true);
 if(count===65535||length>MAX_DIRECTORY||offset+length>size-tail.length+end)throw invalid();
 const bytes=await read(offset,offset+length),d=view(bytes),entries=new Map();let at=0;
 for(let i=0;i<count;i++){
  if(at+46>bytes.length||d.getUint32(at,true)!==0x02014b50)throw invalid();
  const nameSize=d.getUint16(at+28,true),extra=d.getUint16(at+30,true),comment=d.getUint16(at+32,true),next=at+46+nameSize+extra+comment;
  if(next>bytes.length)throw invalid();
  const name=util.bytesToUtf8(bytes.subarray(at+46,at+46+nameSize));
  if(!name||name.startsWith('/')||name.includes('\\')||name.split('/').some(part=>part==='..')||entries.has(name))throw invalid();
  entries.set(name,{flags:d.getUint16(at+8,true),method:d.getUint16(at+10,true),crc:d.getUint32(at+16,true),compressed:d.getUint32(at+20,true),size:d.getUint32(at+24,true),offset:d.getUint32(at+42,true)});at=next;
 }
 if(at!==bytes.length)throw invalid();
 async function location(name,maxBytes=MAX_ENTRY){
  const item=entries.get(name);if(!item)return null;
  if(item.flags&1||![0,8].includes(item.method)||item.size>maxBytes||item.compressed>maxBytes||item.offset+30>=offset)throw invalid();
  const header=await read(item.offset,item.offset+30),h=view(header);if(h.getUint32(0,true)!==0x04034b50||h.getUint16(8,true)!==item.method||h.getUint16(6,true)!==item.flags)throw invalid();
  const nameSize=h.getUint16(26,true),extra=h.getUint16(28,true),start=item.offset+30+nameSize+extra;
  const localName=util.bytesToUtf8(await read(item.offset+30,item.offset+30+nameSize));if(localName!==name||start+item.compressed>offset)throw invalid();return{...item,start};
 }
 async function entry(name,maxBytes=MAX_ENTRY){
  const item=await location(name,maxBytes);if(!item)return null;
  const packed=await read(item.start,item.start+item.compressed);let raw=packed;
  if(item.method!==0){const parts=[];let count=0;const decoder=new(require('../vendor/fflate-browser').Inflate)(part=>{count+=part.length;if(count>item.size)throw invalid();parts.push(part);});let deadline=Date.now()+4;try{for(let at=0;at<packed.length;at+=64){require('./longtask').run('cpu.archive.inflate',Math.min(64,packed.length-at),()=>decoder.push(packed.subarray(at,at+64),at+64>=packed.length));if(Date.now()>=deadline){await require('./cooperative').turn();deadline=Date.now()+4;}}raw=util.bytesConcat(parts);}catch(_){throw invalid();}}
  if(raw.length!==item.size)throw invalid();let crc=-1;for(let at=0;at<raw.length;at+=16384){require('./longtask').run('cpu.archive.CRC32',Math.min(16384,raw.length-at),()=>{for(let i=at;i<Math.min(raw.length,at+16384);i++)crc=(crc>>>8)^crcTable[(crc^raw[i])&255];});await require('./cooperative').turn();}if(((crc^-1)>>>0)!==item.crc)throw invalid();return raw;
 }
 async function entryRange(name,maxBytes=512*1024*1024){
  const item=await location(name,maxBytes);if(!item)return null;
  async function verify(reader){let crc=-1;for(let a=0;a<item.size;a+=65536){await require('./cooperative').turn();const bytes=await reader(a,Math.min(item.size,a+65536));for(const b of bytes)crc=(crc>>>8)^crcTable[(crc^b)&255];}if(((crc^-1)>>>0)!==item.crc)throw invalid();}
  if(item.method===0){let through=0,crc=-1,failed=false;const reader=async(a,b)=>{if(failed||!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<a||b>item.size)throw invalid();const bytes=await read(item.start+a,item.start+b);if(bytes.length!==b-a)throw invalid();
    if(a<=through&&b>through){for(let i=through-a;i<bytes.length;i++)crc=(crc>>>8)^crcTable[(crc^bytes[i])&255];through=b;if(through===item.size&&((crc^-1)>>>0)!==item.crc){failed=true;throw invalid();}}return bytes;};return{size:item.size,identity:name+':'+item.crc,read:reader,verify:()=>verify(reader)};}
  let decoder,packedAt=0,rawAt=0,last=null,checksum=-1,done=false;
  function reset(){packedAt=rawAt=0;checksum=-1;done=false;last=null;decoder=new(require('../vendor/fflate-browser').Inflate)((bytes,final)=>{
   if(bytes.length>2*1024*1024||rawAt+bytes.length>item.size)throw invalid();
   for(const byte of bytes)checksum=(checksum>>>8)^crcTable[(checksum^byte)&255];
   last={start:rawAt,bytes};rawAt+=bytes.length;if(final){done=true;if(rawAt!==item.size||((checksum^-1)>>>0)!==item.crc)throw invalid();}
  });}reset();
  let reading=Promise.resolve();
  async function readRange(a,b){
   if(a<0||b<a||b>item.size)throw invalid();if(a<rawAt&&(!last||a<last.start))reset();const out=new Uint8Array(b-a);let copied=0;
   function take(){if(!last)return;const start=Math.max(a,last.start),end=Math.min(b,last.start+last.bytes.length);if(end>start){out.set(last.bytes.subarray(start-last.start,end-last.start),start-a);copied+=end-start;}}
   take();let deadline=Date.now()+4;while(rawAt<b&&!done){if(Date.now()>=deadline){await require('./cooperative').turn();deadline=Date.now()+4;}const end=Math.min(item.compressed,packedAt+512);if(end===packedAt)throw invalid();const bytes=await read(item.start+packedAt,item.start+end);packedAt=end;decoder.push(bytes,end===item.compressed);take();}
   if(copied!==out.length)throw invalid();return out;
  }
  const result={size:item.size,identity:name+':'+item.crc,read(a,b){const task=reading.then(()=>readRange(a,b));reading=task.catch(()=>{});return task;}};result.verify=()=>verify(result.read);return result;
 }
 return{entry,entries,entryRange};
}
// R44 registration can replace a phone's legacy article ID. Resolve an alias
// only by the exact imported URL AND a nonempty matching content hash. Never
// use a title, summary, preview, or a chapter ordinal from another book.
function findArticle(rows,article,trace){
 if(!Array.isArray(rows)){diagnostics.record(trace,'alias',false,'unsupported');return null;}
 const live=rows.filter(r=>!r.deleted&&typeof r.articleId==='string'&&r.articleId&&(!article.contentHash||r.contentHash===article.contentHash));
 const exact=live.find(r=>r.articleId===article.articleId);if(exact){diagnostics.record(trace,'alias',true,'exact',{rows:rows.length},exact);return exact;}
 const counts=trace?{rows:rows.length,exact:rows.filter(r=>r.articleId===article.articleId).length,urls:rows.filter(r=>r.url===article.url).length,hashes:live.length,deleted:rows.filter(r=>r.deleted&&(r.articleId===article.articleId||r.url===article.url)&&(!article.contentHash||r.contentHash===article.contentHash)).length}:{};
 if(!article.contentHash||!require('./books').isLegacy(article)){diagnostics.record(trace,'alias',false,!article.contentHash?'missing':'not-legacy',counts);return null;}
 const aliases=live.filter(r=>r.url===article.url&&r.contentHash===article.contentHash&&require('./books').isLegacy(r));
 diagnostics.record(trace,'alias',aliases.length===1,aliases.length===1?'url-hash':aliases.length>1?'ambiguous':counts.deleted?'deleted':counts.urls||counts.exact?'hash-mismatch':'url-mismatch',{...counts,aliases:aliases.length},aliases.length===1?aliases[0]:undefined);
 return aliases.length===1?aliases[0]:null;
}
async function readBody({descriptor,manifest,key,loadChunk,check=()=>{},skipBook=()=>false},article,toText,booksOnly=false,original=false){
 const source=await require('./snapshot-range').open({descriptor,manifest,key,loadChunk,check}),size=source.size,range=source.read.bind(source);
 try{
  const zip=await zipDirectory(range,size),manifestBytes=await zip.entry('manifest.json');if(!manifestBytes)throw invalid();
  const manifest=JSON.parse(util.bytesToUtf8(manifestBytes));if(manifest.format!=='watchrss-library-backup'||![1,2,3].includes(manifest.version))throw invalid();
  if(booksOnly){
   const bytes=await zip.entry('books.json');if(!bytes)return[];const catalog=JSON.parse(util.bytesToUtf8(bytes));if(!Array.isArray(catalog))throw invalid();const out=[];
   for(const value of catalog){try{const path='books/'+value.bookId+'.jsonl';if(value.packagePath!==path)throw invalid();if(skipBook(value))continue;const body=await zip.entry(path,32*1024*1024);if(!body)throw invalid();const text=util.bytesToUtf8(body);if(!util.bytesEqual(body,util.utf8ToBytes(text)))throw invalid();require('./books').unpack(text,value);out.push({value,text});}catch(error){out.push({value,error});}}
   return out;
  }
  const metadata=await zip.entry('articles.json');if(!metadata)throw invalid();const rows=JSON.parse(util.bytesToUtf8(metadata));if(!Array.isArray(rows))throw invalid();
  if(!article){
   const values=[];
   for(const row of rows){
    if(row.deleted||typeof row.articleId!=='string'||typeof row.url!=='string'||!row.url)continue;
    const value={};for(const field of ['articleId','url','title','siteName','excerpt','imageUrl','contentHash','importedAt','updatedAt','rssSourceUrl','rssSourceTitle','independentSaved','independentChangedAt','independentSortOrder','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder'])if(row[field]!==undefined)value[field]=row[field];
    // Recover omitted presentation fields from the authenticated original only.
    const prefix='bodies/'+crypto.sha256Hex(row.articleId);let html='',text='';
    if(!value.excerpt&&row.contentTextEntry===prefix+'.txt'){const bytes=await zip.entry(row.contentTextEntry);if(bytes)text=util.bytesToUtf8(bytes);}
    if((!value.excerpt||!value.imageUrl)&&row.contentHtmlEntry===prefix+'.html'){const bytes=await zip.entry(row.contentHtmlEntry);if(bytes)html=util.bytesToUtf8(bytes);}
    if(!value.excerpt){if(!text&&html)text=require('./online-reader').toText({contentHtml:html});value.excerpt=text.replace(/\s+/g,' ').trim().slice(0,280);}
    if(!value.imageUrl&&html){const image=/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(html);if(image){try{const url=new(require('../vendor/url').URL)((image[1]||image[2]||image[3]).replace(/&amp;/g,'&'),row.url);if(['http:','https:'].includes(url.protocol))value.imageUrl=url.toString();}catch(_){/* no usable image */}}}
    for(const field of ['excerpt','imageUrl','siteName','rssSourceTitle'])if(!value[field])delete value[field];
    values.push(value);
   }
   check();return values;
  }
  const row=findArticle(rows,article);if(!row)return null;
  const prefix='bodies/'+crypto.sha256Hex(row.articleId),textName=prefix+'.txt',htmlName=prefix+'.html';
  if(row.contentTextEntry!==textName||row.contentHtmlEntry&&row.contentHtmlEntry!==htmlName)throw invalid();
  const body=await zip.entry(textName);let text=body?util.bytesToUtf8(body):'';
  if(original){const bytes=row.contentHtmlEntry?await zip.entry(htmlName):null;if(row.contentHtmlEntry&&!bytes)throw invalid();check();return{...row,contentText:body?await require('./storage-async').utf8Strict(body,check):'',contentHtml:bytes?await require('./storage-async').utf8Strict(bytes,check):''};}
  if(!text.trim()&&row.contentHtmlEntry){const html=await zip.entry(htmlName);text=html?toText({contentHtml:util.bytesToUtf8(html)}):'';}
  check();return text.trim()?text:null;
 }catch(error){if(error instanceof SyntaxError)throw invalid();throw error;}finally{source.close();}
}
module.exports={zipDirectory,findArticle,readBody,readOriginal:(options,article)=>readBody(options,article,null,false,true),readMetadata:options=>readBody(options,null),readBooks:options=>readBody(options,null,null,true)};
