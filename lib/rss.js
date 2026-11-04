const userError = require('./user-error');
const { URL } = require('../vendor/url');
const backendUrl=require('./backend-url'),sourceIdentity=require('./rss-source-key');
// 服务端 RSS 代理：resolve + entries；条目落库语义与手机 saveImportedSource 一致
const http = require('./http');
const util = require('./util');
const crypto = require('./crypto');
const account = require('./account');
const appaccess = require('./appaccess');
const library = require('./library');
const merge = require('./merge');
const payload = require('./payload');

function authedRequest({ method, path, body }) {
  return appaccess.request({ method, path, body: body === undefined ? null : body });
}

function normalizeSourceUrl(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new Error('请输入 RSS 地址');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new Error('只支持 HTTP/HTTPS RSS 地址');
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed;
  try {
    parsed = backendUrl.parse(withScheme);
  } catch (e) {
    throw Object.assign(new Error('RSS 地址不合法'), { code: 'invalid_rss_url' });
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
    throw new Error('只支持 HTTP/HTTPS RSS 地址');
  }
  return parsed.href.split('#')[0];
}

async function resolveSource(url) {
  const normalizedUrl = normalizeSourceUrl(url);
  if(sourceIdentity.localOnly(normalizedUrl))return{localOnly:true,url:normalizedUrl,title:hostLabel(normalizedUrl),description:'仅本机可用'};
  const res = await authedRequest({ method: 'POST', path: '/functions/v1/rss/sources/resolve', body: { url: normalizedUrl } });
  const source = res.data && res.data.source;
  if (!source || !source.id) throw new Error('RSS 服务返回的订阅源无效');
  return source;
}

async function resolveArticle(url) {
  const normalizedUrl = normalizeSourceUrl(url);
  const res = await authedRequest({
    method: 'POST',
    path: '/functions/v1/rss/articles/resolve',
    body: { url: normalizedUrl },
  });
  const article = res.data && res.data.article;
  if (!article || !article.contentText) throw new Error('网页服务未提取到有效正文');
  return article;
}

// 首页条目内存缓存（5 分钟）：按需取正文与刷新源共享，避免同源重复拉取
const entryCache = new Map(); // sourceId -> { at, data }
const ENTRY_CACHE_TTL = 5 * 60 * 1000;

async function listEntries(sourceId, { limit = '128', cursor = null, useCache = true } = {}) {
  if (!sourceId) throw new Error('RSS 订阅源 ID 无效');
  if (!cursor && useCache) {
    const hit = entryCache.get(`${sourceId}:${limit}`);
    if (hit && Date.now() - hit.at < ENTRY_CACHE_TTL) return hit.data;
  }
  let path = `/functions/v1/rss/sources/${encodeURIComponent(sourceId)}/entries?limit=${encodeURIComponent(limit)}`;
  if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
  const res = await authedRequest({ method: 'GET', path });
  if (!res.data || !Array.isArray(res.data.entries)) {
    throw new Error('RSS 服务返回的条目数据无效');
  }
  if (!cursor) {
    // 只保留最近一页，避免浏览多个源后正文缓存持续累积。
    entryCache.clear();
    const estimate=res.data.entries.reduce((n,row)=>n+Object.values(row).reduce((size,v)=>size+(typeof v==='string'?v.length*3:64),0),0);
    if(useCache&&estimate<=1024*1024)entryCache.set(`${sourceId}:${limit}`, { at: Date.now(), data: res.data });
  }
  return res.data;
}

function invalidateEntries(sourceId) {
  if (sourceId) {for(const key of entryCache.keys())if(key.startsWith(`${sourceId}:`))entryCache.delete(key);}
  else entryCache.clear();
}

// 与 WebArticleImporter.stableArticleId / normalizeForIdentity 一致
function normalizeForIdentity(url) {
  // 显式使用兼容实现，真机不依赖浏览器全局 URL。
  const parsed = backendUrl.parse(String(url).trim());
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  let path = parsed.pathname || '/';
  if (!path) path = '/';
  const query = parsed.search || '';
  return `${scheme}://${host}${path}${query}`;
}

function stableArticleId(url) {
  return crypto.sha256Hex(normalizeForIdentity(url));
}

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

