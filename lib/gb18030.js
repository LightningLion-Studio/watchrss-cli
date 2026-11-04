// Strict GB18030-2022 / Android 15 ICU mapping. No replacement decoding.
// The grammar is shared by native and JS backends; at most 3 bytes are pending.
const util=require('./util');
let table,ranges,probedConstructor,probedLabel;
function invalid(){return Object.assign(Error('TXT 文件编码无效，请使用 UTF-8、UTF-16 或 GB18030 编码后重试'),{code:'txt_encoding_invalid'});}
function load(){
 if(table)return;
 const data=require('./gb18030-data'),bytes=require('./gzip').gunzip(util.base64Decode(data.data));
 table=new Uint16Array(23940);ranges=data.ranges;let at=0,previous=0;
 for(let i=0;i<table.length;i++){let n=0,shift=0,b;do{b=bytes[at++];n+=(b&127)*2**shift;shift+=7;}while(b&128);previous+=(n&1)?-(n+1)/2:n/2;table[i]=previous;}
}
function four(pointer){
 if(pointer>1237575||pointer>39419&&pointer<189000)throw invalid();
 // The 2005 reassignment is an exception to the monotonic BMP ranges.
 if(pointer===7457)return 0xe7c7;
 let lo=0,hi=ranges.length-1;
 while(lo<hi){const mid=(lo+hi+1)>>1;if(ranges[mid][0]<=pointer)lo=mid;else hi=mid-1;}
 return ranges[lo][1]+pointer-ranges[lo][0];
}
function pointBytes(p){const d=p%10;p=Math.floor(p/10);const c=p%126;p=Math.floor(p/126);return[129+Math.floor(p/10),48+p%10,129+c,48+d];}
function scanner(bytes,final,emit){
 const parts=[],codes=[];let at=0;
 const put=cp=>{if(!emit)return;if(cp>0xffff){cp-=0x10000;codes.push(0xd800+(cp>>10),0xdc00+(cp&1023));}else codes.push(cp);if(codes.length>=4096){parts.push(String.fromCharCode.apply(null,codes));codes.length=0;}};
 while(at<bytes.length){const start=at,a=bytes[at++];
  if(a<128){put(a);continue;}if(a===128){put(0x20ac);continue;}if(a<129||a>254)throw invalid();
  if(at===bytes.length){at=start;break;}const b=bytes[at++];
  if(b>=48&&b<=57){
   if(at===bytes.length){at=start;break;}const c=bytes[at++];if(c<129||c>254)throw invalid();
   if(at===bytes.length){at=start;break;}const d=bytes[at++];if(d<48||d>57)throw invalid();
   put(four(((a-129)*10+b-48)*1260+(c-129)*10+d-48));
  }else{if(b<64||b===127||b>254)throw invalid();put(table[(a-129)*190+b-(b<127?64:65)]);}
 }
 if(final&&at!==bytes.length)throw invalid();
 if(codes.length)parts.push(String.fromCharCode.apply(null,codes));return{end:at,text:parts.join('')};
}
function nativeLabel(Decoder){
 if(probedConstructor===Decoder)return probedLabel;
 probedConstructor=Decoder;probedLabel=null;if(typeof Decoder!=='function')return null;
 // Compare every double-byte entry, all range edges, and the 2005 exception.
 // A label alone is insufficient: GBK aliases and old ICU mappings differ.
 const bytes=[65,128];for(let a=129;a<=254;a++)for(let b=64;b<=254;b++)if(b!==127)bytes.push(a,b);
 const points=new Set([7457]);for(const [p]of ranges)for(const n of [p-1,p,p+1])if(n>=0&&(n<=39419||n>=189000&&n<=1237575))points.add(n);
 points.add(39419);points.add(1237575);for(const p of points)bytes.push(...pointBytes(p));
 const vector=new Uint8Array(bytes),expected=scanner(vector,true,true).text;
 for(const label of ['gb18030','gbk'])try{
  const make=()=>new Decoder(label,{fatal:true,ignoreBOM:true});
  if(make().decode(vector)!==expected)continue;
  let strict=true;for(const bad of [[255],[129],[129,48],[129,48,129],[129,127],[129,48,128,48],pointBytes(39420),pointBytes(1237576)]){
   try{make().decode(new Uint8Array(bad));strict=false;break;}catch(_){}
  }
  if(!strict)continue;
  const d=make();if(d.decode(new Uint8Array([129,48,129]),{stream:true})!==''||d.decode(new Uint8Array([48]),{stream:true})!=='\u0080'||d.decode()!=='')continue;
  const flush=make();flush.decode(new Uint8Array([129]),{stream:true});try{flush.decode();continue;}catch(_){}
  probedLabel=label;break;
 }catch(_){}
 return probedLabel;
}
function createDecoder({native=true,Decoder=typeof TextDecoder==='undefined'?null:TextDecoder}={}){
 load();const label=native?nativeLabel(Decoder):null,decoder=label?new Decoder(label,{fatal:true,ignoreBOM:true}):null;let pending=new Uint8Array(0),failed=false;
 return{backend:label?'native:'+label:'javascript',get pendingBytes(){return pending.length;},decode(input=new Uint8Array(0),{stream=false}={}){
  if(failed)throw invalid();try{
   const bytes=pending.length?util.bytesConcat([pending,input]):input,result=scanner(bytes,!stream,!decoder);
   pending=bytes.slice(result.end);
   // Pass complete characters only. Native code never owns hidden pending state.
   return decoder?decoder.decode(bytes.subarray(0,result.end)):result.text;
  }catch(error){failed=true;throw error;}
 }};
}
module.exports={createDecoder};
