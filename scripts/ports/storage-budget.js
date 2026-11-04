// Native CLI retention policy. Only named, regenerable caches can be reclaimed.
const storage=require('./storage'),nativeFS=require('node:fs');
function nativeRoot(){const path=require('node:path');return path.dirname(path.dirname(storage.location('state/__budget__')));}
// One file budget for imports, synchronous state writes and async cache writes.
// Durable CLI data is never a candidate, even with a verified cloud receipt.
const MiB=1024*1024,RESERVE=2*MiB,LEDGER='state/storage-cache-v1.json';
let host=null,root='',files=null,savedBytes=0,used=0,ledger=null,busy=false,reserved=0,positions={};
const pins=new Map(),writing=new Map(),readers=new Map(),positionSaved=new Map(),holds=new Map();
let protection=null,admission=null,projectionLocks=0;
// The cap applies to all disk files in WATCHRSS_HOME, across profiles. No
// artificial mini quota, symlink traversal, or deletion of unknown/local data.
function limits(){
 const fs=require('node:fs'),path=require('node:path');let target=storage.root;
 while(!fs.existsSync(target)){const parent=path.dirname(target);if(parent===target)break;target=parent;}
 const stat=fs.statfsSync(target),available=stat.bavail*stat.bsize,total=stat.blocks*stat.bsize,value=process.env.WATCHRSS_STORAGE_LIMIT_BYTES;
 const configured=value===undefined?null:Number(value);
 if(configured!==null&&(!/^[1-9][0-9]*$/.test(value)||!Number.isSafeInteger(configured)))throw Object.assign(Error('WATCHRSS_STORAGE_LIMIT_BYTES 必须为正整数字节数'),{code:'invalid_storage_limit'});
 const limit=configured===null?used+available:configured;
 return{limitBytes:limit,budgetBytes:Math.max(0,Math.min(limit,used+available)-RESERVE),diskAvailableBytes:available,filesystemTotalBytes:total,configuredLimitBytes:configured};
}
function current(){if(host!==storage.root||root!==nativeRoot()){host=storage.root;root=nativeRoot();files=null;ledger=null;used=0;savedBytes=0;reserved=0;pins.clear();writing.clear();touches.clear();readers.clear();positionSaved.clear();positions={};holds.clear();protection=null;admission=null;projectionLocks=0;}return root;}
function absolute(relative){current();return storage.location(relative);}
function relative(path){const prefix=nativeRoot()+require('node:path').sep;return path.startsWith(prefix)?path.slice(prefix.length):null;}
function safe(path){return typeof path==='string'&&path.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!p.includes('\\'));}
function quota(error){return /ENOSPC|quota|no space|disk full|storage full|maximum.*(?:size|storage).*exceed|(?:size|storage).*limit.*exceed|exceed.*(?:storage|quota)|local_storage_full/i.test(String(error?.code||'')+' '+String(error?.errMsg||error?.message||error));}
function full(cause){return Object.assign(Error('这份文件暂时放不下，请拆分后重试'),{code:'local_storage_full',cause});}
function size(path){const s=nativeFS.lstatSync(path);return s.stats||s;}
function refresh(info){current();protection=null;files=new Map();if(info){savedBytes=info.savedBytes||0;for(const row of info.rows)files.set(row.path,row.bytes);}else{
 function walk(path){let s;try{s=path===storage.root?nativeFS.statSync(path):size(path);}catch(e){if(/ENOENT|not found|no such file|not exist/i.test(String(e.errMsg||e.message||e)))return;throw e;}if(s.isDirectory()){for(const name of nativeFS.readdirSync(path)){if(!safe(name)||name.includes('/'))throw Error('Invalid file name');walk(path+'/'+name);}}else{if(!Number.isSafeInteger(s.size)||s.size<0)throw Error('Invalid file size');files.set(path,s.size);}}
 walk(storage.root);
 }used=savedBytes+[...files.values()].reduce((n,v)=>n+v,0);return used;}
