import './test-root.cjs';
// 合并语义矩阵：对照 Kotlin mergeArticleByLatest / mergeRssSourcesFromSync 行为
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const merge = require('../lib/merge.js');

function baseArticle(overrides = {}) {
  return Object.assign({
    articleId: 'a', sourceDeviceId: 'devL', url: 'u', title: 'lt', siteName: '', excerpt: '',
    contentHtml: '<p>l</p>', contentText: 'l', imageUrl: null, contentHash: 'hL',
    importedAt: 1, updatedAt: 100,
    independentSaved: false, independentChangedAt: 0, independentSortOrder: 0,
    rssSourceUrl: null, rssSourceTitle: null,
    favoriteSaved: false, favoriteChangedAt: 0, favoriteSortOrder: 0,
    watchLaterSaved: false, watchLaterChangedAt: 0, watchLaterSortOrder: 0,
    deleted: false, deletedAt: 0,
    readingProgress: 0, readingPositionBytes: 0, readingPositionContentHash: '', readingPositionChangedAt: 0,
    isRead: false,
  }, overrides);
}

// metadata 取 updatedAt 新者；平局取 local
{
  const local = baseArticle({ updatedAt: 100, title: 'L' });
  const remote = baseArticle({ updatedAt: 200, sourceDeviceId: 'devR', title: 'R' });
  assert.equal(merge.mergeArticleByLatest(local, remote).title, 'R');
  // 参数槽位无关：谁 updatedAt 新谁提供 metadata
  assert.equal(merge.mergeArticleByLatest(remote, local).title, 'R');
  const tied = merge.mergeArticleByLatest(baseArticle({ title: 'A' }), baseArticle({ sourceDeviceId: 'devB', title: 'B', updatedAt: 100 }));
  assert.equal(tied.title, 'A', 'updatedAt 平局 → metadata 取 local（与 Kotlin 一致）');
}

// 收藏/稍后看逐字段：changedAt 新者胜，平局比 sourceDeviceId
{
  const local = baseArticle({ favoriteSaved: true, favoriteChangedAt: 50 });
  const remote = baseArticle({ sourceDeviceId: 'devR', favoriteSaved: false, favoriteChangedAt: 80 });
  assert.equal(merge.mergeArticleByLatest(local, remote).favoriteSaved, false, '远端收藏变更更新');
  const remote2 = baseArticle({ sourceDeviceId: 'devR', favoriteSaved: false, favoriteChangedAt: 50 });
  const m2 = merge.mergeArticleByLatest(local, remote2);
  // 平局：sourceDeviceId 大者胜 → devR > devL → 取远端
  assert.equal(m2.favoriteSaved, false, '收藏 changedAt 平局 → sourceDeviceId 决胜');

  const wlLocal = baseArticle({ watchLaterSaved: true, watchLaterChangedAt: 10 });
  const wlRemote = baseArticle({ sourceDeviceId: 'devR', watchLaterSaved: false, watchLaterChangedAt: 5 });
  assert.equal(merge.mergeArticleByLatest(wlLocal, wlRemote).watchLaterSaved, true, '稍后看本地更新');
}

// 阅读位置：contentHash 匹配规则
{
  const local = baseArticle({ contentHash: 'hX', readingProgress: 0.9, readingPositionBytes: 9, readingPositionChangedAt: 100 });
  const remote = baseArticle({ sourceDeviceId: 'devR', contentHash: 'hX', readingProgress: 0.1, readingPositionBytes: 1, readingPositionChangedAt: 50, updatedAt: 200 });
  const m = merge.mergeArticleByLatest(local, remote);
  assert.equal(m.readingProgress, 0.9, '相同 contentHash 且本地 position 更新 → 取本地');
  const remote3 = baseArticle({ sourceDeviceId: 'devR', contentHash: 'hY', readingProgress: 0.5, readingPositionBytes: 5, readingPositionChangedAt: 50, updatedAt: 200, contentHtml: '<p>r</p>', contentText: 'r' });
  const m3 = merge.mergeArticleByLatest(local, remote3);
  // metadata=remote(新)；remoteContentIsSelected（remote.hash==metadata.hash 且 local.hash!=）→ 取远端位置
  assert.equal(m3.readingProgress, 0.5);
}

// 删除保护
{
  // 新墓碑覆盖旧RSS/保存投影；旧投影不是显式重订阅/恢复。
  const local = baseArticle({ rssSourceUrl: 'https://f/rss' });
  const remote = baseArticle({ sourceDeviceId: 'devR', rssSourceUrl: 'https://f/rss', deleted: true, deletedAt: 999, updatedAt: 999 });
  assert.equal(merge.mergeArticleByLatest(local, remote).deleted, true, '较新墓碑不被旧RSS投影复活');
  // 收藏文章：删除保护
  const localFav = baseArticle({ favoriteSaved: true, favoriteChangedAt: 10 });
  assert.equal(merge.mergeArticleByLatest(localFav, remote).deleted, true, '较新墓碑不被旧收藏投影复活');
  assert.equal(merge.mergeArticleByLatest({...localFav,updatedAt:1000,favoriteChangedAt:1000},remote).deleted,false,'较新显式保存仍可恢复');
  assert.equal(merge.mergeArticleByLatest(local,{...remote,updatedAt:50,deletedAt:50}).deleted,false,'旧删除不能覆盖较新RSS');
  // 普通私有文章：远端删除更新 → 删
  const localPriv = baseArticle({ url: 'watchrss://import/x', rssSourceUrl: null });
  const remotePriv = baseArticle({ sourceDeviceId: 'devR', url: 'watchrss://import/x', rssSourceUrl: null, deleted: true, deletedAt: 999, updatedAt: 999 });
  assert.equal(merge.mergeArticleByLatest(localPriv, remotePriv).deleted, true, '私有文章远端删除生效');
}

