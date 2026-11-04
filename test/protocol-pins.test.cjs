const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),source=path.resolve(root,'../WatchRSS_WeChat'),pins=require('../protocol-source.json'),port=require('../protocol-port.json');
test('source pins verify exact committed or explicitly pending working-tree bytes; Node output pins are independent',()=>{
 assert.match(port.sourceCommit,/^[a-f0-9]{40}$/);
 if(port.sourceWorkingTree){assert.equal(port.sourceWorkingTree.baseCommit,port.sourceCommit);assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,'protocol-source.json'))).digest('hex'),port.sourceWorkingTree.sourcePinsSha256);}
 for(const [file,hash]of Object.entries(pins)){
  if(!fs.existsSync(source))continue;
  const rel=file.replace(/^WatchRSS_WeChat\//,'');let bytes;
  const result=spawnSync('git',['show',port.sourceCommit+':'+rel],{cwd:source});
  // A scoped pending port retains committed pins for untouched modules. Only
  // explicitly changed hashes resolve to the corresponding working-tree file.
  if(result.status===0 && createHash('sha256').update(result.stdout).digest('hex')===hash)bytes=result.stdout;
  else{assert(port.sourceWorkingTree,'uncommitted source pin requires explicit pending provenance: '+file);bytes=fs.readFileSync(path.join(source,rel));}
  assert.equal(createHash('sha256').update(bytes).digest('hex'),hash,file);
 }
 for(const [name,hash]of Object.entries(port.ports))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,'lib',name+'.js'))).digest('hex'),hash,name);
});
test('shared vector fixture copies match cloud-v2 authoritative inputs',()=>{const dir=path.resolve(root,'../.codex-tmp/cloud-v2/vectors');if(!fs.existsSync(dir))return;const aliases={'cloud-v2-vectors.json':'v2-vectors.json'};for(const name of fs.readdirSync(path.join(__dirname,'fixtures'))){if(!fs.statSync(path.join(__dirname,'fixtures',name)).isFile())continue;const original=path.join(dir,aliases[name]||name);if(fs.existsSync(original))assert.deepEqual(fs.readFileSync(path.join(__dirname,'fixtures',name)),fs.readFileSync(original),name);}});
const {hasWeChatRuntime,hasUIImport}=require('../scripts/runtime-guard.cjs');
test('CLI production business code has no WeChat runtime or UI imports',()=>{for(const name of fs.readdirSync(path.join(root,'lib'))){const s=fs.readFileSync(path.join(root,'lib',name),'utf8');assert(!hasWeChatRuntime(s)&&!hasUIImport(s),name);}});
test('runtime guard rejects WeChat aliases and permits Node exclusive-create flags',()=>{
 for(const code of ['const host=wx;host.getFileSystemManager()','let host = wx','const {env}=wx','typeof wx','wx.getFileSystemManager()',"wx['getFileSystemManager']()",'globalThis.wx',"globalThis['wx']",'storage.root.getFileSystemManager()'] )assert(hasWeChatRuntime(code),code);
 assert(!hasWeChatRuntime("fs.writeFileSync(file,bytes,{flag:'wx'}); // wx is only a comment\n/* wx */"));
});
test('Node runtime overrides survive protocol regeneration',()=>{for(const name of ['import-files','import-space','storage-audit','storage-budget','storage-protection','pending-payloads'])assert.deepEqual(fs.readFileSync(path.join(root,'lib',name+'.js')),fs.readFileSync(path.join(root,'scripts/ports',name+'.js')),name);});
