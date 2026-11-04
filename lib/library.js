// 本地库：文章 / RSS 源 / 收藏 / 稍后看 / 已读 状态
// 存储：lib/articles.json + lib/sources.json（storage.root 文件系统）
const storage = require('./storage');
const payload = require('./payload');
const merge = require('./merge');
const util = require('./util');
const provenance=require('./article-provenance');

let ARTICLES_PATH = 'lib/articles.json';
let SOURCES_PATH = 'lib/sources.json';
let INDEX_PATH = 'lib/article-index-v2.json';
let indexCache = null;
const INDEX_FIELDS = ['url','title','siteName','excerpt','imageUrl','contentHash','importedAt','rssSourceUrl','rssSourceTitle','__bodyFile','__privateBodyClock','__privateBodyTracked'];
let ARTICLE_STATE_PATH = 'lib/article-state.json';
let RSS_INTERACTIONS_PATH='lib/rss-interactions.json';
let stateJournal = null;
const metadataCache = new WeakMap();
const STATE_FIELDS = ['registerSources','__articleProvenanceV1','__articleRegisterLegacyV1','__articlePendingEdits','articleId', 'sourceDeviceId', 'updatedAt', 'favoriteSaved', 'favoriteChangedAt', 'favoriteSortOrder', 'watchLaterSaved', 'watchLaterChangedAt', 'watchLaterSortOrder', 'independentSaved', 'independentChangedAt', 'independentSortOrder', 'isRead', 'readingProgress', 'readingPositionBytes', 'readingPositionContentHash', 'readingPositionChangedAt', 'deleted', 'deletedAt'];
let DIRTY_PATH = 'state/library_dirty.json';
let articlesCache = null;
let sourcesCache = null;

let activeOwner=null,rssAliasCache=null,recoveringRssId=false;
function resetOwner(){rssAliasCache=null;activeOwner=null;articlesCache=null;sourcesCache=null;indexCache=null;stateJournal=null;ensureOwner();}
function ensureOwner() {
  const session=require('./account').getUsableSession();
  if(!session){
    if(activeOwner==='')return;
    // Legacy unclaimed local libraries keep their import path until first login.
    // Once claimed, an anonymous session must never read that owner's files.
    if(activeOwner===null && !storage.readJSON('state/library-owner.json',null))return;
    ARTICLES_PATH='lib/guest/articles.json';SOURCES_PATH='lib/guest/sources.json';INDEX_PATH='lib/guest/article-index-v2.json';ARTICLE_STATE_PATH='lib/guest/article-state.json';RSS_INTERACTIONS_PATH='lib/guest/rss-interactions.json';DIRTY_PATH='state/guest/library_dirty.json';
    articlesCache=null;sourcesCache=null;indexCache=null;stateJournal=null;rssAliasCache=null;activeOwner='';return;
  }
  if(session.userId===activeOwner)return;
  const id=String(session.userId || '');if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw new Error('账号身份无效，请重新登录');
  let marker=storage.readJSON('state/library-owner.json',null);
  if(!marker){marker={primaryUserId:id};storage.writeJSON('state/library-owner.json',marker);}
  const prefix=id===marker.primaryUserId?'lib':`lib/accounts/${id}`;
  ARTICLES_PATH=`${prefix}/articles.json`;SOURCES_PATH=`${prefix}/sources.json`;INDEX_PATH=`${prefix}/article-index-v2.json`;ARTICLE_STATE_PATH=`${prefix}/article-state.json`;RSS_INTERACTIONS_PATH=`${prefix}/rss-interactions.json`;
  DIRTY_PATH=id===marker.primaryUserId?'state/library_dirty.json':`state/accounts/${id}/library_dirty.json`;
  articlesCache=null;sourcesCache=null;indexCache=null;stateJournal=null;rssAliasCache=null;activeOwner=id;
}

// Local data belongs to an account until a local, explicit transfer decision.
function uploadOwnershipStatus(){
  ensureOwner();const session=require('./account').getUsableSession();if(!session)throw Error('请先登录账号');
  const backend=require('./cloud-scope').backend();let marker=storage.readJSON('state/library-owner.json',null)||{primaryUserId:session.userId};
  if(!marker.ownerUserId){marker={...marker,ownerUserId:session.userId,ownerBackendBaseUrl:backend};storage.writeJSON('state/library-owner.json',marker);}
  return{ownerUserId:marker.ownerUserId,userId:session.userId,needsChoice:marker.ownerUserId!==session.userId||marker.ownerBackendBaseUrl!==backend};
}
function assertUploadOwner(){const state=uploadOwnershipStatus();if(state.needsChoice)throw Object.assign(Error('请先选择清空本机资料或合并到新账号'),{code:'cloud_library_owner_choice_required'});}
function chooseUploadOwner(choice){
  if(!['clear','merge'].includes(choice))throw Error('请选择资料库归属');
  const status=uploadOwnershipStatus();if(!status.needsChoice)return status;
  const marker=storage.readJSON('state/library-owner.json',null),oldPrefix=marker.ownerUserId===marker.primaryUserId?'lib':`lib/accounts/${marker.ownerUserId}`;
  const journal=storage.readJSON(oldPrefix+'/article-state.json',{})||{};
  const oldArticles=(storage.readJSON(oldPrefix+'/articles.json',[])||[]).map(row=>Object.assign({},row,journal[row.articleId]||{})),oldSources=storage.readJSON(oldPrefix+'/sources.json',[])||[];
  if(choice==='merge'){
    // An explicit local action is the only path that imports the former owner.
    mergeArticles(oldArticles);mergeSources(oldSources);require('./books').transfer(oldPrefix,'merge');markDirty();
  }else{
    require('./books').transfer(oldPrefix,'clear');
    for(const name of new Set([ARTICLES_PATH,SOURCES_PATH,INDEX_PATH,ARTICLE_STATE_PATH,DIRTY_PATH,...['articles.json','sources.json','article-index-v2.json','article-state.json'].map(name=>oldPrefix+'/'+name),marker.ownerUserId===marker.primaryUserId?'state/library_dirty.json':`state/accounts/${marker.ownerUserId}/library_dirty.json`]))storage.deleteFile(name);
    articlesCache=null;sourcesCache=null;indexCache=null;stateJournal=null;
    const cloudScope=require('./cloud-scope');for(const kind of ['sync','library','records','records-checkpoint','exchange','operations','quarantine','latest-manifest'])storage.deleteFile(cloudScope.path(kind,status.userId));
    require('./cloud-library').resetSession();
  }
  storage.writeJSON('state/library-owner.json',{...marker,ownerUserId:status.userId,ownerBackendBaseUrl:require('./cloud-scope').backend()});
  return uploadOwnershipStatus();
}

// 本地库脏标志：任何写入都置脏；成功上传后清除。
// 云同步用它判断"是否需要重新序列化整个库并上传"，避免每次同步都全库重算。
function markDirty() {
  ensureOwner();
  try {
    const previous = storage.readJSON(DIRTY_PATH, null);
    storage.writeJSON(DIRTY_PATH, { at: Math.max(Date.now(), (previous && previous.at || 0) + 1) });
  } catch (e) {
    /* 忽略：上传路径仍会按内容判断 */
  }
}
function isDirty() {
  ensureOwner();
  return !!storage.readJSON(DIRTY_PATH, null);
}
function dirtyRevision() {
  ensureOwner(); const value = storage.readJSON(DIRTY_PATH, null); return value && value.at || 0; }
function clearDirty(expectedRevision = null) {
  ensureOwner();
  if (expectedRevision !== null && dirtyRevision() !== expectedRevision) return false;
  try {
    storage.deleteFile(DIRTY_PATH);
  } catch (e) {
    /* ignore */
  }
}

