// R30: rss.rs canonicalize_source_url + SHA256; no network or pool UUID.
const {parse}=require('./backend-url'),crypto=require('./crypto'),util=require('./util');
function invalid(code='invalid_rss_url'){return Object.assign(Error(code),{code});}
function publicV4(b){return !(b[0]===0||b[0]===10||b[0]===127||b[0]>=224||b[0]===169&&b[1]===254||b[0]===172&&b[1]>=16&&b[1]<=31||b[0]===192&&(b[1]===168||b[1]===0&&[0,2].includes(b[2])||b[1]===88&&b[2]===99)||b[0]===100&&b[1]>=64&&b[1]<=127||b[0]===198&&(b[1]>=18&&b[1]<=19||b[1]===51&&b[2]===100)||b[0]===203&&b[1]===0&&b[2]===113);}
function publicLiteral(host){
 if(/^\d+\.\d+\.\d+\.\d+$/.test(host))return publicV4(host.split('.').map(Number));
 if(!host.startsWith('['))return true;
 const parts=host.slice(1,-1).split('::'),left=parts[0]?parts[0].split(':'):[],right=parts[1]?parts[1].split(':'):[];
 const words=left.concat(Array(8-left.length-right.length).fill('0'),right).map(s=>parseInt(s,16));
 if(words.slice(0,5).every(n=>n===0)&&[0,65535].includes(words[5]))return publicV4([words[6]>>8,words[6]&255,words[7]>>8,words[7]&255]);
 return (words[0]&0xe000)===0x2000&&!(words[0]===0x2001&&(words[1]<0x200||words[1]===0xdb8))&&words[0]!==0x2002&&!(words[0]===0x3fff&&words[1]<0x1000);
}
function canonicalUrl(raw){
 if(typeof raw!=='string'||util.utf8ToBytes(raw).length>4096)throw invalid();
 let url;try{url=parse(raw.trim());}catch(_){throw invalid();}
 if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.passwordPresent)throw invalid();
 if(!publicLiteral(url.hostname))throw invalid('rss_private_address_blocked');
 return url.href.split('#')[0];
}
function localOnly(raw){
 try{const url=parse(String(raw).trim());return ['http:','https:'].includes(url.protocol)&&!!(url.username||url.password||url.passwordPresent||!publicLiteral(url.hostname));}catch(_){return false;}
}
function sourceKey(raw){return crypto.sha256Hex(canonicalUrl(raw));}
module.exports={canonicalUrl,sourceKey,localOnly};
