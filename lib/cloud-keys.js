const storage=require('./storage'),scope=require('./cloud-scope'),v2=require('./cloud-v2'),envelope=require('./envelope');
const unlocked=new Map(),legacyPending=new Map();
function memoryId(userId){return storage.root+':'+scope.scope(userId).id;}
function memory(userId){const id=memoryId(userId);if(!unlocked.has(id))unlocked.set(id,new Map());return unlocked.get(id);}
function lock(userId){const pending=legacyPending.get(memoryId(userId));if(pending)for(const key of pending.values())key.fill(0);legacyPending.delete(memoryId(userId));const keys=unlocked.get(memoryId(userId));if(keys)for(const key of keys.values())key.fill(0);unlocked.delete(memoryId(userId));}
scope.setClearHandler(id=>{for(const [name,keys]of legacyPending)if(name.endsWith(':'+id)){for(const key of keys.values())key.fill(0);legacyPending.delete(name);}for(const [name,keys]of unlocked)if(name.endsWith(':'+id)){for(const key of keys.values())key.fill(0);unlocked.delete(name);}});
function lockUser(userId){for(const [name,keys]of legacyPending)if(name.endsWith('/'+userId)){for(const key of keys.values())key.fill(0);legacyPending.delete(name);}for(const [name,keys]of unlocked)if(name.endsWith('/'+userId)){for(const key of keys.values())key.fill(0);unlocked.delete(name);}}
function get(userId,version){const key=memory(userId).get(version),trust=scope.load(userId);if(!key)return null;const row=trust&&trust.keyCommitments.find(row=>row.keyVersion===version);if(!row||!v2.equal(v2.commitment(key,userId,trust.libraryEpoch,version),row.commitment)){scope.clear(userId,'cloud_key_commitment_mismatch');throw v2.error('NEEDS_RECOVERY');}return new Uint8Array(key);}
function current(userId){const versions=Array.from(memory(userId).keys()).sort((a,b)=>b-a);for(const version of versions){const key=get(userId,version);if(key){key.fill(0);return version;}}return 0;}
function accept(userId,candidates){const trust=scope.load(userId);if(!trust)throw v2.error('cloud_bootstrap_required');if(!trust.keyCommitments.length)throw v2.error('cloud_key_migration_required');let verified;try{verified=v2.verifyKeys({userId,...trust,keys:candidates,existing:memory(userId)});}catch(error){if(error.code==='cloud_key_commitment_mismatch')scope.clear(userId,error.code);throw error;}
 for(const key of memory(userId).values())key.fill(0);unlocked.set(memoryId(userId),verified);if(verified.size){scope.recovered(userId);finalizeLegacy(userId);}return current(userId);
}
function legacy(userId){
 const id=memoryId(userId);if(!legacyPending.has(id))legacyPending.set(id,new Map());const pending=legacyPending.get(id);
 for(const name of storage.listDir(`keys/${userId}`)){const match=/^accountKey_v(\d+)\.bin$/.exec(name);if(match){const key=storage.readBytes(`keys/${userId}/${name}`);if(key&&key.length===32){const old=pending.get(Number(match[1]));if(old)old.fill(0);pending.set(Number(match[1]),key);}}}
 return new Map(Array.from(pending,([version,key])=>[version,new Uint8Array(key)]));
}
function sanitizeLegacyStorage(){
 const session=require('./account').getUsableSession();
 // R21: offline startup is not a migration. Leave every user's durable legacy
 // recovery material intact until its keys have been authenticated in v2.
 if(session){const copies=legacy(session.userId);for(const key of copies.values())key.fill(0);}
}
function resolve(userId,deviceId,boot,keypair){
 const observed=scope.observe(userId,boot);if(observed.changed||observed.requireApproval||observed.needsRecovery)throw v2.error('NEEDS_RECOVERY');
 if(!observed.keyCommitments.length)throw v2.error('NEEDS_RECOVERY');
 const candidates=legacy(userId),quarantine=[];
 // Validate cached keys on every bootstrap, even if their version is unchanged.
 if(memory(userId).size)accept(userId,new Map(memory(userId)));
 const stored=deviceEnvelopes(userId,deviceId,boot).sort((a,b)=>(a.envelope||a).keyVersion-(b.envelope||b).keyVersion);
 for(const row of stored){const env=row.envelope||row;let key;try{key=envelope.unwrapDeviceEnvelope(env,userId,deviceId,keypair.privateKey);const old=candidates.get(env.keyVersion);if(old)old.fill(0);candidates.set(env.keyVersion,key);}catch(_){quarantine.push({keyVersion:env.keyVersion,reason:'cloud_device_envelope_invalid'});}}
 try{
  for(const [version,key]of Array.from(candidates).sort((a,b)=>a[0]-b[0])){
    try{accept(userId,new Map([[version,key]]));}
    catch(error){if(error.code==='cloud_key_commitment_mismatch')throw v2.error('NEEDS_RECOVERY');quarantine.push({keyVersion:version,reason:error.code});}
  }
 }finally{for(const key of candidates.values())key.fill(0);}
 storage.writeJSON(scope.path('quarantine',userId),quarantine);
 const version=current(userId);if(!version)throw v2.error('NEEDS_RECOVERY');return{accountKey:get(userId,version),keyVersion:version,source:'verified',quarantined:quarantine};
}
function purgeLegacy(userId){const pending=legacyPending.get(memoryId(userId));if(pending)for(const key of pending.values())key.fill(0);legacyPending.delete(memoryId(userId));for(const name of storage.listDir(`keys/${userId}`))if(/^accountKey_v\d+\.bin$/.test(name)||name==='meta.json'||name==='recovery-words.json')storage.deleteFile(`keys/${userId}/${name}`);}
function finalizeLegacy(userId){
 const candidates=legacy(userId),trust=scope.load(userId);
 try{
  for(const [version,key]of candidates){const row=trust.keyCommitments.find(row=>row.keyVersion===version);if(!memory(userId).has(version)||!row||!v2.equal(v2.commitment(key,userId,trust.libraryEpoch,version),row.commitment))return;}
  if(candidates.size){
   // Preserve a durable encrypted recovery path before retiring the only local
   // plaintext copy, even if server self-envelope backfill has not run yet.
   cacheVerified(userId);
  }
  purgeLegacy(userId);
 }finally{for(const key of candidates.values())key.fill(0);}
}
function legacyCandidates(userId,deviceId,boot,keypair){
 const candidates=legacy(userId);
 for(const row of deviceEnvelopes(userId,deviceId,boot)){const env=row.envelope||row;let key;
  try{key=envelope.unwrapDeviceEnvelope(env,userId,deviceId,keypair.privateKey);const old=candidates.get(env.keyVersion);if(old){if(!old.every((byte,i)=>byte===key[i]))throw v2.error('cloud_key_migration_required');key.fill(0);}else candidates.set(env.keyVersion,key);}
  catch(error){if(key)key.fill(0);if(error.code==='cloud_key_migration_required'){for(const value of candidates.values())value.fill(0);throw error;}}
 }
 return candidates;
}
function deviceEnvelopes(userId,deviceId,boot){return[...(storage.readJSON(scope.keys(userId)+'/legacy-device-envelopes.json',[])||[]),...(boot.keyEnvelopes||[])].filter(row=>row.recipientType==='device'&&row.recipientDeviceId===deviceId&&!row.revokedAt&&!(row.envelope&&row.envelope.revokedAt));}
function cacheVerified(userId){
 const deviceId=require('./device').deviceId(),pair=require('./sync').getDeviceKeyPair(userId,deviceId);
 try{const rows=Array.from(memory(userId),([version,key])=>({recipientType:'device',recipientDeviceId:deviceId,envelope:envelope.createDeviceEnvelope({accountKey:key,userId,recipientDeviceId:deviceId,recipientPublicKeyUncompressed:pair.publicKeyUncompressed,keyVersion:version})}));storage.writeJSON(scope.keys(userId)+'/legacy-device-envelopes.json',rows);}
 finally{pair.privateKey.fill(0);}
}
function versions(userId){return Array.from(memory(userId).keys()).sort((a,b)=>a-b);}
module.exports={get,current,accept,resolve,versions,lock,lockUser,legacy,legacyCandidates,cacheVerified,sanitizeLegacyStorage};
