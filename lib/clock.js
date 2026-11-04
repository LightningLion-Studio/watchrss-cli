'use strict';
// Credential TTLs must not jump when wall time changes during a command. A
// successful HTTPS backend response can anchor this process to its Date header.
const mono=()=>performance.now();let epoch=Date.now(),origin=mono();
function now(){return epoch+(mono()-origin);}
function observe(value){const parsed=Date.parse(value||'');if(Number.isFinite(parsed)){epoch=parsed;origin=mono();}}
module.exports={now,observe};
