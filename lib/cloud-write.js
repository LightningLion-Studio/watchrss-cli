// Matches the backend cloud_v2 epoch fence. chunks/missing also enters write_tx.
function epochWrite({method='GET',path='',useBaseUrl=true}){return useBaseUrl&&!['GET','HEAD','OPTIONS'].includes(method.toUpperCase())&&/^\/functions\/v1\/cloud\//.test(path)&&path.split('?')[0]!=='/functions/v1/cloud/bootstrap';}
function assertEpoch(options,headers){if(!epochWrite(options))return;const value=Object.entries(headers).find(([key])=>key.toLowerCase()==='x-watchrss-library-epoch')?.[1];if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw Object.assign(Error('云写入缺少有效资料库标识，请先同步读取资料库'),{code:'cloud_bootstrap_required'});}
module.exports={epochWrite,assertEpoch};
