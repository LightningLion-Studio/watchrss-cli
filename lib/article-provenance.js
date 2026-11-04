// Read/retention profile only. Canonical projection is not a cloud writer:
// authenticated extension tokens/ciphertexts remain owned by cloud-records.
const raw=require('./json-raw'),util=require('./util');
const FEATURE='article-register-provenance.v1';
const REGISTERS=['metadata','reading','independent','favorite','watchLater','deletion'];
const META=['url','title','siteName','excerpt','imageUrl','contentHash','importedAt','rssSourceUrl','rssSourceTitle'];
const GROUPS={metadata:['updatedAt',...META],reading:['readingPositionChangedAt','isRead','readingPositionBytes','readingProgress','readingPositionContentHash'],deletion:['deletedAt','deleted']};
for(const group of ['independent','favorite','watchLater'])GROUPS[group]=['ChangedAt','Saved','SortOrder'].map(s=>group+s);
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
function invalid(reason){return Object.assign(Error('文章来源记录无效'),{code:reason});}
function scalar(value){if(typeof value!=='string')throw invalid('invalid_unicode');try{return raw.unicode(value);}catch(_){throw invalid('invalid_unicode');}}
function integer(value,container,key,signed=false,code='invalid_integer'){
 if(typeof value!=='number'||!Number.isSafeInteger(value)||(!signed&&value<0))throw invalid(code);
 const node=raw.meta(container)?.entries.find(e=>e.key===key)?.node;
 if(node){const token=node.text.slice(node.start,node.end),m=/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);if(!m)throw invalid(code);
  let digits=(m[2]+(m[3]||'')).replace(/^0+/,''),power=Number(m[4]||0)-(m[3]||'').length;
  if(digits){if(!Number.isSafeInteger(power)||Math.abs(power)>10000)throw invalid(code);if(power<0){if(-power>digits.length||!/^[0]*$/.test(digits.slice(digits.length+power)))throw invalid(code);digits=digits.slice(0,digits.length+power);}else{if(digits.length+power>16)throw invalid(code);digits+='0'.repeat(power);}digits=digits.replace(/^0+/,'')||'0';if(digits.length>16||digits.length===16&&digits>'9007199254740991')throw invalid(code);}
 }
 return value===0?0:value;
}
function marked(doc){return !!doc?.features?.roCompat?.includes(FEATURE);}
function protectedValue(value){return !!value&&(own(value,'registerSources')||value.__articleProvenanceV1===true);}
function record(value){return{format:'watchrss-rss-record',version:1,kind:'article',features:{incompat:[],roCompat:[FEATURE]},value};}
function normalize(doc,{allowReadOnly=false}={}){
 if(!doc||doc.format!=='watchrss-rss-record'||doc.kind!=='article'||integer(doc.version,doc,'version',false,'invalid_record')!==1)throw invalid('invalid_record');
 const features=doc.features;
 if(!features||typeof features!=='object'||Array.isArray(features)||Object.keys(features).sort().join(',')!=='incompat,roCompat')throw invalid('invalid_features');
 const seen=new Set();for(const group of ['incompat','roCompat']){if(!Array.isArray(features[group])||features[group].length>16)throw invalid('invalid_features');for(const token of features[group]){if(typeof token!=='string'||!/^[a-z0-9][a-z0-9.-]{0,47}$/.test(token)||seen.has(token))throw invalid('invalid_features');seen.add(token);}}
 if(!marked(doc))throw invalid('missing_feature_marker');if(features.incompat.length)throw invalid('opaque_feature');if(!allowReadOnly&&features.roCompat.some(f=>f!==FEATURE))throw invalid('read_only_feature');
 const value=doc.value;if(!value||typeof value!=='object'||Array.isArray(value))throw invalid('invalid_value');
 if(['contentText','contentHtml','contentTextGzip','contentHtmlGzip','body','chapters'].some(k=>own(value,k)))throw invalid('body_in_record');
 const sources=value.registerSources;if(!sources||typeof sources!=='object'||Array.isArray(sources)||Object.keys(sources).sort().join(',')!==REGISTERS.slice().sort().join(','))throw invalid('invalid_register_sources');
 const out={registerSources:Object.fromEntries(REGISTERS.map(k=>[k,scalar(sources[k])]))};
 for(const key of ['articleId','url','contentHash','sourceDeviceId','updatedAt'])if(!own(value,key))throw invalid('missing_required_field');
 for(const key of ['articleId','url','contentHash','sourceDeviceId'])out[key]=scalar(value[key]);
 const blank=/^[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;
 if(blank.test(out.articleId)||blank.test(out.url))throw invalid('invalid_identity');if(out.sourceDeviceId!==sources.metadata)throw invalid('metadata_source_mismatch');
 const get=(key,fallback)=>own(value,key)?value[key]:fallback;
 for(const key of ['title','siteName','excerpt','readingPositionContentHash'])out[key]=scalar(get(key,''));
 for(const key of ['imageUrl','rssSourceUrl','rssSourceTitle'])out[key]=get(key,null)===null?null:scalar(value[key]);
 for(const key of ['updatedAt','importedAt','readingPositionBytes','readingPositionChangedAt','deletedAt','independentChangedAt','favoriteChangedAt','watchLaterChangedAt'])out[key]=integer(get(key,0),value,key);
 for(const key of ['independentSortOrder','favoriteSortOrder','watchLaterSortOrder'])out[key]=integer(get(key,0),value,key,true);
 for(const key of ['isRead','deleted','independentSaved','favoriteSaved','watchLaterSaved']){out[key]=get(key,false);if(typeof out[key]!=='boolean')throw invalid('invalid_boolean');}
 const progress=get('readingProgress',0);if(typeof progress!=='number'||!Number.isFinite(progress)||progress<0||progress>1)throw invalid('invalid_progress');out.readingProgress=Math.floor(progress*1e6+0.5)/1e6;
 if(out.deleted&&out.deletedAt===0)throw invalid('zero_deletion_clock');return record(out);
}
function parse(input,options={}){
 let text=input;
 if(typeof input!=='string'){if(input[0]===239&&input[1]===187&&input[2]===191)throw invalid('invalid_json');text=util.bytesToUtf8(input);if(!util.bytesEqual(util.utf8ToBytes(text),input))throw invalid('invalid_utf8');}
 if(util.utf8ByteLength(text)>65520)throw invalid('record_too_large');
 let doc;try{doc=raw.parse(text);}catch(error){throw invalid(error.reason||'invalid_json');}
 if(raw.meta(doc)?.maxDepth>32)throw invalid('json_depth');
 return options.legacySeed?seedLegacy(doc):normalize(doc,options);
}
function stable(value){if(value&&typeof value==='object'){if(Array.isArray(value))return value.map(stable);return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));}return value;}
function canonical(doc){return JSON.stringify(stable(normalize(doc)));}
function seedLegacy(value){
 if(own(value,'registerSources'))throw invalid('legacy_already_seeded');
 const source=scalar(own(value,'sourceDeviceId')?value.sourceDeviceId:''),witness=value.__articleRegisterLegacyV1;
 const sources=Object.fromEntries(REGISTERS.map(k=>[k,witness?.registerSources?.[k]??source]));
 const seeded={...value,sourceDeviceId:sources.metadata,registerSources:sources};
 if(integer(value.readingPositionChangedAt===undefined?0:value.readingPositionChangedAt,value,'readingPositionChangedAt')===0)seeded.readingPositionChangedAt=witness?.readingPositionChangedAt??value.updatedAt;
 for(const key of ['contentText','contentHtml','contentTextGzip','contentHtmlGzip','body','chapters'])delete seeded[key];
 return normalize(record(seeded));
}
function compare(a,b){if(a===b)return 0;if(a===null)return-1;if(b===null)return 1;return a<b?-1:1;}
function tuple(value,group){const fields=GROUPS[group],clock=value[fields[0]],rest=group==='reading'?[value.isRead?0:1,value.readingPositionBytes,Math.floor(value.readingProgress*1e6+0.5),value.readingPositionContentHash]:group==='deletion'?[value.deleted?1:0]:group==='metadata'?META.map(k=>value[k]):[value[group+'Saved']?0:1,value[group+'SortOrder']];return[clock,value.registerSources[group],...rest];}
function compareGroup(a,b,group){const at=tuple(a,group),bt=tuple(b,group);for(let i=0;i<at.length;i++){const n=compare(at[i],bt[i]);if(n)return n;}return 0;}
function merge(left,right){const a=normalize(left).value,b=normalize(right).value;if(a.articleId!==b.articleId)throw invalid('identity_mismatch');const out={articleId:a.articleId,registerSources:{}};for(const group of REGISTERS){const winner=compareGroup(a,b,group)<0?b:a;for(const field of GROUPS[group])out[field]=winner[field];out.registerSources[group]=winner.registerSources[group];}out.sourceDeviceId=out.registerSources.metadata;return record(out);}
function asRecord(value){if(!protectedValue(value))return seedLegacy(value);const projection={...value};for(const key of ['contentText','contentHtml','contentTextGzip','contentHtmlGzip','body','chapters'])delete projection[key];return normalize(record(projection));}
function mergeValues(left,right){
 if((left.__privateBodyMetadata||left.__bodyOnly)&&protectedValue(right)){const result={...right,__articleProvenanceV1:true};if(left.contentHash===right.contentHash)for(const field of ['contentText','contentHtml','__bodyFile'])if(left[field]!==undefined)result[field]=left[field];return result;}
 if(right.__privateBodyMetadata||right.__bodyOnly){const next={...left};if(right.contentHash===left.contentHash)for(const field of ['contentText','contentHtml','__bodyFile'])if(right[field]!==undefined)next[field]=right[field];return next;}
 const a=asRecord(left),b=asRecord(right),value=merge(a,b).value,metadata=compareGroup(a.value,b.value,'metadata')<0?right:left;
 const result={...metadata,...value,__articleProvenanceV1:true};if(left.__articlePendingEdits||right.__articlePendingEdits)result.__articlePendingEdits=left.__articlePendingEdits||right.__articlePendingEdits;
 // A body is bound to the selected metadata version, never to the read tuple.
 const body=[metadata,left,right].find(v=>v.contentHash===value.contentHash&&(v.contentText||v.contentHtml||v.__bodyFile));
 for(const key of ['contentText','contentHtml','__bodyFile','syncBodyHash','syncBodyByteCount','syncChunkSize','syncChunkHashesJson','syncMetadataHash']){delete result[key];if(body&&body[key]!==undefined)result[key]=body[key];}
 if(!body){result.contentText='';result.contentHtml=null;}
 return result;
}
function freezeLegacy(value){if(value.__privateBodyMetadata||value.__bodyOnly||value.__metadataOnly||protectedValue(value)||value.__articleRegisterLegacyV1)return value;try{const seeded=seedLegacy(value).value;return{...value,__articleRegisterLegacyV1:{registerSources:seeded.registerSources,readingPositionChangedAt:seeded.readingPositionChangedAt}};}catch(_){return value;}}
function positionStatus(value){return!value.readingPositionContentHash?'unresolved':value.readingPositionContentHash===value.contentHash?'applicable':'requires_relocation';}
function effectiveSaved(value){return Object.fromEntries(['independent','favorite','watchLater'].map(k=>[k,!!value[k+'Saved']&&!value.deleted]));}
module.exports={FEATURE,REGISTERS,META,GROUPS,record,normalize,parse,canonical,seedLegacy,merge,mergeValues,asRecord,protectedValue,marked,freezeLegacy,positionStatus,effectiveSaved,compareGroup};

function retentionProof(doc){const value=normalize(doc,{allowReadOnly:true}).value,keys=new Set(Object.keys(value)),tokens=[];for(const [object,known,path]of [[doc,new Set(['format','version','kind','features','value']),''],[doc.value,keys,'value.']])for(const entry of raw.meta(object)?.entries||[])if(!known.has(entry.key))tokens.push(path+entry.key+':'+entry.node.text.slice(entry.keyStart,entry.node.end));tokens.sort();const crypto=require('./crypto');return{metadata:crypto.sha256Hex(JSON.stringify([value.updatedAt,value.registerSources.metadata,...META.map(k=>value[k])])),extensions:crypto.sha256Hex(tokens.join('\n'))};}
module.exports.retentionProof=retentionProof;
