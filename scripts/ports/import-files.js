// CLI override for the pinned mini import-files module. Never use KV staging.
const fs=require('node:fs'),path=require('node:path'),storage=require('./storage');
const BLOCK=65536,active=require('./import-space').active;
function full(error){return Object.assign(Error('本机资料尚未保存，请释放空间后重试；原有资料仍保留'),{code:'local_storage_full',cause:error});}
async function open(filePath,check=()=>{}){
 check();const release=require('./storage-budget').hold(filePath);let handle;try{handle=await fs.promises.open(filePath,'r');}catch(error){release();throw error;}let closed=false;
 try{check();const stat=await handle.stat();check();
  if(!stat.isFile()||!Number.isSafeInteger(stat.size)||stat.size<0)throw Error('文件长度无效');
  return{size:stat.size,async read(start,end){check();if(closed||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>stat.size||end-start>BLOCK)throw Error('文件读取范围无效');
   const out=new Uint8Array(end-start);let at=0;
   while(at<out.length){const {bytesRead}=await handle.read(out,at,out.length-at,start+at);check();if(bytesRead<=0||bytesRead>out.length-at)throw Error('文件在导入期间已改变');at+=bytesRead;}
   return out;
  },async close(){if(closed)return;closed=true;try{await handle.close();}finally{release();}}};
 }catch(error){await handle.close().catch(()=>{});release();throw error;}
}
async function readAll(filePath,maxBytes,check=()=>{}){
 const source=await open(filePath,check);
 try{if(source.size>maxBytes)throw Error('请选择 8 MB 以内的 TXT 或 EPUB 文件');
  const out=new Uint8Array(source.size);let at=0;for await(const part of bytes(source)){out.set(part,at);at+=part.length;}check();return out;
 }finally{await source.close();}
}
async function stage(check=()=>{}){
 check();await require('./import-space').reclaim(check);check();const parent=storage.location('tmp/stream-import');let root;
 try{
  fs.mkdirSync(parent,{recursive:true,mode:0o700});fs.chmodSync(parent,0o700);
  root=fs.mkdtempSync(path.join(parent,'import-'));fs.chmodSync(root,0o700);
 }catch(error){throw full(error);}
 active.add(root);let closed=false;
 const guard=()=>{check();if(closed)throw Error('导入已取消');};
 const location=n=>{if(!/^[a-zA-Z0-9._-]+$/.test(n)||n==='.'||n==='..')throw Error('Invalid staging name');return path.join(root,n);};
 return{root,path:location,check:guard,
  async remove(n){guard();await fs.promises.rm(location(n),{force:true});guard();},
  async release(){guard();for(const n of await fs.promises.readdir(root))if(n!=='package')await this.remove(n);},
  async writer(n){guard();const filePath=location(n);try{await fs.promises.writeFile(filePath,new Uint8Array(0),{mode:0o600});}catch(error){throw full(error);}guard();let size=0;
   return{filePath,get size(){return size;},async append(value){guard();for(let at=0;at<value.length;at+=BLOCK){const part=value.subarray(at,at+BLOCK);try{await fs.promises.appendFile(filePath,part);}catch(error){throw full(error);}size+=part.length;guard();}}};
  },open:n=>{guard();return open(location(n),guard);},
  async put(n,value){const writer=await this.writer(n);await writer.append(value);},
  async get(n){const source=await this.open(n);try{if(source.size>4*1024*1024+65536)throw Error('暂存密文块超过上限');const chunks=[];for await(const part of bytes(source))chunks.push(part);return require('./util').bytesConcat(chunks);}finally{await source.close();}},
  async close(){if(closed)return;closed=true;active.delete(root);await fs.promises.rm(root,{recursive:true,force:true});}
 };
}
// Keep the mini synchronous rename/metadata boundary. Cloud mode keeps no body.
function commit(filePath,relative){
 try{if(storage.getMode()==='cloud')fs.rmSync(filePath,{force:true});
  else{const target=storage.location(relative);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.renameSync(filePath,target);fs.chmodSync(target,0o600);}
 }catch(error){throw full(error);}storage.invalidate(relative);
}
async function* bytes(source,start=0,end=source.size,width=BLOCK){for(let at=start;at<end;at+=width)yield await source.read(at,Math.min(end,at+width));}
module.exports={open,readAll,stage,bytes,BLOCK,commit,reclaim:require('./import-space').reclaim,preflight:require('./import-space').preflight};
