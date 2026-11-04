// Rust url 2.5.8 retains literal ^ in paths; the newer URL polyfill encodes it.
// Protect only literal input carets, preserving an existing %5E byte sequence.
const {URL}=require('../vendor/url');
function parse(raw,base){
 raw=String(raw);const original=new URL(raw,base);
 let marker='watchrss-caret-marker';
 while((raw+' '+(base||'')).toLowerCase().includes(marker))marker+='x';
 const parsed=raw.includes('^')||String(base||'').includes('^')?new URL(raw.replace(/\^/g,marker),base===undefined?undefined:String(base).replace(/\^/g,marker)):original;
 const restore=value=>value.split(marker).join('^');
 const authority=/^[a-z][a-z0-9+.-]*:[/\\]*([^/\\?#]*)/i.exec(raw.trim().replace(/[\t\r\n]/g,''));
 const passwordPresent=!!(authority&&authority[1].includes('@')&&authority[1].slice(0,authority[1].lastIndexOf('@')).includes(':'));
 return{protocol:original.protocol,hostname:original.hostname,username:original.username,password:original.password,passwordPresent,pathname:restore(parsed.pathname),search:restore(parsed.search),href:restore(parsed.toString())};
}
module.exports={parse};
