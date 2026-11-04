// Text-only presentation; never execute markup or load embedded resources.
const ENTITIES = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”'};
function toText(value) {
  return String(value || '')
    .replace(/<!--[^]*?(?:-->|$)/g, '')
    .replace(/<(script|style|head|template|noscript)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<\/?[a-z][a-z0-9:-]*\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, tag =>
      /^<(?:[a-z][\w-]*:)?br\b|^<\/(?:[a-z][\w-]*:)?(?:p|div|article|section|h[1-6]|blockquote|pre|li|tr)\b/i.test(tag) ? '\n' : '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (raw, entity) => {
      if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] || raw;
      const code = /^#x/i.test(entity) ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
    });
}
module.exports = { toText };
