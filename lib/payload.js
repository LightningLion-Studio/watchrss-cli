// 云同步载荷编解码：library-sync.json（中继库）与 rss-state.json（RSS 状态）
// 逐字段对应 Android_WatchRSS_Phone 的 LibrarySyncPayload / CloudRssStateCodec / ArticleSyncBody
const crypto = require('./crypto');
const util = require('./util');
const gzip = require('./gzip');

const LIBRARY_SYNC_VERSION = 13;
const LIBRARY_SYNC_ACTION = 'syncLibrary';
const LIBRARY_SYNC_PHASE = 'complete';
const BODY_ENCODING_VERSION = 2;
const BODY_CHUNK_SIZE = 128 * 1024;

// ---------- 正文同步元数据（ArticleSyncBody 等价） ----------

function encodeBody(contentHtml, contentText) {
  const obj = { contentHtml: contentHtml === null || contentHtml === undefined ? undefined : contentHtml };
  obj.contentText = contentText === null || contentText === undefined ? '' : contentText;
  return gzip.gzip(util.utf8ToBytes(JSON.stringify(obj)));
}

function decodeBody(bodyBytes) {
  let text;
  try {
    text = util.bytesToUtf8(gzip.gunzip(new Uint8Array(bodyBytes)));
  } catch (e) {
    text = util.bytesToUtf8(new Uint8Array(bodyBytes));
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') return { contentHtml: null, contentText: '' };
  const html = parsed.contentHtml;
  const textContent = parsed.contentText;
  return {
    contentHtml: html === undefined || html === null || html === '' ? null : html,
    contentText: textContent === undefined || textContent === null ? '' : String(textContent),
  };
}

function chunkHashesFor(bytes) {
  const arr = new Uint8Array(bytes);
  const count = arr.length === 0 ? 1 : Math.floor((arr.length - 1) / BODY_CHUNK_SIZE) + 1;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * BODY_CHUNK_SIZE;
    const end = Math.min(start + BODY_CHUNK_SIZE, arr.length);
    out.push(crypto.sha256Hex(arr.subarray(start, end)));
  }
  return out;
}

// metadataHash：org.json 序（null 省略），与 Kotlin metadataHashFor 一致
function metadataHashFor(article) {
  const obj = {
    bodyEncodingVersion: BODY_ENCODING_VERSION,
    articleId: article.articleId,
    sourceDeviceId: article.sourceDeviceId,
    url: article.url,
    title: article.title,
    siteName: article.siteName,
    excerpt: article.excerpt,
  };
  if (article.imageUrl) obj.imageUrl = article.imageUrl;
  Object.assign(obj, {
    importedAt: article.importedAt,
    updatedAt: article.updatedAt,
    independentSaved: article.independentSaved,
    independentChangedAt: article.independentChangedAt,
    independentSortOrder: article.independentSortOrder,
  });
  if (article.rssSourceUrl) obj.rssSourceUrl = article.rssSourceUrl;
  if (article.rssSourceTitle) obj.rssSourceTitle = article.rssSourceTitle;
  Object.assign(obj, {
    favoriteSaved: article.favoriteSaved,
    favoriteChangedAt: article.favoriteChangedAt,
    favoriteSortOrder: article.favoriteSortOrder,
    watchLaterSaved: article.watchLaterSaved,
    watchLaterChangedAt: article.watchLaterChangedAt,
    watchLaterSortOrder: article.watchLaterSortOrder,
    deleted: article.deleted,
    deletedAt: article.deletedAt,
  });
  return crypto.sha256Hex(JSON.stringify(obj));
}

function currentSyncMetadata(article) {
  const bodyBytes = encodeBody(article.contentHtml, article.contentText);
  return {
    syncBodyHash: crypto.sha256Hex(bodyBytes),
    syncBodyByteCount: bodyBytes.length,
    syncChunkSize: BODY_CHUNK_SIZE,
    syncChunkHashesJson: JSON.stringify(chunkHashesFor(bodyBytes)),
    syncMetadataHash: metadataHashFor(article),
  };
}

