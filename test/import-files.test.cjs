const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'clirepin-'));process.env.WATCHRSS_HOME=home;
const files=require('../lib/import-files'),storage=require('../lib/storage');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
test('Node range reads reject truncation and rollback admission precedes reading',async()=>{
 const file=path.join(home,'input');fs.writeFileSync(file,Buffer.alloc(70000,97));const input=await files.open(file);
 try{assert.equal((await input.read(0,65536)).length,65536);await assert.rejects(input.read(0,65537),/范围/);fs.truncateSync(file,10);await assert.rejects(input.read(0,100),/改变/);}finally{await input.close();}
 await assert.rejects(input.read(0,1),/范围/);fs.writeFileSync(file,'rollback');await assert.rejects(files.readAll(file,3),/8 MB/);assert.equal(Buffer.from(await files.readAll(file,8)).toString(),'rollback');
});
test('Node staging is private, bounded, operation-owned and cleans failures',async()=>{
 const abandoned=storage.location('tmp/stream-import/import-old001');fs.mkdirSync(abandoned,{recursive:true});fs.writeFileSync(path.join(abandoned,'private'),'stale');
 const a=await files.stage(),b=await files.stage();
 try{assert(!fs.existsSync(abandoned));assert(fs.existsSync(a.root));for(const dir of [a.root,b.root,path.dirname(a.root)])assert.equal(fs.statSync(dir).mode&0o777,0o700);
  await assert.rejects(a.writer('..'),/Invalid/);const data=Buffer.alloc(180000,123);await a.put('ciphertext',data);assert.equal(fs.statSync(a.path('ciphertext')).mode&0o777,0o600);assert.deepEqual(Buffer.from(await a.get('ciphertext')),data);
  await a.put('package',Buffer.from('keep'));await a.release();assert.deepEqual(fs.readdirSync(a.root),['package']);await a.remove('package');assert.deepEqual(fs.readdirSync(a.root),[]);
  storage.setMode('hybrid');const writer=await a.writer('package');await writer.append(Buffer.from('complete package'));files.commit(writer.filePath,'lib/books/test.jsonl');assert.equal(fs.readFileSync(storage.location('lib/books/test.jsonl'),'utf8'),'complete package');assert.equal(fs.statSync(storage.location('lib/books/test.jsonl')).mode&0o777,0o600);
  storage.setMode('cloud');await a.put('cloud-package',Buffer.from('private cloud body'));files.commit(a.path('cloud-package'),'lib/books/cloud.jsonl');assert(!fs.existsSync(storage.location('lib/books/cloud.jsonl')));assert(!fs.existsSync(a.path('cloud-package')));
  const original=fs.promises.appendFile;try{fs.promises.appendFile=async()=>{throw Object.assign(Error('ENOSPC'),{code:'ENOSPC'});};await assert.rejects(a.put('failed',Buffer.from('original')),error=>error.code==='local_storage_full');}finally{fs.promises.appendFile=original;}
 }finally{storage.setMode('hybrid');await a.close();await b.close();}
 assert(!fs.existsSync(a.root));await assert.rejects(a.writer('after-close'),/取消/);
});
test('Node preflight uses actual filesystem space and preserves local originals',async()=>{
 const space=require('../lib/import-space'),statfs=fs.promises.statfs,file=path.join(home,'original.txt');fs.writeFileSync(file,'original');
 try{fs.promises.statfs=async()=>({bavail:0,bsize:4096,blocks:100,bfree:0});await assert.rejects(space.preflight('book.txt',100,require('../lib/import-policy').DEFAULTS),e=>e.code==='local_storage_full'&&e.requiredBytes>0);assert.equal(fs.readFileSync(file,'utf8'),'original');}
 finally{fs.promises.statfs=statfs;}
 assert((await space.preflight('book.txt',100,require('../lib/import-policy').DEFAULTS)).availableBytes>0);
});
test('watchrss import dispatches >8 MiB to streaming and remote-off restores legacy admission',()=>{
 const dir=path.join(home,'dispatch');fs.mkdirSync(dir);const large=path.join(dir,'large.txt'),small=path.join(dir,'small.txt'),fd=fs.openSync(large,'w');for(let i=0;i<145;i++)fs.writeSync(fd,Buffer.alloc(65536,97));fs.closeSync(fd);fs.writeFileSync(small,'rollback original');
 const preload=path.join(dir,'preload.cjs'),root=path.resolve(__dirname,'..');fs.writeFileSync(preload,`
 const assert=require('node:assert/strict'),fs=require('node:fs'),root=${JSON.stringify(root)};
 global.fetch=()=>{throw Error('network forbidden');};require(root+'/lib/http').request=async()=>{throw Error('network forbidden');};
 const session={userId:'synthetic',accessToken:'fixture'};const account=require(root+'/lib/account');account.getUsableSession=()=>session;account.requireMember=async()=>({active:true});
 require(root+'/lib/cloud-command').flush=async()=>({});require(root+'/lib/sync').formatCapabilities=async()=>({streamImport:{enabled:process.env.STREAM_OFF!=='1'}});
 const cloud=require(root+'/lib/cloud-reader');cloud.publishBookStream=async p=>{assert(p.package.size>8*1024*1024);require(root+'/lib/books').commitStream(p);};cloud.publishBook=async()=>{};
 `);
 const run=(file,off=false)=>spawnSync(process.execPath,['--require',preload,path.join(root,'bin/watchrss.cjs'),'import',file],{env:{...process.env,WATCHRSS_HOME:path.join(dir,'state'),STREAM_OFF:off?'1':'0'},encoding:'utf8'});
 let r=run(large);assert.equal(r.status,0,r.stdout+r.stderr);assert(JSON.parse(r.stdout).ok);assert.deepEqual(fs.readdirSync(path.join(dir,'state/tmp/stream-import')),[]);
 r=run(large,true);assert.equal(r.status,1);assert.match(JSON.parse(r.stdout).error.message,/8 MB/);r=run(small,true);assert.equal(r.status,0,r.stdout+r.stderr);
});
