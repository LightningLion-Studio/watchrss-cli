'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const root=path.resolve(process.env.WATCHRSS_HOME||path.join(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local/share'),'watchrss'));
let mode='hybrid',namespace='';const memory=new Map(),revisions=new Map(),cache=new Map(),cleaners=new Set();
function namespaced(name){return namespace&&/^(lib|state|cloud|cache)\//.test(name)?`modes/${namespace}/${name}`:name;}
function location(name){const target=path.resolve(root,namespaced(name));if(!target.startsWith(root+path.sep))throw Error('Invalid storage path');return target;}
function temporary(name){return mode==='cloud'&&(/^(cloud\/(chunks|manifests)|cache\/rss-bodies)\//.test(name)||/^lib\/(?:accounts\/[^/]+\/)?(?:books\/|saved-bodies\/)/.test(name));}
function revision(name){return revisions.get(location(name))||0;}
function invalidate(name){const key=location(name);revisions.set(key,(revisions.get(key)||0)+1);cache.delete(key);}
function writeBytes(name,data){const key=location(name);if(temporary(name)){memory.set(key,Buffer.from(data));invalidate(name);return key;}
 fs.mkdirSync(path.dirname(key),{recursive:true,mode:0o700});const temp=key+'.'+process.pid+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temp,data,{mode:0o600,flag:'wx'});fs.renameSync(temp,key);invalidate(name);return key;}finally{fs.rmSync(temp,{force:true});}}
function readBytes(name){const key=location(name);if(memory.has(key))return new Uint8Array(memory.get(key));try{return new Uint8Array(fs.readFileSync(key));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function readText(name){const value=readBytes(name);return value===null?null:Buffer.from(value).toString('utf8');}
function writeText(name,text){return writeBytes(name,text);}
function readJSONRaw(name,fallback=null){const text=readText(name),value=text===null?fallback:JSON.parse(text);return isMapPath(name)?require('./state-map').unwrap(name,value):value;}
function isMapPath(name){return /(?:article-state|reader-position|operations)\.json$/.test(name);}
function readJSON(name,fallback=null){return isMapPath(name)?require('./state-map').read(name,fallback):readJSONRaw(name,fallback);}
function readJSONCached(name,fallback=null){const key=location(name),hit=cache.get(key);if(hit&&hit.rev===revision(name))return hit.value;const value=readJSON(name,fallback);cache.set(key,{rev:revision(name),value});return value;}
function writeJSON(name,value){if(mode==='cloud'&&/articles.*\.json$/.test(name)&&Array.isArray(value))value=value.map(a=>({...a,contentText:'',contentHtml:null}));const map=isMapPath(name)?require('./state-map'):null,prepared=map?map.prepareWrite(name,value):value;const result=writeText(name,JSON.stringify(prepared));if(map)map.committed(name,prepared);return result;}
function deleteFile(name){memory.delete(location(name));fs.rmSync(location(name),{force:true});invalidate(name);if(isMapPath(name)){require('./state-map').clear(name,true);}}
function removeTree(name){const key=location(name);for(const item of memory.keys())if(item===key||item.startsWith(key+path.sep))memory.delete(item);for(const item of cache.keys())if(item===key||item.startsWith(key+path.sep))cache.delete(item);fs.rmSync(key,{recursive:true,force:true});invalidate(name);}
function listDir(name){const key=location(name);let disk=[];try{disk=fs.readdirSync(key);}catch(e){if(e.code!=='ENOENT')throw e;}const mem=[...memory.keys()].filter(k=>k.startsWith(key+path.sep)).map(k=>k.slice(key.length+1).split(path.sep)[0]);return[...new Set([...disk,...mem])];}
function exists(name){return memory.has(location(name))||fs.existsSync(location(name));}
function acquireLock(){fs.mkdirSync(root,{recursive:true,mode:0o700});const lock=path.join(root,'process.lock');try{fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});}catch(e){if(e.code==='EEXIST')throw Object.assign(Error('另一个 CLI 正在运行；确认进程退出后移除 process.lock'),{code:'cli_busy'});throw e;}return()=>fs.rmSync(lock,{force:true});}
const api={root,location,resolvePath:location,writeBytes,readBytes,writeText,readText,writeJSON,readJSON,readJSONRaw,readJSONCached,deleteFile,removeTree,listDir,exists,acquireLock,revision,invalidate,isMapPath,readMap:(p,f)=>require('./state-map').read(p,f),patchMap:(p,k,v)=>require('./state-map').patch(p,k,v),clearMap:(p)=>require('./state-map').clear(p,true),registerCacheCleaner:f=>cleaners.add(f),requestCleanup:()=>{for(const f of cleaners)f(false);},setMode(value){mode=value;},getMode:()=>mode,setNamespace(value){namespace=value;cache.clear();}};
for(const [name,method]of Object.entries({readTextAsync:'readText',readJSONAsync:'readJSON',writeTextAsync:'writeText',writeJSONAsync:'writeJSON',readBytesAsync:'readBytes',writeBytesAsync:'writeBytes'}))api[name]=(...args)=>require('./storage-async')[method](...args);
module.exports=api;
