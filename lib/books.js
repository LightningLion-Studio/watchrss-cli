// R44: immutable original books; grow-only deletions and sparse reading records.
// The package is kept separately from article state, including deleted chapters.
const crypto=require('./crypto'),util=require('./util'),storage=require('./storage');
const HEX=/^[a-f0-9]{64}$/,MAX_COUNT=100000,MAX_PACKAGE=32*1024*1024;
const READ=['bookId','chapterIndex','isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','sourceDeviceId',...['favorite','watchLater'].flatMap(p=>['Saved','ChangedAt','SortOrder','SourceDeviceId'].map(k=>p+k))];
function invalid(){return Object.assign(Error('导入书格式或指纹无效'),{code:'cloud_book_invalid'});}
function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object'){const out={};for(const key of Object.keys(v).sort())if(v[key]!==undefined)out[key]=stable(v[key]);return out;}return v;}
function normalized(s){return s.replace(/\r\n?/g,'\n');}
function hash(...strings){return hashValues(strings);}
function hashValues(strings){const parts=strings.map(util.utf8ToBytes),out=new Uint8Array(parts.reduce((n,b)=>n+4+b.length,0)),view=new DataView(out.buffer);let at=0;for(const bytes of parts){view.setUint32(at,bytes.length);out.set(bytes,at+4);at+=4+bytes.length;}return crypto.sha256Hex(out);}
function chapterHash(i,title,text){return hash('watchrss/book/chapter/v1',String(i),normalized(title),normalized(text));}
function* fingerprintSteps(chapters){if(!chapters.length||chapters.length>MAX_COUNT)throw invalid();const hashes=[];for(let i=0;i<chapters.length;i++){yield;if(chapters[i].contentText.length<16384){hashes.push(chapterHash(i+1,chapters[i].title,chapters[i].contentText));continue;}let value;yield {__backgroundTask:true,async:async()=>{value=await crypto.hashLP4Async(['watchrss/book/chapter/v1',String(i+1),normalized(chapters[i].title),normalized(chapters[i].contentText)]);},sync:()=>{value=chapterHash(i+1,chapters[i].title,chapters[i].contentText);}};hashes.push(value);}return hashValues(['watchrss/book/fingerprint/v1',String(chapters.length)].concat(hashes));}
function id(fp,instanceId){if(instanceId===undefined)return hash('watchrss/book/id/v1',fp);if(!/^[a-f0-9]{32}$/.test(instanceId))throw invalid();return hash('watchrss/book/instance-id/v1',fp,instanceId);}
function articleId(bookId,index){return hash('watchrss/book/article/v1',bookId,String(index));}
function uint(v){return Number.isSafeInteger(v)&&v>=0;}
function state(value){
 if(!value||!HEX.test(value.fingerprint)||value.bookId!==id(value.fingerprint,value.instanceId)||typeof value.title!=='string'||!uint(value.chapterCount)||!value.chapterCount||value.chapterCount>MAX_COUNT||typeof value.sourceDeviceId!=='string'||typeof value.deleted!=='boolean'||!['deletionClock','deletedAt','updatedAt'].every(k=>uint(value[k]))||!Array.isArray(value.deletedChapters))throw invalid();
 if(value.lifecycle!==undefined&&(!value.lifecycle||typeof value.lifecycle!=='object'||Array.isArray(value.lifecycle)||Object.keys(value.lifecycle).sort().join(',')!=='generation,operationId,startedAt'||!uint(value.lifecycle.generation)||value.lifecycle.generation<1||!uint(value.lifecycle.startedAt)||!/^[a-f0-9]{32}$/.test(value.lifecycle.operationId)))throw invalid();
 let prior=0;for(const i of value.deletedChapters){if(!uint(i)||i<=prior||i>value.chapterCount)throw invalid();prior=i;}
 const out={};for(const k of ['bookId','fingerprint','title','chapterCount','deletedChapters','deletionClock','deleted','deletedAt','updatedAt','sourceDeviceId','sourceUrl','kind','instanceId','lifecycle'])if(value[k]!==undefined){if(['sourceUrl','kind'].includes(k)&&typeof value[k]!=='string')throw invalid();out[k]=value[k];}return stable(out);
}
function reading(value){
 if(!value||!HEX.test(value.bookId)||!uint(value.chapterIndex)||!value.chapterIndex||value.chapterIndex>MAX_COUNT||typeof value.isRead!=='boolean'||typeof value.sourceDeviceId!=='string'||!uint(value.readingPositionBytes)||!uint(value.readingPositionChangedAt)||!Number.isFinite(value.readingProgress)||value.readingProgress<0||value.readingProgress>1||typeof value.readingPositionContentHash!=='string')throw invalid();
 const out=Object.fromEntries(READ.slice(0,8).map(k=>[k,value[k]]));
 out.readingProgress=Math.floor(value.readingProgress*1e6+.5)/1e6;
 for(const p of ['favorite','watchLater']){
  if(value[p+'Saved']!==undefined){
   if(typeof value[p+'Saved']!=='boolean'||!uint(value[p+'ChangedAt'])||!uint(value[p+'SortOrder'])||value[p+'SourceDeviceId']!==undefined&&typeof value[p+'SourceDeviceId']!=='string')throw invalid();
   for(const k of ['Saved','ChangedAt','SortOrder'])out[p+k]=value[p+k];out[p+'SourceDeviceId']=value[p+'SourceDeviceId']??value.sourceDeviceId;
  }else if(['ChangedAt','SortOrder','SourceDeviceId'].some(k=>value[p+k]!==undefined))throw invalid();
 }
 return stable(out);
}
function compare(a,b,fields){for(const field of fields){const x=typeof field==='function'?field(a):a[field]||'',y=typeof field==='function'?field(b):b[field]||'';if(x!==y)return x<y?-1:1;}return 0;}
function lifecycleOrder(a,b){return compare(a.lifecycle||{generation:0,operationId:''},b.lifecycle||{generation:0,operationId:''},['generation','operationId']);}
function merge(a,b){b=state(b);if(!a)return b;a=state(a);if(a.bookId!==b.bookId||a.chapterCount!==b.chapterCount)throw invalid();
 const order=lifecycleOrder(a,b);if(order!==0)return stable({...order>0?a:b});
 return stable({...compare(a,b,['updatedAt','sourceDeviceId','title','sourceUrl','kind'])>=0?a:b,deletedChapters:[...new Set(a.deletedChapters.concat(b.deletedChapters))].sort((x,y)=>x-y),deletionClock:Math.max(a.deletionClock,b.deletionClock),deletedAt:Math.max(a.deletedAt,b.deletedAt),deleted:a.deleted||b.deleted});}
