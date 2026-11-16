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
 // Additive schema update: keep all existing rules and allow old app versions to read them.
 if(!db.prepare('PRAGMA table_info(rss_article_hide_rules)').all().some(c=>c.name==='title_text2'))
  db.exec("ALTER TABLE rss_article_hide_rules ADD COLUMN title_text2 TEXT NOT NULL DEFAULT ''");
 // Existing RC08 two-term rows are preserved as AND rules.
 if(!db.prepare('PRAGMA table_info(rss_article_hide_rules)').all().some(c=>c.name==='title_operator'))
  db.exec("ALTER TABLE rss_article_hide_rules ADD COLUMN title_operator TEXT NOT NULL DEFAULT 'and'");
 const profiles=new Map();
 const norm=x=>String(x||'').normalize('NFKC').toLocaleLowerCase().trim();
 const normPhrase=x=>String(x||'').normalize('NFKC').toLocaleLowerCase();
 const host=value=>{try{const u=new URL(String(value||''));if(!['http:','https:'].includes(u.protocol))return '';return u.hostname.toLowerCase().replace(/^www\./,'').replace(/\.$/,'')}catch{return ''}};
 // Historical rules are host-only. New `domain` values may include a path
 // prefix, without requiring a schema change or modifying saved records.
 const getRows=pid=>db.prepare('SELECT id,domain,title_mode AS titleMode,title_text AS titleText,title_text2 AS titleText2,title_operator AS titleOperator,created_at AS createdAt FROM rss_article_hide_rules WHERE profile_id=? ORDER BY id DESC').all(pid);
 const normalizeEscapes=s=>s.replace(/%[0-9a-f]{2}/gi,v=>v.toUpperCase());
 const pathOf=(url,expectedHost)=>{try{
  const u=new URL(String(url||''));
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||host(u.href)!==expectedHost)return '';
  return normalizeEscapes(u.pathname);
 }catch{return ''}};
 const matchesScope=(scope,articleHost,articleUrl)=>{
  const slash=scope.indexOf('/');
  const ruleHost=slash<0?scope:scope.slice(0,slash);
  if(!articleHost||(articleHost!==ruleHost&&!articleHost.endsWith('.'+ruleHost)))return false;
  if(slash<0)return true;
  // Publisher hostname by itself is insufficient evidence of a URL directory.
  // Google News wrappers must not be assumed to have the publisher's path.
  const path=pathOf(articleUrl,articleHost);
  if(!path)return false;
  const prefix=scope.slice(slash);
  return path.startsWith(prefix)||path===prefix.slice(0,-1);
 };
 const getCompiled=pid=>{
  if(!profiles.has(pid))profiles.set(pid,getRows(pid).map(x=>({...x,needle:norm(x.titleText),containsNeedle:normPhrase(x.titleText),needle2:normPhrase(x.titleText2)})));
  return profiles.get(pid);
 };
 // For AI E2, the article link often points to Google News. Prefer the
 // verified publisher host supplied with the candidate for domain rules.
 // Ordinary RSS articles and SQL callers still use the original article URL.
 const visible=(pid,title,url,publisherHost='')=>{
  const rules=getCompiled(Number(pid));if(!rules.length)return true;
  const txt=norm(title);let h=null;
  for(const r of rules){
   if(r.domain){
    if(h===null){
     const publisher=String(publisherHost||'').trim().toLowerCase();
     const validPublisher=/^[a-z0-9.-]{1,253}$/.test(publisher)&&publisher.includes('.');
     h=(validPublisher?host('https://'+publisher+'/'):'')||host(url);
    }
    if(!matchesScope(r.domain,h,url))continue;
   }
   if(r.titleMode==='all'||r.titleMode==='exact'&&txt===r.needle||r.titleMode==='contains'&&(r.needle2&&r.titleOperator==='or'?(txt.includes(r.containsNeedle)||txt.includes(r.needle2)):(txt.includes(r.containsNeedle)&&(!r.needle2||txt.includes(r.needle2)))))return false;
  }
  return true;
 };
 db.function('nestrill_rss_visible',(pid,title,url)=>visible(pid,title,url)?1:0);
 const filter=(pid,items)=>Array.isArray(items)?items.filter(x=>visible(pid,x.title,x.url,x.publisherHost)):[];
 const list=pid=>({rules:getRows(pid)});
 // Accept `example.com`, `example.com/subdir/` and full http(s) URLs.
 // Store a canonical host/path prefix in the existing `domain` column.
 function domainValue(value){
  if(value==null||value==='')return '';
  if(typeof value!=='string'||value!==value.trim()||value.length>480||/[\\\s?#]/u.test(value))
   throw Error('対象サイトは example.com または example.com/sub1/ の形式で指定してください');
  const explicit=/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if(explicit&&!/^https?:\/\//i.test(value)||!explicit&&value.includes('://'))throw Error('http(s)のURLまたはドメインを指定してください');
  const urlText=explicit?value:'https://'+value;
  let u;try{u=new URL(urlText)}catch{throw Error('URLが不正です')}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||u.search||u.hash)
   throw Error('ログイン情報・ポート・検索条件のないURLを指定してください');
  const hostname=host(u.href);
  if(!hostname||hostname.length>253||!hostname.includes('.')||
     !hostname.split('.').every(x=>x.length>0&&x.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x)))
   throw Error('ドメインが不正です');
  // Parse from the raw string to reject dot-segment normalization tricks and
  // encoded separators that could widen or obscure the intended directory.
  const authority=value.replace(/^https?:\/\//i,'').split('/')[0];
  if(!authority||authority.includes('@')||authority.includes(':'))throw Error('URLが不正です');
  const rawPath=value.replace(/^https?:\/\//i,'').slice(authority.length);
  if(/(?:^|\/)(?:\.{1,2}|%2e(?:%2e|\.)?)(?:\/|$)/i.test(rawPath)||/%(?:2f|5c|00)/i.test(rawPath)||rawPath.startsWith('//'))
   throw Error('URLパスが不正です');
  const path=normalizeEscapes(u.pathname);
  return !path||path==='/'?hostname:hostname+(path.endsWith('/')?path:path+'/');
 }
 // For compound title conditions, require ASCII double quotes around both
 // literal phrases. This makes whitespace (e.g. " - Publisher") explicit and
 // avoids interpreting operators inside a title as syntax. A simple unquoted
 // phrase remains supported for single-term historical use.
 function parseTitleExpression(value){
  const src=String(value||'').trim();
  const example='複数語句は半角ダブルクォートで囲み、"A"+"B" または "A"or"B" の形式で指定してください';
  // Each quoted phrase may contain spaces; spaces outside quotes are ignored.
  const pair=/^"([^"\r\n]+)"\s*(\+|or)\s*"([^"\r\n]+)"$/i.exec(src);
  if(pair){
   if(!pair[1].trim()||!pair[3].trim())throw Error('空白だけの語句は指定できません');
   return {titleText:pair[1],titleText2:pair[3],titleOperator:pair[2].toLowerCase()==='or'?'or':'and'};
  }
  const single=/^"([^"\r\n]+)"$/.exec(src);
  if(single){
   if(!single[1].trim())throw Error('空白だけの語句は指定できません');
   return {titleText:single[1],titleText2:'',titleOperator:'and'};
  }
  if(src.includes('"'))throw Error(example);
  // Disallow ambiguous expressions like A + B, without changing any rows
  // saved by earlier versions (those are stored as individual terms).
  if(/\s+(?:\+|or)\s+/i.test(src)||/^(?:\+|or)\s+|\s+(?:\+|or)$/i.test(src))throw Error(example);
  return {titleText:src,titleText2:'',titleOperator:'and'};
 }
 function add(pid,x){
  if(!x||typeof x!=='object'||Array.isArray(x))throw Error('ルール形式が不正です');
  const domain=domainValue(x.domain),titleMode=String(x.titleMode||'');
  if(!['all','contains','exact'].includes(titleMode))throw Error('タイトル条件が不正です');
  const hasExpression=x.titleExpression!==undefined;
  if(hasExpression&&(typeof x.titleExpression!=='string'||x.titleExpression.length>255||x.titleText!==undefined||x.titleText2!==undefined||x.titleOperator!==undefined))
   throw Error('タイトル条件の指定が不正です');
  if(!hasExpression&&(typeof x.titleText!=='string'||x.titleText.length>160))throw Error('タイトル条件は160文字以内です');
  if(!hasExpression&&x.titleText2!==undefined&&typeof x.titleText2!=='string')throw Error('追加の語句が不正です');
  if(!hasExpression&&x.titleOperator!==undefined&&!['and','or'].includes(x.titleOperator))throw Error('演算子が不正です');
  const parsed=hasExpression&&titleMode==='contains'?parseTitleExpression(x.titleExpression):null;
  const titleText=parsed?parsed.titleText:(hasExpression?x.titleExpression.trim():x.titleText.trim());
  const titleText2=parsed?parsed.titleText2:String(x.titleText2||'');
  const titleOperator=parsed?parsed.titleOperator:(x.titleOperator||'and');
  if(titleMode==='all'&&titleText)throw Error('全記事を対象とする場合はタイトルを空欄にしてください');
  if(titleMode!=='all'&&!titleText)throw Error('タイトルの語句を入力してください');
  if(titleText2.length>120||/[\x00-\x1f\x7f]/.test(titleText2)||titleText2.length>0&&!titleText2.trim())throw Error('追加の語句は120文字以内で入力してください');
  if(titleMode!=='contains'&&(titleText2||titleOperator!=='and'))throw Error('演算子は「タイトルに含む」で指定してください');
  if(titleOperator==='or'&&!titleText2)throw Error('or の右側に語句を指定してください');
  if(titleMode==='contains'&&titleText2&&norm(titleText2)===norm(titleText))throw Error('2つの語句は別の内容を指定してください');
  if(!domain&&titleMode==='all')throw Error('全サイトの全記事は非表示にできません');
  if(titleText.length>120||/[\x00-\x1f\x7f]/.test(titleText))throw Error('タイトル条件は120文字以内で入力してください');
  const rows=getRows(pid);if(rows.length>=100)throw Error('非表示ルールは100件までです');
  if(rows.some(r=>r.domain===domain&&r.titleMode===titleMode&&norm(r.titleText)===norm(titleText)&&normPhrase(r.titleText2)===normPhrase(titleText2)&&r.titleOperator===titleOperator))throw Error('同じルールが登録されています');
  const result=db.prepare('INSERT INTO rss_article_hide_rules(profile_id,domain,title_mode,title_text,title_text2,title_operator,created_at) VALUES(?,?,?,?,?,?,?)').run(pid,domain,titleMode,titleText,titleText2,titleOperator,Date.now());
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
