// CLI quota uses the filesystem containing WATCHRSS_HOME, not a mini quota.
const fs=require('node:fs'),path=require('node:path'),storage=require('./storage');
const RESERVE=2*1024*1024,active=new Set();
function full({used=0,required=0,limit=0}={},cause){return Object.assign(Error('本机文件空间不足，请释放空间或拆分文件后重试；原有书籍和未上传资料保留'),{code:'local_storage_full',usedBytes:used,requiredBytes:required,limitBytes:limit,cause});}
async function reclaim(check=()=>{}){
 const parent=storage.location('tmp/stream-import');let entries;try{entries=await fs.promises.readdir(parent);}catch(error){if(error.code==='ENOENT')return;throw error;}
 // Unknown directories and any possible pending payload are durable by default.
 const rows=require('./storage-budget').inventory().rows,paths=rows.map(row=>path.relative(storage.root,row.path).split(path.sep).join('/'));
 if(require('./storage-protection').snapshot(paths).pending)return;
 for(const name of entries){check();if(!/^import-[a-zA-Z0-9]{6}$/.test(name))continue;const root=path.join(parent,name);if(!active.has(root)&&!(await fs.promises.lstat(root)).isSymbolicLink())await fs.promises.rm(root,{recursive:true,force:true});check();}
}
function estimate(name,size,limits){const text=/\.txt$/i.test(name)?Math.min(limits.maxTextBytes,Math.ceil(size*1.5)):limits.maxTextBytes,packed=Math.min(limits.maxPackageBytes,text*6+2*1024*1024);return Math.max(text+packed,packed*2)+RESERVE;}
async function preflight(name,size,limits,check=()=>{}){
 check();await fs.promises.mkdir(storage.root,{recursive:true,mode:0o700});await reclaim(check);check();const info=await fs.promises.statfs(storage.root);check();const required=estimate(name,size,limits),available=info.bavail*info.bsize;
 const budget=require('./storage-budget');budget.refresh();budget.ensure(required);check();
 if(available<required)throw full({used:(info.blocks-info.bfree)*info.bsize,required,limit:info.blocks*info.bsize});budget.recordAdmission({usedBytes:budget.status().usedBytes,requiredBytes:required,remainingBytes:Math.max(0,budget.BUDGET-budget.status().usedBytes)});return{availableBytes:available,requiredBytes:required};
}
module.exports={RESERVE,active,reclaim,estimate,preflight,full};
