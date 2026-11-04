// Repeatable bounded payload passes over disk, preserving the R44 JSONL bytes.
const util=require('./util'),crypto=require('./crypto'),files=require('./import-files'),books=require('./books');
const {MAX_CHAPTERS,MAX_ZIP_ENTRIES,chapterError,archiveError}=require('./import-limits');
const MiB=1024*1024,ENTRY_LIMIT=12*MiB,TITLE_LIMIT=16384;
const NUM='0-9０-９一二三四五六七八九十百千万亿零〇两壹贰叁肆伍陆柒捌玖拾佰仟萬';
const heading=new RegExp('^[\\t 　]*(?:(?:第\\s*['+NUM+']+\\s*[章回卷篇部集])|(?:chapter\\s+(?:[0-9]+|[ivxlcdm]+)))[\\t 　:：、.．—-]*[^\\r\\n]{0,100}$','i');
const partial=new RegExp('^[\\t 　]*(?:第\\s*(?:['+NUM+']+\\s*)?|chapter(?:\\s+(?:[0-9]+|[ivxlcdm]+)?\\s*)?)$','i');
function invalid(message){return Error(message||'文件编码暂不支持，请将文本转换为 UTF-8 后再上传');}
function strictUtf8(bytes){
 // TextDecoder consumes a BOM at every call. Interior BOMs are content.
 const bom=bytes[0]===239&&bytes[1]===187&&bytes[2]===191;
 let text=util.bytesToUtf8(bytes);if(bom&&typeof TextDecoder!=='undefined')text='\ufeff'+text;
 if(!util.bytesEqual(util.utf8ToBytes(text),bytes))throw invalid();return text;
}
async function* decoded(source,encoding,skip,onRead=()=>{}){
 const decoder=require('./txt-encoding').createDecoder(encoding);let cr=false;
 function normalize(text){if(cr&&text[0]==='\n')text=text.slice(1);cr=false;if(!text)return '';cr=text.endsWith('\r');return text.replace(/\r\n?/g,'\n');}
 for await(const raw of files.bytes(source,skip)){
  const text=decoder.decode(raw,{stream:true});if(text){const value=normalize(text);if(value)yield value;}onRead(raw.length);
 }
 const tail=decoder.decode();if(tail){const value=normalize(tail);if(value)yield value;}
}
async function* strings(source,start=0,end=source.size){let carry=new Uint8Array(0);for await(const raw of files.bytes(source,start,end,32768)){const bytes=util.bytesConcat([carry,raw]);let stop=bytes.length;if(stop<end-start){let i=stop-1;while(i>=0&&(bytes[i]&192)===128)i--;if(i>=0){const b=bytes[i],n=b>=240?4:b>=224?3:b>=192?2:1;if(stop-i<n)stop=i;}}carry=bytes.slice(stop);if(stop)yield strictUtf8(bytes.subarray(0,stop));}if(carry.length)throw invalid();}
async function* normalizedStrings(source,start,end){let cr=false;for await(let text of strings(source,start,end)){if(cr&&text[0]==='\n')text=text.slice(1);cr=text.endsWith('\r');yield text.replace(/\r\n?/g,'\n');}}
async function inspect(source,start=0,end=source.size,trim=true){
 let offset=start,first=null,last=start,chars=0,firstChars=0,lastChars=0;
 for await(const text of strings(source,start,end)){
  const left=text.search(/\S/),right=text.trimEnd().length;if(left>=0){if(first===null){first=offset+util.utf8ToBytes(text.slice(0,left)).length;firstChars=chars+left;}last=offset+util.utf8ToBytes(text.slice(0,right)).length;lastChars=chars+right;}
  chars+=text.length;offset+=util.utf8ToBytes(text).length;
 }
 const a=trim?(first===null?end:first):start,b=trim?(first===null?end:last):end;const digest=crypto.createSha256();let excerpt='';
 try{for await(const text of strings(source,a,b)){digest.update(util.utf8ToBytes(text));if(excerpt.length<160)excerpt=(excerpt+text).slice(0,160);}return{start:a,end:b,bytes:b-a,chars:trim?lastChars-firstChars:chars,contentHash:digest.hex(),excerpt};}finally{digest.destroy();}
}
// A single sequential scan records trim/character boundaries and heading
// metadata. No chapter body is reread or hashed before the user's decision.
function progress(onPhase,title,total){
 let done=0,last=0,lastAt=Date.now();onPhase(title+'（0.00 / '+(total/MiB).toFixed(2)+' MB）');
 return bytes=>{done+=bytes;if((done-last<256*1024||Date.now()-lastAt<100)&&done<total)return;last=done;lastAt=Date.now();onPhase(title+'（'+(Math.min(done,total)/MiB).toFixed(2)+' / '+(total/MiB).toFixed(2)+' MB）');};
}
// Incremental metadata tracking shares the decode/write pass. Once the user
// chooses a whole article, the remaining blocks never enter the line matcher.
function txtScanner({detect=true,onHeadings=null}={}){
 const found=[];let offset=0,chars=0,lineStart=0,line='',ignored=false,pending=null,first=null,last={byte:0,chars:0},lineFirst=null,lineBefore=last,excerpt='',asked=false,error=null;
 function stop(){detect=false;found.length=0;line='';pending=null;lineFirst=null;}
 function add(value,mark){found.push({title:value.trim().replace(/\s+/g,' '),start:mark.start,first:mark.first,before:mark.before});if(found.length>MAX_CHAPTERS)throw chapterError('TXT');}
 function finish(){
  const here={start:lineStart,first:lineFirst,before:lineBefore},value=pending?pending.value+'\n'+line:line,mark=pending||here;
  if(!ignored&&heading.test(value)){add(value,mark);pending=null;}
  else if(!ignored&&partial.test(value))pending={...mark,value:value.replace(/\s+/g,' ')};
  else {pending=null;if(!ignored&&heading.test(line))add(line,here);else if(!ignored&&partial.test(line))pending={...here,value:line};}
  line='';ignored=false;
  return !!onHeadings&&!asked&&found.length>=3;
 }
 async function decide(){asked=true;if(!await onHeadings(found.length))stop();}
 function whole(text,bytes){
  const left=text.search(/\S/),right=text.trimEnd().length;
  if(left>=0){if(!first)first={byte:offset+(left?util.utf8ToBytes(text.slice(0,left)).length:0),chars:chars+left};last={byte:offset+bytes-(right===text.length?0:util.utf8ToBytes(text.slice(right)).length),chars:chars+right};}
  offset+=bytes;chars+=text.length;
 }
 async function push(text,bytes=util.utf8ToBytes(text).length){
  if(excerpt.length<160){const left=first?0:text.search(/\S/);if(left>=0)excerpt+=text.slice(left,left+160-excerpt.length);}
  if(!detect){whole(text,bytes);return;}
  const startOffset=offset;let at=0;
  while(at<text.length){
   if(!detect){whole(text.slice(at),bytes-(offset-startOffset));return;}
   const newline=text.indexOf('\n',at),end=newline<0?text.length:newline,piece=text.slice(at,end),pieceBytes=util.utf8ToBytes(piece).length,left=piece.search(/\S/),right=piece.trimEnd().length;
   if(left>=0){const point={byte:offset+(left?util.utf8ToBytes(piece.slice(0,left)).length:0),chars:chars+left};if(!first)first=point;if(!lineFirst)lineFirst=point;last={byte:offset+(right===piece.length?pieceBytes:util.utf8ToBytes(piece.slice(0,right)).length),chars:chars+right};}
   offset+=pieceBytes;chars+=piece.length;
   let ask=false;
   try{
    if(!ignored){line+=line?piece:piece.replace(lineFirst&&first&&lineFirst.byte===first.byte?/^\s+/:/^[\t 　]+/,'');if(line.length>TITLE_LIMIT){
     if(partial.test(line)){line=line.replace(/\s+/g,' ');if(line.length>TITLE_LIMIT)throw invalid('TXT 章节标题过长，请缩短标题后上传');}
     else if(heading.test(line))throw invalid('TXT 章节标题过长，请缩短标题后上传');else{line='';ignored=true;}
    }}
    if(newline>=0)ask=finish();
   }catch(cause){error=cause;stop();}
   if(newline>=0){offset++;chars++;lineStart=offset;lineBefore=last;lineFirst=null;at=end+1;}else at=end;
   if(ask)await decide();
  }
 }
 async function end(){
  if(detect){let ask=false;try{ask=finish();}catch(cause){error=cause;stop();}if(ask)await decide();}
  if(error)throw error;const length=first?last.chars-first.chars:0;
  return{headings:found,first,last,whole:{start:first?first.byte:offset,end:first?last.byte:offset,bytes:first?last.byte-first.byte:0,chars:length,excerpt:excerpt.slice(0,Math.min(160,length))}};
 }
 return{push,end};
}
async function hashRange(source,part,report=()=>{}){
 const digest=crypto.createSha256();let excerpt='';try{for await(const text of strings(source,part.start,part.end)){const bytes=util.utf8ToBytes(text);digest.update(bytes);if(excerpt.length<160)excerpt=(excerpt+text).slice(0,160);report(bytes.length);}return{...part,excerpt,contentHash:digest.hex()};}finally{digest.destroy();}
}
async function parseTxt(name,input,stage,limits,{deferHashes=false,onPhase=()=>{},chooseTxtChapters}={}){
 const encoding=require('./txt-encoding'),h=encoding.header(await input.read(0,Math.min(4,input.size))),title=name.replace(/\.txt$/i,'');let decided=false,selection=true;
 async function choose(chapterCount,partial){
  if(decided)return selection;stage.check();const answer=await chooseTxtChapters({title,chapterCount,...(partial?{partial:true}:{})});stage.check();
  if(answer===null)throw Object.assign(Error('已取消导入'),{code:'file_selection_cancelled'});decided=true;selection=!!answer;
  onPhase(selection?'正在识别章节标题':'正在读取并转换文本');return selection;
 }
 async function write(kind,skip){
  const report=progress(onPhase,'正在读取并转换文本',input.size-skip),writer=await stage.writer('text'),scanner=txtScanner({detect:!decided||selection,onHeadings:chooseTxtChapters&&!decided?count=>choose(count,true):null});
  if(!decided||selection)onPhase('正在识别章节标题');
  for await(const text of decoded(input,kind,skip,report)){const bytes=util.utf8ToBytes(text);if(writer.size+bytes.length>limits.maxTextBytes)throw invalid('TXT 正文超过配置上限，请拆分后上传');await scanner.push(text,bytes.length);stage.check();await writer.append(bytes);}
  return scanner.end();
 }
 let scan;try{scan=await write(h.encoding,h.skip);}catch(error){if(h.bom||error.code!=='txt_encoding_invalid')throw error;stage.check();scan=await write('gb18030',0);}
 const headings=scan.headings;let whole=scan.whole,chapters=[];
 if(headings.length>=2){const before=headings[0].before,prefaceChars=scan.first?before.chars-scan.first.chars:0;if(prefaceChars>=24)chapters.push({start:whole.start,end:before.byte,bytes:before.byte-whole.start,chars:prefaceChars,title:'前言',index:1});const prefix=chapters.length;
  for(let i=0;i<headings.length;i++){const h=headings[i],end=headings[i+1]?.before||scan.last,chars=end.chars-h.first.chars;if(chars>=8)chapters.push({start:h.first.byte,end:end.byte,bytes:end.byte-h.first.byte,chars,title:h.title,index:i+1+prefix});}
 }
 if(chapters.length>MAX_CHAPTERS)throw chapterError('TXT');if(chapters.length<2)chapters=[];
 if(chooseTxtChapters&&!decided&&chapters.length&&!await choose(chapters.length,false))chapters=[];
 if(!deferHashes){const source=await stage.open('text');try{whole=await hashRange(source,whole);for(let i=0;i<chapters.length;i++)chapters[i]=await hashRange(source,chapters[i]);}finally{await source.close();}}
 return{whole,chapters,title:title||whole.excerpt.split('\n')[0].slice(0,80),kind:'txt'};
}
function attrs(tag){const out={};tag.replace(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g,(_,k,q,v)=>{out[k]=v;return '';});return out;}
function resolvePath(base,relative){const out=[];for(const p of (base.slice(0,base.lastIndexOf('/')+1)+relative.split('#')[0]).split('/'))if(p==='..')out.pop();else if(p&&p!=='.')out.push(p);return out.join('/');}
async function parseEpub(name,input,stage,limits){
 // Keep the legacy per-entry 12 MiB bomb bound. Total text is configurable;
 // only one XML/HTML entry is decoded at a time, never the whole EPUB.
 const directory=await require('./private-archive').zipDirectory(async(a,b)=>{
  const chunks=[];for await(const bytes of files.bytes(input,a,b))chunks.push(bytes);const value=util.bytesConcat(chunks);
  if(b===input.size){const view=new DataView(value.buffer,value.byteOffset,value.byteLength);for(let i=value.length-22;i>=0;i--)if(view.getUint32(i,true)===0x06054b50&&i+22+view.getUint16(i+20,true)===value.length){if(i>=20&&view.getUint32(i-20,true)===0x07064b50)throw invalid('EPUB 压缩包格式不支持 ZIP64');break;}}
  return value;
 },input.size);
 if(directory.entries.size>MAX_ZIP_ENTRIES)throw archiveError();let total=0;
 for(const [name,item]of directory.entries)if(/\.(?:xml|opf|xhtml|html|htm)$/i.test(name)){if(item.flags&1||item.size>ENTRY_LIMIT)throw invalid('不支持加密或过大的 EPUB 章节');total+=item.size;if(total>limits.maxTextBytes)throw invalid('EPUB 正文超过配置上限，请拆分后上传');}
 async function xml(name){if(!/\.(?:xml|opf|xhtml|html|htm)$/i.test(name))throw invalid('EPUB 缺少必要的目录或章节文件');stage.check();const bytes=await directory.entry(name,ENTRY_LIMIT);if(!bytes)throw invalid('EPUB 缺少必要的目录或章节文件');let value=bytes;if(value[0]===239&&value[1]===187&&value[2]===191)value=value.subarray(3);let text=util.bytesToUtf8(value);if(!util.bytesEqual(util.utf8ToBytes(text),value))throw invalid();text=text.replace(/^\ufeff/,'');if(/<!DOCTYPE[\s\S]*?\b(?:SYSTEM|PUBLIC)\b|<!ENTITY/i.test(text))throw invalid('EPUB 使用了不支持的外部 XML 实体');return text;}
 const container=await xml('META-INF/container.xml'),root=container.match(/<(?:\w+:)?rootfile\b[^>]*>/i),path=root&&attrs(root[0])['full-path'];if(!path)throw invalid('EPUB 未找到书籍目录');
 const opf=await xml(path),items={};for(const item of opf.match(/<(?:\w+:)?item\b[^>]*>/gi)||[]){const a=attrs(item);if(a.id&&a.href)items[a.id]=a;}
 const writer=await stage.writer('text'),chapters=[];
 for(const ref of opf.match(/<(?:\w+:)?itemref\b[^>]*>/gi)||[]){const a=attrs(ref),item=items[a.idref];if(!item||a.linear==='no')continue;const entry=resolvePath(path,decodeURIComponent(item.href));if(!/\.(?:xhtml|html|htm)$/i.test(entry))continue;
  const html=await xml(entry),text=require('./online-reader').toText({contentHtml:html});if(!text.trim())continue;const heading=(html.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)||[])[1],title=heading?require('./online-reader').toText({contentHtml:heading}).trim().slice(0,160):`第 ${chapters.length+1} 章`;
  if(chapters.length)await writer.append(util.utf8ToBytes('\n\n'));const start=writer.size;
  // Even entry strings are encoded/hashed in bounded slices.
  for(let at=0;at<text.length;){let end=Math.min(text.length,at+16384);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;await writer.append(util.utf8ToBytes(text.slice(at,end)));at=end;}
  if(chapters.length>=MAX_CHAPTERS)throw chapterError('EPUB');
  chapters.push({title,start,end:writer.size,index:chapters.length+1});
 }
 const source=await stage.open('text');try{const whole=await inspect(source);if(!whole.bytes)throw invalid('EPUB 没有可阅读的文字，暂不支持扫描版或受 DRM 保护的书籍');for(let i=0;i<chapters.length;i++)chapters[i]={...chapters[i],...await inspect(source,chapters[i].start,chapters[i].end,false)};
 const title=(opf.match(/<(?:dc:)?title\b[^>]*>([\s\S]*?)<\/(?:dc:)?title>/i)||[])[1];return{whole,chapters,title:title?require('./online-reader').toText({contentHtml:`<p>${title}</p>`}).trim():'',kind:'epub'};}finally{await source.close();}
}
function prefix(hash,length){const bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint32(0,length,false);hash.update(bytes);}
function field(hash,text){const bytes=util.utf8ToBytes(text);prefix(hash,bytes.length);hash.update(bytes);}
async function prepare(name,input,stage,limits,{chooseTxtChapters,onPhase=()=>{},now=Date.now()}={}){
 if(!input.size)throw invalid('文件为空');if(input.size>limits.maxFileBytes)throw invalid('文件超过配置上限，请拆分后上传');
 const parsed=/\.txt$/i.test(name)?await parseTxt(name,input,stage,limits,{deferHashes:true,onPhase,chooseTxtChapters}):/\.epub$/i.test(name)?await parseEpub(name,input,stage,limits):null;if(!parsed)throw invalid('只支持 TXT 和 EPUB 文件');if(!parsed.whole.bytes)throw invalid('文件没有可阅读的正文');
 let chapters=parsed.chapters;
 const multi=chapters.length>1;
 onPhase(multi?'正在校验章节正文':'正在校验整篇正文');await util.tick();
 if(parsed.kind==='txt'){const input=await stage.open('text');try{parsed.whole=await hashRange(input,parsed.whole,progress(onPhase,'正在校验整篇正文',parsed.whole.bytes));}finally{await input.close();}}
 const hash=parsed.whole.contentHash,title=parsed.title||name;
 const sourceUrl=multi?`https://watchrss.local/${parsed.kind==='epub'?'import-epub':'import-txt-novel'}/${hash}`:`watchrss://import/online-v1/${hash}`;
 if(!multi)chapters=[{...parsed.whole,title,index:1}];
 const source=await stage.open('text'),hashes=[],report=progress(onPhase,multi?'正在校验章节正文':'正在准备整篇正文',chapters.reduce((sum,c)=>sum+c.bytes,0));
 try{for(let i=0;i<chapters.length;i++){stage.check();const c=chapters[i],digest=crypto.createSha256(),content=parsed.kind==='txt'&&!c.contentHash?crypto.createSha256():null;try{
  field(digest,'watchrss/book/chapter/v1');field(digest,String(i+1));field(digest,books.normalized(c.title));let length=c.bytes;c.packageChars=c.chars;
  // TXT staging is already LF-normalized. Its exact byte/character lengths
  // came from the heading scan; do not reread the body just to count it again.
  if(parsed.kind!=='txt'){length=0;c.packageChars=0;for await(const text of normalizedStrings(source,c.start,c.end)){length+=util.utf8ToBytes(text).length;c.packageChars+=text.length;}}
  prefix(digest,length);let excerpt='';for await(const text of normalizedStrings(source,c.start,c.end)){const bytes=util.utf8ToBytes(text);digest.update(bytes);if(content)content.update(bytes);if(excerpt.length<160)excerpt=(excerpt+text).slice(0,160);report(bytes.length);}
  if(content){c.contentHash=content.hex();c.excerpt=excerpt;}hashes.push(digest.hex());
 }finally{digest.destroy();if(content)content.destroy();}}

 }finally{await source.close();}
 // Only chapter digests and metadata grow with chapter count (at most MAX_CHAPTERS).
 const fingerprintHash=crypto.createSha256();let fingerprint;try{for(const value of ['watchrss/book/fingerprint/v1',String(chapters.length),...hashes])field(fingerprintHash,value);fingerprint=fingerprintHash.hex();}finally{fingerprintHash.destroy();}
 const bookId=books.id(fingerprint),entries=chapters.map((c,i)=>{
  const url=multi?`${sourceUrl}/chapter/${String(c.index||i+1).padStart(4,'0')}-${c.contentHash.slice(0,24)}`:sourceUrl;
  const article=multi?Object.assign(require('./library').defaultArticle(books.articleId(bookId,i+1)),{url,title:c.title,siteName:title,excerpt:c.excerpt,contentHash:c.contentHash,importedAt:now,updatedAt:now,rssSourceUrl:sourceUrl,rssSourceTitle:title}):{articleId:books.articleId(bookId,1),url,title,siteName:'文件导入',excerpt:c.excerpt,contentText:'',contentHtml:null,contentHash:hash,importedAt:now,updatedAt:now,rssSourceUrl:null,rssSourceTitle:null,independentSaved:true,independentChangedAt:now,independentSortOrder:now,deleted:false,deletedAt:0};
  return{article,chapter:c};
 });
 const book=books.state({bookId,fingerprint,title,chapterCount:chapters.length,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:now,sourceDeviceId:require('./device').deviceId(),sourceUrl,kind:/epub/i.test(sourceUrl)?'epub':'txt'});
 // Legacy single-EPUB imports use kind txt, because kind is derived from URL.
 return{book,entries,source:multi?{url:sourceUrl,title,description:'导入书籍',addedAt:now,updatedAt:now,deleted:false,deletedAt:0,pinned:false,pinnedAt:0}:{url:sourceUrl,title},multi,stage};
}
async function packageBook(prepared,limits,onPhase=()=>{}){
 const {book,entries,stage}=prepared,writer=await stage.writer('package'),digest=crypto.createSha256(),positions=[],textPositions=[];const source=await stage.open('text'),report=progress(onPhase,prepared.multi?'正在打包章节正文':'正在打包整篇正文',entries.reduce((sum,e)=>sum+e.chapter.bytes,0));
 const buffer=new Uint8Array(65536);let used=0,total=0;
 // Keep JSON escape boundaries byte-for-byte compatible, but coalesce the
 // resulting fragments before crossing the native file API.
 async function append(text){stage.check();const bytes=util.utf8ToBytes(text);if(total+bytes.length>limits.maxPackageBytes)throw invalid('书包超过兼容上限，请拆分后上传');digest.update(bytes);total+=bytes.length;
  for(let at=0;at<bytes.length;){const n=Math.min(buffer.length-used,bytes.length-at);buffer.set(bytes.subarray(at,at+n),used);used+=n;at+=n;if(used===buffer.length){await writer.append(buffer);used=0;}}
 }
 try{
  // Object key order is books.stable's lexical order, exactly, including LF.
  await append(JSON.stringify({chapterCount:entries.length,format:'watchrss-book',...(book.instanceId===undefined?{}:{instanceId:book.instanceId}),kind:book.kind,sourceUrl:book.sourceUrl,title:book.title,version:1})+'\n');
  for(let i=0;i<entries.length;i++){const {article,chapter}=entries[i],large=chapter.packageChars>=16384;positions.push(total);await append('{"chapterIndex":'+(i+1)+',"contentHtml":null,"contentText":"');textPositions.push(total);
   // Match the existing *async* packer, including JSON escapes when its 4096
   // UTF-16-code-unit stringify slices fall between a valid surrogate pair.
   let pending='';const width=large?4096:16384;
   for await(const text of normalizedStrings(source,chapter.start,chapter.end)){report(util.utf8ToBytes(text).length);pending+=text;while(pending.length>=width){await append(JSON.stringify(pending.slice(0,width)).slice(1,-1));pending=pending.slice(width);}}
   if(pending)await append(JSON.stringify(pending).slice(1,-1));
   const quote=value=>large?'"'+Array.from({length:Math.ceil(value.length/4096)},(_,n)=>JSON.stringify(value.slice(n*4096,n*4096+4096)).slice(1,-1)).join('')+'"':JSON.stringify(value);
   await append('","title":'+quote(books.normalized(article.title))+',"url":'+quote(article.url)+'}\n');
  }
  if(used)await writer.append(buffer.subarray(0,used));
  return{filePath:writer.filePath,size:writer.size,contentSha256:digest.hex(),positions,textPositions};
 }finally{digest.destroy();await source.close();if(stage.remove)await stage.remove('text');}
}
module.exports={prepare,packageBook,decoded,strings,inspect,parseTxt,parseEpub,ENTRY_LIMIT};
