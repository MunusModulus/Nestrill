'use strict';
// User-controlled SOURCE QUALITY feedback, deliberately independent from
// AI interest ratings. Only exact user-confirmed publisher hosts are blocked.
// No network request and no assumption that RSS publisher metadata is verified.
const {hostOf}=require('./ai-source-quality');
function create({db}){
 db.exec(`CREATE TABLE IF NOT EXISTS ai_article_quality_reports(
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('dead_link','low_quality')),
  title TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(profile_id,item_key));
 CREATE TABLE IF NOT EXISTS ai_blocked_sources(
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  host TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(profile_id,host));`);
 // Existing rows retain their legacy type; new reports also preserve all reasons.
 if(!db.prepare('PRAGMA table_info(ai_article_quality_reports)').all().some(c=>c.name==='reasons_json')){
  db.exec("ALTER TABLE ai_article_quality_reports ADD COLUMN reasons_json TEXT NOT NULL DEFAULT '[]'");
 }
 const REPORT_REASONS=['dead_link','low_quality','content_mismatch'];
 function reasonsOf(row){
  if(!row)return [];
  let arr=[];
  try{arr=JSON.parse(row.reasons_json||'[]')}catch{}
  if(!Array.isArray(arr))arr=[];
  const clean=REPORT_REASONS.filter(key=>arr.includes(key));
  return clean.length?clean:(REPORT_REASONS.includes(row.type)?[row.type]:[]);
 }
 const normalizeHost=value=>{
  const host=String(value||'').toLowerCase().replace(/^www\./,'').replace(/\.$/,'');
  return hostOf('https://'+host)===host?host:'';
 };
 // Existing ai_blocked_sources.host entries remain valid host-only rules.
 // New entries may contain a directory prefix, e.g. example.com/sub1/.
 // Do not accept query/fragment rules or guess a publisher URL from Google RSS.
 function normalizeRule(value){
  const raw=String(value||'').trim();
  if(!raw||raw.length>480||/[\\\s?#]/u.test(raw))return '';
  const explicit=/^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if(explicit&&!/^https?:\/\//i.test(raw))return '';
  if(!explicit&&raw.includes('://'))return '';
  const authority=(explicit?raw.replace(/^https?:\/\//i,''):raw).split('/')[0];
  if(!authority||authority.includes('@')||authority.includes(':'))return '';
  const pathRaw=(explicit?raw.replace(/^https?:\/\//i,''):raw).slice(authority.length);
  if(/(?:^|\/)(?:\.{1,2}|%2e(?:%2e|\.)?)(?:\/|$)/i.test(pathRaw)||/%(?:2f|5c|00)/i.test(pathRaw))return '';
  let url;
  try{url=new URL(explicit?raw:'https://'+raw)}catch{return ''}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port||url.search||url.hash)return '';
  const host=normalizeHost(url.hostname);
  if(!host)return '';
  const path=url.pathname;
  if(!path||path==='/')return host;
  return host+(path.endsWith('/')?path:path+'/');
 }
 function pathOf(url,expectedHost){
  try{
   const u=new URL(String(url||''));
   if(!['https:','http:'].includes(u.protocol)||u.username||u.password||normalizeHost(u.hostname)!==expectedHost)return '';
   return u.pathname.replace(/%[0-9a-f]{2}/gi,s=>s.toUpperCase());
  }catch{return ''}
 }
 function matchRules(rules,host,url){
  if(!host)return false;
  const path=pathOf(url,host);
  return rules.some(rule=>{
   if(rule===host)return true;
   if(!rule.startsWith(host+'/'))return false;
   // A URL without a confirmed matching publisher host/path MUST NOT be
   // treated as a directory match (e.g. news.google.com redirect URLs).
   if(!path)return false;
   const prefix=rule.slice(host.length).replace(/%[0-9a-f]{2}/gi,s=>s.toUpperCase());
   return path.startsWith(prefix)||path===prefix.slice(0,-1);
  });
 }
 function blockedRules(pid){
  return db.prepare('SELECT host FROM ai_blocked_sources WHERE profile_id=?').all(pid).map(x=>x.host);
 }
 function resolve(pid,itemId){
  const id=String(itemId||'');
  if(/^x:[a-f0-9]{32}$/.test(id)){
   const x=db.prepare(`SELECT title,publisher_host AS host,url AS sourceUrl FROM ai_external_articles
     WHERE profile_id=? AND id=?`).get(pid,id.slice(2));
   if(x)return {key:id,title:x.title,host:normalizeHost(x.host),sourceUrl:x.sourceUrl,unverified:true};
   // Persisted recommendations may outlive the transient external search cache.
   const r=db.prepare(`SELECT items_json FROM ai_blend_cache WHERE profile_id=? AND kind='rss'`).get(pid);
   if(r){try{
    const item=JSON.parse(r.items_json).find(x=>x.id===id&&x.origin==='external');
    if(item)return {key:id,title:String(item.title||''),host:normalizeHost(item.publisherHost),sourceUrl:item.url||'',unverified:true};
   }catch{}}
   return null;
  }
  if(!/^(?:r:)?[1-9]\d{0,15}$/.test(id))return null;
  const n=Number(id.replace(/^r:/,''));
  const r=db.prepare(`SELECT a.title,a.url, f.site_url AS siteUrl,f.url AS feedUrl
    FROM articles a JOIN profile_feeds pf ON pf.feed_id=a.feed_id AND pf.profile_id=?
    JOIN feeds f ON f.id=a.feed_id WHERE a.id=? LIMIT 1`).get(pid,n);
  if(!r)return null;
  return {key:'r:'+n,title:r.title,host:normalizeHost(hostOf(r.url)||hostOf(r.siteUrl)||hostOf(r.feedUrl)),sourceUrl:r.url,unverified:false};
 }
 function report(pid,x){
  if(!x||typeof x!=='object'||Array.isArray(x))throw Error('報告形式が不正です');
  const action=String(x.action||'');
  if(action==='unblock'){
   const host=normalizeRule(x.host);
   if(!host)throw Error('情報源が不正です');
   const r=db.prepare('DELETE FROM ai_blocked_sources WHERE profile_id=? AND host=?').run(pid,host);
   if(!r.changes)throw Error('このプロファイルで除外されていない情報源です');
   return {ok:true,action,host};
  }
  if(action==='add_source'){
   const host=normalizeRule(x.host);
   if(!host)throw Error('正しいドメインまたはURLパスを入力してください（例：example.com/sub1/）');
   if(db.prepare('SELECT 1 FROM ai_blocked_sources WHERE profile_id=? AND host=?').get(pid,host))
    throw Error('この除外対象は既に登録されています');
   const count=db.prepare('SELECT COUNT(*) AS count FROM ai_blocked_sources WHERE profile_id=?').get(pid).count;
   if(count>=500)throw Error('除外サイト・URLパスは500件が上限です');
   db.prepare('INSERT INTO ai_blocked_sources(profile_id,host,updated_at) VALUES(?,?,?)').run(pid,host,Date.now());
   return {ok:true,action,host};
  }
  if(action==='rename_source'){
   const host=normalizeRule(x.host),newHost=normalizeRule(x.newHost);
   if(!host||!newHost)throw Error('変更前と変更後に正しいドメインまたはURLパスを指定してください');
   const existing=db.prepare('SELECT 1 FROM ai_blocked_sources WHERE profile_id=? AND host=?').get(pid,host);
   if(!existing)throw Error('このプロファイルに変更対象の除外設定がありません');
   if(host===newHost)return {ok:true,action,host:newHost,unchanged:true};
   if(db.prepare('SELECT 1 FROM ai_blocked_sources WHERE profile_id=? AND host=?').get(pid,newHost))
    throw Error('変更先の除外対象は既に登録されています');
   // SQLite UPDATE is atomic: a unique-key conflict leaves the original intact.
   const changed=db.prepare('UPDATE ai_blocked_sources SET host=?,updated_at=? WHERE profile_id=? AND host=?')
    .run(newHost,Date.now(),pid,host);
   if(changed.changes!==1)throw Error('変更対象が見つかりませんでした');
   return {ok:true,action,host:newHost,previousHost:host};
  }
  // Report reasons can be corrected from Settings even when the original
  // externally discovered article has expired. Updates require an EXISTING
  // profile-owned report and never create a new report or modify interest data.
  if(action==='update_report'){
   const id=String(x.itemId||'');
   if(!/^(?:x:[a-f0-9]{32}|r:[1-9]\d{0,15})$/.test(id))throw Error('対象IDが不正です');
   const reasons=Array.isArray(x.types)?x.types:null;
   if(!reasons||!reasons.length||reasons.length>REPORT_REASONS.length||
      new Set(reasons).size!==reasons.length||
      !reasons.every(reason=>REPORT_REASONS.includes(reason)))throw Error('報告理由を1件以上選択してください');
   const existing=db.prepare('SELECT 1 FROM ai_article_quality_reports WHERE profile_id=? AND item_key=?').get(pid,id);
   if(!existing)throw Error('このプロファイルに変更対象の記事報告がありません');
   const legacy=reasons.includes('dead_link')?'dead_link':'low_quality';
   const result=db.prepare('UPDATE ai_article_quality_reports SET type=?,reasons_json=?,updated_at=? WHERE profile_id=? AND item_key=?')
    .run(legacy,JSON.stringify(reasons),Date.now(),pid,id);
   if(result.changes!==1)throw Error('報告理由の更新に失敗しました');
   return {ok:true,action,itemKey:id,types:reasons};
  }
  // Article reports may hide their own item. Allow undo from Settings even
  // after a transient external RSS result expires, but only if this profile
  // owns the saved report already.
  if(action==='clear'){
   const id=String(x.itemId||'');
   if(!/^(?:x:[a-f0-9]{32}|r:[1-9]\d{0,15})$/.test(id))throw Error('対象IDが不正です');
   const changed=db.prepare('DELETE FROM ai_article_quality_reports WHERE profile_id=? AND item_key=?').run(pid,id);
   if(!changed.changes)throw Error('このプロファイルには該当する記事報告がありません');
   return {ok:true,action,itemKey:id};
  }
  const item=resolve(pid,x.itemId);
  if(!item)throw Error('このプロファイルに存在する記事を指定してください');
  const now=Date.now();
  if(action==='flag'){
   const reasons=Array.isArray(x.types)?x.types:(typeof x.type==='string'?[x.type]:null);
   if(!reasons||!reasons.length||reasons.length>REPORT_REASONS.length||
      new Set(reasons).size!==reasons.length||
      !reasons.every(reason=>REPORT_REASONS.includes(reason)))throw Error('報告理由を1件以上選択してください');
   // Keep the legacy CHECK-constrained type for existing rows, but store every reason.
   const legacy=reasons.includes('dead_link')?'dead_link':'low_quality';
   db.prepare(`INSERT INTO ai_article_quality_reports(profile_id,item_key,type,reasons_json,title,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(profile_id,item_key) DO UPDATE SET
    type=excluded.type,reasons_json=excluded.reasons_json,title=excluded.title,updated_at=excluded.updated_at`)
    .run(pid,item.key,legacy,JSON.stringify(reasons),item.title.slice(0,350),now);
  }else if(action==='block'){
   if(!item.host)throw Error('出典ドメインが不明なため、情報源全体は除外できません');
   if(x.confirmHost!==item.host)throw Error('情報源の確認が一致しません');
   db.prepare(`INSERT INTO ai_blocked_sources(profile_id,host,updated_at) VALUES(?,?,?)
    ON CONFLICT(profile_id,host) DO UPDATE SET updated_at=excluded.updated_at`).run(pid,item.host,now);
  }else throw Error('操作が不正です');
  return {ok:true,action,host:item.host,itemKey:item.key};
 }
 function detail(pid,itemId){
  const item=resolve(pid,itemId);if(!item)throw Error('このプロファイルの記事ではありません');
  const r=db.prepare('SELECT type,reasons_json,updated_at FROM ai_article_quality_reports WHERE profile_id=? AND item_key=?').get(pid,item.key);
  const reasons=reasonsOf(r);
  const b=matchRules(blockedRules(pid),item.host,item.sourceUrl);
  const {sourceUrl,...publicItem}=item;
  return {...publicItem,reported:reasons[0]||'',reportedTypes:reasons,reportedAt:r?.updated_at||0,blocked:b};
 }
 function list(pid){
  return {blocked:db.prepare('SELECT host,updated_at FROM ai_blocked_sources WHERE profile_id=? ORDER BY host').all(pid),
   reports:db.prepare(`SELECT item_key AS itemKey,type,reasons_json,title,updated_at AS updatedAt FROM ai_article_quality_reports
    WHERE profile_id=? ORDER BY updated_at DESC LIMIT 250`).all(pid).map(r=>({
     itemKey:r.itemKey,type:r.type,types:reasonsOf(r),title:r.title,updatedAt:r.updatedAt
    }))};
 }
 function filter(pid,items,{externalPreview=false}={}){
  if(!Array.isArray(items)||!items.length)return [];
  const blocked=blockedRules(pid);
  const reported=new Set(db.prepare('SELECT item_key FROM ai_article_quality_reports WHERE profile_id=?').all(pid).map(x=>x.item_key));
  return items.filter(x=>{
   const ext=externalPreview||x.origin==='external'||String(x.id||'').startsWith('x:');
   const key=ext?('x:'+String(x.id||'').replace(/^x:/,'')):'r:'+String(x.id||'').replace(/^r:/,'');
   if(reported.has(key))return false;
   const host=ext?normalizeHost(x.publisherHost):normalizeHost(hostOf(x.url));
   return !matchRules(blocked,host,x.url);
  });
 }
 return {resolve,report,detail,list,filter};
}
module.exports={create};
