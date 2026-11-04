import './test-root.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import authority from '../lib/body-authority.js';
import books from '../lib/books.js';
import storage from '../lib/storage.js';
import library from '../lib/library.js';
const vector=JSON.parse(readFileSync(new URL('./fixtures/previewguard.json',import.meta.url),'utf8'));
const sha=s=>createHash('sha256').update(s).digest('hex');
const full=vector.fullRecipe.unit.repeat(Math.ceil(vector.fullRecipe.chars/vector.fullRecipe.unit.length)).slice(0,vector.fullRecipe.chars),excerpt=full.replace(/[ \t\n\r\f\v]+/g,' ').trim().slice(0,vector.excerptChars);
const expand=s=>s==='full'?full:s==='excerpt'?excerpt:s==='short'?'短'.repeat(vector.shortChars):s==='htmlShort'?'<p>'+expand('short')+'</p>':s==='htmlFull'?'<p>'+full+'</p>':s;
for(const c of vector.cases)test('PREVIEWGUARD shared '+c.name,()=>{const text=expand(c.text);assert.equal(authority.authoritativeBody({fileImport:c.fileImport,text,excerpt:expand(c.excerpt),bodyEvidence:c.bodyEvidence,digestMatches:authority.matchingBodyDigest(text,c.contentHtml?expand(c.contentHtml):null,c.contentHash),bodyAvailable:c.bodyAvailable}),c.expected);});
function fixture(t){global.wx={env:{USER_DATA_PATH:process.env.WATCHRSS_HOME}};books.clear();storage.writeJSON('session.json',{userId:'previewguard-synthetic',accessToken:'fixture'});storage.writeJSON('identity.json',{deviceId:'previewguard'});library.resetOwner();}

for(const asyncMode of [false,true])test('PREVIEWGUARD registration '+(asyncMode?'async':'sync')+' rejects preview before package/state and accepts proven short chapter',async t=>{
 fixture(t);const source={url:'https://watchrss.local/import-epub/previewguard',title:'Synthetic'};
 const article={...library.defaultArticle('previewguard'),url:source.url+'/chapter/1',title:'Synthetic',excerpt,contentHash:sha(full)};
 const run=entries=>asyncMode?books.registerAsync(entries,source):Promise.resolve().then(()=>books.register(entries,source));
 for(const patch of [{},{__localBody:true},{bodyAvailable:false}])await assert.rejects(run([{article:{...article,...patch},text:excerpt}]),e=>e.code==='cloud_book_body_missing');
 assert.deepEqual(Object.keys(books.load().books),[]);
 const text='短'.repeat(87),short={...article,excerpt:text,contentHash:sha(text)};const state=await run([{article:short,text}]);
 assert.equal(books.unpack(await books.packageTextAsync(state.bookId)).chapters[0].contentText,text);
 const path=library.bookStoragePath('books/'+state.bookId+'.jsonl'),before=storage.readText(path);
 await assert.rejects(run([{article,text:excerpt}]),e=>e.code==='cloud_book_body_missing');assert.equal(storage.readText(path),before);
});
test('PREVIEWGUARD explicit missing inline body is rejected, full externally supplied body is accepted',()=>{
 const article={url:'https://watchrss.local/import-content/txt/x',contentText:'ordinary body',excerpt:'summary',__localBody:false};
 assert.throws(()=>authority.requireBookBody(article,article.contentText),e=>e.code==='cloud_book_body_missing');
 assert.doesNotThrow(()=>authority.requireBookBody({...article,contentHash:sha(full)},full));
});

test('PREVIEWGUARD actual EPUB short text and complete HTML agree with original digest',()=>{
 const text='短'.repeat(87),html='<p>'+text+'</p>',article={url:'https://watchrss.local/import-epub/guard/chapter/1',excerpt:text,contentText:text,contentHtml:html,contentHash:sha(html)};
 assert.doesNotThrow(()=>authority.requireBookBody(article,text));
 assert.throws(()=>authority.requireBookBody({...article,excerpt,contentText:excerpt,contentHtml:'<p>'+full+'</p>',contentHash:sha('<p>'+full+'</p>')},excerpt),e=>e.code==='cloud_book_body_missing');
});