// 与 Kotlin hasSyncMetadata 一致：判断文章上的同步元数据是否仍与当前正文匹配
function hasCurrentSyncMetadata(article) {
  if (!article.syncMetadataHash || article.syncMetadataHash !== metadataHashFor(article)) return false;
  if (!article.syncBodyHash) return false;
  const expected = currentSyncMetadata(article);
  const chunkHashes = parseChunkHashesJson(article.syncChunkHashesJson);
  return (
    article.syncBodyHash === expected.syncBodyHash &&
    Number(article.syncBodyByteCount || 0) === expected.syncBodyByteCount &&
    Number(article.syncChunkSize || 0) === expected.syncChunkSize &&
    JSON.stringify(chunkHashes) === expected.syncChunkHashesJson &&
    article.syncMetadataHash === expected.syncMetadataHash
  );
}

function parseChunkHashesJson(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (e) {
    return [];
  }
}

function withCurrentSyncMetadata(article) {
  return Object.assign({}, article, currentSyncMetadata(article));
}

// ---------- library-sync.json（中继库） ----------

function putCompressedString(obj, name, value) {
  if (value === null || value === undefined || String(value).trim() === '') return;
  // Java Base64.getEncoder()：标准字母表 + 填充
  obj[name] = util.base64PaddedEncode(gzip.gzip(util.utf8ToBytes(String(value))));
}

function optCompressedString(obj, name) {
  const encoded = obj[name];
  if (typeof encoded !== 'string' || encoded.trim() === '') return null;
  try {
    return util.bytesToUtf8(gzip.gunzip(util.base64PaddedDecode(encoded)));
  } catch (e) {
    return null;
  }
}

