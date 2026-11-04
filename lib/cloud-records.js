// Versioned, independently encrypted RSS metadata. No article bodies or cloud keys
// are cached here. The caller owns merge policy and retries CAS after a fresh pull.
const crypto=require('./crypto'),util=require('./util'),payload=require('./payload'),rssPolicy=require('./rss-cloud'),bookPolicy=require('./books');
const provenance=require('./article-provenance');
const evolution=require('./cloud-format'),rawJson=evolution.raw;
const PATH='/functions/v1/cloud/records',LIMIT=50,MAX_BYTES=65536,MAX_BATCH=1048576;
const HOT_ACK_ROWS=2048,HOT_ACK_BYTES=512*1024;
const MAX_REV='9223372036854775807',ID=/^[a-f0-9]{64}$/;
function failure(code){return Object.assign(new Error(code),{code});}
function compare(a,b){return a.length-b.length || (a===b?0:a<b?-1:1);}
function revision(value){if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(value)||compare(value,MAX_REV)>0)throw failure('cloud_record_response_invalid');return value;}
function stable(value){if(Array.isArray(value))return value.map(stable);if(value && typeof value==='object'){const out={};for(const key of Object.keys(value).sort())if(value[key]!==undefined)out[key]=stable(value[key]);return out;}return value;}
function canonical(kind,value){
 if(kind==='article'&&provenance.protectedValue(value))return provenance.asRecord(value);
 if(typeof kind!=='string'||!kind||value===undefined)throw failure('cloud_record_invalid');
 if(['book','book-reading'].includes(kind)&&['contentText','contentHtml','contentTextGzip','contentHtmlGzip','body','chapters','contentAvailable'].some(k=>Object.prototype.hasOwnProperty.call(value||{},k)))throw failure('cloud_record_invalid');
 if(['book','book-reading'].includes(kind))return stable({format:'watchrss-rss-record',version:1,kind,...(kind==='book'&&(value.lifecycle||value.instanceId)?{features:{incompat:['book-lifecycle.v1'],roCompat:[]}}:{}),value:kind==='book'?bookPolicy.state(value):bookPolicy.reading(value)});
 if(kind==='rss-state'){
  if(!value||typeof value.sourceId!=='string'||!value.sourceId||value.sourceId.length>128||!ID.test(value.articleIdHash))throw failure('cloud_record_invalid');
  if(Object.keys(value).some(field=>!rssPolicy.READ_FIELDS.concat(['sourceId','articleIdHash','sourceDeviceId']).includes(field)))throw failure('cloud_record_invalid');
  const fields={sourceId:value.sourceId,sourceDeviceId:String(value.sourceDeviceId||''),articleIdHash:value.articleIdHash};
  for(const field of rssPolicy.READ_FIELDS){const raw=value[field],boolean=['isRead','favoriteSaved','watchLaterSaved','deleted'].includes(field),text=field==='readingPositionContentHash';if(raw!==undefined&&(boolean?typeof raw!=='boolean':text?typeof raw!=='string':typeof raw!=='number'||!Number.isFinite(raw)||raw<0||(field==='readingProgress'&&raw>1)))throw failure('cloud_record_invalid');fields[field]=boolean?!!raw:text?String(raw||''):Math.max(0,Number(raw)||0);}
  fields.readingProgress=Math.floor(Math.min(1,fields.readingProgress)*1e6+0.5)/1e6;
  return stable({format:'watchrss-rss-record',version:1,kind,value:fields});
 }
 if(!['article','source'].includes(kind))return stable({format:'watchrss-rss-record',version:1,kind,value});
 if(!value||typeof value!=='object'||Array.isArray(value))throw failure('cloud_record_invalid');
 const field=kind==='article'?'articles':'sources';
 const input={articles:[],sources:[],exportedAt:0};input[field]=[value];
 const normalized=payload.parseRssState(payload.buildRssState(input));
 const built=JSON.parse(util.bytesToUtf8(payload.buildRssState(normalized)))[field];
 if(built.length!==1 || typeof (kind==='article'?built[0].articleId:built[0].url)!=='string' || !(kind==='article'?built[0].articleId:built[0].url))throw failure('cloud_record_invalid');
 if(kind==='article'&&value.bookIndexRetired===true)built[0].bookIndexRetired=true;
 if(kind==='source'&&typeof value.sourceId==='string')built[0].sourceId=value.sourceId;
 return stable({format:'watchrss-rss-record',version:1,kind,value:built[0]});
}
function restoresDeletion(remote,local){if(!local.lifecycle)return false;const next=bookPolicy.merge(remote,local);return JSON.stringify(next.lifecycle)===JSON.stringify(local.lifecycle)&&JSON.stringify(remote.lifecycle)!==JSON.stringify(local.lifecycle)&&!next.deleted&&!next.deletedChapters.length;}
function fingerprint(doc){if(doc.kind==='article'&&provenance.marked(doc))return crypto.sha256Hex(provenance.canonical(doc));if(!['article','source','rss-state'].includes(doc.kind))return crypto.sha256Hex(JSON.stringify(stable(doc)));const value=Object.assign({},doc.value);delete value.sourceDeviceId;if(['article','rss-state'].includes(doc.kind))value.readingProgress=Math.floor(Math.max(0,Math.min(1,Number(value.readingProgress)||0))*1e6+0.5)/1e6;if(doc.kind==='source')delete value.createdAt;return crypto.sha256Hex(JSON.stringify(stable(Object.assign({},doc,{value}))));}
function derived(key,userId,anchorKey=key){if(!key || key.length!==32)throw failure('NEEDS_RECOVERY');return {cipher:crypto.hkdfSha256(key,util.utf8ToBytes(userId),'watchrss/cloud/record/v1',32),id:crypto.hkdfSha256(anchorKey,util.utf8ToBytes(userId),'watchrss/cloud/record-id/v1',32)};}
function opaque(keys,kind,value){return util.hexEncode(crypto.hmacSha256(keys.id,util.utf8ToBytes(kind+':'+(kind==='book'?value.bookId:kind==='book-reading'?value.bookId+':'+value.chapterIndex:kind==='article'?value.articleId:kind==='rss-state'?value.sourceId+':'+value.articleIdHash:value.url))));}
function aad(userId,id,version){return util.utf8ToBytes(`watchrss-cloud-record-v1:${userId}:${id}:${version}`);}
function keyVersion(v){if(!Number.isInteger(v)||v<=0||v>2147483647)throw failure('cloud_record_invalid');return v;}
function dispose(keys){keys.cipher.fill(0);keys.id.fill(0);}
function encode({userId,key,keyVersion:version,kind,value,nonce,anchorKey=key,retained}){
 evolution.assertAccountWriteRoot(key);
 if(retained&&!retained.policy.write)throw evolution.error();
 if(kind==='article'&&provenance.protectedValue(value))throw evolution.error();
 const doc=canonical(kind,value),keys=derived(key,userId,anchorKey);
 try{
  const recordId=opaque(keys,kind,doc.value),bytes=util.utf8ToBytes(retained?rawJson.stringify(rawJson.merge(rawJson.parse(retained.raw),doc)):JSON.stringify(doc));
  if(bytes.length+16>MAX_BYTES)throw failure('cloud_record_too_large');
  version=keyVersion(version);nonce=nonce || crypto.randomBytes(12);if(nonce.length!==12)throw failure('cloud_record_invalid');
  const result={recordId,hash:fingerprint(doc),envelope:{algorithm:'A256GCM',keyVersion:version,nonceBase64:util.base64PaddedEncode(nonce),ciphertextBase64:util.base64PaddedEncode(crypto.aesGcmEncrypt(keys.cipher,nonce,bytes,aad(userId,recordId,version)))}};if(retained)Object.defineProperty(result,'retained',{value:{policy:retained.policy}});return result;
 }finally{dispose(keys);}
}
function base64(value,max){if(typeof value!=='string'||value.length>4*Math.ceil(max/3)||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw failure('cloud_record_invalid');const bytes=util.base64PaddedDecode(value);if(bytes.length>max||util.base64PaddedEncode(bytes)!==value)throw failure('cloud_record_invalid');return bytes;}
function decode({userId,key,recordId,envelope,anchorKey=key}){
 if(!ID.test(recordId)||!envelope||envelope.algorithm!=='A256GCM')throw failure('cloud_record_invalid');
 const version=keyVersion(envelope.keyVersion),nonce=base64(envelope.nonceBase64,12),encrypted=base64(envelope.ciphertextBase64,MAX_BYTES);
 if(nonce.length!==12||encrypted.length<16)throw failure('cloud_record_invalid');
 const keys=derived(key,userId,anchorKey);let plain;
 try{
  plain=crypto.aesGcmDecrypt(keys.cipher,nonce,encrypted,aad(userId,recordId,version));
  const text=util.bytesToUtf8(plain);if(!util.bytesEqual(plain,util.utf8ToBytes(text)))throw failure('cloud_record_invalid');
  const raw=rawJson.parse(text),known=['article','source','rss-state','book','book-reading'].includes(raw.kind);
  if(raw.kind==='book'&&(raw.value?.lifecycle!==undefined||raw.value?.instanceId!==undefined)&&!(raw.features?.incompat||[]).includes('book-lifecycle.v1'))throw failure('cloud_record_invalid');
  let doc,policy;if(raw.format!=='watchrss-rss-record'||raw.version!==1||!known){doc={kind:raw.kind,value:{}};policy={read:'opaque',write:false,reason:'format'};}
  else{const preliminary=evolution.features(raw,'record',rawJson.meta(raw).maxDepth<=32);if(preliminary.read!=='known-fields'){doc={kind:raw.kind,value:{}};policy=preliminary;}else if(raw.kind==='article'&&provenance.marked(raw)){doc=provenance.normalize(raw,{allowReadOnly:true});policy={...evolution.assess(raw,'record',Object.keys(doc.value)),write:false,reason:'article-provenance-read-only'};}else{if(raw.kind==='article'&&Object.prototype.hasOwnProperty.call(raw.value||{},'registerSources'))throw failure('cloud_record_invalid');const value=raw.kind==='rss-state'?Object.fromEntries(Object.entries(raw.value||{}).filter(([k])=>rssPolicy.READ_FIELDS.concat(['sourceId','articleIdHash','sourceDeviceId']).includes(k))):raw.value;doc=canonical(raw.kind,value);policy=evolution.assess(raw,'record',Object.keys(doc.value));}}
  let legacy=false;if(known&&policy.read==='known-fields'&&opaque(keys,doc.kind,doc.value)!==recordId){const old=derived(key,userId);try{if(opaque(old,doc.kind,doc.value)!==recordId)throw failure('cloud_record_invalid');legacy=true;}finally{dispose(old);}}
  const result={kind:doc.kind,value:doc.value,hash:policy.read==='known-fields'?fingerprint(doc):crypto.sha256Hex(text),legacy};
  const preserve=raw.features!==undefined||policy.read!=='known-fields'||rawJson.unknownBytes(raw,{format:true,version:true,kind:true,features:true,value:Object.fromEntries(Object.keys(doc.value).map(k=>[k,true]))})>0;
  Object.defineProperty(result,'retained',{value:{raw:text,policy,preserve,...(provenance.protectedValue(doc.value)?{provenance:provenance.retentionProof(raw)}:{})},enumerable:false});return result;

 }catch(_){throw failure('cloud_record_invalid');}finally{if(plain)plain.fill(0);dispose(keys);}
}
// Keep only identity, interaction state and clocks needed for retirement. The old
// ciphertext is necessary only for a pre-anchor alias (storage-ID retirement).
function retirement(value,revision,envelope,legacy=false){
 const minimal={};for(const field of ['articleId','url','rssSourceUrl','sourceDeviceId','updatedAt','importedAt','independentChangedAt'].concat(rssPolicy.READ_FIELDS))if(value[field]!==undefined)minimal[field]=value[field];
 return{value:minimal,revision,...(legacy&&envelope?{envelope}:{})};
}
function deletionClock(value){return Math.max(0,...['updatedAt','importedAt','independentChangedAt','favoriteChangedAt','watchLaterChangedAt','readingPositionChangedAt','deletedAt'].map(field=>Number(value[field])||0))+1;}
function createClient(ports={}){
 const account=ports.account||require('./account'),storage=ports.storage||require('./storage'),request=ports.request||(options=>require('./appaccess').request(options));
 let generation=0;const unsupported=new Map();
 const sparseEnabled=!ports.request||ports.sparseAcks===true;
 function owner(scope){const now=account.getUsableSession();return scope && now && scope.userId===now.userId && (scope.lifecycle===undefined||scope.lifecycle===require('./cloud-scope').scope(scope.userId).lifecycle) && (!scope.backendBaseUrl||scope.backendBaseUrl===(ports.backendBaseUrl||require('./cloud-scope').backend()));}
 function context(scope){if(!owner(scope)||!/^[a-zA-Z0-9_-]{1,128}$/.test(scope.userId))throw failure('cloud_record_session_changed');return{...scope,backendBaseUrl:!ports.request?require('./cloud-scope').backend():scope.backendBaseUrl,lifecycle:!ports.request?require('./cloud-scope').scope(scope.userId).lifecycle:scope.lifecycle,generation,...(!ports.request?{contentGeneration:require('./cloud-scope').content(scope.userId)?.contentGeneration,cacheRevision:require('./cloud-scope').content(scope.userId)?.cacheRevision}:{})};}
 function check(ctx){if(!ports.request&&ctx.cacheRevision!==require('./cloud-scope').content(ctx.userId)?.cacheRevision)throw require('./cloud-scope').rebuildError();if(!ports.request&&ctx.contentGeneration!==require('./cloud-scope').content(ctx.userId)?.contentGeneration)throw require('./cloud-scope').rebuildError();if(!owner(ctx)||ctx.generation!==generation)throw failure('cloud_record_session_changed');}
 function path(scope){return ports.statePath?ports.statePath(scope):require('./cloud-scope').path('records',scope.userId);}
 function empty(){return{articleProvenanceReadVersion:1,cursor:'0',records:{},quarantine:{},unknown:{},migrations:{},rssRetirements:{},bookRetirements:{},rssLayout:3,bookLayout:1};}
 // Import ACKs are a small durable overlay. The large base is only read on
 // conflicts or normal background synchronization, never for a new book.
 function ackPath(ctx){return path(ctx).replace(/\.json$/,'-acks.json');}
 function ackIdentity(ctx){return{userId:ctx.userId,backend:ctx.backendBaseUrl||'',contentGeneration:ctx.contentGeneration||'',cacheRevision:ctx.cacheRevision||0,libraryEpoch:!ports.request?require('./cloud-scope').load(ctx.userId)?.libraryEpoch||'':ctx.libraryEpoch||''};}
 function sameAckIdentity(ctx,value){return value&&value.version===1&&JSON.stringify(value.identity)===JSON.stringify(ackIdentity(ctx));}
 async function readAcks(ctx){const value=storage.readJSONAsync?await storage.readJSONAsync(ackPath(ctx),null):storage.readJSON(ackPath(ctx),null);check(ctx);if(value?.identity&&JSON.stringify(value.identity)===JSON.stringify(ackIdentity(ctx))&&value.version!==1)throw failure('cloud_record_ack_invalid');if(!sameAckIdentity(ctx,value))return{version:1,identity:ackIdentity(ctx),epoch:'legacy',records:{}};
  if(typeof value.epoch!=='string'||value.compacting!==undefined&&typeof value.compacting!=='string'||!value.records||typeof value.records!=='object'||Array.isArray(value.records))throw failure('cloud_record_ack_invalid');
  for(const [id,row]of Object.entries(value.records)){if(!ID.test(id)||!ID.test(row?.hash))throw failure('cloud_record_ack_invalid');revision(row.revision);}return value;
 }
 async function writeAcks(ctx,value){check(ctx);if(storage.writeJSONAsync)await storage.writeJSONAsync(ackPath(ctx),value,{check:()=>check(ctx)});else storage.writeJSON(ackPath(ctx),value);check(ctx);}
 function mergeAcks(state,journal){if(journal.compacting&&journal.epoch!==(state.ackEpoch||'legacy'))return state;for(const [id,row]of Object.entries(journal.records)){const old=state.records[id];if(!old||compare(row.revision,old.revision)>0)state.records[id]=row;}return state;}
 async function sparseState(ctx){const journal=await readAcks(ctx);if(journal.compacting)return null;return{state:{...empty(),ackEpoch:journal.epoch,records:{...journal.records}},journal};}
 async function persistAcks(ctx,state,ids,baseLoaded=false){const journal=await readAcks(ctx),epoch=state.ackEpoch||'legacy',matching=journal.epoch===epoch;if((journal.compacting||!matching)&&!baseLoaded||!matching&&baseLoaded&&!state.ackEpoch&&journal.compacting)throw failure('cloud_record_ack_changed');const next={version:1,identity:ackIdentity(ctx),epoch,records:matching||!journal.compacting?{...journal.records}:{}};for(const id of ids){const row=state.records[id],old=next.records[id];if(row&&(!old||compare(row.revision,old.revision)>=0))next.records[id]=row;}await writeAcks(ctx,next);}

 // Keep a bounded book/reading revision index across background compaction.
 // These rows are already acknowledged, never new user operations. A cache
 // miss authenticates a conflict row, or takes the full-state/CAS fallback.
 async function hotAcks(ctx,state,journal){
  const selected={},seen=new Set(),recent=Object.keys(journal.records).reverse(),all=Object.keys(state.records),isBook=id=>state.records[id]?.kind==='book'||journal.records[id]?.kind==='book';
  const candidates=[...recent.filter(isBook),...all.filter(isBook),...recent,...all.slice().reverse().filter(id=>state.records[id]?.kind==='book-reading')];
  let bytes=2,count=0,deadline=Date.now()+4;
  for(const id of candidates){if(seen.has(id))continue;seen.add(id);const row=state.records[id];if(!row)continue;
   const size=JSON.stringify(id).length+util.utf8ByteLength(JSON.stringify(row))+2;if(count<HOT_ACK_ROWS&&bytes+size<=HOT_ACK_BYTES){selected[id]=row;bytes+=size;count++;}
   if(Date.now()>=deadline){await (ports.yield||util.tick)();check(ctx);deadline=Date.now()+4;}
  }
  return selected;
 }
 async function ackOnlyState(scope){const journal=await readAcks(scope);return mergeAcks({...empty(),ackEpoch:journal.epoch},journal);}
 async function load(scope){
  const raw=storage.readJSONAsync?await storage.readJSONAsync(path(scope),null):storage.readJSON(path(scope),null);check(scope);if(!raw)return sparseEnabled?await ackOnlyState(scope):empty();
  if(!ports.request){const current=require('./cloud-scope').content(scope.userId);if(current&&((raw.contentGeneration&&raw.contentGeneration!==current.contentGeneration)||(raw.cacheRevision||0)!==(current.cacheRevision||0)))return sparseEnabled?await ackOnlyState(scope):empty();}
  try{if(raw.ackEpoch!==undefined&&typeof raw.ackEpoch!=='string')throw failure('cloud_record_ack_invalid');revision(raw.cursor);if(!raw.records||typeof raw.records!=='object'||Array.isArray(raw.records))return sparseEnabled?await ackOnlyState(scope):empty();const records={};for(const [id,value]of Object.entries(raw.records)){if(!ID.test(id)||!value||!ID.test(value.hash))return sparseEnabled?await ackOnlyState(scope):empty();revision(value.revision);records[id]={revision:value.revision,hash:value.hash,...(['book','book-reading'].includes(value.kind)?{kind:value.kind}:{}),...(value.retained?{retained:value.retained}:{})};}const state={...(raw.ackEpoch?{ackEpoch:raw.ackEpoch}:{}),articleProvenanceReadVersion:raw.articleProvenanceReadVersion||0,cursor:raw.rssLayout===3&&raw.bookLayout===1?raw.cursor:'0',rssLayout:3,bookLayout:1,records,quarantine:raw.quarantine||{},unknown:raw.unknown||{},migrations:raw.migrations||{},rssRetirements:raw.rssRetirements||{},bookRetirements:raw.bookRetirements||{},editPending:raw.editPending||[],recordsGeneration:raw.recordsGeneration||null,exchangeVersion:raw.exchangeVersion||0};return sparseEnabled?mergeAcks(state,await readAcks(scope)):state;}catch(error){if(error.code&&error.code!=='cloud_record_response_invalid')throw error;return sparseEnabled?await ackOnlyState(scope):empty();}
 }
 async function persist(ctx,state){check(ctx);let compactEpoch,hot;if(sparseEnabled){const journal=await readAcks(ctx);hot=await hotAcks(ctx,state,journal);const versions=[state.ackEpoch,journal.epoch,journal.compacting].map(value=>BigInt(/^a1:([0-9]+)$/.exec(value||'')?.[1]||'0'));compactEpoch='a1:'+String(versions.reduce((a,b)=>a>b?a:b,0n)+1n);await writeAcks(ctx,{...journal,compacting:compactEpoch});state.ackEpoch=compactEpoch;}if(!ports.request)storage.deleteFile(require('./cloud-scope').path('records-checkpoint',ctx.userId));if(!ports.request){state.contentGeneration=ctx.contentGeneration;state.cacheRevision=ctx.cacheRevision;}if(storage.writeJSONAsync)await storage.writeJSONAsync(path(ctx),state,{check:()=>check(ctx)});else storage.writeJSON(path(ctx),state);check(ctx);if(sparseEnabled)await writeAcks(ctx,{version:1,identity:ackIdentity(ctx),epoch:compactEpoch,records:hot});
  if(!ports.request){const meta={version:1,contentGeneration:ctx.contentGeneration,cacheRevision:ctx.cacheRevision,cursor:state.cursor,recordsGeneration:state.recordsGeneration||null,quarantined:Object.keys(state.quarantine).length,needsPush:!!(Object.keys(state.migrations).length||Object.keys(state.rssRetirements).length||Object.keys(state.bookRetirements).length||(state.editPending||[]).length)};const file=require('./cloud-scope').path('records-checkpoint',ctx.userId);if(storage.writeJSONAsync)await storage.writeJSONAsync(file,meta,{check:()=>check(ctx)});else storage.writeJSON(file,meta);check(ctx);}
 }
 function canonicalArticle(value){return !ports.request?require('./library').canonicalRssArticle(value):value;}
 function cacheKey(ctx){return (ctx.backendBaseUrl||ports.backendBaseUrl||require('./cloud-scope').backend())+':'+ctx.userId+':'+ctx.accessToken;}
 async function send(ctx,options){check(ctx);try{
   if(!ports.request&&options.method==='POST'){const admission=options.path===PATH?await require('./cloud-overlay').admissionHeaders():{};check(ctx);options={...options,extraHeaders:{...options.extraHeaders,...require('./cloud-scope').headers(ctx.userId),...admission,'x-watchrss-cloud-device-id':require('./device').deviceId()}};}
   const response=await request(options);check(ctx);
   if(!ports.request&&options.method==='GET'){const observed=require('./cloud-scope').observe(ctx.userId,response.data);if(observed.changed)throw failure('NEEDS_RECOVERY');require('./cloud-scope').observeContent(ctx.userId,response.data);check(ctx);}
   return response.data;}catch(error){check(ctx);if(error.status===404&&!['snapshot_not_found','upload_reservation_not_found'].includes(error.code)){unsupported.set(cacheKey(ctx),Date.now()+300000);return null;}if(error.status===413||['cloud_record_count_limit','cloud_quota_exceeded'].includes(error.code))error.recordFailure=error.code==='cloud_record_count_limit'?'count_limit':error.code==='cloud_quota_exceeded'?'quota':'payload_limit';throw error;}}
 function format(data){if(!data||![0,1].includes(data.formatVersion))throw failure('cloud_record_response_invalid');return data.formatVersion;}
 async function statusRequest(scope){const ctx=context(scope);const data=await send(ctx,{method:'GET',path:PATH+'?after=0&limit=1'});if(!data)return{unsupported:true,enabled:false};unsupported.delete(cacheKey(ctx));return{...data,enabled:format(data)===1,unsupported:false};}
 async function consentRequest(scope){const ctx=context(scope),data=await send(ctx,{method:'POST',path:PATH+'/consent',body:{formatVersion:1}});if(!data)return{unsupported:true,enabled:false};if(format(data)!==1)throw failure('cloud_record_response_invalid');unsupported.delete(cacheKey(ctx));return{...data,enabled:true,unsupported:false};}
 async function pull({scope,keyForVersion,refreshKeys,anchorKey,apply,commit,exchange=scope&&scope.exchange,reset=false,supplements=[],shouldYield}){
  const ctx=context(scope);if((unsupported.get(cacheKey(ctx))||0)>Date.now())return{enabled:false,unsupported:true,changed:false};
  let state=reset?empty():await load(ctx),cursor=state.cursor,pages=0,changed=false,restarted=false,appliedRows=0,quarantineChanged=false,continuation=null,restarts=0,totalAppliedRows=0;
  if(reset)await persist(ctx,state);
  const refreshed=new Set();
  async function process(row,articles,sources,updates,rssStates,books,bookReading){
    const token=row.recordId+':'+row.revision;
    const cached=updates[row.recordId]||state.records[row.recordId];
    if(cached&&compare(cached.revision,row.revision)>0){if(state.quarantine[token]){delete state.quarantine[token];quarantineChanged=true;}return;}
    try{
      const version=keyVersion(row.envelope&&row.envelope.keyVersion);let key=await keyForVersion(version);check(ctx);
      if(!key&&refreshKeys&&!refreshed.has(version)){refreshed.add(version);await refreshKeys(version);check(ctx);key=await keyForVersion(version);check(ctx);}
      if(!key)throw failure('cloud_key_version_missing');
      const value=decode({userId:ctx.userId,key,anchorKey:anchorKey||key,recordId:row.recordId,envelope:row.envelope});
      if(value.retained.policy.read!=='known-fields'){state.unknown[row.recordId]=row;const previous=(updates[row.recordId]||state.records[row.recordId])?.retained,proof=value.retained.provenance;let versions=previous?.versions||[];
      if(proof&&previous?.provenance?.metadata===proof.metadata&&previous.provenance.extensions!==proof.extensions){versions=[...versions,previous.row];const unique=new Map(versions.map(v=>[v.recordId+':'+v.revision,v]));versions=[...unique.values()];if(versions.length>8)throw failure('cloud_record_conflict');}
      updates[row.recordId]={revision:row.revision,hash:value.hash,...(['book','book-reading'].includes(value.kind)?{kind:value.kind}:{}),...(value.retained.preserve?{retained:{policy:value.retained.policy,row,...(proof?{provenance:proof}:{}),...(versions.length?{versions}: {})}}:{})};return;}
      if(value.kind==='article'&&!provenance.protectedValue(value.value)&&rssPolicy.isPublic(value.value)&&!row.tombstone){state.rssRetirements[row.recordId]=retirement(value.value,row.revision,row.envelope,value.legacy);}
      if(value.kind==='article'&&!provenance.protectedValue(value.value)&&bookPolicy.isLegacy(value.value)&&!row.tombstone)state.bookRetirements[row.recordId]={value:value.value,revision:row.revision,...(value.legacy?{envelope:row.envelope}:{})};
      if(row.tombstone)delete state.bookRetirements[row.recordId];
      const retired=row.tombstone===true&&(!value.value||value.value.deleted!==true);
      if(row.tombstone)delete state.rssRetirements[row.recordId];
      if(value.kind==='article'&&value.value.bookIndexRetired===true){delete state.migrations[row.recordId];}
      else if(retired){delete state.migrations[row.recordId];delete state.unknown[row.recordId];}
      else if(value.kind==='book'){if(!ports.request){const current=bookPolicy.load().books[value.value.bookId];if(current&&current.chapterCount!==value.value.chapterCount)throw failure('cloud_book_invalid');}books.push(value.value);}
      else if(value.kind==='book-reading')bookReading.push(value.value);
      else if(value.kind==='rss-state'){rssStates.push(value.value);}
      else if(value.kind==='article'&&!provenance.protectedValue(value.value)&&rssPolicy.isPublic(value.value)&&!rssPolicy.isPrivate(value.value)){
        if(!row.tombstone)state.rssRetirements[row.recordId]=retirement(value.value,row.revision,row.envelope,value.legacy);
      }
      else if(['article','source'].includes(value.kind)){
        (value.kind==='article'?articles:sources).push(value.value);
        if(value.legacy&&!provenance.protectedValue(value.value)&&!row.tombstone&&!(value.kind==='article'&&(rssPolicy.isPublic(value.value)||bookPolicy.isLegacy(value.value))))state.migrations[row.recordId]={kind:value.kind,value:value.value,revision:row.revision,envelope:row.envelope};
      }else state.unknown[row.recordId]=row;
      const previous=(updates[row.recordId]||state.records[row.recordId])?.retained,proof=value.retained.provenance;let versions=previous?.versions||[];
      if(proof&&previous?.provenance?.metadata===proof.metadata&&previous.provenance.extensions!==proof.extensions){versions=[...versions,previous.row];const unique=new Map(versions.map(v=>[v.recordId+':'+v.revision,v]));versions=[...unique.values()];if(versions.length>8)throw failure('cloud_record_conflict');}
      updates[row.recordId]={revision:row.revision,hash:value.hash,...(['book','book-reading'].includes(value.kind)?{kind:value.kind}:{}),...(value.retained.preserve?{retained:{policy:value.retained.policy,row,...(proof?{provenance:proof}:{}),...(versions.length?{versions}: {})}}:{})};
      for(const [name,item]of Object.entries(state.quarantine))if(item.recordId===row.recordId&&compare(item.revision,row.revision)<=0){delete state.quarantine[name];quarantineChanged=true;}
      if(row.tombstone)delete state.migrations[row.recordId];
    }catch(error){check(ctx);if(['cloud_content_rebuild_required','NEEDS_RECOVERY','cloud_key_commitment_mismatch','cloud_session_changed'].includes(error.code))throw error;
      state.quarantine[token]={recordId:row.recordId,revision:row.revision,keyVersion:row.envelope&&row.envelope.keyVersion,reason:error.code||'cloud_record_invalid',row};quarantineChanged=true;
    }
  }
  // Retry retained ciphertext; a missing key or poisoned row never fences GET.
  const replayArticles=[],replaySources=[],replayUpdates={},replayRss=[],replayBooks=[],replayReading=[];
  if(!state.articleProvenanceReadVersion){for(const entry of Object.values(state.records)){if(!entry.retained?.row)continue;await (ports.yield||util.tick)();check(ctx);await process(entry.retained.row,replayArticles,replaySources,replayUpdates,replayRss,replayBooks,replayReading);}state.articleProvenanceReadVersion=1;quarantineChanged=true;}
  for(const item of Object.values(state.quarantine)){await (ports.yield||util.tick)();check(ctx);await process(item.row,replayArticles,replaySources,replayUpdates,replayRss,replayBooks,replayReading);}
  if(replayArticles.length||replaySources.length||replayRss.length||replayBooks.length||replayReading.length){changed=!!(await apply({articles:replayArticles,sources:replaySources,rssStates:replayRss,books:replayBooks,bookReading:replayReading}));check(ctx);totalAppliedRows+=replayArticles.length+replaySources.length+replayRss.length+replayBooks.length+replayReading.length;appliedRows+=replayArticles.length+replaySources.length+replayRss.length+replayBooks.length+replayReading.length;quarantineChanged=true;}
  Object.assign(state.records,replayUpdates);
  // Conflict ciphertext can predate after. Apply it without claiming coverage
  // of the missing interval or advancing the durable GET cursor.
  if(supplements.length){
   const articles=[],sources=[],updates={},rssStates=[],books=[],bookReading=[];
   for(const row of supplements){revision(row.revision);if(!ID.test(row.recordId))throw failure('cloud_record_response_invalid');await process(row,articles,sources,updates,rssStates,books,bookReading);}
   if(articles.length||sources.length||rssStates.length||books.length||bookReading.length){changed=!!(await apply({articles,sources,rssStates,books,bookReading}))||changed;check(ctx);totalAppliedRows+=articles.length+sources.length+rssStates.length+books.length+bookReading.length;appliedRows+=articles.length+sources.length+rssStates.length+books.length+bookReading.length;}
   Object.assign(state.records,updates);
  }
  while(true){
   if(++pages>2000)throw failure('cloud_record_response_invalid');
   let data;
   try{data=exchange?await exchange.read(cursor,state,continuation):await send(ctx,{method:'GET',path:PATH+`?after=${cursor}&limit=${LIMIT}`+(!ports.request?'&deviceId='+encodeURIComponent(require('./device').deviceId()):'')});}
   catch(error){
    check(ctx);
    if(exchange&&['cloud_exchange_window_changed','cloud_exchange_cursor_reset_required','cloud_exchange_records_reset_required'].includes(error.code)&&restarts++<3){
     continuation=null;state=error.code==='cloud_exchange_window_changed'?await load(ctx):empty();cursor=state.cursor;appliedRows=0;quarantineChanged=false;
     if(error.code!=='cloud_exchange_window_changed')await persist(ctx,state);continue;
    }
    if(!restarted&&error.status===400&&error.code==='cloud_record_cursor_invalid'){restarted=true;state=empty();await persist(ctx,state);cursor='0';continue;}throw error;
   }
   if(!data)return{enabled:false,unsupported:true,changed};
   if(format(data)===0){await persist(ctx,empty());return{enabled:false,unsupported:false,changed:false};}
   const next=revision(data.cursor),head=revision(data.headRevision);
   if(!Array.isArray(data.items)||data.items.length>LIMIT||typeof data.hasMore!=='boolean'||compare(next,cursor)<0||compare(head,next)<0||(!data.hasMore&&next!==head)||(data.hasMore&&(next===cursor||!data.items.length)))throw failure('cloud_record_response_invalid');
   const articles=[],sources=[],updates={},rssStates=[],books=[],bookReading=[];let last=cursor;
   for(const row of data.items){
    await (ports.yield||util.tick)();check(ctx);const rev=revision(row.revision);if(!ID.test(row.recordId)||compare(rev,last)<=0||compare(rev,next)>0)throw failure('cloud_record_response_invalid');last=rev;
    await process(row,articles,sources,updates,rssStates,books,bookReading);
   }
   if(articles.length||sources.length||rssStates.length||books.length||bookReading.length){check(ctx);changed=!!(await apply({articles,sources,rssStates,books,bookReading}))||changed;check(ctx);totalAppliedRows+=articles.length+sources.length+rssStates.length+books.length+bookReading.length;appliedRows+=articles.length+sources.length+rssStates.length+books.length+bookReading.length;}
   Object.assign(state.records,updates);cursor=next;
   if(exchange){
    if(appliedRows&&commit){await commit();check(ctx);}state.recordsGeneration=data.recordsGeneration;
    const advanced=state.cursor!==cursor;state.cursor=cursor;
    if(appliedRows||advanced||quarantineChanged||!state.exchangeVersion){state.exchangeVersion=1;await persist(ctx,state);}appliedRows=0;quarantineChanged=false;
    continuation=data.continuation;
   }
   if(data.hasMore&&shouldYield&&shouldYield()){
    // Hand off only after projection and cursor describe the same complete page.
    // A failed projection/state write must not authorize the foreground writer.
    if(appliedRows&&commit){await commit();check(ctx);}const advanced=state.cursor!==cursor;state.cursor=cursor;
    if(appliedRows||advanced||quarantineChanged)await persist(ctx,state);
    return{enabled:true,unsupported:false,changed,cursor,pages,yielded:true,needsPush:true,quarantined:Object.keys(state.quarantine).length};
   }
   if(!data.hasMore){if(appliedRows && commit){await commit();check(ctx);}const advanced=state.cursor!==cursor;state.cursor=cursor;if(appliedRows||advanced||quarantineChanged)await persist(ctx,state);return{enabled:true,unsupported:false,changed,cursor,pages,needsPush:!!(totalAppliedRows||Object.keys(state.migrations).length||Object.keys(state.rssRetirements).length||Object.keys(state.bookRetirements).length),quarantined:Object.keys(state.quarantine).length,upgradeRequired:Object.values(state.records).some(v=>v.retained&&!v.retained.policy.write)};}
  }
 }
 async function push({scope,keyVersion:version,key,anchorKey=key,articles=[],sources=[],rssStates=[],books=[],bookReading=[],bookIds,readyBookIds=[],deferSavedCleanup=false,pendingSavedArticleIds=[],readySavedArticleIds,exchange=scope&&scope.exchange,onDelta,onAck,entitiesOnly=false,shouldYield,onStage=()=>{},_fullState=false,_targetedTried=false}){
  const retryInput=arguments[0];let ownedAnchor,sparse=false,targetedRetry;try{
  const ctx=context(scope);if(!ports.request)require('./library').assertUploadOwner();if((unsupported.get(cacheKey(ctx))||0)>Date.now())return{written:0,unsupported:true};
  evolution.assertAccountWriteRoot(key);keyVersion(version);if(!ports.request){const sync=require('./sync'),trust=sync.trustInfo(ctx.userId);if(version!==sync.currentKeyVersion(ctx.userId))throw failure('cloud_key_version_stale');ownedAnchor=sync.getAccountKey(ctx.userId,trust.keyCommitments[0].keyVersion);anchorKey=ownedAnchor;if(!anchorKey)throw failure('NEEDS_RECOVERY');}
  onStage('loading');const incremental=sparseEnabled&&entitiesOnly&&!exchange&&!onDelta&&!articles.length&&!sources.length,fast=incremental&&!_fullState?await sparseState(ctx):null;sparse=!!fast;let state=fast?fast.state:await load(ctx);
  const identityKeys=derived(key,ctx.userId,anchorKey);try{for(const [id,entry]of (entitiesOnly?[]:Object.entries(state.rssRetirements))){state.rssRetirements[id]=retirement(entry.value,entry.revision,entry.envelope,opaque(identityKeys,'article',entry.value)!==id);delete state.migrations[id];}}finally{dispose(identityKeys);}
  // Foreground imports acknowledge their own entities. Library maintenance
  // remains with the background driver, including pending legacy retirements.
  const selectedBooks=entitiesOnly?new Set(bookIds||books.map(value=>value.bookId)):null;
  const originalArticles=articles,protectedArticles=articles.filter(provenance.protectedValue);articles=articles.filter(value=>!provenance.protectedValue(value));
  if(!ports.request){const bp=await bookPolicy.projectAsync(articles,sources);articles=bp.articles;sources=bp.sources;const selected=selectedBooks||(bookIds&&new Set(bookIds));books=books.concat(bp.books.filter(s=>!selected||selected.has(s.bookId)));bookReading=bookReading.concat(bp.bookReading.filter(s=>!selected||selected.has(s.bookId)));}
  if(selectedBooks){books=books.filter(value=>selectedBooks.has(value.bookId));bookReading=bookReading.filter(value=>selectedBooks.has(value.bookId));}
  books=[...books.reduce((map,value)=>map.set(value.bookId,bookPolicy.merge(map.get(value.bookId),value)),new Map()).values()];bookReading=[...bookReading.reduce((map,value)=>{const key=value.bookId+':'+value.chapterIndex;return map.set(key,bookPolicy.mergeReading(map.get(key),value));},new Map()).values()];
  const projection=rssPolicy.project(articles,sources);articles=projection.articles;sources=projection.sources;rssStates=rssStates.concat(projection.rssStates);
  onStage('encoding');await crypto.initializeRandom();check(ctx);
  const keys=derived(key,ctx.userId,anchorKey);let batch=[],size=util.utf8ToBytes(JSON.stringify({formatVersion:1,items:[]})).length,written=0,processed=0;const seen=new Set(),editPending=[],pendingEntities=[];
  async function retainedFor(recordId,cached){if(!cached?.retained)return null;const row=cached.retained.row;if(!row||row.recordId!==recordId||row.revision!==cached.revision)throw failure('cloud_record_conflict');const oldKey=row.envelope.keyVersion===version?key:ports.keyForVersion?await ports.keyForVersion(row.envelope.keyVersion):!ports.request?require('./sync').getAccountKey(ctx.userId,row.envelope.keyVersion):null;check(ctx);if(!oldKey)throw failure('cloud_key_version_missing');try{return decode({userId:ctx.userId,key:oldKey,anchorKey,recordId,envelope:row.envelope}).retained;}finally{if(oldKey!==key&&!ports.request)oldKey.fill(0);}}
  // A conflict revision is only a locator. Authenticate the exact current row
  // before rebasing; this read must never acknowledge a device/global cursor.
  targetedRetry=async error=>{
   // Backend auth.rs maps wrp_ and verified phone JWTs to device_id=None;
   // watch access tokens are wra_ (account.rs/watch_refresh.rs). appaccess
   // adds device headers only on mutations. Other credential types fall back.
   const token=String(ctx.accessToken||''),enabled=ports.request?ports.targetedConflicts===true:token.startsWith('wrp_')||token.split('.').length===3;
   const hints=error.recordConflicts;if(!enabled||_targetedTried||!hints||!Array.isArray(hints.items)||!hints.items.length||hints.items.length>LIMIT)return null;
   const submitted=new Map(batch.map(item=>[item.recordId,item])),updates={},mergedBooks=new Map(books.map(v=>[v.bookId,v])),mergedReading=new Map(bookReading.map(v=>[v.bookId+':'+v.chapterIndex,v])),ids=new Set();
   for(const hint of hints.items){
    const item=submitted.get(hint.recordId);if(!item||!['book','book-reading'].includes(item._entity?.kind)||ids.has(hint.recordId))return null;ids.add(hint.recordId);
    let rev;try{rev=revision(hint.revision);revision(hints.headRevision);}catch(_){return null;}if(rev==='0'||compare(rev,hints.headRevision)>0)return null;
    let data;try{data=await send(ctx,{method:'GET',path:PATH+'?after='+String(BigInt(rev)-1n)+'&limit=1'});}catch(e){if(e.code==='cloud_record_cursor_invalid')return null;throw e;}
    if(!data||data.formatVersion!==1||!Array.isArray(data.items)||data.items.length!==1)return null;
    const expected=ackIdentity(ctx);if(typeof data.libraryEpoch!=='string'||typeof data.contentGeneration!=='string')return null;
    if(data.libraryEpoch!==expected.libraryEpoch)throw failure('NEEDS_RECOVERY');if(data.contentGeneration!==expected.contentGeneration)throw failure('cloud_content_rebuild_required');
    const row=data.items[0];if(row.recordId!==hint.recordId||row.revision!==rev)return null;try{if(compare(revision(data.headRevision),rev)<0)return null;}catch(_){return null;}
    const oldKey=row.envelope?.keyVersion===version?key:ports.keyForVersion?await ports.keyForVersion(row.envelope?.keyVersion):!ports.request?require('./sync').getAccountKey(ctx.userId,row.envelope?.keyVersion):null;check(ctx);if(!oldKey)return null;
    let decoded;try{decoded=decode({userId:ctx.userId,key:oldKey,anchorKey,recordId:row.recordId,envelope:row.envelope});}finally{if(oldKey!==key&&!ports.request)oldKey.fill(0);}
    if(decoded.kind!==item._entity.kind)return null;
    if(decoded.retained.policy.read==='known-fields'){
     if(row.tombstone&&!(decoded.kind==='book'&&restoresDeletion(decoded.value,mergedBooks.get(decoded.value.bookId)||{})))throw failure('cloud_book_chapter_deleted');
     if(decoded.kind==='book'){
      const local=mergedBooks.get(decoded.value.bookId);if(!local)return null;
      if((decoded.value.deleted&&!local.deleted||decoded.value.deletedChapters.some(i=>!local.deletedChapters.includes(i)))&&!restoresDeletion(decoded.value,local))throw failure('cloud_book_chapter_deleted');
      mergedBooks.set(local.bookId,bookPolicy.merge(decoded.value,local));
     }else{const id=decoded.value.bookId+':'+decoded.value.chapterIndex,local=mergedReading.get(id);if(!local)return null;mergedReading.set(id,bookPolicy.mergeReading(decoded.value,local));}
    }
    updates[row.recordId]={revision:rev,hash:decoded.hash,kind:decoded.kind,retained:{policy:decoded.retained.policy,row}};
   }
   check(ctx);Object.assign(state.records,updates);await persistAcks(ctx,state,Object.keys(updates));
   return{...retryInput,books:[...mergedBooks.values()],bookReading:[...mergedReading.values()],_targetedTried:true};
  };
  async function flush(){
   if(!batch.length)return true;
   onStage('submitting');let data,full;
   try{if(exchange){full=await exchange.write({formatVersion:1,items:batch},state);data={formatVersion:full.formatVersion,items:full.writeAck};}else data=await send(ctx,{method:'POST',path:PATH,body:{formatVersion:1,items:batch}});}
   catch(error){if(exchange&&error.code==='cloud_record_conflict'&&error.exchangeData&&onDelta){const options=await exchange.conflict(error.exchangeData);await onDelta(options);check(ctx);error.deltaApplied=true;}throw error;}
   if(!data)return false;
   if(format(data)!==1||!Array.isArray(data.items)||data.items.length!==batch.length)throw failure('cloud_record_response_invalid');
   const expected=new Map(batch.map(item=>[item.recordId,item])),acks=new Set();
   for(const row of data.items){const item=expected.get(row.recordId),rev=revision(row.revision);if(!item||acks.has(row.recordId)||compare(rev,item.expectedRevision)<=0)throw failure('cloud_record_response_invalid');acks.add(row.recordId);}
   if(onAck)await onAck(batch.map(item=>item._entity).filter(Boolean));check(ctx);
   let foreign=false;
   if(full&&onDelta){
    const own=new Set(data.items.map(row=>row.recordId+':'+row.revision));foreign=full.hasMore||full.items.some(row=>!own.has(row.recordId+':'+row.revision));
    await exchange.offer(full);await onDelta();check(ctx);state=await load(ctx);
   }
   acks.clear();
   for(const row of data.items){const item=expected.get(row.recordId),rev=revision(row.revision);if(!item||acks.has(row.recordId)||compare(rev,item.expectedRevision)<=0)throw failure('cloud_record_response_invalid');acks.add(row.recordId);if(state.records[row.recordId]&&compare(state.records[row.recordId].revision,rev)>0)continue;state.records[row.recordId]={revision:rev,hash:item._hash,...(['book','book-reading'].includes(item._entity?.kind)?{kind:item._entity.kind}:{}),...(item._retained?{retained:{policy:item._retained.policy,row:{recordId:row.recordId,revision:rev,envelope:item.envelope,tombstone:item.tombstone}}}:{})};if(item._publicValue&&!item.tombstone)state.rssRetirements[row.recordId]=retirement(item._publicValue,rev);if(item._retirementDone){delete state.rssRetirements[item._retirementDone];delete state.migrations[item._retirementDone];}if(item._migrationDone)delete state.migrations[item._migrationDone];if(item._bookDone){delete state.bookRetirements[item._bookDone];delete state.migrations[item._bookDone];}}
   onStage('saving');written+=batch.length;if(incremental)await persistAcks(ctx,state,[...expected.keys()],!sparse);else await persist(ctx,state);batch=[];size=util.utf8ToBytes(JSON.stringify({formatVersion:1,items:[]})).length;
   if(shouldYield&&shouldYield())throw failure('cloud_foreground_pending');
   // Later queued documents were captured before the concurrent delta. Rebuild
   // them from the merged projection rather than CAS stale values at fresh revs.
   if(foreign)throw failure('cloud_record_rebase_required');return true;
  }
  try{
   for(const value of protectedArticles){const recordId=opaque(keys,'article',value),cached=state.records[recordId];if(cached&&cached.hash===fingerprint(provenance.asRecord(value))&&!value.__articlePendingEdits)continue;editPending.push(recordId);pendingEntities.push({kind:'article',entityId:value.articleId,sourceUrl:value.rssSourceUrl});}
   const warnings=projection.warnings,blocked=new Set(),readByKey=rssStates.reduce((map,value)=>{const id=value.sourceId+':'+value.articleIdHash;map.set(id,rssPolicy.mergeState(map.get(id),value));return map;},new Map());
   for(const [oldId,entry]of (entitiesOnly?[]:Object.entries(state.rssRetirements))){if(!rssPolicy.interacted(entry.value)||rssPolicy.localOnly(entry.value.rssSourceUrl))continue;try{const value=rssPolicy.stateOf(canonicalArticle(entry.value),rssPolicy.sourceKey(entry.value.rssSourceUrl)),id=value.sourceId+':'+value.articleIdHash;readByKey.set(id,rssPolicy.mergeState(value,readByKey.get(id)||value));}catch(error){blocked.add(oldId);warnings.push({articleId:entry.value.articleId,url:entry.value.rssSourceUrl,code:error.code});}}
   rssStates=Array.from(readByKey.values());
   for(const deleting of [true,false]){
   for(const [kind,values]of [['article',articles],['source',sources],['rss-state',rssStates],['book',books],['book-reading',bookReading]])for(const value of values){
    if(!!value.deleted!==deleting)continue;
    if(++processed%8===0){await (ports.yield||util.tick)();check(ctx);}
    check(ctx);let doc=canonical(kind,value);const recordId=opaque(keys,kind,doc.value);if(seen.has(recordId))throw failure('cloud_record_duplicate');seen.add(recordId);
    const cached=state.records[recordId];if(!['book','book-reading'].includes(kind)&&cached&&cached.hash===fingerprint(doc))continue;
    const retained=await retainedFor(recordId,cached);
    // Point reads retain their authenticated envelope. Merge it again on later
    // imports, so a fresh CAS revision cannot bless an older local reading tuple.
    if(retained?.policy.read==='known-fields'&&['book','book-reading'].includes(kind)){
     const remote=canonical(kind,rawJson.parse(retained.raw).value).value;
     if((cached.retained.row.tombstone&&!(kind==='book'&&remote.deleted&&value.deleted)||kind==='book'&&(remote.deleted&&!value.deleted||remote.deletedChapters.some(i=>!value.deletedChapters.includes(i))))&&!(kind==='book'&&restoresDeletion(remote,value)))throw failure('cloud_book_chapter_deleted');
     doc=canonical(kind,kind==='book'?bookPolicy.merge(remote,value):bookPolicy.mergeReading(remote,value));
    }
    const hash=fingerprint(doc);if(cached&&cached.hash===hash)continue;
    if(retained&&!retained.policy.write){editPending.push(recordId);pendingEntities.push({kind,entityId:kind==='article'?value.articleId:kind==='source'?value.url:value.bookId,sourceUrl:value.rssSourceUrl||value.sourceUrl,articleIdHash:value.articleIdHash,chapterIndex:value.chapterIndex});continue;}
    const text=retained?rawJson.stringify(rawJson.merge(rawJson.parse(retained.raw),doc)):JSON.stringify(doc),bytes=util.utf8ToBytes(text);
    if(bytes.length+16>MAX_BYTES)throw failure('cloud_record_too_large');
    const nonce=crypto.randomBytes(12),envelope={algorithm:'A256GCM',keyVersion:version,nonceBase64:util.base64PaddedEncode(nonce),ciphertextBase64:util.base64PaddedEncode(crypto.aesGcmEncrypt(keys.cipher,nonce,bytes,aad(ctx.userId,recordId,version)))};
    const item={recordId,expectedRevision:cached?cached.revision:'0',envelope,tombstone:!!doc.value.deleted};Object.defineProperty(item,'_entity',{value:{kind,entityId:kind==='article'?value.articleId:kind==='source'?value.url:value.bookId,sourceUrl:value.rssSourceUrl||value.sourceUrl,articleIdHash:value.articleIdHash,chapterIndex:value.chapterIndex}});Object.defineProperty(item,'_hash',{value:hash});if(cached?.retained)Object.defineProperty(item,'_retained',{value:{raw:text,policy:evolution.assess(rawJson.parse(text),'record',Object.keys(doc.value))}});if(kind==='article'&&rssPolicy.isPublic(value))Object.defineProperty(item,'_publicValue',{value});const bytesSize=util.utf8ToBytes(JSON.stringify(item)).length;
    if(batch.length && (batch.length>=LIMIT||size+bytesSize+1>(exchange?MAX_BATCH-4096:MAX_BATCH))){if(!await flush())return{written:0,unsupported:true};}
    batch.push(item);size+=bytesSize+(batch.length>1?1:0);
   }
   if(!await flush())return{written:0,unsupported:true};
   }
   // Preserve unrelated editPending/retirement queues byte for byte. The caller
   // still receives failures for its own submitted entities and cannot publish
   // a dependent snapshot until every submitted batch is acknowledged.
   if(entitiesOnly){if(incremental&&!sparse&&!written&&seen.size){onStage('saving');await persistAcks(ctx,state,[...seen],true);}return{written,unsupported:false,warnings,editPending:editPending.length>0,pendingEntities,upgradeRequired:editPending.length>0};}
   // Replacement states have been acknowledged. Retire in bounded batches;
   // each acknowledged batch durably removes only its completed work.
   async function queue(item){
     if(++processed%8===0){await (ports.yield||util.tick)();check(ctx);}
     const bytes=util.utf8ToBytes(JSON.stringify(item)).length;
     if(batch.length&&(batch.length>=LIMIT||size+bytes+1>(exchange?MAX_BATCH-4096:MAX_BATCH))){if(!await flush())return false;}
     batch.push(item);size+=bytes+(batch.length>1?1:0);return true;
   }
   const aliases=[],localById=new Map(originalArticles.map(article=>[article.articleId,article])),pendingSaved=new Set(pendingSavedArticleIds),readySaved=readySavedArticleIds&&new Set(readySavedArticleIds);
   for(const [oldId,entry]of Object.entries(state.rssRetirements)){
     if(blocked.has(oldId)||state.records[oldId]?.retained&&!state.records[oldId].retained.policy.write)continue;
     const local=localById.get(canonicalArticle(entry.value).articleId),active=local||entry.value;
     if(rssPolicy.isPrivate(active)&&!active.deleted&&(deferSavedCleanup||pendingSaved.has(active.articleId)||readySaved&&!readySaved.has(active.articleId)))continue;
     const current=state.records[oldId];if(!current){delete state.rssRetirements[oldId];continue;}
     const value={...entry.value,deleted:true,deletedAt:Math.max(deletionClock(entry.value),deletionClock(local||{})),favoriteSaved:false,watchLaterSaved:false};
     const tomb=encode({userId:ctx.userId,key,keyVersion:version,anchorKey,kind:'article',value,retained:await retainedFor(oldId,state.records[oldId])});
     const anchored=state.records[tomb.recordId];
     const item={recordId:tomb.recordId,expectedRevision:anchored?anchored.revision:'0',envelope:tomb.envelope,tombstone:true};Object.defineProperty(item,'_hash',{value:tomb.hash});if(tomb.retained)Object.defineProperty(item,'_retained',{value:tomb.retained});
     if(tomb.recordId===oldId)Object.defineProperty(item,'_retirementDone',{value:oldId});
     else aliases.push({oldId,entry,current});
     if(!await queue(item))return{written,unsupported:true};
   }
   if(!await flush())return{written,unsupported:true};
   // A pre-anchor alias follows its stable entity tombstone, never precedes it.
   for(const {oldId,entry,current}of aliases){
     if(!entry.envelope)throw failure('cloud_record_invalid');
     const item={recordId:oldId,expectedRevision:current.revision,envelope:entry.envelope,tombstone:true};Object.defineProperty(item,'_hash',{value:current.hash});Object.defineProperty(item,'_retirementDone',{value:oldId});
     if(!await queue(item))return{written,unsupported:true};
   }
   if(!await flush())return{written,unsupported:true};
   // R44: first acknowledge book + sparse reading, then retire old chapter IDs.
   const readyBooks=new Set(readyBookIds),bookById=new Map(books.map(value=>[value.bookId,value]));
   for(const [oldId,entry]of Object.entries(state.bookRetirements)){
    if(state.records[oldId]?.retained&&!state.records[oldId].retained.policy.write)continue;
    const membership=!ports.request?bookPolicy.member(entry.value):null;if(!membership)continue;
    const replacement=bookById.get(membership.bookId);if(!replacement||(!replacement.deleted&&!readyBooks.has(replacement.bookId)))continue;
    const bookRecord=opaque(keys,'book',replacement);if(!state.records[bookRecord])continue;
    const value={...entry.value,bookIndexRetired:true,deleted:true,deletedAt:deletionClock(entry.value)};
    const tomb=encode({userId:ctx.userId,key,keyVersion:version,anchorKey,kind:'article',value}),cached=state.records[tomb.recordId];
    const item={recordId:tomb.recordId,expectedRevision:cached?cached.revision:'0',envelope:tomb.envelope,tombstone:true};Object.defineProperty(item,'_hash',{value:tomb.hash});if(tomb.retained)Object.defineProperty(item,'_retained',{value:tomb.retained});
    if(tomb.recordId===oldId)Object.defineProperty(item,'_bookDone',{value:oldId});
    if(!await queue(item))return{written,unsupported:true};
    if(tomb.recordId!==oldId){if(!await flush())return{written,unsupported:true};if(!entry.envelope)throw failure('cloud_record_invalid');const alias={recordId:oldId,expectedRevision:entry.revision,envelope:entry.envelope,tombstone:true};Object.defineProperty(alias,'_hash',{value:state.records[oldId].hash});Object.defineProperty(alias,'_bookDone',{value:oldId});if(!await queue(alias))return{written,unsupported:true};}
   }
   if(!await flush())return{written,unsupported:true};
   // Stable-ID migration: only retire a legacy ID after the anchored copy exists.
   for(const [oldId,migration]of Object.entries(state.migrations)){
     if(state.records[oldId]?.retained&&!state.records[oldId].retained.policy.write)continue;
     const doc=canonical(migration.kind,migration.value),newId=opaque(keys,doc.kind,doc.value);
     if(newId===oldId||!state.records[newId])continue;
     // This retires a storage ID, not the logical entity. Preserve its authenticated
     // value and old content key: encrypting deleted=true would delete the new ID too.
     const item={recordId:oldId,expectedRevision:migration.revision,envelope:migration.envelope,tombstone:true};Object.defineProperty(item,'_hash',{value:fingerprint(doc)});Object.defineProperty(item,'_migrationDone',{value:oldId});
     if(!await queue(item))return{written,unsupported:true};
   }
   if(!await flush())return{written,unsupported:true};if(JSON.stringify(state.editPending||[])!==JSON.stringify(editPending)){state.editPending=editPending;await persist(ctx,state);}return{written,unsupported:false,warnings,editPending:editPending.length>0,pendingEntities,upgradeRequired:editPending.length>0||Object.values(state.records).some(v=>v.retained&&!v.retained.policy.write)};
  }finally{dispose(keys);}
  }catch(error){if(sparse&&error.code==='cloud_record_conflict'){const retry=targetedRetry&&await targetedRetry(error);return push(retry||{...retryInput,_fullState:true});}throw error;}finally{if(ownedAnchor)ownedAnchor.fill(0);}
 }
 function status(scope){return ports.request?statusRequest(scope):require('./sync').withContentRebuild(()=>statusRequest(scope));}
 function consent(scope){return ports.request?consentRequest(scope):require('./sync').withContentRebuild(()=>consentRequest(scope));}
 if(!ports.request)require('./cloud-scope').setContentClearHandler(()=>unsupported.clear());
 function resetSession(){generation++;unsupported.clear();}
 async function checkpoint(scope){const ctx=context(scope);if(!ports.request){const file=require('./cloud-scope').path('records-checkpoint',ctx.userId);try{const m=storage.readJSONAsync?await storage.readJSONAsync(file,null):storage.readJSON(file,null);check(ctx);if(m&&m.version===1&&m.contentGeneration===ctx.contentGeneration&&m.cacheRevision===ctx.cacheRevision){revision(m.cursor);return m;}}catch(e){check(ctx);if(!['local_storage_read_failed','cloud_record_response_invalid'].includes(e.code)&&!(e instanceof SyntaxError))throw e;}}const s=await load(ctx);return{cursor:s.cursor,recordsGeneration:s.recordsGeneration||null,quarantined:Object.keys(s.quarantine).length,needsPush:!!(Object.keys(s.migrations).length||Object.keys(s.rssRetirements).length||Object.keys(s.bookRetirements).length||(s.editPending||[]).length)};}
 return{status,consent,pull,push,checkpoint,resetSession};
}
module.exports=Object.assign({createClient,encode,decode,canonical,fingerprint},createClient());
