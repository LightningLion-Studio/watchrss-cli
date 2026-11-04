// Seekable R44 JSONL reader. Never materialize a book/chapter string: decode
// only one visible text page, retain byte offsets, and leave originals intact.
const storage=require('./storage'),util=require('./util');
const BLOCK=8192,PAGE=3000;
const yieldTurn=()=>new Promise(resolve=>setTimeout(resolve,0));
// Shared derivative offsets are bounded and revision-fenced. Never sync-write a
// growing seek JSON on the first-screen or every segment's decoding stack.
const indexes=new Map();
async function offsets(indexPath,range,expected){
 const host=storage.root,key=host+':'+indexPath;let entry=indexes.get(key);
 if(indexPath&&entry&&entry.revision===storage.revision(indexPath)&&entry.saved.size===range.size&&entry.saved.source===(range.identity||'')&&entry.saved.fingerprint===expected.fingerprint)return entry;
 let saved=null;try{saved=indexPath?await storage.readJSONAsync(indexPath,null):null;}catch(_){/* derivative is rebuilt */}
 if(!saved||saved.version!==1||saved.size!==range.size||saved.source!==(range.identity||'')||!Array.isArray(saved.positions)||!saved.chapters||typeof saved.chapters!=='object'||Array.isArray(saved.chapters)||saved.fingerprint!==expected.fingerprint)saved={version:1,size:range.size,source:range.identity||'',fingerprint:expected.fingerprint,positions:[],chapters:{}};
 entry={saved,revision:storage.revision(indexPath),host};if(indexPath)indexes.set(key,entry);while(indexes.size>4)indexes.delete(indexes.keys().next().value);return entry;
}
function persistLater(entry,indexPath){
 if(!indexPath||entry.timer)return;
 entry.timer=setTimeout(async()=>{entry.timer=null;if(storage.root!==entry.host||storage.revision(indexPath)!==entry.revision)return;try{await storage.writeJSONAsync(indexPath,entry.saved,{check:()=>{if(storage.root!==entry.host)throw invalid();}});entry.revision=storage.revision(indexPath);}catch(_){/* derivative only */}},100);
 if(entry.timer&&entry.timer.unref)entry.timer.unref();
}
function invalid(){return Object.assign(Error('导入正文格式或校验异常，原文件已保留'),{code:'reader_book_invalid'});}
class Cursor{
 constructor(range,at,scanning=false){this.range=range;this.at=at;this.bytes=new Uint8Array(0);this.base=at;this.width=scanning&&range.scan&&range.size>262144?65536:BLOCK;this.read=scanning&&range.scan&&range.size>262144?range.scan.bind(range):range.read.bind(range);}
 async fill(){if(this.at>=this.base&&this.at<this.base+this.bytes.length)return;if(this.at>=this.range.size)throw invalid();this.base=this.at;this.bytes=await this.read(this.at,Math.min(this.range.size,this.at+this.width));if(!this.bytes.length||this.bytes.length>this.width)throw invalid();}
 async peek(){await this.fill();return this.bytes[this.at-this.base];}
 async byte(){const b=await this.peek();this.at++;return b;}
 async space(){while([9,10,13,32].includes(await this.peek()))this.at++;}
 async expect(b){if(await this.byte()!==b)throw invalid();}
 async char(){
  const b=await this.byte();if(b===34)return null;if(b<32)throw invalid();
  if(b===92){const e=await this.byte(),simple={34:'"',92:'\\',47:'/',98:'\b',102:'\f',110:'\n',114:'\r',116:'\t'};if(simple[e]!==undefined)return simple[e];if(e!==117)throw invalid();let hex='';for(let i=0;i<4;i++)hex+=String.fromCharCode(await this.byte());if(!/^[a-f\d]{4}$/i.test(hex))throw invalid();return String.fromCharCode(parseInt(hex,16));}
  if(b<128)return String.fromCharCode(b);
  const count=b>=240?4:b>=224?3:b>=194?2:0;if(!count||b>244)throw invalid();let point=b&((1<<(7-count))-1);
  for(let i=1;i<count;i++){const x=await this.byte();if((x&192)!==128)throw invalid();point=(point<<6)|(x&63);}
  if(point>0x10ffff||point>=0xd800&&point<=0xdfff||point<(count===2?128:count===3?2048:65536))throw invalid();return String.fromCodePoint(point);
 }
 // Decode buffered characters without allocating a Promise per byte/character.
 // The async slow path only handles block boundaries (including escapes/UTF-8).
 charBuffered(){
  if(this.base+this.bytes.length-this.at<12)return undefined;
  const bytes=this.bytes;let i=this.at-this.base;const b=bytes[i++];let value;
  if(b===34)value=null;
  else if(b<32)throw invalid();
  else if(b===92){const e=bytes[i++],simple={34:'"',92:'\\',47:'/',98:'\b',102:'\f',110:'\n',114:'\r',116:'\t'};
   if(simple[e]!==undefined)value=simple[e];else{if(e!==117)throw invalid();let hex='';for(let k=0;k<4;k++)hex+=String.fromCharCode(bytes[i++]);if(!/^[a-f\d]{4}$/i.test(hex))throw invalid();value=String.fromCharCode(parseInt(hex,16));}
  }else if(b<128)value=String.fromCharCode(b);
  else{const count=b>=240?4:b>=224?3:b>=194?2:0;if(!count||b>244)throw invalid();let point=b&((1<<(7-count))-1);
   for(let k=1;k<count;k++){const x=bytes[i++];if((x&192)!==128)throw invalid();point=(point<<6)|(x&63);}
   if(point>0x10ffff||point>=0xd800&&point<=0xdfff||point<(count===2?128:count===3?2048:65536))throw invalid();value=String.fromCodePoint(point);
  }this.at=this.base+i;return value;
 }
 async string(limit=256){await this.expect(34);let text='';for(;;){const c=await this.char();if(c===null)return text;text+=c;if(text.length>limit)throw invalid();}}
 async skipString(){await this.expect(34);let escaped=false,turn=this.at;for(;;){if(this.at-turn>=65536){await yieldTurn();turn=this.at;}await this.fill();while(this.at<this.base+this.bytes.length){const b=this.bytes[this.at++-this.base];if(escaped){escaped=false;continue;}if(b===92){escaped=true;continue;}if(b===34)return;if(b<32)throw invalid();}}}
 async skipValue(){await this.space();if(await this.peek()===34)return this.skipString();let depth=0;for(;;){const b=await this.peek();if(depth===0&&(b===44||b===125))return;if(b===34){await this.skipString();continue;}if(b===123||b===91)depth++;if(b===125||b===93)depth--;if(depth<0)throw invalid();this.at++;}}
}
// Use one cursor while building page offsets. Do not allocate/format thousands
// of invisible pages or pay a native read + three timers for every 3000 chars.
async function decodePage(cursor,check,collect){
 const chars=[];let length=0,ended=false,lastStart=cursor.at,last='',count=0,deadline=Date.now()+4;
 while(length<PAGE){const before=cursor.at,buffered=cursor.charBuffered(),c=buffered===undefined?await cursor.char():buffered;if(c===null){ended=true;break;}if(length+c.length>PAGE){cursor.at=before;break;}lastStart=before;last=c;if(collect)chars.push(c);length+=c.length;
  if(++count%1024===0&&(collect&&count===1024||Date.now()>=deadline)){await yieldTurn();check();deadline=Date.now()+4;}
 }
 if(!ended){const before=cursor.at,c=await cursor.char();if(c===null)ended=true;else if(/[\uD800-\uDBFF]$/.test(last)&&/^[\uDC00-\uDFFF]$/.test(c)){if(collect)chars.pop();cursor.at=lastStart;}else cursor.at=before;}
 check();return{ended,text:collect?chars.join(''):null};
}
// Canonical phone/mini JSONL starts with chapterIndex. Probe bounded local
// ranges to find distant chapters without scanning the entire book. Unusual
// field order/very long lines retain the ordinary cancellable scan fallback.
async function locateChapter(range,saved,target,count,check){
 if(!range.scan||target<8)return;
 let low=saved.positions[0],high=range.size;
 for(let attempt=0;attempt<24&&high-low>65536;attempt++){
  check();const mid=Math.floor((low+high)/2),bytes=await range.scan(mid,Math.min(range.size,mid+65536));check();const newline=bytes.indexOf(10);if(newline<0)return;
  const at=mid+newline+1;if(at>=range.size){high=mid;continue;}
  let prefix=bytes.subarray(newline+1,Math.min(bytes.length,newline+1+256));if(prefix.length<64)prefix=await range.read(at,Math.min(range.size,at+256));
  const match=/^\s*\{\s*"chapterIndex"\s*:\s*(\d+)\s*[,}]/.exec(util.bytesToUtf8(prefix));if(!match)return;
  const n=Number(match[1]);if(n<1||n>count)return;saved.positions[n-1]=at;
  if(n===target)return;if(n<target)low=at;else high=mid;
 }
}
function localRange(relative,check=()=>{}){
 const fs=require('node:fs'),filePath=storage.location(relative);let stat;
 try{stat=fs.statSync(filePath);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(!Number.isSafeInteger(stat.size)||stat.size<2)throw invalid();
 const range={size:stat.size,identity:relative+':'+stat.size+':'+stat.mtimeMs,async read(start,end){check();const handle=await fs.promises.open(filePath,'r');try{const out=Buffer.alloc(end-start);const {bytesRead}=await handle.read(out,0,out.length,start);check();if(bytesRead!==out.length)throw invalid();return new Uint8Array(out);}finally{await handle.close();}}};
 range.scan=range.read;return range;
}

async function open({range,expected,chapterIndex,indexPath,check=()=>{},onClose=()=>{},sibling}){
 if(!expected||!Number.isInteger(chapterIndex)||chapterIndex<1||chapterIndex>expected.chapterCount)throw invalid();
 let closed=false;const checked=()=>{if(closed)throw Object.assign(Error('阅读已关闭'),{code:'reader_closed'});check();};
 const entry=await offsets(indexPath,range,expected),saved=entry.saved;checked();
 const persist=()=>persistLater(entry,indexPath);
 // Header is small and checked on every cold open. Cached offsets never turn
 // missing or different original bytes into a successful empty reader.
 const header=new Cursor(range,0),headBytes=[];
 for(;;){const b=await header.byte();if(b===10)break;headBytes.push(b);if(headBytes.length>16384)throw invalid();}
 let head;try{head=JSON.parse(util.bytesToUtf8(new Uint8Array(headBytes)));}catch(_){throw invalid();}
 if(head.format!=='watchrss-book'||head.version!==1||head.chapterCount!==expected.chapterCount||head.instanceId!==expected.instanceId||expected.instanceId!==undefined&&require('./books').id(expected.fingerprint,expected.instanceId)!==expected.bookId)throw invalid();
 saved.positions[0]=header.at;
 let start=saved.positions[chapterIndex-1];
 if(!Number.isSafeInteger(start)){
  await locateChapter(range,saved,chapterIndex,expected.chapterCount,checked);
  start=saved.positions[chapterIndex-1];
  let known=chapterIndex-2;while(known>0&&!Number.isSafeInteger(saved.positions[known]))known--;
  const seek=new Cursor(range,saved.positions[known],true);let line=known,turn=seek.at;
  while(!Number.isSafeInteger(start)&&line<chapterIndex-1){checked();if(seek.at-turn>=65536){await yieldTurn();checked();turn=seek.at;}await seek.fill();while(seek.at<seek.base+seek.bytes.length&&line<chapterIndex-1){if(seek.bytes[seek.at++-seek.base]===10){line++;saved.positions[line]=seek.at;}}}
  start=saved.positions[chapterIndex-1];persist();
 }
 let chapter=saved.chapters[chapterIndex],sampleCursor;
 if(!chapter||chapter.line!==start||!Array.isArray(chapter.pages)||!chapter.pages.length||!chapter.pages.every(p=>Number.isSafeInteger(p)&&p>=start&&p<range.size)){
  const textAt=saved.textPositions&&saved.textPositions[chapterIndex-1];let contentAt;
  if(Number.isSafeInteger(textAt)&&textAt>=start&&textAt<(saved.positions[chapterIndex]||range.size))contentAt=textAt;
  else{
  const scan=new Cursor(range,start);await scan.space();await scan.expect(123);let found=false;
  while(!found){await scan.space();const field=await scan.string();await scan.space();await scan.expect(58);await scan.space();
   if(field==='contentText'){await scan.expect(34);found=true;break;}
   if(field==='chapterIndex'){let token='';while(/[0-9]/.test(String.fromCharCode(await scan.peek())))token+=String.fromCharCode(await scan.byte());if(Number(token)!==chapterIndex)throw invalid();}
   else await scan.skipValue();
   await scan.space();await scan.expect(44);
  }
   contentAt=scan.at;sampleCursor=scan;
  }
  chapter={line:start,pages:[contentAt],complete:false};saved.chapters[chapterIndex]=chapter;persist();
 }
 const contentAt=chapter.pages[0];let bytesPerUnit=1,estimate=null,estimatedAt=0;
 if(!chapter.complete&&chapter.pages.length===1){
  // A small source-byte sample handles UTF-8, surrogate pairs and JSON escapes
  // without decoding a full page or scanning the chapter to find its end.
  checked();const sample=sampleCursor||new Cursor(range,contentAt);let units=0,deadline=Date.now()+4;
  while(units<256){const at=sample.at,buffered=sample.charBuffered(),c=buffered===undefined?await sample.char():buffered;if(c===null){sample.at=at;break;}units+=c.length;if(Date.now()>=deadline){await yieldTurn();checked();deadline=Date.now()+4;}}
  checked();
  if(units)bytesPerUnit=(sample.at-contentAt)/units;
 }
 return{get knownPages(){return Math.max(1,chapter.pages.length-(chapter.complete?1:0));},get totalPages(){return this.knownPages;},get estimatedPages(){
   const known=this.knownPages;if(chapter.complete)return known;
   const pages=chapter.pages.length-1,average=pages?(chapter.pages[pages]-contentAt)/pages:PAGE*bytesPerUnit;
   const end=saved.positions[chapterIndex]||range.size;
   const candidate=Math.ceil((end-contentAt)/average);
   // Keep a stationary thumb stable when density changes: only tighten, by
   // at most 2% per newly parsed page. Repeated layout reads do not decay it.
   if(estimate===null)estimate=candidate;
   else if(pages>estimatedAt)estimate=Math.min(estimate,Math.max(candidate,estimate*Math.pow(0.98,pages-estimatedAt)));
   estimatedAt=pages;estimate=Math.max(known,estimate);return Math.ceil(estimate);
  },get totalPagesKnown(){return chapter.complete;},hasMore(page){return !chapter.complete||page+1<this.knownPages;},hint:'导入文件按需分段读取，仅保留当前阅读窗口',sibling,
  async preparePage(page){if(!Number.isSafeInteger(page)||page<0)throw invalid();if(page>chapter.pages.length)estimate=null;const cursor=new Cursor(range,chapter.pages[chapter.pages.length-1],true);let deadline=Date.now()+4;while(!chapter.complete&&page>=chapter.pages.length){checked();const result=await decodePage(cursor,checked,false);chapter.pages.push(cursor.at);if(result.ended)chapter.complete=true;if(Date.now()>=deadline){await yieldTurn();checked();deadline=Date.now()+4;}}persist();},
  async read(page){checked();if(!Number.isInteger(page)||page<0||page>=this.totalPages)throw invalid();const cursor=new Cursor(range,chapter.pages[page]),result=await decodePage(cursor,checked,true);
   checked();chapter.pages[page+1]=cursor.at;if(result.ended){chapter.complete=true;chapter.pages.length=page+2;}persist();return result.text;
  },close(){if(closed)return;closed=true;onClose();}
 };
}
module.exports={open,localRange,BLOCK,PAGE,invalid};
function plain({range,check=()=>{},onClose=()=>{},sibling}){
 let closed=false;const width=6000;
 return{totalPages:Math.max(1,Math.ceil(range.size/width)),get estimatedPages(){return this.totalPages;},hint:'导入正文按需分段读取',sibling,
  async read(page){check();if(closed)throw Object.assign(Error('阅读已关闭'),{code:'reader_closed'});if(!Number.isInteger(page)||page<0||page>=this.totalPages)throw invalid();if(!range.size)return'';
   const a=page*width,b=Math.min(range.size,a+width),base=Math.max(0,a-3),end=Math.min(range.size,b+4),bytes=await range.read(base,end);check();let start=a-base,stop=b-base;
   while(start<bytes.length&&(bytes[start]&192)===128)start++;while(stop<bytes.length&&(bytes[stop]&192)===128)stop++;return util.bytesToUtf8(bytes.subarray(start,stop));
  },close(){if(closed)return;closed=true;onClose();}
 };
}
module.exports.plain=plain;

function* seedSteps(text,relative,expected){
 // Called only on already validated ingestion bytes, never by a reader open.
 const range=localRange(relative);if(!range)return;const lines=text.slice(0,-1).split('\n'),positions=[],textPositions=[];let at=0;
 for(let i=0;i<lines.length;i++){yield;if(i){positions.push(at);const field=/"contentText"\s*:\s*"/.exec(lines[i]);if(!field)throw invalid();textPositions.push(at+(yield* util.utf8ByteLengthSteps(lines[i].slice(0,field.index+field[0].length))));}at+=(yield* util.utf8ByteLengthSteps(lines[i]))+1;}
 if(at!==range.size||positions.length!==expected.chapterCount)throw invalid();
 try{const scope=require('./cloud-scope').current();storage.writeJSON('cache/book-seek/'+scope.id+'/'+expected.bookId+'.json',{version:1,size:range.size,source:range.identity,fingerprint:expected.fingerprint,positions,textPositions,chapters:{}});}catch(_){}
}
module.exports.seedSteps=seedSteps;

const taskProbe=require('./longtask');if(taskProbe.instrument)taskProbe.instrument(module.exports,'book-stream');