function optFiniteProgress(obj, name) {
  const value = obj[name];
  if (typeof value !== 'number' || !isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// 与 Kotlin toJson(includeBody=true) 一致（org.json null 省略语义）
function articleToJson(article) {
  if(require('./article-provenance').protectedValue(article))throw require('./cloud-format').error();
  const obj = {};
  obj.articleId = article.articleId;
  obj.sourceDeviceId = article.sourceDeviceId;
  obj.url = article.url;
  obj.title = article.title;
  obj.siteName = article.siteName;
  obj.excerpt = article.excerpt;
  putCompressedString(obj, 'contentHtmlGzip', article.contentHtml);
  putCompressedString(obj, 'contentTextGzip', article.contentText);
  if (article.imageUrl) obj.imageUrl = article.imageUrl;
  obj.contentHash = article.contentHash;
  obj.importedAt = article.importedAt;
  obj.updatedAt = article.updatedAt;
  obj.independentSaved = article.independentSaved;
  obj.independentChangedAt = article.independentChangedAt;
  obj.independentSortOrder = article.independentSortOrder;
  if (article.rssSourceUrl) obj.rssSourceUrl = article.rssSourceUrl;
  if (article.rssSourceTitle) obj.rssSourceTitle = article.rssSourceTitle;
  obj.favoriteSaved = article.favoriteSaved;
  obj.favoriteChangedAt = article.favoriteChangedAt;
  obj.favoriteSortOrder = article.favoriteSortOrder;
  obj.watchLaterSaved = article.watchLaterSaved;
  obj.watchLaterChangedAt = article.watchLaterChangedAt;
  obj.watchLaterSortOrder = article.watchLaterSortOrder;
  obj.deleted = article.deleted;
  obj.deletedAt = article.deletedAt;
  const progress = typeof article.readingProgress === 'number' && isFinite(article.readingProgress)
    ? Math.min(1, Math.max(0, article.readingProgress))
    : 0;
  obj.readingProgress = progress;
  obj.readingPositionBytes = Math.max(0, Number(article.readingPositionBytes || 0));
  obj.readingPositionContentHash = article.readingPositionContentHash || '';
  obj.readingPositionChangedAt = Math.max(0, Number(article.readingPositionChangedAt || 0));
  obj.isRead = !!article.isRead;
  return obj;
}

function sourceToJson(source) {
  const obj = {};
  obj.url = source.url;
  obj.sourceDeviceId = source.sourceDeviceId;
  obj.title = source.title;
  obj.description = source.description;
  if (source.siteUrl) obj.siteUrl = source.siteUrl;
  if (source.imageUrl) obj.imageUrl = source.imageUrl;
  obj.createdAt = source.createdAt;
  obj.updatedAt = source.updatedAt;
  obj.sortOrder = source.sortOrder;
  obj.isPinned = source.isPinned;
  obj.deleted = source.deleted;
  obj.deletedAt = source.deletedAt;
  obj.useOriginalContent = source.useOriginalContent;
  obj.continuePlaybackInBackground = source.continuePlaybackInBackground;
  return obj;
}

// 与 Kotlin buildResponse 一致
function buildLibrarySync({ deviceId, articles, rssSources, sentAt = Date.now(), stats = null }) {
  const obj = {
    success: true,
    version: LIBRARY_SYNC_VERSION,
    action: LIBRARY_SYNC_ACTION,
    phase: LIBRARY_SYNC_PHASE,
    deviceId,
    sentAt,
    articles: articles.map(articleToJson),
    rssSources: rssSources.map(sourceToJson),
  };
  if (stats) obj.stats = stats;
  return util.utf8ToBytes(JSON.stringify(obj));
}

async function buildLibrarySyncAsync({ deviceId, articles, rssSources, sentAt = Date.now(), stats = null }) {
  const encoded = [];
  let started = Date.now();
  for (let i = 0; i < articles.length; i += 1) {
    encoded.push(articleToJson(articles[i]));
    if ((i & 31) === 31 || Date.now() - started >= 8) { await util.tick(); started = Date.now(); }
  }
  const obj = { success: true, version: LIBRARY_SYNC_VERSION, action: LIBRARY_SYNC_ACTION,
    phase: LIBRARY_SYNC_PHASE, deviceId, sentAt, articles: encoded, rssSources: rssSources.map(sourceToJson) };
  if (stats) obj.stats = stats;
  return util.utf8ToBytes(JSON.stringify(obj));
}

function parseArticle(item) {
  const articleId = String(item.articleId || '').trim();
  const url = String(item.url || '').trim();
  if (!articleId || !url) return null;
  const contentText = optCompressedString(item, 'contentTextGzip');
  return {
    articleId,
    sourceDeviceId: String(item.sourceDeviceId || '').trim() || String(item.deviceId || '').trim(),
    url,
    title: String(item.title || '').trim() || url,
    siteName: String(item.siteName || '').trim(),
    excerpt: String(item.excerpt || '').trim(),
    contentHtml: optCompressedString(item, 'contentHtmlGzip'),
    contentText: contentText === null ? '' : contentText,
    imageUrl: String(item.imageUrl || '').trim() || null,
    contentHash: String(item.contentHash || '').trim(),
    importedAt: Number(item.importedAt || 0),
    updatedAt: Number(item.updatedAt || 0),
    independentSaved: item.independentSaved !== undefined
      ? !!item.independentSaved
      : !(item.favoriteSaved === true) && !(item.watchLaterSaved === true) && !(item.deleted === true),
    independentChangedAt: Number(item.independentChangedAt || 0),
    independentSortOrder: Number(item.independentSortOrder || 0),
    rssSourceUrl: String(item.rssSourceUrl || '').trim() || null,
    rssSourceTitle: String(item.rssSourceTitle || '').trim() || null,
    favoriteSaved: !!item.favoriteSaved,
    favoriteChangedAt: Number(item.favoriteChangedAt || 0),
    favoriteSortOrder: Number(item.favoriteSortOrder || 0),
    watchLaterSaved: !!item.watchLaterSaved,
    watchLaterChangedAt: Number(item.watchLaterChangedAt || 0),
    watchLaterSortOrder: Number(item.watchLaterSortOrder || 0),
    deleted: !!item.deleted,
    deletedAt: Number(item.deletedAt || 0),
    readingProgress: optFiniteProgress(item, 'readingProgress'),
    readingPositionBytes: Math.max(0, Number(item.readingPositionBytes || 0)),
    readingPositionContentHash: String(item.readingPositionContentHash || '').trim(),
    readingPositionChangedAt: Math.max(0, Number(item.readingPositionChangedAt || 0)),
    isRead: !!item.isRead,
    // 同步元数据默认值（中继载荷不含该字段）
    syncBodyHash: '',
    syncBodyByteCount: 0,
    syncChunkSize: 0,
    syncChunkHashesJson: '',
    syncMetadataHash: '',
  };
}

function parseSource(item) {
  const url = String(item.url || '').trim();
  if (!url) return null;
  return {
    url,
    sourceDeviceId: String(item.sourceDeviceId || '').trim() || String(item.deviceId || '').trim(),
    title: String(item.title || '').trim() || url,
    description: String(item.description || '').trim(),
    siteUrl: String(item.siteUrl || '').trim() || null,
    imageUrl: String(item.imageUrl || '').trim() || null,
    createdAt: Number(item.createdAt || 0),
    updatedAt: Number(item.updatedAt || 0),
    sortOrder: Number(item.sortOrder || 0),
    isPinned: !!item.isPinned,
    deleted: !!item.deleted,
    deletedAt: Number(item.deletedAt || 0),
    __syncedSettingsIncluded: Object.prototype.hasOwnProperty.call(item,'useOriginalContent') || Object.prototype.hasOwnProperty.call(item,'continuePlaybackInBackground'),
    useOriginalContent: !!item.useOriginalContent,
    continuePlaybackInBackground: !!item.continuePlaybackInBackground,
  };
}

function parseLibrarySync(bytes) {
  const root = JSON.parse(util.bytesToUtf8(bytes));
  if (root.phase !== LIBRARY_SYNC_PHASE && root.phase !== 'complete') {
    // 宽容处理：只要携带 articles 即可
  }
  const articles = [];
  const items = Array.isArray(root.articles) ? root.articles : [];
  for (const item of items) {
    if (item && typeof item === 'object') {
      const article = parseArticle(item);
      if (article) articles.push(article);
    }
  }
  const rssSources = [];
  const sourceItems = Array.isArray(root.rssSources) ? root.rssSources : [];
  for (const item of sourceItems) {
    if (item && typeof item === 'object') {
      const source = parseSource(item);
      if (source) rssSources.push(source);
    }
  }
  return { deviceId: String(root.deviceId || ''), sentAt: Number(root.sentAt || 0), articles, rssSources };
}

// ---------- rss-state.json（CloudRssStateCodec 等价） ----------

const RSS_STATE_FORMAT = 'watchrss-rss-state';
const RSS_STATE_VERSION = 1;

function buildRssState({ articles, sources, exportedAt = Date.now() }) {
  if(articles.some(a=>require('./article-provenance').protectedValue(a)))throw require('./cloud-format').error();
  const obj = {
    format: RSS_STATE_FORMAT,
    version: RSS_STATE_VERSION,
    exportedAt,
    articles: articles.map((a) => {
      const item = {
        articleId: a.articleId,
        sourceDeviceId: a.sourceDeviceId,
        url: a.url,
        title: a.title,
        siteName: a.siteName,
        excerpt: a.excerpt,
        contentHash: a.contentHash,
        importedAt: a.importedAt,
        updatedAt: a.updatedAt,
        independentSaved: a.independentSaved,
        independentChangedAt: a.independentChangedAt,
        independentSortOrder: a.independentSortOrder,
        favoriteSaved: a.favoriteSaved,
        favoriteChangedAt: a.favoriteChangedAt,
        favoriteSortOrder: a.favoriteSortOrder,
        watchLaterSaved: a.watchLaterSaved,
        watchLaterChangedAt: a.watchLaterChangedAt,
        watchLaterSortOrder: a.watchLaterSortOrder,
        deleted: a.deleted,
        deletedAt: a.deletedAt,
        readingProgress: typeof a.readingProgress === 'number' ? a.readingProgress : 0,
        readingPositionBytes: a.readingPositionBytes,
        readingPositionContentHash: a.readingPositionContentHash,
        readingPositionChangedAt: a.readingPositionChangedAt,
        isRead: a.isRead,
      };
      if (a.imageUrl) item.imageUrl = a.imageUrl;
      if (a.rssSourceUrl) item.rssSourceUrl = a.rssSourceUrl;
      if (a.rssSourceTitle) item.rssSourceTitle = a.rssSourceTitle;
      return item;
    }),
    sources: (sources || []).map((s) => {
      const item = {
        url: s.url,
        sourceDeviceId: s.sourceDeviceId,
        title: s.title,
        description: s.description,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        sortOrder: s.sortOrder,
        isPinned: s.isPinned,
        deleted: s.deleted,
        deletedAt: s.deletedAt,
        useOriginalContent: s.useOriginalContent,
        continuePlaybackInBackground: s.continuePlaybackInBackground,
      };
      if (s.siteUrl) item.siteUrl = s.siteUrl;
      if (s.imageUrl) item.imageUrl = s.imageUrl;
      return item;
    }),
  };
  return util.utf8ToBytes(JSON.stringify(obj));
}

function parseRssState(bytes) {
  const root = JSON.parse(util.bytesToUtf8(bytes));
  if (root.format !== RSS_STATE_FORMAT || root.version !== RSS_STATE_VERSION) {
    throw new Error('云端RSS状态格式不受支持');
  }
  const articles = (Array.isArray(root.articles) ? root.articles : []).map((item) => ({
    articleId: String(item.articleId || ''),
    sourceDeviceId: String(item.sourceDeviceId || ''),
    url: String(item.url || ''),
    title: String(item.title || ''),
    siteName: String(item.siteName || ''),
    excerpt: String(item.excerpt || ''),
    imageUrl: item.imageUrl === undefined || item.imageUrl === null ? null : String(item.imageUrl),
    contentHash: String(item.contentHash || ''),
    importedAt: Number(item.importedAt || 0),
    updatedAt: Number(item.updatedAt || 0),
    rssSourceUrl: item.rssSourceUrl === undefined || item.rssSourceUrl === null ? null : String(item.rssSourceUrl),
    rssSourceTitle: item.rssSourceTitle === undefined || item.rssSourceTitle === null ? null : String(item.rssSourceTitle),
    independentSaved: !!item.independentSaved,
    independentChangedAt: Number(item.independentChangedAt || 0),
    independentSortOrder: Number(item.independentSortOrder || 0),
    favoriteSaved: !!item.favoriteSaved,
    favoriteChangedAt: Number(item.favoriteChangedAt || 0),
    favoriteSortOrder: Number(item.favoriteSortOrder || 0),
    watchLaterSaved: !!item.watchLaterSaved,
    watchLaterChangedAt: Number(item.watchLaterChangedAt || 0),
    watchLaterSortOrder: Number(item.watchLaterSortOrder || 0),
    deleted: !!item.deleted,
    deletedAt: Number(item.deletedAt || 0),
    readingProgress: optFiniteProgress(item, 'readingProgress'),
    readingPositionBytes: Number(item.readingPositionBytes || 0),
    readingPositionContentHash: String(item.readingPositionContentHash || ''),
    readingPositionChangedAt: Number(item.readingPositionChangedAt || 0),
    isRead: !!item.isRead,
  })).filter((a) => a.articleId);
  const sources = (Array.isArray(root.sources) ? root.sources : []).map(parseSource).filter(Boolean);
  return { articles, sources, exportedAt: Number(root.exportedAt || 0) };
}

module.exports = {
  LIBRARY_SYNC_VERSION,
  BODY_CHUNK_SIZE,
  encodeBody,
  decodeBody,
  chunkHashesFor,
  metadataHashFor,
  currentSyncMetadata,
  hasCurrentSyncMetadata,
  withCurrentSyncMetadata,
  buildLibrarySync,
  buildLibrarySyncAsync,
  parseLibrarySync,
  articleToJson,
  buildRssState,
  parseRssState,
};

const taskProbe=require('./longtask');if(taskProbe.instrument)taskProbe.instrument(module.exports,'payload');
