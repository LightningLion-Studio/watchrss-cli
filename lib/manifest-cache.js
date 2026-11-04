'use strict';
// Optional, bounded ciphertext cache. Trust/epoch/content clear owns its parent.
const storage=require('./storage'),scope=require('./cloud-scope'),fs=require('node:fs');
const ID=/^[a-f0-9-]{36}$/;
function file(id){if(!ID.test(id))throw Error('Invalid snapshot cache ID');return 'cloud/'+scope.current().id+'/manifests/'+id;}
function store(id,bytes){try{const name=file(id);storage.writeBytes(name,bytes);const dir=name.slice(0,name.lastIndexOf('/'));const entries=storage.listDir(dir).filter(n=>ID.test(n)).map(n=>{const name=dir+'/'+n,stat=fs.statSync(storage.location(name));return{name,size:stat.size,mtime:stat.mtimeMs};}).sort((a,b)=>b.mtime-a.mtime);let total=0;for(let i=0;i<entries.length;i++){total+=entries[i].size;if(i>=32||total>8*1048576)storage.deleteFile(entries[i].name);}}catch(_){/* reconstructible cache; never fail a remote commit */}}
module.exports={store,file};
