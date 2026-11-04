import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import os from 'node:os';import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'clirepin-limits-'));process.env.WATCHRSS_HOME=home;
const LIB='../lib/',VENDOR='../vendor/';
require(LIB+'account').getUsableSession=()=>({userId:'synthetic',accessToken:'fixture'});require(LIB+'storage').writeJSON('identity.json',{deviceId:'synthetic'});
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
function fixture(){const root=fs.mkdtempSync(path.join(home,'case-'));return{root,close:()=>fs.rmSync(root,{recursive:true,force:true})};}
const files=require(LIB+'import-files'),stream=require(LIB+'import-stream'),books=require(LIB+'books'),importer=require(LIB+'file-import'),limits=require(LIB+'import-limits'),policy=require(LIB+'import-policy');
const textFor=n=>Array.from({length:n},(_,i)=>`第${i+1}章 标题\n完整正文内容。\n`).join('');
const cases=new WeakMap();
async function prepared(t,text,name='book.txt'){
 let state=cases.get(t);if(!state){state={env:fixture(),resources:[]};cases.set(t,state);t.after(async()=>{try{for(const {input,stage} of state.resources){await input.close();await stage.close();}}finally{state.env.close();}});}
 const file=state.env.root+'/input-'+state.resources.length;fs.writeFileSync(file,text);const input=await files.open(file),stage=await files.stage();state.resources.push({input,stage});return{input,stage,prepare:()=>stream.prepare(name,input,stage,policy.DEFAULTS,{now:123})};
}

for(const count of [2006,2583,10000])test(`import ${count} TXT chapters preserves complete package and last ordinal`,async t=>{
 const text=textFor(count),{stage,prepare}=await prepared(t,text),p=await prepare();assert.equal(p.book.chapterCount,count);assert.equal((await importer.parse('book.txt',Buffer.from(text))).txtChapterPlan.ranges.length,count);
 p.package=await stream.packageBook(p,policy.DEFAULTS);const decoded=await books.unpackAsync(fs.readFileSync(p.package.filePath,'utf8'),p.book);assert.equal(decoded.chapters.length,count);assert.equal(decoded.chapters.at(-1).chapterIndex,count);assert.match(decoded.chapters.at(-1).contentText,new RegExp(`第${count}章`));assert.equal(decoded.bookId,p.book.bookId);
});
test('chapter admission counts preface and rejects 10001 with an explicit limit',async t=>{
 assert.equal(limits.MAX_CHAPTERS,10000);const preface='前'.repeat(24)+'\n',ok=preface+textFor(9999),bad=preface+textFor(10000);
 assert.equal(require(LIB+'txt-chapters').plan(ok).ranges.length,10000);for(const text of [bad,textFor(10001)]){assert.throws(()=>require(LIB+'txt-chapters').plan(text),e=>e.code==='import_chapter_limit'&&/10000.*含前言/.test(e.message));const value=await prepared(t,text);await assert.rejects(value.prepare(),e=>e.code==='import_chapter_limit');}
 const value=await prepared(t,ok);assert.equal((await value.prepare()).book.chapterCount,10000);
});
function epub(count){const entries={'META-INF/container.xml':Buffer.from('<container><rootfile full-path="book.opf"/></container>')};let items='',spine='';for(let i=1;i<=count;i++){items+=`<item id="c${i}" href="c${i}.html"/>`;spine+=`<itemref idref="c${i}"/>`;entries[`c${i}.html`]=Buffer.from(`<h1>chapter ${i}</h1><p>complete original</p>`);}entries['book.opf']=Buffer.from(`<package><manifest>${items}</manifest><spine>${spine}</spine></package>`);return require(VENDOR+'fflate-browser').zipSync(entries);}
test('EPUB supports 10000 spine chapters plus metadata and rejects chapter 10001',async t=>{
 const cooperative=require(LIB+'cooperative'),util=require(LIB+'util'),oldTurn=cooperative.turn,oldTick=util.tick;t.after(()=>{cooperative.turn=oldTurn;util.tick=oldTick;});cooperative.turn=async()=>{};util.tick=async()=>{};
 const bytes=epub(10000),value=await prepared(t,bytes,'book.epub');assert.equal((await value.prepare()).book.chapterCount,10000);assert.equal((await importer.parse('book.epub',bytes)).chapters.length,10000);
 const bad=epub(10001),other=await prepared(t,bad,'book.epub');await assert.rejects(other.prepare(),e=>e.code==='import_chapter_limit');await assert.rejects(importer.parse('book.epub',bad),e=>e.code==='import_chapter_limit');
 const fake=new Uint8Array(22),view=new DataView(fake.buffer);view.setUint32(0,0x06054b50,true);view.setUint16(10,20001,true);assert.throws(()=>importer.preflight(fake),e=>e.code==='import_archive_entry_limit'&&/20000/.test(e.message));
});
test('10000 chapter deletion ordinals fit the 64 KiB encrypted book record ceiling',async t=>{
 const value=await prepared(t,textFor(2)),p=await value.prepare(),book={...p.book,chapterCount:10000,deletedChapters:Array.from({length:10000},(_,i)=>i+1),title:'标题'.repeat(160)};
 const encoded=require(LIB+'cloud-records').encode({userId:'synthetic',key:new Uint8Array(32).fill(3),keyVersion:1,kind:'book',value:book});assert(Buffer.from(encoded.envelope.ciphertextBase64,'base64').length<=65536);
});

test('book slices and import cloud admission respect all readers',()=>{for(const size of [1,9000*1024,32*1024*1024])assert(Math.ceil(size/(limits.bookChunkBytes(size)-3))<=1024);const made={encryptedManifest:new Uint8Array(1),manifest:{objects:[{chunks:[]}]}};limits.validateSnapshot(made);for(const object of [{chunks:new Array(1025)},null]){const bad=object?{...made,manifest:{objects:[object]}}:{...made,manifest:{objects:new Array(1025).fill({})}};assert.throws(()=>limits.validateSnapshot(bad),e=>e.code==='import_cloud_capacity');}assert.equal(policy.policy({maxPackageBytes:512*1024*1024}).maxPackageBytes,32*1024*1024);});
