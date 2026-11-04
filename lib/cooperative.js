// A real event-loop turn, not Promise.resolve(): input and the watchdog can run.
const probe=require('./longtask');
const now=()=>typeof performance!=='undefined'&&performance.now?performance.now():Date.now();
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
async function run(iterator,label='cpu.batch',check=()=>{},wait=null){let result;for(;;){check();result=probe.run(label,0,()=>{const end=now()+4;let r;do{r=iterator.next();}while(!r.done&&!(r.value&&r.value.__backgroundTask)&&now()<end);return r;});if(result.done)return result.value;if(result.value&&result.value.__backgroundTask){await result.value.async();check();}await turn();if(wait)await wait();}}
function* string(text){yield '"';for(let i=0;i<text.length;i+=4096)yield JSON.stringify(text.slice(i,i+4096)).slice(1,-1);yield '"';}
function boundedCost(value,depth=0){
 if(typeof value==='string')return value.length*6+2;
 if(!value||typeof value!=='object')return 32;
 if(depth>8||typeof value.toJSON==='function')return Infinity;
 let bytes=2,count=0;for(const key in value){if(!Object.prototype.hasOwnProperty.call(value,key))continue;if(++count>256)return Infinity;const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value'in descriptor))return Infinity;bytes+=key.length*6+3+boundedCost(descriptor.value,depth+1);if(bytes>16384)return Infinity;}return bytes;
}
function* encode(value,ancestors=new Set(),key=''){
 if(value&&typeof value.toJSON==='function')value=value.toJSON(key);
 if(typeof value==='string'){yield* string(value);return;}
 if(!value||typeof value!=='object'){yield JSON.stringify(value);return;}
 if(boundedCost(value)<=16384){yield JSON.stringify(value);return;}
 if(ancestors.has(value))throw TypeError('Converting circular structure to JSON');ancestors.add(value);
 const array=Array.isArray(value);yield array?'[':'{';let count=0;
 for(const k of array?value.keys():Object.keys(value)){const v=value[k];if(!array&&['undefined','function','symbol'].includes(typeof v))continue;if(count++)yield ',';if(!array){yield* string(k);yield ':';}if(array&&['undefined','function','symbol'].includes(typeof v))yield 'null';else yield* encode(v,ancestors,String(k));}
 yield array?']':'}';ancestors.delete(value);
}
async function stringify(value,check){
 const parts=[];let buffer=[],chars=0;
 function* steps(){for(const part of encode(value)){buffer.push(part);chars+=(part||'').length;if(chars>=8192){parts.push(buffer.join(''));buffer=[];chars=0;}yield;}if(buffer.length)parts.push(buffer.join(''));return parts.join('');}
 return run(steps(),'cpu.JSON.stringify',check);
}
function* decode(text){let at=0;
 const white=()=>{while(at<text.length&&[32,9,10,13].includes(text.charCodeAt(at)))at++;};
 function* span(start){let quote=false,depth=0;for(let i=start;i<text.length;i++){const c=text.charCodeAt(i);if(quote){if(c===92)i++;else if(c===34){quote=false;if(!depth)return i+1;}}else{if(c===34)quote=true;else if(c===123||c===91)depth++;else if(c===125||c===93){if(!depth)return i;if(!--depth)return i+1;}else if(!depth&&(c===44||[32,9,10,13].includes(c)))return i;}if((i-start)%8192===8191)yield;}return text.length;}
 function* longString(end){let start=++at;const parts=[];while(at<end-1){if(text[at]==='\\'){at++;if(text[at]==='u')at+=4;}at++;if(at-start>=4096){parts.push(JSON.parse('"'+text.slice(start,at)+'"'));start=at;yield;}}parts.push(JSON.parse('"'+text.slice(start,end-1)+'"'));at=end;return parts.join('');}
 function* value(depth=0,knownEnd=null){white();if(depth>512)throw SyntaxError('JSON depth');const start=at,c=text[at];
  if(knownEnd!==null&&knownEnd-start<=16384){at=knownEnd;yield;return JSON.parse(text.slice(start,at));}
  if(c==='['||c==='{'){const array=c==='[',out=array?[]:{};at++;white();if(text[at]===(array?']':'}')){at++;return out;}
   for(;;){white();let key=out.length;if(!array){if(text[at]!=='"')throw SyntaxError('Expected key');const end=yield* span(at);key=JSON.parse(text.slice(at,end));at=end;white();if(text[at++]!==':')throw SyntaxError('Expected colon');}
    white();const end=yield* span(at),v=yield* value(depth+1,end);Object.defineProperty(out,key,{value:v,writable:true,enumerable:true,configurable:true});white();const sep=text[at++];if(sep===(array?']':'}'))return out;if(sep!==',')throw SyntaxError('Expected comma');yield;
   }
  }
  const end=knownEnd===null?yield* span(at):knownEnd;if(end===at)throw SyntaxError('Invalid JSON');if(c==='"'&&end-start>16384)return yield* longString(end);at=end;yield;return JSON.parse(text.slice(start,end));
 }
 const result=yield* value();white();if(at!==text.length)throw SyntaxError('Trailing JSON');return result;
}
async function parse(text,check){return run(decode(text),'cpu.JSON.parse',check);}
function* mapSteps(rows,fn){const result=[];for(let i=0;i<rows.length;i++){result.push(fn(rows[i],i));yield;}return result;}
module.exports={turn,run,parse,stringify,decodeSteps:decode,encodeSteps:encode,map:(rows,fn,check)=>run(mapSteps(rows,fn),'cpu.map',check)};