function mergeReading(a,b){b=reading(b);if(!a)return b;a=reading(a);if(a.bookId!==b.bookId||a.chapterIndex!==b.chapterIndex)throw invalid();
 const out={...compare(a,b,['readingPositionChangedAt','sourceDeviceId',v=>v.isRead?0:1,'readingPositionBytes','readingProgress','readingPositionContentHash'])>=0?a:b};
 for(const p of ['favorite','watchLater']){const winner=b[p+'Saved']===undefined?a:a[p+'Saved']===undefined?b:compare(a,b,[p+'ChangedAt',p+'SourceDeviceId',v=>v[p+'Saved']?0:1,p+'SortOrder'])>=0?a:b;for(const k of ['Saved','ChangedAt','SortOrder','SourceDeviceId'])if(winner[p+k]!==undefined)out[p+k]=winner[p+k];}
 return stable(out);
}
function* packSteps(chapters,metadata){
 const head={format:'watchrss-book',version:1,title:String(metadata.title||''),chapterCount:chapters.length,sourceUrl:String(metadata.sourceUrl||''),kind:String(metadata.kind||'txt'),...(metadata.instanceId===undefined?{}:{instanceId:metadata.instanceId})};if(head.instanceId!==undefined&&!/^[a-f0-9]{32}$/.test(head.instanceId))throw invalid();
 const lines=[JSON.stringify(stable(head))];let bytes=util.utf8ToBytes(lines[0]).length+1;
 for(let i=0;i<chapters.length;i++){yield;const c=chapters[i];if(typeof c.title!=='string'||typeof c.contentText!=='string')throw invalid();
  const row={chapterIndex:i+1,title:normalized(c.title),contentText:normalized(c.contentText),contentHtml:c.contentHtml==null?null:normalized(c.contentHtml),url:String(c.url||'')};
  let line;if(row.contentText.length+(row.contentHtml||'').length<16384)line=JSON.stringify(stable(row));else yield {__backgroundTask:true,async:async()=>{line=await require('./cooperative').stringify(stable(row));},sync:()=>{line=JSON.stringify(stable(row));}};bytes+=(yield* util.utf8ByteLengthSteps(line))+1;if(bytes>MAX_PACKAGE)throw invalid();lines.push(line);
 }
 return lines.join('\n')+'\n';
}
function pack(...args){return require('./background').drain(packSteps(...args));}
function* unpackSteps(text,expected){
 if(typeof text!=='string'||text.length>MAX_PACKAGE||text.charCodeAt(0)===0xfeff||!text.endsWith('\n'))throw invalid();
 try{const lines=text.slice(0,-1).split('\n'),header=lines.shift(),head=JSON.parse(header);if(head.format!=='watchrss-book'||head.version!==1||!uint(head.chapterCount)||!head.chapterCount||lines.length!==head.chapterCount||head.chapterCount>MAX_COUNT||!['title','sourceUrl','kind'].every(k=>typeof head[k]==='string'))throw invalid();
 let byteCount=util.utf8ToBytes(header).length+1;const chapters=[];for(let i=0;i<lines.length;i++){yield;byteCount+=(yield* util.utf8ByteLengthSteps(lines[i]))+1;if(byteCount>MAX_PACKAGE)throw invalid();const c=JSON.parse(lines[i]);if(c.chapterIndex!==i+1||typeof c.title!=='string'||typeof c.contentText!=='string'||typeof c.url!=='string'||c.contentHtml!==null&&typeof c.contentHtml!=='string')throw invalid();chapters.push(c);}
 const fp=(yield* fingerprintSteps(chapters)),bookId=id(fp,head.instanceId);if(expected&&(expected.bookId!==bookId||expected.fingerprint!==fp||expected.chapterCount!==head.chapterCount||expected.instanceId!==head.instanceId))throw invalid();return{head,chapters,fingerprint:fp,bookId};
 }catch(error){if(error.code==='cloud_book_invalid')throw error;throw invalid();}
}
function path(name){return require('./library').bookStoragePath(name);}
let projection=null;
function load(){const file=path('book-state.json'),revision=storage.revision(file),host=storage.root;if(projection&&projection.file===file&&projection.revision===revision&&projection.host===host)return projection.value;const value=storage.readJSONCached(file,null)||{books:{},chapters:{},reading:{}};projection={file,revision,host,value};return value;}
function save(db){
 // User interactions can run between background batches. Merge against the
 // latest durable clocks instead of overwriting edits made during a yield.
 const latest=load();if(latest!==db){
  for(const [id,value]of Object.entries(latest.books))db.books[id]=merge(db.books[id],value);
  for(const [key,value]of Object.entries(latest.reading))if(db.reading[key]!==value)db.reading[key]=mergeReading(db.reading[key],value);
  for(const [id,mapping]of Object.entries(latest.chapters)){const into=db.chapters[id]||(db.chapters[id]={});for(const [n,ids]of Object.entries(mapping))if(into[n]!==ids)into[n]=[...new Set((into[n]||[]).concat(ids))];}
 }
 const file=path('book-state.json');storage.writeJSON(file,db);projection={file,revision:storage.revision(file),host:storage.root,value:db};memberIndexes.delete(db);
}
function mutable(){const db=load();return{books:Object.fromEntries(Object.entries(db.books).map(([id,value])=>[id,{...value,deletedChapters:value.deletedChapters.slice()}])),chapters:Object.fromEntries(Object.entries(db.chapters).map(([id,mapping])=>[id,{...mapping}])),reading:{...db.reading}};}
function packagePath(bookId){if(!HEX.test(bookId))throw invalid();return path('books/'+bookId+'.jsonl');}
let packageRoot='',packageChars=0;const packages=new Map();
function packageKey(bookId){const root=storage.root;if(root!==packageRoot){packages.clear();packageChars=0;packageRoot=root;}const file=packagePath(bookId);return file+':'+storage.revision(file);}
function rememberPackage(key,text,parsed){if(packages.has(key))packageChars-=packages.get(key).text.length;packages.delete(key);packages.set(key,{text,parsed});packageChars+=text.length;while(packages.size>2||packageChars>32*1024*1024){const first=packages.keys().next().value;packageChars-=packages.get(first).text.length;packages.delete(first);}}
function* packageDataSteps(bookId){const key=packageKey(bookId),hit=packages.get(key);if(hit){packages.delete(key);packages.set(key,hit);return hit;}let text;yield {__backgroundTask:true,async:async()=>{text=await storage.readTextAsync(packagePath(bookId));},sync:()=>{text=storage.readText(packagePath(bookId));}};if(text===null)return null;try{const parsed=(yield* unpackSteps(text,load().books[bookId]));rememberPackage(key,text,parsed);return{text,parsed};}catch(_){return null;}}
function* packageTextSteps(bookId){return (yield* packageDataSteps(bookId))?.text||null;}
const memberIndexes=new WeakMap();
function member(article,db=load()){
 let index=memberIndexes.get(db);if(!index){index=new Map();for(const [bookId,mapping]of Object.entries(db.chapters))for(const [n,ids]of Object.entries(mapping))for(const id of ids)index.set(id,{bookId,chapterIndex:Number(n)});memberIndexes.set(db,index);}
 return index.get(article.articleId||article)||null;
}
function isLegacy(article){return /^(?:https:\/\/watchrss\.local\/(?:import-(?:epub|txt-novel)\/|import-content\/(?:txt|epub)\/)|watchrss:\/\/import\/online-v1\/|watchrss-(?:txt|epub):\/\/)/i.test(article.url||'');}
function group(a){return /(?:import-content\/txt\/|import\/online-v1\/)/.test(a.url||'')?a.url:(a.rssSourceUrl||String(a.url).split('/chapter/')[0]);}
function ordinal(a){return Number((String(a.url).match(/\/chapter\/(\d+)/)||[])[1]||0);}
function descriptor(s){return{bookId:s.bookId,fingerprint:s.fingerprint,title:s.title,chapterCount:s.chapterCount,sourceUrl:s.sourceUrl||'',kind:s.kind||'txt',...(s.instanceId===undefined?{}:{instanceId:s.instanceId}),...(s.lifecycle===undefined?{}:{lifecycle:s.lifecycle}),packagePath:'books/'+s.bookId+'.jsonl'};}
function* registerSteps(entries,source={}){
 for(const e of entries){yield;require('./body-authority').requireBookBody(e.article,e.text);}
 const chapters=entries.map(e=>({title:e.article.title||'',contentText:e.text,contentHtml:e.article.contentHtml||null,url:e.article.url||''}));
 const fp=(yield* fingerprintSteps(chapters)),bookId=id(fp),clock=Math.max(0,...entries.map(e=>Math.max(e.article.updatedAt||0,e.article.deletedAt||0))),text=(yield* packSteps(chapters,{title:source.title||entries[0].article.title||'',sourceUrl:source.url||group(entries[0].article),kind:/epub/i.test(source.url||'')?'epub':'txt'}));
 const db=mutable(),candidate=state({bookId,fingerprint:fp,title:source.title||entries[0].article.title||'',chapterCount:entries.length,deletedChapters:entries.flatMap((e,i)=>e.article.deleted?[i+1]:[]),deletionClock:Math.max(0,...entries.map(e=>e.article.deletedAt||0)),deleted:!!source.deleted,deletedAt:source.deletedAt||0,updatedAt:clock,sourceDeviceId:require('./device').deviceId(),sourceUrl:source.url||group(entries[0].article),kind:/epub/i.test(source.url||'')?'epub':'txt'});
 db.books[bookId]=merge(db.books[bookId],candidate);const mapping=db.chapters[bookId]||(db.chapters[bookId]={});entries.forEach((e,i)=>{mapping[i+1]=[...new Set((mapping[i+1]||[]).concat(e.article.articleId))];});
 // Durable original precedes registration; an interrupted write is safe to repeat.
 const priorText=(yield* packageTextSteps(bookId));if(priorText===null)yield {__backgroundTask:true,async:()=>storage.writeTextAsync(packagePath(bookId),text),sync:()=>storage.writeText(packagePath(bookId),text)};save(db);(yield* captureSteps(entries.map(e=>e.article)));(yield* require('./book-stream').seedSteps(priorText===null?text:priorText,packagePath(bookId),db.books[bookId]));return db.books[bookId];
}
function* applySteps(states=[],readings=[]){if(!states.length&&!readings.length)return false;const db=mutable(),before=JSON.stringify(db);for(const value of states)db.books[value.bookId]=merge(db.books[value.bookId],value);for(const value of readings){yield;const key=value.bookId+':'+value.chapterIndex;db.reading[key]=mergeReading(db.reading[key],value);}if(JSON.stringify(db)!==before)save(db);(yield* materializeSteps());return JSON.stringify(db)!==before;}
function* acceptSteps(text,expected){
 const parsed=(yield* unpackSteps(text,expected)),bookId=parsed.bookId,db=mutable();if(!db.books[bookId])db.books[bookId]=state({bookId,fingerprint:parsed.fingerprint,title:parsed.head.title,chapterCount:parsed.head.chapterCount,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:expected?.lifecycle?.startedAt||0,sourceDeviceId:'',sourceUrl:parsed.head.sourceUrl,kind:parsed.head.kind,...(parsed.head.instanceId===undefined?{}:{instanceId:parsed.head.instanceId}),...(expected?.lifecycle===undefined?{}:{lifecycle:expected.lifecycle})});
 if(expected?.lifecycle)db.books[bookId]=merge(db.books[bookId],state({bookId,fingerprint:parsed.fingerprint,title:parsed.head.title,chapterCount:parsed.head.chapterCount,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:expected.lifecycle.startedAt,sourceDeviceId:'',sourceUrl:parsed.head.sourceUrl,kind:parsed.head.kind,...(parsed.head.instanceId===undefined?{}:{instanceId:parsed.head.instanceId}),lifecycle:expected.lifecycle}));
 const mapping=db.chapters[bookId]||(db.chapters[bookId]={});
 const legacy=require('./library').listArticleViews({includeDeleted:true}).filter(a=>isLegacy(a)&&group(a)===parsed.head.sourceUrl);
 const legacyByIndex=new Map();for(const a of legacy){yield;const i=parsed.head.chapterCount===1?1:ordinal(a);if(!legacyByIndex.has(i))legacyByIndex.set(i,[]);legacyByIndex.get(i).push(a);}
 for(const c of parsed.chapters){yield;if(!mapping[c.chapterIndex]?.length){const matches=legacyByIndex.get(c.chapterIndex)||[];mapping[c.chapterIndex]=matches.length?matches.map(a=>a.articleId):[articleId(bookId,c.chapterIndex)];}}
 yield {__backgroundTask:true,async:()=>storage.writeTextAsync(packagePath(bookId),text),sync:()=>storage.writeText(packagePath(bookId),text)};save(db);(yield* materializeSteps(bookId,parsed));(yield* require('./book-stream').seedSteps(text,packagePath(bookId),db.books[bookId]));return db.books[bookId];
}
function* materializeSteps(only,parsed){
 const library=require('./library');(yield* captureSteps(library.listArticleViews({includeDeleted:true})));const db=load(),rows=[],sources=[],localById=new Map(library.listArticleViews({includeDeleted:true}).map(a=>[a.articleId,a]));
 for(const s of Object.values(db.books)){yield;if(only&&s.bookId!==only)continue;const mapping=db.chapters[s.bookId]||{},p=parsed&&parsed.bookId===s.bookId?parsed:(yield* packageDataSteps(s.bookId))?.parsed;
 const source=s.sourceUrl||'watchrss://book/'+s.bookId;
 if(p)sources.push({url:source,title:s.title,description:'导入书籍',updatedAt:s.updatedAt,deleted:s.deleted,deletedAt:s.deletedAt});
 for(const [index,ids]of Object.entries(mapping)){yield;
 for(const alias of ids.slice(1)){yield;const row=library.getArticle(alias);if(row){library.mergeArticles([{...row,articleId:ids[0]}]);library.removeArticle(alias);}}
 const aid=ids[0];const old=localById.get(aid),chapter=p?.chapters[Number(index)-1],r=db.reading[s.bookId+':'+index];if(!old&&!chapter)continue;
 let row=old||{...library.defaultArticle(aid),url:chapter.url||source+'/chapter/'+index,title:chapter.title,siteName:s.title,excerpt:chapter.contentText.slice(0,160),contentHash:crypto.sha256Hex(chapter.contentText),rssSourceUrl:source,rssSourceTitle:s.title};
 if(s.lifecycle)row={...row,__bookLifecycle:true,deleted:false,deletedAt:0};
 if(r)row={...row,__bookReading:true,...Object.fromEntries(READ.filter(k=>!['bookId','chapterIndex'].includes(k)&&r[k]!==undefined).map(k=>[k,r[k]]))};
 if(s.deleted||s.deletedChapters.includes(Number(index))){
 const kinds=['favorite','watchLater','independent'],at=Math.max(row.deletedAt||0,s.deleted?s.deletedAt:s.deletionClock,...kinds.map(k=>row[k+'Saved']?(row[k+'ChangedAt']||0)+1:0));
 row={...row,deleted:true,deletedAt:at,updatedAt:Math.max(row.updatedAt||0,at)};for(const k of kinds){yield;row[k+'Saved']=false;row[k+'ChangedAt']=Math.max(at,row[k+'ChangedAt']||0);}
 }
 rows.push(row);
 }
 }
 if(rows.length||sources.length)yield {__backgroundTask:true,async:()=>library.applyCloudIndexAsync(rows,sources,{requirePersist:true,skipUnchanged:true}),sync:()=>library.applyCloudIndex(rows,sources,{requirePersist:true,skipUnchanged:true})};
}
function* captureSteps(articles){const db=mutable();let changed=false;for(const a of articles){yield;const m=member(a,db);if(!m)continue;const s=db.books[m.bookId];if(a.deleted&&s.lifecycle&&(a.deletedAt||a.updatedAt||0)<=s.lifecycle.startedAt)continue;if(a.deleted&&!s.deletedChapters.includes(m.chapterIndex)){changed=true;s.deletedChapters.push(m.chapterIndex);s.deletedChapters.sort((x,y)=>x-y);s.deletionClock=Math.max(s.deletionClock,a.deletedAt||a.updatedAt||0);}
 // Permanent R44 deletion masks saved projections; its generated cancellations
 // are not user reading/save operations and must never be captured as new clocks.
 if(s.deleted||s.deletedChapters.includes(m.chapterIndex))continue;
 if(a.isRead||a.readingProgress||a.readingPositionChangedAt||a.favoriteChangedAt||a.watchLaterChangedAt||a.favoriteSaved||a.watchLaterSaved){const key=m.bookId+':'+m.chapterIndex,prior=db.reading[key],clock=a.readingPositionChangedAt||a.updatedAt||0,device=prior&&clock>prior.readingPositionChangedAt?require('./device').deviceId():a.sourceDeviceId||prior?.sourceDeviceId||require('./device').deviceId();const value=reading({bookId:m.bookId,chapterIndex:m.chapterIndex,isRead:!!a.isRead,readingProgress:a.readingProgress||0,readingPositionBytes:a.readingPositionBytes||0,readingPositionContentHash:a.readingPositionContentHash||'',readingPositionChangedAt:clock,sourceDeviceId:device,...Object.fromEntries(['favorite','watchLater'].flatMap(p=>{
  if(!a[p+'ChangedAt']&&!a[p+'Saved'])return [];
  const unchanged=prior&&['Saved','ChangedAt','SortOrder'].every(k=>prior[p+k]===a[p+k]);
  const writer=a[p+'SourceDeviceId']??(unchanged?prior[p+'SourceDeviceId']:a.sourceDeviceId||require('./device').deviceId());
  return ['Saved','ChangedAt','SortOrder','SourceDeviceId'].map(k=>[p+k,k==='SourceDeviceId'?writer:k==='Saved'?!!a[p+k]:a[p+k]||0]);
 }))});if(!prior||READ.some(k=>prior[k]!==value[k])){db.reading[key]=mergeReading(prior,value);changed=true;}}}
 if(changed)save(db);
 return db;
}
function deleteBook(url,clock){const db=mutable();let changed=false;for(const s of Object.values(db.books))if(s.sourceUrl===url&&!s.deleted){s.deleted=true;s.deletedAt=Math.max(clock,s.deletedAt,s.deletionClock,s.lifecycle?s.lifecycle.startedAt+1:0);s.deletionClock=s.deletedAt;changed=true;}if(changed)save(db);}
function* projectSteps(articles,sources){const db=(yield* captureSteps(articles)),members=new Set(Object.values(db.chapters).flatMap(m=>Object.values(m).flat())),urls=new Set(Object.values(db.books).map(s=>s.sourceUrl));return{articles:articles.filter(a=>!members.has(a.articleId)&&!isLegacy(a)),sources:sources.filter(s=>!urls.has(s.url)),books:Object.values(db.books),bookReading:Object.values(db.reading)};}
async function migrate({readBody}={}){
 const migrationOwner=require('./account').getUsableSession(),check=()=>{const now=require('./account').getUsableSession();if(migrationOwner?.userId!==now?.userId||migrationOwner?.accessToken!==now?.accessToken)throw Object.assign(Error('账号已切换'),{code:'cloud_session_changed'});};
 const library=require('./library'),db=load(),groups=new Map(),warnings=[];
 for(const a of library.listArticleViews({includeDeleted:true}))if(isLegacy(a)&&!member(a,db)){const key=group(a);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(a);}
 for(const [url,rows]of groups){const existing=Object.values(db.books).find(s=>s.sourceUrl===url);
 if(existing){
  const text=await packageTextAsync(existing.bookId);if(text!==null){const original=await unpackAsync(text,existing),latest=mutable(),mapping=latest.chapters[existing.bookId]||(latest.chapters[existing.bookId]={});
   for(const row of rows){const index=existing.chapterCount===1?1:ordinal(row),chapter=original.chapters[index-1];if(!chapter||normalized(row.title||'')!==chapter.title)continue;mapping[index]=[...new Set((mapping[index]||[articleId(existing.bookId,index)]).concat(row.articleId))];}save(latest);await captureAsync(rows);await materializeAsync(existing.bookId);
  }continue;
 }
 try{rows.sort((a,b)=>ordinal(a)-ordinal(b)||a.url.localeCompare(b.url));if(rows.some(a=>ordinal(a)>0)&&rows.some((a,i)=>ordinal(a)!==i+1))throw invalid();const entries=[];
 for(const a of rows){if(entries.length%32===0){await require('./interaction').whenIdle();check();}const full=library.getArticle(a.articleId);let text=full?.contentText;if(!text&&full?.contentHtml)text=require('./online-reader').toText(full);if(!text&&readBody){text=await readBody(a);check();}if(typeof text!=='string'||!text.length)throw Object.assign(invalid(),{code:'cloud_book_body_missing'});require('./body-authority').requireBookBody(full||a,text);entries.push({article:{...a,...full},text});}
 await registerAsync(entries,library.getSource(url)||{url,title:rows[0].rssSourceTitle||rows[0].title});
 }catch(error){check();warnings.push({sourceUrl:url,code:error.code||'cloud_book_body_missing'});}}
 await captureAsync(library.listArticleViews({includeDeleted:true}));return warnings;
}
function transfer(oldPrefix,choice){
 const prior=storage.readJSON(oldPrefix+'/book-state.json',null);if(choice==='merge'&&prior){const db=load();for(const value of Object.values(prior.books||{})){const text=storage.readText(oldPrefix+'/books/'+value.bookId+'.jsonl');if(text!==null){unpack(text,value);storage.writeText(packagePath(value.bookId),text);}db.books[value.bookId]=merge(db.books[value.bookId],value);const mapping=db.chapters[value.bookId]||(db.chapters[value.bookId]={});for(const [index,ids]of Object.entries(prior.chapters[value.bookId]||{}))mapping[index]=[...new Set((mapping[index]||[]).concat(ids))];}for(const [key,value]of Object.entries(prior.reading||{}))db.reading[key]=mergeReading(db.reading[key],value);save(db);}else if(choice==='clear'){clear();storage.deleteFile(oldPrefix+'/book-state.json');storage.removeTree(oldPrefix+'/books');}
}
function clear(){storage.deleteFile(path('book-state.json'));storage.removeTree(path('books'));}
function fingerprint(...args){return require('./background').drain(fingerprintSteps(...args));}
function fingerprintAsync(...args){return require('./background').run(fingerprintSteps(...args));}
function unpack(...args){return require('./background').drain(unpackSteps(...args));}
function unpackAsync(...args){return require('./background').run(unpackSteps(...args));}
function register(...args){return require('./background').drain(registerSteps(...args));}
function registerAsync(...args){return require('./background').run(registerSteps(...args));}
function apply(...args){return require('./background').drain(applySteps(...args));}
function applyAsync(...args){return require('./background').run(applySteps(...args));}
function accept(...args){return require('./background').drain(acceptSteps(...args));}
function acceptAsync(...args){return require('./background').run(acceptSteps(...args));}
function materialize(...args){return require('./background').drain(materializeSteps(...args));}
function materializeAsync(...args){return require('./background').run(materializeSteps(...args));}
function capture(...args){return require('./background').drain(captureSteps(...args));}
function captureAsync(...args){return require('./background').run(captureSteps(...args));}
function project(...args){return require('./background').drain(projectSteps(...args));}
function projectAsync(...args){return require('./background').run(projectSteps(...args));}
function packageData(...args){return require('./background').drain(packageDataSteps(...args));}
function packageDataAsync(...args){return require('./background').run(packageDataSteps(...args));}
function packageText(...args){return require('./background').drain(packageTextSteps(...args));}
function packageTextAsync(...args){return require('./background').run(packageTextSteps(...args));}
module.exports={fingerprintAsync,unpackAsync,registerAsync,applyAsync,acceptAsync,materializeAsync,captureAsync,projectAsync,packageDataAsync,packageTextAsync,packageData,normalized,chapterHash,fingerprint,id,articleId,state,reading,merge,mergeReading,pack,unpack,register,accept,apply,materialize,capture,deleteBook,project,migrate,member,isLegacy,group,ordinal,descriptor,packageText,load,clear,transfer,READ};

