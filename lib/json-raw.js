// Authenticated JSON editing: retain source tokens, including numbers which JS
// cannot represent. This is deliberately independent of migration-plan JCS.
const util=require('./util');
const nodes=new WeakMap();
function invalid(reason='invalid_json'){return Object.assign(Error('云内容 JSON 无效'),{code:'cloud_format_invalid',reason});}
function unicode(s){for(let i=0;i<s.length;i++){const n=s.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const low=s.charCodeAt(++i);if(!(low>=0xdc00&&low<=0xdfff))throw invalid('invalid_unicode');}else if(n>=0xdc00&&n<=0xdfff)throw invalid('invalid_unicode');}return s;}
function parse(text){if(typeof text!=='string')throw invalid();let at=0,maxDepth=0;
 const space=()=>{while(/[\x20\t\r\n]/.test(text[at]||'x'))at++;};
 function string(){const start=at;if(text[at++]!=='"')throw invalid();for(;at<text.length;at++){if(text[at]==='\\'){at++;if(text[at]==='u'){if(!/^[a-f\d]{4}$/i.test(text.slice(at+1,at+5)))throw invalid();at+=4;}else if(!'"\\/bfnrt'.includes(text[at]||'x'))throw invalid();}else if(text[at]==='"'){at++;try{return unicode(JSON.parse(text.slice(start,at)));}catch(error){if(error.code==='cloud_format_invalid')throw error;throw invalid();}}else if(text.charCodeAt(at)<32)throw invalid();}throw invalid();}
 function value(depth){space();const start=at,c=text[at];let v,entries=[];
  if(c==='{'||c==='['){maxDepth=Math.max(maxDepth,depth);if(depth>256)throw invalid();at++;space();v=c==='{'?{}:[];const seen=new Set();if(text[at]!== (c==='{'?'}':']'))for(;;){space();let key,keyStart=at,keyEnd=at;if(c==='{'){key=string();keyEnd=at;if(seen.has(key))throw invalid('duplicate_key');seen.add(key);space();if(text[at++]!==':')throw invalid();}const child=value(depth+1);if(c==='{')Object.defineProperty(v,key,{value:child.value,writable:true,configurable:true,enumerable:true});else{key=v.length;v.push(child.value);}entries.push({key,keyStart,keyEnd,node:child});space();if(text[at]===','){at++;continue;}break;}if(text[at++]!==(c==='{'?'}':']'))throw invalid();
  }else if(c==='"')v=string();else{const match=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));if(!match)throw invalid();at+=match[0].length;v=JSON.parse(match[0]);}
  const n={text,start,end:at,value:v,entries,maxDepth:0};if(v&&typeof v==='object')nodes.set(v,n);return n;
 }
 const root=value(1);space();if(at!==text.length)throw invalid();root.maxDepth=maxDepth;return root.value;
}
function serialize(value,node=nodes.get(value)){
 if(!node)return JSON.stringify(value);if(!value||typeof value!=='object')return Object.is(value,node.value)?node.text.slice(node.start,node.end):JSON.stringify(value);
 const keys=Object.keys(value).filter(k=>value[k]!==undefined),original=node.entries.map(e=>String(e.key));
 if(keys.length===original.length&&keys.every((k,i)=>k===original[i])){const parts=[];let at=node.start;for(const e of node.entries){parts.push(node.text.slice(at,e.node.start),serialize(value[e.key],nodes.get(value[e.key])||e.node));at=e.node.end;}parts.push(node.text.slice(at,node.end));return parts.join('');}
 if(Array.isArray(value))return'['+value.map(v=>serialize(v)).join(',')+']';
 return'{'+keys.map(k=>{const e=node.entries.find(e=>e.key===k);return(e?node.text.slice(e.keyStart,e.node.start):JSON.stringify(k)+':')+serialize(value[k],nodes.get(value[k])||(e&&e.node));}).join(',')+'}';
}
function merge(base,patch){if(!base||typeof base!=='object'||Array.isArray(base)||!patch||typeof patch!=='object'||Array.isArray(patch))return patch;const result={...base};for(const key of Object.keys(patch))Object.defineProperty(result,key,{value:merge(base[key],patch[key]),writable:true,enumerable:true,configurable:true});const node=nodes.get(base);if(node)nodes.set(result,node);return result;}
function raw(value){return serialize(value);}
function unknownBytes(value,known){const n=nodes.get(value);if(!n)return 0;let bytes=0;for(const e of n.entries){const rule=known&&Object.prototype.hasOwnProperty.call(known,e.key)?known[e.key]:null;if(!rule)bytes+=util.utf8ByteLength(n.text.slice(e.keyStart,e.node.end));else if(typeof rule==='object'){const child=value[e.key];if(Array.isArray(child))for(const item of child)bytes+=unknownBytes(item,rule);else if(child&&typeof child==='object')bytes+=unknownBytes(child,rule);}}return bytes;}
module.exports={parse,stringify:serialize,merge,raw,unknownBytes,meta:value=>nodes.get(value),unicode};

