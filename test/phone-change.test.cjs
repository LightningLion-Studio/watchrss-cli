const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
 let session={userId:'u',accessToken:'token',refreshToken:'refresh',expiresAt:999999,phoneMasked:'old'},handler;
 const files=new Map(),deleted=[],calls=[];
 const storage={readJSON:name=>name==='session.json'?session:files.get(name),writeJSON:(name,value)=>{if(name==='session.json')session=value;else files.set(name,value);},deleteFile:name=>{deleted.push(name);if(name==='session.json')session=null;else files.delete(name);}};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/account.js'),'utf8'),{module,require:id=>{
  if(id==='./storage')return storage;if(id==='./clock')return{now:()=>100};if(id==='../config')return{backendBaseUrl:'https://test.invalid'};
  if(id==='./http')return{request:async q=>{calls.push(q);return {data:await handler(q)};}};return require(id);
 },Date});
 return {api:module.exports,deleted,calls,get session(){return session;},setSession:s=>session=s,setHandler:f=>handler=f};
}
test('profile refresh preserves user, credentials, expiry and unrelated local data',async()=>{
 const f=fixture();const original={...f.session};f.setHandler(async()=>({userId:'u',phoneMasked:'139****0000'}));
 const result=await f.api.refreshProfile();assert.equal(result.phoneMasked,'139****0000');
 for(const key of ['userId','accessToken','refreshToken','expiresAt'])assert.equal(result[key],original[key]);
 assert.deepEqual(f.deleted,[]);assert.equal(f.calls[0].path,'/functions/v1/account/profile');
});
test('late profile and invalid profile cannot overwrite a switched account',async()=>{
 const f=fixture();f.setHandler(async()=>{f.setSession({userId:'other',accessToken:'other',expiresAt:999999});return{userId:'u',phoneMasked:'139****0000'};});
 await assert.rejects(f.api.refreshProfile(),e=>e.code==='account_changed');assert.equal(f.session.userId,'other');
 const g=fixture();g.setHandler(async()=>({userId:'other',phoneMasked:'139****0000'}));
 await assert.rejects(g.api.refreshProfile(),e=>e.code==='invalid_account_profile');assert.equal(g.session.phoneMasked,'old');
});
test('only rejected current account credentials invalidate login, preserving all reading/cloud files',async()=>{
 for(const error of [{status:401,code:'invalid_session'},{status:401,code:'invalid_signature'},{status:503,code:'unavailable'}]){
  const f=fixture();f.setHandler(async()=>{throw error;});await assert.rejects(f.api.refreshProfile());
  if(error.code==='invalid_session'){assert.equal(f.session,null);assert.deepEqual(f.deleted,['session.json','cli-access.json','membership-cache.json']);}
  else {assert.ok(f.session);assert.deepEqual(f.deleted,[]);}
 }
});
test('CLI account-safety notice and cancellation preserve credentials and clear the pending metadata',async()=>{
 const f=fixture();let pending={appealId:'appeal',status:'cooling',effectiveAt:1893456000000,phoneMasked:'139****0000',cancellable:true};
 f.setHandler(async q=>{if(q.method==='POST'){pending=null;return{status:'cancelled'};}return{userId:'u',phoneMasked:'138****0000',pendingPhoneChange:pending};});
 await f.api.refreshProfile();assert.match(f.session.pendingPhoneChange.message,/2030年1月1日/);
 await f.api.cancelPhoneAppeal('appeal');assert.equal(f.session.pendingPhoneChange,null);assert.equal(f.session.accessToken,'token');assert.deepEqual(f.deleted,[]);
 assert.equal(f.calls[1].path,'/functions/v1/account/phone/appeals/appeal/cancel');
});
