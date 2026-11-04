from pathlib import Path
import subprocess,re,json,hashlib,argparse
root=Path(__file__).resolve().parents[2]; dst=root/'WatchRSS_CLI'; src=root/'WatchRSS_WeChat'
parser=argparse.ArgumentParser(description='Import pinned mini protocol bytes; --worktree is a review-only pending-commit pin.')
choice=parser.add_mutually_exclusive_group()
choice.add_argument('--source-ref',help='Mini commit/ref to pin after Lead commits the shared fixes')
choice.add_argument('--worktree',action='store_true',help='Pin current mini bytes, explicitly recording their uncommitted provenance')
args=parser.parse_args()
previous_manifest=json.loads((dst/'protocol-port.json').read_text())
if not args.source_ref and not args.worktree and previous_manifest.get('sourceWorkingTree'):
 parser.error('Pending working-tree source: use --worktree again or --source-ref <Lead mini commit>')
ref=args.source_ref or previous_manifest['sourceCommit']
commit=subprocess.check_output(['git','rev-parse','HEAD' if args.worktree else ref],cwd=src,text=True).strip()
def source_bytes(relative):
 return (src/relative).read_bytes() if args.worktree else subprocess.check_output(['git','show',commit+':'+relative],cwd=src)

adapters={'storage','storage-async','http','account','appaccess','login','user-error','cloud-storage-upgrade','longtask','interaction','error-report','session-route','storage-maintenance'}
# These mini implementations contain platform policy/runtime calls. Traverse
# their source for provenance, but always emit the explicit Node adapter.
native_adapters={'import-files','import-space','storage-audit','storage-budget','storage-protection','pending-payloads'}
names=set(['crypto','util','gzip','envelope','recovery','snapshot','payload','merge','library','sync','cloud-library','cloud-records','device','rss','body','online-reader','cloud-reader','html-text','reader-upload','file-import','txt-chapters','cloud-format','cloud-scope','cloud-v2','cloud-keys'])
files={}
while names:
 n=names.pop()
 if n in adapters or n in files:continue
 text=source_bytes('miniprogram/lib/'+n+'.js').decode()
 files[n]=text
 names.update(x for x in re.findall(r"require\(['\"]\./([a-z0-9-]+)['\"]\)",text) if x not in adapters and x not in files)