function note(path){current();if(!files)return;const old=files.get(path)||0;let bytes=0;try{const s=size(path);if(!s.isDirectory())bytes=s.size;}catch(_){}if(bytes)files.set(path,bytes);else files.delete(path);used+=bytes-old;}
function forget(path){current();if(!files)return;for(const [name,n]of files)if(name===path||name.startsWith(path+'/')){files.delete(name);used-=n;}}
function move(from,to){forget(to);forget(from);note(to);}
function load(){current();if(!ledger){const previous=busy;busy=true;try{const data=require('./storage').readJSON(LEDGER,null);ledger=data?.version===1&&data.entries&&typeof data.entries==='object'?data.entries:{};positions=data?.positions&&typeof data.positions==='object'?data.positions:{};}finally{busy=previous;}}return ledger;}
function save(){if(busy)return;load();busy=true;try{require('./storage').writeJSON(LEDGER,{version:1,entries:load(),positions});}catch(_){/* Receipts are optional recency/diagnostic hints. */}finally{busy=false;}}
function stamp(){const scope=require('./cloud-scope'),ctx=scope.contentCurrent(),trust=scope.load(ctx.userId);if(!trust||trust.needsRecovery||!trust.libraryEpoch)return null;return{scope:ctx.id,epoch:trust.libraryEpoch,generation:ctx.contentGeneration||'',revision:ctx.cacheRevision||0};}
function confirmable(path){return /^(?:lib\/(?:accounts\/[a-zA-Z0-9_-]+\/|guest\/)?(?:books\/[a-f0-9]{64}\.jsonl|saved-bodies\/[a-f0-9]{64}\.json)|cloud\/chunks\/[a-f0-9]{64}|cloud\/(?:[a-f0-9]{32}\/[a-zA-Z0-9_-]+\/)?manifests\/[a-zA-Z0-9_-]{1,128})$/.test(path);}
function receipt(path){if(!confirmable(path))return null;const row=load()[path];if(!row)return null;let now;try{now=stamp();}catch(_){return null;}return now&&['scope','epoch','generation','revision'].every(k=>row[k]===now[k])?row:null;}
function confirmed(path){return !!receipt(path);}
function confirmMany(paths,{snapshotId,bookId}={}){if(!snapshotId)return false;let now;try{now=stamp();}catch(_){return false;}if(!now)return false;const entries=load();let changed=false;for(const path of paths){if(!safe(path)||!confirmable(path))continue;const prior=entries[path],next={...now,snapshotId,bookId:bookId||'',at:prior?.at||0};if(!prior||Object.keys(next).some(k=>next[k]!==prior[k])){entries[path]=next;changed=true;}}require('./pending-payloads').ack(paths);if(changed){save();try{trim();}catch(_){/* Cache trimming cannot undo a server complete. */}}return true;}
function confirm(path,options){return safe(path)&&confirmable(path)?confirmMany([path],options):false;}
function revoke(path){if(load()[path]){delete ledger[path];save();}}
function touch(path){const row=load()[path];if(row){row.at=Date.now();save();}else{touches.set(absolute(path),Date.now());while(touches.size>2048)touches.delete(touches.keys().next().value);}}
const touches=new Map();
function pin(path){const book=path.match(/\/books\/([a-f0-9]{64})\.jsonl$/);if(book){touch(path);return reading(book[1]);}const owner=storage.root,key=absolute(path);pins.set(key,(pins.get(key)||0)+1);touch(path);let released=false;return()=>{if(released)return;released=true;if(typeof storage.root==='undefined'||storage.root!==owner||!key.startsWith(current()+'/'))return;const count=(pins.get(key)||1)-1;if(count)pins.set(key,count);else pins.delete(key);};}
// Reading is a retention preference, never a file pin. Position uses the
// authenticated object's ordered chunk index; the +/-2 window is evicted last.
function reading(bookId){current();const owner=storage.root,ownerRoot=root;readers.set(bookId,(readers.get(bookId)||0)+1);let closed=false;return()=>{if(closed)return;closed=true;if(typeof storage.root==='undefined'||storage.root!==owner||current()!==ownerRoot)return;const n=(readers.get(bookId)||1)-1;if(n)readers.set(bookId,n);else{readers.delete(bookId);save();}};}
function range(file,{bookId,index,series},{persist=true}={}){if(!bookId||!Number.isSafeInteger(index)||index<0||!/^cache\/(?:remote-chunks|local-book-ranges)\//.test(file))return;try{if(!size(absolute(file)).size)return;}catch(_){return;}const entries=load(),prior=entries[file],ref=prior?.references?.[bookId];if(ref?.index===index&&ref.series===series)return;entries[file]={kind:'range',bookId,index,series,references:{...prior?.references,[bookId]:{index,series}},at:prior?.at||0};if(persist)save();}
function focus(bookId,index,series){if(!bookId||!Number.isSafeInteger(index)||index<0)return;load();const at=Date.now();positions[bookId]={index,series,at};if(at-(positionSaved.get(bookId)||0)>1000){positionSaved.set(bookId,at);save();}}
function derived(path){return require('./storage-protection').derived(path);}
function refreshProtection(payloads=false){current();const paths=new Set();if(files)for(const path of files.keys()){const rel=relative(path);if(rel)paths.add(rel);}protection=require('./storage-protection').snapshot(paths,{payloads});return protection;}

function invalidateProtection(path){if(!path||!/^cache\/|^cloud\//.test(path))protection=null;}
function protectedPath(path){for(const set of [pins,writing,holds])for(const key of set.keys())if(path===key||set===holds&&path.startsWith(key+'/'))return true;const rel=relative(path);if(!rel||!derived(rel))return true;try{if(size(path).isSymbolicLink())return true;}catch(error){if(error.code!=='ENOENT')return true;}const policy=require('./storage-protection');if(projectionLocks&&policy.projection(rel))return true;return policy.core(rel)||policy.queue(rel)||(protection||refreshProtection()).has(rel)||[...require('./import-space').active].some(p=>path===p||path.startsWith(p+'/'));}
function reclaimable(path){current();return safe(path)&&derived(path)&&!protectedPath(absolute(path));}
function hold(path){current();const owner=storage.root,ownerRoot=root;holds.set(path,(holds.get(path)||0)+1);let closed=false;return()=>{if(closed)return;closed=true;if(storage.root!==owner||current()!==ownerRoot)return;const n=(holds.get(path)||1)-1;if(n)holds.set(path,n);else holds.delete(path);};}
function lockProjections(){current();const owner=storage.root,ownerRoot=root;projectionLocks++;return()=>{if(storage.root===owner&&current()===ownerRoot)projectionLocks--;};}
function status(){current();return{usedBytes:used,reservedBytes:reserved,...limits(),admission};}
function recordAdmission(value){current();admission=value;}
function sweep(required=0,{force=false,exclude}={}){current();if(busy)return{usedBytes:used};refresh();refreshProtection(true);load();const rows=[],now=Date.now();let retiredRanges=false;busy=true;
 try{for(const [path,bytes]of files){const rel=relative(path);if(path===exclude||protectedPath(path)||rel&&!safe(rel))continue;
 // Candidates are restricted to explicit caches in the active profile.
 {const row=ledger?.[rel];let at=touches.get(path)||row?.at||0;const match=(rel||'').match(/\/books\/([a-f0-9]{64})\.jsonl$/);if(match)try{for(const r of Object.values(require('./books').load().reading))if(r.bookId===match[1])at=Math.max(at,r.readingPositionChangedAt||0);}catch(_){}let distance=Infinity,near=false;for(const [bookId,ref]of Object.entries(row?.references||(row?.bookId?{[row.bookId]:row}:{}))){const focus=positions[bookId],d=focus&&row?.kind==='range'&&focus.series===ref.series?Math.abs(ref.index-focus.index):Infinity;distance=Math.min(distance,d);at=Math.max(at,focus?.at||0);near=near||!!(readers.get(bookId)&&d<=2);}const score=(now-at)/3600000+(Number.isFinite(distance)?Math.log2(1+distance):8);rows.push({path,rel,bytes,at,near,score});}}
 rows.sort((a,b)=>Number(a.near)-Number(b.near)||b.score-a.score||a.path.localeCompare(b.path));const target=force?Math.max(0,used-required-RESERVE):limits().budgetBytes-required-reserved;
 for(const row of rows){if(used<=target)break;if(row.rel){require('./storage').deleteFile(row.rel);}else try{nativeFS.unlinkSync(row.path);}catch(_){}note(row.path);if(!files.has(row.path)&&ledger?.[row.rel]?.kind==='range'){delete ledger[row.rel];retiredRanges=true;}}
 }finally{busy=false;}if(retiredRanges)save();return{usedBytes:used,remainingBytes:Math.max(0,limits().budgetBytes-used-reserved)};}

function ensure(bytes,path,{force=false,cache=false}={}){current();if(busy)return;if(!files)refresh();if(force||used+reserved+bytes>limits().budgetBytes)sweep(bytes,{force,exclude:path});if(used+reserved+bytes>limits().budgetBytes){sweep(bytes,{force:true,exclude:path});if(used+reserved+bytes>limits().budgetBytes){admission={...admission,writeRequiredBytes:bytes,usedBytes:used,reservedBytes:reserved,remainingBytes:Math.max(0,limits().budgetBytes-used-reserved),exhausted:true};throw full();}}}
function begin(path,bytes,append){current();if(busy)return()=>{};if(!files)refresh();const canonical=path.replace(/(?:\.pending|\.async-\d+|\.kv-migration)$/,''),rel=relative(canonical),cache=rel&&reclaimable(rel),release=hold(canonical);try{const old=files.get(path)||0,delta=append?bytes:Math.max(0,bytes-old);ensure(delta,path,{cache});reserved+=delta;writing.set(path,(writing.get(path)||0)+1);let done=false;return()=>{if(done)return;done=true;reserved-=delta;const n=(writing.get(path)||1)-1;if(n)writing.set(path,n);else writing.delete(path);note(path);release();};}catch(error){release();throw error;}}
function recover(path,bytes){refresh();ensure(bytes,path,{force:true});}
function writeSync(path,bytes,operation,{append=false}={}){const end=begin(path,bytes,append);try{try{return operation();}catch(e){if(!quota(e))throw e;const protect=hold(path.replace(/(?:\.pending|\.async-\d+|\.kv-migration)$/, ''));try{end();recover(path,bytes);}finally{protect();}const retry=begin(path,bytes,append);try{return operation();}finally{retry();}}}finally{end();}}
async function write(path,bytes,operation,{append=false,check=()=>{}}={}){check();const owner=storage.root,ownerRoot=current(),before=append?(()=>{try{return size(path).size;}catch(_){return 0;}})():0,end=begin(path,bytes,append);try{try{return await operation();}catch(e){check();if(storage.root!==owner||current()!==ownerRoot)throw e;if(!quota(e))throw e;const protect=hold(path.replace(/(?:\.pending|\.async-\d+|\.kv-migration)$/, ''));try{end();
 // Never duplicate a partially appended block. Roll it back if the runtime offers truncate.
 if(append&&size(path).size!==before){const fs=nativeFS;if(!fs.truncateSync)throw full(e);fs.truncateSync(path,before);}
 recover(path,bytes);check();}finally{protect();}const retry=begin(path,bytes,append);try{return await operation();}finally{retry();}}}finally{if(storage.root===owner&&current()===ownerRoot)end();}}
function trim(){return sweep();}
function overBudget(){current();refresh();return used+reserved>limits().budgetBytes;}
function inventory(){refresh();return{usedBytes:used,rows:[...files].map(([path,bytes])=>({path,bytes})),savedBytes:0,...limits()};}
module.exports={get LIMIT(){return limits().limitBytes;},get BUDGET(){return limits().budgetBytes;},inventory,limits,RESERVE,quota,full,refresh,note,forget,move,ensure,trim,overBudget,sweep,writeSync,write,confirm,confirmMany,confirmed,revoke,touch,pin,derived,reclaimable,absolute,reading,range,focus,flushRanges:save,hold,protectedPath,refreshProtection,invalidateProtection,lockProjections,status,recordAdmission};