async function prepare(){const host=storage.root,file=path('book-state.json'),revision=storage.revision(file);if(projection&&projection.file===file&&projection.revision===revision&&projection.host===host)return;const value=await storage.readJSONAsync(file,null)||{books:{},chapters:{},reading:{}};if(storage.root!==host||path('book-state.json')!==file||storage.revision(file)!==revision)throw Object.assign(Error('本机资料已更新'),{code:'local_storage_changed'});projection={file,revision,host,value};}
module.exports.prepare=prepare;

// Import-stream already verified content hashes, LP4 fingerprint and JSONL
// bytes. Preview never registers a half-book while cloud publication is pending.
function assertImportReadable(candidate){
 if(candidate.deleted)throw Object.assign(Error('该书已删除，不能通过重复导入恢复'),{code:'cloud_book_deleted'});
 if(candidate.deletedChapters.length===candidate.chapterCount)throw Object.assign(Error('这份文件的全部章节已删除，不能通过重复导入恢复'),{code:'cloud_book_chapter_deleted'});
 return candidate;
}
function streamCandidate(candidate){return assertImportReadable(merge(load().books[candidate.bookId],candidate));}
function commitStream(prepared,check=()=>{},{remoteOnly=false}={}){
 check();const {book,entries,source,package:packed}=prepared,db=mutable(),candidate=assertImportReadable(merge(db.books[book.bookId],book));
 if(candidate.deleted)throw Object.assign(Error('该书已删除，不能通过旧内容包恢复'),{code:'cloud_book_deleted'});
 const relative=packagePath(book.bookId),file=storage.resolvePath(relative);
 // This synchronous rename/metadata commit cannot interleave an account switch.
 check();if(!remoteOnly){require('./storage-budget').writeSync(file,0,()=>require('./import-files').commit(packed.filePath,relative));require('./storage-budget').move(packed.filePath,file);storage.invalidate(relative);}
 db.books[book.bookId]=candidate;const mapping=db.chapters[book.bookId]||(db.chapters[book.bookId]={});
 entries.forEach((e,i)=>{mapping[i+1]=[...new Set((mapping[i+1]||[]).concat(e.article.articleId))];});
 const rows=entries.map((entry,i)=>{let row=entry.article;if(candidate.lifecycle)row={...row,__bookLifecycle:true,deleted:false,deletedAt:0};const reading=db.reading[book.bookId+':'+(i+1)];
  if(reading)row={...row,__bookReading:true,...Object.fromEntries(READ.filter(k=>!['bookId','chapterIndex'].includes(k)&&reading[k]!==undefined).map(k=>[k,reading[k]]))};
  if(candidate.deletedChapters.includes(i+1)){const at=Math.max(candidate.deletionClock,row.deletedAt||0);row={...row,deleted:true,deletedAt:at,updatedAt:Math.max(row.updatedAt||0,at)};for(const k of ['favorite','watchLater','independent']){row[k+'Saved']=false;row[k+'ChangedAt']=Math.max(at,row[k+'ChangedAt']||0);}}
  return row;
 });save(db);require('./library').applyCloudIndex(rows,prepared.multi?[source]:[],{requirePersist:true});
 // Offsets came from the exact writer; never split or parse a chapter line.
 try{const range=require('./book-stream').localRange(relative),scope=require('./cloud-scope').current();if(range&&!remoteOnly)storage.writeJSON('cache/book-seek/'+scope.id+'/'+book.bookId+'.json',{version:1,size:packed.size,source:range.identity,fingerprint:book.fingerprint,positions:packed.positions,textPositions:packed.textPositions,chapters:{}});}catch(_){}
 return candidate;
}
Object.assign(module.exports,{assertImportReadable,streamCandidate,commitStream});
const bookProbe=require('./longtask');if(bookProbe.instrument)bookProbe.instrument(module.exports,'books');