previous_pins=json.loads((dst/'protocol-source.json').read_text())
previous_ports=json.loads((dst/'protocol-port.json').read_text())['ports']
pins={}
for n,s in files.items():
 p='WatchRSS_WeChat/miniprogram/lib/'+n+'.js';pins[p]=hashlib.sha256(s.encode()).hexdigest()
 # Native Node storage roots replace WeChat runtime object identity fences.
 if 'storage' not in s and n=='background':s="const storage=require('./storage');\n"+s
 s=s.replace("(typeof wx!=='undefined'&&wx.env?wx.env.USER_DATA_PATH:'')","storage.root")
 s=s.replace("typeof wx==='undefined'?null:wx","storage.root")
 s=s.replace("typeof wx!=='undefined'&&wx.env?cloudScope.load(userId)?.libraryEpoch:undefined","cloudScope.load(userId)?.libraryEpoch")
 s=s.replace("typeof wx!=='undefined'&&wx.env","true").replace("typeof wx==='undefined'||!wx.env","false")
 s=s.replace('wx.env.USER_DATA_PATH','storage.root')
 if n in ['library','state-map','books','book-stream','article-body-store']:s=re.sub(r'\bwx\b','storage.root',s)
 # Runtime I/O is owned by the CLI; pin mini source and Node output separately.
 if n in native_adapters:s=(dst/'scripts/ports'/f'{n}.js').read_text()
 if n=='cloud-books':
  marker="try{await new Promise(resolve=>setTimeout(resolve,250));check();if(noLiveBody(object.privateBook)){job.status='complete';return;}job.status='running';"
  drain_marker="batchReferences(){if(!batch)batch=batchReferences().catch(error=>{batch=null;throw error;});return batch;},close()"
  finally_marker="finally{source?.close();options?.close();job.options=null;}"
  text_finally="finally{source?.close();hash.destroy();options.close();}"
  if any(s.count(value)!=1 for value in [marker,drain_marker,finally_marker,text_finally,'const jobs=new Map()']) or 'function noLiveBody(value)' not in s:
   raise ValueError('cloud-books prefetch lifecycle changed: review the Node command fence')
  # Mini 78 skips authenticated books with no live body. Keep that branch and
  # reject cancelled queued jobs before they can even schedule the 250ms delay.
  s=s.replace(marker,marker.replace('try{await','try{check();await',1))
  # Range lookahead is deliberately concurrent. Closing aborts admission/tasks;
  # draining also owns every detached chunk continuation until command unlock.
  s=s.replace(drain_marker,drain_marker.replace(',close()',',async drain(){await Promise.allSettled([...pending.values(),...(batch?[batch]:[])]);},close()'))
  s=s.replace(finally_marker,"finally{source?.close();options?.close();await options?.drain();job.options=null;}")
  s=s.replace(text_finally,"finally{source?.close();hash.destroy();options.close();await options.drain();}")
  s+="\n// One CLI command owns these jobs until its profile lock is released.\nmodule.exports.finishCommand=async function({cancel=false}={}){if(cancel)cancelPrefetch();try{return await waitForPrefetch();}finally{jobs.clear();}};\n"
 if n=='cloud-download':
  # Native transport adapts from failures/byte pressure, without wx observers.
  a=s.index("\nif(typeof wx!=='undefined'){");b=s.index('\nmodule.exports',a)
  s=s[:a]+s[b:]
 if n=='books' and 'function commitStream(' in s:
  if ",fs=storage.root.getFileSystemManager();" not in s or 'fs.renameSync(packed.filePath,file)' not in s:
   raise ValueError('books.commitStream changed: review the CLI file commit adapter')
  s=s.replace(",fs=storage.root.getFileSystemManager();", ";")
  s=s.replace('fs.renameSync(packed.filePath,file)', "require('./import-files').commit(packed.filePath,relative)")
 if n=='crypto':
  a=s.index('function getPlatformRandomValues('); b=s.index('\nfunction initializeRandom',a)
  s=s[:a]+"function getPlatformRandomValues(length) {return Promise.resolve(new Uint8Array(require('node:crypto').randomBytes(length)));}\n"+s[b:]
 if n=='sync':
  a=s.index('    // 落盘文件');b=s.index('\n  }',a)
  s=s[:a]+"    throw Object.assign(Error('下载未返回二进制'),{code:'cloud_download_invalid'});"+s[b:]
  s=s.replace('小程序 · 本机','WatchRSS CLI').replace('小程序 ·','WatchRSS CLI ·')
  s=s.replace("function needsFormatDeclaration(deviceId){return !r48Declarations.has(declarationId(deviceId));}", "function needsFormatDeclaration(deviceId,knownDevice){if(knownDevice&&knownDevice.deviceId===deviceId&&!knownDevice.revokedAt&&Object.entries(require('./cloud-format').capabilities()).every(([name,value])=>knownDevice.capabilities?.[name]===value))return false;return !r48Declarations.has(declarationId(deviceId));}")

  s=s.replace("const cacheId=cloudScope.current().id+':'+snapshotId;manifestMemory.delete(cacheId);", "require('./manifest-cache').store(snapshotId,bytes);const cacheId=cloudScope.current().id+':'+snapshotId;manifestMemory.delete(cacheId);")
  s=s.replace("  if(onPhase)onPhase('manifest','正在读取索引清单');", """  // A current authenticated head + matching cached ciphertext is sufficient
  // when none of the requested logical objects exist (v3 metadata lives in records).
  const cachedBytes=loadManifest(head.id);
  if(cachedBytes && crypto.sha256Hex(cachedBytes)===head.manifestSha256 && cachedBytes.length===head.manifestSizeBytes){
    const cached=await snapshot.decryptManifestAsync(accountKey,head.id,cachedBytes,head);
    if(!wanted.length || !cached.objects.some(object=>wanted.includes(object.name)))return {manifest:cached,objects:{}};
  }else if(cachedBytes){manifestMemory.delete(cloudScope.current().id+':'+head.id);storage.deleteFile(require('./manifest-cache').file(head.id));}
  if(onPhase)onPhase('manifest','正在读取索引清单');""")

 if n=='cloud-reader':
  marker="remoteOnly=!!(budget&&prepared.stage.remove&&budget.overBudget())"
  if marker not in s:raise ValueError('cloud-reader remote-only policy changed: review hybrid retention')
  s=s.replace(marker,"remoteOnly=storage.getMode()==='cloud'&&!!(budget&&prepared.stage.remove&&budget.overBudget())")
 if n=='cloud-reader':
  a=s.index(' const approval=approved?'); b=s.index('\n if(!approval',a)
  s=s[:a]+" if(!approved)throw Object.assign(Error('请先在手机或小程序授权旧备份转换'),{code:'reader_migration_consent_required'});\n const approval={confirm:true};"+s[b:]
 if n=='cloud-reader':
  s=s.replace("    await require('./reader-upload').uploadObjects(directTargets", "    await require('./upload-plan').stage(created,directTargets);\n    await require('./reader-upload').uploadObjects(directTargets")
  s=s.replace("onProgress:p=>{diagnostic?.progress(p);", "onProgress:p=>{require('./upload-plan').progress(created.manifest.snapshotId,p);diagnostic?.progress(p);")
  s=s.replace("    sync.storeManifest(created.manifest.snapshotId, created.encryptedManifest, true);", "    require('./upload-plan').complete(created.manifest.snapshotId);\n    sync.storeManifest(created.manifest.snapshotId, created.encryptedManifest, true);")
 if n=='cloud-library':s=s.replace("function applyIntent(intent){","function applyIntent(intent){\n  if(intent.type==='progress'){library.updateReadingPosition(intent.id,intent.progress,intent.positionBytes||0);return;}")
 if n=='cloud-library':s=s.replace("    const changed=await (library.applyCloudIndexAsync","    require('./intent-rebase').sources(index.sources,pending(scope.userId),library);\n    const changed=await (library.applyCloudIndexAsync")
 if n=='cloud-library':
  s=s.replace('sync.needsFormatDeclaration(identity)','sync.needsFormatDeclaration(identity,ownDevice)')
  s=s.replace("  if(recordState.enabled&&!recordError){try{", "  const skipRecordPush=!changed&&!library.isDirty()&&!pending(userId).length&&!recordState.needsPush&&!require('./cloud-scope').content(userId)?.rebuildRequired;\n  if(recordState.enabled&&!recordError&&!skipRecordPush){try{")
  s=s.replace("    try{await pushRecords(scope,keyInfo,!!privateError,privateState);", "    try{if(!skipRecordPush||privateState.uploaded||library.isDirty())await pushRecords(scope,keyInfo,!!privateError,privateState);")

  # CLI metadata sync never refreshes the public RSS pool implicitly. The
  # dedicated sources refresh/add command owns that explicit network operation.
  s=s.replace("if(lastFullRead===0&&typeof rss.refreshSources", "if(scope.refreshPublic!==false&&lastFullRead===0&&typeof rss.refreshSources")
  s=s.replace("manual:!!options.force};", "manual:!!options.force,refreshPublic:options.refreshPublic!==false};")
  s=s.replace("\n      await pullRecords(scope);assertCurrent(scope);", "\n      await new Promise(resolve=>setTimeout(resolve,100*2**attempt+Math.floor(Math.random()*100)));assertCurrent(scope);await pullRecords(scope);assertCurrent(scope);")
 if n=='article-body-store':s=s.replace('owner=host.env.USER_DATA_PATH','owner=host')
 if n=='book-stream':
  a=s.index('function localRange(');b=s.index('\nasync function open(',a)
  s=s[:a]+'''function localRange(relative,check=()=>{}){
 const fs=require('node:fs'),filePath=storage.location(relative);let stat;
 try{stat=fs.statSync(filePath);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(!Number.isSafeInteger(stat.size)||stat.size<2)throw invalid();
 const range={size:stat.size,identity:relative+':'+stat.size+':'+stat.mtimeMs,async read(start,end){check();const handle=await fs.promises.open(filePath,'r');try{const out=Buffer.alloc(end-start);const {bytesRead}=await handle.read(out,0,out.length,start);check();if(bytesRead!==out.length)throw invalid();return new Uint8Array(out);}finally{await handle.close();}}};
 range.scan=range.read;return range;
}
'''+s[b:]
  s=s.replace("const host=storage.root,key=host.env.USER_DATA_PATH+':'+indexPath","const host=storage.root,key=host+':'+indexPath")
  s=s.replace("typeof storage.root==='undefined'||storage.root!==entry.host","storage.root!==entry.host")
 s=s.replace("true?storage.root:''","storage.root").replace("if(false)return null;","").replace("privateContent&&true&&","privateContent&&").replace("if(true){","{")
 (dst/'lib'/f'{n}.js').write_text(s)
for n in ['noble-crypto','fflate-browser']:
 data=source_bytes('miniprogram/vendor/'+n+'.js');(dst/'vendor'/f'{n}.js').write_bytes(data);pins['WatchRSS_WeChat/miniprogram/vendor/'+n+'.js']=hashlib.sha256(data).hexdigest()
pins={**{k:pins[k] for k in previous_pins if k in pins},**{k:pins[k] for k in sorted(pins) if k not in previous_pins}}
port_hashes={n:hashlib.sha256((dst/'lib'/f'{n}.js').read_bytes()).hexdigest() for n in files}
port_hashes={**{k:port_hashes[k] for k in previous_ports if k in port_hashes},**{k:port_hashes[k] for k in sorted(port_hashes) if k not in previous_ports}}
(dst/'protocol-source.json').write_text(json.dumps(pins,indent=2)+'\n')
manifest={'sourceCommit':commit,'node':'>=22','ports':port_hashes}
if args.worktree:manifest['sourceWorkingTree']={'baseCommit':commit,'sourcePinsSha256':hashlib.sha256((dst/'protocol-source.json').read_bytes()).hexdigest()}
(dst/'protocol-port.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('ported',len(files),'business modules')
