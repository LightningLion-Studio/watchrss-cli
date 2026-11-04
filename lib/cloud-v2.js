// Byte-level cloud v2 contract. This module has no storage or network effects.
const crypto=require('./crypto'),util=require('./util');
function error(code){return Object.assign(new Error(code),{code});}
function lp(...fields){return util.bytesConcat(fields.map(field=>{const bytes=field instanceof Uint8Array?field:util.utf8ToBytes(String(field)),len=new Uint8Array(4);new DataView(len.buffer).setUint32(0,bytes.length,false);return util.bytesConcat([len,bytes]);}));}
function digest(bytes){return util.hexDecode(crypto.sha256Hex(bytes));}
function mac(key,...fields){if(!key||key.length!==32)throw error('NEEDS_RECOVERY');return util.hexEncode(crypto.hmacSha256(key,lp(...fields)));}
function commitment(key,userId,epoch,version){return mac(key,'watchrss/key-commit/v2',userId,epoch,version);}
function rotationProof(previous,userId,epoch,version,commit){return mac(previous,'watchrss/key-rotate/v2',userId,epoch,version,commit);}
function attest(key,userId,epoch,deviceId,spki){crypto.publicKeyUncompressedFromSpki(spki);return mac(key,'watchrss/device-attest/v2',userId,epoch,deviceId,digest(spki));}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let result=0;for(let i=0;i<a.length;i++)result|=a.charCodeAt(i)^b.charCodeAt(i);return result===0;}
function base64(value,length){if(typeof value!=='string'||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw error('cloud_v2_invalid');const bytes=util.base64PaddedDecode(value);if((length!==undefined&&bytes.length!==length)||util.base64PaddedEncode(bytes)!==value)throw error('cloud_v2_invalid');return bytes;}
function spki(value){if(typeof value!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw error('cloud_v2_invalid');const bytes=util.base64PaddedDecode(value);if(bytes.length!==91||util.base64PaddedEncode(bytes).replace(/=+$/,'')!==value.replace(/=+$/,''))throw error('cloud_v2_invalid');crypto.publicKeyUncompressedFromSpki(bytes);return bytes;}
function commitments(rows,floor=0){if(!Array.isArray(rows)||!Number.isInteger(floor)||floor<0)throw error('cloud_v2_invalid');const sorted=rows.slice().sort((a,b)=>a.keyVersion-b.keyVersion);for(let i=0;i<sorted.length;i++){const row=sorted[i];if(!Number.isInteger(row.keyVersion)||row.keyVersion<=floor||row.keyVersion>2147483647||!/^[a-f0-9]{64}$/.test(row.commitment)|| (i===0?row.rotationProof!==null:row.keyVersion!==sorted[i-1].keyVersion+1||!/^[a-f0-9]{64}$/.test(row.rotationProof)))throw error('cloud_v2_invalid');}return sorted;}
// All-or-nothing acceptance; callers persist only after this returns.
function verifyKeys({userId,libraryEpoch,keyVersionFloor=0,keyCommitments,keys,existing=new Map()}){
 const rows=commitments(keyCommitments,keyVersionFloor),verified=new Map(),created=[];
 try{
  for(const version of new Set([...keys.keys(),...existing.keys()]))if(!rows.some(row=>row.keyVersion===version))throw error('cloud_key_commitment_mismatch');
  for(const row of rows){const key=keys.get(row.keyVersion)||existing.get(row.keyVersion);if(!key)continue;
   if(!equal(commitment(key,userId,libraryEpoch,row.keyVersion),row.commitment))throw error('cloud_key_commitment_mismatch');
   if(row!==rows[0]){const previous=verified.get(row.keyVersion-1);if(!previous||!equal(rotationProof(previous,userId,libraryEpoch,row.keyVersion,row.commitment),row.rotationProof))throw error('cloud_key_chain_invalid');}
   const copy=new Uint8Array(key);created.push(copy);verified.set(row.keyVersion,copy);
  }
  return verified;
 }catch(failure){for(const key of created)key.fill(0);throw failure;}
}
function approvalCommit(spki,nonce){if(nonce.length!==32)throw error('cloud_v2_invalid');crypto.publicKeyUncompressedFromSpki(spki);return crypto.sha256Hex(lp('watchrss/approval-commit/v2',spki,nonce));}
function transcript({userId,libraryEpoch,requestId,deviceId,publicKeySpki,approverDeviceId,approverSpki,requesterNonce,approverNonce}){return lp('watchrss/approval/v2',userId,libraryEpoch,requestId,deviceId,spki(publicKeySpki),approverDeviceId,spki(approverSpki),base64(requesterNonce,32),base64(approverNonce,32));}
function shortCode(bytes){if(bytes.length<8)throw error('cloud_v2_invalid');let mod=0;for(const byte of bytes.slice(0,8))mod=(mod*256+byte)%100000000;return String(mod).padStart(8,'0');}
function code(bytes){return shortCode(digest(bytes));}
function pairingSas(secret,sessionId,userId){return shortCode(crypto.hmacSha256(secret,lp('watchrss/pairing-sas/v2',sessionId,userId)));}
function deliverBytes(bytes,payload){return lp('watchrss/approval-deliver/v2',digest(bytes),util.utf8ToBytes(payload));}
function sign(bytes,payload,privateKey){return crypto.signP256CompactBase64(deliverBytes(bytes,payload),privateKey);}
function verify(bytes,payload,signature,publicSpki){try{return crypto.verifyP256Compact(deliverBytes(bytes,payload),base64(signature,64),spki(publicSpki));}catch(_){return false;}}
module.exports={lp,digest,commitment,rotationProof,attest,equal,base64,spki,commitments,verifyKeys,approvalCommit,transcript,code,pairingSas,sign,verify,error};