// Authenticated metadata only. A missing legacy sidecar gets ordinal labels;
// the background verifier replaces those labels with the original directory.
async function acceptRemote(value,catalog,check=()=>{},{deferPersist=false}={}){
 const descriptor=value,bookId=value.bookId;
 const candidate=state({deleted:false,deletedChapters:[],deletionClock:0,deletedAt:0,updatedAt:value.lifecycle?.startedAt||0,sourceDeviceId:'',...value});
 function* steps(){const db=mutable();check();db.books[bookId]=merge(db.books[bookId],candidate);const mapping=db.chapters[bookId]||(db.chapters[bookId]={}),rows=[],library=require('./library'),oldById=new Map(library.listArticleViews({includeDeleted:true}).map(row=>[row.articleId,row])),display=db.books[bookId],source=display.sourceUrl||value.sourceUrl||'watchrss://book/'+bookId;
  for(let i=1;i<=value.chapterCount;i++){yield;check();if(!mapping[i]?.length)mapping[i]=[articleId(bookId,i)];const aid=mapping[i][0],old=oldById.get(aid),chapter=catalog?.rows[i-1];if(old&&!chapter)continue;
   let row={...library.defaultArticle(aid),...old,url:chapter?.url||old?.url||source+'/chapter/'+i,title:chapter?chapter.title:old?.title||'第 '+i+' 章',siteName:display.title,rssSourceUrl:source,rssSourceTitle:display.title,...(chapter?{excerpt:chapter.excerpt,contentHash:chapter.contentHash,__privateBodyMetadata:true,__privateBodyClock:0}:{})};
   if(display.lifecycle)row={...row,__bookLifecycle:true,deleted:false,deletedAt:0};
   const r=db.reading[bookId+':'+i];if(r)row={...row,__bookReading:true,...Object.fromEntries(READ.filter(k=>!['bookId','chapterIndex'].includes(k)&&r[k]!==undefined).map(k=>[k,r[k]]))};
   const state=db.books[bookId];if(state.deleted||state.deletedChapters.includes(i)){row.deleted=true;row.deletedAt=Math.max(row.deletedAt||0,state.deletedAt,state.deletionClock);for(const k of ['favorite','watchLater','independent']){row[k+'Saved']=false;row[k+'ChangedAt']=Math.max(row[k+'ChangedAt']||0,row.deletedAt);}}
   rows.push(row);
  }
  check();save(db);yield {__backgroundTask:true,async:()=>library.applyCloudIndexAsync(rows,[{url:source,title:display.title,description:'导入书籍',updatedAt:db.books[bookId].updatedAt,deleted:db.books[bookId].deleted,deletedAt:db.books[bookId].deletedAt}],{requirePersist:true,skipUnchanged:true,check,deferPersist,batchSize:64}),sync:()=>{throw invalid();}};
 }
 await require('./background').run(steps());check();return load().books[bookId];
}
module.exports.acceptRemote=acceptRemote;

