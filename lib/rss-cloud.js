// S8: public RSS metadata is a local projection, never a personal cloud index.
const crypto=require('./crypto'),merge=require('./merge'),{sourceKey,localOnly}=require('./rss-source-key');
const READ_FIELDS=['isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder','deleted','deletedAt'];
function isPublic(article){return !!(article.rssSourceUrl&&!merge.isImportedContentUrl(article.rssSourceUrl)&&!merge.isImportedContentUrl(article.url));}
function isPrivate(article){return !isPublic(article)||!!(article.favoriteSaved||article.watchLaterSaved);}
function interacted(article){return !!(article.isRead||article.readingProgress||article.readingPositionChangedAt||article.favoriteSaved||article.watchLaterSaved||article.favoriteChangedAt||article.watchLaterChangedAt);}
function stateOf(article,sourceId){
 if(!sourceId)throw Object.assign(Error('订阅尚未进入公共 RSS 池'),{code:'cloud_rss_source_unresolved'});
 const value={sourceId,sourceDeviceId:article.sourceDeviceId||'',articleIdHash:crypto.sha256Hex(String(article.articleId))};
 for(const field of READ_FIELDS)value[field]=article[field];
 return value;
}
function mergeState(a,b){
 if(!a)return b;
 const local={...a,articleId:a.articleIdHash,contentHash:a.readingPositionContentHash,updatedAt:a.readingPositionChangedAt||0};
 const remote={...b,articleId:b.articleIdHash,contentHash:b.readingPositionContentHash,updatedAt:b.readingPositionChangedAt||0};
 const merged=merge.mergeArticleByLatest(local,remote),out={sourceId:b.sourceId,sourceDeviceId:merged.sourceDeviceId||'',articleIdHash:b.articleIdHash};
 for(const field of READ_FIELDS)out[field]=merged[field];
 return out;
}
function subscription(source){
 const value={url:source.url,title:source.customTitle||source.title||'',sourceId:source.sourceId||'',sortOrder:source.sortOrder||0,isPinned:!!source.isPinned,updatedAt:source.updatedAt||0,deleted:!!source.deleted,deletedAt:source.deletedAt||0,useOriginalContent:!!source.useOriginalContent,continuePlaybackInBackground:!!source.continuePlaybackInBackground};
 return value;
}
function project(articles,sources){
 const rssStates=[],warnings=[];
 for(const article of articles){if(!isPublic(article)||!interacted(article)||localOnly(article.rssSourceUrl))continue;try{rssStates.push(stateOf(article,sourceKey(article.rssSourceUrl)));}catch(error){warnings.push({articleId:article.articleId,url:article.rssSourceUrl,code:error.code});}}
 return{articles:articles.filter(article=>!isPublic(article)),sources:sources.map(subscription),rssStates,warnings};
}
module.exports={sourceKey,localOnly,READ_FIELDS,isPublic,isPrivate,interacted,stateOf,mergeState,subscription,project};
