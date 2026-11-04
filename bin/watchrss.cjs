#!/usr/bin/env node
'use strict';
const {parseArgs}=require('node:util');
const fs=require('node:fs');
const path=require('node:path');
const storage=require('../lib/storage');
const HELP=`watchrss --login                      交互登录（短信 / 密码 / TOTP）
watchrss config --url URL --anon-key KEY 配置后端公开 anon key
watchrss mode [hybrid|cloud]            默认 hybrid；模式分目录保存
watchrss status                        登录、会员、模式与手机号变更提示
watchrss account-safety                查看换绑冷却提示（不要求会员）
watchrss phone-change-cancel APPEAL_ID  取消本人待处理人工换绑
watchrss sync                          拉取并提交待同步修改
watchrss sources list|add URL|remove URL|pin URL [true|false]|refresh [URL]
watchrss articles list [--query TEXT] [--source URL] [--favorite] [--limit N]
watchrss articles get ID [--page N]     按需读取正文页
watchrss articles favorite|later|read ID [true|false]
watchrss articles progress ID NUMBER   阅读进度 0..1
watchrss articles remove ID            软删除
watchrss books list|remove URL          书籍目录 / 软删除
watchrss import FILE.txt|FILE.epub      加密上传、分章导入
watchrss export FILE.json              导出本地投影（hybrid 可含缓存正文）
watchrss format-capabilities           查询服务端格式能力（本机写入默认关闭）
watchrss format-write enable|disable    本机显式 opt-in；每轮仍需服务端允许
watchrss uploads status                可恢复加密上传计划（WATCHRSS_PROGRESS=1 输出进度到 stderr）
watchrss snapshots list                快照历史
watchrss devices list                 云同步设备
watchrss records-enable               明确同意启用逐条加密记录格式
watchrss keys recover|init             交互恢复 / 首次建立云密钥
watchrss logout                       撤销当前登录；本地资料保留
全局：--json（默认，适合 agent） --mode hybrid|cloud --defer（混合模式延后提交） --offline（混合模式离线，需有效本地会员凭据）
环境：WATCHRSS_HOME、WATCHRSS_URL、WATCHRSS_ANON_KEY。凭证不会写入 stdout。`;
function fail(message,code='invalid_argument'){throw Object.assign(new Error(message),{code});}
function boolean(value){if(value===undefined||value==='true')return true;if(value==='false')return false;fail('布尔值必须是 true 或 false');}
function required(value){if(!value)fail('缺少参数；请运行 watchrss --help');return value;}
function integer(value,min,max){const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)fail(`整数必须在 ${min}..${max} 之间`);return n;}
function summary(a){const {contentText,contentHtml,...rest}=a;return rest;}
async function flush(options){return require('../lib/cloud-command').flush(options);}
async function main(){
 const {values:v,positionals:p}=parseArgs({allowPositionals:true,options:{login:{type:'boolean'},help:{type:'boolean',short:'h'},json:{type:'boolean'},mode:{type:'string'},defer:{type:'boolean'},offline:{type:'boolean'},url:{type:'string'},'anon-key':{type:'string'},query:{type:'string'},source:{type:'string'},favorite:{type:'boolean'},limit:{type:'string'},page:{type:'string'}}});
 if(v.help || (!p.length&&!v.login)){process.stdout.write(HELP+'\n');return;}
 const unlock=storage.acquireLock();
 try{
  let config=storage.readJSON('config.json',{});
  const mode=v.mode || config.mode || 'hybrid';if(!['hybrid','cloud'].includes(mode))fail('模式必须是 hybrid 或 cloud');
  if(v.defer && mode!=='hybrid')fail('--defer 仅适用于混合模式');
  const [command,action,id,arg]=p;
  if(v.offline){
   if(mode!=='hybrid')fail('--offline 仅适用于混合模式');
   const read=command==='format-write'||command==='status'||command==='export'||(command==='articles'&&['list','get'].includes(action))||(command==='sources'&&action==='list')||(command==='books'&&action==='list');
   const write=(command==='articles'&&['favorite','later','read','progress','remove'].includes(action))||(command==='sources'&&['remove','pin'].includes(action))||(command==='books'&&action==='remove');
   if(!read&&!write)fail('此命令需要联网');
   if(write)v.defer=true;
  }
  if(v.defer && !((command==='articles'&&['favorite','later','read','progress','remove'].includes(action)) || (command==='sources'&&['remove','pin'].includes(action)) || (command==='books'&&action==='remove')))fail('--defer 仅适用于已有条目的本地状态修改');
  if(command==='config'){
   if(v.url){const u=new URL(v.url);if(u.username||u.password)fail('URL 凭据不受支持');if(u.protocol!=='https:' && !(u.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname)))fail('后端必须使用 HTTPS');config.backendBaseUrl=v.url;}
   if(v['anon-key'])config.supabaseAnonKey=v['anon-key'];storage.writeJSON('config.json',config);return {configured:true,backendBaseUrl:config.backendBaseUrl};
  }
  // Modes have independent projections/cursors, preventing cloud mode from reading hybrid bodies.
  storage.setMode(mode);
  storage.setNamespace(mode);
  if(command==='mode'){
   if(action){if(!['hybrid','cloud'].includes(action))fail('模式必须是 hybrid 或 cloud');config.mode=action;storage.writeJSON('config.json',config);}
   return {mode:action||mode};
  }
  const account=require('../lib/account'),http=require('../lib/http'),login=require('../lib/login');
  if(v.login)return await login.login(login.prompt);
  if(command==='logout'){
   const session=account.getUsableSession();
   if(session){
    const scope=require('../lib/cloud-scope'),identity=storage.readJSON('identity.json',null),extraHeaders=scope.load(session.userId)?scope.headers(session.userId):{};
    if(identity?.deviceId&&extraHeaders['x-watchrss-library-epoch'])await require('../lib/appaccess').request({method:'POST',path:`/functions/v1/cloud/devices/${encodeURIComponent(identity.deviceId)}/revoke`,body:{},extraHeaders});
    await http.request({method:'POST',path:'/functions/v1/account/logout',body:{},bearer:session.accessToken,extraHeaders});
   }
   storage.deleteFile('session.json');storage.deleteFile('cli-access.json');storage.deleteFile('membership-cache.json');return {loggedOut:true};
  }
  if(command==='format-write'){if(!['enable','disable'].includes(action))fail('format-write 仅支持 enable 或 disable');const overlay=require('../lib/cloud-overlay');overlay.setEnabled(action==='enable');return {localWriteOptIn:overlay.localEnabled(),cloudFormatMigrationR48V1:false};}
  if(command==='account-safety'){const s=await account.refreshProfile();return{userId:s.userId,phoneMasked:s.phoneMasked,pendingPhoneChange:s.pendingPhoneChange};}
  if(command==='phone-change-cancel')return await account.cancelPhoneAppeal(action||'');
  const member=await account.requireMember(false,{offline:v.offline,preferCached:!!v.defer});
  if(command==='status'){const session=v.offline?account.getUsableSession():await account.refreshProfile();return {mode,offline:!!v.offline,userId:session.userId,phoneMasked:session.phoneMasked,pendingPhoneChange:session.pendingPhoneChange??null,member};}
  const sync=require('../lib/sync'),library=require('../lib/library'),cloud=require('../lib/cloud-library'),device=require('../lib/device'),records=require('../lib/cloud-records');
  await require('../lib/crypto').initializeRandom();
  const userId=account.getUsableSession().userId;
  if(command==='keys'){
   const boot=await sync.bootstrap({allowRevoked:action==='recover'});
   if(action==='recover'){
    const words=(await login.prompt('24 个恢复词（空格分隔）: ',true)).trim().split(/\s+/);
    const info=await sync.recoverWithWords(userId,words,boot);try{await sync.registerDevice(device.deviceId(),'WatchRSS CLI');await sync.ensureOwnDeviceEnvelope(userId,device.deviceId(),info.accountKey,info.keyVersion,boot.keyEnvelopes);return {recovered:true,keyVersion:info.keyVersion};}finally{info.accountKey.fill(0);words.fill('');}
   }
   if(action==='init')throw Object.assign(Error('请先使用已授权手机或小程序建立云密钥，再在 CLI 执行 keys recover'),{code:'key_migration_phone_required'});
   fail('keys 仅支持 recover 或 init');
  }
  if(command==='devices'&&action==='list')return (await sync.bootstrap()).devices;
  if(command==='uploads'&&action==='status')return require('../lib/upload-plan').status();
  if(command==='snapshots'&&action==='list')return await sync.snapshotHistory();
  if(command==='records-enable'){await account.requireMember(true);return await records.consent(account.getUsableSession());}
  // Only explicit commands reach synchronization, so typos cannot trigger cloud writes.
  const valid=command==='format-write'||command==='format-capabilities'||command==='sync'||command==='export'||command==='import'||(command==='sources'&&['list','add','remove','pin','refresh'].includes(action))||(command==='articles'&&['list','get','favorite','later','read','progress','remove'].includes(action))||(command==='books'&&['list','remove'].includes(action));
  if(!valid)fail('未知命令；请运行 watchrss --help');
  if(command==='sync'){
   const result=await flush(cloud),prefetch=require('../lib/cloud-books');
   const jobs=await (prefetch.finishCommand?prefetch.finishCommand():prefetch.waitForPrefetch?.())||[];
   const failed=jobs.find(job=>job.status==='stopped'&&!['cloud_operation_cancelled','cloud_book_deleted'].includes(job.error));
   if(failed)throw Object.assign(Error('书包后台校验尚未完成，本机修改已保留'),{code:failed.error||'cloud_book_body_missing'});
   return result;
  }
  if(command==='format-capabilities')return await sync.formatCapabilities();
  const mutating=command==='import'||(command==='sources'&&action!=='list')||(command==='articles'&&!['list','get'].includes(action))||(command==='books'&&action==='remove');
  // requireMember above already checks active/readable/writable. The shared
  // driver pulls and replays durable intents itself; an existing local state
  // mutation needs one post-edit sync, not a full sync on both sides of it.
  const localMutation=mutating&&((command==='articles'&&!!library.getArticleView(id))||
   (command==='sources'&&['remove','pin'].includes(action)&&!!library.getSource(id))||
   (command==='books'&&action==='remove'&&!!library.getSource(id)));
  if(!v.defer&&!v.offline&&!localMutation){const result=await flush({allowWritePaused:!mutating});if(result.writePaused)process.stderr.write(JSON.stringify({event:'cloud-write-paused',pending:true,code:result.privateError||result.snapshotError||result.recordError||result.code})+'\n');}
  let result;
  if(command==='sources'){
   if(action==='list')return library.listSources();
   const rss=require('../lib/rss');
   if(action==='add')result=await rss.refreshSource(required(id),{keepBody:mode==='hybrid'});
   else if(action==='refresh'){
    const sources=id?[{url:id}]:library.listSources();result=[];
    for(const source of sources)result.push(await rss.refreshSource(source.url,{keepBody:mode==='hybrid'}));
   }else{
    required(id);if(!library.getSource(id))fail('订阅源不存在','not_found');
    const intent=action==='remove'?{type:'delete-source',id}:{type:'pin',id,value:boolean(arg)};
    cloud.note(intent);result=action==='remove'?library.softDeleteSource(id):library.pinSource(id,intent.value);
   }
  }else if(command==='articles'){
   if(action==='list'){
    let list=library.listArticleViews();
    if(v.query)list=list.filter(a=>(a.title+' '+(a.excerpt||'')).toLowerCase().includes(v.query.toLowerCase()));
    if(v.source)list=list.filter(a=>a.rssSourceUrl===v.source);if(v.favorite)list=list.filter(a=>a.favoriteSaved);
    const limit=integer(v.limit||'100',1,10000);return {items:list.slice(0,limit).map(summary),total:list.length};
   }
   const article=library.getArticleView(required(id));if(!article || article.deleted)fail('文章不存在','not_found');
   if(action==='get'){
    const page=integer(v.page||'0',0,1000000);
    if(v.offline&&!library.hasBody(library.getArticle(id)||article)&&!require('../lib/books').member(article))fail('正文尚未缓存，请联网读取','body_not_cached');
    const reader=await require('../lib/online-reader').open(library.getArticle(id)||article,{localOnly:!!v.offline});
    try{if(reader.preparePage)await reader.preparePage(page);if(page>=reader.totalPages)fail('页码超出范围');const text=await reader.read(page),hasMore=reader.hasMore?reader.hasMore(page):page+1<reader.totalPages;return {article:summary(article),page,knownPages:reader.knownPages??reader.totalPages,totalPages:reader.totalPagesKnown===false?null:reader.totalPages,hasMore,eof:!hasMore,text};}finally{reader.close();}
   }
   if(action==='progress'){
    const progress=Number(required(arg));if(!Number.isFinite(progress)||progress<0||progress>1)fail('阅读进度必须在 0..1 之间');
    cloud.note({type:'progress',id,progress,positionBytes:0});result=library.updateReadingPosition(id,progress,0);
   }else{
    const intent=action==='remove'?{type:'delete-article',id}:{type:'article',id,kind:{favorite:'favorite',later:'watchLater',read:'read'}[action],value:boolean(arg)};
    cloud.note(intent);result=action==='remove'?library.softDeleteArticle(id):library.toggleSavedState(id,intent.kind,intent.value);
   }
  }else if(command==='books'){
   const books=library.listSources().filter(s=>/watchrss\.local\/import-|watchrss:\/\//.test(s.url));
   if(action==='list')return books;
   if(!books.some(s=>s.url===required(id)))fail('书籍不存在','not_found');cloud.note({type:'delete-book',id});result=library.softDeleteBook(id);
  }else if(command==='import'){
   const file=path.resolve(required(action)),imports=require('../lib/file-import');
   result=await imports.uploadFile(path.basename(file),file);
  }else if(command==='export'){
   const file=required(action);fs.writeFileSync(file,JSON.stringify(library.exportLibrary(),null,2)+'\n',{mode:0o600,flag:'wx'});return {exported:true,file:path.resolve(file)};
  }
  if(!v.defer&&!v.offline)await flush(cloud);
  return {mode,pending:!!v.defer,result};
 }finally{try{require('../lib/cloud-library').stop?.();await require('../lib/cloud-books').finishCommand?.({cancel:true});}finally{unlock();}}
}
main().then(result=>{if(result!==undefined)process.stdout.write(JSON.stringify({ok:true,data:result})+'\n');}).catch(error=>{
 process.stdout.write(JSON.stringify({ok:false,error:{code:error.code||'cli_error',message:error.message,status:error.status||undefined}})+'\n');process.exitCode=1;
});
