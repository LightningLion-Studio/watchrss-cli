const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('SYNCPERF native cache ledger follows the active mode namespace without carrying another namespace positions',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'wrss-syncperf-adapter-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const result=spawnSync(process.execPath,['-e',`const assert=require('node:assert/strict'),s=require('./lib/storage'),b=require('./lib/storage-budget');
 s.setNamespace('hybrid');s.writeBytes('cache/remote-chunks/test/block',new Uint8Array([1]));b.focus('book-a',5,'series-a');b.range('cache/remote-chunks/test/block',{bookId:'book-a',index:5,series:'series-a'},{persist:false});b.flushRanges();assert.equal(s.readJSON('state/storage-cache-v1.json').positions['book-a'].index,5);
 s.setNamespace('cloud');s.writeBytes('cache/remote-chunks/test/block',new Uint8Array([2]));b.focus('book-b',8,'series-b');b.range('cache/remote-chunks/test/block',{bookId:'book-b',index:8,series:'series-b'},{persist:false});b.flushRanges();const ledger=s.readJSON('state/storage-cache-v1.json');assert.equal(ledger.positions['book-a'],undefined);assert.equal(ledger.entries['cache/remote-chunks/test/block'].references['book-a'],undefined);assert.equal(ledger.positions['book-b'].index,8);
 s.setNamespace('hybrid');b.focus('book-a',6,'series-a');assert.equal(s.readJSON('state/storage-cache-v1.json').positions['book-b'],undefined);assert.equal(s.readJSON('state/storage-cache-v1.json').positions['book-a'].index,6);`],{cwd:path.resolve(__dirname,'..'),env:{...process.env,WATCHRSS_HOME:home},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr||result.stdout);
});
function commandFixture(args,{values={},failed=false}={}){
 const vm=require('node:vm'),code=fs.readFileSync(path.resolve(__dirname,'../bin/watchrss.cjs'),'utf8'),events=[];let locked=false,resume;
 const gate=new Promise(r=>resume=r),prefetch={async finishCommand({cancel=false}={}){assert(locked,'profile lock must cover every prefetch continuation');events.push(cancel?'cancel-drain':'wait');await gate;return !cancel&&failed?[{status:'stopped',error:'network_error'}]:[];}};
 const modules={
  '../lib/storage':{readJSON:()=>({mode:'hybrid'}),setMode(){},setNamespace(){},acquireLock(){assert(!locked);locked=true;events.push('lock');return()=>{events.push('unlock');locked=false;};}},
  '../lib/account':{requireMember:async()=>({}),getUsableSession:()=>({userId:'synthetic-command'})},'../lib/http':{},'../lib/login':{},'../lib/sync':{},'../lib/library':{listSources:()=>[]},'../lib/cloud-library':{stop(){events.push('stop');}},'../lib/device':{},'../lib/cloud-records':{},'../lib/crypto':{initializeRandom:async()=>{}},'../lib/cloud-command':{flush:async()=>{events.push('flush');return{pending:false};}},'../lib/cloud-books':prefetch,
 };
 const box={module:{exports:{}},process:{stderr:{write(){}}},URL,console,require:name=>name==='node:util'?{parseArgs:()=>({values,positionals:args})}:name.startsWith('node:')?require(name):modules[name]||(()=>{throw Error('unexpected command module '+name);})()};
 vm.runInNewContext(code.slice(0,code.indexOf('main().then(result=>{'))+'module.exports=main;',box);
 return{main:box.module.exports,events,resume,get locked(){return locked;}};
}
test('SYNCPERF explicit sync waits for background completion before releasing its profile lock',async()=>{
 const f=commandFixture(['sync']),pending=f.main();await new Promise(setImmediate);assert(f.locked);assert(f.events.includes('wait'));assert(!f.events.includes('unlock'));f.resume();await pending;assert.deepEqual(f.events,['lock','flush','wait','stop','cancel-drain','unlock']);assert(!f.locked);
});
test('SYNCPERF short read commands cancel and drain prefetch before releasing the profile lock',async()=>{
 const f=commandFixture(['sources','list'],{values:{offline:true}}),pending=f.main();await new Promise(setImmediate);assert(f.locked);assert(f.events.includes('cancel-drain'));f.resume();await pending;assert.deepEqual(f.events,['lock','stop','cancel-drain','unlock']);
});
test('SYNCPERF a failed background verification cannot produce successful explicit sync',async()=>{
 const f=commandFixture(['sync'],{failed:true}),pending=f.main();await new Promise(setImmediate);f.resume();await assert.rejects(pending,e=>e.code==='network_error');assert(!f.locked);assert.equal(f.events.at(-1),'unlock');
});
