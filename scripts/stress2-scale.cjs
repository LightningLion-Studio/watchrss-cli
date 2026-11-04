'use strict';
// Offline complexity probe; no network or credentials. Uses the production codec
// and paged projection against synthetic article state, on the same Node22 host.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
if(!process.env.TEST_SCALE_CHILD){const results=[];for(const size of [650,1300,2600,5200]){const child=spawnSync(process.execPath,[__filename],{env:{...process.env,TEST_SCALE_CHILD:String(size)},encoding:'utf8'});if(child.status)throw Error(child.stderr);results.push(JSON.parse(child.stdout));}console.log(JSON.stringify(results,null,2));process.exit();}
process.env.WATCHRSS_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'watchrss-scale-'));process.env.WATCHRSS_URL='http://127.0.0.1:19999';
const lib=require('../lib/library'),storage=require('../lib/storage'),account=require('../lib/account'),crypto=require('../lib/crypto'),rss=require('../lib/rss-cloud');storage.setNamespace('hybrid');account.saveSession({userId:'scale-synthetic',accessToken:'not-a-token',expiresAt:Date.now()+3600000});
const size=Number(process.env.TEST_SCALE_CHILD),articles=Array.from({length:size},(_,i)=>({...lib.defaultArticle('a'+i),url:'https://example.org/a'+i,rssSourceUrl:'https://example.org/rss/'+i%200,title:'Synthetic '+i,sourceDeviceId:'device',updatedAt:100,readingPositionChangedAt:100,readingProgress:0.2}));lib.saveArticles(articles);const states=rss.project(articles,[]).rssStates;
const cpu=process.cpuUsage(),start=performance.now();let max=0;
for(let i=0;i<states.length;i+=50){const t=performance.now();lib.applyRssInteractions(states.slice(i,i+50));max=Math.max(max,performance.now()-t);}
lib.saveArticles(articles);storage.deleteFile('lib/rss-interactions.json');const bStart=performance.now(),bCpu=process.cpuUsage();lib.applyRssInteractions(states);const batched={ms:performance.now()-bStart,cpu:process.cpuUsage(bCpu)};
console.log(JSON.stringify({batched,size,pages:Math.ceil(size/50),ms:performance.now()-start,cpu:process.cpuUsage(cpu),maxTaskMs:max,maxRSSKiB:process.resourceUsage().maxRSS}));fs.rmSync(storage.root,{recursive:true,force:true});
