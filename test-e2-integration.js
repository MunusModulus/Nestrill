'use strict';
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(':memory:');
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE profiles(id INTEGER PRIMARY KEY,is_secret INTEGER NOT NULL DEFAULT 0);
INSERT INTO profiles VALUES(1,0);
CREATE TABLE feeds(id INTEGER PRIMARY KEY,url TEXT,site_url TEXT);
CREATE TABLE profile_feeds(profile_id INTEGER,feed_id INTEGER);
CREATE TABLE articles(id INTEGER PRIMARY KEY,feed_id INTEGER,url TEXT,title TEXT,excerpt TEXT,published INTEGER);
CREATE TABLE ai_article_open_signals(profile_id INTEGER,kind TEXT,item_id TEXT,title TEXT,open_days INTEGER,last_opened_at INTEGER);
CREATE TABLE youtube_videos_local(video_id TEXT,channel_id TEXT,title TEXT,excerpt TEXT);
CREATE TABLE youtube_subscriptions_local(channel_id TEXT,account_id INTEGER);
CREATE TABLE source_accounts(id INTEGER,profile_id INTEGER,service TEXT);
`);
require('./app/ai-recommend').create({db});
db.prepare('INSERT INTO ai_interest_lists(profile_id,terms_json,updated_at) VALUES(?,?,?)').run(1,JSON.stringify(['AMD','キーボード','トラックボール','ゲーム']),100);
db.prepare('INSERT INTO ai_item_feedback(profile_id,kind,item_id,rating,comment,updated_at) VALUES(?,?,?,?,?,?)').run(1,'rss','x:historical',1,'',Date.now()-3600000);
db.prepare('INSERT INTO ai_external_feedback_meta(profile_id,item_id,title,url,excerpt) VALUES(?,?,?,?,?)').run(1,'x:historical','AMD RX 9060 XTの発売が正式決定','https://news.google.com/articles/older','AMD RX 9060 XTが発売決定',);
const now=new Date().toUTCString();
const escape=x=>x.replaceAll('&','&amp;');
const xml=()=>`<?xml version="1.0"?><rss version="2.0"><channel><title>Search</title><item><title>AMD RX 9060 XTの発売が正式決定 - サイトA</title><link>https://news.google.com/articles/new1</link><description>AMDがRX 9060 XTを発表</description><pubDate>${now}</pubDate><source url="https://publisherA.example.com">サイトA</source></item><item><title>AMD RX 9060 XTの実機レビューと性能評価 - サイトB</title><link>https://news.google.com/articles/new2</link><description>独自のゲームベンチマークを計測</description><pubDate>${now}</pubDate><source url="https://publisherB.example.com">サイトB</source></item></channel></rss>`;
let modelCalls=0;
const semantic={
 planDiscovery:async()=>[],planInferenceQueries:async()=>[],
 compareRatedE2Reports:async({pairs})=>{modelCalls++;return {items:pairs.map(p=>({id:p.id,relation:'different'}))}},
 screenExternalSearch:async({candidates})=>({items:candidates.map(x=>({id:x.id,relation:'direct',why:''}))}),
};
const ext=require('./app/ai-external').create({db,fetchXml:async()=>xml(),semantic});
const job=ext.start(1);assert.equal(job.started,true);
(async()=>{
 for(let n=0;n<100;n++){
  await new Promise(r=>setTimeout(r,15));
  const s=ext.status(1);if(!s.running){
   assert.equal(s.error,'',JSON.stringify(s));
   const titles=s.items.map(x=>x.title);
   assert.equal(titles.length,1,JSON.stringify(titles));
   assert.match(titles[0],/レビュー/);
   assert.equal(s.qualityStats.ratedHistoryRepeats.exactTitle,1);
   assert.equal(db.prepare('SELECT COUNT(*) AS c FROM ai_item_feedback').get().c,1,'ratings preserved');
   assert.ok(s.qualityStats.queryAudit.length>=4);
   console.log('PASS: integrated E2 search and rated external duplicate suppression; feedback untouched');
   return;
  }
 }
 throw Error('job never finished');
})().catch(e=>{console.error(e);process.exitCode=1});
