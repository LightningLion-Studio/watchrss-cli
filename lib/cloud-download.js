// Shared network admission: bounded workers and ciphertext bytes, no plaintext.
// Jobs carry their own owner/epoch/cancellation fence, including queued jobs.
const MAX_BYTES=8*1024*1024,MAX_CHUNK=17*1024*1024;
let active=0,bytes=0,limit=4,networkCap=6,good=0;const queue=[];
function cancelled(){return Object.assign(Error('同步已取消'),{code:'cloud_operation_cancelled'});}
function network(type){networkCap=['2g','3g'].includes(type)?2:type==='none'?1:6;limit=Math.min(networkCap,type==='wifi'?6:4);pump();}
function pump(){
 while(queue.length&&active<limit){const item=queue[0];if(active&&bytes+item.size>MAX_BYTES)break;queue.shift();
  try{item.check();}catch(error){item.reject(error);continue;}
  active++;bytes+=item.size;const started=Date.now();
  (async()=>{try{const result=await item.work();item.check();if(Date.now()-started<1000&&++good>=12){limit=Math.min(networkCap,limit+1);good=0;}item.resolve(result);}catch(error){good=0;if(['timeout','network_error'].includes(error.code))limit=Math.max(1,Math.floor(limit/2));item.reject(error);}finally{active--;bytes-=item.size;pump();}})();
 }
}
function run(size,work,check=()=>{}){if(!Number.isSafeInteger(size)||size<0||size>MAX_CHUNK)return Promise.reject(Error('云端分块超过内存上限'));return new Promise((resolve,reject)=>{queue.push({size,work,check,resolve,reject});pump();});}
function session({check=()=>{}}={}){let closed=false;const tasks=new Set(),checked=()=>{check();if(closed)throw cancelled();};return{check:checked,run:(size,work)=>run(size,()=>work(task=>{if(closed)task?.abort?.();else tasks.add(task);}),checked),close(){closed=true;for(const task of tasks)task?.abort?.();tasks.clear();pump();},release:task=>tasks.delete(task)};}
// Node ports have no wx; their transport still shares these limits.
module.exports={run,session,network,MAX_BYTES,stats:()=>({active,bytes,queued:queue.length,limit})};
