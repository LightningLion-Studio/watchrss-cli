// Admission is deliberately below the 100000-chapter R44 reader ceiling.
// See the CLIREPIN limit audit: records, manifest and byte limits also apply.
const MAX_CHAPTERS=10000,MAX_ZIP_ENTRIES=20000;
function chapterError(kind){return Object.assign(Error(`${kind} 文件最多支持 ${MAX_CHAPTERS} 章（含前言），请拆分后上传`),{code:'import_chapter_limit'});}
function archiveError(){return Object.assign(Error(`EPUB 压缩包最多支持 ${MAX_ZIP_ENTRIES} 个文件，请拆分后上传`),{code:'import_archive_entry_limit'});}
// UTF-8 alignment can shorten a chunk by at most three bytes.
function bookChunkBytes(size){return Math.max(64*1024,Math.ceil(size/1024)+4);}
function validateSnapshot(created){if(created.encryptedManifest.length>8*1024*1024||created.manifest.objects.length>1024||created.manifest.objects.some(o=>Array.isArray(o.chunks)&&o.chunks.length>1024))throw Object.assign(Error('云端目录超过跨端读取上限（1024 个对象、每对象 1024 个分块、8 MiB 清单），请减少资料后重试'),{code:'import_cloud_capacity'});}
module.exports={MAX_CHAPTERS,MAX_ZIP_ENTRIES,chapterError,archiveError,bookChunkBytes,validateSnapshot};
