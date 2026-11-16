'use strict';
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(':memory:');
db.exec(`CREATE TABLE profiles(id INTEGER PRIMARY KEY);
INSERT INTO profiles(id) VALUES(1),(2);
CREATE TABLE rss_article_hide_rules(
 id INTEGER PRIMARY KEY,profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
 domain TEXT NOT NULL DEFAULT '',
 title_mode TEXT NOT NULL CHECK(title_mode IN ('all','contains','exact')),
 title_text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);`);
// Migrate the real legacy schema: the existing saved rows must survive.
db.prepare(`INSERT INTO rss_article_hide_rules(profile_id,domain,title_mode,title_text,created_at) VALUES(?,?,?,?,?)`)
 .run(1,'gamewith.jp','contains','関連記事',123);
const hide=require('../app/rss-hide-rules').create({db});
assert.equal(hide.list(1).rules[0].titleText2,'');
assert.ok(db.prepare(`PRAGMA table_info(rss_article_hide_rules)`).all().some(r=>r.name==='title_text2'));
const title='【鳴潮】リリーの評価とおすすめパーティ編成・音骸・武器 - GameWith';
const a=t=>({title:t,url:'https://news.google.com/rss/articles/abc',publisherHost:'gamewith.jp'});
const x=hide.add(1,{domain:'',titleMode:'contains',titleText:'【鳴潮】',titleText2:' - GameWith'});
assert.equal(x.rules[0].titleText2,' - GameWith');
assert.equal(hide.filter(1,[a(title)]).length,0,'both terms must hide');
assert.equal(hide.filter(1,[a('【鳴潮】新着アップデート')]).length,1,'first term alone stays');
assert.equal(hide.filter(1,[a('原神 ニュース - GameWith')]).length,1,'second term alone stays');
assert.equal(hide.filter(1,[a('【鳴潮】 - GAMEWITH')]).length,0,'case insensitive');
assert.equal(hide.filter(1,[a('【鳴潮】- GAMEWITH')]).length,1,'require exact leading space');
assert.equal(hide.filter(2,[a(title)]).length,1,'profile separation');
assert.equal(hide.filter(1,[{...a(title),publisherHost:'another.example'}]).length,0,'domain-free title match');
const d=hide.add(1,{domain:'gamewith.jp',titleMode:'contains',titleText:'【鳴潮】',titleText2:'GameWith'});
assert.equal(hide.filter(1,[{...a(title),publisherHost:'another.example'}]).length,0,'domain-free rule stays active');
assert.throws(()=>hide.add(1,{domain:'',titleMode:'exact',titleText:title,titleText2:'GameWith'}));
assert.throws(()=>hide.add(1,{domain:'',titleMode:'contains',titleText:'鳴潮',titleText2:'鳴潮'}));
assert.throws(()=>hide.add(1,{domain:'',titleMode:'contains',titleText:'鳴潮',titleText2:'foo\nbar'}));
assert.equal(hide.list(1).rules[0].titleText2,'GameWith');
hide.remove(1,d.id);
hide.remove(1,x.id);
assert.equal(hide.filter(1,[a(title)]).length,1,'revert to visible without deleting articles');
assert.equal(hide.filter(1,[a('関連記事')]).length,0,'legacy rule survives');
assert.equal(db.prepare(`SELECT nestrill_rss_visible(?,?,?) AS v`).get(1,title,'https://elsewhere.example/a').v,1,'SQL RSS unchanged');
console.log('PASS: additive schema migration, AND title rule, legacy, E2 Google News, profiles, rollback');
