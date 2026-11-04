// 库合并语义：与 Android_WatchRSS_Phone PhoneCompanionRepository 的
// mergeArticleByLatest / mergeRssSourcesFromSync / mergeArticlesFromSync(retainsLocalBody) 一致
// 文章对象为 payload.parse* 产出的纯 JS 对象

// 与手机端 ImportedContentIds.isImportedContentUrl 一致：
// 导入内容走 https://watchrss.local/{import-content|import-epub|import-txt-novel}/...
// （旧版 watchrss:// 自定义 scheme 保留兼容）
function isImportedContentUrl(value) {
  if (!value) return false;
  const v = String(value).trim().toLowerCase();
  if (!v) return false;
  return (
    v.indexOf('watchrss://') === 0 ||
    v.indexOf('watchrss-txt://') === 0 ||
    v.indexOf('watchrss-epub://') === 0 ||
    v.indexOf('https://watchrss.local/') === 0
  );
}

// 与手机端 ImportedContentIds 对齐的导入内容 URL
const IMPORT_CONTENT_ROOT = 'https://watchrss.local/import-content';
const IMPORT_TXT_PREFIX = IMPORT_CONTENT_ROOT + '/txt/';
const NOVEL_SOURCE_PREFIXES = [
  'https://watchrss.local/import-txt-novel/',
  'https://watchrss.local/import-epub/',
];

function isNovelSourceUrl(rssSourceUrl) {
  const v = String(rssSourceUrl || '').trim().toLowerCase();
  return NOVEL_SOURCE_PREFIXES.some((p) => v.indexOf(p) === 0);
}

// “导入内容”列表语义（与 PhoneArticleDao.observeImportedContentArticles 一致）：
// 网页/TXT 文件导入（import-content 根源 或 /txt/ 文章）；
// 已作为频道导入的小说（TXT/EPUB）不在这里出现
function isImportedContentArticle(article) {
  if (!article || article.deleted) return false;
  const rssSource = String(article.rssSourceUrl || '').trim();
  if (rssSource.toLowerCase() === IMPORT_CONTENT_ROOT) return true;
  const url = String(article.url || '').trim().toLowerCase();
  if (url.indexOf(IMPORT_TXT_PREFIX) === 0) return true;
  // 旧 scheme 兼容：导入内容且不属于小说频道
  if (isImportedContentUrl(url) && !isNovelSourceUrl(article.rssSourceUrl)) return true;
  return false;
}

// Mini-program imports include both standalone files and novel source chapters.
function isImportedLibraryArticle(article) {
  return !!article && !article.deleted && (isImportedContentArticle(article) ||
    isImportedContentUrl(article.url) || isImportedContentUrl(article.rssSourceUrl));
}

function latestOperationAt(article) {
  return Math.max(
    article.updatedAt || 0,
    article.independentChangedAt || 0,
    article.favoriteChangedAt || 0,
    article.watchLaterChangedAt || 0,
    article.deletedAt || 0
  );
}

function isStateNewer(own, other, type) {
  const ownChangedAt = type === 'favorite' ? own.favoriteChangedAt || 0 : own.watchLaterChangedAt || 0;
  const otherChangedAt = type === 'favorite' ? other.favoriteChangedAt || 0 : other.watchLaterChangedAt || 0;
  if (ownChangedAt > otherChangedAt) return true;
  if (ownChangedAt === otherChangedAt) return String(own.sourceDeviceId || '') > String(other.sourceDeviceId || '');
  return false;
}

function isIndependentNewer(own, other) {
  const a = own.independentChangedAt || 0;
  const b = other.independentChangedAt || 0;
  if (a > b) return true;
  if (a === b) return String(own.sourceDeviceId || '') > String(other.sourceDeviceId || '');
  return false;
}

