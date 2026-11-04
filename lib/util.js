// 基础工具：UTF-8、base64（标准字母表无填充 / base64url 无填充）、hex、长度前缀 SHA-256
// 全部为纯函数，Node 与微信小程序环境通用

function utf8ToBytes(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  const bytes = [];
  for (let i = 0; i < str.length; i += 1) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(
      0xf0 | (code >> 18),
      0x80 | ((code >> 12) & 0x3f),
      0x80 | ((code >> 6) & 0x3f),
      0x80 | (code & 0x3f)
    );
  }
  return new Uint8Array(bytes);
}

function bytesToUtf8(bytes) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  const parts=[],codes=[];
  const arr=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  for(let i=0;i<arr.length;i++){
    const b=arr[i];
    if(b<0x80)codes.push(b);
    else if(b<0xe0)codes.push(((b&0x1f)<<6)|(arr[++i]&0x3f));
    else if(b<0xf0)codes.push(((b&0x0f)<<12)|((arr[++i]&0x3f)<<6)|(arr[++i]&0x3f));
    else{const c=((b&7)<<18)|((arr[++i]&0x3f)<<12)|((arr[++i]&0x3f)<<6)|(arr[++i]&0x3f);codes.push(0xd800+((c-0x10000)>>10),0xdc00+((c-0x10000)&0x3ff));}
    if(codes.length>=4096){parts.push(String.fromCharCode.apply(null,codes));codes.length=0;}
  }
  if(codes.length)parts.push(String.fromCharCode.apply(null,codes));return parts.join('');
}

const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64Encode(bytes, alphabet = B64_STD) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < arr.length; i += 3) {
    const b0 = arr[i];
    const b1 = i + 1 < arr.length ? arr[i + 1] : 0;
    const b2 = i + 2 < arr.length ? arr[i + 2] : 0;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < arr.length) out += alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (i + 2 < arr.length) out += alphabet[b2 & 0x3f];
  }
  return out;
}

function base64Decode(text, alphabet = B64_STD) {
  const clean = String(text).replace(/=+$/g, '').replace(/\s+/g, '');
  const table = {};
  for (let i = 0; i < 64; i += 1) table[alphabet[i]] = i;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = table[clean[i]];
    const c1 = table[clean[i + 1]];
    const c2 = clean[i + 2];
    const c3 = clean[i + 3];
    if (c0 === undefined || c1 === undefined) throw new Error('base64 解码失败');
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (c2 !== undefined) {
      out[o++] = ((c1 & 0x0f) << 4) | (table[c2] >> 2);
      if (c3 !== undefined) out[o++] = ((table[c2] & 0x03) << 6) | table[c3];
    }
  }
  return out;
}

// 标准 base64（带填充）——与 Java Base64.getEncoder()/getDecoder() 互操作
function base64PaddedEncode(bytes) {
  const b64 = base64Encode(bytes, B64_STD);
  const pad = (4 - (b64.length % 4)) % 4;
  return b64 + '='.repeat(pad);
}

function base64PaddedDecode(text) {
  return base64Decode(String(text), B64_STD);
}

function base64UrlEncode(bytes) {
  return base64Encode(bytes, B64_URL);
}

function base64UrlDecode(text) {
  return base64Decode(text, B64_URL);
}

function hexEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < arr.length; i += 1) out += arr[i].toString(16).padStart(2, '0');
  return out;
}

function hexDecode(text) {
  const clean = String(text).trim().toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) throw new Error('hex 解码失败');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function sha256LengthPrefixedHex(sha256, fields) {
  const digest = sha256.create ? sha256.create() : null;
  // 兼容传入 hash 函数本身（@noble/hashes）：由 crypto.js 注入已初始化的 digest
  throw new Error('use crypto.sha256LengthPrefixed');
}

function bytesConcat(list) {
  const total = list.reduce((sum, b) => sum + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of list) {
    out.set(b instanceof Uint8Array ? b : new Uint8Array(b), offset);
    offset += b.length;
  }
  return out;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// 与手机端 maskPhone 一致
function maskPhone(phone) {
  const trimmed = String(phone).trim();
  if (trimmed.length <= 4) return '****';
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`;
}

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

module.exports = {
  utf8ToBytes,
  bytesToUtf8,
  base64Encode,
  base64Decode,
  base64PaddedEncode,
  base64PaddedDecode,
  base64UrlEncode,
  base64UrlDecode,
  hexEncode,
  hexDecode,
  bytesConcat,
  bytesEqual,
  maskPhone,
  tick,
};

// Count without allocating a JS number array on runtimes without TextEncoder.
function* utf8ByteLengthSteps(text){let bytes=0,checkpoint=0;for(let i=0;i<text.length;i++){const code=text.charCodeAt(i);if(code<128)bytes++;else if(code<2048)bytes+=2;else if(code>=0xd800&&code<=0xdbff&&i+1<text.length&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}else bytes+=3;if(i-checkpoint>=4096){checkpoint=i;yield;}}return bytes;}
function utf8ByteLength(text){let result;const iterator=utf8ByteLengthSteps(text);while(!(result=iterator.next()).done){}return result.value;}
Object.assign(module.exports,{utf8ByteLength,utf8ByteLengthSteps});
