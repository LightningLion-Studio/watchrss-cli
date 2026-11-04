// Opt-in copy surface only: RAM, fixed vocabulary, hashes and numeric facts.
// Never retain an article, URL, body, exception message or account credential.
const crypto=require('./crypto');
const STEPS=new Set(['open','cache','private','local-book','local-file','local-text','cloud','membership','match-book','remote','manifest','descriptor','archive','catalog','alias','body','overlay','migration','consent','result']);
const REASONS=new Set(['begin','classified','public','private','mapped','canonical','missing','foreign-book','ordinal','identity','source','no-match','unreadable','selected','opened','empty','metadata-preview','local','fallback','exception','exact','url-hash','hash-mismatch','url-mismatch','not-legacy','ambiguous','deleted','text','html','invalid-path','unsupported','archive-only','speculative','prompt','approved','declined','queued','complete','cancelled']);
const NUMBERS=new Set(['count','books','chapters','ordinal','objects','archives','direct','rows','exact','urls','hashes','aliases','version','bytes','textLength','htmlLength','pages','localBody','bodyFile','status','deleted','canonical','legacy','sourceMatch']);
const CODES=new Set(['reader_migration_invalid','reader_migration_declined','reader_migration_consent_failed','reader_book_invalid','cloud_book_invalid','cloud_private_archive_invalid','cloud_entry_missing','cloud_book_chapter_deleted','reader_closed','invalid_session','cloud_session_changed','cloud_operation_cancelled','cloud_content_rebuild_required','NEEDS_RECOVERY','cloud_format_upgrade_required','reader_private_unavailable','reader_not_segmented','network_error','timeout']);
const REFS=new Set(['articleId','bookId','url','rssSourceUrl','sourceUrl','contentHash']);
let last=null;
function format(value,field){
 if(!value)return 'empty';
 if(field==='contentHash')return /^[a-f\d]{64}$/i.test(value)?'sha256':'legacy';
 if(field==='articleId'||field==='bookId')return /^[a-f\d]{64}$/i.test(value)?'sha256':'legacy';
 if(/^https:\/\/watchrss\.local\/import-epub\//i.test(value))return /\/chapter\/\d+/.test(value)?'import-epub/chapter':'import-epub';
 if(/^https:\/\/watchrss\.local\/import-txt-novel\//i.test(value))return /\/chapter\/\d+/.test(value)?'import-txt-novel/chapter':'import-txt-novel';
 if(/^watchrss:\/\/import\/online-v1\//i.test(value))return 'online-v1';
 if(/^watchrss:\/\/import\/instance-v1\//i.test(value))return 'instance-v1';
 if(/^watchrss:\/\/book\//i.test(value))return 'book';
 if(/^https:\/\/watchrss\.local\/import-content\/epub\//i.test(value))return 'import-content/epub';
 if(/^https:\/\/watchrss\.local\/import-content\/txt\//i.test(value))return 'import-content/txt';
 if(/^(?:watchrss|watchrss-txt|watchrss-epub):\/\//i.test(value))return 'legacy';
 return /^https?:\/\//i.test(value)?'http':'other';
}
function refs(value){
 const out={};for(const key of REFS)if(typeof value?.[key]==='string')out[key]={sha256:crypto.sha256Hex(value[key]).slice(0,12),format:format(value[key],key)};return out;
}
function begin(article,{speculative=false}={}){
 if(speculative)return null;
 last={version:1,article:refs(article),steps:[],totals:{},dropped:0};
 record(last,'open',true,'begin');return last;
}
function record(trace,step,hit,reason,numbers={},identities){
 if(!trace||trace!==last||!STEPS.has(step)||!REASONS.has(reason))return;
 const entry={step,hit:!!hit,reason};
 for(const key of NUMBERS)if(typeof numbers[key]==='number'&&Number.isFinite(numbers[key]))entry[key]=Math.max(-1,Math.min(Number.MAX_SAFE_INTEGER,Math.trunc(numbers[key])));
 if(identities)entry.refs=refs(identities);
 const totals=trace.totals[step]||(trace.totals[step]=[0,0]);totals[hit?0:1]++;
 // A catalog may contain thousands of candidates. Summarize repeated decisions
 // with the last sanitized candidate, so misses do not erase the entry route.
 const at=trace.steps.findIndex(e=>e.step===step&&e.hit===entry.hit&&e.reason===reason);
 if(at>=0){entry.repeats=(trace.steps[at].repeats||1)+1;trace.steps.splice(at,1);}
 trace.steps.push(entry);
 // Preserve the entry decision and the most recent failure/fallback decisions.
 while(trace.steps.length>28){trace.steps.splice(1,1);trace.dropped++;}
}
function error(trace,step,value){
 if(!trace||trace!==last||!STEPS.has(step))return;
 record(trace,step,false,'exception',{status:value?.status});
 if(typeof value?.code==='string'){const entry=trace.steps[trace.steps.length-1];entry.codeSha256=crypto.sha256Hex(value.code).slice(0,12);if(CODES.has(value.code))entry.code=value.code;}
}
function getLastBookDiagnostics(){
 const storage=require('./storage-audit').lastDiagnostics();
 if(!last)return JSON.stringify({version:1,reason:'no-open',...(storage?{storage}:{})});
 const out={...last,steps:last.steps.slice(),...(storage?{storage}:{})};let json=JSON.stringify(out);
 // All retained strings are ASCII. String length therefore equals UTF-8 bytes.
 while(json.length>4096&&out.steps.length){out.steps.splice(out.steps.length>1?1:0,1);out.dropped++;json=JSON.stringify(out);}
 return json;
}
async function getStorageDiagnostics(){return JSON.stringify(await require('./storage-audit').getStorageDiagnostics());}
module.exports={begin,record,error,getLastBookDiagnostics,getStorageDiagnostics};