function clampProgress(value) {
  if (typeof value !== 'number' || !isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// Same rule as cv2-phone CloudArticleStateMerge.mergeReadFlag.
function mergeReadFlag(local,remote){
 const a=Number(local.readingPositionChangedAt)||Number(local.updatedAt)||0,b=Number(remote.readingPositionChangedAt)||Number(remote.updatedAt)||0;
 if(a!==b)return !!(b>a?remote.isRead:local.isRead);
 const own=String(local.sourceDeviceId||''),other=String(remote.sourceDeviceId||'');
 if(own!==other)return !!(other>own?remote.isRead:local.isRead);
 return !!local.isRead&&!!remote.isRead;
}

// 与 mergeArticleByLatest 一致（默认 KEEP_LATEST 策略）
function mergeArticleByLatest(local, remote) {
  const provenance=require('./article-provenance');if(provenance.protectedValue(local)||provenance.protectedValue(remote))return provenance.mergeValues(local,remote);
  const metadata = (remote.updatedAt || 0) > (local.updatedAt || 0) ? remote : local;

  const favoriteFromRemote = isStateNewer(remote, local, 'favorite');
  const watchLaterFromRemote = isStateNewer(remote, local, 'watch-later');
  const independentFromRemote = isIndependentNewer(remote, local);

  const favoriteSaved = favoriteFromRemote ? remote.favoriteSaved : local.favoriteSaved;
  const favoriteChangedAt = favoriteFromRemote ? remote.favoriteChangedAt : local.favoriteChangedAt;
  const favoriteSortOrder = favoriteFromRemote ? remote.favoriteSortOrder : local.favoriteSortOrder;
  const watchLaterSaved = watchLaterFromRemote ? remote.watchLaterSaved : local.watchLaterSaved;
  const watchLaterChangedAt = watchLaterFromRemote ? remote.watchLaterChangedAt : local.watchLaterChangedAt;
  const watchLaterSortOrder = watchLaterFromRemote ? remote.watchLaterSortOrder : local.watchLaterSortOrder;
  const independentSaved = independentFromRemote ? remote.independentSaved : local.independentSaved;
  const independentChangedAt = independentFromRemote ? remote.independentChangedAt : local.independentChangedAt;
  const independentSortOrder = independentFromRemote ? remote.independentSortOrder : local.independentSortOrder;

  const remoteContentIsSelected =
    remote.contentHash === metadata.contentHash && local.contentHash !== metadata.contentHash;
  const localContentIsSelected =
    local.contentHash === metadata.contentHash && remote.contentHash !== metadata.contentHash;
  const remoteReadingPositionNewer =
    remoteContentIsSelected ||
    (!localContentIsSelected && (remote.readingPositionChangedAt || 0) > (local.readingPositionChangedAt || 0));
  const localReadingPositionNewer =
    localContentIsSelected ||
    (!remoteContentIsSelected && (local.readingPositionChangedAt || 0) > (remote.readingPositionChangedAt || 0));

  let readingProgress;
  let readingPositionBytes;
  let readingPositionContentHash;
  let readingPositionChangedAt;
  if (remoteReadingPositionNewer) {
    readingProgress = remote.readingProgress;
    readingPositionBytes = remote.readingPositionBytes;
    readingPositionContentHash = remote.readingPositionContentHash;
    readingPositionChangedAt = remote.readingPositionChangedAt;
  } else if (localReadingPositionNewer) {
    readingProgress = local.readingProgress;
    readingPositionBytes = local.readingPositionBytes;
    readingPositionContentHash = local.readingPositionContentHash;
    readingPositionChangedAt = local.readingPositionChangedAt;
  } else {
    readingProgress = Math.max(local.readingProgress || 0, remote.readingProgress || 0);
    readingPositionBytes =
      (remote.readingProgress || 0) > (local.readingProgress || 0) ? remote.readingPositionBytes : local.readingPositionBytes;
    readingPositionContentHash =
      (remote.readingProgress || 0) > (local.readingProgress || 0) ? remote.readingPositionContentHash : local.readingPositionContentHash;
    readingPositionChangedAt = Math.max(local.readingPositionChangedAt || 0, remote.readingPositionChangedAt || 0);
  }

  const rssSourceUrl = (remote.rssSourceUrl && String(remote.rssSourceUrl).trim())
    ? remote.rssSourceUrl
    : (local.rssSourceUrl && String(local.rssSourceUrl).trim()) ? local.rssSourceUrl : null;
  const rssSourceTitle = (remote.rssSourceTitle && String(remote.rssSourceTitle).trim())
    ? remote.rssSourceTitle
    : (local.rssSourceTitle && String(local.rssSourceTitle).trim()) ? local.rssSourceTitle : null;

  const remoteDeletedNewer =
    (remote.deletedAt || 0) > (local.deletedAt || 0) ||
    ((remote.deletedAt || 0) === (local.deletedAt || 0) && !!remote.deleted && String(remote.sourceDeviceId || '') > String(local.sourceDeviceId || ''));
  const isImported = isImportedContentUrl(rssSourceUrl) || isImportedContentUrl(remote.url) || isImportedContentUrl(local.url);

  // A retained body/snapshot is not a new save operation. A newer tombstone
  // must win even when an older projection still says saved (phone rule).
  const newestDeletionAt = Math.max(local.deleted ? local.deletedAt || 0 : 0, remote.deleted ? remote.deletedAt || 0 : 0);
  const newestLiveOperationAt = Math.max(local.deleted ? 0 : latestOperationAt(local), remote.deleted ? 0 : latestOperationAt(remote));
  let deleted;
  if (newestDeletionAt > 0 && newestDeletionAt >= newestLiveOperationAt) deleted = true;
  else if (favoriteSaved || watchLaterSaved || independentSaved) deleted = false;
  else if (rssSourceUrl && !isImported) deleted = false;
  else if (remoteDeletedNewer) deleted = remote.deleted;
  else deleted = local.deleted;
  const deletedAt = deleted ? Math.max(local.deletedAt || 0, remote.deletedAt || 0) : 0;

  const merged = Object.assign({}, metadata, {
    independentSaved,
    independentChangedAt,
    independentSortOrder,
    rssSourceUrl,
    rssSourceTitle,
    favoriteSaved,
    favoriteChangedAt,
    favoriteSortOrder,
    watchLaterSaved,
    watchLaterChangedAt,
    watchLaterSortOrder,
    deleted,
    deletedAt,
    readingProgress: clampProgress(readingProgress),
    readingPositionBytes: Number(readingPositionBytes || 0),
    readingPositionContentHash: readingPositionContentHash || '',
    readingPositionChangedAt: Number(readingPositionChangedAt || 0),
    isRead: mergeReadFlag(local,remote),
  });
  return merged;
}

// 与 mergeArticlesFromSync 的 retainsLocalBody 一致：
// 远端无正文而本地有正文时，保留本地正文与同步元数据
function prepareRemote(remote, local) {
  const remoteBlank = !remote.contentHtml && !(remote.contentText || '').trim();
  const localHasBody = !!local && (!!local.contentHtml || (local.contentText || '').trim() !== '');
  if (!remoteBlank || !localHasBody || (require('./article-provenance').protectedValue(local)||require('./article-provenance').protectedValue(remote))&&local.contentHash!==remote.contentHash) return remote;
  return Object.assign({}, remote, {
    contentHtml: local.contentHtml,
    contentText: local.contentText,
    syncBodyHash: local.syncBodyHash,
    syncBodyByteCount: local.syncBodyByteCount,
    syncChunkSize: local.syncChunkSize,
    syncChunkHashesJson: local.syncChunkHashesJson,
    syncMetadataHash: local.syncMetadataHash,
  });
}

// 与 isNewerThan 一致
function sourceIsNewer(own, other) {
  if ((own.updatedAt || 0) > (other.updatedAt || 0)) return true;
  if ((own.updatedAt || 0) === (other.updatedAt || 0)) {
    return String(own.sourceDeviceId || '') > String(other.sourceDeviceId || '');
  }
  return false;
}

// 与 mergeRssSourcesFromSync 一致（含 syncedSettingsIncluded 兼容）
function mergeSource(local, remote) {
  let compatibleRemote = remote;
  const syncedSettingsIncluded = remote.__syncedSettingsIncluded === true;
  if (local && !syncedSettingsIncluded) {
    compatibleRemote = Object.assign({}, remote, {
      useOriginalContent: local.useOriginalContent,
      continuePlaybackInBackground: local.continuePlaybackInBackground,
    });
  }
  if (!local || sourceIsNewer(compatibleRemote, local)) return compatibleRemote;
  return local;
}

// 与 mergeCloudState（applyCloudRssState）一致：仅更新已存在文章的同步状态字段
function mergeRssState(local, state) {
  if(require('./article-provenance').protectedValue(local)||require('./article-provenance').protectedValue(state))return require('./article-provenance').mergeValues(local,state);
  const merged = Object.assign({}, local, {
    sourceDeviceId: state.sourceDeviceId || local.sourceDeviceId,
    title: state.title || local.title,
    siteName: state.siteName || local.siteName,
    excerpt: state.excerpt === undefined ? local.excerpt : state.excerpt,
    contentHash: state.contentHash || local.contentHash,
    updatedAt: Math.max(local.updatedAt || 0, state.updatedAt || 0),
    rssSourceUrl: state.rssSourceUrl || local.rssSourceUrl,
    rssSourceTitle: state.rssSourceTitle || local.rssSourceTitle,
    independentSaved: state.independentSaved,
    independentChangedAt: state.independentChangedAt || 0,
    independentSortOrder: state.independentSortOrder || 0,
    favoriteSaved: state.favoriteSaved,
    favoriteChangedAt: state.favoriteChangedAt || 0,
    favoriteSortOrder: state.favoriteSortOrder || 0,
    watchLaterSaved: state.watchLaterSaved,
    watchLaterChangedAt: state.watchLaterChangedAt || 0,
    watchLaterSortOrder: state.watchLaterSortOrder || 0,
    deleted: state.deleted,
    deletedAt: state.deletedAt || 0,
    readingProgress: clampProgress(state.readingProgress),
    readingPositionBytes: Number(state.readingPositionBytes || 0),
    readingPositionContentHash: state.readingPositionContentHash || '',
    readingPositionChangedAt: Number(state.readingPositionChangedAt || 0),
    isRead: state.isRead,
  });
  return merged;
}

module.exports = {
  mergeReadFlag,
  isImportedContentUrl,
  isImportedContentArticle,
  isImportedLibraryArticle,
  isNovelSourceUrl,
  latestOperationAt,
  mergeArticleByLatest,
  prepareRemote,
  sourceIsNewer,
  mergeSource,
  mergeRssState,
  clampProgress,
};