// isRead LWW：同钟比设备，允许 false
{
  const m = merge.mergeArticleByLatest(baseArticle({ isRead: true }), baseArticle({ sourceDeviceId: 'devR', isRead: false }));
  assert.equal(m.isRead, false);
}

// rssSourceUrl 合并：非空者优先
{
  const m = merge.mergeArticleByLatest(baseArticle({ rssSourceUrl: null }), baseArticle({ sourceDeviceId: 'devR', rssSourceUrl: 'https://f/rss', rssSourceTitle: 'F', updatedAt: 200 }));
  assert.equal(m.rssSourceUrl, 'https://f/rss');
}

// 源合并：updatedAt（平局比 sourceDeviceId）
{
  const localSrc = { url: 'u', sourceDeviceId: 'devL', updatedAt: 100, title: 'L' };
  const remoteSrc = { url: 'u', sourceDeviceId: 'devR', updatedAt: 200, title: 'R' };
  assert.equal(merge.mergeSource(localSrc, remoteSrc).title, 'R');
  assert.equal(merge.mergeSource(remoteSrc, localSrc).title, 'R'); // remote(=L,100) 不比 local(=R,200) 新 → 保留 local
  const tiedRemote = { url: 'u', sourceDeviceId: 'devB', updatedAt: 100, title: 'B' };
  assert.equal(merge.mergeSource(tiedRemote, tiedRemote).title, 'B');
  const localB = { url: 'u', sourceDeviceId: 'devB', updatedAt: 100, title: 'B' };
  const localA = { url: 'u', sourceDeviceId: 'devA', updatedAt: 100, title: 'A' };
  assert.equal(merge.mergeSource(localA, localB).title, 'B', '源 updatedAt 平局 → sourceDeviceId 大者胜');
}

// retainsLocalBody
{
  const local = baseArticle({ contentHtml: '<p>keep</p>', contentText: 'keep' });
  const remote = baseArticle({ sourceDeviceId: 'devR', contentHtml: null, contentText: '', updatedAt: 500 });
  const prepared = merge.prepareRemote(remote, local);
  assert.equal(prepared.contentHtml, '<p>keep</p>', '远端无正文 → 保留本地正文');
  const prepared2 = merge.prepareRemote(baseArticle({ sourceDeviceId: 'devR', contentHtml: '<p>r</p>', contentText: 'r', updatedAt: 500 }), local);
  assert.equal(prepared2.contentHtml, '<p>r</p>', '远端有正文 → 用远端');
}

// import URL 识别
assert.ok(merge.isImportedContentUrl('watchrss://import/a'));
assert.ok(merge.isImportedContentUrl('watchrss-txt://x'));
assert.ok(!merge.isImportedContentUrl('https://x.com/a'));
// 手机端导入内容前缀（ImportedContentIds）
assert.ok(merge.isImportedContentUrl('https://watchrss.local/import-content/txt/abc'));
assert.ok(merge.isImportedContentUrl('https://watchrss.local/import-content/epub/bk/chapter/0001-x'));
assert.ok(merge.isImportedContentUrl('https://watchrss.local/import-epub/book2'));
assert.ok(merge.isImportedContentUrl('https://watchrss.local/import-txt-novel/n1/chapter/0002-y'));
assert.ok(!merge.isImportedContentUrl('https://watchrss.local.evil.com/x'));

console.log('合并测试全部通过');

// Read/unread follows the phone rule, including legacy clocks and exact ties.
for(const [local,remote,expected]of [
 [{isRead:true,readingPositionChangedAt:2},{isRead:false,readingPositionChangedAt:3},false],
 [{isRead:false,readingPositionChangedAt:3},{isRead:true,readingPositionChangedAt:2},false],
 [{isRead:true,updatedAt:2},{isRead:false,updatedAt:3},false],
 [{isRead:true,readingPositionChangedAt:4,sourceDeviceId:'a'},{isRead:false,readingPositionChangedAt:4,sourceDeviceId:'b'},false],
 [{isRead:true,readingPositionChangedAt:4,sourceDeviceId:'same'},{isRead:false,readingPositionChangedAt:4,sourceDeviceId:'same'},false],
]){assert.equal(merge.mergeReadFlag(local,remote),expected);assert.equal(merge.mergeReadFlag(remote,local),expected);}
