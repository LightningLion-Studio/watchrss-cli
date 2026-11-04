import test from 'node:test';
import assert from 'node:assert/strict';
import books from '../lib/books.js';
import records from '../lib/cloud-records.js';
import merge from '../lib/merge.js';
const id='a'.repeat(64),r={bookId:id,chapterIndex:1,isRead:true,readingProgress:.1234567,readingPositionBytes:10,readingPositionContentHash:'h',readingPositionChangedAt:100,sourceDeviceId:'reader'};
const saved={...r,favoriteSaved:true,favoriteChangedAt:300,favoriteSortOrder:7,favoriteSourceDeviceId:'favorite-writer'};
test('R46 codec keeps independent save tuples and millionth progress',()=>{
 const key=new Uint8Array(32).fill(41),wire=records.encode({key,userId:'synthetic',keyVersion:1,kind:'book-reading',value:saved});
 const value=records.decode({key,userId:'synthetic',...wire}).value;
 assert.equal(value.favoriteSourceDeviceId,'favorite-writer');assert.equal(value.favoriteChangedAt,300);assert.equal(value.readingProgress,.123457);
});
test('R46 newer reading does not overwrite older winning favorite; explicit cancel survives permutations and replay',()=>{
 const read={...r,readingPositionChangedAt:400,sourceDeviceId:'new-reader',watchLaterSaved:true,watchLaterChangedAt:200,watchLaterSortOrder:3,watchLaterSourceDeviceId:'later-writer'};
 const cancel={...saved,favoriteSaved:false,favoriteSourceDeviceId:'z'};
 const variants=[[saved,read,cancel],[cancel,saved,read],[read,cancel,saved]];
 const expected=books.mergeReading(books.mergeReading(saved,read),cancel);
 assert.equal(expected.favoriteSaved,false);assert.equal(expected.favoriteSourceDeviceId,'z');assert.equal(expected.sourceDeviceId,'new-reader');assert.equal(expected.watchLaterSourceDeviceId,'later-writer');
 for(const rows of variants){let value;for(const row of rows.concat(rows)){value=books.mergeReading(value,row);value=JSON.parse(JSON.stringify(value));}assert.deepEqual(value,expected);}
});
test('R46 missing save fields remain absent and legacy source fallback is frozen independently',()=>{
 assert(!('favoriteSaved' in books.reading(r)));
 const legacy={...r,favoriteSaved:false,favoriteChangedAt:10,favoriteSortOrder:0};
 const merged=books.mergeReading(legacy,{...r,sourceDeviceId:'new-reader',readingPositionChangedAt:500});
 assert.equal(merged.favoriteSourceDeviceId,'reader');assert.equal(merged.favoriteSaved,false);
 for(const delta of [{favoriteChangedAt:1},{favoriteSaved:true},{favoriteSaved:true,favoriteChangedAt:1,favoriteSortOrder:0,favoriteSourceDeviceId:3}])assert.throws(()=>books.reading({...r,...delta}));
});
test('R44 metadata kind breaks an otherwise exact tie in both orders',()=>{
 const fingerprint='b'.repeat(64),base={bookId:books.id(fingerprint),fingerprint,title:'Book',chapterCount:1,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'a',sourceUrl:'synthetic'};
 assert.deepEqual(books.merge({...base,kind:'txt'},{...base,kind:'epub'}),books.merge({...base,kind:'epub'},{...base,kind:'txt'}));
});
test('newer private tombstone survives an old saved body in either input order and repeated delivery',()=>{
 const old={articleId:'private',url:'https://watchrss.local/import-content/txt/fixture',updatedAt:100,sourceDeviceId:'a',contentHash:'same',independentSaved:true,independentChangedAt:100,deleted:false,deletedAt:0};
 const tombstone={...old,updatedAt:200,independentSaved:false,independentChangedAt:0,deleted:true,deletedAt:200,sourceDeviceId:'b'};
 for(const inputs of [[old,tombstone],[tombstone,old]]){let value=merge.mergeArticleByLatest(...inputs);assert.equal(value.deleted,true);assert.equal(value.deletedAt,200);value=merge.mergeArticleByLatest(value,old);assert.equal(value.deleted,true);assert.equal(value.deletedAt,200);}
 const restore={...old,updatedAt:300,independentChangedAt:300};assert.equal(merge.mergeArticleByLatest(tombstone,restore).deleted,false);
});