// R41: RSS identity is the backend dedup_key, not the independent-web URL ID.
function canonicalEntryLink(raw){
 try{const url=backendUrl.parse(stringValue(raw));return ['http:','https:'].includes(url.protocol)&&url.hostname?url.href.split('#')[0]:null;}catch(_){return null;}
}
function entryIdentity(entry){
 const guid=stringValue(entry.guid);if(guid)return guid;
 const link=canonicalEntryLink(entry.link||entry.url);if(link)return link;
 const explicitHash=stringValue(entry.contentHash);if(explicitHash)return explicitHash;
 const body=normalizeBodyFields(entry.contentHtml,entry.contentText);
 if(body.contentHtml||body.contentText)return crypto.sha256Hex(body.contentHtml||body.contentText);
 return stringValue(entry.title);
}
function entryArticleId(entry){
 if(!entry||typeof entry!=='object')throw Object.assign(Error('RSS 条目身份无效'),{code:'rss_entry_identity_invalid'});
 if(entry.dedupKey!==undefined&&entry.dedupKey!==null&&entry.dedupKey!==''){
  if(typeof entry.dedupKey!=='string'||!/^[a-f0-9]{64}$/.test(entry.dedupKey))throw Object.assign(Error('RSS 条目身份无效'),{code:'rss_entry_identity_invalid'});
  return entry.dedupKey;
 }
 return crypto.sha256Hex(entryIdentity(entry));
}

// Both pre-R37 and pre-R41 published URL identities are recognized. Pool UUID
// entry.id is used only to reconstruct the old synthetic URL, never the new ID.
function legacyEntryArticleIds(entry,source,article){
 const urls=[article.url],sourceUrl=normalizeSourceUrl(source.url),body=normalizeBodyFields(entry.contentHtml,entry.contentText);let url=stringValue(entry.link||entry.url);
 try{if(url)url=new URL(url,sourceUrl).toString();}catch(_){url='';}
 if(!url){const key=stringValue(entry.id||entry.guid||entry.dedupKey)||crypto.sha256Hex(stringValue(entry.title)||body.contentHtml||body.contentText).slice(0,16);url=sourceUrl+(sourceUrl.includes('?')?'&':'?')+'watchrss_entry='+encodeURIComponent(key);}
 urls.push(url);const ids=new Set();
 for(const value of urls){try{const parsed=new URL(value),host=parsed.hostname.toLowerCase().replace(/^www\./,'');ids.add(crypto.sha256Hex(parsed.protocol.toLowerCase()+'//'+host+(parsed.pathname||'/')+(parsed.search||'')));ids.add(stableArticleId(value));}catch(_){/* non-web URL had no valid URL identity */}}
 ids.delete(article.articleId);return Array.from(ids);
}
function migrateLegacyEntries(entries,source,articles){
 const present=new Set(library.listArticleViews({includeDeleted:true}).map(article=>article.articleId)),mappings=[];
 entries.forEach((entry,index)=>{const article=articles[index];if(!article)return;for(const oldId of legacyEntryArticleIds(entry,source,article))if(present.has(oldId))mappings.push({oldId,newId:article.articleId,sourceUrl:source.url});});
 return mappings.length?library.migrateRssArticleIds(mappings):0;
}

// 部分 RSS 服务会把 HTML 摘要放进 contentText。只识别明确的正文标签，
// 避免把包含比较符号或尖括号的普通文本误当成 HTML。
function normalizeBodyFields(contentHtml, contentText) {
  const html = stringValue(contentHtml);
  const text = contentText === undefined || contentText === null ? '' : String(contentText);
  const structuralHtml = /<(p|div|article|section|h[1-6]|blockquote|pre|ul|ol|li|table)\b[^>]*>[\s\S]*<\/\1\s*>/i;
  return {
    contentHtml: html || (structuralHtml.test(text) ? text.trim() : null),
    contentText: text,
  };
}

