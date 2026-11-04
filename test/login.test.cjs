const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
process.env.WATCHRSS_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'watchrss-login-'));
process.env.WATCHRSS_URL='http://127.0.0.1:19876';
const {login,normalizePhone}=require('../lib/login'),storage=require('../lib/storage');
test('interactive login waits for both required factors and retains only final session',async()=>{
 const original=global.fetch,calls=[],answers=['13812345678','sms','123456','totp','654321'];let completed=false;
 global.fetch=async(url,opts)=>{
  const p=new URL(url).pathname,body=opts.body?JSON.parse(opts.body):{};calls.push(p);
  if(p.endsWith('/login/start'))return Response.json({transactionId:'transaction',requiredFactorCount:2,completedFactors:[],complete:false});
  if(p.endsWith('/sms/request'))return Response.json({});
  if(p.endsWith('/sms/verify')){assert.equal(body.code,'123456');assert.equal(storage.readJSON('session.json'),null);return Response.json({completedFactors:['sms'],requiredFactorCount:2,complete:false});}
  if(p.endsWith('/totp/verify')){assert.equal(body.code,'654321');completed=true;return Response.json({completedFactors:['sms','totp'],complete:true,session:{userId:'test-user',accessToken:'wrp_login-test',expiresIn:3600}});}
  if(p.endsWith('/entitlement')){assert(completed);return Response.json({active:true,writable:true,readable:true});}
  if(p.endsWith('/challenge'))return Response.json({challengeId:'challenge',nonce:'nonce'});
  if(p.endsWith('/cli/access')){assert(completed);return Response.json({cliAccessToken:'wrc_login',expiresAt:Date.now()+3600000});}
  throw new Error('unexpected path '+p);
 };
 try{const result=await login(async()=>answers.shift());assert.equal(result.loggedIn,true);assert.equal(result.accessToken,undefined);assert.equal(answers.length,0);assert.equal(calls.filter(p=>p.endsWith('/totp/verify')).length,1);}
 finally{global.fetch=original;fs.rmSync(storage.root,{recursive:true,force:true});}
});
test('phone normalization matches ordinary and reserved test ranges',()=>{assert.equal(normalizePhone('138 1234 5678'),'+8613812345678');assert.equal(normalizePhone('+86 20000000001'),'+8620000000001');assert.throws(()=>normalizePhone('123'));});
test('explicit server account rejection invalidates offline membership cache',async()=>{
 const account=require('../lib/account'),original=global.fetch;
 account.saveSession({userId:'cache-user',accessToken:'wrp_cache-test',expiresAt:Date.now()+3600000});
 try{
  global.fetch=async()=>Response.json({active:true,readable:true,writable:true,expiresAt:new Date(Date.now()+60000).toISOString()});
  await account.requireMember();const cached=storage.readJSON('membership-cache.json');assert(cached.validUntil<=Date.now()+60000);
  global.fetch=async()=>Response.json({error:'account_login_blocked'},{status:403});
  await assert.rejects(account.requireMember(),e=>e.code==='account_login_blocked');
  await assert.rejects(account.requireMember(false,{offline:true}),e=>e.code==='membership_check_required');
 }finally{global.fetch=original;fs.rmSync(storage.root,{recursive:true,force:true});}
});
