const storage=require('./storage'),PATH='state/local-payload-outbox.json';
function path(value){const normalized=require('./storage-protection').normalize(value);if(!normalized)throw Object.assign(Error('暂存资料路径无效'),{code:'invalid_storage_path'});return normalized;}
function load(){const rows=storage.readJSON(PATH,{})||{};if(typeof rows!=='object'||Array.isArray(rows))throw Object.assign(Error('待上传资料清单无效，原数据已保留'),{code:'local_storage_read_failed'});return rows;}
function add(payloadPath,kind){payloadPath=path(payloadPath);const rows=load();if(Object.hasOwn(rows,payloadPath))return;storage.writeJSON(PATH,{...rows,[payloadPath]:{payloadPath,kind}});require('./storage-budget').invalidateProtection(PATH);}
function ack(paths){const rows=load();let changed=false;for(const value of paths){const key=path(value);if(Object.hasOwn(rows,key)){delete rows[key];changed=true;}}if(changed){storage.writeJSON(PATH,rows);require('./storage-budget').invalidateProtection(PATH);}}
module.exports={add,ack};
