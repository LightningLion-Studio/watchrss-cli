// Authenticated R48 body membership. Records, not these clocks, own user state.
const util=require('./util'),crypto=require('./crypto'),raw=require('./json-raw'),format=require('./cloud-format'),cooperative=require('./cooperative');
const NAME='private/overlay-v1.json',FEATURE='r48.private-overlay.v1',MAX_BYTES=4194304,MAX_ENTRIES=8192;
const MAX_ARTICLE_ENTRY=12*1024*1024,MAX_ARTICLE_ARCHIVE=32*1024*1024;
const invalid=(code='cloud_overlay_invalid')=>Object.assign(Error('部分私有原文暂不可用，原件与本机修改已保留'),{code,editPending:true});
const compare=(a,b)=>a<b?-1:a>b?1:0;
const order=(a,b)=>compare(a.kind,b.kind)||compare(a.id,b.id);
const key=e=>e.kind+'\n'+e.id;
const articleName=id=>'private/articles/'+crypto.sha256Hex(util.utf8ToBytes(raw.unicode(id)))+'.wrss';
const exact=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===names.slice().sort().join(',');
function validate(value){
 if(!exact(value,['format','version','entries'])||value.format!=='watchrss-private-overlay'||value.version!==1||!Array.isArray(value.entries)||value.entries.length>MAX_ENTRIES)throw invalid();
 let prior=null;
 for(const e of value.entries){
  if(!exact(e,['kind','id','object','changedAt','sourceDeviceId'])||!['article','book'].includes(e.kind)||typeof e.id!=='string'||!e.id||e.id.length>1024||util.utf8ByteLength(raw.unicode(e.id))>1024||!Number.isSafeInteger(e.changedAt)||e.changedAt<0||typeof e.sourceDeviceId!=='string'||!e.sourceDeviceId||e.sourceDeviceId.length>128||util.utf8ByteLength(raw.unicode(e.sourceDeviceId))>128||/[\x00-\x1f\x7f]/.test(e.sourceDeviceId)||e.object!==null&&!format.safePath(e.object)||prior&&order(prior,e)>=0)throw invalid();
  if(e.kind==='book'&&!/^[a-f0-9]{64}$/.test(e.id)||e.object!==null&&e.object!==(e.kind==='article'?articleName(e.id):'books/'+e.id+'.jsonl'))throw invalid();
  prior=e;
 }
 return value;
}
async function decode(bytes,check=()=>{}){if(bytes.length>MAX_BYTES)throw invalid();const text=await require('./storage-async').utf8Strict(bytes,check);return validate(await raw.parseAsync(text,check));}
async function encode(entries,check=()=>{}){const value=validate({format:'watchrss-private-overlay',version:1,entries:entries.slice().sort(order)}),bytes=await require('./storage-async').utf8Encode(await cooperative.stringify(value,check),check);if(bytes.length>MAX_BYTES)throw invalid();return bytes;}
function marked(manifest){return(manifest.features?.incompat||[]).includes(FEATURE);}
function features(manifest){return raw.merge(manifest.features||{},{incompat:[...new Set([...(manifest.features?.incompat||[]),FEATURE])],roCompat:manifest.features?.roCompat||[]});}
async function readObject(options,descriptor,maxBytes=MAX_BYTES){
 if(!descriptor||descriptor.originalBytes>maxBytes)throw invalid('cloud_entry_missing');
 const source=await require('./snapshot-range').open({...options,descriptor});
 try{const bytes=await source.read(0,source.size);options.check?.();if(descriptor.contentSha256&&await crypto.sha256HexAsync(bytes,options.check)!==descriptor.contentSha256)throw invalid();return bytes;}finally{source.close();}
}
async function load(options){
 format.assertRead(options.manifest,'manifest');const d=options.manifest.objects.find(d=>d.name===NAME);
 if(!d){if(marked(options.manifest))throw invalid('cloud_entry_missing');return{format:'watchrss-private-overlay',version:1,entries:[]};}
 if(!marked(options.manifest)||d.entryRef)throw invalid();
 format.assertRead(d,'descriptor');return decode(await readObject(options,d),options.check);
}
// A stable object name is not a content identity: bind ties to authenticated raw
// descriptor tokens as well. Keep every conflicting input available to callers.
function merge(inputs){
 const grouped=new Map();for(const input of inputs)for(const entry of input.index.entries){const list=grouped.get(key(entry))||[];list.push({entry,context:input.context,descriptor:entry.object===null?null:input.manifest.objects.find(d=>d.name===entry.object)});grouped.set(key(entry),list);}
 const selected=new Map(),conflicts=[];
 for(const [id,rows]of grouped){rows.sort((a,b)=>a.entry.changedAt-b.entry.changedAt||compare(a.entry.sourceDeviceId,b.entry.sourceDeviceId));const last=rows[rows.length-1],ties=rows.filter(r=>r.entry.changedAt===last.entry.changedAt&&r.entry.sourceDeviceId===last.entry.sourceDeviceId),deleted=ties.find(r=>r.entry.object===null);if(deleted){selected.set(id,deleted);continue;}
  const digests=new Set(ties.map(r=>r.entry.object+'\n'+(r.descriptor?crypto.sha256Hex(raw.stringify(r.descriptor)):'missing')));
  if(digests.size>1){const conflict={id,inputs:ties};conflicts.push(conflict);selected.set(id,{...last,conflict});}else selected.set(id,last);
 }
 return{selected,conflicts};
}
// Store-only ZIP creation avoids a large synchronous DEFLATE. CC2 compression is
// cooperative later. No imported all-library ZIP is ever repacked here.
function originalUnicode(value){try{return raw.unicode(value);}catch(_){throw invalid('cloud_overlay_type_pending');}}
async function packArticle(article,text,check=()=>{}){
 if(!article||typeof article.articleId!=='string'||!article.articleId||typeof article.url!=='string'||!article.url||article.__bodyLocator||article.bookId||require('./books').isLegacy(article))throw invalid('cloud_overlay_type_pending');
 if(article.articleId.length>1024||util.utf8ByteLength(originalUnicode(article.articleId))>1024||text!==undefined&&typeof text!=='string'||article.contentText!=null&&typeof article.contentText!=='string'||article.contentHtml!=null&&typeof article.contentHtml!=='string')throw invalid('cloud_overlay_type_pending');
 const prefix='bodies/'+crypto.sha256Hex(article.articleId),files=Object.create(null),html=article.contentHtml||'',body=html&&article.contentText!==undefined?article.contentText:String(text===undefined?article.contentText||'':text);
 // External HTTP images remain external. Local/resource references require a
 // lossless extractor; never publish a TXT substitute for missing HTML assets.
 if(typeof html!=='string'||typeof body!=='string'||!html.trim()&&!body.trim()||/(?:src|href)\s*=\s*["'](?:file:|wxfile:|watchrss-resource:|resources\/|\.\.?\/)/i.test(html)||html.length>12*1024*1024||body.length>12*1024*1024)throw invalid('cloud_overlay_type_pending');
 const row={};for(const [field,value]of Object.entries(article))if(Object.prototype.hasOwnProperty.call(format.descriptorSchema.privateArticle,field)&&value!==undefined)row[field]=value;
 // Bound metadata before serializing it. Keep the same per-entry and total ZIP
 // limits as the consumer, including multibyte UTF-8 and JSON escape expansion.
 const strings=new Set(['articleId','url','title','siteName','excerpt','imageUrl','contentHash','rssSourceUrl','rssSourceTitle']);
 let metadataChars=0;
 for(const [field,value]of Object.entries(row)){
  if(strings.has(field)){if(value!==null&&typeof value!=='string')throw invalid('cloud_overlay_type_pending');metadataChars+=(value||'').length;}
  else if(field.endsWith('Saved')){if(typeof value!=='boolean')throw invalid('cloud_overlay_type_pending');}
  else if(typeof value!=='number'||!Number.isFinite(value))throw invalid('cloud_overlay_type_pending');
  if(metadataChars>MAX_ARTICLE_ENTRY)throw invalid('cloud_overlay_type_pending');
 }
 // TextEncoder replaces lone surrogates. Refuse them rather than publishing a
 // successful archive that silently changed the authenticated original bytes.
 for(const value of [...Object.values(row),body,html])if(typeof value==='string')await cooperative.run((function*(){for(let at=0;at<value.length;){let end=Math.min(at+8192,value.length);if(end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1]))end--;originalUnicode(value.slice(at,end));at=end;yield;}})(),'cpu.overlay.unicode',check);
 Object.assign(row,{importedAt:0,updatedAt:0,independentSaved:false,independentChangedAt:0,independentSortOrder:0,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,deleted:false,deletedAt:0,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:0,isRead:false,contentTextEntry:prefix+'.txt',contentHtmlEntry:html?prefix+'.html':null});
 files['manifest.json']=util.utf8ToBytes('{"format":"watchrss-library-backup","version":3,"cloudContentOnly":true}');files['articles.json']=await require('./storage-async').utf8Encode(await cooperative.stringify([row],check),check);if(files['articles.json'].length>MAX_ARTICLE_ENTRY)throw invalid('cloud_overlay_type_pending');files['sources.json']=util.utf8ToBytes('[]');files['saved_items.json']=util.utf8ToBytes('[]');files[row.contentTextEntry]=await require('./storage-async').utf8Encode(body,check);if(html)files[row.contentHtmlEntry]=await require('./storage-async').utf8Encode(html,check);
 if(Object.values(files).some(bytes=>bytes.length>MAX_ARTICLE_ENTRY)||Object.entries(files).reduce((n,[name,bytes])=>n+bytes.length+76+2*util.utf8ByteLength(name),22)>MAX_ARTICLE_ARCHIVE)throw invalid('cloud_overlay_type_pending');
 return storedZip(files,check);
}
async function storedZip(files,check){
 const locals=[],central=[];let offset=0;
 for(const name of Object.keys(files).sort()){
  check();const bytes=files[name],encoded=util.utf8ToBytes(name);let crc=-1;
  for(let a=0;a<bytes.length;a+=8192){for(let i=a;i<Math.min(a+8192,bytes.length);i++){crc^=bytes[i];for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}await cooperative.turn();check();}crc=(crc^-1)>>>0;
  const local=new Uint8Array(30+encoded.length),l=new DataView(local.buffer);l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);l.setUint16(12,33,true);l.setUint32(14,crc,true);l.setUint32(18,bytes.length,true);l.setUint32(22,bytes.length,true);l.setUint16(26,encoded.length,true);local.set(encoded,30);
  const c=new Uint8Array(46+encoded.length),v=new DataView(c.buffer);v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint16(8,0x800,true);v.setUint16(14,33,true);v.setUint32(16,crc,true);v.setUint32(20,bytes.length,true);v.setUint32(24,bytes.length,true);v.setUint16(28,encoded.length,true);v.setUint32(42,offset,true);c.set(encoded,46);locals.push(local,bytes);central.push(c);offset+=local.length+bytes.length;
 }
 const directory=util.bytesConcat(central),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,central.length,true);v.setUint16(10,central.length,true);v.setUint32(12,directory.length,true);v.setUint32(16,offset,true);return util.bytesConcat([...locals,directory,end]);
}
async function readArticle(options,entry){
 const descriptor=options.manifest.objects.find(d=>d.name===entry.object);if(entry.kind!=='article'||entry.object!==articleName(entry.id)||!descriptor)throw invalid('cloud_entry_missing');
 format.assertRead(descriptor,'descriptor');if(descriptor.originalBytes>32*1024*1024)throw invalid();const source=await require('./snapshot-range').open({...options,descriptor});
 try{
  const zip=await require('./private-archive').zipDirectory(source.read.bind(source),source.size),parse=async name=>{const b=await zip.entry(name);if(!b)throw invalid();return raw.parseAsync(await require('./storage-async').utf8Strict(b,options.check),options.check);};
  const m=await parse('manifest.json'),rows=await parse('articles.json');if(m.format!=='watchrss-library-backup'||m.version!==3||m.cloudContentOnly!==true||!Array.isArray(rows)||rows.length!==1||rows[0].articleId!==entry.id||rows[0].deleted)throw invalid();
  for(const name of ['sources.json','saved_items.json']){const values=await parse(name);if(!Array.isArray(values)||values.length)throw invalid();}
  const row=rows[0],prefix='bodies/'+crypto.sha256Hex(entry.id),allowed=new Set(['manifest.json','articles.json','sources.json','saved_items.json',prefix+'.txt',prefix+'.html']);
  if(row.contentTextEntry!==prefix+'.txt'||row.contentHtmlEntry!=null&&row.contentHtmlEntry!==prefix+'.html')throw invalid();
  let resourceBytes=0;for(const [name,item]of zip.entries){if(!format.safePath(name))throw invalid();if(name.startsWith('resources/')){resourceBytes+=item.size;if(resourceBytes>16*1024*1024)throw invalid();}else if(!allowed.has(name)){if(name!=='app_meta.json')throw invalid();const values=await parse(name);if(!Array.isArray(values)||values.length)throw invalid();}}
  const body=await zip.entry(row.contentTextEntry);if(!body)throw invalid('cloud_entry_missing');const contentText=await require('./storage-async').utf8Strict(body,options.check);let contentHtml='';if(row.contentHtmlEntry){const b=await zip.entry(row.contentHtmlEntry);if(!b)throw invalid('cloud_entry_missing');contentHtml=await require('./storage-async').utf8Strict(b,options.check);}
  // CRC-check all resources even when this reader renders text only.
  for(const name of zip.entries.keys())if(name.startsWith('resources/'))await zip.entry(name);
  options.check?.();return{...row,contentText,contentHtml};
 }finally{source.close();}
}
function localEnabled(){try{const scope=require('./cloud-scope');return require('./storage').readJSON(scope.path('r48-write-opt-in',scope.current().userId),null)?.enabled===true;}catch(_){return false;}}
function setEnabled(enabled){const scope=require('./cloud-scope');require('./storage').writeJSON(scope.path('r48-write-opt-in',scope.current().userId),{enabled:enabled===true});}
async function assertEnabled(){if(!localEnabled())throw invalid('cloud_format_write_disabled');const caps=await require('./sync').formatCapabilities();if(caps.phaseA?.cloudFormatR48ReadV1!==true||caps.phaseA?.cloudFormatR48WriteV1!==true)throw invalid('cloud_format_write_disabled');}
async function admissionHeaders(){if(!localEnabled())return{};await assertEnabled();return{'x-watchrss-r48-write-v1':'1'};}
// Local observer/UI bridge only: no upload, persistence, identifiers, URLs,
// exception messages or content. Subscriber failures never affect publication.
const recentPublications=[],publicationObservers=new Set(),activePublications=new Set();
const diagnosticNumber=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const diagnosticCodes=new Set(['cloud_format_write_disabled','r48_write_feature_disabled','r48_write_header_invalid','cloud_format_upgrade_required','cloud_format_invalid','cloud_private_archive_invalid','cloud_overlay_invalid','cloud_overlay_conflict','cloud_overlay_capacity_pending','cloud_overlay_type_pending','cloud_overlay_clock_pending','cloud_overlay_rebase_required','cloud_entry_missing','cloud_session_changed','cloud_operation_cancelled','cloud_content_rebuild_required','snapshot_not_found','upload_reservation_not_found','reservation_expired']);
function diagnosticCode(error){const code=error&&error.code;if(diagnosticCodes.has(code))return code;if(['ENOSPC','local_storage_full'].includes(code))return 'storage_full';if(['ECONNRESET','ETIMEDOUT','network_error'].includes(code))return 'network_error';if(error?.status===401||error?.status===403)return 'unauthorized';if(error?.status===426)return 'upgrade_required';if(error?.status===409)return 'conflict';if(error?.status>=500)return 'server_error';return 'unclassified';}
function diagnostics(){return{recent:recentPublications.map(v=>({...v})),active:[...activePublications].map(v=>({...v}))};}
function subscribeDiagnostics(listener){if(typeof listener!=='function'||publicationObservers.size>=8)throw TypeError('R48 observer limit');publicationObservers.add(listener);return()=>publicationObservers.delete(listener);}
function beginPublication(){
 const started=Date.now(),row={operation:'r48_write_v1',phase:'prepare',outcome:'running',code:'none',durationMs:0,reserveAttempts:0,plannedCiphertextBytes:0,successfulPutBytes:0,successfulPuts:0,logicalObjects:0};let done=false;
 // Normal callers are serialized by cloudExclusive; bound even misuse.
 if(activePublications.size<8)activePublications.add(row);
 return{
  phase(value){if(!done&&['prepare','reserve','upload','complete','unchanged'].includes(value))row.phase=value;},
  reserve(){if(!done)row.reserveAttempts++;},
  plan(objects,targets){if(!done){row.logicalObjects=diagnosticNumber(objects);row.plannedCiphertextBytes=(Array.isArray(targets)?targets:[]).reduce((n,t)=>Math.min(Number.MAX_SAFE_INTEGER,n+diagnosticNumber(t?.sizeBytes)),0);}},
  progress(p){if(!done){row.successfulPutBytes=diagnosticNumber(p?.uploaded);row.successfulPuts=diagnosticNumber(p?.done);}},
  finish(error){if(done)return;done=true;activePublications.delete(row);row.durationMs=Math.max(0,Date.now()-started);row.outcome=error?'failed':row.phase==='unchanged'?'unchanged':'succeeded';row.code=error?diagnosticCode(error):'none';recentPublications.push({...row});if(recentPublications.length>50)recentPublications.shift();for(const listener of publicationObservers)try{Promise.resolve(listener({...row})).catch(()=>{});}catch(_){}},
 };
}
async function prepare({manifest,inputs,articles=[],objects=[],deletions=[],sourceDeviceId,check=()=>{}}){
 const merged=merge(inputs);if(merged.conflicts.length)throw invalid('cloud_overlay_conflict');
 const rows=new Map([...merged.selected].map(([k,v])=>[k,v.entry])),carry=new Map(manifest.objects.filter(d=>d.name!==NAME).map(d=>[d.name,d])),logical=[];
 for(const selected of merged.selected.values())if(selected.entry.object!==null){if(!selected.descriptor)throw invalid('cloud_entry_missing');carry.set(selected.descriptor.name,selected.descriptor);if(selected.descriptor.entryRef){const dependency=(selected.context.value||selected.context.manifest).objects.find(d=>d.name===selected.descriptor.entryRef.object);if(!dependency)throw invalid('cloud_entry_missing');const existing=carry.get(dependency.name);if(existing&&raw.stringify(existing)!==raw.stringify(dependency))throw invalid('cloud_overlay_conflict');carry.set(dependency.name,dependency);}}
 function update(kind,id,object,changedAt){if(!Number.isSafeInteger(changedAt)||changedAt<=0)throw invalid('cloud_overlay_clock_pending');const entry={kind,id,object,changedAt,sourceDeviceId},prior=rows.get(key(entry));if(prior&&(prior.changedAt>changedAt||prior.changedAt===changedAt&&compare(prior.sourceDeviceId,sourceDeviceId)>0))throw invalid('cloud_overlay_rebase_required');rows.set(key(entry),entry);}
 for(const entry of articles){check();const article=entry.article,bytes=await packArticle(article,entry.text,check),name=articleName(article.articleId),hash=await crypto.sha256HexAsync(bytes,check),old=carry.get(name);
  if(old?.contentSha256===hash&&rows.get('article\n'+article.articleId)?.object===name)continue;
  const contentClock=article.__privateBodyClock||article.contentChangedAt||(Number(article.updatedAt)>Number(article.readingPositionChangedAt||0)?article.updatedAt:article.importedAt);
  update('article',article.articleId,name,Math.max(Number(contentClock)||0,Number(article.importedAt)||0,Number(article.independentChangedAt)||0,Number(article.favoriteChangedAt)||0,Number(article.watchLaterChangedAt)||0));
  logical.push({name,bytes,compress:true,contentSha256:hash});carry.delete(name);
 }
 for(const object of objects){check();if(!object.privateBook)throw invalid('cloud_overlay_type_pending');const value=object.privateBook;update('book',value.bookId,object.name,object.changedAt);logical.push(object);carry.delete(object.name);}
 for(const entry of deletions){check();update(entry.kind,entry.id,null,entry.changedAt);}
 const bytes=await encode([...rows.values()],check),hash=await crypto.sha256HexAsync(bytes,check),oldIndex=manifest.objects.find(d=>d.name===NAME);
 if(!logical.length&&oldIndex?.contentSha256===hash)return{unchanged:true};
 logical.push({name:NAME,bytes,compress:true,contentSha256:hash});if(carry.size+logical.length>1024)throw invalid('cloud_overlay_capacity_pending');
 return{logicalObjects:logical,carryForwardObjects:[...carry.values()],features:features(manifest),index:validate({format:'watchrss-private-overlay',version:1,entries:[...rows.values()].sort(order)})};
}
async function bookReference(options,archive,book){
 const name='books/'+book.bookId+'.jsonl';if(!/^[a-f0-9]{64}$/.test(book.bookId)||book.packagePath!==name||archive.entryRef||!archive.chunks?.length)throw invalid();
 const source=await require('./snapshot-range').open({...options,descriptor:archive});try{const zip=await require('./private-archive').zipDirectory(source.read.bind(source),source.size),bytes=await zip.entry(name,32*1024*1024);if(!bytes)throw invalid('cloud_entry_missing');const text=await require('./storage-async').utf8Strict(bytes,options.check);await require('./books').unpackAsync(text,book);options.check?.();return{name,encoding:'identity',originalBytes:bytes.length,encodedBytes:bytes.length,contentSha256:await crypto.sha256HexAsync(bytes,options.check),privateBook:book,entryRef:{object:archive.name,entryPath:name,encoding:'identity'},features:{incompat:['r48.entry-ref.v1'],roCompat:[]}};}finally{source.close();}
}
module.exports={NAME,FEATURE,MAX_BYTES,MAX_ENTRIES,invalid,key,order,articleName,validate,encode,decode,marked,features,load,merge,readObject,packArticle,readArticle,prepare,bookReference,localEnabled,setEnabled,assertEnabled,admissionHeaders,diagnostics,subscribeDiagnostics,beginPublication};
