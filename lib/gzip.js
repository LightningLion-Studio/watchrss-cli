// gzip 编解码（fflate，纯 JS，与系统 zlib 兼容——已在 tests 中互验）
// 使用 vendored 的 fflate browser 构建（纯 JS，Node 与小程序行为一致）
const fflate = require('../vendor/fflate-browser');

function gzip(bytes, options = {}) {
  return fflate.gzipSync(new Uint8Array(bytes), Object.assign({ mtime: 0 }, options));
}

function gunzip(bytes) {
  return fflate.gunzipSync(new Uint8Array(bytes));
}

module.exports = { gzip, gunzip };

const taskProbe=require('./longtask');if(taskProbe.instrument)taskProbe.instrument(module.exports,'gzip');
async function transformAsync(bytes,decompress,check=()=>{}){
 const parts=[],cpu=require('./cooperative'),probe=require('./longtask'),decoder=decompress?new fflate.Gunzip((part)=>parts.push(part)):new fflate.Gzip({mtime:0},part=>parts.push(part)),width=decompress?64:8192;let deadline=Date.now()+4;
 // Owner state can change only across an event-loop turn. Check every such
 // boundary, rather than repeating filesystem-backed fences per 64 bytes.
 check();for(let at=0;at<bytes.length;at+=width){probe.run(decompress?'cpu.gunzip':'cpu.gzip',Math.min(width,bytes.length-at),()=>decoder.push(bytes.subarray(at,at+width),at+width>=bytes.length));if(Date.now()>=deadline){await cpu.turn();check();deadline=Date.now()+4;}}
 if(!bytes.length)decoder.push(bytes,true);check();return require('./util').bytesConcat(parts);
}
module.exports.gzipAsync=(bytes,check)=>transformAsync(bytes,false,check);
module.exports.gunzipAsync=(bytes,check)=>transformAsync(bytes,true,check);
