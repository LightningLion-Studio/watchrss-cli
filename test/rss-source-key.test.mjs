import './test-root.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import identity from '../lib/rss-source-key.js';
import rss from '../lib/rss.js';
import policy from '../lib/rss-cloud.js';
import records from '../lib/cloud-records.js';
import backendUrl from '../lib/backend-url.js';
const fixtureBytes=readFileSync(new URL('./fixtures/rss-source-key.json',import.meta.url));
const vector=JSON.parse(fixtureBytes);
const sharedUrl=new URL('../../.codex-tmp/cloud-v2/vectors/rss-source-key.json',import.meta.url);
test('R37 checked-in source identity fixture matches shared vectors whenever the shared workspace exists',()=>{if(existsSync(sharedUrl))assert.deepEqual(fixtureBytes,readFileSync(sharedUrl),'Refresh the fixture from cv2-phone vectors/rss-source-key.json');});
const hash=value=>createHash('sha256').update(value).digest('hex');
test('R30 cv2-phone/backend source_key vectors match byte for byte without resolving',()=>{
 for(const row of vector.sourceCases){assert.equal(identity.canonicalUrl(row.input),row.canonicalUrl,row.input);assert.equal(identity.sourceKey(row.input),row.sourceKey,row.input);}
 for(const row of vector.rejectedSources)assert.throws(()=>identity.sourceKey(row.input),row.input);
 assert.throws(()=>identity.sourceKey('https://example.com/'+'字'.repeat(1400)));
});
test('R41 cv2-phone backend dedup identity/hash and legacy independent-web vectors match exactly',()=>{
 for(const row of vector.articleCases){const entry={guid:row.guid,link:row.input,contentHash:row.contentHash,title:row.title};assert.equal(rss.entryIdentity(entry),row.normalizedIdentity,row.name);assert.equal(rss.canonicalEntryLink(row.input),row.canonicalEntryLink,row.name);assert.equal(rss.entryArticleId(entry),row.articleId,row.name);assert.equal(hash(rss.entryArticleId(entry)),row.articleIdHash,row.name);const actual=rss.entryToArticle(entry,{url:'https://example.com/feed'});assert.equal(actual.articleId,row.articleId);assert.equal(rss.entryToArticle({...entry,id:'pool-entry-uuid',dedupKey:row.dedupKey},{url:'https://example.com/feed'}).articleId,row.articleId);}
 for(const row of vector.legacyWebArticleCases){assert.equal(rss.normalizeForIdentity(row.input),row.normalizedIdentity);assert.equal(rss.stableArticleId(row.input),row.articleId);}
});
test('RSS no-contentHash fallback matches phone SHA256(html ?: text), including empty body',()=>{
 for(const [contentHtml,contentText,expected]of [[null,'text','text'],['<p>HTML</p>','text','<p>HTML</p>'],[null,'','']]){
  const article=rss.entryToArticle({link:'https://example.com/article',contentHtml,contentText},{url:'https://example.com/feed'});
  assert.equal(article.contentHash,hash(expected));
 }
 assert.equal(rss.entryToArticle({link:'https://example.com/a',contentText:'text',contentHash:'server-hash'},{url:'https://example.com/feed'}).contentHash,'server-hash');
});

test('R36 public-pool identity rejection distinguishes local-only sources from malformed inputs',()=>{
 for(const url of ['http://192.168.1.10/rss','http://127.0.0.1/rss','http://0177.0.0.1/rss','http://[::1]/rss','https://user:pass@example.com/feed','https://:@example.com/feed'])assert.equal(identity.localOnly(url),true,url);
 for(const url of ['https://example.com/feed','http://[::ffff:808:808]/f','not a URL'])assert.equal(identity.localOnly(url),false,url);
});
test('R37 literal caret matches backend without decoding existing percent escapes or accepting an invalid host',()=>{
 const raw='https://example.com/a%5Eb/^/%5e?literal=^&encoded=%5E#fragment';
 assert.equal(identity.canonicalUrl(raw),'https://example.com/a%5Eb/^/%5e?literal=^&encoded=%5E');
 assert.equal(rss.normalizeSourceUrl(raw),identity.canonicalUrl(raw));
 assert.equal(rss.normalizeForIdentity(raw),identity.canonicalUrl(raw));
 const marker='https://example.com/watchrss-caret-marker/^';assert.equal(identity.canonicalUrl(marker),marker);
 assert.throws(()=>identity.canonicalUrl('https://exa^mple.com/feed'));
 const entry=rss.entryToArticle({link:'/a^b',contentText:'text'},{url:'https://example.com/feed'});assert.equal(entry.url,'https://example.com/a^b');assert.equal(entry.articleId,rss.entryArticleId({link:'/a^b',contentText:'text'}));
});

test('R41 backend URL to actual production RSS projection, anchor recordId and AES-GCM matches cv2-phone e2e oracle',()=>{
 const bytes=readFileSync(new URL('./fixtures/rss-state-e2e-v1.json',import.meta.url)),shared=new URL('../../.codex-tmp/cloud-v2/vectors/rss-state-e2e-v1.json',import.meta.url);
 if(existsSync(shared))assert.deepEqual(bytes,readFileSync(shared),'Refresh rss-state-e2e-v1.json from cv2-phone');
 const e=JSON.parse(bytes),article=rss.entryToArticle({link:e.entry.input,contentText:'synthetic body'},{url:e.feed.input});
 assert.equal(identity.canonicalUrl(e.feed.input),e.feed.canonicalUrl);assert.equal(backendUrl.parse(e.entry.input).href.split('#')[0],e.entry.canonicalEntryLink);assert.equal(article.articleId,e.entry.articleId);assert.equal(rss.entryIdentity({link:article.url}),e.entry.normalizedIdentity);
 for(const field of policy.READ_FIELDS)article[field]=e.value[field];article.sourceDeviceId=e.value.sourceDeviceId;
 const projected=policy.project([article],[{url:e.feed.input}]);assert.equal(projected.articles.length,0);assert.deepEqual(projected.warnings,[]);assert.equal(projected.rssStates.length,1);
 const value=projected.rssStates[0];assert.deepEqual(value,e.value);assert.equal('rss-state:'+value.sourceId+':'+value.articleIdHash,e.recordIdentityUtf8);
 const key=Buffer.from(e.contentKeyHex,'hex'),anchorKey=Buffer.from(e.anchorKeyHex,'hex'),encoded=records.encode({userId:e.userId,key,anchorKey,keyVersion:e.keyVersion,kind:'rss-state',value,nonce:Buffer.from(e.nonceHex,'hex')});
 assert.equal(JSON.stringify(records.canonical('rss-state',value)),e.plaintextUtf8);assert.equal(encoded.recordId,e.recordId);assert.deepEqual(encoded.envelope,e.envelope);assert.equal(`watchrss-cloud-record-v1:${e.userId}:${encoded.recordId}:${e.keyVersion}`,e.aad);assert.deepEqual(records.decode({userId:e.userId,key,anchorKey,...encoded}).value,value);
});
