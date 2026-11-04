// Legacy byte-array parser retained for rollback and compatibility tests.
// uploadFile is the default bounded path; images/fonts are never extracted.
const zip = require('../vendor/fflate-browser');
const util = require('./util');
const crypto = require('./crypto');
const library = require('./library');
const account = require('./account');
const reader = require('./online-reader');
const {MAX_CHAPTERS,MAX_ZIP_ENTRIES,chapterError,archiveError}=require('./import-limits');
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TEXT = 12 * 1024 * 1024;
function utf8(bytes) {
  if(bytes[0]===0xef && bytes[1]===0xbb && bytes[2]===0xbf)bytes=bytes.slice(3);
  const text=util.bytesToUtf8(bytes);
  if (!util.bytesEqual(util.utf8ToBytes(text), bytes)) throw new Error('文件编码暂不支持，请将文本转换为 UTF-8 后再上传');
  return text.replace(/^\uFEFF/,'');
}
function decodeTxt(bytes) {return require('./txt-encoding').decode(bytes);}

function attrs(tag) {
  const out={}; tag.replace(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g,(_,key,q,value)=> {out[key]=value; return '';});return out;
}
function resolvePath(base, relative) {
  const parts=(base.slice(0,base.lastIndexOf('/')+1)+relative.split('#')[0]).split('/'); const out=[];
  for(const part of parts) {if(part==='..')out.pop();else if(part && part!=='.')out.push(part);}
  return out.join('/');
}
function preflight(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) {
    if(view.getUint32(i,true)===0x06054b50 && i+22+view.getUint16(i+20,true)===bytes.length){end=i;break;}
  }
  if(end<0 || view.getUint16(end+4,true) || view.getUint16(end+6,true)) throw new Error('EPUB 压缩包格式不支持');
  const count=view.getUint16(end+10,true); let offset=view.getUint32(end+16,true); let total=0;
  if(end>=20 && view.getUint32(end-20,true)===0x07064b50)throw new Error('EPUB 压缩包格式不支持 ZIP64');
  if(count>MAX_ZIP_ENTRIES || count===0xffff)throw archiveError();
  const allowed=new Set();
  for(let n=0;n<count;n++) {
    if(offset+46>bytes.length || view.getUint32(offset,true)!==0x02014b50)throw new Error('EPUB 目录损坏');
    const flags=view.getUint16(offset+8,true);const size=view.getUint32(offset+24,true);
    const nameSize=view.getUint16(offset+28,true);const extra=view.getUint16(offset+30,true);const comment=view.getUint16(offset+32,true);
    if(offset+46+nameSize+extra+comment>bytes.length)throw new Error('EPUB 目录损坏');
    const name=util.bytesToUtf8(bytes.slice(offset+46,offset+46+nameSize));
    if(/\.(?:xml|opf|xhtml|html|htm)$/i.test(name)) {
      if(flags&1 || size>MAX_TEXT || size===0xffffffff)throw new Error('不支持加密或过大的 EPUB 章节');
      total+=size;if(total>MAX_TEXT)throw new Error('EPUB 正文超过 12 MB，请拆分后上传');allowed.add(name);
    }
    offset+=46+nameSize+extra+comment;
  }
  return allowed;
}
async function parseEpub(bytes) {
  const allowed=preflight(bytes);
  const files=zip.unzipSync(bytes,{filter:f=>allowed.has(f.name)});
  function xml(name) {
    if(!files[name])throw new Error('EPUB 缺少必要的目录或章节文件');
    const value=utf8(files[name]);
    if(/<!DOCTYPE[\s\S]*?\b(?:SYSTEM|PUBLIC)\b|<!ENTITY/i.test(value))throw new Error('EPUB 使用了不支持的外部 XML 实体');
    return value;
  }
  const container=xml('META-INF/container.xml');
  const root=container.match(/<(?:\w+:)?rootfile\b[^>]*>/i);const path=root&&attrs(root[0])['full-path'];
  if(!path)throw new Error('EPUB 未找到书籍目录');
  const opf=xml(path);const items={};
  for(const item of opf.match(/<(?:\w+:)?item\b[^>]*>/gi)||[]){const a=attrs(item);if(a.id&&a.href)items[a.id]=a;}
  const parts=[],chapters=[];
  for(const ref of opf.match(/<(?:\w+:)?itemref\b[^>]*>/gi)||[]) {
    const a=attrs(ref);const item=items[a.idref];if(!item || a.linear==='no')continue;
    const name=resolvePath(path,decodeURIComponent(item.href));
    if(!/\.(?:xhtml|html|htm)$/i.test(name))continue;
    await util.tick();const html=xml(name),text=reader.toText({contentHtml:html});
    if(text.trim()){const heading=(html.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)||[])[1];
      if(chapters.length>=MAX_CHAPTERS)throw chapterError('EPUB');
      chapters.push({title:heading?reader.toText({contentHtml:heading}).trim().slice(0,160):`第 ${chapters.length+1} 章`,text});parts.push(text);}
  }
  const text=parts.join('\n\n');if(!text.trim())throw new Error('EPUB 没有可阅读的文字，暂不支持扫描版或受 DRM 保护的书籍');
  const title=(opf.match(/<(?:dc:)?title\b[^>]*>([\s\S]*?)<\/(?:dc:)?title>/i)||[])[1];
  return {text,chapters,title:title?reader.toText({contentHtml:`<p>${title}</p>`}).trim():''};
}
function splitTxtChapters(text) {
  text=text.replace(/\r\n?/g,'\n').trim();
  const chapters=require('./txt-chapters'),plan=chapters.plan(text);
  return plan?plan.ranges.map(range=>({title:range.title,text:chapters.body(text,range)})):[];
}
async function parse(name,input) {
  const bytes=new Uint8Array(input);
  if(!bytes.length)throw new Error('文件为空');if(bytes.length>MAX_FILE)throw new Error('请选择 8 MB 以内的 TXT 或 EPUB 文件');
  if(/\.txt$/i.test(name)){const text=decodeTxt(bytes).replace(/\r\n?/g,'\n').trim();return {text,txtChapterPlan:require('./txt-chapters').plan(text),title:name.replace(/\.txt$/i,'') || text.split('\n')[0].slice(0,80)};}
  if(/\.epub$/i.test(name))return parseEpub(bytes);
  throw new Error('只支持 TXT 和 EPUB 文件');
}
async function upload(name,bytes,onPhase=()=>{},options={}) {
  const session=account.getUsableSession();if(!session)throw new Error('请先登录后上传');
  onPhase('正在解析文件',5);const parsed=await parse(name,bytes);const text=parsed.text.trim();
  if(!text)throw new Error('文件没有可阅读的正文');
  if(parsed.txtChapterPlan){
    const plan=parsed.txtChapterPlan;
    const split=options.chooseTxtChapters?await options.chooseTxtChapters({title:parsed.title,chapterCount:plan.ranges.length}):true;
    if(split===null)throw Object.assign(new Error('已取消导入'),{code:'file_selection_cancelled'});
    if(split)parsed.chapters=plan.ranges.map(range=>({title:range.title,index:range.index,get text(){return require('./txt-chapters').body(parsed.text,range);}}));
  }
  const current=account.getUsableSession();if(!current || current.userId!==session.userId || current.accessToken!==session.accessToken)throw new Error('账号已切换，请重新登录后上传');
  onPhase('正在校验正文');await util.tick();const hash=crypto.sha256Hex(text);const now=Date.now();
  if(parsed.chapters && parsed.chapters.length>1) {
    const sourceUrl=`https://watchrss.local/${/\.epub$/i.test(name)?'import-epub':'import-txt-novel'}/${hash}`;
    const title=parsed.title||name;
    const entries=[];
    for(let index=0;index<parsed.chapters.length;index++){
      const chapter=parsed.chapters[index];
      await util.tick();
      const chapterText=chapter.text,contentHash=crypto.sha256Hex(chapterText),url=`${sourceUrl}/chapter/${String(chapter.index || index+1).padStart(4,'0')}-${contentHash.slice(0,24)}`;
      const article=Object.assign(library.defaultArticle(crypto.sha256Hex(url)),{url,title:chapter.title,siteName:title,excerpt:chapterText.slice(0,160),contentHash,importedAt:now,updatedAt:now,rssSourceUrl:sourceUrl,rssSourceTitle:title});
      entries.push({article,get text(){return chapter.text;}});
      onPhase('正在整理章节目录',5+Math.floor((index+1)/parsed.chapters.length*10));
    }
    await canonicalBookEntries(entries);
    const source={url:sourceUrl,title,description:'导入书籍',addedAt:now,updatedAt:now,deleted:false,deletedAt:0,pinned:false,pinnedAt:0};
    onPhase('正在加密并上传书籍与目录',15);
    await require('./cloud-reader').publishBook(entries,source,session.userId,onPhase);
    if(!account.getUsableSession() || account.getUsableSession().userId!==session.userId)throw new Error('账号已切换，请重新登录后查看云端上传结果');
    library.applyCloudIndex(entries.map(entry=>entry.article),[source]);
    if(true)await require('./books').materializeAsync();
    onPhase('导入完成',100);
    return Object.assign({},entries[0].article,{bookSourceUrl:sourceUrl});
  }
  const url=`watchrss://import/online-v1/${hash}`;const articleId=crypto.sha256Hex(url);
  const existing=library.getArticle(articleId);
  if(existing && !existing.deleted){onPhase('文件已在资料库中',100);return existing;}
  const article=Object.assign({},existing||{}, {articleId,url,title:parsed.title||name,siteName:'文件导入',excerpt:text.slice(0,160),
    contentText:'',contentHtml:null,contentHash:hash,importedAt:now,updatedAt:now,rssSourceUrl:null,rssSourceTitle:null,
    independentSaved:true,independentChangedAt:now,independentSortOrder:now,deleted:false,deletedAt:0});
  onPhase('正在加密并上传正文',15);
  const entries=[{article,text}];await canonicalBookEntries(entries);
  await require('./cloud-reader').publishBook(entries,{url,title:article.title},session.userId,onPhase);
  // The index becomes visible only after the encrypted cloud snapshot is complete.
  if (!account.getUsableSession() || account.getUsableSession().userId !== session.userId) throw new Error('账号已切换，请重新登录后查看云端上传结果');
  library.applyCloudIndex([article],[]);
  if(true)await require('./books').materializeAsync();
  onPhase('导入完成',100);
  return article;
}
async function canonicalBookEntries(entries){
 const books=require('./books'),fp=await books.fingerprintAsync(entries.map(e=>({title:e.article.title,contentText:e.text}))),bookId=books.id(fp);
 for(let i=0;i<entries.length;i++)entries[i].article.articleId=books.articleId(bookId,i+1);
}
async function uploadFile(name,filePath,onPhase=()=>{},options={}){
 const session=account.getUsableSession();if(!session)throw new Error('请先登录后上传');
 const scope=require('./cloud-scope'),owner=scope.contentCurrent(),epoch=scope.load(session.userId)?.libraryEpoch;
 const check=()=>{scope.check(owner);const current=account.getUsableSession();if(!current||current.userId!==session.userId||current.accessToken!==session.accessToken)throw Object.assign(Error('账号已切换，请重新登录后上传'),{code:'cloud_session_changed'});if(scope.load(session.userId)?.libraryEpoch!==epoch)throw Object.assign(Error('云资料库已重置'),{code:'NEEDS_RECOVERY'});if(options.check)options.check();};
 onPhase('正在确认导入配置');const limits=await require('./import-policy').current();check();
 if(!limits.enabled){
  // Rollback preserves the old parser, wire format and 8 MiB admission bound.
  const input=await require('./import-files').readAll(filePath,MAX_FILE,check);
  return upload(name,input,onPhase,{...options,check});
 }
 const files=require('./import-files'),stream=require('./import-stream'),input=await files.open(filePath,check);let stage;
 try{
  if(input.size>limits.maxFileBytes)throw new Error('文件超过配置上限，请拆分后上传');
  onPhase('正在检查本机文件空间');if(files.preflight)await files.preflight(name,input.size,limits,check);check();stage=await files.stage(check);
  onPhase('正在解析文件',5);const prepared=await stream.prepare(name,input,stage,limits,{...options,onPhase});check();
  const books=require('./books'),existing=books.load().books[prepared.book.bookId];
  if(existing&&options.chooseExistingBook){
   onPhase('文件曾经导入过，请选择恢复或重新导入');
   const choice=await options.chooseExistingBook({title:existing.title,hasDeleted:existing.deleted||existing.deletedChapters.length>0});check();
   if(!['restore','reimport'].includes(choice))throw Object.assign(Error('已取消导入'),{code:'file_selection_cancelled'});
   books.importCandidate(prepared,choice,existing);check();
  }
  books.streamCandidate(prepared.book);check();
  prepared.package=await stream.packageBook(prepared,limits,onPhase);check();
  onPhase('正在准备云端导入');await require('./cloud-reader').publishBookStream(prepared,session.userId,onPhase,check);check();
  const article=prepared.entries[0].article;onPhase('导入完成',100);return prepared.multi?{...article,bookSourceUrl:prepared.source.url}:article;
 }catch(error){try{if(options.onFailure)options.onFailure(error);}catch(_){}throw error;
 }finally{try{await input.close();}finally{if(stage)await stage.close();}}
}
module.exports={parse,parseEpub,preflight,upload,uploadFile,splitTxtChapters,MAX_FILE};
