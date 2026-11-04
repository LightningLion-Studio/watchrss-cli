const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util'),http=require('node:http');
const {randomBytes,createVerify,createCipheriv,hkdfSync}=require('node:crypto');
const runFile=promisify(execFile),home=fs.mkdtempSync(path.join(os.tmpdir(),'watchrss-cli-test-'));
process.env.WATCHRSS_HOME=home;
const storage=require('../lib/storage'),crypto=require('../lib/crypto'),device=require('../lib/device'),account=require('../lib/account'),sync=require('../lib/sync'),library=require('../lib/library'),records=require('../lib/cloud-records');
const userId='11111111-1111-4111-8111-111111111111',key=randomBytes(32),accessToken='wrp_test-session';
const epoch='11111111-2222-4333-8444-555555555555',generation='22222222-3333-4444-8555-666666666666';
function trust(){return {libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[{keyVersion:1,commitment:require('../lib/cloud-v2').commitment(key,userId,epoch,1),rotationProof:null}],contentGeneration:generation,contentEmpty:false,contentClearedAt:null};}
const wireReceived=[];const reservations=new Map();let expireNextRefresh=false,writeEnabled=false;
let member={plan:'member',active:true,readable:true,writable:true},revision=0,rows=new Map(),failWrite=false,challenge,received=[],consents=0,objects=new Map(),snapshots=new Map(),heads=[];
function seed(kind,value){const encoded=records.encode({userId,key,keyVersion:1,kind,value});rows.set(encoded.recordId,{...encoded,revision:String(++revision)});return encoded.recordId;}
const article={...library.defaultArticle('article-one'),url:'https://example.org/one',title:'First article',updatedAt:100,favoriteSaved:false};
async function cli(args,extra={}){try {const result=await runFile(process.execPath,[path.join(__dirname,'../bin/watchrss.cjs'),...args],{env:{...process.env,...extra}});return {exit:0,...result,data:JSON.parse(result.stdout)};}catch(e){return {exit:e.code,stdout:e.stdout,stderr:e.stderr,data:JSON.parse(e.stdout)};}}
function send(res,status,data){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}
test('CLI integration: real encrypted records, membership, retries and projections',async t=>{
 await crypto.initializeRandom();account.saveSession({userId,accessToken,expiresAt:Date.now()+3600000});
 const identity=device.loadOrCreate();
 seed('article',article);
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');const buffers=[];for await(const b of req)buffers.push(b);const bytes=Buffer.concat(buffers);
   const headerText=req.rawHeaders.reduce((s,v,i)=>s+(i%2?v+'\r\n':v+': '),''),wire={path:url.pathname,method:req.method,bytes:bytes.length,headerBytes:Buffer.byteLength(req.method+' '+req.url+' HTTP/1.1\r\n'+headerText+'\r\n'),responseBodyBytes:0};wireReceived.push(wire);const end=res.end;res.end=function(data,...args){if(data)wire.responseBodyBytes+=Buffer.isBuffer(data)?data.length:Buffer.byteLength(data);return end.call(this,data,...args);};
   if(url.pathname.startsWith('/objects/')){
    assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.apikey,undefined);
    const sha=url.pathname.slice('/objects/'.length);
    if(req.method==='PUT'){assert.equal(crypto.sha256Hex(bytes),sha);objects.set(sha,bytes);res.writeHead(200);res.end();return;}
    const data=objects.get(sha);if(!data){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':'application/octet-stream'});res.end(data);return;
   }
   const raw=bytes.toString('utf8'),body=raw&&req.method!=='PUT'?JSON.parse(raw):{};
   received.push({path:url.pathname,method:req.method,raw,bytes:bytes.length});
   if(url.pathname.endsWith('/account/logout')){assert.equal(req.headers['x-watchrss-library-epoch'],epoch);return send(res,200,{revoked:true});}
   if(url.pathname.endsWith('/account/entitlement'))return send(res,200,member);
   if(url.pathname.endsWith('/phone-authorizations/challenge')){challenge={challengeId:'22222222-2222-4222-8222-222222222222',nonce:'test-nonce'};return send(res,200,challenge);}
   if(url.pathname.endsWith('/account/cli/access')){
    const requestHash=crypto.sha256LengthPrefixedHex(['cli-access',body.licenseDeviceId,body.devicePublicKey,crypto.sha256Hex(accessToken)]);
    const message=['watchrss-device-possession-v1','claim',challenge.challengeId,challenge.nonce,identity.deviceId,requestHash].join('\n');
    const verify=createVerify('SHA256');verify.update(message);assert.equal(verify.verify(body.devicePublicKey,Buffer.from(body.possession.signature,'base64url')),true);
    return send(res,200,{cliAccessToken:'wrc_test',expiresAt:Date.now()+3600000});
   }
   if(req.headers['x-watchrss-cli-authorization']!=='Bearer wrc_test')return send(res,403,{error:'cli_access_invalid'});
   if(url.pathname.endsWith('/cloud/bootstrap'))return send(res,200,{...trust(),member,devices:[{deviceId:identity.deviceId,lastSequence:heads[0]?.deviceSequence||0,capabilities:{rssRecordsVersion:1}}],keyEnvelopes:[{recipientType:'device',recipientDeviceId:identity.deviceId,envelope:require('../lib/envelope').createDeviceEnvelope({accountKey:key,userId,recipientDeviceId:identity.deviceId,recipientPublicKeyUncompressed:sync.getDeviceKeyPair(userId,identity.deviceId).publicKeyUncompressed,keyVersion:1})}]});
   if(url.pathname.endsWith('/snapshots/heads'))return send(res,200,{...trust(),heads,nextOffset:null});
   if(require('../lib/cloud-write').epochWrite({method:req.method,path:url.pathname}))assert.equal(req.headers['x-watchrss-library-epoch'],epoch);
   if(url.pathname.endsWith('/revoke'))return send(res,200,{revoked:true});
   if(req.method!=='GET'&&/\/cloud\/(records|snapshots|uploads)/.test(url.pathname)){assert.equal(req.headers['x-watchrss-library-epoch'],epoch);assert.equal(req.headers['x-watchrss-content-generation'],generation);}
   if(url.pathname.endsWith('/format-capabilities'))return send(res,200,{protocol:'watchrss-content-evolution',version:1,phaseA:{cloudFormatR48ReadV1:true,cloudFormatR48WriteV1:writeEnabled}});
   if(url.pathname.endsWith('/refresh')){if(expireNextRefresh){expireNextRefresh=false;return send(res,404,{error:'upload_reservation_not_found'});}const id=url.pathname.split('/').at(-2),r=reservations.get(id);if(!r)return send(res,404,{error:'upload_reservation_not_found'});if(r.requiredR48)assert.equal(req.headers['x-watchrss-r48-write-v1'],'1');return send(res,200,{reservationId:id,transport:'epoch-proxy',alreadyUploaded:objects.has(r.sha256)});}
   if(req.method==='PUT'&&url.pathname.includes('/cloud/uploads/')){const r=reservations.get(url.pathname.split('/').pop());if(!r)return send(res,404,{error:'upload_reservation_not_found'});if(r.requiredR48)assert.equal(req.headers['x-watchrss-r48-write-v1'],'1');assert.equal(crypto.sha256Hex(bytes),r.sha256);objects.set(r.sha256,bytes);return send(res,200,{});}
   if(url.pathname.endsWith('/snapshots/reserve')){assert.equal(body.contentLayout,3);if(writeEnabled)assert.equal(req.headers['x-watchrss-r48-write-v1'],'1');
    const targets=[{kind:'manifest',sha256:body.manifest.sha256,sizeBytes:body.manifest.sizeBytes},...body.chunks.map(c=>({...c,kind:'chunk'}))].filter(t=>!objects.has(t.sha256)).map(t=>(()=>{const reservationId=require('node:crypto').randomUUID();reservations.set(reservationId,{...t,requiredR48:req.headers['x-watchrss-r48-write-v1']==='1'});return {...t,reservationId,transport:'epoch-proxy'};})());
    snapshots.set(body.snapshotId,{request:body,requiredR48:req.headers['x-watchrss-r48-write-v1']==='1',head:{id:body.snapshotId,sourceDeviceId:body.sourceDeviceId,deviceSequence:body.deviceSequence,keyVersion:body.keyVersion,manifestSha256:body.manifest.sha256,manifestSizeBytes:body.manifest.sizeBytes,completedAt:new Date().toISOString()}});
    return send(res,200,{snapshotId:body.snapshotId,missingObjects:targets});
   }
   if(url.pathname.endsWith('/snapshots/complete')){
    const snap=snapshots.get(body.snapshotId);if(snap.requiredR48)assert.equal(req.headers['x-watchrss-r48-write-v1'],'1');assert(objects.has(snap.head.manifestSha256));for(const sha of body.chunkHashes)assert(objects.has(sha));heads=[snap.head];return send(res,200,{});
   }
   if(/\/snapshots\/[^/]+$/.test(url.pathname)){
    const snap=snapshots.get(url.pathname.split('/').pop());if(!snap)return send(res,404,{error:'not_found'});
    return send(res,200,{snapshot:{...snap.head,manifestSignedUrl:process.env.WATCHRSS_URL+'/objects/'+snap.head.manifestSha256},chunks:snap.request.chunks.map(c=>({...c,signedUrl:process.env.WATCHRSS_URL+'/objects/'+c.sha256}))});
   }
   if(url.pathname.endsWith('/key-envelopes')||url.pathname.endsWith('/devices/register'))return send(res,200,{});
   if(url.pathname.endsWith('/records/consent')){consents++;return send(res,200,{formatVersion:1});}
   if(url.pathname.endsWith('/cloud/records')){
    if(req.method==='GET'){const after=BigInt(url.searchParams.get('after')||'0');const pending=[...rows.values()].filter(r=>BigInt(r.revision)>after).sort((a,b)=>Number(a.revision)-Number(b.revision)),items=pending.slice(0,Number(url.searchParams.get('limit')||50)),hasMore=pending.length>items.length;return send(res,200,{...trust(),formatVersion:1,items,cursor:hasMore?items.at(-1).revision:String(revision),headRevision:String(revision),hasMore});}
    if(failWrite)return send(res,503,{error:'unavailable'});
    for(const item of body.items){const previous=rows.get(item.recordId);if(item.expectedRevision!==(previous?.revision||'0'))return send(res,409,{error:'cloud_record_conflict'});}
    const items=body.items.map(item=>{records.decode({userId,key,recordId:item.recordId,envelope:item.envelope});const row={...item,revision:String(++revision)};rows.set(row.recordId,row);return {recordId:row.recordId,revision:row.revision};});return send(res,200,{formatVersion:1,items});
   }
   if(url.pathname.endsWith('/sources/resolve'))return send(res,200,{source:{id:'source-1',url:body.url,title:'Example'}});
   if(url.pathname.includes('/sources/source-1/entries'))return send(res,200,{entries:[{link:'https://example.org/rss',title:'RSS entry',contentText:'PRIVATE BODY CACHE',publishedAt:'2026-01-01T00:00:00Z'}],nextCursor:null});
   return send(res,404,{error:'not_found'});
  }catch(e){send(res,500,{error:e.message});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));process.env.WATCHRSS_URL=`http://127.0.0.1:${server.address().port}`;require('../config').backendBaseUrl=process.env.WATCHRSS_URL;
 try{
  await t.test('noninteractive login fails without exposing credentials',async()=>{const r=await cli(['--login']);assert.equal(r.data.error.code,'tty_required');assert(!r.stdout.includes(accessToken));});
  await t.test('encrypted metadata pull and no implicit format consent',async()=>{const r=await cli(['articles','list']);assert.equal(r.exit,0,r.stdout);assert.equal(r.data.data.items[0].title,'First article');assert.equal(consents,0);});
  await t.test('favorite persists across separate CLI processes',async()=>{const before=received.length;const r=await cli(['articles','favorite','article-one']);assert.equal(r.exit,0,r.stdout);const calls=received.slice(before);assert.equal(calls.filter(c=>c.path.endsWith('/account/entitlement')).length,1);assert.equal(calls.filter(c=>c.path.endsWith('/cloud/bootstrap')).length,1);const list=await cli(['articles','list','--favorite']);assert.equal(list.data.data.total,1);const remote=[...rows.values()].map(r=>records.decode({userId,key,recordId:r.recordId,envelope:r.envelope}));assert(remote.some(d=>d.value.articleId==='article-one'&&d.value.favoriteSaved));});
  await t.test('failed remote write keeps durable intent, subsequent sync replays it',async()=>{const local=await cli(['--defer','articles','later','article-one']);assert.equal(local.exit,0,local.stdout);failWrite=true;const r=await cli(['sync']);assert.equal(r.exit,1,r.stdout);const pending=(storage.setNamespace('hybrid'),storage.readMap(require('../lib/cloud-scope').path('operations',userId),{}));assert(Object.values(pending).some(i=>i.kind==='watchLater'));failWrite=false;const next=await cli(['sync']);assert.equal(next.exit,0,next.stdout);assert.deepEqual((storage.setNamespace('hybrid'),storage.readMap(require('../lib/cloud-scope').path('operations',userId),{})),{});});
  await t.test('progress intent survives a failed CAS round and sync before the next command',async()=>{let r=await cli(['--defer','articles','progress','article-one','0.73']);assert.equal(r.exit,0,r.stdout);failWrite=true;r=await cli(['sync']);assert.equal(r.exit,1,r.stdout);failWrite=false;r=await cli(['sync']);assert.equal(r.exit,0,r.stdout);r=await cli(['articles','list']);assert.equal(r.data.data.items.find(a=>a.articleId==='article-one').readingProgress,0.73);});
  await t.test('deferred local progress reuses its owner-bound member cache and sends zero requests',async()=>{const before=received.length;const r=await cli(['--defer','articles','progress','article-one','0.7']);assert.equal(r.exit,0,r.stdout);assert.equal(received.length,before);});
  await t.test('hybrid offline reads and changes use bounded member cache without network',async()=>{
   const before=received.length;
   let r=await cli(['--offline','articles','list']);assert.equal(r.exit,0,r.stdout);
   r=await cli(['--offline','articles','favorite','article-one','false']);assert.equal(r.exit,0,r.stdout);assert.equal(r.data.data.pending,true);assert.equal(received.length,before);
   const cached=storage.readJSON('membership-cache.json');storage.writeJSON('membership-cache.json',{...cached,validUntil:Date.now()-1});r=await cli(['--offline','articles','list']);assert.equal(r.data.error.code,'membership_check_required');storage.writeJSON('membership-cache.json',cached);
   r=await cli(['sync']);assert.equal(r.exit,0,r.stdout);
  });
  await t.test('read-only and expired membership reject even cached reads',async()=>{const before=received.length;member={...member,writable:false};const r=await cli(['articles','list']);assert.equal(r.exit,1);assert.equal(r.data.error.code,'cloud_membership_required');assert.equal(received.length,before+1);member.writable=true;});
  await t.test('hybrid retains RSS bodies and cloud persists metadata only',async()=>{
   let r=await cli(['sources','add','https://example.org/feed']);assert.equal(r.exit,0,r.stdout);
   assert(!fs.readFileSync(path.join(home,'modes/hybrid/lib/articles.json'),'utf8').includes('PRIVATE BODY CACHE'));assert(fs.readdirSync(path.join(home,'modes/hybrid/cache/rss-bodies')).some(n=>n.endsWith('.json')&&n!=='index.json'));
   r=await cli(['--mode','cloud','sources','refresh','https://example.org/feed']);assert.equal(r.exit,0,r.stdout);
   const cloudFiles=fs.readdirSync(path.join(home,'modes/cloud/lib'));for(const name of cloudFiles)if(name.endsWith('.json'))assert(!fs.readFileSync(path.join(home,'modes/cloud/lib',name),'utf8').includes('PRIVATE BODY CACHE'));
  });
  await t.test('queued source pin rebases on server original/order fields despite newer local whole-source timestamp',async()=>{const url='https://example.org/feed';const before=JSON.parse(fs.readFileSync(path.join(home,'modes/hybrid/lib/sources.json'),'utf8')).find(s=>s.url===url);seed('source',{...before,useOriginalContent:true,sortOrder:42,updatedAt:Date.now()-100});let r=await cli(['--defer','sources','pin',url,'true']);assert.equal(r.exit,0,r.stdout);r=await cli(['sync']);assert.equal(r.exit,0,r.stdout);r=await cli(['sources','list']);assert.equal(r.exit,0,r.stdout);const actual=r.data.data.find(s=>s.url===url);assert(actual.isPinned);assert(actual.useOriginalContent);assert.equal(actual.sortOrder,42);});
  await t.test('a newer local state repairs an older remote rewrite even when pull changes no local view',async()=>{let r=await cli(['articles','favorite','article-one','true']);assert.equal(r.exit,0,r.stdout);seed('article',{...article,favoriteSaved:false,favoriteChangedAt:1,updatedAt:1});r=await cli(['sync']);assert.equal(r.exit,0,r.stdout);const values=[...rows.values()].map(row=>records.decode({userId,key,recordId:row.recordId,envelope:row.envelope}));assert(values.some(v=>v.kind==='article'&&v.value.articleId==='article-one'&&v.value.favoriteSaved));});
  await t.test('an unexpected uncoded shared-channel failure never masquerades as successful CLI sync',async()=>{
   const probe=path.join(home,'channel-failure.cjs');fs.writeFileSync(probe,`require(${JSON.stringify(path.resolve(__dirname,'../lib/cloud-records'))}).pull=async()=>{throw new Error('synthetic uncoded failure');};`);
   const r=await cli(['sync'],{NODE_OPTIONS:'--require='+probe});assert.equal(r.exit,1,r.stdout);assert.equal(r.data.error.code,'cloud_record_failed');
  });
  await t.test('5200 paged RSS states apply in one durable projection before cursor; metadata sync never refreshes 200 feeds',async()=>{
   const sourceId=require('../lib/rss-source-key').sourceKey('https://example.org/feed');
   for(let i=0;i<5200;i++)seed('rss-state',{sourceId,articleIdHash:crypto.sha256Hex('large-state-'+i),sourceDeviceId:'fixture',readingProgress:0.2,readingPositionChangedAt:100});
   const probe=path.join(home,'rss-probe.cjs'),receipt=path.join(home,'rss-probe.json');
   fs.writeFileSync(probe,`const fs=require('node:fs'),lib=require(${JSON.stringify(path.resolve(__dirname,'../lib/library'))});const original=lib.applyRssInteractions,sizes=[];lib.applyRssInteractions=function(states=[]){sizes.push(states.length);return original(states);};process.on('exit',()=>fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(sizes)));`);
   const before=received.length,r=await cli(['sync'],{NODE_OPTIONS:'--require='+probe});assert.equal(r.exit,0,r.stdout);
   assert.deepEqual(JSON.parse(fs.readFileSync(receipt)),[5200]);
   assert.equal(received.slice(before).filter(c=>c.path.endsWith('/sources/resolve')).length,0);
   const noPush=path.join(home,'noop-no-push.cjs');fs.writeFileSync(noPush,`require(${JSON.stringify(path.resolve(__dirname,'../lib/cloud-records'))}).push=async()=>{throw new Error('Noop attempted full projection hash');};`);const again=await cli(['sync'],{NODE_OPTIONS:'--require='+noPush});assert.equal(again.exit,0,again.stdout);
  });
  await t.test('hybrid imported book exposes a seekable local scan to the real reader',async()=>{
   const file=path.join(home,'hybrid-local-scan.txt'),text='LOCAL SCAN REGRESSION 中文🙂 '+('Synthetic local reader paragraph. '.repeat(1000));fs.writeFileSync(file,text);
   let r=await cli(['--mode','hybrid','import',file]);assert.equal(r.exit,0,r.stdout);
   const id=r.data.data.result.articleId;
   r=await cli(['--mode','hybrid','articles','get',id]);assert.equal(r.exit,0,r.stdout);assert(r.data.data.text.startsWith('LOCAL SCAN REGRESSION 中文🙂'));
  });
  await t.test('TXT import encrypts snapshot uploads and cloud reads the uploaded text',async()=>{
   const file=path.join(home,'fixture.txt'),text='SECRET IMPORTED BODY 这是端到端加密的正文。';fs.writeFileSync(file,text);
   let r=await cli(['--mode','cloud','import',file]);assert.equal(r.exit,0,r.stdout);const id=r.data.data.result.articleId;assert(id);assert(heads.length);
   r=await cli(['--mode','cloud','articles','get',id]);assert.equal(r.exit,0,r.stdout);assert.equal(r.data.data.text,text);
   for(const data of objects.values())assert(!data.includes(Buffer.from('SECRET IMPORTED BODY')));
   const data=fs.readFileSync(path.join(home,'modes/cloud/lib/articles.json'),'utf8');assert(!data.includes('SECRET IMPORTED BODY'));
  });
  await t.test('lost reservation on import reserves a new snapshot and never trusts the first PUT plan',async()=>{const before=snapshots.size;expireNextRefresh=true;const file=path.join(home,'retry.txt');fs.writeFileSync(file,'SECOND SYNTHETIC IMPORT AFTER RESERVATION LOSS');const r=await cli(['--mode','cloud','import',file]);assert.equal(r.exit,0,r.stdout);assert(snapshots.size>=before+2);assert.equal(expireNextRefresh,false);});
  await t.test('EPUB imports chapters and preserves prior encrypted reader objects',async()=>{
   const zip=require('../vendor/fflate-browser'),file=path.join(home,'fixture.epub');
   const entries={'META-INF/container.xml':'<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>','OEBPS/content.opf':'<package><metadata><dc:title>Test Book</dc:title></metadata><manifest><item id="c1" href="one.xhtml"/><item id="c2" href="two.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>','OEBPS/one.xhtml':'<html><body><h1>Chapter One</h1><p>PRIVATE EPUB FIRST</p></body></html>','OEBPS/two.xhtml':'<html><body><h1>Chapter Two</h1><p>PRIVATE EPUB SECOND</p></body></html>'};
   fs.writeFileSync(file,zip.zipSync(Object.fromEntries(Object.entries(entries).map(([k,v])=>[k,Buffer.from(v)]))));
   let r=await cli(['--mode','cloud','import',file]);assert.equal(r.exit,0,r.stdout);const book=r.data.data.result.bookSourceUrl;assert(book);
   r=await cli(['--mode','cloud','books','list']);assert.equal(r.exit,0,r.stdout);assert(r.data.data.some(s=>s.url===book));
   r=await cli(['--mode','cloud','articles','list','--source',book]);assert.equal(r.data.data.total,2);const id=r.data.data.items[1].articleId;
   r=await cli(['--mode','cloud','articles','get',id]);assert.equal(r.exit,0,r.stdout);assert(r.data.data.text.includes('PRIVATE EPUB SECOND'));
   const manifest=require('../lib/snapshot').decryptManifest(key,heads[0].id,new Uint8Array(objects.get(heads[0].manifestSha256)));
   assert(manifest.objects.some(o=>o.name==='private-library.wrss'||o.name.startsWith('books/')));
  });
  await t.test('cloud rejects deferred operations',async()=>{const r=await cli(['--mode','cloud','--defer','sync']);assert.equal(r.exit,1);assert.equal(r.data.error.code,'invalid_argument');});
  await t.test('malformed booleans rejected',async()=>{const r=await cli(['articles','favorite','article-one','no']);assert.equal(r.exit,1);assert.equal(r.data.error.code,'invalid_argument');});
  await t.test('member account switch cannot see first account projection',async()=>{
   const saved=storage.readJSON('session.json');account.saveSession({...saved,userId:'other-user'});
   // Local projections are isolated even before network pull.
   storage.setNamespace('hybrid');library.resetOwner();assert.equal(library.listArticleViews().length,0);storage.setNamespace('');account.saveSession(saved);
  });

  await t.test('WriteV1 Node production publisher TCP wire budget, 2000 articles plus prior R44 books, gated default and kill switch',async()=>{
   const snapshot=require('../lib/snapshot'),zip=require('../vendor/fflate-browser'),recipe=require('./fixtures/r48-write-v1/budget-recipe.json').recipe;
   storage.setNamespace('cloud');const previous=snapshot.decryptManifest(key,heads[0].id,new Uint8Array(objects.get(heads[0].manifestSha256))),files={},bodyText=recipe.bodyUtf8.repeat(recipe.bodyRepeats),articles=[];
   for(let i=0;i<2000;i++){const id=recipe.articleIdPrefix+i,name='bodies/'+crypto.sha256Hex(id)+'.txt';articles.push({...library.defaultArticle(id),url:'https://example.org/budget/'+i,title:id,excerpt:'available cached summary',contentHash:crypto.sha256Hex(bodyText),importedAt:0,updatedAt:0,contentTextEntry:name});files[name]=Buffer.from(bodyText);}
   Object.assign(files,{'manifest.json':Buffer.from('{"format":"watchrss-library-backup","version":3,"cloudContentOnly":true}'),'articles.json':Buffer.from(JSON.stringify(articles)),'sources.json':Buffer.from('[]'),'saved_items.json':Buffer.from('[]')});const archive=zip.zipSync(files,{level:0}),seeded=await snapshot.create({accountKey:key,keyVersion:1,sourceDeviceId:identity.deviceId,deviceSequence:heads[0].deviceSequence+1,previousManifest:previous,carryForwardObjects:previous.objects,logicalObjects:[{name:'private-library.wrss',bytes:archive,compress:false}]});
   for(const [hash,bytes]of Object.entries(seeded.newCiphertextChunks))objects.set(hash,Buffer.from(bytes));const manifestHash=crypto.sha256Hex(seeded.encryptedManifest);objects.set(manifestHash,Buffer.from(seeded.encryptedManifest));const request={chunks:snapshot.allChunks(seeded.manifest).map(c=>({sha256:c.ciphertextSha256,sizeBytes:c.ciphertextBytes}))},head={id:seeded.manifest.snapshotId,sourceDeviceId:identity.deviceId,deviceSequence:seeded.manifest.deviceSequence,keyVersion:1,manifestSha256:manifestHash,manifestSizeBytes:seeded.encryptedManifest.length,completedAt:new Date().toISOString()};snapshots.set(head.id,{head,request});heads=[head];
   let r;
   const probe=path.join(home,'r48-publish.cjs'),libRoot=path.resolve(__dirname,'../lib');
   fs.writeFileSync(probe,`const root=${JSON.stringify(libRoot)};const storage=require(root+'/storage');storage.setMode('cloud');storage.setNamespace('cloud');const crypto=require(root+'/crypto'),library=require(root+'/library'),reader=require(root+'/cloud-reader'),account=require(root+'/account');(async()=>{await crypto.initializeRandom();const input=JSON.parse(process.argv[2]);let book={entries:[]},options={};if(input.article)book.entries=[{article:{...library.defaultArticle(input.article.articleId),...input.article},text:input.text}];if(input.delete){if(require(root+'/cloud-overlay').localEnabled())options.overlayDeletions=[{kind:'article',id:input.delete,changedAt:input.changedAt}];else options.removePrefixes=['reader/'+crypto.sha256Hex(input.delete).slice(0,32)+'/'];}await reader.publish(null,'',null,account.getUsableSession().userId,false,null,book,()=>{},options);})().catch(e=>{process.stderr.write(JSON.stringify({code:e.code,message:e.message}));process.exitCode=1;});`);
   const measurements=[];
   async function publish(id,input){const start=performance.now(),before=wireReceived.length;await runFile(process.execPath,[probe,JSON.stringify(input)],{env:process.env});const calls=wireReceived.slice(before),writes=calls.filter(c=>c.method==='POST'||c.method==='PUT'),puts=calls.filter(c=>c.method==='PUT');measurements.push({id,elapsedMs:Math.round(performance.now()-start),requests:calls.length,writeRequests:writes.length,upstreamBytes:calls.reduce((n,c)=>n+c.bytes,0),httpHeaderBytes:calls.reduce((n,c)=>n+c.headerBytes,0),downloadBodyBytes:calls.reduce((n,c)=>n+c.responseBodyBytes,0),putBytes:puts.reduce((n,c)=>n+c.bytes,0),putRequests:puts.length});const m=snapshot.decryptManifest(key,heads[0].id,new Uint8Array(objects.get(heads[0].manifestSha256)));assert.deepEqual(m.objects.find(d=>d.name==='private-library.wrss').chunks,seeded.manifest.objects.find(d=>d.name==='private-library.wrss').chunks);assert(m.objects.length<20);}
   const a={articleId:'wire-add',url:'https://example.org/wire-add',title:'wire add',contentText:bodyText,contentHtml:'',contentHash:crypto.sha256Hex(bodyText),updatedAt:100};
   const b={...a,articleId:articles[1].articleId,url:articles[1].url,contentText:bodyText+'edited',contentHash:crypto.sha256Hex(bodyText+'edited'),updatedAt:101};
   await publish('add-one',{article:a,text:bodyText});await publish('edit-one',{article:b,text:b.contentText});await publish('delete-one',{delete:articles[2].articleId,changedAt:102});await publish('favorite-membership-change',{delete:a.articleId,changedAt:103});await publish('favorite-clock-only',{article:{...b,favoriteSaved:true,favoriteChangedAt:104,favoriteSortOrder:105},text:b.contentText});const phaseABaseline=measurements.splice(0);heads=[head];r=await cli(['--mode','cloud','format-write','enable']);assert.equal(r.exit,0,r.stdout);assert.equal(r.data.data.localWriteOptIn,true);writeEnabled=true;
   await publish('add-one',{article:a,text:bodyText});await publish('edit-one',{article:b,text:b.contentText});await publish('delete-one',{delete:articles[2].articleId,changedAt:102});await publish('favorite-membership-change',{delete:a.articleId,changedAt:103});await publish('favorite-clock-only',{article:{...b,favoriteSaved:true,favoriteChangedAt:104,favoriteSortOrder:105},text:b.contentText});
   for(const row of measurements.slice(0,4))assert(row.upstreamBytes<32768,JSON.stringify(row));assert.equal(measurements.at(-1).putBytes,0);
   writeEnabled=false;const published=heads[0].id;await assert.rejects(runFile(process.execPath,[probe,JSON.stringify({article:{...a,updatedAt:110,contentText:'disabled'},text:'disabled'})],{env:process.env}),e=>e.stderr.includes('cloud_format_write_disabled'));assert.equal(heads[0].id,published);
   const paused=path.join(home,'paused-writer.cjs');fs.writeFileSync(paused,`require(${JSON.stringify(libRoot+'/cloud-reader')}).syncSaved=async()=>{throw Object.assign(Error('writer paused'),{code:'cloud_format_write_disabled'});};`);
   seed('article',{...b,independentSaved:true,independentChangedAt:106});
   r=await cli(['--mode','cloud','articles','get',b.articleId],{NODE_OPTIONS:'--require='+paused});assert.equal(r.exit,0,r.stdout);assert(r.data.data.text.includes(bodyText.slice(0,24)));assert(r.stderr.includes('cloud-write-paused'));assert.equal(heads[0].id,published);
   r=await cli(['--mode','cloud','format-write','disable']);assert.equal(r.exit,0,r.stdout);assert.equal(r.data.data.localWriteOptIn,false);
   const evidence={scale:{articles:2000,books:previous.objects.filter(d=>d.privateBook).length},legacyArchiveBytes:archive.length,transport:'real Node HTTP/TCP with protocol fixture server; not Rust backend or worker',phaseABaseline,measurements};console.log('[writev1-wire-budget]',JSON.stringify(evidence));if(process.env.WRSS_R48_WIRE_BUDGET_OUTPUT)fs.writeFileSync(process.env.WRSS_R48_WIRE_BUDGET_OUTPUT,JSON.stringify(evidence,null,2));storage.setNamespace('');
  });
  await t.test('no plaintext bodies or account keys in HTTP payloads',async()=>{for(const req of received)if(req.path.includes('/cloud/')){assert(!req.raw.includes('PRIVATE BODY CACHE'));assert(!req.raw.includes(key.toString('base64')));}});
  await t.test('logout revokes the cloud device with epoch before revoking the account session',async()=>{const before=received.length,r=await cli(['logout']);assert.equal(r.exit,0,r.stdout);const calls=received.slice(before);assert(calls.some(c=>c.path.endsWith('/revoke')));assert(calls.some(c=>c.path.endsWith('/account/logout')));assert(!fs.existsSync(path.join(home,'session.json')));});
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(home,{recursive:true,force:true});}
});
test('record ciphertext is identity bound and rejects tampering',()=>{const r=records.encode({userId,key,keyVersion:1,kind:'article',value:article});assert.throws(()=>records.decode({userId:'other-user',key,recordId:r.recordId,envelope:r.envelope}));const tampered={...r.envelope,ciphertextBase64:Buffer.alloc(50).toString('base64')};assert.throws(()=>records.decode({userId,key,recordId:r.recordId,envelope:tampered}));});
test('HKDF and AES-GCM agree with Node crypto',()=>{const salt=randomBytes(16),nonce=randomBytes(12),data=Buffer.from('watchrss 中文');assert.deepEqual(Buffer.from(crypto.hkdfSha256(key,salt,'interop',32)),Buffer.from(hkdfSync('sha256',key,salt,'interop',32)));const c=createCipheriv('aes-256-gcm',key,nonce);c.setAAD(data);const ref=Buffer.concat([c.update(data),c.final(),c.getAuthTag()]);assert.deepEqual(Buffer.from(crypto.aesGcmEncrypt(key,nonce,data,data)),ref);});
