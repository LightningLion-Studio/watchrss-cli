// PREVIEWGUARD: local evidence, no protocol fields and no minimum chapter length.
const compact=s=>s.replace(/[ \t\n\r\f\v]+/g,' ').replace(/^ +| +$/g,'');
function fileImportUrl(url){return /^(?:https:\/\/watchrss\.local\/import-(?:content\/(?:txt|epub)\/|txt-novel\/|epub\/)|watchrss:\/\/import\/(?:online-v1|instance-v1)\/|watchrss-(?:txt|epub):\/\/)/i.test(url||'');}
function previewEquivalent(text,excerpt){return !!excerpt.length&&compact(text)===compact(excerpt);}
function authoritativeBody({fileImport,text,excerpt,bodyEvidence,digestMatches,bodyAvailable}){
 if(bodyAvailable===false)return false;
 if(fileImport&&previewEquivalent(text,excerpt))return !!digestMatches;
 return !!(digestMatches||bodyEvidence);
}
function matchingBodyDigest(text,html,expected){
 if(!/^[a-f0-9]{64}$/.test(expected||''))return false;
 const sha=require('./crypto').sha256Hex;
 return sha(text)===expected||!!html&&previewEquivalent(require('./html-text').toText(html),text)&&sha(html)===expected;
}
function requireBookBody(article,text){
 if(typeof text!=='string')throw Object.assign(Error('导入书缺少权威正文，等待补回正文'),{code:'cloud_book_body_missing'});
 const excerpt=article.excerpt||'',fileImport=fileImportUrl(article.url),suspect=fileImport&&previewEquivalent(text,excerpt);
 const digestMatches=(suspect||article.__localBody===false||!text.length)&&matchingBodyDigest(text,article.contentHtml,article.contentHash);
 if(!authoritativeBody({fileImport,text,excerpt,bodyEvidence:typeof text==='string'&&text.length>0&&(article.__localBody!==false||text!==article.contentText),digestMatches,bodyAvailable:article.bodyAvailable}))throw Object.assign(Error('导入书缺少权威正文，等待补回正文'),{code:'cloud_book_body_missing'});
}
module.exports={matchingBodyDigest,fileImportUrl,previewEquivalent,authoritativeBody,requireBookBody};
