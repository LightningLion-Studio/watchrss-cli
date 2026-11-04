// 按需正文获取：索引-only 云同步后，本地文章可能没有正文。
// 进入文章时按来源获取：
//  - RSS 源文章：后端 RSS 代理 entries（直接携带 contentHtml，最多翻页 4 次）
//  - 私有/导入文章（watchrss:// 等，正文只存在于中继库）：downloadRelayLibrary
// 获取结果走 library.mergeArticles 统一合并（与刷新源同一语义，保留本地状态字段）。
const library = require('./library');
const rss = require('./rss');
const merge = require('./merge');
const payload = require('./payload');
const sync = require('./sync');
const account = require('./account');
const device = require('./device');

const MAX_ENTRY_PAGES = 4;

// R41: match the backend dedup_key, including GUID-only items; UUID entry.id is not a GUID.
function findEntryForArticle(entries, article, sourceUrl) {
  const candidate = (e) => {
    try {
      return rss.entryToArticle(e, { url: sourceUrl, title: '' }, {}).articleId;
    } catch (e) {
      return null;
    }
  };
  let match = entries.find((e) => candidate(e) === article.articleId);
  if (!match) match = entries.find((e) => (e.link || e.url) === article.url);
  return match || null;
}

async function applyMergedArticle(remoteRaw) {
  await (library.mergeArticlesAsync||library.mergeArticles)([payload.withCurrentSyncMetadata(remoteRaw)]);
  const merged = library.getArticle(remoteRaw.articleId);
  // mergeArticleByLatest 在 updatedAt 平局时以本地为 metadata；本地是索引 stub（无正文）
  // 而远端带正文时，需反向回填（prepareRemote 只覆盖相反方向）
  if (merged && !library.hasBody(merged) && library.hasBody(remoteRaw)) {
    const filled = Object.assign({}, merged, {
      contentHtml: remoteRaw.contentHtml || null,
      contentText: remoteRaw.contentText || '',
      contentHash: remoteRaw.contentHash || merged.contentHash,
    });
    await (library.upsertArticleAsync||library.upsertArticle)(filled);
    return filled;
  }
  return merged;
}

async function ensureArticleBody(article, { onProgress } = {}) {
  if (!article) throw new Error('文章不存在');
  if (library.hasBody(article)) return { source: 'local', article };

  const rssUrl = article.rssSourceUrl ? String(article.rssSourceUrl).trim() : '';
  const imported = merge.isImportedContentUrl(rssUrl) || merge.isImportedContentUrl(article.url);

  if (rssUrl && !imported) {
    const blocked=library.getSource(rssUrl)?.deleted||require('./rss-source-key').localOnly(rssUrl);
    if(blocked||library.legacyRssArticleIds(article.articleId).length){
      const archived=await require('./cloud-reader').open(article,require('./online-reader').toText,{archiveOnly:true});
      if(archived){try{const parts=[];for(let page=0;page<archived.totalPages;page++)parts.push(await archived.read(page));const text=parts.join('');if(text.trim())return{source:'private-archive',article:await applyMergedArticle({...article,contentText:text,contentHtml:null})};}finally{archived.close();}}
      if(blocked)throw Object.assign(Error('已退订频道的原文尚未备份'),{code:'cloud_saved_body_missing'});
    }
    const source = await rss.resolveSource(rssUrl);
    let cursor = null;
    for (let page = 0; page < MAX_ENTRY_PAGES; page += 1) {
      const result = await rss.listEntries(source.id, { limit: '128', cursor });
      const entries = Array.isArray(result.entries) ? result.entries : [];
      const entry = findEntryForArticle(entries, article, rssUrl);
      if (entry) {
        if (onProgress) onProgress('applying');
        const remote = rss.entryToArticle(entry, { url: rssUrl, title: source.title || '' }, {});
        return { source: 'rss', article: await applyMergedArticle(remote) };
      }
      cursor = result.nextCursor || null;
      if (!cursor || entries.length === 0) break;
      if (onProgress) onProgress('fetching');
    }
    if (onProgress) onProgress('original');
    if(!rss.canonicalEntryLink(article.url))throw Object.assign(Error('收藏原文暂未取得'),{code:'cloud_saved_body_missing'});
    const original = await rss.resolveArticle(article.url);
    const remote = Object.assign({}, article, {
      contentHtml: original.contentHtml || null,
      contentText: original.contentText || '',
      contentHash: original.contentHash || article.contentHash,
      imageUrl: original.imageUrl || article.imageUrl || null,
    });
    const merged = await applyMergedArticle(remote);
    if (!library.hasBody(merged)) throw new Error('原网页未提取到有效正文');
    return { source: 'original', article: merged };
  }

  // Explicit watch export may fetch the complete newly imported text. Online
  // reading itself never calls this full-body path.
  if (/^watchrss:\/\/import\/(?:online-v1|instance-v1)\//.test(String(article.url))) {
    const reader = await require('./online-reader').open(article);
    try {
      const parts=[];
      for(let page=0;page<reader.totalPages;page++) {
        parts.push(await reader.read(page));
        if(onProgress) onProgress('fetching');
      }
      return {source:'encrypted-reader',article:await applyMergedArticle(Object.assign({},article,{contentText:parts.join(''),contentHtml:null}))};
    } finally { reader.close(); }
  }

  // Prefer authenticated private archives/reader objects; legacy relay is read-only.
  const archived=await require('./cloud-reader').open(article,require('./online-reader').toText,{archiveOnly:true});
  if(archived){try{const parts=[];for(let page=0;page<archived.totalPages;page++)parts.push(await archived.read(page));const text=parts.join('');if(text.trim())return{source:'private-archive',article:await applyMergedArticle({...article,contentText:text,contentHtml:null})};}finally{archived.close();}}
  // Old relay remains a read-only transition path.

  const session = account.getUsableSession();
  if (!session) throw new Error('请先登录账号');
  if (onProgress) onProgress('relay');
  const relay = await sync.downloadRelayLibrary(session.userId, device.deviceId(), onProgress);
  const remote = (relay.articles || []).find((a) => a.articleId === article.articleId);
  if (!remote || (!remote.contentHtml && !(remote.contentText || '').trim())) {
    throw new Error('云端暂无该文章正文');
  }
  const merged = await applyMergedArticle(remote);
  if (!library.hasBody(merged)) throw new Error('云端暂无该文章正文');
  return { source: 'relay', article: merged };
}

module.exports = { ensureArticleBody, findEntryForArticle, MAX_ENTRY_PAGES };
