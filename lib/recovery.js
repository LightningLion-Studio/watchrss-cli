// 24 词恢复密钥：与 Android_WatchRSS_Phone RecoveryWords.kt 逐位一致
// 32B 熵 + SHA-256(熵) 首字节校验和 = 33B = 24 × 11bit 词
const crypto = require('./crypto');
const util = require('./util');

const PREFIXES =
  'ba be bi bo bu ca ce ci co cu da de di do du fa fe fi fo fu ga ge gi go gu ha he hi ho hu ja je'
    .split(' ');
const SUFFIXES =
  'la le li lo lu ma me mi mo mu na ne ni no nu pa pe pi po pu ra re ri ro ru sa se si so su ta te ti to tu va ve vi vo vu wa we wi wo wu ya ye yi yo yu za ze zi zo zu ka ke ki ko ku qa qe qi qo'
    .split(' ');
const WORDS = [];
for (const prefix of PREFIXES) {
  for (const suffix of SUFFIXES) {
    WORDS.push(`${prefix}${suffix}`);
  }
}
if (PREFIXES.length !== 32 || SUFFIXES.length !== 64 || WORDS.length !== 2048) {
  throw new Error('恢复词词表不完整');
}
const WORD_INDEX = {};
WORDS.forEach((w, i) => {
  WORD_INDEX[w] = i;
});

const ENTROPY_BYTES = 32;
const WORD_COUNT = 24;
const BITS_PER_WORD = 11;

function encode(entropy) {
  const bytes = new Uint8Array(entropy);
  if (bytes.length !== ENTROPY_BYTES) throw new Error('恢复密钥熵必须为256位');
  const checksum = crypto.sha256Hex(bytes).slice(0, 2);
  const payload = util.bytesConcat([bytes, util.hexDecode(checksum)]);
  const totalBits = payload.length * 8;
  if (totalBits !== WORD_COUNT * BITS_PER_WORD) throw new Error('恢复词位宽不匹配');
  const words = [];
  for (let wordIndex = 0; wordIndex < WORD_COUNT; wordIndex += 1) {
    let value = 0;
    for (let bit = 0; bit < BITS_PER_WORD; bit += 1) {
      const bitIndex = wordIndex * BITS_PER_WORD + bit;
      const byte = payload[Math.floor(bitIndex / 8)];
      const bitValue = (byte >> (7 - (bitIndex % 8))) & 1;
      value = (value << 1) | bitValue;
    }
    words.push(WORDS[value]);
  }
  return words;
}

function decode(words) {
  const list = (Array.isArray(words) ? words : String(words).trim().split(/\s+/)).map((w) => String(w).trim().toLowerCase()).filter(Boolean);
  if (list.length !== WORD_COUNT) throw new Error('恢复密钥必须包含24个词');
  const payload = new Uint8Array(ENTROPY_BYTES + 1);
  list.forEach((word, wordIndex) => {
    const value = Object.prototype.hasOwnProperty.call(WORD_INDEX, word) ? WORD_INDEX[word] : null;
    if (value === null) throw new Error(`恢复词无效：${word}`);
    for (let bit = 0; bit < BITS_PER_WORD; bit += 1) {
      const bitValue = (value >> (BITS_PER_WORD - 1 - bit)) & 1;
      const bitIndex = wordIndex * BITS_PER_WORD + bit;
      payload[Math.floor(bitIndex / 8)] |= bitValue << (7 - (bitIndex % 8));
    }
  });
  const entropy = payload.slice(0, ENTROPY_BYTES);
  const expected = util.hexDecode(crypto.sha256Hex(entropy).slice(0, 2))[0];
  if (payload[ENTROPY_BYTES] !== expected) throw new Error('恢复词校验失败');
  return entropy;
}

function generate() {
  const entropy = crypto.randomBytes(ENTROPY_BYTES);
  return { words: encode(entropy), entropy };
}

function parse(text) {
  return String(text).trim().split(/\s+/).filter(Boolean);
}

module.exports = { WORDS, encode, decode, generate, parse };
