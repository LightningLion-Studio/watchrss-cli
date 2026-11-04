// BOM is authoritative. BOM-less input retries strict GB18030 only on a UTF-8
// syntax error. Text safety failures (NUL / surrogate / UTF-32) never retry.
const util=require('./util');
function invalid(message){return Object.assign(Error(message||'TXT 文件编码无效，请使用 UTF-8、UTF-16 或 GB18030 编码后重试'),{code:'txt_encoding_invalid'});}
function safety(message){return Object.assign(Error(message),{code:'txt_unicode_invalid'});}
function header(bytes){
 if(bytes[0]===255&&bytes[1]===254&&bytes[2]===0&&bytes[3]===0||bytes[0]===0&&bytes[1]===0&&bytes[2]===254&&bytes[3]===255)throw safety('TXT 文件不支持 UTF-32，请转换为 UTF-8 后再上传');
 if(bytes[0]===255&&bytes[1]===254)return{encoding:'le',skip:2,bom:true};
 if(bytes[0]===254&&bytes[1]===255)return{encoding:'be',skip:2,bom:true};
 if(bytes[0]===239&&bytes[1]===187&&bytes[2]===191)return{encoding:'utf8',skip:3,bom:true};
 return{encoding:'utf8',skip:0,bom:false};
}
function strictUtf8(bytes){
 // Validate even when util's JS fallback or a host decoder is permissive.
 for(let i=0;i<bytes.length;){const a=bytes[i++];if(a<128)continue;
  const n=a>=194&&a<=223?1:a>=224&&a<=239?2:a>=240&&a<=244?3:0;if(!n||i+n>bytes.length)throw invalid();
  const b=bytes[i];if(b<128||b>191||a===224&&b<160||a===237&&b>159||a===240&&b<144||a===244&&b>143)throw invalid();
  for(let end=i+n;i<end;i++)if(bytes[i]<128||bytes[i]>191)throw invalid();
 }
 const bom=bytes[0]===239&&bytes[1]===187&&bytes[2]===191;let text=util.bytesToUtf8(bytes);
 if(bom&&util.utf8ToBytes(text).length===bytes.length-3)text='\ufeff'+text;
 return text;
}
function createDecoder(encoding,options){
 const gb=encoding==='gb18030'?require('./gb18030').createDecoder(options):null;let pending=new Uint8Array(0),high='',failed=false;
 return{get backend(){return gb?gb.backend:encoding;},get pendingBytes(){return(gb?gb.pendingBytes:pending.length)+high.length*2;},decode(input=new Uint8Array(0),{stream=false}={}){
  if(failed)throw invalid();try{
   let text='';
   if(gb)text=gb.decode(input,{stream});
   else{const bytes=pending.length?util.bytesConcat([pending,input]):input;let end=bytes.length;
    if(encoding==='utf8'){
     let start=end-1;while(start>=0&&(bytes[start]&192)===128)start--;
     if(start>=0){const b=bytes[start],n=b>=194&&b<=223?2:b>=224&&b<=239?3:b>=240&&b<=244?4:1;if(end-start<n)end=start;}
     text=strictUtf8(bytes.subarray(0,end));
    }else{end-=end%2;const parts=[],codes=[];for(let i=0;i<end;i+=2){codes.push(encoding==='le'?bytes[i]|bytes[i+1]<<8:bytes[i]<<8|bytes[i+1]);if(codes.length===4096){parts.push(String.fromCharCode.apply(null,codes));codes.length=0;}}if(codes.length)parts.push(String.fromCharCode.apply(null,codes));text=parts.join('');}
    pending=bytes.slice(end);if(!stream&&pending.length)throw invalid();
   }
   text=high+text;high='';if(stream&&/[\uD800-\uDBFF]/.test(text.slice(-1))){high=text.slice(-1);text=text.slice(0,-1);}
   for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c===0)throw safety('TXT 文件含 NUL，请检查编码并转换为 UTF-8 后再上传');if(c>=0xd800&&c<=0xdbff){const next=text.charCodeAt(++i);if(next>=0xdc00&&next<=0xdfff)continue;}else if(c<0xdc00||c>0xdfff)continue;throw safety('TXT 文件含无效 Unicode，请检查编码并转换为 UTF-8 后再上传');}
   return text;
  }catch(error){failed=true;throw error;}
 }};
}
function decode(bytes,options){
 const h=header(bytes);try{return createDecoder(h.encoding,options).decode(bytes.subarray(h.skip));}
 catch(error){if(h.bom||error.code!=='txt_encoding_invalid')throw error;return createDecoder('gb18030',options).decode(bytes);}
}
module.exports={header,createDecoder,decode,strictUtf8};
