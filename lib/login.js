'use strict';
const http=require('./http'),account=require('./account'),device=require('./device'),crypto=require('./crypto');
function normalizePhone(raw){const value=raw.trim().replace(/[\s-]/g,'').replace(/^\+?86/,'');if(!/^(1[3-9]\d{9}|200\d{8})$/.test(value))throw new Error('请输入中国大陆手机号');return '+86'+value;}
async function login(ask){
 await crypto.initializeRandom();
 const phone=normalizePhone(await ask('手机号: '));
 let state=(await http.request({method:'POST',path:'/functions/v1/account/login/start',body:{phone,licenseDeviceId:device.deviceId(),devicePublicKey:device.publicKeyPem()}})).data;
 if(!state.transactionId)throw new Error('登录响应缺少事务');
 for(let steps=0;!state.complete && steps<8;steps++){
  const factor=(await ask(`验证方式 sms / password / totp（已完成 ${(state.completedFactors||[]).join(',')||'无'}）: `)).trim().toLowerCase();
  let path,extra;
  if(factor==='sms'){
   await http.request({method:'POST',path:'/functions/v1/account/login/mfa/sms/request',body:{transactionId:state.transactionId}});
   path='sms/verify';extra={code:await ask('短信验证码: ',true)};
  }else if(factor==='totp'){path='totp/verify';extra={code:await ask('TOTP 验证码: ',true)};}
  else if(factor==='password'){path='password';extra={password:await ask('密码: ',true)};}
  else throw Object.assign(new Error('请选择 sms、password 或 totp'),{code:'invalid_factor'});
  const next=(await http.request({method:'POST',path:'/functions/v1/account/login/mfa/'+path,body:{transactionId:state.transactionId,...extra}})).data;
  state={...state,...next};
 }
 if(!state.complete || !state.session)throw new Error('多因素登录尚未完成');
 const session=account.saveSession(state.session);
 await account.requireMember();
 await require('./appaccess').ensureDeviceAccess();
 return {userId:session.userId,phoneMasked:session.phoneMasked,loggedIn:true};
}
// Read terminal input ourselves so password, OTP and recovery words never echo.
function prompt(question,secret=false){
 if(!process.stdin.isTTY || !process.stderr.isTTY)throw Object.assign(new Error('交互登录需要终端 TTY'),{code:'tty_required'});
 process.stderr.write(question);
 return new Promise((resolve,reject)=>{
  let input='';const stdin=process.stdin;stdin.setRawMode(true);stdin.resume();stdin.setEncoding('utf8');
  const finish=(error)=>{stdin.off('data',read);stdin.setRawMode(false);stdin.pause();process.stderr.write('\n');error?reject(error):resolve(input);};
  function read(chunk){for(const ch of chunk){if(ch==='\u0003'||ch==='\u0004'){finish(Object.assign(new Error('已取消'),{code:'cancelled'}));return;}if(ch==='\r'||ch==='\n'){finish();return;}if(ch==='\u007f'||ch==='\b'){if(input){input=input.slice(0,-1);if(!secret)process.stderr.write('\b \b');}}else if(ch>=' '){input+=ch;if(!secret)process.stderr.write(ch);}}}
  stdin.on('data',read);
 });
}
module.exports={login,prompt,normalizePhone};
