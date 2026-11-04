// Explicit CLI commands own their lifetime; no UI navigation or poll scheduler.
module.exports={whenIdle:()=>Promise.resolve(),queueSync(){},foreground:async(_page,_key,work)=>work()};
