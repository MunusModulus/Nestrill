'use strict';
// Nestrill YouTube: Google Takeout CSV + PUBLIC YouTube Atom. No OAuth, API keys or cookies.
const crypto = require('node:crypto');
const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO = /^[A-Za-z0-9_-]{11}$/;
const now = () => Date.now();
const say = e => String(e?.message || e || 'Unknown error').slice(0,240);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function channelId(x) {
 const s=String(x||'').trim();
 if(CHANNEL.test(s)) return s;
 try {const u=new URL(s); if(!['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname)||!['http:','https:'].includes(u.protocol))return '';
  const match=/^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/.exec(u.pathname);
  return match&&CHANNEL.test(match[1])?match[1]:'';
 }catch {return ''}
}
// Resolve a public YouTube handle/legacy URL without OAuth or Data API.
// Only a fixed YouTube host is ever contacted; redirects remain host-restricted.
const HANDLE_PATH=/^\/(?:@[^/?#]+|(?:c|user)\/[^/?#]+)(?:\/(?:videos|shorts|streams|playlists|community|featured|about|live))?\/?$/u;
function youtubeChannelPage(value){
 if(typeof value!=='string'||value.length>600)throw Error('チャンネルURLが不正です');
 let input=value.trim();
 if(/^@[^\s/?#]+$/u.test(input))input='https://www.youtube.com/'+input;
 else if(/^((?:www\.|m\.)?youtube\.com)\//i.test(input))input='https://'+input;
 let url;
 try{url=new URL(input)}catch{throw Error('YouTubeのチャンネルURLまたは@ハンドルを入力してください')}
 if(url.protocol!=='https:'||!['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname)||url.port||url.username||url.password||!HANDLE_PATH.test(decodeURI(url.pathname))){
  throw Error('YouTubeのチャンネルURL（/@名前 など）を指定してください');
 }
 url.hostname='www.youtube.com';url.search='';url.hash='';
 return url.toString();
}
function readChannelMetadata(html){
 // Prefer channel-specific metadata. Do not scan for arbitrary UC IDs in suggested videos.
 let id='';
 for(const match of html.matchAll(/<meta\b[^>]{0,800}>/gi)){
  const tag=match[0];
  if(/\bitemprop\s*=\s*(['"])channelId\1/i.test(tag)){
   const value=/\bcontent\s*=\s*(['"])(UC[A-Za-z0-9_-]{22})\1/i.exec(tag);
   if(value){id=value[2];break}
  }
 }
 if(!id){const m=/<link\b[^>]*\btype\s*=\s*(['"])application\/rss\+xml\1[^>]*>/gi;
  for(const match of html.matchAll(m)){const x=/\bchannel_id=(UC[A-Za-z0-9_-]{22})\b/.exec(match[0]);if(x){id=x[1];break}}
 }
 if(!id){const m=/(?:"externalId"|&quot;externalId&quot;)\s*:\s*(?:"|&quot;)(UC[A-Za-z0-9_-]{22})(?:"|&quot;)/.exec(html);if(m)id=m[1]}
 if(!id){for(const match of html.matchAll(/<link\b[^>]*\brel\s*=\s*(['"])canonical\1[^>]*>/gi)){
  const m=/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/.exec(match[0]);if(m){id=m[1];break}
 }}
 let title='';
 for(const m of html.matchAll(/<meta\b[^>]{0,800}>/gi)){
  const t=m[0];
  if(/\bproperty\s*=\s*(['"])og:title\1/i.test(t)){
   const x=/\bcontent\s*=\s*(['"])(.*?)\1/i.exec(t);
   if(x){title=x[2].replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").slice(0,200);break}
  }
 }
 return {id:CHANNEL.test(id)?id:'',title};
}
async function resolveChannel(value){
 const id=channelId(value);
 if(id)return {channelId:id,title:''};
 let url=youtubeChannelPage(value);
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),9000);
 try{
  for(let redirect=0;redirect<4;redirect++){
   let response;
   try{response=await fetch(url,{method:'GET',redirect:'manual',signal:controller.signal,headers:{'Accept':'text/html','Accept-Language':'ja,en;q=0.8','User-Agent':'Mozilla/5.0 (compatible; Nestrill/1.0)'}})}
   catch(e){throw Error('YouTubeの公開ページへ接続できませんでした。通信状態をご確認ください')}
   if([301,302,303,307,308].includes(response.status)){
    const location=response.headers.get('location');
    if(!location)break;
    const target=new URL(location,url);
    if(target.protocol!=='https:'||!['www.youtube.com','youtube.com','m.youtube.com'].includes(target.hostname)||target.port||target.username||target.password){throw Error('YouTube以外への転送が発生したため、登録を中止しました')}
    url=target.toString();continue;
   }
   if(!response.ok)throw Error('YouTubeの公開ページを取得できませんでした（HTTP '+response.status+'）');
   if(!(response.headers.get('content-type')||'').toLowerCase().includes('text/html'))throw Error('YouTubeからチャンネルページを取得できませんでした');
   const max=3*1024*1024;
   if(Number(response.headers.get('content-length')||0)>max)throw Error('YouTubeページが大きすぎるため、確認できませんでした');
   const chunks=[];let bytes=0;
   if(!response.body)throw Error('YouTubeページを読み取れませんでした');
   for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>max)throw Error('YouTubeページの取得上限を超えました');chunks.push(chunk)}
   const parsed=readChannelMetadata(Buffer.concat(chunks).toString('utf8'));
   if(parsed.id)return {channelId:parsed.id,title:parsed.title};
   throw Error('公開ページからチャンネルIDを確認できませんでした。YouTube側の制限やページ仕様変更の可能性があります');
  }
  throw Error('YouTubeの転送回数が多すぎるため確認できませんでした');
 }finally{clearTimeout(timeout);controller.abort()}
}
function csvRecords(input) {
 const s=String(input||'').replace(/^\uFEFF/,'');
 if(Buffer.byteLength(s,'utf8')>750_000)throw Error('CSVは750KB以下にしてください');
 const rows=[];let row=[],cell='',quoted=false;let limit=0;
 for(let i=0;i<s.length;i++) {
  const c=s[i];
  if(quoted){if(c==='"'&&s[i+1]==='"'){cell+='"';i++}else if(c==='"')quoted=false;else cell+=c;}
  else if(c==='"'){if(cell.trim())throw Error('CSVの引用符が不正です');quoted=true;}
  else if(c===','){row.push(cell);cell=''}
  else if(c==='\n'||c==='\r'){if(c==='\r'&&s[i+1]==='\n')i++;row.push(cell);cell='';if(row.some(v=>v.trim()))rows.push(row);row=[];if(++limit>4000)throw Error('CSVの行数が多すぎます');}
  else cell+=c;
 }
 if(quoted)throw Error('CSVの引用符が閉じられていません');
 row.push(cell);if(row.some(v=>v.trim()))rows.push(row);
 return rows;
}
function parseTakeout(raw) {
 const rows=csvRecords(raw);if(!rows.length)throw Error('CSVが空です');
 const head=rows[0].map(v=>v.toLowerCase().trim().replace(/[\s_\-]/g,''));
 const idCol=head.findIndex(v=>['channelid','チャンネルid'].includes(v));
 const urlCol=head.findIndex(v=>['channelurl','チャンネルurl'].includes(v));
 const titleCol=head.findIndex(v=>['channeltitle','channelname','チャンネルタイトル','チャンネル名'].includes(v));
 const hasHeader=idCol>=0||urlCol>=0;
 const result=new Map();let invalid=0,duplicates=0;
 for(const row of rows.slice(hasHeader?1:0)){
  let id=hasHeader?(channelId(row[idCol])||channelId(row[urlCol])):'';
  if(!id)id=row.map(channelId).find(Boolean)||'';
  if(!id){invalid++;continue;}
  const rawTitle=hasHeader&&titleCol>=0?row[titleCol]:row.find(c=>c.trim()&&c.trim()!==id&&!channelId(c)&&!c.includes('youtube.com'));
  const title=String(rawTitle||id).trim().slice(0,200)||id;
  if(result.has(id)){duplicates++;continue;}
  result.set(id,{channelId:id,title});
  if(result.size>2000)throw Error('登録チャンネルは2000件以内にしてください');
 }
 if(!result.size)throw Error('有効なチャンネルIDがありません。Google Takeoutのsubscriptions.csvを指定してください');
 return {items:[...result.values()],invalid,duplicates,rows:rows.length-(hasHeader?1:0)};
}
function create({db,fetchFeed}) {
 db.exec(`CREATE TABLE IF NOT EXISTS youtube_subscriptions_local(
  account_id INTEGER NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',custom_title TEXT NOT NULL DEFAULT '',origin TEXT NOT NULL CHECK(origin IN ('csv','manual')),
  PRIMARY KEY(account_id,channel_id)
 );
 CREATE INDEX IF NOT EXISTS idx_yts_local_channel ON youtube_subscriptions_local(channel_id);
 CREATE TABLE IF NOT EXISTS youtube_videos_local(
  channel_id TEXT NOT NULL,video_id TEXT NOT NULL,
  title TEXT NOT NULL,url TEXT NOT NULL,excerpt TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',published INTEGER NOT NULL,checked INTEGER NOT NULL,
  PRIMARY KEY(channel_id,video_id)
 );
 CREATE INDEX IF NOT EXISTS idx_ytv_local_date ON youtube_videos_local(published DESC);
 CREATE TABLE IF NOT EXISTS youtube_exclusions_local(
  account_id INTEGER NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY(account_id,channel_id)
 );
 CREATE TABLE IF NOT EXISTS youtube_refresh_local(
  account_id INTEGER PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
  last_refresh INTEGER NOT NULL DEFAULT 0,sync_error TEXT NOT NULL DEFAULT ''
 );`);
 // Per-account local display names survive CSV reimports; original titles remain intact.
 if(!db.prepare('PRAGMA table_info(youtube_subscriptions_local)').all().some(c=>c.name==='custom_title')){
  db.exec("ALTER TABLE youtube_subscriptions_local ADD COLUMN custom_title TEXT NOT NULL DEFAULT ''");
 }
 // Existing installations use the original refresh table. Migration is additive and preserves all records.
 if(!db.prepare('PRAGMA table_info(youtube_refresh_local)').all().some(c=>c.name==='refresh_mode')){
  db.exec("ALTER TABLE youtube_refresh_local ADD COLUMN refresh_mode TEXT NOT NULL DEFAULT 'auto' CHECK(refresh_mode IN ('auto','manual'))");
 }
 const pending=new Map();const active=new Set();
 const account=(id,pid)=>db.prepare("SELECT id,label FROM source_accounts WHERE id=? AND profile_id=? AND service='youtube'").get(id,pid);
 const items=id=>db.prepare("SELECT channel_id AS channelId,COALESCE(NULLIF(custom_title,''),title) AS title,title AS originalTitle,custom_title AS customTitle,origin FROM youtube_subscriptions_local WHERE account_id=? ORDER BY COALESCE(NULLIF(custom_title,''),title) COLLATE NOCASE,channel_id").all(id);
 const excluded=id=>new Set(db.prepare('SELECT channel_id FROM youtube_exclusions_local WHERE account_id=?').all(id).map(x=>x.channel_id));
 const stateHash=id=>sha(JSON.stringify([items(id),[...excluded(id)].sort()]));
 const exclude=db.prepare('INSERT INTO youtube_exclusions_local(account_id,channel_id,created) VALUES(?,?,?) ON CONFLICT(account_id,channel_id) DO NOTHING');
 const unexclude=db.prepare('DELETE FROM youtube_exclusions_local WHERE account_id=? AND channel_id=?');
 const clearLastError=db.prepare("UPDATE youtube_refresh_local SET sync_error='' WHERE account_id=?");
 function status(pid){return db.prepare(`SELECT sa.id,sa.label,
  (SELECT count(*) FROM youtube_subscriptions_local s WHERE s.account_id=sa.id) AS channels,
  (SELECT count(*) FROM youtube_subscriptions_local s WHERE s.account_id=sa.id AND origin='csv') AS csvChannels,
  (SELECT count(*) FROM youtube_subscriptions_local s WHERE s.account_id=sa.id AND origin='manual') AS manualChannels,
  COALESCE(r.last_refresh,0) AS lastRefresh,COALESCE(r.sync_error,'') AS syncError,COALESCE(r.refresh_mode,'auto') AS refreshMode
  FROM source_accounts sa LEFT JOIN youtube_refresh_local r ON r.account_id=sa.id
  WHERE sa.profile_id=? AND sa.service='youtube' ORDER BY sa.id`).all(pid)}
 function preview(id,pid,csv){if(!account(id,pid))throw Error('YouTube表示枠がありません');
  const parsed=parseTakeout(csv);const current=items(id);const incoming=new Map(parsed.items.map(x=>[x.channelId,x]));
  const exclusions=excluded(id);
  const ignored=parsed.items.filter(x=>exclusions.has(x.channelId));
  const added=parsed.items.filter(x=>!exclusions.has(x.channelId)&&!current.some(c=>c.channelId===x.channelId));
  const absent=current.filter(x=>x.origin==='csv'&&!incoming.has(x.channelId));
  const preserved=current.filter(x=>x.origin==='manual'&&!incoming.has(x.channelId));
  const unchanged=parsed.items.length-added.length-ignored.length;
  for(const [key,job] of pending){if(job.expires<now()||(job.id===id&&job.pid===pid))pending.delete(key)}
  if(pending.size>50)pending.clear();
  const token=crypto.randomBytes(24).toString('hex');pending.set(token,{id,pid,parsed,hash:stateHash(id),expires:now()+10*60*1000});
  return {token,added,ignored,absent,preserved,unchanged,valid:parsed.items.length,invalid:parsed.invalid,duplicates:parsed.duplicates,rows:parsed.rows};
 }
 function commit(id,pid,token,removeIds){if(!account(id,pid))throw Error('YouTube表示枠がありません');
  const job=pending.get(token);pending.delete(token);
  if(!job||job.id!==id||job.pid!==pid||job.expires<now())throw Error('取込確認が期限切れです。CSVからやり直してください');
  if(job.hash!==stateHash(id))throw Error('確認後にチャンネル一覧が変更されました。CSVからやり直してください');
  if(!Array.isArray(removeIds)||removeIds.length>2000||removeIds.some(x=>typeof x!=='string'))throw Error('削除候補が不正です');
  const old=items(id),next=new Map(job.parsed.items.map(x=>[x.channelId,x]));
  const removable=new Set(old.filter(x=>x.origin==='csv'&&!next.has(x.channelId)).map(x=>x.channelId));
  if(removeIds.some(x=>!removable.has(x)))throw Error('削除できないチャンネルが含まれます');
  const put=db.prepare(`INSERT INTO youtube_subscriptions_local(account_id,channel_id,title,origin) VALUES(?,?,?,'csv')
   ON CONFLICT(account_id,channel_id) DO UPDATE SET title=excluded.title`);
  const del=db.prepare('DELETE FROM youtube_subscriptions_local WHERE account_id=? AND channel_id=? AND origin=\'csv\'');
  db.exec('BEGIN');try{
   const ignored=excluded(id);
   for(const x of job.parsed.items)if(!ignored.has(x.channelId))put.run(id,x.channelId,x.title);
   for(const cid of removeIds){del.run(id,cid);exclude.run(id,cid,now());}
   if(removeIds.length)clearLastError.run(id);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  return {ok:true,added:job.parsed.items.filter(x=>!old.some(c=>c.channelId===x.channelId)&&!excluded(id).has(x.channelId)).length,removed:removeIds.length,retained:items(id).length};
 }
 async function addChannel(id,pid,value,title){if(!account(id,pid))throw Error('YouTube表示枠がありません');
  const resolved=await resolveChannel(value);
  const cid=resolved.channelId;
  if(!account(id,pid))throw Error('YouTube表示枠がありません');
  const label=String(title||resolved.title||cid).trim().slice(0,200)||cid;
  const existing=db.prepare('SELECT 1 FROM youtube_subscriptions_local WHERE account_id=? AND channel_id=?').get(id,cid);
  if(existing)throw Error('このチャンネルは登録済みです');
  db.exec('BEGIN');try{
   unexclude.run(id,cid);
   db.prepare("INSERT INTO youtube_subscriptions_local(account_id,channel_id,title,origin) VALUES(?,?,?,'manual')").run(id,cid,label);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  return {ok:true,channelId:cid};
 }
 function renameChannel(id,pid,cid,newTitle){
  if(!account(id,pid))throw Error('YouTube表示枠がありません');
  if(!CHANNEL.test(cid))throw Error('チャンネルIDが不正です');
  if(typeof newTitle!=='string'||newTitle.length>200||/[\x00-\x1f\x7f]/.test(newTitle))throw Error('表示名は200文字以内で入力してください');
  const name=newTitle.trim();
  const record=db.prepare('SELECT title FROM youtube_subscriptions_local WHERE account_id=? AND channel_id=?').get(id,cid);
  if(!record)throw Error('このグループにチャンネルがありません');
  // Empty title means reset to the CSV/manual original. The channel ID never changes.
  const override=name===record.title?'':name;
  db.prepare('UPDATE youtube_subscriptions_local SET custom_title=? WHERE account_id=? AND channel_id=?').run(override,id,cid);
  return {ok:true,title:override||record.title};
 }
 function removeChannel(id,pid,cid){if(!account(id,pid))throw Error('YouTube表示枠がありません');
  if(!CHANNEL.test(cid))throw Error('チャンネルIDが不正です');
  db.exec('BEGIN');try{
   const r=db.prepare('DELETE FROM youtube_subscriptions_local WHERE account_id=? AND channel_id=?').run(id,cid);
   if(!r.changes)throw Error('チャンネルがありません');
   exclude.run(id,cid,now());clearLastError.run(id);db.exec('COMMIT');return {ok:true};
  }catch(e){db.exec('ROLLBACK');throw e}
 }
 function changeGroup(id,pid,cid,destination,mode){
  if(!account(id,pid)||!account(destination,pid))throw Error('同じプロファイルのYouTubeグループを指定してください');
  if(id===destination)throw Error('別のグループを選択してください');
  if(!CHANNEL.test(cid)||!['move','copy'].includes(mode))throw Error('操作の指定が不正です');
  const source=db.prepare('SELECT title,origin,custom_title FROM youtube_subscriptions_local WHERE account_id=? AND channel_id=?').get(id,cid);
  if(!source)throw Error('移動元のチャンネルが見つかりません');
  db.exec('BEGIN');try{
   const existing=db.prepare('SELECT 1 FROM youtube_subscriptions_local WHERE account_id=? AND channel_id=?').get(destination,cid);
   if(!existing)db.prepare("INSERT INTO youtube_subscriptions_local(account_id,channel_id,title,origin,custom_title) VALUES(?,?,?,'manual',?)").run(destination,cid,source.title,source.custom_title);
   unexclude.run(destination,cid);
   if(mode==='move'){
    db.prepare('DELETE FROM youtube_subscriptions_local WHERE account_id=? AND channel_id=?').run(id,cid);
    exclude.run(id,cid,now());clearLastError.run(id);
   }
   db.exec('COMMIT');return {ok:true,moved:mode==='move',destinationAlreadyHadChannel:!!existing};
  }catch(e){db.exec('ROLLBACK');throw e}
 }
 function updateSettings(id,pid,mode){
  if(!account(id,pid))throw Error('YouTubeグループがありません');
  if(!['auto','manual'].includes(mode))throw Error('更新方式が不正です');
  db.prepare("INSERT INTO youtube_refresh_local(account_id,refresh_mode) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET refresh_mode=excluded.refresh_mode").run(id,mode);
  return {ok:true,refreshMode:mode};
 }
 // YouTube sometimes replies with transient 404/5xx to valid public Atom URLs.
 // Retry only these specific HTTP failures, once; preserve every other error.
 async function fetchYoutubeAtom(channelId){
  const url=`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let firstError;
  try{return await fetchFeed(url)}catch(e){
   firstError=e;
   if(!/^HTTP (?:404|500|502|503|504)$/.test(say(e)))throw e;
  }
  await new Promise(resolve=>setTimeout(resolve,1200));
  try{return await fetchFeed(url)}catch(e){
   throw Error(`初回 ${say(firstError)}、再試行 ${say(e)}`);
  }
 }
 async function fetchVideos(channels){const put=db.prepare(`INSERT INTO youtube_videos_local(channel_id,video_id,title,url,excerpt,thumbnail,published,checked)
  VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,video_id) DO UPDATE SET
  title=excluded.title,excerpt=excluded.excerpt,thumbnail=excluded.thumbnail,checked=excluded.checked`);
  let position=0,good=0,bad=0;const errors=[];
  async function worker(){while(position<channels.length){const c=channels[position++];try{
   const result=await fetchYoutubeAtom(c);
   if(!result?.feed?.items)throw Error('RSS形式が不正です');
   const stamp=now();for(const a of result.feed.items){
    let vid='';try{const u=new URL(a.url);if(['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname))vid=u.searchParams.get('v')||''}catch{}
    if(!VIDEO.test(vid))vid=String(a.guid||'').split(':').pop();if(!VIDEO.test(vid))continue;
    put.run(c,vid,String(a.title||'').slice(0,500),`https://www.youtube.com/watch?v=${vid}`,String(a.excerpt||'').slice(0,360),`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,Number(a.published)||stamp,stamp);
   }good++;
  }catch(e){bad++;if(errors.length<4)errors.push(`${c}: ${say(e)}`)}}}
  await Promise.all(Array.from({length:Math.min(3,channels.length)},worker));
  return {good,bad,errors};
 }
 async function sync(id,pid,{force=false}={}){
  if(!account(id,pid))throw Error('このプロファイルのYouTube表示枠ではありません');
  if(active.has(id))throw Error('この表示枠は更新中です');active.add(id);
  try{
   const last=db.prepare('SELECT last_refresh FROM youtube_refresh_local WHERE account_id=?').get(id)?.last_refresh||0;
   const subList=items(id),channels=subList.map(x=>x.channelId);
   const mode=db.prepare('SELECT refresh_mode FROM youtube_refresh_local WHERE account_id=?').get(id)?.refresh_mode||'auto';
   if(!force&&mode==='manual')return {ok:true,channels:channels.length,good:0,bad:0,skipped:true,manual:true};
   if(!channels.length)return {ok:true,channels:0,good:0,bad:0,skipped:true};
   if(!force&&now()-last<20*60*1000)return {ok:true,channels:channels.length,good:0,bad:0,skipped:true};
   const result=await fetchVideos(channels);
   const labels=new Map(subList.map(x=>[x.channelId,x.title]));
   const friendlyErrors=result.errors.map(line=>line.replace(/^(UC[A-Za-z0-9_-]{22}): /,(whole,cid)=>`${labels.get(cid)||cid} (${cid}): `));
   if(result.good===0){const msg='YouTube RSSが取得できませんでした（'+result.bad+'件失敗）'+(friendlyErrors.length?': '+friendlyErrors.join('; '):'');
    db.prepare(`INSERT INTO youtube_refresh_local(account_id,sync_error) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET sync_error=excluded.sync_error`).run(id,msg);throw Error(msg)}
   const err=result.bad?`${result.bad}チャンネルのRSS取得に失敗しました: ${friendlyErrors.join('; ')}`:'';
   db.prepare(`INSERT INTO youtube_refresh_local(account_id,last_refresh,sync_error) VALUES(?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET last_refresh=excluded.last_refresh,sync_error=excluded.sync_error`).run(id,now(),err);
   return {ok:true,channels:channels.length,good:result.good,bad:result.bad};
  }finally{active.delete(id)}
 }
 function videos(pid,id,limit=100,cid=''){if(id&&!account(id,pid))throw Error('このプロファイルの表示枠ではありません');
  if(cid&&(!id||!CHANNEL.test(cid)||!db.prepare('SELECT 1 FROM youtube_subscriptions_local WHERE account_id=? AND channel_id=?').get(id,cid)))throw Error('このアカウントに登録されたチャンネルではありません');
  const rows=db.prepare(`SELECT v.video_id AS id,max(v.channel_id) AS channelId,v.title,v.url,v.excerpt,v.thumbnail,v.published,
   json_group_array(DISTINCT sa.id) AS accounts,json_group_array(DISTINCT sa.label) AS labels,
   max(COALESCE(NULLIF(s.custom_title,''),s.title)) AS channel
   FROM youtube_videos_local v
   JOIN youtube_subscriptions_local s ON s.channel_id=v.channel_id
   JOIN source_accounts sa ON sa.id=s.account_id AND sa.profile_id=? AND sa.service='youtube'
   WHERE (?=0 OR sa.id=?) AND (?='' OR v.channel_id=?)
   GROUP BY v.video_id ORDER BY v.published DESC LIMIT ?`).all(pid,id,id,cid,cid,Math.min(150,Math.max(1,limit)));
  return rows.map(x=>({...x,accounts:JSON.parse(x.accounts),labels:JSON.parse(x.labels)}));
 }
 const readId=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):0;
 async function handle(req,res,route,u,pid,body,json,fail){
  const m=route.match(/^\/api\/youtube\/(status|videos|channels|preview|commit|add|remove|rename|sync|transfer|settings)(?:\/(\d+))?$/);
  if(!m)return false;
  const action=m[1],id=readId(m[2]);
  if(action==='status'&&req.method==='GET')return json(res,200,{accounts:status(pid),running:[...active].filter(x=>!!account(x,pid))})||true;
  if(action==='videos'&&req.method==='GET'){
   try{const selected=readId(u.searchParams.get('accountId')||0),cid=u.searchParams.get('channelId')||'';json(res,200,{videos:videos(pid,selected,150,cid)})}catch(e){fail(res,say(e),404)}return true;
  }
  if(!id||!account(id,pid))return fail(res,'このプロファイルのYouTube表示枠ではありません',404)||true;
  if(action==='channels'&&req.method==='GET')return json(res,200,{channels:items(id)})||true;
  if(req.method!=='POST')return fail(res,'操作が許可されていません',405)||true;
  try{
   const read=async limit=>JSON.parse((await body(req,limit)).toString('utf8'));
   if(action==='preview'){const x=await read(850_000);json(res,200,preview(id,pid,x.csv));}
   else if(action==='commit'){const x=await read(200_000);json(res,200,commit(id,pid,x.token,x.removeIds));}
   else if(action==='add'){const x=await read(8000);json(res,200,await addChannel(id,pid,x.channel,x.title));}
   else if(action==='remove'){const x=await read(2000);json(res,200,removeChannel(id,pid,x.channelId));}
   else if(action==='rename'){const x=await read(3000);json(res,200,renameChannel(id,pid,x.channelId,x.title));}
   else if(action==='transfer'){const x=await read(4000);json(res,200,changeGroup(id,pid,x.channelId,readId(x.destinationId),x.mode));}
   else if(action==='settings'){const x=await read(1000);json(res,200,updateSettings(id,pid,x.refreshMode));}
   else if(action==='sync'){json(res,200,await sync(id,pid,{force:true}));}
   else fail(res,'操作が許可されていません',405);
  }catch(e){fail(res,say(e),/同期中/.test(say(e))?409:400)}return true;
 }
 async function scheduled(){const entries=db.prepare("SELECT id,profile_id FROM source_accounts WHERE service='youtube'").all();
  // Deduplicate feed refreshes by account state; never access other services or browser credentials.
  for(const a of entries){if(active.has(a.id))continue;
   try{await sync(a.id,a.profile_id)}catch(e){console.warn('[YT] '+a.id+': '+say(e))}
  }
 }
 return {handle,scheduled};
}
module.exports={create,parseTakeout,channelId,resolveChannel,readChannelMetadata};
