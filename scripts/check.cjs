'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),manifest=require('../protocol-port.json');
for(const [name,expected]of Object.entries(manifest.ports)){const file=path.join(root,'lib',name+'.js'),hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');if(hash!==expected)throw Error('Port hash drift: '+name);}
for(const dir of ['lib','bin','scripts'])for(const file of fs.readdirSync(path.join(root,dir))){if(!/\.(?:js|cjs)$/.test(file))continue;const result=spawnSync(process.execPath,['--check',path.join(root,dir,file)],{encoding:'utf8'});if(result.status)throw Error(result.stderr);}
if(manifest.sourceWorkingTree){const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'protocol-source.json'))).digest('hex');if(hash!==manifest.sourceWorkingTree.sourcePinsSha256)throw Error('Pending source pin hash drift');console.log('Review-only working-tree source pin; Lead must commit mini and run sync-protocol.py --source-ref <commit> before release');}
console.log('Node syntax + '+Object.keys(manifest.ports).length+' pinned protocol ports verified ('+manifest.sourceCommit+')');
