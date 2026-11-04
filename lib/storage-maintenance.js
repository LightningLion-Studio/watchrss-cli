// The mini automatic startup/KV migration does not run in the CLI.
function start(){}
async function migrateFallbacks(){return{supported:false,moved:0,retained:0,reason:'wechat-kv-not-supported'};}
async function manage(){const budget=require('./storage-budget');budget.refresh();const result=budget.trim();await require('./storage-audit').getStorageDiagnostics();return result;}
module.exports={start,migrateFallbacks,manage};