function* parseSteps(text){if(typeof text!=='string')throw invalid();let at=0,maxDepth=0;
 const space=()=>{while(/[\x20\t\r\n]/.test(text[at]||'x'))at++;};
 function* string(){let yielded=at;const start=at;if(text[at++]!=='"')throw invalid();for(;at<text.length;at++){if(at-yielded>=4096){yielded=at;yield;}if(text[at]==='\\'){at++;if(text[at]==='u'){if(!/^[a-f\d]{4}$/i.test(text.slice(at+1,at+5)))throw invalid();at+=4;}else if(!'"\\/bfnrt'.includes(text[at]||'x'))throw invalid();}else if(text[at]==='"'){at++;try{const value=yield* require('./cooperative').decodeSteps(text.slice(start,at));for(let i=0;i<value.length;i+=4096){let end=Math.min(value.length,i+4096);if(end<value.length&&value.charCodeAt(end-1)>=0xd800&&value.charCodeAt(end-1)<=0xdbff)end--;unicode(value.slice(i,end));i=end-4096;yield;}return value;}catch(error){if(error.code==='cloud_format_invalid')throw error;throw invalid();}}else if(text.charCodeAt(at)<32)throw invalid();}throw invalid();}
 function* value(depth){yield;space();const start=at,c=text[at];let v,entries=[];
  if(c==='{'||c==='['){maxDepth=Math.max(maxDepth,depth);if(depth>256)throw invalid();at++;space();v=c==='{'?{}:[];const seen=new Set();if(text[at]!== (c==='{'?'}':']'))for(;;){space();let key,keyStart=at,keyEnd=at;if(c==='{'){key=yield* string();keyEnd=at;if(seen.has(key))throw invalid('duplicate_key');seen.add(key);space();if(text[at++]!==':')throw invalid();}const child=yield* value(depth+1);if(c==='{')Object.defineProperty(v,key,{value:child.value,writable:true,configurable:true,enumerable:true});else{key=v.length;v.push(child.value);}entries.push({key,keyStart,keyEnd,node:child});space();if(text[at]===','){at++;continue;}break;}if(text[at++]!==(c==='{'?'}':']'))throw invalid();
  }else if(c==='"')v=yield* string();else{const match=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));if(!match)throw invalid();at+=match[0].length;v=JSON.parse(match[0]);}
  const n={text,start,end:at,value:v,entries,maxDepth:0};if(v&&typeof v==='object')nodes.set(v,n);return n;
 }
 const root=yield* value(1);space();if(at!==text.length)throw invalid();root.maxDepth=maxDepth;return root.value;
}
module.exports.parseAsync=(text,check)=>require('./cooperative').run(parseSteps(text),'cpu.rawJSON.parse',check);

function* serializeSteps(value,node=nodes.get(value)){
 yield;
 if(!node){const parts=[];for(const part of require('./cooperative').encodeSteps(value)){parts.push(part);yield;}return parts.join('');}
 if(!value||typeof value!=='object'){if(Object.is(value,node.value))return node.text.slice(node.start,node.end);const parts=[];for(const part of require('./cooperative').encodeSteps(value)){parts.push(part);yield;}return parts.join('');}
 const keys=Object.keys(value).filter(k=>value[k]!==undefined),original=node.entries.map(e=>String(e.key));
 if(keys.length===original.length&&keys.every((key,i)=>key===original[i])){const parts=[];let at=node.start;for(const entry of node.entries){parts.push(node.text.slice(at,entry.node.start),yield* serializeSteps(value[entry.key],nodes.get(value[entry.key])||entry.node));at=entry.node.end;}parts.push(node.text.slice(at,node.end));return parts.join('');}
 const parts=[];if(Array.isArray(value)){for(const child of value)parts.push(yield* serializeSteps(child));return'['+parts.join(',')+']';}
 const byKey=new Map(node.entries.map(entry=>[String(entry.key),entry]));for(const key of keys){const entry=byKey.get(key);parts.push((entry?node.text.slice(entry.keyStart,entry.node.start):JSON.stringify(key)+':')+(yield* serializeSteps(value[key],nodes.get(value[key])||(entry&&entry.node))));}return'{'+parts.join(',')+'}';
}
module.exports.stringifyAsync=(value,check)=>require('./cooperative').run(serializeSteps(value),'cpu.rawJSON.stringify',check);
