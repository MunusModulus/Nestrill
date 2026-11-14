'use strict';
// Nestrill-Next UI05: portable *registration configuration*, never a SQLite/database dump.
// A public-mode export never queries the hidden profile; a secret-mode export never
// enumerates public profiles. No media, articles, cookies, sessions or AI cache.
const {randomBytes}=require('node:crypto');
const FORMAT='nestrill-next-registration-config';
const channel=/^UC[A-Za-z0-9_-]{22}$/;
const LIMITS={profiles:50,categories:500,feeds:8000,groups:500,channels:8000,bytes:5_000_000};
function create({db,secretId,validHttpUrl}){
 const tickets=new Map();
 function exportConfig(secret){
  const rows=secret?db.prepare('SELECT id,name FROM profiles WHERE id=? AND is_secret=1').all(secretId):db.prepare('SELECT id,name FROM profiles WHERE is_secret=0 ORDER BY id').all();
  const profiles=rows.map(p=>{
   const cats=db.prepare('SELECT category_id AS id,name,display_mode AS displayMode FROM profile_category_settings WHERE profile_id=? ORDER BY sort_order,category_id').all(p.id);
   const readFeeds=db.prepare(`SELECT f.url,f.title,f.site_url AS siteUrl,pf.display_title AS displayTitle
    FROM profile_feeds pf JOIN feeds f ON f.id=pf.feed_id WHERE pf.profile_id=? AND pf.category_id=? ORDER BY pf.sort_order,pf.feed_id`);
   const groups=db.prepare("SELECT id,label FROM source_accounts WHERE profile_id=? AND service='youtube' ORDER BY sort_order,id").all(p.id).map(a=>{
    const channels=db.prepare('SELECT channel_id AS channelId,title,custom_title AS customTitle,origin FROM youtube_subscriptions_local WHERE account_id=? ORDER BY title,channel_id').all(a.id);
    const exclusions=db.prepare('SELECT channel_id AS channelId FROM youtube_exclusions_local WHERE account_id=? ORDER BY channel_id').all(a.id).map(r=>r.channelId);
    const refreshMode=db.prepare('SELECT refresh_mode AS mode FROM youtube_refresh_local WHERE account_id=?').get(a.id)?.mode||'auto';
    return {label:a.label,refreshMode,channels,exclusions};
   });
   return {name:secret?'シークレット':p.name,categories:cats.map(c=>({name:c.name,displayMode:c.displayMode,feeds:readFeeds.all(p.id,c.id)})),youtubeGroups:groups};
  });
  return {format:FORMAT,version:1,scope:secret?'secret':'regular',exportedAt:new Date().toISOString(),contents:'registration-only',profiles};
 }
 function requireText(s,n,max){if(typeof s!=='string'||!s.trim()||s.length>max||/[\x00-\x1f]/.test(s))throw Error(n+'が不正です');return s.trim()}
 function optText(s,n,max){if(typeof s!=='string'||s.length>max||/[\x00-\x08\x0b\x0e-\x1f]/.test(s))throw Error(n+'が不正です');return s}
 function check(b,secret){
  if(!b||typeof b!=='object'||Array.isArray(b)||b.format!==FORMAT||b.version!==1||b.contents!=='registration-only')throw Error('対応するNestrill登録構成ファイルではありません');
  const scope=secret?'secret':'regular';
  if(b.scope!==scope)throw Error(secret?'通常用バックアップはシークレットに取り込めません':'シークレット用バックアップは通常モードで取り込めません');
  if(!Array.isArray(b.profiles)||!b.profiles.length||b.profiles.length>(secret?1:LIMITS.profiles))throw Error('プロファイル構成が不正です');
  let cats=0,feeds=0,groups=0,channels=0,exclusions=0;
  for(const p of b.profiles){
   if(secret){if(p.name!=='シークレット')throw Error('シークレット用の構成ではありません')}
   else requireText(p.name,'プロファイル名',80);
   if(!Array.isArray(p.categories)||!Array.isArray(p.youtubeGroups))throw Error('登録構成が不正です');
   const catNames=new Set(),grpNames=new Set(),feedURLs=new Set();
   for(const c of p.categories){
    requireText(c.name,'カテゴリ名',80);if(catNames.has(c.name))throw Error('カテゴリが重複しています');catNames.add(c.name);
    if(!['list','magazine'].includes(c.displayMode))throw Error('カテゴリの表示形式が不正です');
    if(!Array.isArray(c.feeds))throw Error('RSS一覧が不正です');cats++;
    for(const f of c.feeds){
     if(!f||typeof f!=='object')throw Error('RSS項目が不正です');
     const url=validHttpUrl(requireText(f.url,'RSS URL',2000));
     if(feedURLs.has(url))throw Error('RSSが同一プロファイル内で重複しています');feedURLs.add(url);
     requireText(f.title,'RSSタイトル',300);optText(f.siteUrl,'サイトURL',2000);optText(f.displayTitle,'表示名',300);feeds++;
    }
   }
   for(const g of p.youtubeGroups){
    requireText(g.label,'YouTubeグループ名',80);if(grpNames.has(g.label))throw Error('YouTubeグループが重複しています');grpNames.add(g.label);
    if(!['auto','manual'].includes(g.refreshMode)||!Array.isArray(g.channels)||!Array.isArray(g.exclusions))throw Error('YouTube登録構成が不正です');
    const ids=new Set(),excluded=new Set();groups++;
    for(const ch of g.channels){
     if(!ch||!channel.test(ch.channelId)||ids.has(ch.channelId)||!['csv','manual'].includes(ch.origin))throw Error('YouTubeチャンネルID等が不正です');
     ids.add(ch.channelId);requireText(ch.title,'チャンネル名',200);optText(ch.customTitle,'チャンネル表示名',200);channels++;
    }
    for(const id of g.exclusions){if(!channel.test(id)||excluded.has(id))throw Error('YouTube除外リストが不正です');excluded.add(id);exclusions++}
   }
  }
  if(cats>LIMITS.categories||feeds>LIMITS.feeds||groups>LIMITS.groups||channels>LIMITS.channels||exclusions>LIMITS.channels)throw Error('登録構成の件数が上限を超えています');
  return {profiles:b.profiles.length,categories:cats,feeds,groups,channels,exclusions,scope};
 }
 function preview(b,secret,profileId,token){
  const serialized=JSON.stringify(b);
  if(Buffer.byteLength(serialized,'utf8')>LIMITS.bytes)throw Error('構成ファイルが大きすぎます（上限5MB）');
  const summary=check(b,secret),ticket=randomBytes(24).toString('hex');
  const now=Date.now();for(const [key,item] of tickets)if(item.expires<now)tickets.delete(key);
  if(tickets.size>12)tickets.clear();
  tickets.set(ticket,{b,summary,secret,profileId,token:secret?token:'',expires:now+3*60*1000});
  return {...summary,ticket,mode:secret?'シークレットへ追加':'通常プロファイルを新規作成'};
 }
 function unique(base,has){
  const original=base.slice(0,80);if(!has(original))return original;
  for(let i=1;i<1000;i++){
   const suffix=i===1?' (復元)':` (復元 ${i})`;
   const candidate=original.slice(0,80-suffix.length)+suffix;
   if(!has(candidate))return candidate;
  }
  throw Error('名称の重複が多すぎます');
 }
 function restore(ticket,secret,profileId,token){
  const item=tickets.get(ticket);tickets.delete(ticket);
  if(!item||item.expires<Date.now()||item.secret!==secret||item.profileId!==profileId||(secret&&item.token!==token))throw Error('確認期限切れまたはプロファイル変更のため、もう一度ファイルを選択してください');
  check(item.b,secret);const ts=Date.now();
  const profExists=db.prepare('SELECT 1 FROM profiles WHERE name=?');
  const catExists=db.prepare('SELECT category_id AS id FROM profile_category_settings WHERE profile_id=? AND name=?');
  const grpExists=db.prepare("SELECT id FROM source_accounts WHERE profile_id=? AND service='youtube' AND label=?");
  const findFeed=db.prepare('SELECT id FROM feeds WHERE url=?');
  const addFeed=db.prepare('INSERT INTO feeds(url,title,site_url,category_id,created) VALUES(?,?,?,?,?)');
  const addCat=db.prepare('INSERT INTO categories(name,display_mode,sort_order) VALUES(?,?,?)');
  const bindCat=db.prepare('INSERT INTO profile_categories(profile_id,category_id) VALUES(?,?)');
  const setCat=db.prepare('INSERT INTO profile_category_settings(profile_id,category_id,name,display_mode,sort_order) VALUES(?,?,?,?,?)');
  const setFeed=db.prepare('INSERT INTO profile_feeds(profile_id,feed_id,category_id,display_title,sort_order) VALUES(?,?,?,?,?)');
  const hasFeed=db.prepare('SELECT 1 FROM profile_feeds WHERE profile_id=? AND feed_id=?');
  const addGroup=db.prepare("INSERT INTO source_accounts(profile_id,service,label,created,updated,sort_order) VALUES(?,'youtube',?,?,?,?)");
  const addCh=db.prepare('INSERT OR IGNORE INTO youtube_subscriptions_local(account_id,channel_id,title,custom_title,origin) VALUES(?,?,?,?,?)');
  const addExclude=db.prepare('INSERT OR IGNORE INTO youtube_exclusions_local(account_id,channel_id,created) VALUES(?,?,?)');
  const addRefresh=db.prepare('INSERT INTO youtube_refresh_local(account_id,refresh_mode) VALUES(?,?)');
  const result={profiles:0,categories:0,feeds:0,groups:0,channels:0,exclusions:0,skippedFeeds:0};
  db.exec('BEGIN');try{
   for(const p of item.b.profiles){
    let pid;
    if(secret)pid=secretId;
    else{
     const name=unique(p.name,n=>!!profExists.get(n));
     pid=Number(db.prepare('INSERT INTO profiles(name,created,is_secret) VALUES(?,?,0)').run(name,ts).lastInsertRowid);result.profiles++;
    }
    let cOrder=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) AS n FROM profile_category_settings WHERE profile_id=?').get(pid).n);
    for(const c of p.categories){
     let existing=secret?catExists.get(pid,c.name):null;
     let cid,fOrder;
     if(existing){cid=existing.id;fOrder=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) AS n FROM profile_feeds WHERE profile_id=? AND category_id=?').get(pid,cid).n)}
     else{
      const label=c.name;
      if(!secret && label==='未分類')cid=db.prepare("SELECT id FROM categories WHERE name='未分類'").get().id;
      else{
       const key='__nestrill_config_import_'+randomBytes(16).toString('hex');
       cid=Number(addCat.run(key,c.displayMode,0).lastInsertRowid);
       if(secret)db.prepare('INSERT INTO secret_category_names(category_id,name) VALUES(?,?)').run(cid,label);
      }
      bindCat.run(pid,cid);setCat.run(pid,cid,label,c.displayMode,++cOrder);result.categories++;
      fOrder=0;
     }
     for(const f of c.feeds){
      let fid=findFeed.get(f.url)?.id;
      if(!fid)fid=Number(addFeed.run(f.url,f.title,f.siteUrl,cid,ts).lastInsertRowid);
      if(hasFeed.get(pid,fid)){result.skippedFeeds++;continue}
      setFeed.run(pid,fid,cid,f.displayTitle,++fOrder);result.feeds++;
     }
    }
    let gOrder=Number(db.prepare("SELECT COALESCE(MAX(sort_order),0) AS n FROM source_accounts WHERE profile_id=? AND service='youtube'").get(pid).n);
    for(const g of p.youtubeGroups){
     let aid=secret?grpExists.get(pid,g.label)?.id:null;
     if(!aid){aid=Number(addGroup.run(pid,g.label,ts,ts,++gOrder).lastInsertRowid);result.groups++;addRefresh.run(aid,g.refreshMode)}
     for(const ch of g.channels)result.channels+=addCh.run(aid,ch.channelId,ch.title,ch.customTitle,ch.origin).changes;
     for(const id of g.exclusions)result.exclusions+=addExclude.run(aid,id,ts).changes;
    }
   }
   db.exec('COMMIT');return result;
  }catch(e){db.exec('ROLLBACK');throw e}
 }
 return {exportConfig,preview,restore};
}
module.exports={create};
