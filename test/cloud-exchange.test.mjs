import * as requireCrypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'wrss-exchange-port-'));process.env.WATCHRSS_HOME=home;
const {default:exchange}=await import('../lib/cloud-exchange.js');
const miniURL=new URL('../../WatchRSS_WeChat/miniprogram/lib/cloud-exchange.js',import.meta.url),mini=existsSync(miniURL)?(await import(miniURL)).default:null;
const dir=new URL('./fixtures/exchange-v1/',import.meta.url);
test.after(()=>rmSync(home,{recursive:true,force:true}));
test('CLI production exchange codec agrees with mini and all shared tags/DTO vectors',()=>{for(const x of JSON.parse(readFileSync(new URL('tags.json',dir)))){assert.equal(exchange.tag(x.kind,x.input),x.sha256);assert.equal(exchange.canonicalJSON(x.input),x.canonicalUtf8);if(mini)assert.equal(exchange.tag(x.kind,x.input),mini.tag(x.kind,x.input));}const x=JSON.parse(readFileSync(new URL('requests.json',dir)));if(mini)assert.deepEqual(exchange.requestBody(x.defaults),mini.requestBody(x.defaults));for(const value of x.invalidRevisions)assert.throws(()=>exchange.revision(value));for(const value of x.validRevisions)assert.equal(exchange.revision(value),value);});
test('Node HTTP retains exchange conflict ciphertext only for the exchange owner',async()=>{const {default:http}=await import('../lib/http.js'),original=global.fetch;const conflict={error:'cloud_record_conflict',conflicts:[],conflictItems:[{opaque:'synthetic'}]};global.fetch=async()=>new Response(JSON.stringify(conflict),{status:409});try{await assert.rejects(http.request({method:'POST',path:exchange.PATH,body:{},extraHeaders:{'x-watchrss-library-epoch':'11111111-1111-4111-8111-111111111111'}}),e=>e.exchange?.conflictItems?.[0].opaque==='synthetic');await assert.rejects(http.request({method:'POST',path:'/functions/v1/cloud/records',body:{},extraHeaders:{'x-watchrss-library-epoch':'11111111-1111-4111-8111-111111111111'}}),e=>e.exchange===undefined);}finally{global.fetch=original;}});

test('exchange fixture copies preserve all authoritative bytes when shared vectors are available',()=>{const {createHash}=requireCrypto;const hashes=JSON.parse(readFileSync(new URL('hashes.json',dir)));for(const [name,hash]of Object.entries(hashes)){const own=readFileSync(new URL(name,dir));assert.equal(createHash('sha256').update(own).digest('hex'),hash);const shared=new URL('../../.codex-tmp/cloud-v2/vectors/exchange-v1/'+name,import.meta.url);if(existsSync(shared))assert.deepEqual(own,readFileSync(shared));}});
