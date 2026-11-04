// Offline only. Input/output are explicit; never emit book text or credentials.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const self=fileURLToPath(import.meta.url),cli=path.resolve(path.dirname(self),'..'),mini=path.resolve(cli,'../WatchRSS_WeChat'),MiB=1024*1024;
if(process.argv[2]!=='--worker'){
 const [inputArg,outArg]=process.argv.slice(2);if(!inputArg||!outArg||process.argv.length!==4)throw Error('Usage: node scripts/verify-import-parity.mjs INPUT OUTPUT_DIR');
 const input=path.resolve(inputArg),out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true,mode:0o700});fs.chmodSync(out,0o700);const rows=[];
 for(const mode of ['cli','mini']){
  const row=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--expose-gc','--max-old-space-size=96',self,'--worker',mode,input,out],{env:{...process.env,WATCHRSS_HOME:path.join(out,'cli-home')}});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>code?reject(Error(mode+' worker failed: '+stderr)):resolve(JSON.parse(stdout)));});rows.push(row);
 }
 const handles=rows.map(row=>fs.openSync(path.join(out,row.mode+'.package'),'r'));let comparedBytes=0;
 try{const buffers=[Buffer.alloc(65536),Buffer.alloc(65536)];while(true){const counts=handles.map((fd,i)=>fs.readSync(fd,buffers[i],0,buffers[i].length,null));assert.equal(counts[0],counts[1]);if(!counts[0])break;assert(buffers[0].subarray(0,counts[0]).equals(buffers[1].subarray(0,counts[1])));comparedBytes+=counts[0];}}
 finally{handles.forEach(fd=>fs.closeSync(fd));for(const row of rows)fs.rmSync(path.join(out,row.mode+'.package'),{force:true});fs.rmSync(path.join(out,'cli-home'),{recursive:true,force:true});}
 assert.equal(rows[0].packageSha256,rows[1].packageSha256);assert.equal(rows[0].bookId,rows[1].bookId);assert.equal(rows[0].chapters,rows[1].chapters);
 const result={runtime:process.version,inputBytes:fs.statSync(input).size,byteEqual:true,comparedBytes,productionChapterLimit:10000,method:'isolated 96 MiB V8 heap workers; product uploadFile + publishBookStream + snapshot encryption/ciphertext spooling + offline reserve/PUT/complete + local book commit; network forbidden; memory sampled every 5ms and all range reads/appends; packages compared in 64 KiB blocks and removed; mini uses Node filesystem wx mock, not device; unchanged product parser and limits',rows};
 fs.writeFileSync(path.join(out,'parity.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});process.stdout.write(JSON.stringify(result,null,2)+'\n');
}else{
 const [, , ,mode,input,out]=process.argv,require=createRequire(path.join(mode==='cli'?cli:mini,'package.json'));let env;
 if(mode==='mini')env=(await import(pathToFileURL(path.join(mini,'tests/stream-import-fixture.mjs')))).fixture();
 const load=name=>require(path.join(mode==='cli'?cli:mini,mode==='cli'?'lib':'miniprogram/lib',name));
 const storage=load('storage'),account=load('account'),http=load('http'),sync=load('sync'),files=load('import-files'),snapshot=load('snapshot'),crypto=load('crypto');
 // No public transport is reachable, even if a future importer adds a call.
 global.fetch=async()=>{throw Error('network forbidden');};for(const name of ['request','putObject','upload','download'])http[name]=async()=>{throw Error('network forbidden');};
 if(mode==='cli'){storage.setMode('hybrid');storage.writeJSON('session.json',{userId:'stream-synthetic',accessToken:'fixture'});storage.writeJSON('identity.json',{deviceId:'stream-device'});}
 account.getUsableSession=()=>({userId:'stream-synthetic',accessToken:'fixture'});sync.formatCapabilities=async()=>({streamImport:{enabled:true}});
 await crypto.initializeRandom();const metrics={maxRead:0,maxAppend:0,wholeReads:0};let baseline,peak;
 function sample(){if(!peak)return;for(const [key,value]of Object.entries(process.memoryUsage()))peak[key]=Math.max(peak[key],value);}
 const originalOpen=files.open;files.open=async(...args)=>{const source=await originalOpen(...args),read=source.read;source.read=async(a,b)=>{metrics.maxRead=Math.max(metrics.maxRead,b-a);const result=await read(a,b);sample();return result;};return source;};
 const originalStage=files.stage;files.stage=async(...args)=>{const stage=await originalStage(...args),writer=stage.writer;stage.writer=async(...args)=>{const result=await writer(...args),append=result.append;result.append=async bytes=>{metrics.maxAppend=Math.max(metrics.maxAppend,Math.min(bytes.length,files.BLOCK));await append(bytes);sample();};return result;};return stage;};
 files.readAll=async()=>{metrics.wholeReads++;throw Error('whole-file read forbidden');};
 const key=new Uint8Array(32).fill(3),records=load('cloud-records'),cloud=load('cloud-reader'),originalPublish=cloud.publishBookStream;
 let details,created,completes=0,puts=0;
 Object.assign(sync,{assertUploadOwner:()=>{},bootstrap:async()=>({devices:[]}),snapshotHeads:async()=>[],resolveAccountKey:()=>({accountKey:new Uint8Array(key),keyVersion:1}),getAccountKey:()=>new Uint8Array(key),registerDevice:async()=>{},ensureOwnDeviceEnvelope:async()=>{},loadState:()=>({}),nextSequence:()=>1,trustInfo:()=>({keyCommitments:[{keyVersion:1}]}),storeManifest:()=>{},
  reserveSnapshot:async made=>{created=made;sample();return{missingObjects:[{kind:'manifest',sha256:crypto.sha256Hex(made.encryptedManifest),sizeBytes:made.encryptedManifest.length},...snapshot.allChunks(made.manifest).map(c=>({kind:'chunk',sha256:c.ciphertextSha256,sizeBytes:c.ciphertextBytes}))]};},freshUploadUrl:async target=>target.sha256,completeSnapshot:async()=>{completes++;}});
 records.status=async()=>({enabled:true});records.push=async()=>({written:1});
 http.putObject=async(hash,bytes)=>{assert.equal(crypto.sha256Hex(bytes),hash);puts++;sample();};
 cloud.publishBookStream=async(prepared,...args)=>{
  const packed=prepared.package;fs.copyFileSync(packed.filePath,path.join(out,mode+'.package'));fs.chmodSync(path.join(out,mode+'.package'),0o600);sample();
  await originalPublish(prepared,...args);sample();assert.equal(completes,1);assert(puts>0);assert.deepEqual(created.newCiphertextChunks,{});
  fs.writeFileSync(path.join(out,mode+'.manifest.json'),JSON.stringify(created.manifest),{mode:0o600});
  const descriptor=created.manifest.objects.find(d=>d.privateBook);assert.equal(descriptor.originalBytes,packed.size);assert.equal(descriptor.contentSha256,packed.contentSha256);
  assert.equal(load('books').load().books[prepared.book.bookId].chapterCount,prepared.entries.length);
  assert.equal(load('library').listArticleViews().length,prepared.entries.length);
  details={packageBytes:packed.size,packageSha256:packed.contentSha256,bookId:prepared.book.bookId,chapters:prepared.entries.length,textChars:prepared.entries.reduce((sum,entry)=>sum+entry.chapter.chars,0),chunks:descriptor.chunks.length,manifestBytes:created.encryptedManifest.length,objects:created.manifest.objects.length,offlinePuts:puts,offlineCompletes:completes};
 };
 global.gc();baseline=process.memoryUsage();peak={...baseline};const timer=setInterval(sample,5),start=performance.now();
 try{await load('file-import').uploadFile(path.basename(input),input,()=>sample());sample();assert(details);assert(metrics.maxRead<=65536);assert.equal(metrics.wholeReads,0);assert(peak.heapUsed<96*MiB);assert(process.resourceUsage().maxRSS*1024<=256*MiB);const result={mode,productionAdmission:'accepted',...details,maxRssBytes:process.resourceUsage().maxRSS*1024,elapsedMs:Math.round(performance.now()-start),baseline,peak,delta:Object.fromEntries(Object.keys(peak).map(key=>[key,peak[key]-baseline[key]])),metrics,...(env?{miniIO:env.metrics}:{})};process.stdout.write(JSON.stringify(result)+'\n');}
 finally{clearInterval(timer);if(env)env.close();}
}
