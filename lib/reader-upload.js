// Bounded parallel PUTs; keep every task inside the cloud writer lock on failure.
const http=require('./http');
const sync=require('./sync');
async function uploadObjects(targets,bytesFor,{assertActive=()=>{},onProgress=()=>{},concurrency=3}={}){
 let next=0,done=0,uploaded=0,failure=null;
 const totalBytes=targets.reduce((sum,t)=>sum+t.sizeBytes,0);
 onProgress({done,total:targets.length,uploaded,totalBytes});
 async function worker(){
  while(!failure && next<targets.length){
   const target=targets[next++];
   try{
    assertActive();const bytes=await bytesFor(target);assertActive();
    if(!bytes || bytes.length!==target.sizeBytes)throw new Error('分段正文云对象缺失');
    // Refresh each reservation immediately before its authenticated PUT.
    const url=await sync.freshUploadUrl(target);assertActive();
    try{await http.putObject(url,bytes,{timeout:120000});}
    catch(error){
     if(error.status!==401)throw error;
     assertActive();await http.putObject(await sync.freshUploadUrl(target),bytes,{timeout:120000});
    }
    assertActive();done++;uploaded+=bytes.length;onProgress({done,total:targets.length,uploaded,totalBytes});
   }catch(error){if(!failure)failure=error;}
  }
 }
 await Promise.all(Array.from({length:Math.min(Math.max(1,concurrency),3,targets.length)},worker));
 if(failure)throw failure;
}
function progressText(p){
 const mb=n=>(n/(1024*1024)).toFixed(2);
 const percent=p.totalBytes?Math.floor(p.uploaded*100/p.totalBytes):100;
 return `已上传 ${mb(p.uploaded)} / ${mb(p.totalBytes)} MB（${percent}%），已完成 ${p.done}/${p.total} 个分块`;
}
module.exports={uploadObjects,progressText};
