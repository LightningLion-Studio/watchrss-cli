const appaccess = require('./appaccess');
const merge = require('./merge');
const diagnostics = require('./book-diagnostics');
const PAGE_CHARS = 3000;
function toText(article) {
  const plain=String(article.contentText||''),html=String(article.contentHtml||'');
  // Older phone EPUB imports flattened paragraphs in contentText, while keeping
  // the complete paragraph markup. Recover from that markup, not punctuation.
  const structured=html&&/<(?:[a-z][\w-]*:)?(?:p|div|br|h[1-6]|li|blockquote)\b/i.test(html);
  const value=structured&&!/[\r\n\u2028\u2029]/.test(plain.trim())?html:(plain||html);
  return require('./html-text').toText(value);
}
function local(text) {
  const ends = [0]; let offset = 0;
  // Store offsets, not a duplicated array of all text pages.
  while (offset < text.length) {
    let end = Math.min(text.length, offset + PAGE_CHARS);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end-1])) end -= 1;
    ends.push(end); offset = end;
  }
  return { totalPages: ends.length-1, get estimatedPages(){return this.totalPages;}, hint:'分段阅读，不新增正文文件',
    read(page) {
      if (page < 0 || page >= this.totalPages) throw new Error('阅读段落不存在');
      return Promise.resolve(text.slice(ends[page],ends[page+1]));
    }, close() { text=''; ends.length=0; } };
}
function publicPageText(data) {
  if (!data || typeof data.contentText !== 'string' || data.contentText.length > 10000) throw new Error('正文分段响应无效');
  if(!Array.isArray(data.blocks))return toText(data);
  if(data.blocks.length>20)throw Error('正文分段响应无效');
  const base=require('../config').backendBaseUrl;
  const prefix=`/functions/v1/rss/articles/read/${data.sessionId}/images/`;
  const blocks=data.blocks.map((b,i)=>{
    if(b.kind==='text'&&typeof b.text==='string'&&b.text.length<=10000)return{kind:'text',text:b.text,key:'t'+i};
    if(b.kind==='image'&&typeof b.src==='string'&&b.src.startsWith(prefix)&&/^\d{1,3}\?token=[a-f0-9]{64}$/.test(b.src.slice(prefix.length)))return{kind:'image',src:base+b.src,alt:String(b.alt||'').slice(0,240),key:'i'+i,loading:true,failed:false};
    throw Error('正文分段响应无效');
  });
  return {text:data.contentText,blocks};
}
async function publicReader(article) {
  function release(id){if(id)appaccess.request({method:'DELETE',path:`/functions/v1/rss/articles/read/${id}`}).catch(()=>{});}
  async function start() {
    return (await appaccess.request({ method:'POST', path:'/functions/v1/rss/articles/read', body:{url:article.url,original:!!article.useOriginalContent} })).data;
  }
  let first = await start(); let closed = false;
  return { totalPages:first.totalPages, get estimatedPages(){return this.totalPages;}, hint:article.useOriginalContent?'原文图文 · 按需加载':'订阅正文 · 图文按需加载',
    async read(page) {
      if(closed)throw new Error('阅读已关闭');
      if (page === 0) return publicPageText(first);
      try {
        return publicPageText((await appaccess.request({ method:'GET', path:`/functions/v1/rss/articles/read/${first.sessionId}?page=${page}` })).data);
      } catch(e) {
        if (closed || e.code !== 'reader_session_expired') throw e;
        const fresh = await start();
        if(closed){release(fresh.sessionId);throw new Error('阅读已关闭');}
        if (fresh.contentHash !== first.contentHash){release(fresh.sessionId);throw new Error('文章内容已更新，请重新打开后继续阅读');}
        first = fresh;
        return publicPageText((await appaccess.request({method:'GET',path:`/functions/v1/rss/articles/read/${first.sessionId}?page=${page}`})).data);
      }
    }, close() { if(closed)return;closed=true;release(first && first.sessionId);first=null; } };
}
function bounded(provider) {
  const cache = new Map(); const pending = new Map(); let closed = false; let speculative = false;
  return {
    // totalPages is a lower bound until totalPagesKnown. EOF is page-specific.
    get totalPages() { return provider.totalPages; },
    get estimatedPages() { return provider.estimatedPages??provider.totalPages; },
    get knownPages() { return provider.knownPages??provider.totalPages; },
    get totalPagesKnown() { return provider.totalPagesKnown!==false; },
    hasMore(page) { return provider.hasMore?provider.hasMore(page):page+1<provider.totalPages; },
    pageInfo(page) { const hasMore=this.hasMore(page);return{knownPages:this.knownPages,totalPages:this.totalPagesKnown?this.totalPages:null,hasMore,eof:!hasMore}; },
    async readPage(page) {const text=await this.read(page);return{text,...this.pageInfo(page)};},
    get hint() { return provider.hint; },
    upgrade: provider.upgrade,
    preparePage:provider.preparePage?page=>provider.preparePage(page):undefined,
    sibling:provider.sibling?article=>{const next=provider.sibling(article);return next&&typeof next.then==='function'?next.then(value=>value?bounded(value):null):next?bounded(next):null;}:undefined,
    peek:page=>closed?undefined:cache.get(page),
    forget:page=>cache.delete(page),
    whenIdle:()=>Promise.all(Array.from(pending.values()).map(task=>task.catch(()=>{}))),
    async read(page) {
      if (closed) throw new Error('阅读已关闭');
      if(!Number.isInteger(page)||page<0)throw new Error('阅读段落不存在');
      if(provider.preparePage)await provider.preparePage(page);
      if(page>=provider.totalPages)throw new Error('阅读段落不存在');
      if (cache.has(page)) { const hit=cache.get(page); cache.delete(page);cache.set(page,hit);return hit; }
      let task=pending.get(page);
      if(!task) {
        task=Promise.resolve(provider.read(page));pending.set(page,task);
      }
      let text;
      try { text=await task; } finally { if(pending.get(page)===task)pending.delete(page); }
      if (closed) throw new Error('阅读已关闭');
      if (typeof text === 'string' ? text.length > 10000 : !text || typeof text.text!=='string' || text.text.length>10000 || !Array.isArray(text.blocks) || text.blocks.length>20) throw new Error('正文分段响应无效');
      cache.set(page,text);
      while(cache.size>3) cache.delete(cache.keys().next().value);
      return text;
    },
    async prefetch(page) {
      if(closed || speculative || page<0 || page>=provider.totalPages || cache.has(page))return;
      speculative=true;
      try { await this.read(page); } catch(error) { /* foreground navigation can retry */ }
      finally { speculative=false; }
    },
    close() { closed=true;cache.clear();pending.clear();provider.close(); },
  };
}
async function open(article,options={}) {
  const trace=diagnostics.begin(article,options);
  try{const reader=await openTracked(article,{...options,diagnostics:trace});diagnostics.record(trace,'result',true,'opened',{pages:reader.totalPages});return reader;}
  catch(error){diagnostics.error(trace,'result',error);throw error;}
}
async function openTracked(article,options) {
  const trace=options.diagnostics;
  const savedPublic=require('./rss-cloud').isPublic(article)&&!!(article.favoriteSaved||article.watchLaterSaved);
  const privateContent = savedPublic || (!article.rssSourceUrl&&article.independentSaved) || merge.isImportedContentUrl(article.url) || merge.isImportedContentUrl(article.rssSourceUrl || '');
  diagnostics.record(trace,'private',!!privateContent,'classified',{localBody:article.__localBody===undefined?-1:Number(!!article.__localBody),bodyFile:Number(!!article.__bodyFile),textLength:typeof article.contentText==='string'?article.contentText.length:0,htmlLength:typeof article.contentHtml==='string'?article.contentHtml.length:0});
  if(!privateContent && /^https?:\/\//i.test(article.url||'') && !options.localOnly){diagnostics.record(trace,'result',true,'public');return bounded(await publicReader(article));}
  if(privateContent&&(merge.isImportedContentUrl(article.url)||merge.isImportedContentUrl(article.rssSourceUrl||''))){const book=await require('./cloud-books').localReaderAsync(article,options);diagnostics.record(trace,'local-book',!!book,book?'opened':'missing');if(book)return bounded(book);}
  const body=article.__bodyFile?await require('./storage').readJSONAsync(article.__bodyFile,null):null;
  diagnostics.record(trace,'local-file',!!body,body?'opened':'missing',{bodyFile:Number(!!article.__bodyFile)});
  const localArticle=body?{...article,...body}:article;
  // An explicit metadata-only view can carry an inline preview. Only a body
  // file or a real local-body view authorizes rendering that text as the book.
  const metadataPreview=privateContent&&!body&&article.__localBody===false;
  const localText = article.useOriginalContent||metadataPreview?'':toText(localArticle);
  diagnostics.record(trace,'local-text',!!localText.trim(),metadataPreview?'metadata-preview':localText.trim()?'local':'empty',{textLength:localText.length});
  if (localText.trim()) return bounded(local(localText));
  if(privateContent){diagnostics.record(trace,'cloud',true,'fallback');try{return bounded(await require('./cloud-reader').open(article,toText,options));}catch(error){diagnostics.error(trace,'cloud',error);if(!savedPublic||error.code!=='reader_private_unavailable')throw error;}}
  return bounded(await publicReader(article));
}

module.exports = { open, local, bounded, toText, PAGE_CHARS,publicPageText };

const onlineProbe=require('./longtask');if(onlineProbe.instrument)onlineProbe.instrument(module.exports,'online-reader');
