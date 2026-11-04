// Keep heading detection and thresholds aligned with phone LocalContentImporter.
// Store offsets only: chapter bodies/hashes are built after the user's decision.
const {MAX_CHAPTERS,chapterError}=require('./import-limits');
const MIN_CHAPTERS=2,MIN_CHARS=8,MIN_PREFACE=24;
function plan(text){
  const headings=[];
  const pattern=/^[\t 　]*(?:(?:第\s*[0-9０-９一二三四五六七八九十百千万亿零〇两壹贰叁肆伍陆柒捌玖拾佰仟萬]+\s*[章回卷篇部集])|(?:chapter\s+(?:[0-9]+|[ivxlcdm]+)))[\t 　:：、.．—-]*[^\r\n]{0,100}$/gim;
  let match;while((match=pattern.exec(text))){headings.push({start:match.index,title:match[0].trim().replace(/\s+/g,' ')});if(headings.length>MAX_CHAPTERS)throw chapterError('TXT');}
  if(headings.length<MIN_CHAPTERS)return null;
  const ranges=[];
  if(text.slice(0,headings[0].start).trim().length>=MIN_PREFACE)ranges.push({title:'前言',start:0,end:headings[0].start,index:1});
  const prefix=ranges.length;
  for(let i=0;i<headings.length;i++){
    const start=headings[i].start,end=i+1<headings.length?headings[i+1].start:text.length;
    if(text.slice(start,end).trim().length>=MIN_CHARS)ranges.push({title:headings[i].title,start,end,index:i+1+prefix});
  }
  if(ranges.length>MAX_CHAPTERS)throw chapterError('TXT');
  return ranges.length>=MIN_CHAPTERS?{ranges,headingCount:headings.length}:null;
}
function body(text,range){return text.slice(range.start,range.end).trim();}
module.exports={plan,body};
