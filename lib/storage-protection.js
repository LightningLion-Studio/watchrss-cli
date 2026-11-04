// CLI local libraries are durable data, including acknowledged hybrid books.
const storage=require('./storage'),nodePath=require('node:path');
function derived(path){return /^cache\/(?:rss-bodies|book-seek|book-range|remote-chunks|local-book-ranges)\//.test(path);}
function core(path){return !derived(path);}
function queue(path){return /(?:^|\/)(?:operations|cloud-library-operations|pending-operations|outbox|local-payload-outbox|pending-upload|upload-plans|reservations|payment_pending)\.json(?:\.parts\/.*)?$/.test(path);}
function projection(path){return /^lib\//.test(path);}
function normalize(value){
 if(typeof value!=='string'||value.includes('\\')||value.includes('\0')||value.includes('://'))return null;
 const root=nodePath.dirname(nodePath.dirname(storage.location('state/__protection__')));
 if(nodePath.isAbsolute(value)){if(!value.startsWith(root+nodePath.sep))return null;value=value.slice(root.length+1);}
 const profile=nodePath.relative(storage.root,root).replaceAll(nodePath.sep,'/');if(profile&&value.startsWith(profile+'/'))value=value.slice(profile.length+1);
 return value.split('/').every(p=>p&&p!=='.'&&p!=='..')?value:null;
}
function snapshot(paths){
 const exact=new Set(),trees=new Set(),seen=new Set();let pending=false;
 for(const path of paths){if(core(path))exact.add(path);if(/(?:^|\/)records\.json$/.test(path)){try{const value=storage.readJSON(path,null);if(value!==null&&(typeof value!=='object'||['editPending','migrations','rssRetirements','bookRetirements'].some(key=>Object.keys(value[key]||{}).length)))pending=true;}catch(_){pending=true;}}if(!queue(path))continue;const base=path.split('.parts/')[0];if(path.includes('.parts/')&&!storage.isMapPath(base))pending=true;if(seen.has(base))continue;seen.add(base);exact.add(base);trees.add(base+'.parts');
  const fs=require('node:fs');let linked=false;for(const name of [base,base+'.parts'])try{linked=linked||fs.lstatSync(storage.location(name)).isSymbolicLink();}catch(error){if(error.code!=='ENOENT')linked=true;}if(linked){pending=true;continue;}
  try{const value=storage.readJSON(base,null);if(value!==null&&(typeof value!=='object'||Array.isArray(value)||Object.keys(value).length))pending=true;}catch(_){pending=true;}
 }
 // Fail closed even for old operation schemas with no explicit payload field.
 // The cache can be reclaimed after pending work is acknowledged, not before.
 return{exact,trees,pending,has:path=>core(path)||pending||exact.has(path),reason:path=>core(path)?'durable-cli-data':pending?'pending-work':'cache'};
}
module.exports={derived,core,queue,projection,normalize,snapshot};