function timestampOf(entry, now, index) {
  // 后端对无发布时间的条目提供 discoveredAt；使用它可避免每次刷新制造假更新。
  for (const value of [entry.publishedAt, entry.discoveredAt]) {
    if (!value) continue;
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return now - index;
}

// 条目 → 本地文章（saveImportedSource 等价语义）
function entryToArticle(entry, source, { now = Date.now(), index = 0 } = {}) {
  if (!entry || typeof entry !== 'object') throw new Error('RSS 条目数据无效');
  const sourceUrl = normalizeSourceUrl(source && source.url);
  const { contentHtml, contentText } = normalizeBodyFields(entry.contentHtml, entry.contentText);
  const articleId=entryArticleId(entry);
  const entryId = stringValue(entry.guid) || articleId;
  const rawLink = stringValue(entry.link || entry.url);
  let articleUrl = rawLink;
  if (articleUrl) {
    try { articleUrl = backendUrl.parse(articleUrl, sourceUrl).href; } catch (e) { articleUrl = ''; }
  }
  if (!articleUrl) {
    const key = entryId || crypto.sha256Hex(stringValue(entry.title) || contentHtml || contentText).slice(0, 16);
    articleUrl = `${sourceUrl}${sourceUrl.indexOf('?') >= 0 ? '&' : '?'}watchrss_entry=${encodeURIComponent(key)}`;
  }
  const contentHash = stringValue(entry.contentHash) || crypto.sha256Hex(contentHtml || contentText);
  const timestamp = timestampOf(entry, now, index);
  return {
    articleId,
    sourceDeviceId: '',
    url: articleUrl,
    title: stringValue(entry.title) || articleUrl,
    siteName: stringValue(source && source.title),
    excerpt: stringValue(entry.excerpt),
    contentHtml,
    contentText,
    imageUrl: stringValue(entry.imageUrl) || null,
    contentHash,
    importedAt: timestamp,
    updatedAt: timestamp,
    independentSaved: false,
    independentChangedAt: 0,
    independentSortOrder: 0,
    rssSourceUrl: sourceUrl,
    rssSourceTitle: stringValue(source && source.title),
    favoriteSaved: false,
    favoriteChangedAt: 0,
    favoriteSortOrder: 0,
    watchLaterSaved: false,
    watchLaterChangedAt: 0,
    watchLaterSortOrder: 0,
    deleted: false,
    deletedAt: 0,
    readingProgress: 0,
    readingPositionBytes: 0,
    readingPositionContentHash: '',
    readingPositionChangedAt: 0,
    isRead: false,
    syncBodyHash: '',
    syncBodyByteCount: 0,
    syncChunkSize: 0,
    syncChunkHashesJson: '',
    syncMetadataHash: '',
  };
}

// 拉取源条目并合并入本地库；返回 { source, merged, count }
async function refreshSource(sourceUrl, { limit = '128', keepBody = false, metadataOnly = false, subscribe = false } = {}) {
  const owner=account.getUsableSession(),backend=require('../config').backendBaseUrl;
  const check=()=>{const now=account.getUsableSession();if((now&&now.userId)!==(owner&&owner.userId)||backend!==require('../config').backendBaseUrl)throw Object.assign(Error('账号已切换'),{code:'cloud_session_changed'});};
  const requestedUrl = normalizeSourceUrl(sourceUrl);
  const initial=library.getSource(requestedUrl);
  if(initial?.deleted&&!subscribe)return{skipped:true,reason:'unsubscribed',count:0};
  if(sourceIdentity.localOnly(requestedUrl)){
    if(subscribe){const now=Date.now();library.upsertSource({...initial,url:requestedUrl,title:initial?.title||hostLabel(requestedUrl),deleted:false,deletedAt:0,updatedAt:Math.max(now,(initial?.deletedAt||0)+1)});}
    return{skipped:true,reason:'local_only',localOnly:true,count:0};
  }
  const source = await resolveSource(requestedUrl);check();
  const currentSource=library.getSource(requestedUrl);
  if(currentSource?.deleted&&!(subscribe&&initial?.deleted&&currentSource.deletedAt===initial.deletedAt))return{skipped:true,reason:'unsubscribed',count:0};
  // 与安卓 refreshRssSource 一致：保留用户订阅的 URL，避免重定向后生成两个频道。
  const localUrl = library.getSource(requestedUrl) ? requestedUrl : normalizeSourceUrl(source.url || requestedUrl);
  const existing = library.getSource(localUrl);
  const now = Date.now();
  // 源元数据更新（与 saveImportedSource 的 candidate/existing 规则一致）
  const candidate = {
    url: localUrl,
    sourceId:source.id,
    sourceDeviceId: existing ? existing.sourceDeviceId : device.localId(),
    title: existing ? existing.title : source.title || hostLabel(source.url),
    description: source.description || '',
    siteUrl: source.siteUrl || null,
    imageUrl: source.imageUrl || null,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: Math.max(now,(existing?.deletedAt||0)+1),
    sortOrder: existing && existing.sortOrder > 0 ? existing.sortOrder : now,
    isPinned: existing ? existing.isPinned : false,
    deleted: false,
    deletedAt: 0,
    useOriginalContent: existing ? existing.useOriginalContent : false,
    continuePlaybackInBackground: existing ? existing.continuePlaybackInBackground : false,
  };
  const keepMeta =
    existing &&
    !existing.deleted;
  const nextSource = keepMeta
    ? Object.assign({}, candidate, { sourceDeviceId: existing.sourceDeviceId, updatedAt: existing.updatedAt })
    : candidate;
  library.upsertSource(nextSource);

  if(metadataOnly)return {source:nextSource,merged:0,count:0,nextCursor:null};

  invalidateEntries(source.id);
  const result = await listEntries(source.id, { limit, useCache: false });check();
  const entries = Array.isArray(result.entries) ? result.entries : [];
  let skippedEntries=0;const projected=entries.map((entry,index)=>{try{return entryToArticle(entry,{url:localUrl,title:nextSource.title},{now,index});}catch(_){skippedEntries++;return null;}});
  const migrated=migrateLegacyEntries(entries,{url:localUrl,title:nextSource.title},projected);
  const cachedArticles=new Map(library.listArticleViews({includeDeleted:true}).map(article=>[article.articleId,article]));
  const articles = projected.map(article => {
    if(!article)return null;
    const current=cachedArticles.get(article.articleId);
    if(current){
      // Public cache clocks never manufacture or erase a user interaction.
      for(const field of require('./rss-cloud').READ_FIELDS)article[field]=current[field];
      if(current.favoriteSaved||current.watchLaterSaved){
        // Saved originals remain the saved version even when the public pool changes.
        for(const field of ['title','siteName','excerpt','imageUrl','contentHash','importedAt','updatedAt','rssSourceTitle'])article[field]=current[field];
      }
    }
    // 列表页只需要索引；正文按需获取（merge 时保留本地已有正文）
    return keepBody ? article : Object.assign({}, article, { contentHtml: null, contentText: '' });
  }).filter(Boolean);
  const merged = await (library.mergeArticlesAsync||library.mergeArticles)(articles.map((a) => payload.withCurrentSyncMetadata(a)));
  library.applyRssInteractions();
  return { source: nextSource, merged, migrated, skippedEntries, count: entries.length, nextCursor: result.nextCursor || null };
}

async function refreshSources(sources, { concurrency = 4, onProgress } = {}) {
  const queue = Array.isArray(sources) ? sources.filter(source=>!source.deleted&&!sourceIdentity.localOnly(source.url)) : [];
  const failures = [];
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      const source = queue[index];
      try {
        await refreshSource(source.url, { limit: '128' });
      } catch (error) {
        failures.push({
          url: source.url,
          title: source.title || hostLabel(source.url),
          error,
        });
      }
      done += 1;
      if (onProgress) onProgress({ done, total: queue.length, source, failures: failures.slice() });
      await util.tick();
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, () => worker()));
  return { done, total: queue.length, failures };
}

function formatRefreshFailures(failures, maximum = 2) {
  if (!failures || !failures.length) return '';
  const details = failures.slice(0, maximum).map(({ title, error }) => {
    const reason = userError.message(error, '订阅源暂时无法更新，请稍后重试。');
    return `${title}：${reason}`;
  });
  const remaining = failures.length - details.length;
  return `更新失败 ${failures.length} 个：${details.join('；')}${remaining > 0 ? `；另 ${remaining} 个` : ''}`;
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return url;
  }
}

// 设备本地 ID（源/文章的 sourceDeviceId 归属）
const device = {
  localId() {
    // 复用 license 设备 ID 作为云同步 deviceId
    return require('./device').deviceId();
  },
};

module.exports = {
  normalizeSourceUrl,
  resolveSource,
  resolveArticle,
  listEntries,
  invalidateEntries,
  normalizeForIdentity,
  stableArticleId,
  canonicalEntryLink,entryIdentity,entryArticleId,legacyEntryArticleIds,migrateLegacyEntries,
  normalizeBodyFields,
  entryToArticle,
  refreshSource,
  refreshSources,
  formatRefreshFailures,
  hostLabel,
};
