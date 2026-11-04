// R45: a content clear is not a local delete. Rebuild only locally held originals.
const scopeStore=require('./cloud-scope'),library=require('./library');
async function publishPrivate({scope,contexts=[],checkBackground=()=>{}}){
 const state=scopeStore.content(scope.userId);if(!state?.rebuildRequired)return{uploaded:false,pending:false,warnings:[]};
 const reader=require('./cloud-reader'),policy=require('./rss-cloud'),books=require('./books'),entries=[],warnings=[];
 checkBackground();for(const article of library.listArticleViews()){
  checkBackground();
  if(policy.isPublic(article)||books.member(article)||books.isLegacy(article))continue;
  if(contexts.some(c=>require('./cloud-format').readable(c.manifest,'manifest')&&c.manifest.objects.some(o=>o.name===reader.objectName(article))))continue;
  const local=library.getArticle(article.articleId),text=require('./online-reader').toText(local||article);
  if(!text.trim()){warnings.push({articleId:article.articleId,code:'cloud_local_original_missing'});continue;}
  if(require('./cloud-overlay').localEnabled())try{await require('./cloud-overlay').packArticle(local||article,text,checkBackground);}catch(error){if(error.code!=='cloud_overlay_type_pending')throw error;warnings.push({articleId:article.articleId,code:error.code});continue;}
  entries.push({article:local||article,text});
 }
 checkBackground();if(entries.length)await reader.publish(entries[0].article,entries[0].text,null,scope.userId,false,null,{entries},()=>{},{locked:true,backgroundCheck:checkBackground});
 return{uploaded:!!entries.length,pending:!!warnings.length,warnings};
}
module.exports={publishPrivate};
