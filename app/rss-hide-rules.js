'use strict';
// Fix91A: RSS list/recommendation display-only rules. Never delete article rows.
function create({db}){
 db.exec(`CREATE TABLE IF NOT EXISTS rss_article_hide_rules(
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  domain TEXT NOT NULL DEFAULT '',
  title_mode TEXT NOT NULL CHECK(title_mode IN ('all','contains','exact')),
  title_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_rss_hide_profile ON rss_article_hide_rules(profile_id,id);`);
 const profiles=new Map();
 const norm=x=>String(x||'').normalize('NFKC').toLocaleLowerCase().trim();
 const host=value=>{try{const u=new URL(String(value||''));if(!['http:','https:'].includes(u.protocol))return '';return u.hostname.toLowerCase().replace(/^www\./,'').replace(/\.$/,'')}catch{return ''}};
 const getRows=pid=>db.prepare('SELECT id,domain,title_mode AS titleMode,title_text AS titleText,created_at AS createdAt FROM rss_article_hide_rules WHERE profile_id=? ORDER BY id DESC').all(pid);
 const getCompiled=pid=>{
  if(!profiles.has(pid))profiles.set(pid,getRows(pid).map(x=>({...x,needle:norm(x.titleText)})));
  return profiles.get(pid);
 };
 const visible=(pid,title,url)=>{
  const rules=getCompiled(Number(pid));if(!rules.length)return true;
  const txt=norm(title);let h=null;
  for(const r of rules){
   if(r.domain){if(h===null)h=host(url);if(!h||(h!==r.domain&&!h.endsWith('.'+r.domain)))continue}
   if(r.titleMode==='all'||r.titleMode==='exact'&&txt===r.needle||r.titleMode==='contains'&&txt.includes(r.needle))return false;
  }
  return true;
 };
 db.function('nestrill_rss_visible',(pid,title,url)=>visible(pid,title,url)?1:0);
 const filter=(pid,items)=>Array.isArray(items)?items.filter(x=>visible(pid,x.title,x.url)):[];
 const list=pid=>({rules:getRows(pid)});
 function domainValue(value){
  if(value==null||value==='')return '';
  if(typeof value!=='string'||value.length>253||value!==value.trim()||/[\s/?#@:%]/.test(value))throw Error('ドメインは example.com の形式で指定してください');
  const u=host('https://'+value);
  if(!u||u!==value.toLowerCase().replace(/^www\./,'')||!u.includes('.')||!u.split('.').every(x=>x.length>0&&x.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x)))throw Error('ドメインが不正です');
  return u;
 }
 function add(pid,x){
  if(!x||typeof x!=='object'||Array.isArray(x))throw Error('ルール形式が不正です');
  const domain=domainValue(x.domain),titleMode=String(x.titleMode||'');
  if(!['all','contains','exact'].includes(titleMode))throw Error('タイトル条件が不正です');
  if(typeof x.titleText!=='string'||x.titleText.length>160)throw Error('タイトル条件は160文字以内です');
  const titleText=x.titleText.trim();
  if(titleMode==='all'&&titleText)throw Error('全記事を対象とする場合はタイトルを空欄にしてください');
  if(titleMode!=='all'&&!titleText)throw Error('タイトルの語句を入力してください');
  if(!domain&&titleMode==='all')throw Error('全サイトの全記事は非表示にできません');
  if(titleText.length>120||/[\x00-\x1f\x7f]/.test(titleText))throw Error('タイトル条件は120文字以内で入力してください');
  const rows=getRows(pid);if(rows.length>=100)throw Error('非表示ルールは100件までです');
  if(rows.some(r=>r.domain===domain&&r.titleMode===titleMode&&norm(r.titleText)===norm(titleText)))throw Error('同じルールが登録されています');
  const result=db.prepare('INSERT INTO rss_article_hide_rules(profile_id,domain,title_mode,title_text,created_at) VALUES(?,?,?,?,?)').run(pid,domain,titleMode,titleText,Date.now());
  profiles.delete(pid);return {ok:true,id:Number(result.lastInsertRowid),...list(pid)};
 }
 function remove(pid,id){
  if(!Number.isSafeInteger(id)||id<1)throw Error('ルールIDが不正です');
  const r=db.prepare('DELETE FROM rss_article_hide_rules WHERE profile_id=? AND id=?').run(pid,id);
  if(!r.changes)throw Error('このプロファイルにはルールがありません');
  profiles.delete(pid);return {ok:true,...list(pid)};
 }
 return {list,add,remove,filter,visible};
}
module.exports={create};
