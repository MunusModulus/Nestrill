'use strict';
const http=require('node:http');
const os=require('node:os');
const {execFile}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const dns=require('node:dns').promises;
const net=require('node:net');
const {createHash,randomBytes,timingSafeEqual}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {parseFeed,parseOpml,escapeXml,normalizeUrl}=require('./feed');
const {shouldRepairExcerpt}=require('./excerpt-improvement');
const {discoverRss}=require('./rss-discovery');
const DATA=path.join(__dirname,'data');const PUBLIC=path.join(__dirname,'public');
fs.mkdirSync(DATA,{recursive:true});fs.mkdirSync(path.join(DATA,'backgrounds'),{recursive:true});fs.mkdirSync(path.join(DATA,'placeholders'),{recursive:true});
const db=new DatabaseSync(path.join(DATA,'nestrill.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,display_mode TEXT NOT NULL DEFAULT 'list',sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS feeds(id INTEGER PRIMARY KEY,url TEXT NOT NULL UNIQUE,title TEXT NOT NULL,site_url TEXT DEFAULT '',category_id INTEGER NOT NULL REFERENCES categories(id),etag TEXT DEFAULT '',modified TEXT DEFAULT '',checked INTEGER DEFAULT 0,error TEXT DEFAULT '',created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS articles(id INTEGER PRIMARY KEY,feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,guid TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,excerpt TEXT DEFAULT '',thumbnail TEXT DEFAULT '',published INTEGER NOT NULL,received INTEGER NOT NULL,read_at INTEGER,starred INTEGER NOT NULL DEFAULT 0,UNIQUE(feed_id,guid));
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published DESC);
CREATE INDEX IF NOT EXISTS idx_articles_feed ON articles(feed_id,published DESC);
CREATE INDEX IF NOT EXISTS idx_articles_unread ON articles(read_at,published DESC);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
// Profiles are a view over shared RSS/Article records, never separate copies of feeds.
// The first run assigns ALL legacy feeds/categories to the default Main profile.
db.exec(`CREATE TABLE IF NOT EXISTS profiles(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS profile_categories(profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,category_id INTEGER NOT NULL REFERENCES categories(id),PRIMARY KEY(profile_id,category_id));
CREATE TABLE IF NOT EXISTS profile_feeds(profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,category_id INTEGER NOT NULL REFERENCES categories(id),PRIMARY KEY(profile_id,feed_id));
CREATE INDEX IF NOT EXISTS idx_profile_feeds_category ON profile_feeds(profile_id,category_id);`);
// Preserve custom display names within a profile, independently of shared feed metadata.
if(!db.prepare('PRAGMA table_info(profile_feeds)').all().some(x=>x.name==='display_title')){
 db.exec("ALTER TABLE profile_feeds ADD COLUMN display_title TEXT NOT NULL DEFAULT ''");
}
const defaultCategory=db.prepare("INSERT OR IGNORE INTO categories(name,sort_order) VALUES('未分類',0)");defaultCategory.run();
if(!db.prepare('SELECT id FROM profiles LIMIT 1').get()){
 db.exec('BEGIN');
 try{
  db.prepare('INSERT INTO profiles(id,name,created) VALUES(1,?,?)').run('Main',Date.now());
  db.exec('INSERT OR IGNORE INTO profile_categories(profile_id,category_id) SELECT 1,id FROM categories');
  db.exec('INSERT OR IGNORE INTO profile_feeds(profile_id,feed_id,category_id) SELECT 1,id,category_id FROM feeds');
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e}
}
// The hidden profile is a different view of the same database, never listed as a normal profile.
if(!db.prepare('PRAGMA table_info(profiles)').all().some(c=>c.name==='is_secret')) db.exec('ALTER TABLE profiles ADD COLUMN is_secret INTEGER NOT NULL DEFAULT 0');
// RC04: secret/incognito mode is retired. Do NOT create a hidden profile on
// fresh installs. Historical rows are preserved for rollback/audit only.
// The sentinel is never a valid profile ID and must never be served.
const legacySecretProfile=db.prepare('SELECT id FROM profiles WHERE is_secret=1').get();
const SECRET_ID=legacySecretProfile?.id ?? -1;
// Future-source account labels only. No OAuth tokens, cookies, passwords or API access.
// A profile (including the secret profile) owns its own independent rows.
db.exec(`CREATE TABLE IF NOT EXISTS source_accounts(
 id INTEGER PRIMARY KEY,
 profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
 service TEXT NOT NULL CHECK(service IN ('youtube','mail')),
 label TEXT NOT NULL,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 UNIQUE(profile_id,service,label)
);
CREATE INDEX IF NOT EXISTS idx_source_accounts_profile ON source_accounts(profile_id,service,id);`);
// Phase B-UI01: positions are owned by the same profile as each group.
if(!db.prepare('PRAGMA table_info(source_accounts)').all().some(c=>c.name==='sort_order')){
 db.exec('ALTER TABLE source_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
}


// YouTube public-feed import: strictly no Google account authentication or API usage.
const youtubeSource=require('./youtube-source').create({db,fetchFeed:(...args)=>fetchFeed(...args)});
const configBackup=require('./config-backup').create({db,secretId:SECRET_ID,validHttpUrl});
const aiRecommend=require('./ai-recommend').create({db});
const aiExternal=require('./ai-external').create({db});
const aiRandom=require('./ai-random').create();
const aiConditional=require('./ai-conditional').create({db});
const aiSourceFeedback=require('./ai-source-feedback').create({db});
const rssHide=require('./rss-hide-rules').create({db});
aiRecommend.attachSourceFilter((pid,items,opts)=>rssHide.filter(pid,aiSourceFeedback.filter(pid,items,opts)));
aiRecommend.attachOutputFilter((pid,items)=>rssHide.filter(pid,items));
aiRecommend.attachExternal(pid=>{
 const s=aiExternal.status(pid);
 return {...s,items:rssHide.filter(pid,aiSourceFeedback.filter(pid,s.items,{externalPreview:true}))};
});

// Historical quarantine records (if present) are preserved without replay.
// Source membership is now a *per-profile* decision. No cross-scope feed guard
// is installed, and guards from v0.2.0j–n are removed before any new writes.
db.exec(`DROP TRIGGER IF EXISTS scope_guard_profile_feed_insert;
DROP TRIGGER IF EXISTS scope_guard_profile_feed_update;`);

// A category name is unique *within* a visibility scope, not across normal
// and secret mode. Old versions reused the same category ID across scopes;
// migrate secret memberships to their own category records while retaining
// the original normal records and all article/feed history.
db.exec(`CREATE TABLE IF NOT EXISTS secret_category_names(
 category_id INTEGER PRIMARY KEY REFERENCES categories(id),
 name TEXT NOT NULL UNIQUE
);`);
function privateCategoryKey(){return '__nestrill_private_category_'+randomBytes(16).toString('hex')}
function separateSecretCategories(){
 const existing=db.prepare(`SELECT c.id,c.name,c.display_mode,c.sort_order
 FROM categories c WHERE EXISTS(SELECT 1 FROM profile_categories pc WHERE pc.profile_id=? AND pc.category_id=c.id)
 OR EXISTS(SELECT 1 FROM profile_feeds pf WHERE pf.profile_id=? AND pf.category_id=c.id)`).all(SECRET_ID,SECRET_ID);
 if(!existing.some(c=>!db.prepare('SELECT 1 FROM secret_category_names WHERE category_id=?').get(c.id)))return;
 const linkedNormally=db.prepare(`SELECT 1 FROM profile_categories pc JOIN profiles p ON p.id=pc.profile_id
 WHERE pc.category_id=? AND p.is_secret=0 LIMIT 1`);
 const insertCategory=db.prepare('INSERT INTO categories(name,display_mode,sort_order) VALUES(?,?,?)');
 const insertLabel=db.prepare('INSERT INTO secret_category_names(category_id,name) VALUES(?,?)');
 const attach=db.prepare('INSERT OR IGNORE INTO profile_categories(profile_id,category_id) VALUES(?,?)');
 const moveFeed=db.prepare('UPDATE profile_feeds SET category_id=? WHERE profile_id=? AND category_id=?');
 const detach=db.prepare('DELETE FROM profile_categories WHERE profile_id=? AND category_id=?');
 const rename=db.prepare('UPDATE categories SET name=? WHERE id=?');
 db.exec('BEGIN');
 try{
  for(const c of existing){
   if(db.prepare('SELECT 1 FROM secret_category_names WHERE category_id=?').get(c.id))continue;
   if(linkedNormally.get(c.id)){
    // Normal memberships keep their original category ID and label.
    const cid=Number(insertCategory.run(privateCategoryKey(),c.display_mode,c.sort_order).lastInsertRowid);
    insertLabel.run(cid,c.name);attach.run(SECRET_ID,cid);
    moveFeed.run(cid,SECRET_ID,c.id);detach.run(SECRET_ID,c.id);
   }else{
    // Secret-only category: preserve ID (and legacy references) while
    // releasing the public-facing name for normal profiles to reuse.
    rename.run(privateCategoryKey(),c.id);insertLabel.run(c.id,c.name);
    attach.run(SECRET_ID,c.id);
   }
  }
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e}
}
// RC04: no longer migrate retired secret categories on startup.
// Historical rows remain untouched; the old function is kept for rollback compatibility.
// Per-profile category metadata: old global records continue to exist as stable
// FKs, but visible labels and list/magazine preferences belong to each profile.
db.exec(`CREATE TABLE IF NOT EXISTS profile_category_settings(
 profile_id INTEGER NOT NULL, category_id INTEGER NOT NULL,
 name TEXT NOT NULL, display_mode TEXT NOT NULL DEFAULT 'list',
 PRIMARY KEY(profile_id,category_id), UNIQUE(profile_id,name),
 FOREIGN KEY(profile_id,category_id) REFERENCES profile_categories(profile_id,category_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS profile_article_state(
 profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
 article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
 read_at INTEGER, starred INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(profile_id,article_id)
);`);
db.exec(`INSERT OR IGNORE INTO profile_category_settings(profile_id,category_id,name,display_mode)
 SELECT pc.profile_id,pc.category_id,COALESCE(sc.name,c.name),c.display_mode
 FROM profile_categories pc JOIN categories c ON c.id=pc.category_id
 LEFT JOIN secret_category_names sc ON sc.category_id=c.id;`);
// UI04: ordering belongs to each profile, including secret. Initialize existing
// subscriptions in their CURRENT display order; never reset it on later starts.
if(!db.prepare('PRAGMA table_info(profile_category_settings)').all().some(c=>c.name==='sort_order')){
 db.exec('BEGIN');try{
  db.exec('ALTER TABLE profile_category_settings ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  const profiles=db.prepare('SELECT id FROM profiles').all();
  const ordered=db.prepare(`SELECT pc.category_id AS id FROM profile_categories pc
   JOIN categories c ON c.id=pc.category_id WHERE pc.profile_id=? ORDER BY c.sort_order,c.id`);
  const update=db.prepare('UPDATE profile_category_settings SET sort_order=? WHERE profile_id=? AND category_id=?');
  for(const p of profiles){let i=0;for(const c of ordered.all(p.id))update.run(++i,p.id,c.id)}
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e}
}
if(!db.prepare('PRAGMA table_info(profile_feeds)').all().some(c=>c.name==='sort_order')){
 db.exec('BEGIN');try{
  db.exec('ALTER TABLE profile_feeds ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  const pairs=db.prepare('SELECT DISTINCT profile_id,category_id FROM profile_feeds').all();
  const ordered=db.prepare(`SELECT pf.feed_id AS id FROM profile_feeds pf JOIN feeds f ON f.id=pf.feed_id
   WHERE pf.profile_id=? AND pf.category_id=? ORDER BY COALESCE(NULLIF(pf.display_title,''),f.title) COLLATE NOCASE,f.id`);
  const update=db.prepare('UPDATE profile_feeds SET sort_order=? WHERE profile_id=? AND feed_id=?');
  for(const p of pairs){let i=0;for(const f of ordered.all(p.profile_id,p.category_id))update.run(++i,p.profile_id,f.id)}
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e}
}
// Preserve pre-upgrade article flags for all *currently subscribed* profiles.
// Values could have leaked across profiles before this version; we cannot
// reconstruct prior per-profile actions, but all future actions are independent.
if(!db.prepare("SELECT 1 FROM settings WHERE key='profile_article_state_migrated_v1'").get()){
 db.exec('BEGIN');try{
  db.exec(`INSERT OR IGNORE INTO profile_article_state(profile_id,article_id,read_at,starred)
   SELECT pf.profile_id,a.id,a.read_at,a.starred FROM articles a
   JOIN profile_feeds pf ON pf.feed_id=a.feed_id
   WHERE a.read_at IS NOT NULL OR a.starred<>0;`);
  db.prepare("INSERT INTO settings(key,value) VALUES('profile_article_state_migrated_v1','1')").run();
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e}
}
const secretSessions=new Map();
const aiOpen=require('./ai-open').create({db,dataDir:DATA,secretId:SECRET_ID,secretSessions});
// Preview requests are explicit: no publisher-page fetch while images are OFF.
const aiNewsPreview=require('./ai-news-preview').create({newsLookup:aiOpen.newsLookup});
aiRecommend.attachOpenSignals(aiOpen);
function withOpenLinks(req,pid,kind,items,external=false){return items.map(item=>({...item,
 openUrl:aiOpen.href(pid,kind,{...item,id:external?'x:'+item.id:item.id},req)}))}
function checkSecret(req){const token=String(req.headers['x-nestrill-secret']||'');const row=secretSessions.get(token);
 if(!row||row< Date.now()){if(row)secretSessions.delete(token);return false}
 secretSessions.set(token,Date.now()+2*60*60*1000);req._secret=true;req._secretToken=token;return true;
}
function isSecretProfile(pid){return pid===SECRET_ID}
function canonicalFeedIdentity(value){
 try{const u=new URL(validHttpUrl(value));
  u.protocol='https:';u.hash='';u.pathname=u.pathname.replace(/\/+$/,'')||'/';
  return u.host+u.pathname+u.search;
 }catch{return ''}
}
function alreadyInProfile(url,pid,excludeFeedId=0){
 const canonical=canonicalFeedIdentity(url);
 const rows=db.prepare(`SELECT f.id,f.url FROM feeds f JOIN profile_feeds pf ON pf.feed_id=f.id
 WHERE pf.profile_id=?`).all(pid);
 return rows.some(f=>f.id!==excludeFeedId && canonicalFeedIdentity(f.url)===canonical);
}
function profileId(req){
 if(req._secret)return SECRET_ID;
 const value=Number(req.headers['x-nestrill-profile-id']||1);
 return Number.isSafeInteger(value)&&value>0&&db.prepare('SELECT id FROM profiles WHERE id=? AND is_secret=0').get(value)?value:1;
}

function profileCategory(id,cid){
 db.prepare('INSERT OR IGNORE INTO profile_categories(profile_id,category_id) VALUES(?,?)').run(id,cid);
 const c=db.prepare(`SELECT COALESCE(sc.name,c.name) AS name,c.display_mode AS mode
 FROM categories c LEFT JOIN secret_category_names sc ON sc.category_id=c.id WHERE c.id=?`).get(cid);
 const next=db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS pos FROM profile_category_settings WHERE profile_id=?').get(id).pos;
 db.prepare('INSERT OR IGNORE INTO profile_category_settings(profile_id,category_id,name,display_mode,sort_order) VALUES(?,?,?,?,?)').run(id,cid,c.name,c.mode,next);
}
function profileFeed(id,fid,cid){profileCategory(id,cid);
 const next=db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS pos FROM profile_feeds WHERE profile_id=? AND category_id=?').get(id,cid).pos;
 return db.prepare('INSERT OR IGNORE INTO profile_feeds(profile_id,feed_id,category_id,sort_order) VALUES(?,?,?,?)').run(id,fid,cid,next).changes;
}
function profileList(){return db.prepare(`SELECT p.id,p.name,p.created,(SELECT count(*) FROM profile_feeds f WHERE f.profile_id=p.id) AS feedCount FROM profiles p WHERE p.is_secret=0 ORDER BY p.id`).all()}
function validLabel(input){const label=String(input||'').trim();if(!label||label.length>80||/[\x00-\x1f]/.test(label))throw Error('名前は1～80文字で入力してください');return label}

function getDefault(pid=1){
 if(isSecretProfile(pid)){
  const c=db.prepare("SELECT category_id AS id FROM secret_category_names WHERE name='未分類'").get();
  if(!c)throw Error('シークレットの未分類カテゴリが見つかりません');
  return c.id;
 }
 return db.prepare("SELECT id FROM categories WHERE name='未分類'").get().id;
}
function findCategory(name,pid){
 return db.prepare('SELECT category_id AS id FROM profile_category_settings WHERE profile_id=? AND name=?').get(pid,name);
}
function ensureCategory(name,pid){
 let c=findCategory(name,pid);
 if(c)return c.id;
 const inserted=db.prepare('INSERT INTO categories(name) VALUES(?)').run(privateCategoryKey());
 const id=Number(inserted.lastInsertRowid);
 if(isSecretProfile(pid))db.prepare('INSERT INTO secret_category_names(category_id,name) VALUES(?,?)').run(id,name);
 profileCategory(pid,id);
 db.prepare('UPDATE profile_category_settings SET name=? WHERE profile_id=? AND category_id=?').run(name,pid,id);
 return id;
}

const defaultTheme={
 genreIcons:{size:15,color:'#65738a'},
 baseColor:'#edf0f5',
 sharedLinked:true,
 header:{extend:true,color:'#ffffff',opacity:75,blur:10,textColor:'#263c59',borderEnabled:true,borderColor:'#dce3ee',borderOpacity:50},
 shared:{image:'',type:'color',folder:'',mobileFolder:'',folderKind:'all',interval:300,blur:0,speed:1,loop:true,color:'#edf0f5',colorOpacity:100,imageOpacity:100,position:'center'},
 left:{image:'',type:'color',folder:'',mobileFolder:'',folderKind:'all',interval:300,blur:0,speed:1,loop:true,color:'#ffffff',colorOpacity:95,imageOpacity:100,position:'center'},
 right:{image:'',type:'color',folder:'',mobileFolder:'',folderKind:'all',interval:300,blur:0,speed:1,loop:true,color:'#ffffff',colorOpacity:96,imageOpacity:100,position:'center'},
 text:{left:{font:'Meiryo, sans-serif',weight:400,color:'#273349',size:13,stroke:0,strokeColor:'#000000',shadow:false,shadowColor:'#121a2d',shadowOpacity:60,shadowX:1,shadowY:2,shadowBlur:3},right:{font:'Meiryo, sans-serif',weight:400,color:'#223148',size:14,stroke:0,strokeColor:'#000000',shadow:false,shadowColor:'#121a2d',shadowOpacity:60,shadowX:1,shadowY:2,shadowBlur:3}},
 articleStyle:{source:{font:'Noto Sans JP Medium',weight:400,size:11,color:'#65758a',stroke:0,strokeColor:'#000000',shadow:false,shadowColor:'#121a2d',shadowOpacity:60,shadowX:1,shadowY:2,shadowBlur:3},title:{font:'Noto Sans JP Medium',weight:500,size:14,color:'#223148',stroke:0,strokeColor:'#000000',shadow:false,shadowColor:'#121a2d',shadowOpacity:60,shadowX:1,shadowY:2,shadowBlur:3},excerpt:{font:'Noto Sans JP',weight:400,size:12,color:'#64748b',stroke:0,strokeColor:'#000000',shadow:false,shadowColor:'#121a2d',shadowOpacity:60,shadowX:1,shadowY:2,shadowBlur:3}},
 stripe:{enabled:false,oddColor:'#ffffff',oddOpacity:0,evenColor:'#dfebf9',evenOpacity:50,hoverColor:'#d6e6fa',hoverOpacity:35},
 separators:{list:{enabled:true,color:'#8192a5',opacity:18,width:1,style:'solid',inset:0,spacing:0},magazine:{enabled:true,color:'#8192a5',opacity:18,width:1,style:'solid',inset:0,spacing:0}}
};
db.exec(`CREATE TABLE IF NOT EXISTS appearance_presets(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,theme TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);`);
// Upgrade the old global-unique name constraint to per-scope uniqueness.
// A secret preset may have the same name as a normal one without leaking its existence.
if(!db.prepare('PRAGMA table_info(appearance_presets)').all().some(c=>c.name==='is_secret')){
 db.exec(`BEGIN;
  CREATE TABLE appearance_presets_v2(id INTEGER PRIMARY KEY,name TEXT NOT NULL,theme TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,is_secret INTEGER NOT NULL DEFAULT 0,UNIQUE(name,is_secret));
  INSERT INTO appearance_presets_v2(id,name,theme,created,updated,is_secret) SELECT id,name,theme,created,updated,0 FROM appearance_presets;
  DROP TABLE appearance_presets;
  ALTER TABLE appearance_presets_v2 RENAME TO appearance_presets;
  COMMIT;`);
}
// Fix99A: dedicated mobile appearance (never inherited from desktop wallpaper).
// This is a normal-profile-independent preference; no secret theme or file paths are exposed.
const MOBILE_BG_DIR=path.join(DATA,'mobile-backgrounds');
const MOBILE_BG_NAME=/^mobile-bg-([0-9a-f]{24})\.webp$/;
const MOBILE_BG_DEFAULT={mode:'color',color:'#f4f7fb',image:''};
function readMobileBackground(){
 let val={};try{val=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='mobile_background_v1'").get()?.value||'{}')}catch{}
 if(!val||typeof val!=='object')val={};
 const color=colorOk(val.color)?val.color:MOBILE_BG_DEFAULT.color;
 const image=typeof val.image==='string'&&MOBILE_BG_NAME.test(val.image)&&
  fs.existsSync(path.join(MOBILE_BG_DIR,val.image))?val.image:'';
 const mode=val.mode==='image'&&image?'image':'color';
 return {mode,color,image};
}
function writeMobileBackground(value){
 db.prepare("INSERT INTO settings(key,value) VALUES('mobile_background_v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
  .run(JSON.stringify(value));
}
// Fix100A: mobile-only appearance palette. Independent of PC theme/secret profiles.
const MOBILE_PALETTE_DEFAULT={mode:'system',titleSize:15,colors:{header:'#ffffff',card:'#ffffff',text:'#172339',muted:'#61738c',accent:'#2563eb',control:'#edf2fa',border:'#dce5ef'}};
const mobilePaletteColorOk=x=>typeof x==='string'&&/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(x);
function readMobilePalette(){
 let val={};try{val=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='mobile_palette_v1'").get()?.value||'{}')}catch{}
 if(!val||typeof val!=='object')val={};
 const mode=['system','light','dark','custom'].includes(val.mode)?val.mode:'system';
 const titleSize=Number.isInteger(val.titleSize)&&val.titleSize>=10&&val.titleSize<=19?val.titleSize:15;
 const colors={};for(const [key,fallback] of Object.entries(MOBILE_PALETTE_DEFAULT.colors))colors[key]=mobilePaletteColorOk(val.colors?.[key])?val.colors[key]:fallback;
 return {mode,titleSize,colors};
}
function writeMobilePalette(value){
 db.prepare("INSERT INTO settings(key,value) VALUES('mobile_palette_v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
}
function mobileBackgroundBytes(){
 const cfg=readMobileBackground();if(cfg.mode!=='image'||!cfg.image)return null;
 const file=path.join(MOBILE_BG_DIR,cfg.image);
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>500000)return null;
 return {bytes:fs.readFileSync(file),version:MOBILE_BG_NAME.exec(cfg.image)[1]};
}
function getTheme(secret=false){
 try{
  const key=secret?'theme_secret':'theme';
  const saved=JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value||'{}');
  const merged={...defaultTheme,...saved,header:{...defaultTheme.header,...saved.header},text:{...defaultTheme.text,...saved.text},articleStyle:{...defaultTheme.articleStyle,...saved.articleStyle},separators:{...defaultTheme.separators,...saved.separators},stripe:{...defaultTheme.stripe,...saved.stripe},genreIcons:{...defaultTheme.genreIcons,...saved.genreIcons}};
  for(const k of ['left','right','shared']){merged[k]={...defaultTheme[k],...saved[k]};if(!saved[k]?.type&&merged[k].image)merged[k].type=/\.(mp4|webm)(?:\?|$)/i.test(merged[k].image)?'video':'image'}
  for(const k of ['left','right'])merged.text[k]={...defaultTheme.text[k],...saved.text?.[k]};
  for(const k of ['source','title','excerpt'])merged.articleStyle[k]={...defaultTheme.articleStyle[k],...saved.articleStyle?.[k]};
  for(const k of ['list','magazine'])merged.separators[k]={...defaultTheme.separators[k],...saved.separators?.[k]};
  return merged;
 }catch{return structuredClone(defaultTheme)}
}
const setTheme=(x,secret=false)=>db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(secret?'theme_secret':'theme',JSON.stringify(x));
function secretDefault(){return Number(db.prepare("SELECT value FROM settings WHERE key='secret_default_preset'").get()?.value||0)}

const FALLBACK_FONTS=['Arial','BIZ UDPGothic','BIZ UDPMincho','Consolas','Meiryo','MS Gothic','MS Mincho','Noto Sans JP','Segoe UI','Yu Gothic','Yu Mincho'];
let fontCache={at:0,names:[]};
async function listInstalledFonts(){
 if(Date.now()-fontCache.at<600000&&fontCache.names.length)return fontCache.names;
 let names=[];
 if(process.platform==='win32'){
  try{
   const script=path.join(__dirname,'scripts','List-Fonts.ps1');
   const out=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,windowsHide:true},(e,stdout)=>e?reject(e):resolve(stdout)));
   const data=JSON.parse(out.trim().replace(/^\uFEFF/,''));
   if(Array.isArray(data))names=data.filter(x=>typeof x==='string'&&x.length<=110&&fontOk(x));
  }catch(e){console.warn('[Nestrill] フォント一覧取得失敗。代替候補を表示します:',e.message)}
 }
 names=[...new Set([...names,...FALLBACK_FONTS])].sort((a,b)=>a.localeCompare(b,'ja'));
 fontCache={at:Date.now(),names};return names;
}

// Placeholder preferences are stored separately to preserve existing theme settings.
const PLACEHOLDER_FILE=/^\/assets\/placeholder-(missing|failed)-[0-9a-f]+\.(?:png|jpg|webp|gif|apng)(?:\?v=\d+)?$/;
function getPlaceholders(){try{const x=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='placeholders'").get()?.value||'{}');return {missing:PLACEHOLDER_FILE.test(x.missing||'')?x.missing:'',failed:PLACEHOLDER_FILE.test(x.failed||'')?x.failed:''}}catch{return {missing:'',failed:''}}}
function setPlaceholders(x){db.prepare("INSERT INTO settings(key,value) VALUES('placeholders',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(x));}
function prunePlaceholders(x){const used=new Set(Object.values(x).map(v=>v.split('?')[0].split('/').pop()).filter(Boolean));for(const f of fs.readdirSync(path.join(DATA,'placeholders'))){if(/^placeholder-(missing|failed)-[0-9a-f]+\.(png|jpg|webp|gif|apng)$/.test(f)&&!used.has(f))fs.unlinkSync(path.join(DATA,'placeholders',f));}}

function json(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(body);}
function fail(res,msg,status=400){json(res,status,{error:msg})}
async function body(req,limit=100_000){let size=0;let chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('送信データが大きすぎます');chunks.push(chunk)}return Buffer.concat(chunks)}
// RC01-R9: Windows autostart is an OS-level option, not a per-profile/theme preference.
// Always consult Windows via the existing, folder-owned PowerShell shortcut manager.
let autostartOperationBusy=false;
function runAutostartAction(action){
 return new Promise((resolve,reject)=>{
  execFile('powershell.exe',[
   '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
   path.join(__dirname,'scripts','Nestrill-Autostart.ps1'),'-Action',action,'-OutputJson'
  ],{windowsHide:true,timeout:15000,maxBuffer:65536,encoding:'utf8'},(error,stdout,stderr)=>{
   if(error)return reject(new Error(String((stderr||stdout||error.message)).trim().slice(0,400)));
   try{
    const result=JSON.parse(String(stdout).replace(/^\uFEFF/,'').trim());
    if(typeof result.enabled!=='boolean'||typeof result.conflict!=='boolean'||result.supported!==true)throw Error('invalid status');
    resolve(result);
   }catch(e){reject(new Error('Windows自動起動の状態を読み取れませんでした: '+e.message))}
  });
 });
}
function autostartRequestIsLocal(req){
 const addr=req.socket.remoteAddress||'';
 const host=String(req.headers.host||'').toLowerCase();
 // The PC-only setting must not be accessible via Tailscale Serve, proxies, or mobile.
 return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(addr)
  && /^(?:127\.0\.0\.1|localhost|\[::1\]):8767$/.test(host)
  && !('forwarded' in req.headers)
  && !('x-forwarded-for' in req.headers)
  && !('x-forwarded-host' in req.headers);
}

function int(x){const n=Number(x);return Number.isSafeInteger(n)&&n>=0?n:0}
function validHttpUrl(text){const s=String(text||'').trim();const u=normalizeUrl(s);if(!u)throw Error('http/httpsのRSS URLを入力してください');const url=new URL(u);if(url.username||url.password)throw Error('認証情報付きURLは登録できません');if(url.port&&!['80','443','8080','8443'].includes(url.port))throw Error('このポート番号には対応していません');return u;}
function forbiddenIP(ip){
 if(net.isIP(ip)===4){const p=ip.split('.').map(Number);return p[0]===0||p[0]===10||p[0]===127||p[0]>=224||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===100&&p[1]>=64&&p[1]<=127)||(p[0]===192&&p[1]===0)||(p[0]===198&&[18,19].includes(p[1]))||(p[0]===198&&p[1]===51&&p[2]===100)||(p[0]===203&&p[1]===0&&p[2]===113);
 }
 if(net.isIP(ip)===6){const t=ip.toLowerCase();return t==='::1'||t==='::'||t.startsWith('fe80:')||t.startsWith('fc')||t.startsWith('fd')||t.startsWith('ff')||t.startsWith('::ffff:')||t.startsWith('2001:db8:');}
 return true;
}
async function checkRemote(url){const u=new URL(validHttpUrl(url));if(u.hostname==='localhost'||u.hostname.endsWith('.localhost')||u.hostname.endsWith('.local')||u.hostname.endsWith('.internal'))throw Error('ローカルネットワークのRSS URLには接続できません');const addresses=await dns.lookup(u.hostname,{all:true});if(!addresses.length||addresses.some(a=>forbiddenIP(a.address)))throw Error('プライベートネットワークへのアクセスは禁止されています');}
// Fix94A: passive timing of actual RSS refresh. Never record feed URLs, article
// text, profile names, session tokens, PINs, or secret-only feed counts.
const {performance:f94Clock}=require('node:perf_hooks');
const F94_REPORT=path.join(__dirname,'run','Fix94B-RefreshTiming.txt');
function f94Add(trace,key,started){if(trace)trace[key]=(trace[key]||0)+(f94Clock.now()-started)}
// Fix94B: locally useful identity for NORMAL-profile diagnostic rows only.
// Never include complete feed URLs, querystrings, credentials or secret-only feeds.
function f94Plain(value,max=80){return String(value??'').replace(/[\x00-\x1f\x7f\u2028\u2029]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max)}
function f94Identity(feed){
 let domain='(invalid hostname)';
 try{domain=f94Plain(new URL(feed.url).hostname.toLowerCase(),120)||domain}catch{}
 return {feedDbId:Number.isSafeInteger(Number(feed.id))?Number(feed.id):'?',domain,feedTitle:f94Plain(feed.title,72)||'(untitled)'};
}
function f94ErrorCode(err){
 const code=String(err?.cause?.code||err?.code||'').toUpperCase();
 return /^[A-Z][A-Z0-9_]{1,49}$/.test(code)?code:'-';
}
function f94Category(error){
 const s=String(error?.message||error||'');
 if(/HTTP\s*4\d\d/i.test(s))return 'HTTP_4xx';
 if(/HTTP\s*5\d\d/i.test(s))return 'HTTP_5xx';
 if(/timeout|timed out|abort/i.test(s))return 'timeout';
 if(/ENOTFOUND|EAI_AGAIN|dns/i.test(s))return 'dns_error';
 if(/private|local network|プライベート|ローカルネットワーク/i.test(s))return 'blocked_private';
 if(/fetch failed|ECONN|socket/i.test(s))return 'network_error';
 return 'other_error';
}
function f94Write(run){
 const rows=run.rows||[];
 const values=key=>rows.map(r=>Number(r[key])||0);
 const total=key=>values(key).reduce((a,b)=>a+b,0);
 const f=n=>`${Math.round(Number(n)||0)}ms`;
 const nums=values('wallMs').sort((a,b)=>a-b);
 const p=x=>nums.length?f(nums[Math.max(0,Math.ceil(nums.length*x)-1)]):'n/a';
 const status=new Map();for(const x of rows){status.set(x.status,(status.get(x.status)||0)+1)}
 const statuses=[...status].sort((a,b)=>a[0].localeCompare(b[0]));
 const lines=[
  'Nestrill Fix97A ACTUAL RSS REFRESH TIMING + SOURCE DOMAIN',
  'Generated: '+new Date().toISOString(),
  'This report is produced after the NORMAL Nestrill full RSS refresh, not a separate network sample.',
  'Only normal-profile domains and saved feed titles are included for slow-source diagnosis.',
  'No complete RSS URLs, article text, profile names, secret-only feed details, cookies or PINs.',
  'All timing values are milliseconds; source phase totals overlap because the refresh uses parallel workers.',
  'Original behavior (including SQLite writes and normal feed polling) was retained.',
  '',
  'Full refresh elapsed wall: '+f(run.wallMs)+' (may include sources omitted from the normal-only sample)',
  'RSS worker limit: 8',
  'First-pass article-ready elapsed: '+(Number.isFinite(run.firstPassMs)?f(run.firstPassMs):'n/a (no separate retry stage)'),
  'Normal-profile feeds observed: '+rows.length,
  'Normal-profile results: '+statuses.map(([k,v])=>`${k}=${v}`).join(', '),
  'Normal-profile articles newly added: '+rows.reduce((a,x)=>a+(x.added||0),0),
  'Normal per-feed wall: p50='+p(.50)+', p90='+p(.90)+', max='+p(1),
  '',
  'SUMMED PHASE TIME across normal-profile feeds (NOT sequential wall time):',
  '  URL validation + DNS lookup: '+f(total('guardMs')),
  '  HTTP request / headers (incl. TLS/socket): '+f(total('headerMs')),
  '  HTTP body receive: '+f(total('bodyMs')),
  '  Text decode: '+f(total('decodeMs')),
  '  XML parse: '+f(total('parseMs')),
  '  SQLite writes incl. transactions: '+f(total('dbMs')),
  '  Unattributed per-feed time (incl. queues/JS work): '+f(Math.max(0,total('wallMs')-total('guardMs')-total('headerMs')-total('bodyMs')-total('decodeMs')-total('parseMs')-total('dbMs'))),
  '',
  'SLOWEST NORMAL-PROFILE ENTRIES (host and saved title shown for identification):',
  '   ID   result       total  guard  header  body  decode  XML  SQLite  redirects  new articles    source'
 ];
 for(const r of rows.slice().sort((a,b)=>b.wallMs-a.wallMs).slice(0,12)){
  const num=n=>String(Math.round(Number(n)||0)).padStart(5);
  lines.push('   N'+String(r.index).padStart(3,'0')+' '+String(r.status).padEnd(12)+' '+num(r.wallMs)+' '+num(r.guardMs)+' '+num(r.headerMs)+' '+num(r.bodyMs)+' '+num(r.decodeMs)+' '+num(r.parseMs)+' '+num(r.dbMs)+' '+String(r.redirects||0).padStart(4)+' '+String(r.added||0).padStart(8)+'    host='+r.domain+'; feed_id='+r.feedDbId+'; title='+r.feedTitle+'; error_code='+(r.errorCode||'-'));
 }
 lines.push('',
  'INTERPRETATION:',
  '- HTTP header wait includes remote server latency and network/TLS setup. DNS for HTTP internals can also occur there.',
  '- SQLite time is measured inside the real updateFeed write path, including unchanged and failure status writes.',
  '- N### is assigned anew per run. feed_id and saved title identify the registered source in this installation.',
  '- The whole refresh duration includes all sources; detailed phase data excludes secret-only feeds.',
  '- Fix97A: a shared 8-worker scheduler overlaps ordinary and previously failing feeds (up to 2 retry-first slots).',
  '- Source domain is the subscribed feed URL hostname, not necessarily the final redirected host.',
  '- This test does not by itself measure Helium UI render time or prove that a proposed speed fix is safe.',
  'END');
 fs.mkdirSync(path.dirname(F94_REPORT),{recursive:true});
 const tmp=F94_REPORT+'.tmp';
 fs.writeFileSync(tmp,lines.join('\r\n')+'\r\n','utf8');
 fs.renameSync(tmp,F94_REPORT);
}
async function fetchFeed(url,etag='',modified='',redirect=0,f94Trace=null){
 const f94Guard=f94Clock.now();
 try{await checkRemote(url)}finally{f94Add(f94Trace,'guardMs',f94Guard)}
 const h={'User-Agent':'Nestrill/0.2.0b (+personal RSS reader)','Accept':'application/atom+xml, application/rss+xml, application/xml, text/xml;q=.9, */*;q=.4'};
 if(etag)h['If-None-Match']=etag;if(modified)h['If-Modified-Since']=modified;
 const f94Head=f94Clock.now();let r;
 try{r=await fetch(url,{headers:h,redirect:'manual',signal:AbortSignal.timeout(15000)})}finally{f94Add(f94Trace,'headerMs',f94Head)}
 if(r.status===304)return {unchanged:true};
 if(r.status>=300&&r.status<400){if(redirect>=3)throw Error('リダイレクト回数超過');const loc=r.headers.get('location');if(!loc)throw Error('リダイレクト先が不明です');if(f94Trace)f94Trace.redirects=(f94Trace.redirects||0)+1;return fetchFeed(new URL(loc,url).toString(),'','',redirect+1,f94Trace)}
 if(!r.ok)throw Error(`HTTP ${r.status}`);
 const len=Number(r.headers.get('content-length')||0);if(len>5_000_000)throw Error('RSSが大きすぎます');
 const f94Body=f94Clock.now();const reader=r.body.getReader();let chunks=[],count=0;try{while(true){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>5_000_000)throw Error('RSSが大きすぎます');chunks.push(Buffer.from(value));}}finally{f94Add(f94Trace,'bodyMs',f94Body);reader.releaseLock();}
 const bytes=Buffer.concat(chunks);const charsetHeader=(r.headers.get('content-type')||'').match(/charset\s*=\s*["']?([a-z0-9_\-]+)/i)?.[1];const charsetXml=bytes.subarray(0,250).toString('latin1').match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)/i)?.[1];
 const f94Decode=f94Clock.now();let xml;try{xml=new TextDecoder(charsetHeader||charsetXml||'utf-8').decode(bytes)}catch{xml=bytes.toString('utf8')}
 f94Add(f94Trace,'decodeMs',f94Decode);
 const f94Parse=f94Clock.now();let parsed;
 try{parsed=parseFeed(xml,url)}finally{f94Add(f94Trace,'parseMs',f94Parse)}
 return {feed:parsed,etag:r.headers.get('etag')||'',modified:r.headers.get('last-modified')||''};
}

// Favicons are intentionally a best-effort option. Never scrape article bodies or replace
// a broken article thumbnail with a favicon: the UI distinguishes those states.
const iconCache=new Map();let iconActive=0;const iconQueue=[];
function queueIcon(task){return new Promise((resolve,reject)=>{iconQueue.push({task,resolve,reject});drainIcons()});}
function drainIcons(){while(iconActive<3&&iconQueue.length){const job=iconQueue.shift();iconActive++;Promise.resolve().then(job.task).then(job.resolve,job.reject).finally(()=>{iconActive--;drainIcons()})}}
function imageFormat(bytes){if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';if(bytes.toString('ascii',0,4)==='GIF8')return 'image/gif';if(bytes.length>=6&&bytes.toString('hex',0,4)==='00000100')return 'image/x-icon';return ''}
async function fetchSmall(url,accept,limit=300_000,redirect=0,deadline=Infinity){
 if(Date.now()>=deadline)throw Error('favicon time budget exceeded');
 await checkRemote(url);
 const r=await fetch(url,{headers:{'User-Agent':'Nestrill/0.1 (personal RSS reader)','Accept':accept},redirect:'manual',signal:AbortSignal.timeout(Math.max(100,Math.min(6000,deadline-Date.now())))});
 if(r.status>=300&&r.status<400){if(redirect>=3)throw Error('favicon redirect limit');const loc=r.headers.get('location');if(!loc)throw Error('favicon redirect without location');return fetchSmall(new URL(loc,url).toString(),accept,limit,redirect+1,deadline)}
 if(!r.ok)throw Error(`favicon HTTP ${r.status}`);
 if(Number(r.headers.get('content-length')||0)>limit)throw Error('favicon is too large');
 const chunks=[];let size=0;for await(const part of r.body){size+=part.byteLength;if(size>limit)throw Error('favicon is too large');chunks.push(Buffer.from(part))}
 return Buffer.concat(chunks);
}
function htmlIconLinks(html,base){
 const found=[];const tags=html.match(/<link\b[^>]*>/gi)||[];
 for(const tag of tags){
  const get=a=>{const rx=new RegExp('\\b'+a+'\\s*=\\s*(?:"([^"]*)"|\\x27([^\\x27]*)\\x27|([^\\s>]+))','i');const m=rx.exec(tag);return m?.[1]||m?.[2]||m?.[3]||''};
  if(!/(^|\s)(?:shortcut\s+)?icon(?:\s|$)/i.test(get('rel')))continue;
  const url=normalizeUrl(get('href'),base);if(url)found.push(url);
 }
 return found.slice(0,6);
}
async function getRemoteIcon(feed){
 const deadline=Date.now()+12000;
 const roots=[feed.site_url,feed.url].filter(Boolean).map(v=>{try{return new URL(v).origin}catch{return ''}}).filter(Boolean);
 const origins=[...new Set(roots)];
 for(const root of origins){
  if(Date.now()>=deadline)break;
  let options=[root+'/favicon.ico'];
  try{const html=(await fetchSmall(root+'/','text/html',120_000,0,deadline)).toString('utf8');options=[...htmlIconLinks(html,root+'/'),...options]}catch{}
  options=[...new Set(options.concat(root+'/favicon.png',root+'/apple-touch-icon.png'))].slice(0,9);
  for(const url of options){if(Date.now()>=deadline)break;try{const bytes=await fetchSmall(url,'image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon,*/*;q=.5',260_000,0,deadline);const type=imageFormat(bytes);if(type)return {type,bytes}}catch{}}
 }
 return null;
}
function faviconForFeed(feed){const origin=feed.site_url||feed.url;const key=createHash('sha256').update(origin+'|'+feed.url).digest('hex');const now=Date.now();const cached=iconCache.get(key);if(cached&&cached.until>now)return cached.promise;
 const promise=queueIcon(()=>getRemoteIcon(feed).catch(()=>null));iconCache.set(key,{promise,until:now+6*60*60*1000});
 promise.then(value=>{const item=iconCache.get(key);if(item?.promise===promise)item.until=Date.now()+(value?24:6)*60*60*1000});
 if(iconCache.size>750){for(const [k,v] of iconCache){if(v.until<now)iconCache.delete(k);if(iconCache.size<550)break}}
 return promise;
}

// Fix93A: single-flight progress snapshot for authenticated mobile RSS refresh.
// Run IDs allow the phone to distinguish completion from a previous refresh.
let refreshing=false;let lastRun=0;
let rssRefreshRunId=0, rssRefreshCompletedRun=0, rssRefreshCompletedAt=0, rssRefreshFailed=false, rssRefreshCompletedFailed=false;
// Fix95A: a first pass only means ordinary sources have been checked. Error
// sources remain in the same refresh; do not report full completion early.
let rssRefreshFirstPassCompletedRun=0;
const mobileRefreshLastByProfile=new Map();
function mobileRefreshStatus(){
  return {running:refreshing,runId:rssRefreshRunId,completedRun:rssRefreshCompletedRun,
    firstPassCompletedRun:rssRefreshFirstPassCompletedRun,
    completedAt:rssRefreshCompletedAt,failed:rssRefreshCompletedFailed};
}
function startMobileRssRefresh(profileId){
  if(refreshing)return {busy:true,runId:rssRefreshRunId};
  // This action is intentionally limited to feeds of the selected NORMAL profile.
  const ids=db.prepare(`SELECT DISTINCT pf.feed_id AS id FROM profile_feeds pf
    JOIN profiles p ON p.id=pf.profile_id AND p.is_secret=0
    WHERE pf.profile_id=?`).all(profileId).map(row=>row.id);
  if(!ids.length)return {empty:true};
  // Avoid rapidly repeating full network work from an authenticated handset.
  const lastMobileRun=mobileRefreshLastByProfile.get(profileId)||0;
  if(Date.now()-lastMobileRun<15000)return {cooldown:true,runId:rssRefreshRunId};
  mobileRefreshLastByProfile.set(profileId,Date.now());
  refresh(ids).catch(e=>console.error('[MOBILE] RSS refresh:',e));
  return {started:true,runId:rssRefreshRunId};
}
async function updateFeed(feed,f94Observer=null){
 const f94Trace=f94Observer?{index:f94Observer.index,...f94Identity(feed),errorCode:'-',added:0,status:'unclassified',redirects:0,wallMs:0,guardMs:0,headerMs:0,bodyMs:0,decodeMs:0,parseMs:0,dbMs:0}:null;
 const f94Start=f94Clock.now();
 try{
  const data=await fetchFeed(feed.url,feed.etag,feed.modified,0,f94Trace);const t=Date.now();
  if(data.unchanged){
   const f94DB=f94Clock.now();
   try{db.prepare("UPDATE feeds SET checked=?,error='' WHERE id=?").run(t,feed.id)}finally{f94Add(f94Trace,'dbMs',f94DB)}
   if(f94Trace)f94Trace.status='304';
   return {id:feed.id,ok:true,added:0};
  }
  const f94DB=f94Clock.now();
  try{
   const ins=db.prepare('INSERT OR IGNORE INTO articles(feed_id,guid,url,title,excerpt,thumbnail,published,received) VALUES(?,?,?,?,?,?,?,?)');
   const existing=db.prepare('SELECT id,title,excerpt FROM articles WHERE feed_id=? AND guid=?');
   // Fix82: preserve existing IDs, flags, dates, and repair excerpts only when justified.
   const repair=db.prepare('UPDATE articles SET excerpt=? WHERE id=? AND excerpt=?');
   db.exec('BEGIN');let added=0;
   try{for(const a of data.feed.items){
     const r=ins.run(feed.id,a.guid,a.url,a.title,a.excerpt,a.thumbnail,a.published,t);
     added+=Number(r.changes);
     if(!r.changes){
      const old=existing.get(feed.id,a.guid);
      if(old&&shouldRepairExcerpt(old.excerpt,a.excerpt,old.title))repair.run(a.excerpt,old.id,old.excerpt);
     }
    }
    db.prepare("UPDATE feeds SET title=?,site_url=?,etag=?,modified=?,checked=?,error='' WHERE id=?").run(data.feed.title,data.feed.siteUrl,data.etag,data.modified,t,feed.id);db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e}
   if(f94Trace){f94Trace.status='200';f94Trace.added=added}
   return {id:feed.id,ok:true,added};
  }finally{f94Add(f94Trace,'dbMs',f94DB)}
 }catch(e){
  if(f94Trace){f94Trace.status=f94Category(e);f94Trace.errorCode=f94ErrorCode(e)}
  const f94DB=f94Clock.now();
  try{db.prepare('UPDATE feeds SET checked=?,error=? WHERE id=?').run(Date.now(),String(e.message).slice(0,400),feed.id)}
  finally{f94Add(f94Trace,'dbMs',f94DB)}
  return {id:feed.id,ok:false,error:String(e.message).slice(0,150)};
 }finally{
  if(f94Trace){f94Trace.wallMs=f94Clock.now()-f94Start;f94Observer.run.rows.push(f94Trace)}
 }
}
async function refresh(ids){if(refreshing)return {busy:true};refreshing=true;lastRun=Date.now();
 const thisRun=++rssRefreshRunId;rssRefreshFailed=false;rssRefreshFirstPassCompletedRun=0;
 const f94Start=f94Clock.now();
 const f94Run=(!ids||!ids.length)?{rows:[],wallMs:0}:null;
 try{
  const rows=ids?.length?db.prepare(`SELECT * FROM feeds WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids):db.prepare('SELECT * FROM feeds WHERE EXISTS(SELECT 1 FROM profile_feeds pf WHERE pf.feed_id=feeds.id)').all();
  // Export timing for NORMAL-profile RSS feeds only. Do not query secret profile rows.
  const normalSet=f94Run?new Set(db.prepare(`SELECT DISTINCT pf.feed_id AS id FROM profile_feeds pf JOIN profiles p ON p.id=pf.profile_id WHERE p.is_secret=0`).all().map(x=>x.id)):null;
  // Fix95B: use the previous run's errors as a scheduling hint ONLY.
  // Every registered feed is still polled on every refresh, with unchanged
  // network timeout and 8 workers. Successful recovery clears feed.error
  // in updateFeed and it joins the ordinary pass on the next refresh.
  const ordinary=rows.filter(f=>!String(f.error||'').trim());
  const retry=rows.filter(f=>String(f.error||'').trim());
  // Fix97A: share 8 fetch slots between both kinds of feed.
  // A slow retry starts immediately instead of waiting for every ordinary
  // feed to finish.  Each lane can borrow an idle worker from the other lane.
  // No feed is skipped; retry and ordinary use the identical updateFeed path.
  let ordinaryIndex=0,retryIndex=0,ordinaryFinished=0,ordinal=0;
  const results=[];
  const mixed=ordinary.length>0&&retry.length>0;
  const retryWorkers=mixed?Math.min(2,retry.length):0;
  const ordinaryWorkers=mixed?8-retryWorkers:8;
  function nextFeed(preferRetry){
   if(preferRetry){
    if(retryIndex<retry.length)return {feed:retry[retryIndex++],isOrdinary:false};
    if(ordinaryIndex<ordinary.length)return {feed:ordinary[ordinaryIndex++],isOrdinary:true};
   }else{
    if(ordinaryIndex<ordinary.length)return {feed:ordinary[ordinaryIndex++],isOrdinary:true};
    if(retryIndex<retry.length)return {feed:retry[retryIndex++],isOrdinary:false};
   }
   return null;
  }
  async function worker(preferRetry){
   let task;
   while((task=nextFeed(preferRetry))!==null){
    const f=task.feed;
    const observed=f94Run&&normalSet.has(f.id)?{run:f94Run,index:++ordinal}:null;
    // A fatal DB exception may interrupt this worker. The other workers are
    // always awaited before the refresh can be marked completed.
    const result=await updateFeed(f,observed);
    results.push(result);
    if(task.isOrdinary){
     ordinaryFinished++;
     if(mixed&&ordinaryFinished===ordinary.length){
      if(f94Run)f94Run.firstPassMs=f94Clock.now()-f94Start;
      rssRefreshFirstPassCompletedRun=thisRun;
     }
    }
   }
  }
  const pending=[
   ...Array.from({length:ordinaryWorkers},()=>worker(false)),
   ...Array.from({length:retryWorkers},()=>worker(true))
  ];
  const settled=await Promise.allSettled(pending);
  const failedWorker=settled.find(x=>x.status==='rejected');
  if(failedWorker)throw failedWorker.reason;
  return {checked:results.length,added:results.reduce((a,x)=>a+(x.added||0),0),errors:results.filter(x=>!x.ok),busy:false};
 }catch(e){rssRefreshFailed=true;throw e}
 finally{
  refreshing=false;rssRefreshCompletedRun=thisRun;rssRefreshCompletedAt=Date.now();rssRefreshCompletedFailed=rssRefreshFailed;
  if(f94Run){f94Run.wallMs=f94Clock.now()-f94Start;try{f94Write(f94Run)}catch(e){console.error('[Fix94B] RSS timing report write failed:',e?.message||e)}}
 }
}
const countRows=(sql,...params)=>db.prepare(sql).get(...params)?.n||0;
function overview(pid=1){
 const categories=db.prepare(`SELECT c.id,pcs.name,pcs.display_mode AS mode,
  (SELECT count(*) FROM articles a JOIN profile_feeds pf ON a.feed_id=pf.feed_id
   LEFT JOIN profile_article_state pas ON pas.profile_id=pf.profile_id AND pas.article_id=a.id
   WHERE pf.profile_id=? AND pf.category_id=c.id AND pas.read_at IS NULL AND nestrill_rss_visible(pf.profile_id,a.title,a.url)=1) AS unread,
  (SELECT count(*) FROM profile_feeds pf WHERE pf.profile_id=? AND pf.category_id=c.id) AS feed_count
  FROM profile_categories pc JOIN categories c ON c.id=pc.category_id
  JOIN profile_category_settings pcs ON pcs.profile_id=pc.profile_id AND pcs.category_id=c.id
  WHERE pc.profile_id=? ORDER BY pcs.sort_order,c.id`).all(pid,pid,pid);
 const feeds=db.prepare(`SELECT f.id,COALESCE(NULLIF(pf.display_title,''),f.title) AS title,f.title AS originalTitle,pf.display_title AS displayTitle,f.url,pf.category_id AS categoryId,f.checked,f.error,
  (SELECT count(*) FROM articles a LEFT JOIN profile_article_state pas ON pas.article_id=a.id AND pas.profile_id=pf.profile_id
   WHERE a.feed_id=f.id AND pas.read_at IS NULL AND nestrill_rss_visible(pf.profile_id,a.title,a.url)=1) AS unread
  FROM feeds f JOIN profile_feeds pf ON pf.feed_id=f.id AND pf.profile_id=? ORDER BY pf.category_id,pf.sort_order,title COLLATE NOCASE,f.id`).all(pid);
 return {categories,feeds,
  unread:countRows(`SELECT count(*) n FROM articles a JOIN profile_feeds pf ON pf.feed_id=a.feed_id
   LEFT JOIN profile_article_state pas ON pas.article_id=a.id AND pas.profile_id=pf.profile_id
   WHERE pf.profile_id=? AND pas.read_at IS NULL AND nestrill_rss_visible(pf.profile_id,a.title,a.url)=1`,pid),
  total:countRows('SELECT count(*) n FROM articles a JOIN profile_feeds pf ON pf.feed_id=a.feed_id WHERE pf.profile_id=? AND nestrill_rss_visible(pf.profile_id,a.title,a.url)=1',pid),refreshing,lastRun,
  rssRefreshRunId,firstPassCompletedRun:rssRefreshFirstPassCompletedRun};
}
function selectArticles(q,pid=1){
 const page=Math.min(int(q.get('page')),10000), limit=60;let where=['pf.profile_id=?'],params=[pid];
 if(q.get('category')){where.push('pf.category_id=?');params.push(int(q.get('category')))}
 if(q.get('feed')){where.push('f.id=?');params.push(int(q.get('feed')))}
 if(q.get('filter')==='unread')where.push('pas.read_at IS NULL');
 if(q.get('filter')==='starred')where.push('COALESCE(pas.starred,0)=1');
 where.push('nestrill_rss_visible(pf.profile_id,a.title,a.url)=1');
 const search=(q.get('q')||'').trim().slice(0,100);if(search){where.push("(a.title LIKE ? ESCAPE '\\' OR a.excerpt LIKE ? ESCAPE '\\')");const pat='%'+search.replace(/[\\%_]/g,'\\$&')+'%';params.push(pat,pat)}
 const from=`FROM articles a JOIN feeds f ON a.feed_id=f.id JOIN profile_feeds pf ON pf.feed_id=f.id
  LEFT JOIN profile_article_state pas ON pas.article_id=a.id AND pas.profile_id=pf.profile_id
  WHERE ${where.join(' AND ')}`;
 const rows=db.prepare(`SELECT a.id,a.title,a.url,a.excerpt,a.thumbnail,a.published,pas.read_at AS readAt,
  COALESCE(pas.starred,0) AS starred,COALESCE(NULLIF(pf.display_title,''),f.title) AS feedTitle,f.id AS feedId
  ${from} ORDER BY a.published DESC,a.id DESC LIMIT ? OFFSET ?`).all(...params,limit,page*limit);
 const total=countRows(`SELECT count(*) n ${from}`,...params);return {articles:rows,total,page,limit};
}
function opmlExport(pid=1){const cats=db.prepare(`SELECT c.id,pcs.name FROM profile_categories pc JOIN categories c ON c.id=pc.category_id JOIN profile_category_settings pcs ON pcs.profile_id=pc.profile_id AND pcs.category_id=c.id WHERE pc.profile_id=? ORDER BY pcs.sort_order,c.id`).all(pid);
 const feeds=db.prepare("SELECT f.url,COALESCE(NULLIF(pf.display_title,''),f.title) AS title,pf.category_id FROM feeds f JOIN profile_feeds pf ON pf.feed_id=f.id AND pf.profile_id=? ORDER BY pf.category_id,pf.sort_order,f.id").all(pid);
 let x=`<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>Nestrill Export</title></head><body>\n`;
 for(const c of cats){const nested=feeds.filter(f=>f.category_id===c.id);if(!nested.length)continue;x+=`<outline text="${escapeXml(c.name)}" title="${escapeXml(c.name)}">\n`;for(const f of nested)x+=`<outline type="rss" text="${escapeXml(f.title)}" title="${escapeXml(f.title)}" xmlUrl="${escapeXml(f.url)}"/>\n`;x+='</outline>\n';}return x+'</body></opml>';}
// OPML import is a two-phase, profile-bound operation. Preview never writes to
// SQLite. Confirmed imports are atomic and recheck duplicates in this profile.
// An OPML is portable data; a prior export source does not control eligibility.
const OPML_GENERIC_FAILURE='一部のRSSを登録できません。内容を確認してもう一度お試しください。';
const OPML_TICKET_TTL=3*60*1000;
const opmlTickets=new Map();
function examineOpml(xml,pid){
 const entries=parseOpml(xml),pending=[];let blocked=0;
 const seen=new Set();
 for(const e of entries){
  let url;try{url=validHttpUrl(e.url)}catch{blocked++;continue}
  const canonical=canonicalFeedIdentity(url);
  if(seen.has(canonical)||alreadyInProfile(url,pid)){blocked++;continue}
  seen.add(canonical);
  pending.push({url,name:String(e.category||'未分類').slice(0,100)||'未分類',title:String(e.title||new URL(url).hostname).slice(0,250)});
 }
 return {pending,blocked,total:entries.length};
}
function previewOpml(xml,pid,secretSession){
 // Avoid unlimited pending tickets and retain raw data only transiently.
 const now=Date.now();for(const [key,t] of opmlTickets)if(t.expires<now)opmlTickets.delete(key);
 if(opmlTickets.size>=64)opmlTickets.delete(opmlTickets.keys().next().value);
 const checked=examineOpml(xml,pid);
 if(!checked.pending.length)return {status:'none',total:checked.total,hasUnavailable:checked.blocked>0};
 const ticket=randomBytes(24).toString('hex');
 opmlTickets.set(ticket,{xml,pid,secretSession:secretSession||'',pending:JSON.stringify(checked.pending),blocked:checked.blocked,expires:now+OPML_TICKET_TTL});
 return {status:checked.blocked?'partial':'ready',ticket,needsConfirmation:checked.blocked>0};
}
function commitOpml(ticket,pid,secretSession,acceptPartial){
 const t=opmlTickets.get(ticket);opmlTickets.delete(ticket); // one-time even on errors
 if(!t||t.expires<Date.now()||t.pid!==pid||t.secretSession!==(secretSession||''))return {invalid:true};
 if(t.blocked&&!acceptPartial)return {confirmationRequired:true};
 let result;
 db.exec('BEGIN');try{
  const check=examineOpml(t.xml,pid);
  if(JSON.stringify(check.pending)!==t.pending||check.blocked!==t.blocked)throw Error('OPML_IMPORT_CHANGED');
  const findF=db.prepare('SELECT id FROM feeds WHERE url=?');
  const addF=db.prepare('INSERT OR IGNORE INTO feeds(url,title,category_id,created) VALUES(?,?,?,?)');
  let added=0;
  for(const e of check.pending){
   // Check again before category creation so rejected entries leave no debris.
   const old=findF.get(e.url);
   if(alreadyInProfile(e.url,pid))throw Error('OPML_IMPORT_CHANGED');
   const cid=ensureCategory(e.name,pid);
   addF.run(e.url,e.title,cid,Date.now());
   const f=findF.get(e.url);
   if(alreadyInProfile(e.url,pid))throw Error('OPML_IMPORT_CHANGED');
   added+=Number(profileFeed(pid,f.id,cid));
  }
  result={added,skipped:check.total-added,total:check.total,partial:check.blocked>0};
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');if(e.message==='OPML_IMPORT_CHANGED')return {invalid:true};throw e}
 return result;
}

// User-selected folders are read by this local Node.js server, not directly by the browser.
// Paths are never accepted in media requests. Only names inside the configured directory are served.
const WALLPAPER_EXT=new Set(['.png','.apng','.jpg','.jpeg','.webp','.gif','.mp4','.webm']);
const STILL_EXT=new Set(['.png','.jpg','.jpeg','.webp']);
const VIDEO_EXT=new Set(['.mp4','.webm']);
const colorOk=x=>typeof x==='string'&&/^#[a-f0-9]{6}$/i.test(x);
const numeric=(x,min,max,fallback)=>Math.max(min,Math.min(max,Number.isFinite(Number(x))?Number(x):fallback));
const fontOk=x=>typeof x==='string'&&/^[\p{L}\p{N}\s_,."'\-]{1,110}$/u.test(x);
function wallpaperFolder(folder){
 if(typeof folder!=='string'||folder.length>700||!folder.trim())return '';
 const full=path.resolve(folder.trim());
 if(!path.isAbsolute(folder.trim())||!fs.existsSync(full)||!fs.statSync(full).isDirectory())throw Error('背景フォルダが見つかりません。PC側の絶対パスを指定してください');
 return full;
}
function wallpaperFiles(folder,mode='all',mobile=false){
 if(!folder)return [];
 const names=fs.readdirSync(folder,{withFileTypes:true}).filter(x=>x.isFile()&&!x.isSymbolicLink()).map(x=>x.name).sort();
 const extensions=mobile?STILL_EXT:mode==='images'?new Set([...STILL_EXT,'.gif','.apng']):mode==='videos'?VIDEO_EXT:WALLPAPER_EXT;
 return names.filter(x=>{
  if(!extensions.has(path.extname(x).toLowerCase()))return false;
  if(mobile&&path.extname(x).toLowerCase()==='.png'){
   try{const f=fs.openSync(path.join(folder,x),'r');const b=Buffer.alloc(65536);const n=fs.readSync(f,b,0,b.length,0);fs.closeSync(f);if(b.subarray(0,n).includes(Buffer.from('6163544c','hex')))return false}catch{return false}
  }
  return true;
 }).slice(0,2500);
}
function folderFor(slot,mobile=false,secret=false){const t=getTheme(secret)[slot];return mobile?(t.mobileFolder||t.folder):t.folder;}
function wallpaperMime(file){return {'.png':'image/png','.apng':'image/apng','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mp4':'video/mp4','.webm':'video/webm'}[path.extname(file).toLowerCase()]||'application/octet-stream'}
function serveWallpaper(req,res,slot,name,mobile=false){
 const secret=!!req._secret;const folder=folderFor(slot,mobile,secret);if(!folder)return fail(res,'背景フォルダが未設定です',404);
 if(name!==path.basename(name)||name.includes('\\')||name.includes('/')||name==='.'||name==='..')return fail(res,'不正なファイル名です',400);
 if(!wallpaperFiles(folder,mobile?'images':getTheme(secret)[slot].folderKind||'all',mobile).includes(name))return fail(res,'画像・動画が見つかりません',404);
 const file=path.join(folder,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())return fail(res,'利用できないファイルです',404);
 const size=stat.size;const hdr={'Content-Type':wallpaperMime(name),'Accept-Ranges':'bytes','Cache-Control':'private, max-age=60','X-Content-Type-Options':'nosniff'};
 const range=req.headers.range;
 if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m)return fail(res,'不正な範囲です',416);
  let from=m[1]?Number(m[1]):0, to=m[2]?Number(m[2]):size-1;
  if(!m[1]&&m[2]){from=Math.max(0,size-Number(m[2]));to=size-1}
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||from>=size||to<from){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end()}
  to=Math.min(to,size-1);res.writeHead(206,{...hdr,'Content-Length':to-from+1,'Content-Range':`bytes ${from}-${to}/${size}`});return fs.createReadStream(file,{start:from,end:to}).pipe(res);
 }
 res.writeHead(200,{...hdr,'Content-Length':size});return fs.createReadStream(file).pipe(res);
}
function sanitizeStyle(x,prev){const z=x&&typeof x==='object'?x:{};return {font:fontOk(z.font)?z.font:prev.font,weight:numeric(z.weight,100,900,prev.weight),size:numeric(z.size,9,36,prev.size),color:colorOk(z.color)?z.color:prev.color,stroke:numeric(z.stroke,0,3,prev.stroke),strokeColor:colorOk(z.strokeColor)?z.strokeColor:prev.strokeColor,shadow:!!z.shadow,shadowColor:colorOk(z.shadowColor)?z.shadowColor:(prev.shadowColor||'#121a2d'),shadowOpacity:numeric(z.shadowOpacity,0,100,prev.shadowOpacity??60),shadowX:numeric(z.shadowX,-20,20,prev.shadowX??1),shadowY:numeric(z.shadowY,-20,20,prev.shadowY??2),shadowBlur:numeric(z.shadowBlur,0,20,prev.shadowBlur??3)}}
function sanitizeSeparator(x,prev){const z=x&&typeof x==='object'?x:{};return {enabled:z.enabled!==false,color:colorOk(z.color)?z.color:prev.color,opacity:numeric(z.opacity,0,100,prev.opacity),width:numeric(z.width,1,5,prev.width),style:['solid','dashed','dotted','double'].includes(z.style)?z.style:prev.style,inset:numeric(z.inset,0,60,prev.inset),spacing:numeric(z.spacing,0,24,prev.spacing)}}

const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpeg':'image/jpeg','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.apng':'image/apng','.mp4':'video/mp4','.webm':'video/webm'};
function serveFile(res,file){try{const bytes=fs.readFileSync(file);res.writeHead(200,{'Content-Type':mime[path.extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':/\.(html|js|css)$/.test(file)?'no-store':'public, max-age=600','X-Content-Type-Options':'nosniff'});res.end(bytes)}catch{fail(res,'見つかりません',404)}}
const HOST='127.0.0.1'; const PORT=8767;
// Local lifecycle control. Control credentials are never exposed by the health API.
const RUN_DIR=path.join(__dirname,'run');
const CONTROL_FILE=path.join(RUN_DIR,'nestrill-next-control.json');
const instanceId=randomBytes(16).toString('hex');
const controlSecret=randomBytes(32).toString('hex');
let shuttingDown=false;
function saveControlFile(){
 fs.mkdirSync(RUN_DIR,{recursive:true});
 fs.writeFileSync(CONTROL_FILE,JSON.stringify({app:'Nestrill-Next',instanceId,pid:process.pid,secret:controlSecret,startedAt:new Date().toISOString()}),{mode:0o600});
}
function clearControlFile(){
 try{const contents=JSON.parse(fs.readFileSync(CONTROL_FILE,'utf8'));if(contents.instanceId===instanceId)fs.unlinkSync(CONTROL_FILE)}catch{}
}
function shutdownServer(reason){
 if(shuttingDown)return;
 shuttingDown=true;
 console.log(`[STOP] ${reason} at ${new Date().toISOString()}`);
 try{mobileReader.stop()}catch(e){console.error('[MOBILE] shutdown:',e.message)}
 const began=Date.now();
 const cleanUp=()=>{
  if(refreshing&&Date.now()-began<30000)return setTimeout(cleanUp,200);
  if(refreshing)console.error('[STOP] RSS refresh did not finish before shutdown timeout');
  try{db.close()}catch(e){console.error('[STOP] SQLite close failed:',e)}
  clearControlFile();
  process.exit(0);
 };
 server.close(cleanUp);
 setTimeout(()=>{console.error('[STOP] Graceful shutdown timed out');clearControlFile();process.exit(2)},35000).unref();
}
process.on('SIGINT',()=>shutdownServer('SIGINT'));
process.on('SIGTERM',()=>shutdownServer('SIGTERM'));
process.on('uncaughtException',e=>{console.error('[FATAL] Uncaught exception',e?.stack||e);process.exit(1)});
process.on('unhandledRejection',e=>{console.error('[FATAL] Unhandled rejection',e?.stack||e);process.exit(1)});

// Fix84A: mobile reader is DISABLED until a verified local control request enables it.
// The PC browser remains strictly bound to 127.0.0.1:8767.
// Fix103I: reuse the same E2 job/cache and profile-scoped preview as desktop.
// Mobile is authenticated, normal-profile only, manual-search only.
const mobileE2={
 status(pid){
  const data=aiExternal.status(pid);
  const items=rssHide.filter(pid,aiSourceFeedback.filter(pid,data.items||[],{externalPreview:true}));
  return {...data,items};
 },
 start(pid){return aiExternal.start(pid)}
};
const mobileConditional={
 catalog(){return aiRandom.catalog()},
 status(pid){const data=aiConditional.status(pid);return {...data,items:rssHide.filter(pid,aiSourceFeedback.filter(pid,data.items||[],{externalPreview:true}))}},
 start(pid,options){return aiConditional.start(pid,options)}
};
const mobileReader=require('./mobile/mobile-server').create({db,profileList,overview,selectArticles,aiRecommend,aiSourceFeedback,startMobileRssRefresh,mobileRefreshStatus,readMobileBackground,mobileBackgroundBytes,readMobilePalette,mobileE2,mobileConditional});
const server=http.createServer(async(req,res)=>{
 try{
 const rawHost=(req.headers.host||'').split(':')[0].toLowerCase();
 // Local-only unless deliberately proxied by Tailscale Serve to the loopback listener.
 if(!['127.0.0.1','localhost','[::1]'].includes(rawHost)&&!rawHost.endsWith('.ts.net'))return fail(res,'無効なホスト',403);
 const hostProto=req.headers.host?.startsWith('[')?'http://':'http://';const u=new URL(req.url,`${hostProto}${req.headers.host||'localhost'}`);const route=u.pathname;
 if(!['GET','POST','DELETE','PATCH'].includes(req.method))return fail(res,'許可されていません',405);
 if(req.method!=='GET'){
  const origin=req.headers.origin;if(origin){try{const o=new URL(origin);if(o.host!==req.headers.host) return fail(res,'不正なOrigin',403)}catch{return fail(res,'不正なOrigin',403)}}
  const type=req.headers['content-type']||'';
  if(!route.startsWith('/api/background/')&&!route.startsWith('/api/placeholder/')&&!route.startsWith('/api/mobile-background/image')&&!type.startsWith('application/json')&&!type.startsWith('text/xml')&&!type.startsWith('application/xml'))return fail(res,'Content-Typeが不正です',415);
 }
 const openRoute=route.match(/^\/api\/ai\/open\/([a-zA-Z0-9_-]+)$/);
 if(openRoute&&req.method==='GET')return aiOpen.handle(req,res,openRoute[1]);
 if(route==='/api/_control/health'&&req.method==='GET')return json(res,200,{app:'Nestrill-Next',instanceId,pid:process.pid,version:'Nestrill-Next-UI02',uptimeSec:Math.floor(process.uptime())});
 // PC-only startup preference; never available through mobile or remote reverse proxies.
 if(route==='/api/_local/autostart'&&['GET','POST'].includes(req.method)){
  if(!autostartRequestIsLocal(req))return fail(res,'この設定はPC本体からのみ変更できます',403);
  if(process.platform!=='win32'){
   if(req.method==='GET')return json(res,200,{supported:false,enabled:false,conflict:false});
   return fail(res,'Windowsでのみ使用できる設定です',501);
  }
  if(req.method==='GET'){
   try{return json(res,200,await runAutostartAction('Status'))}
   catch(e){return fail(res,'自動起動の状態を確認できません: '+e.message,500)}
  }
  const options=JSON.parse((await body(req,256)).toString('utf8'));
  if(typeof options.enabled!=='boolean')return fail(res,'設定値が不正です',400);
  if(autostartOperationBusy)return fail(res,'別の自動起動設定操作を処理中です',409);
  autostartOperationBusy=true;
  try{
   const old=await runAutostartAction('Status');
   if(old.conflict)return fail(res,'別のNestrillフォルダが自動起動を設定しています。上書き・削除はしません',409);
   if(old.enabled!==options.enabled)await runAutostartAction(options.enabled?'Enable':'Disable');
   const latest=await runAutostartAction('Status');
   if(latest.conflict||latest.enabled!==options.enabled)return fail(res,'変更結果を確認できませんでした',409);
   return json(res,200,latest);
  }catch(e){return fail(res,'Windowsの自動起動を変更できません: '+e.message,500)}
  finally{autostartOperationBusy=false}
 }

 if(route==='/api/_control/stop'&&req.method==='POST'){
  const address=req.socket.remoteAddress||'';
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address))return fail(res,'Local requests only',403);
  const supplied=String(req.headers['x-nestrill-control']||'');
  const a=Buffer.from(supplied);const b=Buffer.from(controlSecret);
  if(a.length!==b.length||!timingSafeEqual(a,b))return fail(res,'Unauthorized',403);
  json(res,200,{ok:true,stopping:true});
  setImmediate(()=>shutdownServer('authenticated local request'));
  return;
 }

 // Optional mobile access: ONLY callable over loopback with the lifecycle control secret.
 // Access never exposes the PC API, secret profile, or AI generation endpoints.
 if(route==='/api/_control/mobile'&&req.method==='POST'){
  const address=req.socket.remoteAddress||'';
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address))return fail(res,'Local requests only',403);
  const supplied=String(req.headers['x-nestrill-control']||'');
  const a=Buffer.from(supplied),b=Buffer.from(controlSecret);
  if(a.length!==b.length||!timingSafeEqual(a,b))return fail(res,'Unauthorized',403);
  const x=JSON.parse((await body(req,1024)).toString('utf8'));
  if(x.action==='enable'){
   const host=String(x.host||'');
   if(!mobileReader.localPrivateAddresses().includes(host))return fail(res,'PCのローカルIPv4を指定してください',400);
   try{return json(res,200,await mobileReader.start(host))}catch(e){return fail(res,'スマホ接続を開始できません: '+e.message,409)}
  }
  if(x.action==='disable'){mobileReader.stop();return json(res,200,{enabled:false})}
  if(x.action==='status')return json(res,200,mobileReader.info());
  return fail(res,'操作が不正です',400);
 }

 // RC04: secret mode is retired in Standard and X Edition.
 // No secret session can be issued; even old/stale tokens are rejected.
 if(route.startsWith('/api/secret/'))return fail(res,'シークレット機能は廃止されました',410);
 if(req.headers['x-nestrill-secret'])return fail(res,'シークレットセッションは利用できません',403);
 // An archived secret profile must never become accessible by a guessed ID.
 if(SECRET_ID>0 && Number(req.headers['x-nestrill-profile-id'])===SECRET_ID)
  return fail(res,'このプロファイルは利用できません',403);
 // Appearance presets are global across profiles; applying one never changes RSS membership.
 if(route==='/api/presets'&&req.method==='GET')return json(res,200,{presets:db.prepare('SELECT id,name,created,updated,is_secret AS isSecret FROM appearance_presets WHERE is_secret=0 OR ? ORDER BY is_secret,name COLLATE NOCASE,id').all(req._secret?1:0)});
 if(route==='/api/presets'&&req.method==='POST'){
  const x=JSON.parse((await body(req)).toString());let name;try{name=validLabel(x.name)}catch(e){return fail(res,e.message)}
  try{const now=Date.now(),r=db.prepare('INSERT INTO appearance_presets(name,theme,created,updated,is_secret) VALUES(?,?,?,?,?)').run(name,JSON.stringify(getTheme(!!req._secret)),now,now,req._secret?1:0);return json(res,200,{id:Number(r.lastInsertRowid),name})}
  catch{return fail(res,'同名のプリセットが存在します')}
 }
 const pre=route.match(/^\/api\/presets\/(\d+)(?:\/(apply|duplicate))?$/);
 if(pre){const id=int(pre[1]),mode=pre[2]||'',preset=db.prepare('SELECT * FROM appearance_presets WHERE id=? AND (is_secret=0 OR ?)').get(id,req._secret?1:0);if(!preset)return fail(res,'プリセットがありません',404);
  if(req._secret&&!preset.is_secret&&['PATCH','DELETE'].includes(req.method))return fail(res,'共通プリセットの変更は通常モードで行ってください',403);
  if(req.method==='PATCH'&&!mode){const x=JSON.parse((await body(req)).toString());let name;try{name=validLabel(x.name)}catch(e){return fail(res,e.message)}
   try{db.prepare('UPDATE appearance_presets SET name=?,updated=? WHERE id=?').run(name,Date.now(),id);return json(res,200,{ok:true})}catch{return fail(res,'同名のプリセットが存在します')}
  }
  if(req.method==='DELETE'&&!mode){db.prepare('DELETE FROM appearance_presets WHERE id=?').run(id);if(id===secretDefault())db.prepare("DELETE FROM settings WHERE key='secret_default_preset'").run();return json(res,200,{ok:true})}
  if(req.method==='POST'&&mode==='apply'){try{const saved=JSON.parse(preset.theme);if(!saved.left||!saved.right||!saved.shared)throw Error();setTheme(saved,!!req._secret);return json(res,200,{ok:true,theme:getTheme(!!req._secret)})}catch{return fail(res,'プリセットが破損しています')}}
  if(req.method==='POST'&&mode==='duplicate'){const x=JSON.parse((await body(req)).toString());let name;try{name=validLabel(x.name)}catch(e){return fail(res,e.message)}
   try{const now=Date.now(),r=db.prepare('INSERT INTO appearance_presets(name,theme,created,updated,is_secret) VALUES(?,?,?,?,?)').run(name,preset.theme,now,now,req._secret?1:0);return json(res,200,{id:Number(r.lastInsertRowid),name})}catch{return fail(res,'同名のプリセットが存在します')}
  }
 }
 // Each browser may view a different profile; browser sends its profile ID per request.
 // These endpoints manage account display labels only. No external login occurs here.
 if(route.startsWith('/api/youtube/')){
  const pid=profileId(req);
  const trackedJson=(r,status,data)=>json(r,status,route==='/api/youtube/videos'&&data?.videos
    ?{...data,videos:withOpenLinks(req,pid,'youtube',data.videos)}:data);
  const handled=await youtubeSource.handle(req,res,route,u,pid,body,trackedJson,fail);
  if(handled)return;
 }
 if(route==='/api/source-accounts'&&req.method==='GET'){
  return json(res,200,{accounts:db.prepare('SELECT id,service,label,created,updated,sort_order FROM source_accounts WHERE profile_id=? ORDER BY service,sort_order,id').all(profileId(req))});
 }
 // This changes only the ordering of YouTube groups inside the active profile.
// Neither the group membership nor the YouTube channel subscriptions are touched.
if(route==='/api/source-accounts/order'&&req.method==='POST'){
 const x=JSON.parse((await body(req)).toString());const pid=profileId(req);
 const target=int(x.id),direction=x.direction;
 if(!Number.isSafeInteger(target)||target<1||!['up','down'].includes(direction))return fail(res,'並び替えの指定が不正です',400);
 const owner=db.prepare("SELECT id FROM source_accounts WHERE id=? AND profile_id=? AND service='youtube'").get(target,pid);
 if(!owner)return fail(res,'このプロファイルのYouTubeグループがありません',404);
 const ids=db.prepare("SELECT id FROM source_accounts WHERE profile_id=? AND service='youtube' ORDER BY sort_order,id").all(pid).map(r=>r.id);
 const i=ids.indexOf(target),j=i+(direction==='up'?-1:1);
 if(i<0||j<0||j>=ids.length)return fail(res,'これ以上移動できません',409);
 [ids[i],ids[j]]=[ids[j],ids[i]];
 db.exec('BEGIN');
 try{
  const setOrder=db.prepare('UPDATE source_accounts SET sort_order=? WHERE id=? AND profile_id=?');
  for(let k=0;k<ids.length;k++)setOrder.run(k+1,ids[k],pid);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e}
 return json(res,200,{ok:true,order:ids});
}
if(route==='/api/source-accounts'&&req.method==='POST'){
  const x=JSON.parse((await body(req)).toString());
  if(!['youtube','mail'].includes(x.service))return fail(res,'情報源を選択してください');
  let label;try{label=validLabel(x.label)}catch(e){return fail(res,e.message)}
  try{const now=Date.now();const pid=profileId(req);
   const nextOrder=db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS pos FROM source_accounts WHERE profile_id=? AND service=?').get(pid,x.service).pos;
   const r=db.prepare('INSERT INTO source_accounts(profile_id,service,label,created,updated,sort_order) VALUES(?,?,?,?,?,?)').run(pid,x.service,label,now,now,nextOrder);
   return json(res,200,{id:Number(r.lastInsertRowid),service:x.service,label});
  }catch(e){if(String(e.message).includes('UNIQUE'))return fail(res,'この情報源には同名の表示枠があります',409);throw e}
 }
 const src=route.match(/^\/api\/source-accounts\/(\d+)$/);
 if(src){const id=int(src[1]),pid=profileId(req);
  const row=db.prepare('SELECT id,service,label FROM source_accounts WHERE id=? AND profile_id=?').get(id,pid);
  if(!row)return fail(res,'このプロファイルに登録された表示枠がありません',404);
  if(req.method==='PATCH'){
   const x=JSON.parse((await body(req)).toString());let label;try{label=validLabel(x.label)}catch(e){return fail(res,e.message)}
   try{db.prepare('UPDATE source_accounts SET label=?,updated=? WHERE id=? AND profile_id=?').run(label,Date.now(),id,pid);return json(res,200,{ok:true});}
   catch(e){if(String(e.message).includes('UNIQUE'))return fail(res,'この情報源には同名の表示枠があります',409);throw e}
  }
  if(req.method==='DELETE'){db.prepare('DELETE FROM source_accounts WHERE id=? AND profile_id=?').run(id,pid);return json(res,200,{ok:true})}
 }
 if(route==='/api/profiles'&&req.method==='GET')return json(res,200,{profiles:req._secret?[]:profileList(),defaultId:1});
 if(route==='/api/profiles'&&req._secret)return fail(res,'プロファイル管理は通常モードで行ってください',403);
 if(route==='/api/profiles'&&req.method==='POST'){
  const x=JSON.parse((await body(req)).toString());let name;try{name=validLabel(x.name)}catch(e){return fail(res,e.message)}
  const base=int(x.copyFrom);if(base&&!db.prepare('SELECT id FROM profiles WHERE id=? AND is_secret=0').get(base))return fail(res,'複製元のプロファイルがありません');
  db.exec('BEGIN');try{
   const r=db.prepare('INSERT INTO profiles(name,created) VALUES(?,?)').run(name,Date.now());const id=Number(r.lastInsertRowid);
   if(base){db.prepare('INSERT INTO profile_categories SELECT ?,category_id FROM profile_categories WHERE profile_id=?').run(id,base);db.prepare('INSERT INTO profile_category_settings(profile_id,category_id,name,display_mode,sort_order) SELECT ?,category_id,name,display_mode,sort_order FROM profile_category_settings WHERE profile_id=?').run(id,base);db.prepare('INSERT INTO profile_feeds(profile_id,feed_id,category_id,display_title,sort_order) SELECT ?,feed_id,category_id,display_title,sort_order FROM profile_feeds WHERE profile_id=?').run(id,base);db.prepare('INSERT INTO source_accounts(profile_id,service,label,created,updated,sort_order) SELECT ?,service,label,created,updated,sort_order FROM source_accounts WHERE profile_id=?').run(id,base)}
   else profileCategory(id,getDefault());
   db.exec('COMMIT');return json(res,200,{id,name});
  }catch(e){db.exec('ROLLBACK');return fail(res,'同名のプロファイルが存在します')}
 }
 const prof=route.match(/^\/api\/profiles\/(\d+)$/);
 if(prof){const id=int(prof[1]);if(!db.prepare('SELECT id FROM profiles WHERE id=? AND is_secret=0').get(id))return fail(res,'プロファイルがありません',404);
  if(req.method==='PATCH'){const x=JSON.parse((await body(req)).toString());let name;try{name=validLabel(x.name)}catch(e){return fail(res,e.message)}
   try{db.prepare('UPDATE profiles SET name=? WHERE id=?').run(name,id);return json(res,200,{ok:true})}catch{return fail(res,'同名のプロファイルが存在します')}
  }
  if(req.method==='DELETE'){if(id===1)return fail(res,'Mainプロファイルは削除できません');db.prepare('DELETE FROM profiles WHERE id=?').run(id);return json(res,200,{ok:true})}
 }
 if(route==='/api/wallpaper/list'&&req.method==='GET'){
  const slot=u.searchParams.get('slot'),mobile=u.searchParams.get('mobile')==='1';
  if(!['left','right','shared'].includes(slot))return fail(res,'不正なペイン',400);
  const t=getTheme(!!req._secret)[slot];let folder=mobile?(t.mobileFolder||t.folder):t.folder;
  try{if(!folder)return json(res,200,{files:[],count:0});folder=wallpaperFolder(folder);
   const files=wallpaperFiles(folder,mobile?'images':t.folderKind||'all',mobile);
   return json(res,200,{files:files.map(name=>({url:`/api/wallpaper/file/${slot}/${encodeURIComponent(name)}${mobile?'?mobile=1':''}${req._secret?(mobile?'&':'?')+'secret='+encodeURIComponent(req._secretToken):''}`,name,video:VIDEO_EXT.has(path.extname(name).toLowerCase())})),count:files.length});
  }catch(e){return fail(res,e.message,400)}
 }
 const wall=route.match(/^\/api\/wallpaper\/file\/(left|right|shared)\/(.+)$/);
 if(wall&&req.method==='GET'){
  const token=u.searchParams.get('secret');
  if(token){const expiry=secretSessions.get(token);if(!expiry||expiry<Date.now())return fail(res,'シークレット背景へのアクセス期限切れ',403);req._secret=true;req._secretToken=token}
  return serveWallpaper(req,res,wall[1],decodeURIComponent(wall[2]),u.searchParams.get('mobile')==='1');
 }

 // D3: local Ollama only. No model is selected or run automatically.
 // User-supplied quality reports are not semantic dislike of a topic.
 if(route==='/api/ai/source-feedback'&&req.method==='GET'){
  try{
   const pid=profileId(req),itemId=u.searchParams.get('itemId');
   return json(res,200,itemId?aiSourceFeedback.detail(pid,itemId):aiSourceFeedback.list(pid));
  }catch(e){return fail(res,e.message,400)}
 }
 if(route==='/api/ai/source-feedback'&&req.method==='POST'){
  try{
   const x=JSON.parse((await body(req,1800)).toString('utf8'));
   return json(res,200,aiSourceFeedback.report(profileId(req),x));
  }catch(e){return fail(res,e.message,400)}
 }
 if(route==='/api/ai/open-status'&&req.method==='GET')return json(res,200,aiOpen.status(profileId(req)));
 if(route==='/api/ai/open-signals/reset'&&req.method==='POST'){
  try{
   const x=JSON.parse((await body(req,512)).toString('utf8'));
   if(!x||x.confirm!=='reset-open-signals'||!Number.isSafeInteger(x.expectedTotal)||x.expectedTotal<0)return fail(res,'リセットの確認内容が不正です',400);
   return json(res,200,aiOpen.reset(profileId(req),x.expectedTotal));
  }catch(e){return fail(res,e.message||'閲覧シグナルをリセットできません',409)}
 }
 if(route==='/api/ai/model'&&req.method==='GET')return json(res,200,aiRecommend.modelConfig(profileId(req)));
 if(route==='/api/ai/models'&&req.method==='GET'){
  try{return json(res,200,{models:await aiRecommend.listModels()})}
  catch(e){return json(res,200,{models:[],error:String(e.message).slice(0,160)})}
 }
 if(route==='/api/ai/model'&&req.method==='POST'){
  try{const x=JSON.parse((await body(req,1000)).toString('utf8'));
   return json(res,200,await aiRecommend.setModel(profileId(req),x.model));
  }catch(e){return fail(res,e.message||'AIモデルを設定できません',400)}
 }
 // AI D3: per-profile interests, feedback, and optional local semantic evaluation.
 // Phase E1: save independent registered/external split for each 7:2:1 recommendation class.
 // No change to the existing D3 recommendations until external sources are implemented.
 if(route==='/api/ai/source-mix'&&req.method==='GET')return json(res,200,aiRecommend.sourceMix(profileId(req)));
 if(route==='/api/ai/source-mix'&&req.method==='POST'){
  try{
   const x=JSON.parse((await body(req,1200)).toString('utf8'));
   return json(res,200,aiRecommend.putSourceMix(profileId(req),x));
  }catch(e){return fail(res,e.message||'情報源の配分を保存できません',400)}
 }
 if(route==='/api/ai/exclusions'&&req.method==='GET')return json(res,200,aiRecommend.exclusions(profileId(req)));
 if(route==='/api/ai/exclusions'&&req.method==='POST'){
  try{const x=JSON.parse((await body(req,12000)).toString('utf8'));
   return json(res,200,aiRecommend.putExclusions(profileId(req),x.text));
  }catch(e){return fail(res,e.message||'除外リストを保存できません',400)}
 }
 if(route==='/api/ai/interests'&&req.method==='GET'){
  const scope=u.searchParams.get('scope');
  if(scope!==null&&!['rss','youtube','shared'].includes(scope))return fail(res,'関心リストの対象が不正です',400);
  return json(res,200,scope===null?aiRecommend.interests(profileId(req)):aiRecommend.interestsScoped(profileId(req),scope));
 }
 if(route==='/api/ai/interests'&&req.method==='POST'){
  try{const x=JSON.parse((await body(req,12000)).toString('utf8'));
   return json(res,200,aiRecommend.putInterests(profileId(req),x.text,x.scope===undefined?'rss':x.scope));
  }catch(e){return fail(res,e.message||'関心リストを保存できません',400)}
 }
 if(route==='/api/rss/hide-rules'&&req.method==='GET')return json(res,200,rssHide.list(profileId(req)));
 if(route==='/api/rss/hide-rules'&&req.method==='POST'){
  try{const x=JSON.parse((await body(req,4096)).toString('utf8'));
   return json(res,200,rssHide.add(profileId(req),x));
  }catch(e){return fail(res,e.message||'非表示ルールを保存できません',400)}
 }
 if(route==='/api/rss/hide-rules'&&req.method==='PATCH'){
  try{const x=JSON.parse((await body(req,4096)).toString('utf8'));
   return json(res,200,rssHide.update(profileId(req),x));
  }catch(e){return fail(res,e.message||'非表示ルールを変更できません',400)}
 }
 if(route==='/api/rss/hide-rules'&&req.method==='DELETE'){
  try{const x=JSON.parse((await body(req,512)).toString('utf8'));
   return json(res,200,rssHide.remove(profileId(req),x.id));
  }catch(e){return fail(res,e.message||'非表示ルールを解除できません',400)}
 }
 if(route==='/api/ai/feedback/history/bulk'&&req.method==='POST'){
  try{const x=JSON.parse((await body(req,8000)).toString('utf8'));
   return json(res,200,aiRecommend.deleteFeedbackBulk(profileId(req),x));
  }catch(e){return fail(res,e.message||'評価履歴を削除できません',400)}
 }
 if(route==='/api/ai/feedback/history'&&req.method==='GET'){
  try{
   const x=Object.fromEntries(u.searchParams);
   return json(res,200,aiRecommend.feedbackHistory(profileId(req),x));
  }catch(e){return fail(res,e.message||'評価履歴を取得できません',400)}
 }
 if(route==='/api/ai/feedback/history'&&req.method==='POST'){
  try{
   const x=JSON.parse((await body(req,2400)).toString('utf8'));
   return json(res,200,aiRecommend.editFeedbackHistory(profileId(req),x));
  }catch(e){return fail(res,e.message||'評価履歴を変更できません',400)}
 }
 // UI06: right-click RSS rating only; never overwrite an existing freeform comment.
 if(route==='/api/ai/feedback/rating'&&req.method==='POST'){
  try{const x=JSON.parse((await body(req,1200)).toString('utf8'));
   return json(res,200,aiRecommend.setFeedbackRating(profileId(req),x));
  }catch(e){return fail(res,e.message||'評価を保存できません',400)}
 }
 if(route==='/api/ai/feedback'&&req.method==='POST'){
  try{
   const x=JSON.parse((await body(req,2400)).toString('utf8'));
   return json(res,200,aiRecommend.putFeedback(profileId(req),x));
  }catch(e){return fail(res,e.message||'評価を保存できません',400)}
 }
 // E2: external article discovery is an EXPLICIT manual action. Interests are
 // sent to Google News only when /refresh is invoked; no background poll sends them.
 // GenreTrial01: opt-in branch. No access to user interests, feedback, opens or Gemma.
 if(route==='/api/ai/random/catalog'&&req.method==='GET')return json(res,200,{groups:aiRandom.catalog(),maxQueries:12});
 if(route==='/api/ai/random'&&req.method==='GET')return json(res,200,aiRandom.status(profileId(req)));
 if(route==='/api/ai/random/refresh'&&req.method==='POST'){
  try{
   const options=JSON.parse((await body(req,4500)).toString('utf8'));
   return json(res,200,aiRandom.start(profileId(req),options));
  }catch(e){return fail(res,String(e.message||e),400)}
 }
 // ConditionTrial01: profile-scoped, isolated exploratory controls. Normal E2 is unchanged.
 if(route==='/api/ai/conditional'&&req.method==='GET'){
  const pid=profileId(req),data=aiConditional.status(pid);
  // Apply the same profile-scoped display/source exclusions as ordinary E2.
  // This only filters the response: do not alter the random result cache,
  // rating evidence, history, or SQLite rows. A 40-item sample can show <40.
  const filtered=rssHide.filter(pid,aiSourceFeedback.filter(pid,data.items||[],{externalPreview:true}));
  const offset=Math.max(0,Math.min(1000,Math.floor(Number(u.searchParams.get('offset'))||0)));
  const limit=Math.max(1,Math.min(40,Math.floor(Number(u.searchParams.get('limit'))||40)));
  const page=filtered.slice(offset,offset+limit);
  // Navigation-confirmed opens use the existing signed redirect. Do not prefetch
  // Google URLs for this trial; opens remain weak evidence, never a like.
  return json(res,200,{...data,sourceHidden:(data.items||[]).length-filtered.length,
   totalVisible:filtered.length,hasMore:offset+page.length<filtered.length,offset,
   items:page.map(item=>({...item,
   openUrl:aiOpen.href(pid,'rss',{...item,id:'x:'+item.id,publisherHost:item.publisherHost},req)}))});
 }
 // Trial05: bounded, opt-in article-image metadata for the current profile's
 // visible, non-excluded conditional results only. No remote URL input allowed.
 if(route==='/api/ai/conditional/preview'&&req.method==='GET'){
  // A custom request header prevents incidental cross-site image tags or
  // navigation from triggering publisher metadata lookups.
  if(req.headers['x-nestrill-preview']!=='enabled')return fail(res,'画像補完が有効ではありません',403);
  const pid=profileId(req),id=String(u.searchParams.get('id')||'');
  if(!/^[a-f0-9]{32}$/.test(id))return fail(res,'記事がありません',404);
  const item=(aiConditional.status(pid).items||[]).find(x=>x.id===id);
  if(!item||!rssHide.filter(pid,aiSourceFeedback.filter(pid,[item],{externalPreview:true})).length)return fail(res,'記事がありません',404);
  return json(res,200,aiNewsPreview.request(item));
 }
 if(route==='/api/ai/conditional/refresh'&&req.method==='POST'){
  try{const x=JSON.parse((await body(req,4500)).toString('utf8'));
   return json(res,200,aiConditional.start(profileId(req),x));
  }catch(e){return fail(res,String(e.message||e),400)}
 }
 if(route==='/api/ai/conditional/rating'&&req.method==='POST'){
  try{const x=JSON.parse((await body(req,512)).toString('utf8'));
   return json(res,200,aiConditional.rate(profileId(req),x));
  }catch(e){return fail(res,String(e.message||e),400)}
 }
 if(route==='/api/ai/external'&&req.method==='GET'){const pid=profileId(req);const data=aiExternal.status(pid);
  const filtered=rssHide.filter(pid,aiSourceFeedback.filter(pid,data.items||[],{externalPreview:true}));
  return json(res,200,{...data,sourceHidden:(data.items||[]).length-filtered.length,items:withOpenLinks(req,pid,'rss',filtered,true)});}
 if(route==='/api/ai/external/settings'&&req.method==='POST'){
  try{const x=JSON.parse((await body(req,1400)).toString('utf8'));
   return json(res,200,aiExternal.updateSettings(profileId(req),x));
  }catch(e){return fail(res,String(e.message||e),400)}
 }
 if(route==='/api/ai/external/refresh'&&req.method==='POST'){
  try{return json(res,200,aiExternal.start(profileId(req)))}
  catch(e){return fail(res,String(e.message||e),400)}
 }
 if(route==='/api/ai/blend/refresh'&&req.method==='POST'){
  try{const x=JSON.parse((await body(req,1000)).toString('utf8'));
   return json(res,200,aiRecommend.startBlend(profileId(req),x.kind));
  }catch(e){return fail(res,String(e.message||e),400)}
 }
 if(route==='/api/ai/recommendations'&&req.method==='GET'){
  const kind=u.searchParams.get('kind');if(!['rss','youtube'].includes(kind))return fail(res,'対象が不正です',400);
  const pid=profileId(req),data=aiRecommend.get(pid,kind);
  const filtered=kind==='rss'?rssHide.filter(pid,aiSourceFeedback.filter(pid,data.items||[])):data.items||[];
  const live=kind==='rss'?rssHide.filter(pid,aiSourceFeedback.filter(pid,data.blendPreviewItems||[])):[];
  return json(res,200,{...data,sourceHidden:(data.items||[]).length-filtered.length,
   blendPreviewItems:withOpenLinks(req,pid,kind,live),items:withOpenLinks(req,pid,kind,filtered)});
 }
 if(route==='/api/ai/recommendations/refresh'&&req.method==='POST'){
  const x=JSON.parse((await body(req,1000)).toString('utf8'));
  if(!['rss','youtube'].includes(x.kind))return fail(res,'対象が不正です',400);
  return json(res,200,aiRecommend.start(profileId(req),x.kind));
 }
 if(route==='/api/overview'&&req.method==='GET')return json(res,200,overview(profileId(req)));
 if(route==='/api/articles'&&req.method==='GET'){const pid=profileId(req),data=selectArticles(u.searchParams,pid);
  return json(res,200,{...data,articles:withOpenLinks(req,pid,'rss',data.articles)});}
 if(route==='/api/pick-folder'&&req.method==='POST'){
  // Local Windows-only GUI interaction; never expose it through the future Tailnet interface.
  const host=(req.headers.host||'').split(':')[0].toLowerCase();
  if(!['localhost','127.0.0.1'].includes(host))return fail(res,'フォルダ選択は自宅PCのブラウザからのみ利用できます',403);
  if(process.platform!=='win32')return fail(res,'フォルダ選択はWindows上でのみ利用できます',501);
  const x=JSON.parse((await body(req,2048)).toString('utf8'));
  const supplied=typeof x.initialDirectory==='string'&&x.initialDirectory.length<700?x.initialDirectory.trim():'';
  const defaults=[supplied,path.join(DATA,'backgrounds'),os.homedir()];
  const initial=defaults.find(d=>d&&path.isAbsolute(d)&&fs.existsSync(d)&&fs.statSync(d).isDirectory())||os.homedir();
  const script=path.join(__dirname,'scripts','Pick-BackgroundFolder.ps1');
  return await new Promise(resolve=>{
   execFile('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script,'-InitialDirectory',initial],
    {timeout:300000,maxBuffer:32768,windowsHide:true},(error,stdout,stderr)=>{
     if(res.writableEnded)return resolve();
     if(error){console.error('[FOLDER PICKER]',error.message,stderr?.slice(0,300));fail(res,'フォルダ選択ダイアログを開けませんでした。手入力も利用できます。',500);return resolve()}
     const result=String(stdout||'').trim();
     if(result==='CANCELLED'){json(res,200,{path:'',cancelled:true});return resolve()}
     if(!result.startsWith('SELECTED:')){fail(res,'フォルダ選択結果を受け取れませんでした',500);return resolve()}
     const picked=Buffer.from(result.slice(9),'base64').toString('utf8');
     try{const full=wallpaperFolder(picked);json(res,200,{path:full,cancelled:false})}catch(e){fail(res,e.message,400)}
     resolve();
    });
  });
 }
 if(route==='/api/fonts'&&req.method==='GET')return json(res,200,{fonts:await listInstalledFonts(),detected:process.platform==='win32'&&fontCache.names.length>FALLBACK_FONTS.length});
 // Fix99A: only the loopback PC UI may configure the dedicated mobile background.
 if(route==='/api/mobile-background'&&req.method==='GET'){
  if(req._secret)return fail(res,'通常モードで設定してください',403);
  return json(res,200,readMobileBackground());
 }
 if(route==='/api/mobile-background'&&req.method==='POST'){
  if(req._secret)return fail(res,'通常モードで設定してください',403);
  const v=JSON.parse((await body(req,2048)).toString('utf8'));
  if(!v||typeof v!=='object'||!['color','image'].includes(v.mode)||!colorOk(v.color))return fail(res,'スマホ背景設定が不正です');
  const image=typeof v.image==='string'&&MOBILE_BG_NAME.test(v.image)&&
   fs.existsSync(path.join(MOBILE_BG_DIR,v.image))?v.image:'';
  if(v.mode==='image'&&!image)return fail(res,'スマホ用の静止画像を選択してください');
  const cfg={mode:v.mode,color:v.color,image};writeMobileBackground(cfg);
  return json(res,200,{ok:true,...cfg});
 }
 if(route==='/api/mobile-palette'&&req.method==='GET'){
  if(req._secret)return fail(res,'通常モードで設定してください',403);
  return json(res,200,readMobilePalette());
 }
 if(route==='/api/mobile-palette'&&req.method==='POST'){
  if(req._secret)return fail(res,'通常モードで設定してください',403);
  const v=JSON.parse((await body(req,2048)).toString('utf8'));
  const keys=Object.keys(MOBILE_PALETTE_DEFAULT.colors);
  if(!v||typeof v!=='object'||!['system','light','dark','custom'].includes(v.mode)||
    !Number.isInteger(v.titleSize)||v.titleSize<10||v.titleSize>19||
    !v.colors||typeof v.colors!=='object'||!keys.every(k=>mobilePaletteColorOk(v.colors[k])))return fail(res,'スマホ配色設定が不正です');
  const colors={};for(const k of keys)colors[k]=v.colors[k];
  const cfg={mode:v.mode,titleSize:v.titleSize,colors};writeMobilePalette(cfg);
  return json(res,200,{ok:true,...cfg});
 }
 if(route==='/api/mobile-background/image'&&req.method==='POST'){
  if(req._secret)return fail(res,'通常モードで設定してください',403);
  if(String(req.headers['content-type']||'').split(';')[0]!=='image/webp')return fail(res,'WebP画像のみアップロードできます',415);
  const bytes=await body(req,500000);
  if(bytes.length<16||imageFormat(bytes)!=='image/webp')return fail(res,'画像形式を確認できませんでした');
  const hash=createHash('sha256').update(bytes).digest('hex').slice(0,24);
  const file=`mobile-bg-${hash}.webp`;
  fs.mkdirSync(MOBILE_BG_DIR,{recursive:true});
  const dest=path.join(MOBILE_BG_DIR,file);
  try{fs.writeFileSync(dest,bytes,{flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e}
  return json(res,200,{image:file,size:bytes.length});
 }
 if(route==='/api/theme'&&req.method==='GET')return json(res,200,getTheme(!!req._secret));
 if(route==='/api/placeholders'&&req.method==='GET')return json(res,200,getPlaceholders());
 if(route==='/api/placeholders'&&req.method==='POST'){
  const x=JSON.parse((await body(req)).toString());if(!x||typeof x!=='object')return fail(res,'設定が不正です');
  const fixed={};for(const kind of ['missing','failed']){const v=x[kind]||'';if(typeof v!=='string'||(v&&!PLACEHOLDER_FILE.test(v)))return fail(res,'画像パスが不正です');if(v&&!fs.existsSync(path.join(DATA,'placeholders',path.basename(v.split('?')[0]))))return fail(res,'指定画像が存在しません');fixed[kind]=v}
  setPlaceholders(fixed);prunePlaceholders(fixed);return json(res,200,{ok:true});
 }
 if(route.startsWith('/api/placeholder/')&&req.method==='POST'){
  const kind=route.slice('/api/placeholder/'.length);if(!['missing','failed'].includes(kind))return fail(res,'画像種別が不正です');
  const bytes=await body(req,5_000_000),type=(req.headers['content-type']||'').split(';')[0];
  const ext={'image/png':'png','image/apng':'apng','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[type];
  if(!ext||!imageFormat(bytes)|| (type==='image/png'||type==='image/apng'?imageFormat(bytes)!=='image/png':type==='image/jpeg'?imageFormat(bytes)!=='image/jpeg':type!==imageFormat(bytes)))return fail(res,'PNG/APNG/JPEG/WebP/GIFの画像を選んでください');
  const file=`placeholder-${kind}-${createHash('sha256').update(bytes).digest('hex').slice(0,24)}.${ext}`;
  fs.writeFileSync(path.join(DATA,'placeholders',file),bytes);return json(res,200,{image:`/assets/${file}?v=${Date.now()}`});
 }
 // Fix103L: E2 publisher icons, resolved from a STORED candidate ID.
 // Never accept a remote URL/hostname supplied by the image requester.
 // A secret profile is deliberately excluded from this headerless image route.
 const e2IconRoute=route.match(/^\/api\/ai\/external-icon\/(\d+)\/([a-f0-9]{32})$/);
 if(e2IconRoute&&req.method==='GET'){
  const pid=Number(e2IconRoute[1]),id=e2IconRoute[2];
  const normalProfile=Number.isSafeInteger(pid)&&pid>0&&db.prepare('SELECT 1 FROM profiles WHERE id=? AND is_secret=0').get(pid);
  if(!normalProfile)return fail(res,'記事がありません',404);
  const data=aiExternal.status(pid);
  const candidate=(data.items||[]).find(x=>String(x.id)===id);
  if(!candidate)return fail(res,'記事がありません',404);
  // Match the ordinary E2 visible-list exclusion checks before fetching.
  if(!rssHide.filter(pid,aiSourceFeedback.filter(pid,[candidate],{externalPreview:true})).length)return fail(res,'記事がありません',404);
  const host=String(candidate.publisherHost||'').trim().toLowerCase();
  // Strict DNS hostname only: no scheme, user-info, port, IP, slash or query.
  const labels=host.split('.');
  if(host.length>253||labels.length<2||net.isIP(host)||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||labels.some(label=>!label||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))return fail(res,'出典のホスト名がありません',404);
  const site='https://'+host+'/';
  // faviconForFeed uses the pre-existing guarded URL check, bounded reads,
  // size/type validation, 3-worker queue and per-site success/failure cache.
  const result=await faviconForFeed({site_url:site,url:site});
  if(!result){res.writeHead(404,{'Cache-Control':'private, max-age=1800','X-Content-Type-Options':'nosniff'});return res.end()}
  res.writeHead(200,{'Content-Type':result.type,'Content-Length':result.bytes.length,
   'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  return res.end(result.bytes);
 }
 // Conditional news publisher favicon (existing guarded cache, no arbitrary URLs).
 const conditionalIconRoute=route.match(/^\/api\/ai\/conditional-icon\/(\d+)\/([a-f0-9]{32})$/);
 if(conditionalIconRoute&&req.method==='GET'){
  const pid=Number(conditionalIconRoute[1]),id=conditionalIconRoute[2];
  if(!Number.isSafeInteger(pid)||pid<1||!db.prepare('SELECT 1 FROM profiles WHERE id=? AND is_secret=0').get(pid))return fail(res,'記事がありません',404);
  const candidate=(aiConditional.status(pid).items||[]).find(x=>x.id===id);
  if(!candidate||!rssHide.filter(pid,aiSourceFeedback.filter(pid,[candidate],{externalPreview:true})).length)return fail(res,'記事がありません',404);
  const host=String(candidate.publisherHost||'').trim().toLowerCase(),labels=host.split('.');
  if(host.length>253||labels.length<2||net.isIP(host)||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||labels.some(label=>!label||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))return fail(res,'出典のホスト名がありません',404);
  const site='https://'+host+'/';
  const result=await faviconForFeed({site_url:site,url:site});
  if(!result){res.writeHead(404,{'Cache-Control':'private, max-age=1800','X-Content-Type-Options':'nosniff'});return res.end()}
  res.writeHead(200,{'Content-Type':result.type,'Content-Length':result.bytes.length,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  return res.end(result.bytes);
 }
 const iconRoute=route.match(/^\/api\/feed-icon\/(\d+)$/);
 if(iconRoute&&req.method==='GET'){
  // Images cannot send custom headers: validate an ephemeral query token for secret icons.
  const token=u.searchParams.get('secret');
  if(token){if(!secretSessions.get(token)||secretSessions.get(token)<Date.now())return fail(res,'シークレットの期限切れ',403);req._secret=true}
  const feed=db.prepare('SELECT f.id,f.url,f.site_url FROM feeds f WHERE f.id=? AND EXISTS (SELECT 1 FROM profile_feeds pf JOIN profiles p ON p.id=pf.profile_id WHERE pf.feed_id=f.id AND p.is_secret=?)').get(int(iconRoute[1]),req._secret?1:0);
  if(!feed)return fail(res,'RSSがありません',404);
  const result=await faviconForFeed(feed);
  if(!result){res.writeHead(404,{'Cache-Control':'private, max-age=3600'});return res.end()}
  res.writeHead(200,{'Content-Type':result.type,'Content-Length':result.bytes.length,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'});return res.end(result.bytes);
 }

 if(route==='/api/theme'&&req.method==='POST'){
  const input=JSON.parse((await body(req)).toString());
  if(!input||typeof input!=='object'||!['left','right','shared'].every(k=>input[k]&&typeof input[k]==='object'))return fail(res,'設定が不正です');
  const previous=getTheme(!!req._secret),fixed=structuredClone(previous);
  fixed.baseColor=colorOk(input.baseColor)?input.baseColor:previous.baseColor;
  fixed.sharedLinked=input.sharedLinked!==false;
  // RC07 genre icon size/color: validate input, preserving old preferences on absence.
  const gi=input.genreIcons||{},pgi=previous.genreIcons||defaultTheme.genreIcons;
  const rawSize=Number(gi.size);
  fixed.genreIcons={size:Number.isInteger(rawSize)&&rawSize>=8&&rawSize<=48?rawSize:pgi.size,color:colorOk(gi.color)?gi.color:pgi.color};
  // Validate and persist header settings separately from the wallpaper layers.
  const incomingHeader=input.header||{},oldHeader=previous.header||defaultTheme.header;
  fixed.header={
   extend:incomingHeader.extend!==false,
   color:colorOk(incomingHeader.color)?incomingHeader.color:oldHeader.color,
   opacity:numeric(incomingHeader.opacity,0,100,oldHeader.opacity),
   blur:numeric(incomingHeader.blur,0,40,oldHeader.blur),
   textColor:colorOk(incomingHeader.textColor)?incomingHeader.textColor:oldHeader.textColor,
   borderEnabled:incomingHeader.borderEnabled!==false,
   borderColor:colorOk(incomingHeader.borderColor)?incomingHeader.borderColor:oldHeader.borderColor,
   borderOpacity:numeric(incomingHeader.borderOpacity,0,100,oldHeader.borderOpacity)
  };
  for(const slot of ['left','right','shared']){
   const src=input[slot],s=fixed[slot];
   s.color=colorOk(src.color)?src.color:'#ffffff';s.colorOpacity=numeric(src.colorOpacity,0,100,100);s.imageOpacity=numeric(src.imageOpacity,0,100,100);
   s.position=['center','top','bottom','left','right'].includes(src.position)?src.position:'center';
   const img=src.image||'';
   s.image=typeof img==='string'&&/^\/assets\/bg-(left|right|shared)-[\w-]+\.(png|apng|jpg|gif|webp|mp4|webm)(\?v=\d+)?$/.test(img)?img:'';
   s.type=['color','image','video','folder'].includes(src.type)?src.type:(s.image?'image':'color');
   s.folder=src.folder?wallpaperFolder(src.folder):'';
   s.mobileFolder=src.mobileFolder?wallpaperFolder(src.mobileFolder):'';
   s.folderKind=['all','images','videos'].includes(src.folderKind)?src.folderKind:'all';
   s.interval=numeric(src.interval,5,3600,300);s.speed=numeric(src.speed,0.25,2,1);s.loop=src.loop!==false;
   s.blur=numeric(src.blur,0,40,0);
  }
  for(const slot of ['left','right']){
   const t=input.text?.[slot]||{};fixed.text[slot]={font:fontOk(t.font)?t.font:'Meiryo, sans-serif',weight:numeric(t.weight,100,900,previous.text[slot]?.weight??400),color:colorOk(t.color)?t.color:'#223148',size:numeric(t.size,11,24,14),stroke:numeric(t.stroke,0,3,0),strokeColor:colorOk(t.strokeColor)?t.strokeColor:'#000000',shadow:!!t.shadow,shadowColor:colorOk(t.shadowColor)?t.shadowColor:(previous.text[slot]?.shadowColor||'#121a2d'),shadowOpacity:numeric(t.shadowOpacity,0,100,previous.text[slot]?.shadowOpacity??60),shadowX:numeric(t.shadowX,-20,20,previous.text[slot]?.shadowX??1),shadowY:numeric(t.shadowY,-20,20,previous.text[slot]?.shadowY??2),shadowBlur:numeric(t.shadowBlur,0,20,previous.text[slot]?.shadowBlur??3)};
  }
  for(const key of ['source','title','excerpt'])fixed.articleStyle[key]=sanitizeStyle(input.articleStyle?.[key],previous.articleStyle[key]);
  for(const key of ['list','magazine'])fixed.separators[key]=sanitizeSeparator(input.separators?.[key],previous.separators[key]);
  const st=input.stripe||{},before=previous.stripe;
  fixed.stripe={enabled:!!st.enabled,oddColor:colorOk(st.oddColor)?st.oddColor:before.oddColor,evenColor:colorOk(st.evenColor)?st.evenColor:before.evenColor,oddOpacity:numeric(st.oddOpacity,0,100,before.oddOpacity),evenOpacity:numeric(st.evenOpacity,0,100,before.evenOpacity),hoverColor:colorOk(st.hoverColor)?st.hoverColor:before.hoverColor,hoverOpacity:numeric(st.hoverOpacity,0,100,before.hoverOpacity)};
  setTheme(fixed,!!req._secret);
  // Existing backgrounds remain stored. Do not delete unsaved, old, or rollback assets.
  return json(res,200,{ok:true});
 }
 if(route.startsWith('/api/background/')&&req.method==='POST'){
  const slot=route.slice('/api/background/'.length);if(!['left','right','shared'].includes(slot))return fail(res,'不正な背景');
  const type=(req.headers['content-type']||'').split(';')[0];
  const ext={'image/png':'png','image/apng':'apng','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','video/mp4':'mp4','video/webm':'webm'}[type];
  if(!ext)return fail(res,'PNG/APNG/JPEG/WebP/GIF/MP4/WebM形式を選んでください');
  const video=type.startsWith('video/');const max=video?256_000_000:20_000_000;
  const temp=path.join(DATA,'backgrounds',`upload-${randomBytes(8).toString('hex')}.tmp`);
  let count=0;const handle=fs.openSync(temp,'wx');let first=Buffer.alloc(0);
  try{for await(const chunk of req){count+=chunk.length;if(count>max)throw Error(`ファイルは${video?'256':'20'}MB以下にしてください`);if(first.length<32)first=Buffer.concat([first,chunk]).subarray(0,32);fs.writeSync(handle,chunk)}
  }catch(e){fs.closeSync(handle);fs.rmSync(temp,{force:true});throw e}fs.closeSync(handle);
  const detected=imageFormat(first);
  const valid=video?(type==='video/mp4'?first.toString('ascii',4,8)==='ftyp':(first[0]===0x1a&&first[1]===0x45&&first[2]===0xdf&&first[3]===0xa3)):
    detected===(type==='image/apng'?'image/png':type);
  if(!count||!valid){fs.rmSync(temp,{force:true});return fail(res,'ファイル形式を確認できませんでした')}
  const file=`bg-${slot}-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
  fs.renameSync(temp,path.join(DATA,'backgrounds',file));return json(res,200,{image:`/assets/${file}?v=${Date.now()}`});
 }
 if(route==='/api/categories'&&req.method==='POST'){
  const x=JSON.parse((await body(req)).toString());const name=String(x.name||'').trim().slice(0,100);
  if(!name||/[\x00-\x1f]/.test(name))return fail(res,'カテゴリ名を確認してください');
  const pid=profileId(req);
  db.exec('BEGIN');
  try{const id=ensureCategory(name,pid);db.exec('COMMIT');return json(res,200,{id})}
  catch(e){db.exec('ROLLBACK');throw e}
 }
// UI04 category order: move exactly one slot within the active profile.
if(route==='/api/categories/order'&&req.method==='POST'){
 const x=JSON.parse((await body(req)).toString()),pid=profileId(req),target=int(x.id),direction=x.direction;
 if(!Number.isSafeInteger(target)||target<1||!['up','down'].includes(direction))return fail(res,'並び替えの指定が不正です',400);
 const all=db.prepare(`SELECT pcs.category_id AS id,pcs.name,
   (SELECT COUNT(*) FROM profile_feeds pf WHERE pf.profile_id=pcs.profile_id AND pf.category_id=pcs.category_id) AS feedCount
   FROM profile_category_settings pcs WHERE pcs.profile_id=? ORDER BY pcs.sort_order,pcs.category_id`).all(pid);
 // Hidden unused fallback is not a visible neighbor. Preserve its position.
 const visible=all.filter(c=>c.name!=='未分類'||c.feedCount>0).map(c=>c.id);
 const i=visible.indexOf(target),j=i+(direction==='up'?-1:1);
 if(i<0)return fail(res,'このプロファイルに表示中のカテゴリがありません',404);
 if(j<0||j>=visible.length)return fail(res,'これ以上移動できません',409);
 [visible[i],visible[j]]=[visible[j],visible[i]];
 const shown=new Set(visible);let offset=0;
 const ids=all.map(c=>shown.has(c.id)?visible[offset++]:c.id);
 db.exec('BEGIN');try{
  const put=db.prepare('UPDATE profile_category_settings SET sort_order=? WHERE profile_id=? AND category_id=?');
  for(let k=0;k<ids.length;k++)put.run(k+1,pid,ids[k]);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e}
 return json(res,200,{ok:true,order:ids});
}
 const cat=route.match(/^\/api\/categories\/(\d+)$/);
 if(cat&&req.method==='PATCH'){
  const x=JSON.parse((await body(req)).toString()),id=int(cat[1]),pid=profileId(req);
  if(!db.prepare('SELECT 1 FROM profile_categories WHERE profile_id=? AND category_id=?').get(pid,id))return fail(res,'このプロファイルにカテゴリがありません',404);
  const label=x.name===undefined?null:String(x.name).trim().slice(0,100);
  if(label!==null&&(!label||/[\x00-\x1f]/.test(label)))return fail(res,'カテゴリ名を確認してください');
  if(x.mode!==undefined&&!['list','magazine'].includes(x.mode))return fail(res,'表示方式が不正です');
  if(label!==null&&id===getDefault(pid)&&label!=='未分類')return fail(res,'未分類の名前は変更できません',409);
  if(label!==null){const same=findCategory(label,pid);if(same&&same.id!==id)return fail(res,'同名のカテゴリがあります',409)}
  db.exec('BEGIN');
  try{
   if(x.mode)db.prepare('UPDATE profile_category_settings SET display_mode=? WHERE profile_id=? AND category_id=?').run(x.mode,pid,id);
   if(label!==null){
    db.prepare('UPDATE profile_category_settings SET name=? WHERE profile_id=? AND category_id=?').run(label,pid,id);
    if(isSecretProfile(pid))db.prepare('UPDATE secret_category_names SET name=? WHERE category_id=?').run(label,id);
   }
   db.exec('COMMIT');return json(res,200,{ok:true});
  }catch(e){db.exec('ROLLBACK');if(String(e.message).includes('UNIQUE'))return fail(res,'同名のカテゴリがあります',409);throw e}
 }
 if(cat&&req.method==='DELETE'){
  const id=int(cat[1]),pid=profileId(req),defaultId=getDefault(pid);
  if(id===defaultId)return fail(res,'未分類は削除できません');
  // Previously this endpoint returned {ok:true} even if zero rows were removed.
  // Detect mismatched profile/mode, so the UI never reports a silent success.
  if(!db.prepare('SELECT 1 FROM profile_categories WHERE profile_id=? AND category_id=?').get(pid,id))
   return fail(res,'このプロファイルにカテゴリがありません。再読み込みして確認してください。',404);
  db.exec('BEGIN');
  let moved=0,removed=0;
  try{
   profileCategory(pid,defaultId);
   const from=db.prepare('SELECT feed_id FROM profile_feeds WHERE profile_id=? AND category_id=? ORDER BY sort_order,feed_id').all(pid,id);
   let next=db.prepare('SELECT COALESCE(MAX(sort_order),0) AS pos FROM profile_feeds WHERE profile_id=? AND category_id=?').get(pid,defaultId).pos;
   const move=db.prepare('UPDATE profile_feeds SET category_id=?,sort_order=? WHERE profile_id=? AND feed_id=?');
   for(const f of from)moved+=move.run(defaultId,++next,pid,f.feed_id).changes;
   removed=db.prepare('DELETE FROM profile_categories WHERE profile_id=? AND category_id=?').run(pid,id).changes;
   if(removed!==1||db.prepare('SELECT 1 FROM profile_categories WHERE profile_id=? AND category_id=?').get(pid,id))
    throw Error('カテゴリの削除を確認できませんでした');
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  return json(res,200,{ok:true,removed:true,categoryId:id,movedFeeds:moved});
 }
 // Discover public RSS/Atom links from a site page; never fetch or render article bodies.
 if(route==='/api/feed-discover'&&req.method==='POST'){
  const x=JSON.parse((await body(req)).toString());
  return json(res,200,await discoverRss(validHttpUrl(x.url),{fetchFeed,checkRemote,fetchImpl:fetch,validHttpUrl}));
 }
// UI04: only RSS belonging to this category and profile may move.
if(route==='/api/feeds/order'&&req.method==='POST'){
 const x=JSON.parse((await body(req)).toString()),pid=profileId(req),target=int(x.id),direction=x.direction;
 if(!Number.isSafeInteger(target)||target<1||!['up','down'].includes(direction))return fail(res,'並び替えの指定が不正です',400);
 const item=db.prepare('SELECT category_id FROM profile_feeds WHERE profile_id=? AND feed_id=?').get(pid,target);
 if(!item)return fail(res,'このプロファイルのRSSがありません',404);
 const ids=db.prepare('SELECT feed_id AS id FROM profile_feeds WHERE profile_id=? AND category_id=? ORDER BY sort_order,feed_id').all(pid,item.category_id).map(r=>r.id);
 const i=ids.indexOf(target),j=i+(direction==='up'?-1:1);
 if(i<0||j<0||j>=ids.length)return fail(res,'これ以上移動できません',409);
 [ids[i],ids[j]]=[ids[j],ids[i]];
 db.exec('BEGIN');try{
  const put=db.prepare('UPDATE profile_feeds SET sort_order=? WHERE profile_id=? AND category_id=? AND feed_id=?');
  for(let k=0;k<ids.length;k++)put.run(k+1,pid,item.category_id,ids[k]);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e}
 return json(res,200,{ok:true,order:ids});
}
 if(route==='/api/feeds'&&req.method==='POST'){
  const x=JSON.parse((await body(req)).toString());const url=validHttpUrl(x.url),pid=profileId(req),cid=int(x.categoryId)||getDefault(pid);
  const customTitle=String(x.displayTitle??'').trim();
  if(customTitle.length>250||/[\x00-\x1f]/.test(customTitle))return fail(res,'表示名は250文字以内にしてください');
  if(!db.prepare('SELECT category_id FROM profile_categories WHERE profile_id=? AND category_id=?').get(pid,cid))return fail(res,'このプロファイルにカテゴリがありません');
  if(alreadyInProfile(url,pid))return fail(res,'このプロファイルには登録済みです',409);
  const existing=db.prepare('SELECT id FROM feeds WHERE url=?').get(url);
  if(existing){if(!profileFeed(pid,existing.id,cid))return fail(res,'このプロファイルには登録済みです',409);if(customTitle)db.prepare('UPDATE profile_feeds SET display_title=? WHERE profile_id=? AND feed_id=?').run(customTitle,pid,existing.id);return json(res,200,{id:existing.id,reused:true})}
  // Validate before writing: arbitrary HTML/web pages cannot become feed subscriptions.
  const checked=await fetchFeed(url);
  if(checked.unchanged||!checked.feed)throw Error('RSSの内容を確認できません');
  const r=db.prepare('INSERT INTO feeds(url,title,site_url,category_id,created) VALUES(?,?,?,?,?)').run(url,checked.feed.title||new URL(url).hostname,checked.feed.siteUrl||'',cid,Date.now());const id=Number(r.lastInsertRowid);
  profileFeed(pid,id,cid);if(customTitle)db.prepare('UPDATE profile_feeds SET display_title=? WHERE profile_id=? AND feed_id=?').run(customTitle,pid,id);updateFeed(db.prepare('SELECT * FROM feeds WHERE id=?').get(id)).catch(console.error);return json(res,200,{id,reused:false});
 }
 const fr=route.match(/^\/api\/feeds\/(\d+)$/);
 if(fr&&req.method==='GET'){
  const id=int(fr[1]);const f=db.prepare('SELECT f.id,f.url,f.title,f.site_url AS siteUrl,pf.category_id AS categoryId,pf.display_title AS displayTitle FROM feeds f JOIN profile_feeds pf ON pf.feed_id=f.id WHERE f.id=? AND pf.profile_id=?').get(id,profileId(req));
  if(!f)return fail(res,'このプロファイルにRSSがありません',404);
  // Other profiles are independent users: do not disclose their memberships.
  return json(res,200,{feed:f,usedBy:[]});
 }
 if(fr&&req.method==='PATCH'){
  const x=JSON.parse((await body(req)).toString()),pid=profileId(req),id=int(fr[1]);
  if(!db.prepare('SELECT 1 FROM profile_feeds WHERE profile_id=? AND feed_id=?').get(pid,id))return fail(res,'このプロファイルにRSSがありません',404);
  if(x.url!==undefined)return fail(res,'URLを変更する場合は「URLを差し替える」を使用してください');
  if(x.categoryId!==undefined){
   const cid=int(x.categoryId);
   if(!db.prepare('SELECT category_id FROM profile_categories WHERE profile_id=? AND category_id=?').get(pid,cid))return fail(res,'このプロファイルにカテゴリがありません');
   const currentCategory=db.prepare('SELECT category_id FROM profile_feeds WHERE feed_id=? AND profile_id=?').get(id,pid).category_id;
   if(currentCategory!==cid){
    const next=db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS pos FROM profile_feeds WHERE profile_id=? AND category_id=?').get(pid,cid).pos;
    db.prepare('UPDATE profile_feeds SET category_id=?,sort_order=? WHERE feed_id=? AND profile_id=?').run(cid,next,id,pid);
   }
  }
  if(x.displayTitle!==undefined){
   const title=String(x.displayTitle??'').trim();
   if(title.length>250||/[\x00-\x1f]/.test(title))return fail(res,'表示名は250文字以内にしてください');
   db.prepare('UPDATE profile_feeds SET display_title=? WHERE feed_id=? AND profile_id=?').run(title,id,pid);
  }
  return json(res,200,{ok:true});
 }
 const replacement=route.match(/^\/api\/feeds\/(\d+)\/replace$/);
 if(replacement&&req.method==='POST'){
  const id=int(replacement[1]),pid=profileId(req),x=JSON.parse((await body(req)).toString());
  const current=db.prepare('SELECT feed_id,category_id,display_title FROM profile_feeds WHERE profile_id=? AND feed_id=?').get(pid,id);
  if(!current)return fail(res,'このプロファイルにRSSがありません',404);
  if(x.scope==='all')return fail(res,'他のプロファイルのRSSは編集できません',403);
  const url=validHttpUrl(x.url);
  const old=db.prepare('SELECT url FROM feeds WHERE id=?').get(id);
  if(old.url===url)return fail(res,'URLが変更されていません');
  // Validate new source BEFORE changing membership or history.
  const target=db.prepare('SELECT id FROM feeds WHERE url=?').get(url);
  if(alreadyInProfile(url,pid,id))return fail(res,'差し替え先はこのプロファイルに登録済みです',409);
  const checked=target?null:await fetchFeed(url);
  if(!target&&(checked.unchanged||!checked.feed))throw Error('RSSの内容を確認できません');
  const members=[{profile_id:pid,...current}];
  if(members.some(m=>alreadyInProfile(url,m.profile_id,id)))return fail(res,'差し替え先のRSSは対象プロファイルに登録済みです',409);
  db.exec('BEGIN');
  try{
   let targetId=target?.id;
   if(!targetId){const r=db.prepare('INSERT INTO feeds(url,title,site_url,category_id,created) VALUES(?,?,?,?,?)').run(url,checked.feed.title||new URL(url).hostname,checked.feed.siteUrl||'',current.category_id,Date.now());targetId=Number(r.lastInsertRowid)}
   const move=db.prepare('UPDATE profile_feeds SET feed_id=? WHERE profile_id=? AND feed_id=?');
   for(const m of members)move.run(targetId,m.profile_id,id);
   db.exec('COMMIT');
   // Do not migrate old articles or read history; they belong to the old feed.
   iconCache.clear();updateFeed(db.prepare('SELECT * FROM feeds WHERE id=?').get(targetId)).catch(console.error);
   return json(res,200,{ok:true,id:targetId,profilesChanged:members.length,oldArticlesPreserved:true,reused:!!target});
  }catch(e){db.exec('ROLLBACK');throw e}
 }
 if(fr&&req.method==='DELETE'){
  const r=db.prepare('DELETE FROM profile_feeds WHERE feed_id=? AND profile_id=?').run(int(fr[1]),profileId(req));
  return json(res,200,{ok:true,removed:r.changes});
 }
 if(route==='/api/refresh'&&req.method==='POST'){if(refreshing)return json(res,200,{busy:true});refresh().catch(console.error);return json(res,200,{started:true})}
 const art=route.match(/^\/api\/articles\/(\d+)$/);
 if(art&&req.method==='PATCH'){
  const x=JSON.parse((await body(req)).toString()),id=int(art[1]),pid=profileId(req);
  if(!db.prepare('SELECT 1 FROM articles a JOIN profile_feeds pf ON pf.feed_id=a.feed_id WHERE a.id=? AND pf.profile_id=?').get(id,pid))
   return fail(res,'このプロファイルに記事がありません',404);
  if(typeof x.read==='boolean')db.prepare(`INSERT INTO profile_article_state(profile_id,article_id,read_at,starred)
   VALUES(?,?,?,0) ON CONFLICT(profile_id,article_id) DO UPDATE SET read_at=excluded.read_at`).run(pid,id,x.read?Date.now():null);
  if(typeof x.starred==='boolean')db.prepare(`INSERT INTO profile_article_state(profile_id,article_id,read_at,starred)
   VALUES(?,?,NULL,?) ON CONFLICT(profile_id,article_id) DO UPDATE SET starred=excluded.starred`).run(pid,id,x.starred?1:0);
  return json(res,200,{ok:true});
 }
 if(route==='/api/mark-read'&&req.method==='POST'){
  const x=JSON.parse((await body(req)).toString()),pid=profileId(req),now=Date.now();
  let conditions=['pf.profile_id=?','pas.read_at IS NULL'],params=[pid];
  if(x.feedId){conditions.push('pf.feed_id=?');params.push(int(x.feedId))}
  else if(x.categoryId){conditions.push('pf.category_id=?');params.push(int(x.categoryId))}
  db.prepare(`INSERT INTO profile_article_state(profile_id,article_id,read_at,starred)
   SELECT ?,a.id,?,COALESCE(pas.starred,0) FROM articles a
   JOIN profile_feeds pf ON pf.feed_id=a.feed_id
   LEFT JOIN profile_article_state pas ON pas.profile_id=pf.profile_id AND pas.article_id=a.id
   WHERE ${conditions.join(' AND ')}
   ON CONFLICT(profile_id,article_id) DO UPDATE SET read_at=excluded.read_at`).run(pid,now,...params);
  return json(res,200,{ok:true});
 }
 // UI05: preview/commit are token- and mode-bound. No cross-mode restore.
 if(route==='/api/config-backup'&&req.method==='GET'){
  const data=configBackup.exportConfig(!!req._secret);
  return json(res,200,data);
 }
 if(route==='/api/config-backup/preview'&&req.method==='POST'){
  try{
   const x=JSON.parse((await body(req,5_200_000)).toString('utf8'));
   const info=configBackup.preview(x,!!req._secret,profileId(req),req._secretToken);
   return json(res,200,info);
  }catch(e){return fail(res,e.message||'構成ファイルを確認できませんでした',400)}
 }
 if(route==='/api/config-backup/commit'&&req.method==='POST'){
  const x=JSON.parse((await body(req,4096)).toString('utf8'));
  if(typeof x.ticket!=='string'||!/^[a-f0-9]{48}$/.test(x.ticket))return fail(res,'取り込み確認番号が不正です',400);
  try{return json(res,200,configBackup.restore(x.ticket,!!req._secret,profileId(req),req._secretToken))}
  catch(e){return fail(res,'構成を復元できませんでした: '+(e.message||'確認エラー'),400)}
 }
 if(route==='/api/opml/preview'&&req.method==='POST'){
  const xml=(await body(req,2_000_000)).toString('utf8');
  return json(res,200,previewOpml(xml,profileId(req),req._secretToken));
 }
 if(route==='/api/opml/commit'&&req.method==='POST'){
  const x=JSON.parse((await body(req,4096)).toString('utf8'));
  const ticket=typeof x.ticket==='string'&&/^[a-f0-9]{48}$/.test(x.ticket)?x.ticket:'';
  const result=commitOpml(ticket,profileId(req),req._secretToken,x.acceptPartial===true);
  if(result.invalid||result.confirmationRequired)return fail(res,OPML_GENERIC_FAILURE,409);
  return json(res,200,result);
 }
 // Legacy one-shot import must not bypass the preview/confirmation barrier.
 if(route==='/api/opml'&&req.method==='POST')return fail(res,'新しい取り込み画面からOPMLを選択してください。',409);
 if(route==='/api/opml'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8','Content-Disposition':'attachment; filename="nestrill.opml"'});return res.end(opmlExport(profileId(req)))}
 if(route.startsWith('/assets/')&&req.method==='GET'){
  const placeholder=route.slice('/assets/'.length);
  if(/^placeholder-(missing|failed)-[0-9a-f]+\.(png|jpg|webp|gif|apng)$/.test(placeholder))return serveFile(res,path.join(DATA,'placeholders',placeholder));
  const f=path.basename(route);if(!/^bg-(left|right|shared)-[\w-]+\.(png|apng|jpg|gif|webp|mp4|webm)$/.test(f))return fail(res,'ファイルがありません',404);return serveFile(res,path.join(DATA,'backgrounds',f));
 }
 if(req.method==='GET'){
  const f=route==='/'?'index.html':route.slice(1);if(!['index.html','app.js','style.css','bird.svg','favicon.svg','placeholder-missing.svg','placeholder-failed.svg','manifest.webmanifest','uxclean-motion.js'].includes(f))return fail(res,'見つかりません',404);
  return serveFile(res,path.join(PUBLIC,f));
 }
 return fail(res,'見つかりません',404);
 }catch(e){console.error('[API]',e.message);if(String(e.message).includes('scope_membership_conflict'))return fail(res,'このRSSは登録できません',409);return fail(res,e.message||'予期しないエラー',e instanceof SyntaxError?400:500)}
});
server.on('error',e=>{console.error('[FATAL] Server listen error:',e?.stack||e);process.exit(1)});
server.listen(PORT,HOST,()=>{
 try{saveControlFile()}catch(e){console.error('[FATAL] Failed to create lifecycle control file:',e);server.close();process.exitCode=1;return}
 console.log(`Nestrill: http://${HOST}:${PORT}`);
 console.log(`Database: ${path.join(DATA,'nestrill.sqlite')}`);
 console.log(`[START] pid=${process.pid}, instance=${instanceId}, time=${new Date().toISOString()}`);
 console.log('[Next] Automatic refresh disabled (initial isolated smoke-test phase)');



});
