// Native Node filesystem adapter; revision/CAS checks surround atomic rename.
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),storage=require('./storage');
function stale(){return Object.assign(Error('本机资料已更新，请重试'),{code:'local_storage_changed'});}
function fence(relative){const rev=storage.revision(relative),file=storage.location(relative);return()=>{if(storage.revision(relative)!==rev||storage.location(relative)!==file)throw stale();};}
async function readBytes(relative){const check=fence(relative);if(storage.getMode()==='cloud'){const bytes=storage.readBytes(relative);check();return bytes;}try{const bytes=new Uint8Array(await fs.readFile(storage.location(relative)));check();return bytes;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function readText(relative){const bytes=await readBytes(relative);return bytes===null?null:Buffer.from(bytes).toString('utf8');}
async function readJSON(relative,fallback=null){const check=fence(relative),text=await readText(relative);check();let value=text===null?fallback:await require('./cooperative').parse(text,check);return storage.isMapPath(relative)?require('./state-map').unwrap(relative,value):value;}
async function writeBytes(relative,bytes,{check:caller=()=>{},onCommit=()=>{}}={}){const local=fence(relative),check=()=>{caller();local();};check();if(storage.getMode()==='cloud'){const result=storage.writeBytes(relative,bytes);onCommit();return result;}const file=storage.location(relative),temp=file+'.'+randomUUID()+'.tmp';await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});try{await fs.writeFile(temp,bytes,{mode:0o600,flag:'wx'});check();require('node:fs').renameSync(temp,file);storage.invalidate(relative);onCommit();return file;}finally{await fs.rm(temp,{force:true});}}
async function writeText(relative,text,options){return writeBytes(relative,text,options);}
async function writeJSON(relative,value,options={}){const check=fence(relative),map=storage.isMapPath(relative)?require('./state-map'):null,prepared=map?map.prepareWrite(relative,value):value,text=await require('./cooperative').stringify(prepared,()=>{check();options.check?.();});return writeText(relative,text,{...options,onCommit:()=>{if(map)map.committed(relative,prepared);options.onCommit?.();}});}
async function utf8(bytes,check=()=>{}){check();return Buffer.from(bytes).toString('utf8');}
async function utf8Strict(bytes,check=()=>{}){check();return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
async function utf8Encode(text,check=()=>{}){check();return new Uint8Array(Buffer.from(text));}
module.exports={readBytes,readText,readJSON,writeBytes,writeText,writeJSON,utf8,utf8Strict,utf8Encode,fence};
