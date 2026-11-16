'use strict';
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(':memory:');
db.exec('CREATE TABLE profiles(id INTEGER PRIMARY KEY); INSERT INTO profiles(id) VALUES (1),(2)');
const hide=require('../app/rss-hide-rules').create({db});
const article=(title,publisherHost,url='https://news.google.com/rss/articles/ABCDEF')=>({title,publisherHost,url});
const t='【鳴潮】リリーの評価とおすすめパーティ編成・音骸・武器 - GameWith';
hide.add(1,{domain:'gamewith.jp',titleMode:'contains',titleText:'おすすめパーティ'});
assert.equal(hide.filter(1,[article(t,'gamewith.jp')]).length,0,'AI E2 publisher must match despite Google News URL');
assert.equal(hide.filter(1,[article(t,'sub.gamewith.jp')]).length,0,'publisher subdomain');
assert.equal(hide.filter(1,[article(t,'game8.jp')]).length,1,'different publisher');
assert.equal(hide.filter(1,[article('鳴潮アップデート速報','gamewith.jp')]).length,1,'same publisher, different title');
assert.equal(hide.filter(2,[article(t,'gamewith.jp')]).length,1,'separate profile');
assert.equal(hide.filter(1,[article(t,'', 'https://gamewith.jp/wutheringwaves/580545')]).length,0,'RSS-style direct URL fallback');
assert.equal(hide.filter(1,[article(t,'', 'https://news.google.com/rss/articles/ABCDEF')]).length,1,'unknown publisher does not falsely match');
// Existing RSS SQL filtering is unaffected.
assert.equal(db.prepare('SELECT nestrill_rss_visible(?,?,?) AS value').get(1,t,'https://gamewith.jp/wutheringwaves/580545').value,0);
assert.equal(db.prepare('SELECT nestrill_rss_visible(?,?,?) AS value').get(1,'鳴潮アップデート速報','https://gamewith.jp/').value,1);
// Domain-free rules match E2 and RSS titles alike.
hide.add(1,{domain:'',titleMode:'exact',titleText:'宣伝だけのページ'});
assert.equal(hide.filter(1,[article('宣伝だけのページ','somewhere.example')]).length,0);
assert.equal(hide.filter(1,[article('宣伝だけのページ','gamewith.jp')]).length,0);
// Removing a rule restores visibility without rewriting stored articles.
const rules=hide.list(1).rules;
const domRule=rules.find(x=>x.domain==='gamewith.jp');
hide.remove(1,domRule.id);
assert.equal(hide.filter(1,[article(t,'gamewith.jp')]).length,1);
console.log('PASS: E2 publisher host, title AND domain, other profiles, RSS SQL, fallback, removal');
