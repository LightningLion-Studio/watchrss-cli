// Sparse durable overlays. Each base replacement carries a generation in the
// same atomic JSON write, so interrupted retirement cannot replay an old intent.
const storage=require('./storage'),cpu=require('./cooperative');
const MARK='__watchrssMapGeneration';let host=null;const cache=new Map();
function entries(path){if(host!==storage.root){host=storage.root;cache.clear();}let entry=cache.get(path);if(!entry){entry={buckets:new Map(),generation:null};cache.set(path,entry);}return entry;}
function unwrap(path,value){const entry=entries(path),marker=value&&value[MARK],hasMarker=typeof marker==='string'&&/^g1:[0-9]+$/.test(marker),generation=hasMarker?marker:'legacy';if(entry.generation!==generation){entry.buckets.clear();entry.generation=generation;}if(hasMarker)delete value[MARK];return value;}
function prepareWrite(path,value){if(!value||typeof value!=='object'||Array.isArray(value))return value;const entry=entries(path);if(entry.generation===null)storage.readJSONRaw(path,{});const prior=/^g1:[0-9]+$/.test(entry.generation)?BigInt(entry.generation.slice(3)):0n;return{...value,[MARK]:'g1:'+String(prior+1n)};}
function committed(path,value){const entry=entries(path);entry.generation=value&&value[MARK]||'legacy';entry.buckets.clear();}
function bucket(key){let n=0;for(let i=0;i<key.length;i++)n=(Math.imul(n,31)+key.charCodeAt(i))>>>0;return n%128;}
function pathFor(path,n){return path+'.parts/'+n+'.json';}
function partValues(part,entry){if(part&&part.epoch!==undefined)return part.epoch===entry.generation?part.values||{}:{};return entry.generation==='legacy'?part||{}:{};}
function overlay(base,part){for(const [key,value]of Object.entries(part)){if(value===null)delete base[key];else Object.defineProperty(base,key,{value,writable:true,enumerable:true,configurable:true});}return base;}
function read(path,fallback={}){let base=storage.readJSONRaw(path,fallback);const entry=entries(path);for(const name of storage.listDir(path+'.parts')){if(!/^\d+\.json$/.test(name))continue;const n=Number(name.slice(0,-5)),part=partValues(storage.readJSONCached(pathFor(path,n),{}),entry);entry.buckets.set(n,part);if(Object.keys(part).length)base=overlay(base||{},part);}return base;}
async function readAsync(path,fallback={}){const root=storage.root,revision=storage.revision(path);let base=await storage.readJSONAsync(path,fallback);const entry=entries(path);for(const name of storage.listDir(path+'.parts')){if(!/^\d+\.json$/.test(name))continue;const n=Number(name.slice(0,-5)),part=partValues(await storage.readJSONAsync(pathFor(path,n),{}),entry);if(storage.root!==root||storage.revision(path)!==revision)throw Object.assign(Error('本机资料已更新'),{code:'local_storage_changed'});entry.buckets.set(n,part);if(Object.keys(part).length)base=overlay(base||{},part);await cpu.turn();}return base;}
function patch(path,key,value){const entry=entries(path);if(entry.generation===null)storage.readJSONRaw(path,{});const n=bucket(key),part=entry.buckets.get(n)||partValues(storage.readJSONCached(pathFor(path,n),{}),entry),next={...part,[key]:value};storage.writeText(pathFor(path,n),JSON.stringify({epoch:entry.generation,values:next}),{compact:false});entry.buckets.set(n,next);storage.invalidate(path);}
function clear(path,remove=false){if(remove)storage.removeTree(path+'.parts');cache.delete(path);}
module.exports={read,readAsync,patch,clear,unwrap,prepareWrite,committed};
