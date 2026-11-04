// Exchange P1 metadata/transport. Cached tags never grant authorization; every
// request still uses appaccess, live server fences, and the existing record codec.
const crypto=require('./crypto'),util=require('./util');
const PATH='/functions/v1/cloud/sync/exchange',HEX=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX='9223372036854775807';
function error(code='cloud_exchange_response_invalid'){return Object.assign(Error(code),{code});}
function compare(a,b){return a.length-b.length||(a===b?0:a<b?-1:1);}
function revision(v){if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(v)||compare(v,MAX)>0)throw error();return v;}
function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object'){const out=Object.create(null);for(const k of Object.keys(v).sort())if(v[k]!==undefined)out[k]=stable(v[k]);return out;}return v;}
function canonicalJSON(v){return JSON.stringify(stable(v));}
// Only vector verification uses tag(); live tags are opaque server values.
function tag(kind,input){if(!['trust','heads'].includes(kind))throw error();return crypto.sha256Hex(util.bytesConcat([util.utf8ToBytes('watchrss/cloud/exchange/'+kind+'/v1\0'),util.utf8ToBytes(canonicalJSON(input))]));}
function requestBody({deviceId,libraryEpoch,contentGeneration,after='0',recordsGeneration=null,verifiedCache=false,knownTrustTag=null,knownHeadsTag=null,limit=50,maxResponseBytes=131072,frozenHead=null,cursorFloor=null,ackAfter=null,write=null}){
 if(typeof deviceId!=='string'||!deviceId||deviceId.length>128||!UUID.test(libraryEpoch)||!UUID.test(contentGeneration)||recordsGeneration!==null&&!UUID.test(recordsGeneration)||typeof verifiedCache!=='boolean'||!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(maxResponseBytes)||maxResponseBytes<16384||maxResponseBytes>262144)throw error('cloud_exchange_request_invalid');
 revision(after);for(const n of [frozenHead,cursorFloor,ackAfter])if(n!==null)revision(n);
 if((frozenHead===null)!==(cursorFloor===null)||frozenHead!==null&&write!==null||ackAfter!==null&&ackAfter!==after||[knownTrustTag,knownHeadsTag].some(t=>t!==null&&!HEX.test(t)))throw error('cloud_exchange_request_invalid');
 if(write!==null&&(write.formatVersion!==1||!Array.isArray(write.items)||write.items.length<1||write.items.length>50))throw error('cloud_exchange_request_invalid');
 const body={version:1,deviceId,libraryEpoch,contentGeneration,recordsGeneration,after,ackAfter,verifiedCache,knownTrustTag,knownHeadsTag,limit,maxResponseBytes,frozenHead,cursorFloor,write};if(util.utf8ToBytes(JSON.stringify(body)).length>1048576)throw error('cloud_exchange_request_invalid');return body;
}
function row(value){if(!value||!HEX.test(value.recordId)||typeof value.tombstone!=='boolean'||!value.envelope||typeof value.envelope!=='object')throw error();revision(value.revision);return value;}
function validate(data,q,spki,{conflict=false}={}){
 if(!data||data.version!==1||data.libraryEpoch!==q.libraryEpoch||data.contentGeneration!==q.contentGeneration||!UUID.test(data.recordsGeneration)||!HEX.test(data.trustTag)||!HEX.test(data.headsTag)||![0,1].includes(data.formatVersion)||!Number.isInteger(data.keyVersionFloor)||data.keyVersionFloor<0||typeof data.contentEmpty!=='boolean'||!(data.contentClearedAt===null||typeof data.contentClearedAt==='string')||typeof data.serverTime!=='string'||!Number.isFinite(Date.parse(data.serverTime)))throw error();
 if(!data.device||data.device.deviceId!==q.deviceId||data.device.publicKeySha256!==spki||data.device.registered!==true||data.device.authorized!==true||!Number.isInteger(data.device.keyVersion)||data.device.keyVersion<=data.keyVersionFloor)throw error();
 if(q.recordsGeneration&&q.recordsGeneration!==data.recordsGeneration)throw error('cloud_exchange_records_reset_required');
 for(const k of ['trustChanged','headsChanged','bootstrapRequired','headsRequired','hasMore'])if(typeof data[k]!=='boolean')throw error();
 if(data.trustChanged!==(q.knownTrustTag!==data.trustTag)||data.headsChanged!==(q.knownHeadsTag!==data.headsTag)||data.bootstrapRequired!==(!q.verifiedCache||data.trustChanged)||data.headsRequired!==data.headsChanged)throw error();
 if(!data.member||typeof data.member.readable!=='boolean'||typeof data.member.writable!=='boolean'||!data.formatCapabilities||typeof data.formatCapabilities!=='object')throw error();
 const cursor=revision(data.cursor),head=revision(data.headRevision),frozen=revision(data.frozenHead),floor=revision(data.cursorFloor);revision(data.acknowledgedCursor);
 if(head!==frozen||q.frozenHead!==null&&q.frozenHead!==frozen||q.cursorFloor!==null&&q.cursorFloor!==floor||compare(cursor,q.after)<0||compare(cursor,frozen)>0||compare(floor,frozen)>0||!data.hasMore&&cursor!==frozen)throw error();
 if(!Array.isArray(data.items)||data.items.length>q.limit||!Array.isArray(data.writeAck))throw error();let last=q.after;const ids=new Set();
 for(const item of data.items){row(item);if(compare(item.revision,last)<=0||compare(item.revision,cursor)>0||ids.has(item.recordId))throw error();ids.add(item.recordId);last=item.revision;}
 if(data.hasMore){const c=data.continuation;if(!data.items.length||cursor!==last||!c||c.after!==cursor||c.frozenHead!==frozen||c.recordsGeneration!==data.recordsGeneration||c.cursorFloor!==floor)throw error();}else if(data.continuation!==null)throw error();
 if(conflict){if(data.error!=='cloud_record_conflict'||!Array.isArray(data.conflicts)||!Array.isArray(data.conflictItems)||typeof data.conflictItemsTruncated!=='boolean'||data.writeAck.length)throw error();const conflicts=new Map();for(const c of data.conflicts){if(!HEX.test(c.recordId)||conflicts.has(c.recordId))throw error();revision(c.revision);conflicts.set(c.recordId,c.revision);}const seen=new Set();for(const item of data.conflictItems){row(item);if(conflicts.get(item.recordId)!==item.revision||seen.has(item.recordId))throw error();seen.add(item.recordId);}}
 else if(!q.write&&data.writeAck.length)throw error();
 Object.defineProperty(data,'_exchangeAfter',{value:q.after,configurable:true});return data;
}
function createClient(ports={}){
 const storage=ports.storage||require('./storage'),scopeStore=ports.scope||require('./cloud-scope'),sync=ports.sync||require('./sync'),device=ports.device||require('./device');
 const request=ports.request||(o=>require('./appaccess').request(o));let serial=0;const enabled=new Set(),saved=new Map();
 function identity(scope){const pair=sync.getDeviceKeyPair(scope.userId,device.deviceId());try{return{version:1,backend:scopeStore.backend(),userId:scope.userId,deviceId:device.deviceId(),publicKeySha256:crypto.sha256Hex(pair.spki),libraryEpoch:scopeStore.load(scope.userId)?.libraryEpoch,contentGeneration:scopeStore.content(scope.userId)?.contentGeneration,cacheRevision:scopeStore.content(scope.userId)?.cacheRevision||0};}finally{pair.privateKey.fill(0);}}
 function path(user){return scopeStore.path('exchange',user);}
 function cachePath(ctx){return ctx.exchangePath||path(ctx.userId);}
 function check(ctx){if(ctx.exchangeClosed)throw error('cloud_operation_cancelled');scopeStore.check(ctx);if(ctx.exchangeSerial!==serial)throw error('cloud_operation_cancelled');}
 async function readCache(scope){const ctx={...scopeStore.scope(scope.userId),...scope,exchangeSerial:serial};check(ctx);let data;try{data=storage.readJSONAsync?await storage.readJSONAsync(cachePath(ctx),null):storage.readJSON(cachePath(ctx),null);}catch(e){check(ctx);if(e.code!=='local_storage_read_failed'&&!(e instanceof SyntaxError))throw e;data=null;}check(ctx);saved.set(cachePath(ctx),canonicalJSON(data));return data;}
 function seal(value){return crypto.sha256Hex(canonicalJSON(value));}
 function cacheDigest(cache){return seal({identity:cache.identity,capabilities:cache.capabilities,boot:cache.boot,heads:cache.heads,trustTag:cache.trustTag,headsTag:cache.headsTag,projection:cache.projection});}
 function valid(cache,id){return !!cache&&cache.version===1&&cache.capabilities?.cloudSyncExchangeV1===true&&canonicalJSON(cache.identity)===canonicalJSON(id)&&cache.digest===cacheDigest(cache)&&Array.isArray(cache.boot?.devices)&&Array.isArray(cache.boot?.keyEnvelopes)&&Array.isArray(cache.boot?.keyCommitments)&&Array.isArray(cache.heads)&&HEX.test(cache.trustTag)&&HEX.test(cache.headsTag);}
 async function save(ctx,cache){check(ctx);cache.digest=cacheDigest(cache);const bytes=canonicalJSON(cache);if(saved.get(cachePath(ctx))===bytes)return;if(storage.writeJSONAsync)await storage.writeJSONAsync(cachePath(ctx),cache,{check:()=>check(ctx)});else storage.writeJSON(cachePath(ctx),cache);check(ctx);saved.set(cachePath(ctx),bytes);}
 function invalidate(user,file=path(user)){enabled.delete(file);saved.delete(file);storage.deleteFile(file);}
 function cachedEnabled(user){return enabled.has(path(user));}
 async function open(scope,checkpoint={cursor:'0'}){
  const ctx={...scopeStore.scope(scope.userId),...scope,exchangeSerial:serial,exchangePath:path(scope.userId)};check(ctx);let cache=await readCache(ctx),id=identity(ctx),usable=valid(cache,id),boot=null,heads=[],keyInfo=null;const keys=[];let handedOff=false;
  try{
  if(cache?.disabledUntil>Date.now()&&canonicalJSON(cache.identity)===canonicalJSON(id))return null;
  if(!usable){
   const cap=await sync.formatCapabilities();check(ctx);if(cap.cloudSyncExchangeV1!==true){await save(ctx,{version:1,identity:id,disabledUntil:Date.now()+300000});return null;}
   boot=await sync.bootstrap();check(ctx);id=identity(ctx);cache={version:1,identity:id,capabilities:{cloudSyncExchangeV1:true},boot,heads:[],trustTag:null,headsTag:null};
  }else{boot=cache.boot;heads=cache.heads;}
  function verify(){keyInfo=sync.resolveAccountKey(ctx.userId,id.deviceId,boot);if(keyInfo?.accountKey)keys.push(keyInfo.accountKey);check(ctx);if(!keyInfo||!keyInfo.accountKey||!Array.isArray(boot.devices)||!Array.isArray(boot.keyEnvelopes)||!Array.isArray(boot.keyCommitments))throw error('cloud_bootstrap_required');}
  try{verify();}catch(e){if(!usable)throw e;invalidate(ctx.userId,cachePath(ctx));boot=await sync.bootstrap();check(ctx);id=identity(ctx);cache={version:1,identity:id,capabilities:{cloudSyncExchangeV1:true},boot,heads:[],trustTag:null,headsTag:null};usable=false;verify();}
  ctx.contentGeneration=id.contentGeneration;ctx.cacheRevision=id.cacheRevision;
  if(typeof checkpoint==='function'){checkpoint=await checkpoint();check(ctx);}
  let resetRecords=!checkpoint.recordsGeneration,first=null,snapshotError=null,initialHeadsTag=null;
  let knownTrust=usable?cache.trustTag:null,knownHeads=usable?cache.headsTag:null,budget=131072;
  const conn={enabled:true,boot,heads,keyInfo,resetRecords,initial:null,cache,checkpoint,projectionValid:usable&&cache.projection?.headsTag===cache.headsTag&&cache.projection?.cursor===checkpoint.cursor};
  function query(after,state={},continuation=null,write=null){return requestBody({deviceId:id.deviceId,libraryEpoch:id.libraryEpoch,contentGeneration:id.contentGeneration,recordsGeneration:continuation?.recordsGeneration||state.recordsGeneration||null,after,ackAfter:after,verifiedCache:!!knownTrust,knownTrustTag:knownTrust,knownHeadsTag:knownHeads,maxResponseBytes:budget,...(continuation?{frozenHead:continuation.frozenHead,cursorFloor:continuation.cursorFloor}:{}),write});}
  async function send(after,state,continuation=null,write=null){check(ctx);const q=query(after,state,continuation,write);for(let attempt=0;;attempt++){
   try{const admission=write?await(ports.admissionHeaders||require('./cloud-overlay').admissionHeaders)():{};check(ctx);const response=await request({method:'POST',path:PATH,body:q,timeout:30000,extraHeaders:{...scopeStore.headers(ctx.userId),...scopeStore.contentHeaders(ctx.userId),...admission,'x-watchrss-cloud-device-id':id.deviceId}});check(ctx);return validate(response.data,q,id.publicKeySha256);}
   catch(e){check(ctx);if(e.status===413&&e.code==='cloud_exchange_budget_too_small'&&budget<262144&&attempt===0){budget=262144;q.maxResponseBytes=budget;continue;}
    const data=e.exchange||e.data;if(e.code==='cloud_record_conflict'&&data){e.exchangeData=validate(data,q,id.publicKeySha256,{conflict:true});}throw e;}
  }}
  async function metadata(data){check(ctx);
   if(data.keyVersionFloor!==boot.keyVersionFloor||data.device.keyVersion!==keyInfo.keyVersion||data.bootstrapRequired){
    // A tag is only a hint. Fetch and authenticate the entire chain again.
    boot=await sync.bootstrap();check(ctx);id=identity(ctx);verify();conn.projectionValid=false;delete cache.projection;
    if(boot.libraryEpoch!==data.libraryEpoch||boot.contentGeneration!==data.contentGeneration||boot.keyVersionFloor!==data.keyVersionFloor||keyInfo.keyVersion!==data.device.keyVersion)throw error('cloud_exchange_window_changed');
   }
   boot={...boot,member:data.member,contentGeneration:data.contentGeneration,contentEmpty:data.contentEmpty,contentClearedAt:data.contentClearedAt};
   scopeStore.observeContent(ctx.userId,data);check(ctx);
   if(data.headsRequired){try{heads=await sync.snapshotHeads();check(ctx);snapshotError=null;}catch(e){check(ctx);if(['NEEDS_RECOVERY','cloud_content_rebuild_required','client_upgrade_required'].includes(e.code))throw e;snapshotError=e;heads=[];}conn.projectionValid=false;delete cache.projection;}
   knownTrust=data.trustTag;knownHeads=snapshotError?null:data.headsTag;
   cache={...cache,identity:id,boot,heads,trustTag:knownTrust,headsTag:knownHeads};Object.assign(conn,{boot,heads,keyInfo,cache,snapshotError});
  }
  async function ready(data){await metadata(data);return data;}
  try{
   let after=resetRecords?'0':checkpoint.cursor,state=resetRecords?{}:checkpoint;
   for(let attempt=0;attempt<3;attempt++){
    let data;try{data=await send(after,state);}catch(e){if(['cloud_exchange_cursor_reset_required','cloud_exchange_records_reset_required'].includes(e.code)&&attempt<2){after='0';state={};resetRecords=true;continue;}if(e.code==='cloud_exchange_window_changed'&&attempt<2){await new Promise(resolve=>setTimeout(resolve,50*2**attempt+Math.floor(Math.random()*50)));check(ctx);continue;}throw e;}
    const refresh=data.bootstrapRequired||data.headsRequired;await ready(data);first=data;
    // Bind a freshly verified bootstrap/heads to a stable exchange confirmation.
    if(!refresh||snapshotError)break;if(attempt===2)throw error('cloud_exchange_window_changed');
   }
   if(knownTrust&&knownHeads)await save(ctx,cache);
  }catch(e){
   for(const key of keys)key.fill(0);
   if(e.status===404&&['cloud_exchange_disabled','not_found'].includes(e.code)){invalidate(ctx.userId,cachePath(ctx));await save(ctx,{version:1,identity:id,disabledUntil:Date.now()+300000});return null;}
   if(['cloud_device_not_registered','cloud_device_key_not_authorized'].includes(e.code)){invalidate(ctx.userId,cachePath(ctx));const fresh=await sync.bootstrap();check(ctx);return{enabled:false,boot:fresh};}
   invalidate(ctx.userId,cachePath(ctx));throw e;
  }
  enabled.add(cachePath(ctx));conn.close=()=>{ctx.exchangeClosed=true;for(const key of keys)key.fill(0);};
  initialHeadsTag=knownHeads;conn.resetRecords=resetRecords;conn.initial=first;
  conn.read=async(after,state,continuation=null)=>{let data;if(first&&first._exchangeAfter===after&&!continuation){data=first;first=null;}else{first=null;data=await send(after,state,continuation);await ready(data);}return data;};
  conn.write=(write,state)=>send(state.cursor,state,null,write);
  conn.offer=async(data)=>{await ready(data);first=data;};
  conn.conflict=async(data)=>{await ready(data);const union=new Map([...data.items,...data.conflictItems].map(r=>[r.recordId+':'+r.revision,r]));const missing=data.conflicts.some(c=>c.revision==='0'||!union.has(c.recordId+':'+c.revision));if(missing){first=null;return{reset:true,supplements:data.conflictItems};}first=data;return{supplements:data.conflictItems};};
  conn.markApplied=async(cursor)=>{if(snapshotError||initialHeadsTag!==knownHeads)return;cache.projection={version:1,cursor,headsTag:knownHeads};await save(ctx,cache);};
  conn.invalidate=()=>invalidate(ctx.userId,cachePath(ctx));
  handedOff=true;return conn;
  }finally{if(!handedOff)for(const key of keys)key.fill(0);}
 }
 function resetSession(){serial++;enabled.clear();saved.clear();}
 return{open,invalidate,resetSession,cachedEnabled};
}
// Debounce has a non-sliding deadline. A call during a flight gets its own next
// batch; all callers of one batch share one result, without overlapping writers.
function createScheduler({run,now=Date.now,schedule=setTimeout,cancel=clearTimeout,delay=250,maxWait=1000}){
 let pending=null,flight=null,timer=null,closed=false;
 function arm(){if(!pending||flight||closed)return;cancel(timer);timer=schedule(drain,Math.max(0,Math.min(pending.last+delay,pending.first+maxWait)-now()));}
 function drain(){timer=null;if(!pending||flight||closed)return;const batch=pending;pending=null;flight=Promise.resolve().then(()=>run(batch.options));flight.then(batch.resolve,batch.reject).finally(()=>{flight=null;arm();});}
 function enqueue(options={}){if(closed)return Promise.reject(error('cloud_operation_cancelled'));const at=now();if(!pending){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});pending={first:at,last:at,options,promise,resolve,reject};}else{pending.last=at;pending.options={...pending.options,...options};}const promise=pending.promise;if(options.force){pending.first=at-maxWait;pending.last=at-delay;}arm();return promise;}
 function close(){closed=true;cancel(timer);timer=null;if(pending)pending.reject(error('cloud_operation_cancelled'));pending=null;}
 return{enqueue,close};
}
let client;
function defaultClient(){return client||(client=createClient());}
module.exports={PATH,revision,compare,canonicalJSON,tag,requestBody,validate,createClient,createScheduler,open:(...args)=>defaultClient().open(...args),cachedEnabled:user=>defaultClient().cachedEnabled(user),resetSession:()=>{if(client)client.resetSession();}};