function defaultArticle(articleId) {
  return {
    articleId,
    sourceDeviceId: '',
    url: '',
    title: '',
    siteName: '',
    excerpt: '',
    contentHtml: null,
    contentText: '',
    imageUrl: null,
    contentHash: '',
    importedAt: 0,
    updatedAt: 0,
    independentSaved: false,
    independentChangedAt: 0,
    independentSortOrder: 0,
    rssSourceUrl: null,
    rssSourceTitle: null,
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

// R41 local rekey: a write-ahead row protects bodies/state until replacement
// and alias-dependent journals are durable. Recovery runs before any library read.
function rssIdPath(name){return ARTICLES_PATH.replace(/articles\.json$/,name+'.json');}
function rssAliases(){ensureOwner();if(rssAliasCache===null)rssAliasCache=storage.readJSON(rssIdPath('rss-id-aliases'),{})||{};return rssAliasCache;}
function canonicalRssArticleId(id){
 ensureOwner();recoverRssIdMigration();const aliases=rssAliases(),seen=new Set();
 while(aliases[id]&&!seen.has(id)){seen.add(id);id=aliases[id];}return id;
}
function legacyRssArticleIds(id){const current=canonicalRssArticleId(id);return Object.keys(rssAliases()).filter(old=>old!==current&&canonicalRssArticleId(old)===current);}
function canonicalRssArticle(value){return value&&require('./rss-cloud').isPublic(value)?{...value,articleId:canonicalRssArticleId(value.articleId)}:value;}
function mergeRssIdentityRows(old,current,newId){
 const own={...old,articleId:newId};if(!current)return payload.withCurrentSyncMetadata(own);
 const policy=require('./rss-cloud'),next=merge.mergeArticleByLatest(own,current),state=policy.mergeState(policy.stateOf(own,'local-rekey'),policy.stateOf(current,'local-rekey'));
 for(const field of policy.READ_FIELDS)next[field]=state[field];next.sourceDeviceId=state.sourceDeviceId;
 // A freshly cached canonical row has no user event to supersede legacy state.
 if(!current.isRead&&!current.readingProgress&&!current.readingPositionBytes&&!current.readingPositionChangedAt)for(const field of ['isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt'])next[field]=own[field];
 for(const kind of ['favorite','watchLater','independent'])if(!current[kind+'Saved']&&!current[kind+'ChangedAt'])for(const suffix of ['Saved','ChangedAt','SortOrder'])next[kind+suffix]=own[kind+suffix];
 const ownSaved=!!(own.favoriteSaved||own.watchLaterSaved),currentSaved=!!(current.favoriteSaved||current.watchLaterSaved);
 const original=ownSaved&&(!currentSaved||Math.max(own.favoriteChangedAt||0,own.watchLaterChangedAt||0)>Math.max(current.favoriteChangedAt||0,current.watchLaterChangedAt||0))?own:currentSaved?current:hasBody(current)?current:own;
 if(hasBody(original)||original.favoriteSaved||original.watchLaterSaved)for(const field of INDEX_FIELDS.concat(['contentText','contentHtml','updatedAt']))next[field]=original[field];
 next.articleId=newId;return payload.withCurrentSyncMetadata(next);
}
function migrateRssIdentityJournals(items){
 const policy=require('./rss-cloud'),crypto=require('./crypto'),hashes=new Map(items.map(item=>[crypto.sha256Hex(item.oldId),crypto.sha256Hex(item.newId)])),states=storage.readJSON(RSS_INTERACTIONS_PATH,{})||{};let changed=false;
 for(const [key,value]of Object.entries(states))if(hashes.has(value.articleIdHash)){const moved={...value,articleIdHash:hashes.get(value.articleIdHash)},nextKey=value.sourceId+':'+moved.articleIdHash;states[nextKey]=policy.mergeState(moved,states[nextKey]||moved);delete states[key];changed=true;}
 if(changed)storage.writeJSON(RSS_INTERACTIONS_PATH,states);
 const session=require('./account').getUsableSession();if(session){const path=require('./cloud-scope').path('saved-body-retries',session.userId),retry=storage.readJSON(path,null);let moved=false;if(retry&&retry.entries){for(const {oldId,newId}of items)if(retry.entries[oldId]){if(!retry.entries[newId])retry.entries[newId]=retry.entries[oldId];delete retry.entries[oldId];moved=true;}if(moved)storage.writeJSON(path,retry);}}
}
function recoverRssIdMigration(){
 if(recoveringRssId)return;const path=rssIdPath('rss-id-migration'),job=storage.readJSON(path,null);if(!job)return;
 const items=job.items||[job];
 if(job.version!==1||!Array.isArray(items)||items.some(item=>!item.article||!/^[a-f0-9]{64}$/.test(item.oldId)||!/^[a-f0-9]{64}$/.test(item.newId)||item.article.articleId!==item.newId))throw Object.assign(Error('RSS 身份迁移日志无效'),{code:'rss_id_migration_invalid'});
 recoveringRssId=true;
 try{
  const rows=new Map(loadArticles().map(row=>[row.articleId,row])),aliases={...rssAliases()};
  for(const item of items){const article=mergeRssIdentityRows(item.article,rows.get(item.newId),item.newId);rows.delete(item.oldId);rows.set(item.newId,article);aliases[item.oldId]=item.newId;}
  storage.writeJSON(rssIdPath('rss-id-aliases'),aliases);rssAliasCache=aliases;
  writeArticles(Array.from(rows.values()));
  migrateRssIdentityJournals(items);
  markDirty();storage.deleteFile(path);
 }catch(error){articlesCache=null;indexCache=null;stateJournal=null;rssAliasCache=null;throw error;}finally{recoveringRssId=false;}
}
function migrateRssArticleIds(mappings){
 ensureOwner();recoverRssIdMigration();const rows=new Map(loadArticles().map(row=>[row.articleId,row])),items=[];
 for(const mapping of mappings){const {oldId,sourceUrl}=mapping,newId=canonicalRssArticleId(mapping.newId);
  if(oldId===newId||!/^[a-f0-9]{64}$/.test(oldId)||!/^[a-f0-9]{64}$/.test(newId))continue;
  const old=rows.get(oldId),current=rows.get(newId);
  if(!old||old.rssSourceUrl!==sourceUrl||!require('./rss-cloud').isPublic(old)||current&&current.rssSourceUrl!==sourceUrl)continue;
  const article=mergeRssIdentityRows(old,current,newId);items.push({oldId,newId,article});rows.delete(oldId);rows.set(newId,article);
 }
 if(!items.length)return 0;
 storage.writeJSON(rssIdPath('rss-id-migration'),{version:1,items});recoverRssIdMigration();return items.length;
}
function migrateRssArticleId(oldId,newId,sourceUrl){return migrateRssArticleIds([{oldId,newId,sourceUrl}])>0;}

// ---------- 文章 ----------

function stateTimestamp(article) { return Math.max(merge.latestOperationAt(article), Number(article.readingPositionChangedAt || 0)); }

function applyFullPatch(article,patch) {
  if(!patch || stateTimestamp(patch)<stateTimestamp(article))return article;
  const updated=Object.assign({},article);
  for(const key of STATE_FIELDS.concat(INDEX_FIELDS))if(Object.prototype.hasOwnProperty.call(patch,key))updated[key]=patch[key];
  if(patch.__invalidateBody){delete updated.__bodyFile;updated.contentHtml=null;updated.contentText='';updated.syncBodyHash='';updated.syncMetadataHash='';}
  return updated;
}
function loadArticles() {
  ensureOwner();recoverRssIdMigration();
  if(articlesCache===null) {
    const raw=storage.readJSON(ARTICLES_PATH,[]) || [];
    stateJournal=(storage.readMap||storage.readJSON)(ARTICLE_STATE_PATH,{}) || {};
    articlesCache=raw.map(article=>require('./article-body-store').remember(require('./article-body-store').hydrate(applyFullPatch(article,stateJournal[article.articleId]))));
    const ids=new Set(articlesCache.map(a=>a.articleId));
    for(const [id,patch]of Object.entries(stateJournal))if(!ids.has(id) && patch.__indexEntry)articlesCache.push(applyFullPatch(defaultArticle(id),patch));
  }
  return articlesCache;
}

function articleView(article) {
  const view={};
  for(const key of STATE_FIELDS.concat(INDEX_FIELDS)) if(article[key]!==undefined)view[key]=article[key];
  view.__localBody=!!(article.contentHtml || article.contentText || article.__bodyFile);
  return view;
}
function overlayJournal(article) {
  const patch=stateJournal && stateJournal[article.articleId];
  if(!patch || !(stateTimestamp(patch)>stateTimestamp(article)||stateTimestamp(patch)===stateTimestamp(article)&&(patch.registerSources||patch.__articleRegisterLegacyV1||patch.__articlePendingEdits)))return article;
  return applyFullPatch(article,patch);
}
function loadIndex() {
  ensureOwner();recoverRssIdMigration();
  if(indexCache===null) {
    if(stateJournal===null)stateJournal=(storage.readMap||storage.readJSON)(ARTICLE_STATE_PATH,{}) || {};
    const cached=storage.readJSON(INDEX_PATH,null);
    if(Array.isArray(cached))indexCache=cached.map(overlayJournal);
    else {
      // A legacy installation migrates once, after the view has painted.
      indexCache=loadArticles().map(articleView);
      try { storage.writeJSON(INDEX_PATH,indexCache); } catch(error) { /* optional derived cache */ }
    }
  }
  return indexCache;
}
function listArticleViews({includeDeleted=false}={}) {const rows=loadIndex();return includeDeleted?rows:rows.filter(a=>!a.deleted);}
function getArticleView(articleId) {articleId=canonicalRssArticleId(articleId);return loadIndex().find(a=>a.articleId===articleId) || null;}
function cachedArticle(articleId) {ensureOwner();return articlesCache && articlesCache.find(a=>a.articleId===articleId) || null;}
function stateArticles() {return articlesCache===null?loadIndex():articlesCache;}
function writeArticles(articles) {
  ensureOwner();
  // Invalidate the derived index before changing the authoritative body file.
  // If interrupted, the next launch rebuilds it instead of trusting stale rows.
  storage.deleteFile(INDEX_PATH);
  const bodyStore=require('./article-body-store'),prefix=ARTICLES_PATH.slice(0,ARTICLES_PATH.lastIndexOf('/'));
  const persisted=articles.map(article=>bodyStore.persist(article,prefix));
  storage.writeJSON(ARTICLES_PATH,persisted);
  bodyStore.prune();
  articlesCache=articles.map((article,i)=>{
    const row={...article},file=persisted[i].__bodyFile;
    if(file&&bodyStore.available(file))row.__bodyFile=file;
    else if(bodyStore.isPublic(row)){delete row.__bodyFile;row.contentText='';row.contentHtml=null;}
    return bodyStore.remember(row);
  });
  indexCache=articlesCache.map(articleView);
  try { storage.writeJSON(INDEX_PATH,indexCache); } catch(error) { /* body data remains authoritative */ }
  stateJournal={};
  storage.deleteFile(ARTICLE_STATE_PATH);if(storage.clearMap)storage.clearMap(ARTICLE_STATE_PATH);
}

function saveArticles(articles) {
  markDirty();
  writeArticles(articles);
}

function stampPrivateBody(article,old){
 if(provenance.protectedValue(old)){if(hasBody(article)&&article.contentHash!==old.contentHash)throw require('./cloud-format').error();article=provenance.mergeValues(old,{...article,__bodyOnly:true});}
 old=old&&provenance.freezeLegacy(old);
 if(old?.__articleRegisterLegacyV1&&!article.__articleRegisterLegacyV1)article={...article,__articleRegisterLegacyV1:old.__articleRegisterLegacyV1};article=provenance.freezeLegacy(article);
 if(old?.__privateBodyTracked&&article.__privateBodyTracked===undefined)article={...article,__privateBodyTracked:true};
 if(hasBody(article)&&(!old||old.contentHash!==article.contentHash))return{...article,__privateBodyClock:Math.max(Number(article.__privateBodyClock)||0,Number(article.updatedAt)||Date.now())};
 if(old?.__privateBodyClock&&article.__privateBodyClock===undefined)return{...article,__privateBodyClock:old.__privateBodyClock};return article;
}
function upsertArticle(article) {
  article=canonicalRssArticle(article);
  const articles = loadArticles().slice();
  const index = articles.findIndex((a) => a.articleId === article.articleId);
  const old = index >= 0 ? articles[index] : null;
  article=stampPrivateBody(article,old);
  if (index >= 0) articles[index] = article;
  else articles.push(article);
  if (!old || JSON.stringify(old) !== JSON.stringify(article)) markDirty();
  writeArticles(articles);
  return article;
}

// State-only changes must not serialize/write every article and its body.
function saveArticleState(articles, article, updated) {
  markDirty();
  if(provenance.protectedValue(article)){
    // This build is a reader, not a provenance writer. Save the requested edit
    // beside the accepted projection; never manufacture a register operation.
    const edits={...article.__articlePendingEdits};
    for(const group of provenance.REGISTERS.filter(k=>k!=='metadata'))if(provenance.GROUPS[group].some(key=>article[key]!==updated[key]))edits[group]=Object.fromEntries(provenance.GROUPS[group].filter(key=>!key.endsWith('ChangedAt')&&key!=='deletedAt').map(key=>[key,updated[key]]));
    updated={...article,__articlePendingEdits:edits};
  }else{
    const frozen=provenance.freezeLegacy(article);updated={...updated,...(frozen.__articleRegisterLegacyV1?{__articleRegisterLegacyV1:{...frozen.__articleRegisterLegacyV1,registerSources:{...frozen.__articleRegisterLegacyV1.registerSources}}}:{})};
    updated.sourceDeviceId=require('./device').deviceId();
    if(updated.__articleRegisterLegacyV1)for(const group of provenance.REGISTERS.filter(k=>k!=='metadata'))if(provenance.GROUPS[group].some(key=>article[key]!==updated[key])){updated.__articleRegisterLegacyV1.registerSources[group]=updated.sourceDeviceId;if(group==='reading')updated.__articleRegisterLegacyV1.readingPositionChangedAt=updated.readingPositionChangedAt;}
  }
  if (stateJournal === null) stateJournal = (storage.readMap||storage.readJSON)(ARTICLE_STATE_PATH, {}) || {};
  const patch=Object.assign({},stateJournal[updated.articleId] || {});
  for (const key of STATE_FIELDS) if (updated[key] !== undefined) patch[key] = updated[key];
  const next = Object.assign({}, stateJournal, { [updated.articleId]: patch });
  if((updated.favoriteSaved||updated.watchLaterSaved)&&!article.favoriteSaved&&!article.watchLaterSaved){
    const full=articlesCache&&articlesCache.find(a=>a.articleId===updated.articleId);
    const stored=require('./article-body-store').persist({...full,...updated},ARTICLES_PATH.slice(0,ARTICLES_PATH.lastIndexOf('/')));
    if(stored.__bodyFile){patch.__bodyFile=stored.__bodyFile;updated.__bodyFile=stored.__bodyFile;}
  }
  if(storage.patchMap)storage.patchMap(ARTICLE_STATE_PATH,updated.articleId,patch);else storage.writeJSON(ARTICLE_STATE_PATH,next);
  stateJournal=next;
  const cached=metadataCache.get(article);
  if(cached && cached.html===updated.contentHtml && cached.text===updated.contentText)metadataCache.set(updated,cached);
  articles.splice(articles.indexOf(article),1,updated);
  if(indexCache && indexCache!==articles) {
    const at=indexCache.findIndex(a=>a.articleId===updated.articleId);
    if(at>=0)indexCache[at]=articleView(updated);
  }
  return updated;
}

function getArticle(articleId) {
  articleId=canonicalRssArticleId(articleId);
  const articles = loadArticles();
  return articles.find((a) => a.articleId === articleId) || null;
}

function listArticles({ includeDeleted = false } = {}) {
  const articles = loadArticles();
  return includeDeleted ? articles : articles.filter((a) => !a.deleted);
}

function listBySource(sourceUrl) {
  return loadArticles().filter((a) => a.rssSourceUrl === sourceUrl && !a.deleted);
}

function allFavorite() {
  return loadArticles().filter((a) => a.favoriteSaved && !a.deleted);
}

function allWatchLater() {
  return loadArticles().filter((a) => a.watchLaterSaved && !a.deleted);
}

function allIndependent() {
  return loadArticles().filter((a) => a.independentSaved && !a.deleted);
}

// 切换收藏/稍后看/独立/已读状态（时间戳单调递增，避免平局）
function toggleSavedState(articleId, type, desired = null) {
  articleId=canonicalRssArticleId(articleId);
  const articles = stateArticles();
  const article = articles.find((a) => a.articleId === articleId);
  if (!article) return null;
  const now = Math.max(Date.now(), Math.max(article.latestOperationAt || 0, stateTimestamp(article)) + 1);
  let updated;
  if (type === 'favorite') {
    const saved = desired === null ? !article.favoriteSaved : !!desired;
    updated = Object.assign({}, article, {
      favoriteSaved: saved,
      favoriteChangedAt: now,
      favoriteSortOrder: saved ? now : article.favoriteSortOrder,
      updatedAt: now,
    });
  } else if (type === 'watchLater') {
    const saved = desired === null ? !article.watchLaterSaved : !!desired;
    updated = Object.assign({}, article, {
      watchLaterSaved: saved,
      watchLaterChangedAt: now,
      watchLaterSortOrder: saved ? now : article.watchLaterSortOrder,
      updatedAt: now,
    });
  } else if (type === 'independent') {
    const saved = desired === null ? !article.independentSaved : !!desired;
    updated = Object.assign({}, article, {
      independentSaved: saved,
      independentChangedAt: saved ? now : article.independentChangedAt,
      independentSortOrder: saved ? now : article.independentSortOrder,
      updatedAt: now,
    });
  } else if (type === 'read') {
    updated = Object.assign({}, article, { isRead: desired === null ? !article.isRead : !!desired, readingPositionChangedAt:now,updatedAt: now });
  } else {
    return null;
  }
  return saveArticleState(articles, article, updated);
}

function markRead(articleId, { progress = null, positionBytes = 0 } = {}) {
  articleId=canonicalRssArticleId(articleId);
  const articles = stateArticles();
  const article = articles.find((a) => a.articleId === articleId);
  if (!article) return null;
  if (article.isRead && (progress === null || merge.clampProgress(progress) === article.readingProgress)
      && positionBytes === (article.readingPositionBytes || 0)) return article;
  const now = Math.max(Date.now(), stateTimestamp(article) + 1);
  const updated = Object.assign({}, article, {
    isRead: true,
    updatedAt: now,
    readingPositionBytes: positionBytes,
    readingPositionChangedAt: now,
  });
  if (progress !== null) updated.readingProgress = merge.clampProgress(progress);
  return saveArticleState(articles, article, updated);
}

function updateReadingPosition(articleId, progress, positionBytes) {
  articleId=canonicalRssArticleId(articleId);
  const articles = stateArticles();
  const article = articles.find((a) => a.articleId === articleId);
  if (!article) return null;
  const now = Math.max(Date.now(), stateTimestamp(article) + 1);
  const updated = Object.assign({}, article, {
    readingProgress: merge.clampProgress(progress),
    readingPositionBytes: positionBytes,
    readingPositionContentHash: article.contentHash,
    readingPositionChangedAt: now,
  });
  return saveArticleState(articles, article, updated);
}

// Reuse the existing synchronized per-list sort keys; larger keys sort first.
function setArticleOrder(articleId,kind,value){
  articleId=canonicalRssArticleId(articleId);
  const prefix={favorite:'favorite',watchLater:'watchLater',independent:'independent'}[kind];
  if(!prefix||!Number.isSafeInteger(value)||value<0)throw Error('排序操作无效');
  const articles=stateArticles(),article=articles.find(a=>a.articleId===articleId);if(!article||article.deleted)return null;
  const now=Math.max(Date.now(),stateTimestamp(article)+1);
  return saveArticleState(articles,article,Object.assign({},article,{[prefix+'SortOrder']:value,[prefix+'ChangedAt']:now}));
}
function setSourceOriginal(url,value){const source=getSource(url);if(!source||source.deleted)return null;return upsertSource(Object.assign({},source,{useOriginalContent:!!value,updatedAt:Math.max(Date.now(),(source.updatedAt||0)+1)}));}
function setSourceOrder(url,value){
  if(!Number.isSafeInteger(value))throw Error('排序操作无效');const source=getSource(url);if(!source||source.deleted)return null;
  return upsertSource(Object.assign({},source,{sortOrder:value,updatedAt:Math.max(Date.now(),(source.updatedAt||0)+1)}));
}
function softDeleteBook(url){
  require('./books').deleteBook(url,Date.now());
  // One metadata-journal write for all chapters; never load or serialize their bodies.
  const articles=stateArticles(),updates=new Map();
  for(const article of articles)if(!article.deleted&&article.rssSourceUrl===url){
    const now=Math.max(Date.now(),stateTimestamp(article)+1);updates.set(article.articleId,Object.assign({},article,{deleted:true,deletedAt:now,updatedAt:now}));
  }
  if(updates.size){
    if(stateJournal===null)stateJournal=(storage.readMap||storage.readJSON)(ARTICLE_STATE_PATH,{})||{};
    const next=Object.assign({},stateJournal);
    for(const [id,updated] of updates){const patch=Object.assign({},next[id]||{});for(const key of STATE_FIELDS)if(updated[key]!==undefined)patch[key]=updated[key];next[id]=patch;}
    storage.writeJSON(ARTICLE_STATE_PATH,next);stateJournal=next;
    for(let i=0;i<articles.length;i++)if(updates.has(articles[i].articleId))articles[i]=updates.get(articles[i].articleId);
    if(indexCache&&indexCache!==articles)for(let i=0;i<indexCache.length;i++)if(updates.has(indexCache[i].articleId))indexCache[i]=articleView(updates.get(indexCache[i].articleId));
    markDirty();
  }
  return softDeleteSource(url);
}

function softDeleteArticle(articleId) {
  articleId=canonicalRssArticleId(articleId);
  const articles = stateArticles();
  const article = articles.find((a) => a.articleId === articleId);
  if (!article) return null;
  const books=require('./books'),membership=books.member(article),book=membership&&books.load().books[membership.bookId];
  const now = Math.max(Date.now(), stateTimestamp(article) + 1,book?.lifecycle?book.lifecycle.startedAt+1:0);
  const updated = Object.assign({}, article, { deleted: true, deletedAt: now, updatedAt: now });
  require('./books').capture([updated]);
  return saveArticleState(articles, article, updated);
}

function removeArticle(articleId) {
  articleId=canonicalRssArticleId(articleId);
  const articles = loadArticles();
  const next = articles.filter((a) => a.articleId !== articleId);
  saveArticles(next);
  return next.length !== articles.length;
}

// 与 mergeArticlesFromSync 语义一致（默认 KEEP_LATEST）
function mergeArticles(incoming, deviceKeyProvider = null) {
  const articles = loadArticles();
  const byId = {};
  articles.forEach((a) => {
    byId[a.articleId] = a;
  });
  let mergedCount = 0;
  for (let remoteRaw of incoming) {
    remoteRaw=canonicalRssArticle(remoteRaw);
    const local = byId[remoteRaw.articleId];
    const remote = payload.withCurrentSyncMetadata(merge.prepareRemote(remoteRaw, local));
    const next = local ? merge.mergeArticleByLatest(local, remote) : remote;
    if (!local || JSON.stringify(local) !== JSON.stringify(next)) {
      byId[next.articleId] = next;
      mergedCount += 1;
    }
  }
  if (mergedCount > 0) { writeArticles(Object.values(byId)); markDirty(); }
  return mergedCount;
}

// ---------- RSS 源 ----------

function loadSources() {
  ensureOwner();
  if (sourcesCache === null) sourcesCache = storage.readJSON(SOURCES_PATH, []) || [];
  return sourcesCache;
}

function writeSources(sources) {
  ensureOwner();
  sourcesCache = sources;
  storage.writeJSON(SOURCES_PATH, sources);
}

function saveSources(sources) {
  markDirty();
  writeSources(sources);
}

function getSource(url) {
  return loadSources().find((s) => s.url === url) || null;
}

function upsertSource(source) {
  const sources = loadSources();
  const index = sources.findIndex((s) => s.url === source.url);
  const old = index >= 0 ? sources[index] : null;
  if (index >= 0) sources[index] = source;
  else sources.push(source);
  if (!old || JSON.stringify(old) !== JSON.stringify(source)) markDirty();
  writeSources(sources);
  return source;
}

function listSources({ includeDeleted = false } = {}) {
  const sources = loadSources();
  if (includeDeleted) return sources;
  return sources.filter((s) => !s.deleted);
}

function softDeleteSource(url) {
  const sources = loadSources();
  const source = sources.find((s) => s.url === url);
  if (!source) return null;
  const now = Math.max(Date.now(), (source.updatedAt || 0) + 1);
  const updated = Object.assign({}, source, { deleted: true, deletedAt: now, updatedAt: now });
  sources.splice(sources.indexOf(source), 1, updated);
  try { saveSources(sources); } catch(error) { sources.splice(sources.indexOf(updated),1,source); throw error; }
  return updated;
}

function pinSource(url, pinned) {
  const sources = loadSources();
  const source = sources.find((s) => s.url === url);
  if (!source) return null;
  const now = Math.max(Date.now(), (source.updatedAt || 0) + 1);
  const updated = Object.assign({}, source, { isPinned: pinned, updatedAt: now });
  sources.splice(sources.indexOf(source), 1, updated);
  try { saveSources(sources); } catch(error) { sources.splice(sources.indexOf(updated),1,source); throw error; }
  return updated;
}

function removeSource(url) {
  const sources = loadSources();
  const next = sources.filter((s) => s.url !== url);
  saveSources(next);
  return next.length !== sources.length;
}

// 与 mergeRssSourcesFromSync 一致
function mergeSources(incoming,{markLocalDirty=true,requirePersist=false,deferPersist=false}={}) {
  const sources = loadSources();
  const byUrl = {};
  sources.forEach((s) => {
    byUrl[s.url] = s;
  });
  let mergedCount = 0;
  for (const remote of incoming) {
    const local = byUrl[remote.url];
    const next = merge.mergeSource(local, remote);
    if (!local || JSON.stringify(local) !== JSON.stringify(next)) {
      byUrl[next.url] = next;
      mergedCount += 1;
    }
  }
  if(deferPersist)sourcesCache=Object.values(byUrl);
  else try{writeSources(Object.values(byUrl));}catch(error){if(markLocalDirty || requirePersist)throw error;/* remote source cache is optional */}
  if(mergedCount>0 && markLocalDirty)markDirty();
  return mergedCount;
}

// ---------- rss-state 应用（与 applyCloudRssState 一致：仅已存在文章） ----------

// 索引-only 同步：云端索引里有、本地没有的文章创建为 stub（无正文），
// 正文在进入文章时按需获取（lib/body.js）；已删文章不创建。
function stubFromState(state) {
  const a = defaultArticle(state.articleId);
  return Object.assign(a, {
    sourceDeviceId: state.sourceDeviceId || '',
    url: state.url || '',
    title: state.title || '',
    siteName: state.siteName || '',
    excerpt: state.excerpt || '',
    imageUrl: state.imageUrl || null,
    contentHash: state.contentHash || '',
    importedAt: state.importedAt || 0,
    updatedAt: state.updatedAt || 0,
    rssSourceUrl: state.rssSourceUrl || null,
    rssSourceTitle: state.rssSourceTitle || null,
    independentSaved: !!state.independentSaved,
    independentChangedAt: state.independentChangedAt || 0,
    independentSortOrder: state.independentSortOrder || 0,
    favoriteSaved: !!state.favoriteSaved,
    favoriteChangedAt: state.favoriteChangedAt || 0,
    favoriteSortOrder: state.favoriteSortOrder || 0,
    watchLaterSaved: !!state.watchLaterSaved,
    watchLaterChangedAt: state.watchLaterChangedAt || 0,
    watchLaterSortOrder: state.watchLaterSortOrder || 0,
    deleted: !!state.deleted,
    deletedAt: state.deletedAt || 0,
    readingProgress: state.readingProgress || 0,
    readingPositionBytes: state.readingPositionBytes || 0,
    readingPositionContentHash: state.readingPositionContentHash || '',
    readingPositionChangedAt: state.readingPositionChangedAt || 0,
    isRead: !!state.isRead,
  });
}

function hasBody(article) {
  return !!article && (!!article.contentHtml || String(article.contentText || '').trim() !== '');
}

// mergeRssState 触碰的状态字段（均不含正文，比较成本可忽略）
const RSS_STATE_KEYS = [
  'registerSources','__articleProvenanceV1','__articleRegisterLegacyV1','__articlePendingEdits',
  '__privateBodyClock','__privateBodyTracked',
  'sourceDeviceId', 'title', 'siteName', 'excerpt', 'imageUrl', 'contentHash', 'updatedAt',
  'rssSourceUrl', 'rssSourceTitle',
  'independentSaved', 'independentChangedAt', 'independentSortOrder',
  'favoriteSaved', 'favoriteChangedAt', 'favoriteSortOrder',
  'watchLaterSaved', 'watchLaterChangedAt', 'watchLaterSortOrder',
  'deleted', 'deletedAt',
  'readingProgress', 'readingPositionBytes', 'readingPositionContentHash', 'readingPositionChangedAt',
  'isRead',
];

function applyRssStates(states, { createStubs = true } = {}) {
  const articles = loadArticles();
  const byId = {};
  articles.forEach((a) => {
    byId[a.articleId] = a;
  });
  let applied = 0;
  let created = 0;
  for (let state of states) {
    state=canonicalRssArticle(state);
    const current = byId[state.articleId];
    if (!current) {
      if (!createStubs || state.deleted) continue;
      byId[state.articleId] = stubFromState(state);
      created += 1;
      continue;
    }
    const merged = merge.mergeRssState(current, state);
    if (RSS_STATE_KEYS.some((k) => current[k] !== merged[k])) {
      byId[current.articleId] = merged;
      applied += 1;
    }
  }
  const all = Object.values(byId);
  if (applied > 0 || created > 0) { writeArticles(all); markDirty(); }
  // pending：本地尚无正文、需要按需拉取的文章数
  const pending = all.filter((a) => !a.deleted && !hasBody(a)).length;
  return { applied, created, pending };
}

// 导出全库（用于构建 library-sync.json / rss-state.json）
// 已有且仍有效的同步元数据直接复用（避免每次全库 gzip/哈希）；persist 时回存新算的元数据
function exportLibrary({ persist = false } = {}) {
  const raw = loadArticles();
  let changed = false;
  const articles = raw.map((a) => {
    if (payload.hasCurrentSyncMetadata(a)) return a;
    changed = true;
    return payload.withCurrentSyncMetadata(a);
  });
  if (persist && changed) writeArticles(articles);
  return { articles, sources: loadSources() };
}

// Cooperative preparation: keep full protocol validation, yield between small batches.
function mergeCloudIndexState(current,state){
  if(state.__freezeLegacyOnly&&current&&!provenance.protectedValue(current))return{...current,__articleRegisterLegacyV1:current.__articleRegisterLegacyV1||state.__articleRegisterLegacyV1};
  if(provenance.protectedValue(current)||provenance.protectedValue(state)){
    const result=current?provenance.mergeValues(current,state):{...stubFromState(state),...provenance.asRecord(state).value,__articleProvenanceV1:true};
    if(current?.__articlePendingEdits)result.__articlePendingEdits=current.__articlePendingEdits;
    return result;
  }
  current=current&&provenance.freezeLegacy(current);state=provenance.freezeLegacy(state);
  const merged=current?merge.mergeArticleByLatest(current,Object.assign({},current,state)):stubFromState(state);
  const deleted=[current,state].filter(value=>value && value.deleted).sort((a,b)=>(b.deletedAt || 0)-(a.deletedAt || 0))[0];
  if(deleted){
    const at=Number(deleted.deletedAt || 0);
    const revived=['favorite','watchLater','independent'].some(kind=>merged[kind+'Saved'] && Number(merged[kind+'ChangedAt'] || 0)>at);
    if(!revived){
      merged.deleted=true;merged.deletedAt=at;
      for(const kind of ['favorite','watchLater','independent']){
        merged[kind+'Saved']=false;merged[kind+'ChangedAt']=Math.max(at,Number(merged[kind+'ChangedAt'] || 0));
      }
    }
  }
  if(current?.__privateBodyTracked&&!state.__privateBodyMetadata){for(const field of ['contentHash','__bodyFile','__privateBodyClock','__privateBodyTracked'])if(current[field]!==undefined)merged[field]=current[field];}
  if(state.__privateBodyMetadata){
    // R48 body clocks are independent of records reading/favorite timestamps.
    // Keep every user-state field, and reject an older body over a local edit.
    if(!current||state.__privateBodyFallback&&!current.__privateBodyTracked&&!current.__localBody||Number(state.__privateBodyClock)>=Number(current.__privateBodyClock||0)){for(const field of INDEX_FIELDS)if(state[field]!==undefined)merged[field]=state[field];}
    else{for(const field of INDEX_FIELDS)if(current[field]!==undefined)merged[field]=current[field];}
    if(current)for(const field of STATE_FIELDS)if(current[field]!==undefined)merged[field]=current[field];
  }
  if(current?.__articleRegisterLegacyV1||state.__articleRegisterLegacyV1)merged.__articleRegisterLegacyV1=current?.__articleRegisterLegacyV1||state.__articleRegisterLegacyV1;return merged;
}
function applyCloudIndex(states,sources,{requirePersist=false,deferPersist=false,skipUnchanged=false}={}) {
  const rows=loadIndex(),byId=new Map(rows.map(a=>[a.articleId,a]));
  const nextJournal=Object.assign({},stateJournal || {});let changed=false;
  for(let state of states) {
    state=canonicalRssArticle(state);
    const current=byId.get(state.articleId);
    // A records cursor must not forget a deletion just because this device has
    // never seen the article: an older legacy snapshot can still arrive later.
    if(!current && state.deleted && !requirePersist && !deferPersist)continue;
    const merged=mergeCloudIndexState(current,state);
    // The dedicated S8 projection already merged user clocks without public
    // metadata timestamps. Do not feed those timestamps back into read LWW.
    if(state.__rssInteraction&&current){merged.sourceDeviceId=state.sourceDeviceId;for(const field of require('./rss-cloud').READ_FIELDS)merged[field]=state[field];}
    // R44 already chose the complete reading tuple using the shared tie order.
    if(state.__bookReading)for(const field of require('./books').READ.filter(k=>!['bookId','chapterIndex'].includes(k)))merged[field]=state[field];
    // The authenticated book lifecycle owns deletion after explicit restoration.
    // Never revive arbitrary article input based on an untrusted row marker.
    if(state.__bookLifecycle){const bookPolicy=require('./books'),membership=bookPolicy.member(state),book=membership&&bookPolicy.load().books[membership.bookId];
      if(book?.lifecycle){merged.deleted=book.deleted||book.deletedChapters.includes(membership.chapterIndex);merged.deletedAt=merged.deleted?Math.max(book.deletedAt,book.deletionClock):0;}
    }
    if(merged.__bodyFile&&(merged.favoriteSaved||merged.watchLaterSaved)&&!(current?.favoriteSaved||current?.watchLaterSaved)){const stored=require('./article-body-store').persist(merged,ARTICLES_PATH.slice(0,ARTICLES_PATH.lastIndexOf('/')));if(stored.__bodyFile)merged.__bodyFile=stored.__bodyFile;}
    const view=articleView(merged);
    view.__localBody=!!(current && current.__localBody && current.contentHash===merged.contentHash);
    if(current && !RSS_STATE_KEYS.some(key=>typeof view[key]==='object'&&view[key]!==null?JSON.stringify(current[key])!==JSON.stringify(view[key]):current[key]!==view[key]))continue;
    const patch={__indexEntry:true,__invalidateBody:!!(nextJournal[view.articleId] && nextJournal[view.articleId].__invalidateBody) || !!(current && current.__localBody && !view.__localBody)};
    for(const key of STATE_FIELDS.concat(INDEX_FIELDS))if(view[key]!==undefined)patch[key]=view[key];
    nextJournal[view.articleId]=patch;byId.set(view.articleId,view);changed=true;
  }
  if(changed || requirePersist&&!skipUnchanged) {
    if(!deferPersist)try{storage.writeJSON(ARTICLE_STATE_PATH,nextJournal);if(storage.clearMap)storage.clearMap(ARTICLE_STATE_PATH);}catch(error){if(requirePersist)throw error;/* legacy heads are re-read on cold start */}
    const nextIndex=Array.from(byId.values());
    if(!deferPersist)try{storage.writeJSON(INDEX_PATH,nextIndex);}catch(error){if(requirePersist)throw error;/* derived cache */}
    // Publish the new in-memory view only after a required durable commit.
    // A failed equal-clock index write must still look changed on retry.
    stateJournal=nextJournal;indexCache=nextIndex;
    if(articlesCache) {
      const ids=new Set(articlesCache.map(a=>a.articleId));
      articlesCache=articlesCache.map(a=>applyFullPatch(a,nextJournal[a.articleId]));
      for(const [id,patch]of Object.entries(nextJournal))if(!ids.has(id) && patch.__indexEntry)articlesCache.push(applyFullPatch(defaultArticle(id),patch));
    }
  }
  const sourceChanges=sources&&(!skipUnchanged||sources.length)?mergeSources(sources,{markLocalDirty:false,requirePersist,deferPersist}):0;
  return changed || sourceChanges>0;
}

// State may arrive before public entries. Keep only interaction keys, no index stubs.
function applyRssInteractions(states=[]) {
  ensureOwner();recoverRssIdMigration();const policy=require('./rss-cloud'),map=storage.readJSON(RSS_INTERACTIONS_PATH,{})||{};
  const hashes=new Map(Object.keys(rssAliases()).map(old=>[require('./crypto').sha256Hex(old),require('./crypto').sha256Hex(canonicalRssArticleId(old))]));
  for(let state of states){if(hashes.has(state.articleIdHash))state={...state,articleIdHash:hashes.get(state.articleIdHash)};const key=state.sourceId+':'+state.articleIdHash;map[key]=policy.mergeState(map[key],state);}
  if(states.length)storage.writeJSON(RSS_INTERACTIONS_PATH,map);
  const patches=[];
  for(const article of listArticleViews({includeDeleted:true})){
    if(!policy.isPublic(article))continue;
    let sourceKey;try{sourceKey=policy.sourceKey(article.rssSourceUrl);}catch(_){continue;}
    const state=map[sourceKey+':'+require('./crypto').sha256Hex(article.articleId)];if(!state)continue;
    const merged=policy.mergeState(policy.stateOf(article,sourceKey),state),patch={...article,sourceDeviceId:merged.sourceDeviceId};
    for(const field of policy.READ_FIELDS)patch[field]=merged[field];
    patch.__rssInteraction=true;patches.push(patch);
  }
  return patches.length?applyCloudIndex(patches,[],{requirePersist:true,skipUnchanged:true}):false;
}

async function exportLibraryAsync() {
  const raw = loadArticles().slice();
  const articles = [];
  await util.tick();
  let started = Date.now();
  for (let i = 0; i < raw.length; i += 1) {
    const article = raw[i];
    const signature = payload.metadataHashFor(article);
    const cached = metadataCache.get(article);
    let value;
    if(cached && cached.html===article.contentHtml && cached.text===article.contentText) {
      const metadata=Object.assign({},cached.metadata,{syncMetadataHash:signature});
      value=Object.assign({},article,metadata);
      metadataCache.set(article,{signature,html:article.contentHtml,text:article.contentText,metadata});
    }
    else {
      const metadata = payload.currentSyncMetadata(article);
      value = Object.assign({}, article, metadata);
      metadataCache.set(article, { signature, html: article.contentHtml, text: article.contentText, metadata });
    }
    articles.push(value);
    if ((i & 31) === 31 || Date.now() - started >= 8) { await util.tick(); started = Date.now(); }
  }
  return { articles, sources: loadSources().slice() };
}

function clearAll() {
  require('./books').clear();
  saveArticles([]);
  saveSources([]);
  storage.deleteFile(RSS_INTERACTIONS_PATH);storage.deleteFile(rssIdPath('rss-id-aliases'));storage.deleteFile(rssIdPath('rss-id-migration'));rssAliasCache=null;
}

module.exports = {
  migrateRssArticleId,migrateRssArticleIds,canonicalRssArticleId,canonicalRssArticle,legacyRssArticleIds,
  applyRssInteractions,
  listRssInteractions(){ensureOwner();return Object.values(storage.readJSON(RSS_INTERACTIONS_PATH,{})||{}).filter(s=>/^[a-f0-9]{64}$/.test(s.sourceId));},
  setArticleOrder,setSourceOrder,setSourceOriginal,softDeleteBook,
  ensureOwner,
  uploadOwnershipStatus,assertUploadOwner,chooseUploadOwner,
  resetOwner,
  applyCloudIndex,
  loadIndex,
  listArticleViews,
  getArticleView,
  cachedArticle,
  loadArticles,
  saveArticles,
  upsertArticle,
  getArticle,
  listArticles,
  listBySource,
  allFavorite,
  allWatchLater,
  allIndependent,
  toggleSavedState,
  markRead,
  updateReadingPosition,
  softDeleteArticle,
  removeArticle,
  mergeArticles,
  loadSources,
  saveSources,
  getSource,
  upsertSource,
  listSources,
  softDeleteSource,
  pinSource,
  removeSource,
  mergeSources,
  applyRssStates,
  hasBody,
  isDirty,
  markDirty,
  clearDirty,
  dirtyRevision,
  exportLibrary,
  exportLibraryAsync,
  clearAll,
  bookStoragePath(name){ensureOwner();return ARTICLES_PATH.slice(0,ARTICLES_PATH.lastIndexOf('/')+1)+name;},
  defaultArticle,
};

// Warm immutable projections using native async I/O and cooperative JSON decoding.
// Capture owner and revisions across every yield; a newer foreground write wins.
let preparingViews=null,preparingArticles=null;
async function prepareViews(){
 ensureOwner();if(indexCache!==null)return;const owner=activeOwner,file=INDEX_PATH,journal=ARTICLE_STATE_PATH,version=storage.revision(file),jv=storage.revision(journal),host=storage.root;
 if(preparingViews&&preparingViews.file===file)return preparingViews.promise;
 const check=()=>{ensureOwner();if(storage.root!==host||activeOwner!==owner||storage.revision(file)!==version||storage.revision(journal)!==jv)throw Object.assign(Error('本机资料已更新'),{code:'local_storage_changed'});};
 const promise=(async()=>{const patches=await require('./state-map').readAsync(journal,{}),cached=await storage.readJSONAsync(file,null);check();
  if(!Array.isArray(cached)){await prepareArticles();check();indexCache=await require('./cooperative').map(articlesCache,articleView,check);}
  else {const rows=await require('./cooperative').map(cached,a=>{const patch=patches[a.articleId];return patch&&(stateTimestamp(patch)>stateTimestamp(a)||stateTimestamp(patch)===stateTimestamp(a)&&(patch.registerSources||patch.__articleRegisterLegacyV1||patch.__articlePendingEdits))?applyFullPatch(a,patch):a;},check);const ids=new Set(rows.map(a=>a.articleId));for(const [id,patch]of Object.entries(patches))if(!ids.has(id)&&patch.__indexEntry)rows.push(applyFullPatch(defaultArticle(id),patch));check();stateJournal=patches;indexCache=rows;}
  if(sourcesCache===null){const sourceFile=SOURCES_PATH,sv=storage.revision(sourceFile),sources=await storage.readJSONAsync(sourceFile,[]);check();if(storage.revision(sourceFile)===sv)sourcesCache=sources||[];}
 })();preparingViews={file,promise};try{await promise;}finally{if(preparingViews?.promise===promise)preparingViews=null;}
}
async function prepareArticles(){
 ensureOwner();if(articlesCache!==null)return;const owner=activeOwner,file=ARTICLES_PATH,version=storage.revision(file),host=storage.root;
 if(preparingArticles&&preparingArticles.file===file)return preparingArticles.promise;
 const check=()=>{ensureOwner();if(storage.root!==host||activeOwner!==owner||storage.revision(file)!==version)throw Object.assign(Error('本机资料已更新'),{code:'local_storage_changed'});};
 const promise=(async()=>{const raw=await storage.readJSONAsync(file,[])||[],patches=await require('./state-map').readAsync(ARTICLE_STATE_PATH,{});check();const body=require('./article-body-store');
  const rows=await require('./cooperative').map(raw,a=>body.remember(applyFullPatch(a,patches[a.articleId])),check);
  const ids=new Set(rows.map(a=>a.articleId));for(const [id,patch]of Object.entries(patches))if(!ids.has(id)&&patch.__indexEntry)rows.push(applyFullPatch(defaultArticle(id),patch));check();articlesCache=rows;stateJournal=patches;
 })();preparingArticles={file,promise};try{await promise;}finally{if(preparingArticles?.promise===promise)preparingArticles=null;}
}
async function writeArticlesAsync(articles){
 markDirty();
 ensureOwner();const owner=activeOwner,file=ARTICLES_PATH,version=storage.revision(file),journal=ARTICLE_STATE_PATH,jv=storage.revision(journal),host=storage.root,body=require('./article-body-store'),prefix=file.slice(0,file.lastIndexOf('/'));
 const check=()=>{ensureOwner();if(storage.root!==host||owner!==activeOwner||version!==storage.revision(file)||jv!==storage.revision(journal))throw Object.assign(Error('本机资料已更新'),{code:'local_storage_changed'});};
 let deadline=Date.now()+4;const persisted=[];for(const article of articles){check();persisted.push(body.persistAsync?await body.persistAsync(article,prefix,check):body.persist(article,prefix));if(Date.now()>=deadline){await require('./cooperative').turn();deadline=Date.now()+4;}}
 await storage.writeJSONAsync(file,persisted,{check});
 // No await before retiring the overlaid state: the new base contains it.
 if(storage.root!==host||owner!==activeOwner)throw Object.assign(Error('账号已切换'),{code:'cloud_session_changed'});
 storage.deleteFile(INDEX_PATH);const latest=require('./state-map').read(journal,{})||{};articlesCache=articles.map(a=>applyFullPatch(a,latest[a.articleId]));indexCache=null;stateJournal=latest;
 if(storage.revision(journal)===jv){stateJournal={};storage.deleteFile(journal);}
 body.prune();
 const projection=await require('./cooperative').map(articlesCache,articleView);ensureOwner();if(owner===activeOwner)indexCache=projection;markDirty();
}
async function upsertArticleAsync(article){await prepareArticles();const rows=loadArticles().slice(),at=rows.findIndex(a=>a.articleId===article.articleId);article=stampPrivateBody(article,at>=0?rows[at]:null);if(at>=0)rows[at]=article;else rows.push(article);await writeArticlesAsync(rows);return article;}
Object.assign(module.exports,{prepareViews,prepareArticles,writeArticlesAsync,upsertArticleAsync});
const probe=require('./longtask');if(probe.instrument)probe.instrument(module.exports,'library');

async function mergeArticlesAsync(incoming,deviceKeyProvider=null){await prepareArticles();const byId=new Map(loadArticles().map(a=>[a.articleId,a]));let count=0;
 for(let remote of incoming){remote=canonicalRssArticle(remote);const local=byId.get(remote.articleId);const candidate=payload.withCurrentSyncMetadata(merge.prepareRemote(remote,local)),next=local?merge.mergeArticleByLatest(local,candidate):candidate;if(!local||JSON.stringify(local)!==JSON.stringify(next)){byId.set(next.articleId,next);count++;}await require('./cooperative').turn();}
 if(count)await writeArticlesAsync(Array.from(byId.values()));return count;
}
module.exports.mergeArticlesAsync=mergeArticlesAsync;

async function getArticleAsync(id){await prepareArticles();const article=getArticle(id);if(!article||!article.__bodyFile)return article;const body=await storage.readJSONAsync(article.__bodyFile,null);return body?{...article,...body}:article;}
module.exports.getArticleAsync=getArticleAsync;

// Records/snapshot merges are cooperative; cursor ACK still follows the durable
// journal AND derived-index commit. Foreground edits invalidate/retry the save.
async function commitCloudIndexAsync(check=()=>{}){
 ensureOwner();const owner=activeOwner,journal=ARTICLE_STATE_PATH,index=INDEX_PATH,sources=SOURCES_PATH,host=storage.root;
 const owned=()=>{check();ensureOwner();if(storage.root!==host||activeOwner!==owner)throw Object.assign(Error('账号已切换'),{code:'cloud_session_changed'});};
 for(let attempt=0;attempt<3;attempt++){
  owned();const version=storage.revision(journal),snapshot={...stateJournal},rows=indexCache&&indexCache.slice();
  try{await storage.writeJSONAsync(journal,snapshot,{check:owned});owned();
   const committedVersion=storage.revision(journal);
   if(rows)await storage.writeJSONAsync(index,rows,{check:()=>{owned();if(storage.revision(journal)!==committedVersion)throw Object.assign(Error('本机资料已更新'),{code:'local_storage_changed'});}});
   await storage.writeJSONAsync(sources,sourcesCache||[],{check:owned});owned();return;
  }catch(error){if(error.code!=='local_storage_changed'||attempt===2)throw error;}
 }
}
async function applyCloudIndexAsync(states,sources,options={}){
 await prepareViews();const host=storage.root,owner=activeOwner;
 const check=()=>{if(options.check)options.check();ensureOwner();if(storage.root!==host||activeOwner!==owner)throw Object.assign(Error('账号已切换'),{code:'cloud_session_changed'});};let changed=false;
 const width=options.batchSize===64?64:16;
 for(let at=0;at<states.length;at+=width){check();changed=applyCloudIndex(states.slice(at,at+width),[],{deferPersist:true})||changed;await require('./cooperative').turn();}
 check();changed=!!mergeSources(sources||[],{markLocalDirty:false,requirePersist:options.requirePersist,deferPersist:true})||changed;
 if(!options.deferPersist&&(changed||options.requirePersist&&!options.skipUnchanged))await commitCloudIndexAsync(check);
 return changed;
}
Object.assign(module.exports,{applyCloudIndexAsync,commitCloudIndexAsync});

// Upgrade work runs only in the cloud background pipeline, never navigation.
// Each complete legacy row freezes its then-known provenance once; stubs/body
// projections are not invented reading operations. The existing durable journal
// and owner/revision fences are reused; no key/cache reset or cloud rewrite.
async function migrateProvenanceLegacy(check=()=>{}){
 await prepareViews();ensureOwner();const marker=ARTICLES_PATH.replace(/articles\.json$/,'article-provenance-legacy-v1.json'),owner=activeOwner,host=storage.root;const owned=()=>{check();ensureOwner();if(activeOwner!==owner||storage.root!==host)throw Object.assign(Error('账号已切换'),{code:'cloud_session_changed'});};
 if(storage.readJSONCached(marker,null)?.version===1)return false;
 let changed=false;const rows=loadIndex().slice();
 for(let at=0;at<rows.length;at+=16){owned();const patches=[];
  for(const row of rows.slice(at,at+16)){const current=getArticleView(row.articleId);if(!current)continue;const frozen=provenance.freezeLegacy(current);if(frozen!==current)patches.push({...frozen,__freezeLegacyOnly:true});}
  if(patches.length)changed=applyCloudIndex(patches,[],{deferPersist:true})||changed;
  await require('./cooperative').turn();owned();
 }
 await commitCloudIndexAsync(owned);owned();await storage.writeJSONAsync(marker,{version:1},{check:owned});return changed;
}
module.exports.migrateProvenanceLegacy=migrateProvenanceLegacy;
