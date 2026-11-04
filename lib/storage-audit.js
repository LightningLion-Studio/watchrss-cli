// Node-only, read-only diagnostics. Aggregate WATCHRSS_HOME logical file sizes.
// RAM-only cloud caches and WeChat KV/saveFile have no disk quota equivalent.
const storage=require('./storage'),budget=require('./storage-budget'),path=require('node:path');
function category(name){
 name=name.replace(/^modes\/[^/]+\//,'');
 if(/(?:session|identity|appaccess|mini_access|cli-access|membership-cache|config)\.json$|(?:^|\/)keys\//.test(name))return 'account-and-keys';
 if(require('./storage-protection').queue(name)||/(?:^|\/)library_dirty\.json$/.test(name))return 'pending-work';
 if(/\/books\/.*\.jsonl$/.test(name))return 'book-packages';
 if(/saved-bodies\//.test(name))return 'saved-bodies';
 if(/book-state/.test(name))return 'R44-book-registry';
 if(/\/content\.json$/.test(name))return 'R45-generation';
 if(/(?:records|records-checkpoint|quarantine|exchange|r48-overlay)\.json$/.test(name))return 'records-and-projection-state';
 if(/tmp\/stream-import\//.test(name))return 'stream-import-staging';
 if(/cache\/book-seek\//.test(name))return 'book-seek';
 if(/cache\/book-range\//.test(name))return 'book-range';
 if(/cache\/local-book-ranges\//.test(name))return 'local-book-ranges';
 if(/cache\/remote-chunks\//.test(name))return 'remote-reader-ciphertext';
 if(/manifest|chunks|encoding/.test(name))return 'cloud-cache';
 if(/cache\/rss-bodies\//.test(name))return 'RSS-body-LRU';
 if(/article-index/.test(name))return 'article-index';
 if(/articles\.json$/.test(name))return 'legacy-library-and-bodies';
 if(/saveFile:/.test(name))return 'legacy-saveFile';
 return 'state-or-unknown';
}
function owner(){return storage.root+':'+storage.location('state/__audit__')+':'+storage.getMode();}
function policy(key){return budget.reclaimable(key)?'reclaimable-cache':'protected-work-or-identity';}
async function inventory(){
 const measured=budget.inventory(),activeRoot=path.dirname(path.dirname(storage.location('state/__audit__')));budget.refreshProtection(true);
 const rows=measured.rows.map(file=>{const key=path.relative(storage.root,file.path).split(path.sep).join('/'),logical=file.path.startsWith(activeRoot+path.sep)?file.path.slice(activeRoot.length+1):null;return{medium:'file',key,bytes:file.bytes,category:category(key),policy:logical?policy(logical):'protected-work-or-identity',receipted:!!logical&&budget.confirmed(logical)};});
 const totals={};for(const row of rows)totals[row.category]=(totals[row.category]||0)+row.bytes;
 return{kvCurrentKiB:null,kvLimitKiB:null,fileUsedBytes:measured.usedBytes,fileLimitBytes:measured.limitBytes,budgetBytes:measured.budgetBytes,diskAvailableBytes:measured.diskAvailableBytes,filesystemTotalBytes:measured.filesystemTotalBytes,configuredLimitBytes:measured.configuredLimitBytes,savedBytes:0,totals,rows};
}
let latest=null,latestOwner=null;
function admission(){const value=budget.status().admission;if(!value)return null;const out={};for(const key of ['requiredBytes','usedBytes','freedBytes','remainingBytes','reclaimableBytes','writeRequiredBytes','reservedBytes'])if(Number.isSafeInteger(value[key])&&value[key]>=0)out[key]=value[key];if(typeof value.exhausted==='boolean')out.exhausted=value.exhausted;return out;}
async function getStorageDiagnostics(){
 const before=owner(),data=await inventory();if(owner()!==before)throw Error('Storage owner changed');const categories={};
 for(const row of data.rows){const value=categories[row.category]||(categories[row.category]={bytes:0,files:0,receiptedFiles:0,reclaimableBytes:0,protectedBytes:0});value.bytes+=row.bytes;value.files++;if(row.receipted)value.receiptedFiles++;value[row.policy==='reclaimable-cache'?'reclaimableBytes':'protectedBytes']+=row.bytes;}
 latestOwner=before;latest={version:2,platform:'node',usageScope:'WATCHRSS_HOME',measurement:'logical-file-bytes-no-symlink-traversal',kvSupported:false,usedBytes:data.fileUsedBytes,limitBytes:data.fileLimitBytes,budgetBytes:data.budgetBytes,diskAvailableBytes:data.diskAvailableBytes,filesystemTotalBytes:data.filesystemTotalBytes,configuredLimitBytes:data.configuredLimitBytes,categories,admission:admission()};return latest;
}
function lastDiagnostics(){return owner()===latestOwner?latest:null;}
module.exports={inventory,category,policy,getStorageDiagnostics,lastDiagnostics};
