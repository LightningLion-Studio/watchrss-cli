// Public RSS bodies are re-fetchable. Keep them out of the library/KV JSON.
// Saved bodies use protected files; only disposable public files enter the LRU.
const budget=require('./storage-budget');
const storage=require('./storage'),crypto=require('./crypto');
const versions=new WeakMap();
let maxBytes=16*1024*1024,maxEntries=128,root='',ledger=null;
function load(){if(root!==storage.root){root=storage.root;ledger=null;}if(!ledger){const raw=storage.readJSON('cache/rss-bodies/index.json',{})||{};ledger=Object.fromEntries(Object.entries(raw).filter(([file,v])=>/^cache\/rss-bodies\/[a-f0-9]{64}\.json$/.test(file)&&v&&Number.isFinite(v.bytes)&&v.bytes>=0&&Number.isFinite(v.at)));}return ledger;}
async function prepareLedger(check){
 const host=storage.root,owner=host;if(root!==owner){root=owner;ledger=null;}if(ledger)return;
 const raw=await storage.readJSONAsync('cache/rss-bodies/index.json',{})||{};check();if(storage.root!==host||root!==owner)throw Object.assign(Error('本机缓存作用域已变化'),{code:'local_storage_changed'});if(ledger)return;
 const entries=await require('./cooperative').map(Object.entries(raw),([file,v])=>/^cache\/rss-bodies\/[a-f0-9]{64}\.json$/.test(file)&&v&&Number.isFinite(v.bytes)&&v.bytes>=0&&Number.isFinite(v.at)?[file,v]:null,check);check();if(storage.root!==host||root!==owner)throw Object.assign(Error('本机缓存作用域已变化'),{code:'local_storage_changed'});if(!ledger)ledger=Object.fromEntries(entries.filter(Boolean));
}
function save(){try{storage.writeJSON('cache/rss-bodies/index.json',load());}catch(_){} }
function isPublic(a){return /^https?:\/\//i.test(a.rssSourceUrl||'')&&!require('./merge').isImportedContentUrl(a.rssSourceUrl)&&!require('./merge').isImportedContentUrl(a.url||'');}
function protectedBody(a){return !!(a.favoriteSaved||a.watchLaterSaved||a.independentSaved);}
function prune({all=false}={}){
 const map=load(),entries=Object.entries(map).sort((a,b)=>a[1].at-b[1].at);let bytes=entries.reduce((n,[,v])=>n+v.bytes,0),count=entries.length;
 for(const [file,v]of entries){if(!all&&bytes<=maxBytes&&count<=maxEntries)break;storage.deleteFile(file);delete map[file];bytes-=v.bytes;count--;}
 save();return{bytes,count};
}
function get(article){
 if(!article.__bodyFile||! /^(?:cache\/rss-bodies|lib(?:\/accounts\/[a-zA-Z0-9_-]+)?\/saved-bodies)\/[a-f0-9]{64}\.json$/.test(article.__bodyFile))return null;const body=storage.readJSONCached(article.__bodyFile,null);if(body)budget.touch(article.__bodyFile);if(body&&load()[article.__bodyFile])load()[article.__bodyFile].at=Date.now();return body;
}
function available(file){return !!file&&(file.includes('/saved-bodies/')||!!load()[file]);}
function remember(row){if(isPublic(row))versions.set(row,{text:row.contentText,html:row.contentHtml,file:row.__bodyFile,revision:row.__bodyFile?storage.revision(row.__bodyFile):0,pinned:protectedBody(row)});return row;}
function persist(article,prefix){
 if(!isPublic(article))return article;
 const previous=versions.get(article);
 if(previous&&previous.file&&previous.revision===storage.revision(previous.file)&&previous.text===article.contentText&&previous.html===article.contentHtml&&previous.pinned===protectedBody(article)){
  const row={...article,contentText:'',contentHtml:null};if(!available(previous.file))delete row.__bodyFile;return row;
 }
 let body=article.contentText||article.contentHtml?{contentText:article.contentText||'',contentHtml:article.contentHtml||null}:null;
 let file=article.__bodyFile;
 const pinned=protectedBody(article),wasPinned=file&&file.startsWith(prefix+'/saved-bodies/');
 if(!body&&file&&pinned&&!wasPinned)body=get(article);
 if(body){
  const text=JSON.stringify(body),hash=crypto.sha256Hex(text);
  const target=pinned?prefix+'/saved-bodies/'+hash+'.json':'cache/rss-bodies/'+hash+'.json';
  if(pinned&&require('./library').isDirty())require('./pending-payloads').add(target,'saved-body');
  const written=storage.exists(target)?target:storage.writeText(target,text);
  file=written?target:null;
  if(file&&!pinned)load()[file]={bytes:text.length*3,at:Date.now()};
  // A saved original is durable before any state is acknowledged. Its old cache
  // copy can subsequently be removed without threatening the protected file.
  if(pinned&&article.__bodyFile&&article.__bodyFile!==file&&load()[article.__bodyFile]){delete load()[article.__bodyFile];storage.deleteFile(article.__bodyFile);}
 }
 const row={...article,contentText:'',contentHtml:null};if(file)row.__bodyFile=file;else delete row.__bodyFile;return row;
}
function hydrate(article){const body=get(article);return body?{...article,...body}:article;}
function configure({bytes=16*1024*1024,entries=128}={}){maxBytes=bytes;maxEntries=entries;return prune();}
async function pruneAsync(){
 const expected=storage.root;
 for(const [file]of Object.entries(load()).sort((a,b)=>a[1].at-b[1].at)){
  await require('./interaction').whenIdle();if(storage.root!==expected)return;
  storage.deleteFile(file);delete load()[file];
 }
 save();
}
storage.registerCacheCleaner(background=>background?pruneAsync():prune({all:true}));
module.exports={available,remember,persist,hydrate,prune,configure,isPublic,protectedBody};

async function persistAsync(article,prefix,check=()=>{}){
 if(!isPublic(article))return article;
 await prepareLedger(check);
 const previous=versions.get(article);if(previous&&previous.file&&previous.revision===storage.revision(previous.file)&&previous.text===article.contentText&&previous.html===article.contentHtml&&previous.pinned===protectedBody(article))return persist(article,prefix);
 let body=article.contentText||article.contentHtml?{contentText:article.contentText||'',contentHtml:article.contentHtml||null}:null,file=article.__bodyFile;
 const pinned=protectedBody(article);if(!body&&file&&pinned&&!file.startsWith(prefix+'/saved-bodies/'))body=await storage.readJSONAsync(file,null);
 if(body){const text=await require('./cooperative').stringify(body,check),hash=await crypto.sha256HexAsync(text,check),target=(pinned?prefix+'/saved-bodies/':'cache/rss-bodies/')+hash+'.json';check();if(pinned&&require('./library').isDirty())require('./pending-payloads').add(target,'saved-body');if(!storage.exists(target))await storage.writeTextAsync(target,text,{check});check();file=target;if(!pinned)load()[file]={bytes:text.length*3,at:Date.now()};}
 const row={...article,contentText:'',contentHtml:null};if(file)row.__bodyFile=file;else delete row.__bodyFile;return row;
}
module.exports.persistAsync=persistAsync;
