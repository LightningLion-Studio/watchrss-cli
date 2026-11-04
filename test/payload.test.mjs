import './test-root.cjs';
// 载荷 wire 格式：gzip 正文、base64 标准带填充（正文块）、字段省略语义、同步元数据稳定
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const payload = require('../lib/payload.js');
const util = require('../lib/util.js');

function makeArticle(overrides = {}) {
  return Object.assign({
    articleId: 'id-1', sourceDeviceId: 'dev-1', url: 'https://example.com/a',
    title: 'Title', siteName: 'Site', excerpt: 'Ex',
    contentHtml: '<p>HTML 正文</p>', contentText: '纯文本正文',
    imageUrl: 'https://example.com/i.png', contentHash: 'ch-1',
    importedAt: 100, updatedAt: 200,
    independentSaved: true, independentChangedAt: 5, independentSortOrder: 7,
    rssSourceUrl: 'https://feeds.x/rss', rssSourceTitle: 'Feed',
    favoriteSaved: false, favoriteChangedAt: 0, favoriteSortOrder: 0,
    watchLaterSaved: false, watchLaterChangedAt: 0, watchLaterSortOrder: 0,
    deleted: false, deletedAt: 0,
    readingProgress: 0.42, readingPositionBytes: 33, readingPositionContentHash: 'ch-1',
    readingPositionChangedAt: 9, isRead: false,
    syncBodyHash: '', syncBodyByteCount: 0, syncChunkSize: 0, syncChunkHashesJson: '', syncMetadataHash: '',
  }, overrides);
}

// 1) 正文 gzip + 标准 base64（带填充）
{
  const bytes = payload.encodeBody('<p>x</p>', 'text');
  // 与 Java GZIPOutputStream 兼容：node zlib 可解开
  const unzipped = zlib.gunzipSync(Buffer.from(bytes)).toString('utf8');
  const parsed = JSON.parse(unzipped);
  assert.equal(parsed.contentHtml, '<p>x</p>');
  assert.equal(parsed.contentText, 'text');
  const back = payload.decodeBody(bytes);
  assert.equal(back.contentHtml, '<p>x</p>');
  assert.equal(back.contentText, 'text');

  const article = makeArticle();
  const json = payload.articleToJson(article);
  const decoded = Buffer.from(json.contentHtmlGzip, 'base64');
  assert.ok(zlib.gunzipSync(decoded).toString('utf8').includes('HTML 正文'), '正文块为系统 zlib 可解的 gzip');
  // 标准 base64 带填充（Java Base64.getEncoder()）
  assert.ok(/=[=]?$/.test(json.contentHtmlGzip) || json.contentHtmlGzip.length % 4 === 0, 'base64 填充合法');
}

// 2) null/空正文省略 key
{
  const json = payload.articleToJson(makeArticle({ contentHtml: null, contentText: '' }));
  assert.ok(!('contentHtmlGzip' in json), 'null 正文省略 key');
  assert.ok(!('contentTextGzip' in json), '空正文省略 key');
  const json2 = payload.articleToJson(makeArticle({ imageUrl: null, rssSourceUrl: null, rssSourceTitle: null }));
  assert.ok(!('imageUrl' in json2) && !('rssSourceUrl' in json2), 'null 字段省略');
}

// 3) wire round-trip（parse 后字段完整）
{
  const article = makeArticle({ readingProgress: 1.7, contentText: '中文字符串 ' });
  const relay = payload.buildLibrarySync({ deviceId: 'dev-1', articles: [article], rssSources: [] });
  const parsed = payload.parseLibrarySync(relay).articles[0];
  assert.equal(parsed.readingProgress, 1, 'readingProgress 截断到 [0,1]');
  assert.equal(parsed.contentHtml, '<p>HTML 正文</p>');
  assert.equal(parsed.contentText, '中文字符串 ');
  assert.equal(parsed.independentSaved, true);
  assert.equal(parsed.syncBodyHash, '', '中继载荷不含同步元数据 → 默认空');
}

// 4) 同步元数据稳定且与正文绑定
{
  const a = makeArticle();
  const m1 = payload.currentSyncMetadata(a);
  const m2 = payload.currentSyncMetadata(makeArticle());
  assert.equal(m1.syncBodyHash, m2.syncBodyHash);
  assert.equal(m1.syncMetadataHash, m2.syncMetadataHash);
  assert.equal(m1.syncChunkSize, 128 * 1024);
  const m3 = payload.currentSyncMetadata(makeArticle({ contentText: 'changed' }));
  assert.notEqual(m1.syncBodyHash, m3.syncBodyHash, '正文变化 → bodyHash 变化');
  const m4 = payload.currentSyncMetadata(makeArticle({ title: 'changed' }));
  assert.notEqual(m1.syncMetadataHash, m4.syncMetadataHash, '元数据字段变化 → metadataHash 变化');
  assert.ok(payload.hasCurrentSyncMetadata(payload.withCurrentSyncMetadata(a)));
}

// 5) rss-state 格式
{
  const state = payload.buildRssState({ articles: [makeArticle()], sources: [] });
  const root = JSON.parse(util.bytesToUtf8(state));
  assert.equal(root.format, 'watchrss-rss-state');
  assert.equal(root.version, 1);
  assert.ok(root.articles[0].articleId === 'id-1');
  assert.ok(!('contentHtml' in root.articles[0]), 'rss-state 不含正文');
  const back = payload.parseRssState(state);
  assert.equal(back.articles.length, 1);
  assert.throws(() => payload.parseRssState(util.utf8ToBytes('{"format":"x","version":1}')), /不受支持/);
}

console.log('载荷测试全部通过');
