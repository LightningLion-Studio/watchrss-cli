const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto'),{spawnSync}=require('node:child_process');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'clirepin-eof-'));process.env.WATCHRSS_HOME=home;
const stream=require('../lib/book-stream'),online=require('../lib/online-reader'),text='长书原文🙂'.repeat(150000),bytes=Buffer.from(JSON.stringify({format:'watchrss-book',version:1,chapterCount:1})+'\n'+JSON.stringify({chapterIndex:1,contentText:text})+'\n');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
test('cold partial offsets expose knownPages and true EOF; every character survives paging',async()=>{
 const reader=online.bounded(await stream.open({range:{size:bytes.length,identity:'long',async read(a,b){return bytes.subarray(a,b);}},expected:{fingerprint:'synthetic',chapterCount:1},chapterIndex:1,indexPath:'cache/eof.json'}));
 try{assert.equal(reader.knownPages,1);assert.equal(reader.totalPagesKnown,false);let page=0,chars=0,info;const digest=createHash('sha256');do{info=await reader.readPage(page++);digest.update(info.text);chars+=info.text.length;if(info.hasMore)assert.equal(info.eof,false);}while(info.hasMore);
  assert.equal(chars,text.length);assert.equal(digest.digest('hex'),createHash('sha256').update(text).digest('hex'));assert(info.eof);assert.equal(info.totalPages,page);assert.equal(info.knownPages,page);assert.equal(reader.totalPagesKnown,true);
 }finally{reader.close();}
});
test('CLI articles get reports page metadata after reading and never labels an unknown total as EOF',()=>{
 const root=path.resolve(__dirname,'..'),preload=path.join(home,'preload.cjs');fs.writeFileSync(preload,`
 const root=${JSON.stringify(root)},account=require(root+'/lib/account'),online=require(root+'/lib/online-reader'),stream=require(root+'/lib/book-stream');global.fetch=()=>{throw Error('network forbidden');};require(root+'/lib/http').request=async()=>{throw Error('network forbidden');};account.getUsableSession=()=>({userId:'synthetic',accessToken:'fixture'});account.requireMember=async()=>({active:true});require(root+'/lib/cloud-command').flush=async()=>({});const library=require(root+'/lib/library'),article={...library.defaultArticle('synthetic'),title:'synthetic'};library.getArticleView=library.getArticle=()=>article;
 const text='x'.repeat(900001),bytes=Buffer.from(JSON.stringify({format:'watchrss-book',version:1,chapterCount:1})+'\\n'+JSON.stringify({chapterIndex:1,contentText:text})+'\\n');online.open=async()=>online.bounded(await stream.open({range:{size:bytes.length,identity:'cli',read:async(a,b)=>bytes.subarray(a,b)},expected:{fingerprint:'synthetic',chapterCount:1},chapterIndex:1,indexPath:'cache/cli-eof.json'}));
 `);
 const run=page=>{const r=spawnSync(process.execPath,['--require',preload,path.join(root,'bin/watchrss.cjs'),'articles','get','synthetic','--page',String(page)],{encoding:'utf8',env:{...process.env,WATCHRSS_HOME:path.join(home,'cli')}});assert.equal(r.status,0,r.stdout+r.stderr);return JSON.parse(r.stdout).data;};
 const first=run(0);assert.equal(first.totalPages,null);assert.equal(first.knownPages,2);assert.equal(first.hasMore,true);assert.equal(first.eof,false);const last=run(300);assert.equal(last.text,'x');assert.equal(last.totalPages,301);assert.equal(last.hasMore,false);assert.equal(last.eof,true);
});