// Explicit user choices are previews; publication precedes registry/index commit.
function importCandidate(prepared,choice,existing){
 const old=existing||load().books[prepared.book.bookId],candidate=prepared.book;
 if(choice==='restore'){
  if(!old||old.fingerprint!==candidate.fingerprint||old.chapterCount!==candidate.chapterCount)throw invalid();
  if(!old.deleted&&!old.deletedChapters.length)prepared.book=state(old);else{
  const generation=(old.lifecycle?.generation||0)+1,at=Math.max(Date.now(),old.updatedAt+1,old.deletedAt+1,old.deletionClock+1);
  if(!uint(generation)||!uint(at))throw invalid();
  prepared.book=state({...candidate,...old,lifecycle:{generation,operationId:util.hexEncode(crypto.randomBytes(16)),startedAt:at},deleted:false,deletedChapters:[],deletionClock:0,deletedAt:0,updatedAt:at,sourceDeviceId:require('./device').deviceId()});
  }
 }else if(choice==='reimport'){
  const instanceId=util.hexEncode(crypto.randomBytes(16)),bookId=id(candidate.fingerprint,instanceId),at=Math.max(Date.now(),candidate.updatedAt),sourceUrl='watchrss://import/instance-v1/'+instanceId;
  const next={...candidate};delete next.lifecycle;
  prepared.book=state({...next,bookId,instanceId,sourceUrl,deleted:false,deletedChapters:[],deletionClock:0,deletedAt:0,updatedAt:at});
 }else throw invalid();
 const target=prepared.book,sourceUrl=target.sourceUrl||prepared.source.url;
 prepared.source={...prepared.source,url:sourceUrl,title:target.title,deleted:false,deletedAt:0,updatedAt:target.updatedAt};
 prepared.entries=prepared.entries.map((entry,i)=>({...entry,article:{...entry.article,articleId:articleId(target.bookId,i+1),url:choice==='reimport'||target.bookId!==candidate.bookId?(prepared.multi?sourceUrl+'/chapter/'+String(i+1).padStart(4,'0'):sourceUrl):entry.article.url,rssSourceUrl:prepared.multi?sourceUrl:null,rssSourceTitle:prepared.multi?target.title:null,deleted:false,deletedAt:0,updatedAt:Math.max(entry.article.updatedAt||0,target.updatedAt),...(!prepared.multi?{independentSaved:true,independentChangedAt:Math.max(entry.article.independentChangedAt||0,target.updatedAt),independentSortOrder:entry.article.independentSortOrder||target.updatedAt}:{}),...(choice==='reimport'?{isRead:false,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:0,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0}:{})}}));
 return target;
}
Object.assign(module.exports,{lifecycleOrder,importCandidate});
