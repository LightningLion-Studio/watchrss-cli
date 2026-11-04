'use strict';
function hasWeChatRuntime(source){
 // Ignore quoted literals (including Node's exclusive-create flag) and
 // comments. Reject every remaining runtime identifier, including aliases,
 // typeof checks, destructuring and property access.
 const code=source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,' ');
 return /\bwx\b|\bgetFileSystemManager\s*\(/.test(code)||/\b(?:globalThis|global)\s*\[\s*['"]wx['"]\s*\]/.test(source);
}
function hasUIImport(source){return /require\(['"][^'"]*(?:pages\/|wx-mock|tab-transition|reader-cache)/.test(source);}
module.exports={hasWeChatRuntime,hasUIImport};
