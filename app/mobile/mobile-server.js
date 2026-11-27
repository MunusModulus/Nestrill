'use strict';
// Optional LAN-only Nestrill mobile reader. E2 manual search only; no settings or secret profile.
// Loaded from server.js only after an authenticated LOOPBACK control request.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {randomBytes, randomInt, timingSafeEqual, createHash} = require('node:crypto');
const PORT = 8768;
const WEB = path.join(__dirname, 'mobile-web');
const MAX_SESSION_AGE = 30 * 24 * 60 * 60 * 1000;
const SESSION_FILE = path.join(__dirname, '..', 'run', 'nestrill-mobile-sessions-v1.json');
const MAX_SESSIONS = 32;
const COOKIE = 'nestrill_mobile_session';

function localPrivateAddresses() {
  const out = new Set();
  for (const entries of Object.values(os.networkInterfaces())) for (const item of entries || []) {
    if (item.internal || item.family !== 'IPv4') continue;
    const a = item.address.split('.').map(Number);
    if (a.length !== 4 || a.some(n => !Number.isInteger(n) || n < 0 || n > 255)) continue;
    if (a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168)) out.add(item.address);
  }
  return [...out];
}
function safeUrl(url) {
  try { const u = new URL(String(url || '')); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; }
  catch { return ''; }
}
function sanitizeArticle(a) {
  return {id:Number(a.id), title:a.title || '', url:safeUrl(a.url), excerpt:a.excerpt || '',
    thumbnail:safeUrl(a.thumbnail), published:Number(a.published)||0, readAt:a.readAt ?? null,
    starred:!!a.starred, feedTitle:a.feedTitle || '', feedId:Number(a.feedId)||0};
}
function sanitizeRecommendation(item) {
  return {id:String(item.id ?? ''), title:String(item.title||''),
    url:safeUrl(item.articleUrl || item.url), excerpt:String(item.excerpt||''),
    source:String(item.source||''), published:Number(item.published)||0,
    origin:item.origin==='external'?'external':'registered',
    bucket:['explicit','inferred','discovery'].includes(item.bucket)?item.bucket:'',
    score:Number(item.score)||0, feedbackRating:Number(item.feedback?.rating)||0};
}
function sanitizeExternal(item){
  return {id:String(item.id??''),title:String(item.title||''),url:safeUrl(item.url),
    source:String(item.source||'').slice(0,160),published:Number(item.published)||0,
    queryLabel:String(item.queryLabel||'').slice(0,120)};
}
function writeJson(res, status, value, headers={}) {
  const bytes=Buffer.from(JSON.stringify(value));
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8',...headers});res.end(bytes);
}
function getBody(req) {
  return new Promise((resolve,reject)=>{
    let total=0, chunks=[];
    req.on('data',chunk=>{total+=chunk.length;if(total>4096){reject(new Error('本文が長すぎます'));req.destroy();return;}chunks.push(chunk);});
    req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{reject(new Error('JSONが不正です'))}});
    req.on('error',reject);
  });
}
// Sessions are stored as SHA-256 digests of random 256-bit bearer tokens.
// Read from disk for every request: revocation takes effect immediately, even while
// the PC server is running. Never store the raw token or 8-digit login code on disk.
function tokenDigest(token) { return createHash('sha256').update(token).digest('hex'); }
function cookieToken(req) {
  return String(req.headers.cookie || '').match(/(?:^|;\s*)nestrill_mobile_session=([a-f0-9]{64})(?=;|$)/)?.[1] || '';
}
function readSessions() {
  let raw;
  try { raw = fs.readFileSync(SESSION_FILE, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  if (Buffer.byteLength(raw, 'utf8') > 32768) throw new Error('Mobile sessions file exceeds limit');
  const obj = JSON.parse(raw);
  if (obj.version !== 1 || !Array.isArray(obj.sessions)) throw new Error('Invalid Mobile sessions file');
  const now = Date.now();
  return obj.sessions.filter(s => s && /^[a-f0-9]{64}$/.test(s.digest) &&
    Number.isSafeInteger(s.created) && Number.isSafeInteger(s.expires) &&
    s.created <= now && s.expires > now && s.expires - s.created === MAX_SESSION_AGE)
    .slice(-MAX_SESSIONS);
}
function writeSessions(sessions) {
  fs.mkdirSync(path.dirname(SESSION_FILE), {recursive:true});
  const tmp = SESSION_FILE + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({version:1,sessions}),
      {encoding:'utf8', mode:0o600, flag:'wx'});
    fs.renameSync(tmp, SESSION_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function create({db,profileList,overview,selectArticles,aiRecommend,aiSourceFeedback,startMobileRssRefresh,mobileRefreshStatus,readMobileBackground,mobileBackgroundBytes,readMobilePalette,mobileE2,mobileConditional}) {
  let listener=null, activeHost='', pin='';
  const attempts=new Map();
  // Authenticated mobile clients may start E2, but may not continuously re-trigger Ollama.
  const lastE2Start=new Map();
  const lastConditionalStart=new Map();
  function stop(){
    const old=listener;listener=null;activeHost='';pin='';attempts.clear();
    if(old) old.close();
  }
  function info(){return listener?{enabled:true,url:`http://${activeHost}:${PORT}/mobile/`,pin,host:activeHost,port:PORT}:{enabled:false};}
  function normalProfile(value){
    const id=Number(value);if(!Number.isSafeInteger(id)||id<1)return null;
    return db.prepare('SELECT id,name FROM profiles WHERE id=? AND is_secret=0').get(id)||null;
  }
  function requireSession(req){
    const token=cookieToken(req);
    if (!token) return false;
    const digest=tokenDigest(token);
    return readSessions().some(s=>s.digest===digest);
  }
  function csrfOk(req){
    return req.headers.origin===`http://${activeHost}:${PORT}` &&
      String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()==='application/json';
  }
  async function handle(req,res){
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if(req.headers.host!==`${activeHost}:${PORT}`)return writeJson(res,403,{error:'無効なホストです'});
    let url;
    try{url=new URL(req.url,`http://${activeHost}:${PORT}`)}catch{return writeJson(res,400,{error:'不正なURL'})}
    if(!['GET','POST'].includes(req.method))return writeJson(res,405,{error:'許可されていません'});
    if(req.method==='POST'&&!csrfOk(req))return writeJson(res,403,{error:'不正な送信元です'});
    const route=url.pathname;
    if(req.method==='GET'&&['/mobile/','/mobile/app.js','/mobile/style.css'].includes(route)){
      const name=route==='/mobile/'?'index.html':route.slice('/mobile/'.length);
      const content=fs.readFileSync(path.join(WEB,name));
      res.writeHead(200,{'Content-Type':name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.js')?'application/javascript; charset=utf-8':'text/html; charset=utf-8'});
      return res.end(content);
    }
    if(req.method==='GET'&&route==='/mobile/api/session')return writeJson(res,200,{authenticated:requireSession(req)});
    if(req.method==='POST'&&route==='/mobile/api/login'){
      const ip=req.socket.remoteAddress||'';
      const a=attempts.get(ip)||{count:0,start:Date.now()};
      if(Date.now()-a.start>5*60*1000){a.count=0;a.start=Date.now()}
      if(a.count>=5)return writeJson(res,429,{error:'試行回数が多すぎます。5分後にもう一度お試しください。'});
      const b=await getBody(req),input=typeof b.code==='string'?b.code:'';
      const supplied=Buffer.from(input),expected=Buffer.from(pin);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){
        a.count++;attempts.set(ip,a);return writeJson(res,403,{error:'接続コードが違います'});
      }
      attempts.delete(ip);const token=randomBytes(32).toString('hex');
      const now=Date.now();
      const rows=readSessions();
      rows.push({digest:tokenDigest(token),created:now,expires:now+MAX_SESSION_AGE});
      writeSessions(rows.slice(-MAX_SESSIONS));
      return writeJson(res,200,{ok:true},{'Set-Cookie':`${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/mobile; Max-Age=2592000`});
    }
    if(req.method==='POST'&&route==='/mobile/api/logout'){
      const token=cookieToken(req);
      if(token){
        const digest=tokenDigest(token),rows=readSessions();
        if(rows.some(s=>s.digest===digest))writeSessions(rows.filter(s=>s.digest!==digest));
      }
      return writeJson(res,200,{ok:true},{'Set-Cookie':`${COOKIE}=; HttpOnly; SameSite=Strict; Path=/mobile; Max-Age=0`});
    }
    if(!requireSession(req))return writeJson(res,401,{error:'接続コードで認証してください'});
    // Fix99A: these two GETs are behind the existing 30-day session validation.
    if(req.method==='GET'&&route==='/mobile/api/appearance'){
      const bg=readMobileBackground();
      return writeJson(res,200,{mode:bg.mode,color:bg.color,version:bg.mode==='image'&&bg.image?bg.image.slice(10,-5):'',palette:readMobilePalette()});
    }
    if(req.method==='GET'&&route==='/mobile/api/background-image'){
      const bg=mobileBackgroundBytes(),version=url.searchParams.get('v');
      if(!bg||!version||version!==bg.version)return writeJson(res,404,{error:'背景画像が見つかりません'});
      const headers={'Content-Type':'image/webp','Content-Length':bg.bytes.length,'ETag':'"'+bg.version+'"'};
      if(req.headers['if-none-match']==='"'+bg.version+'"'){res.writeHead(304,headers);return res.end()}
      res.writeHead(200,headers);return res.end(bg.bytes);
    }
    if(req.method==='GET'&&route==='/mobile/api/profiles')return writeJson(res,200,{profiles:profileList().map(p=>({id:p.id,name:p.name}))});
    // Fix93A: same authenticated session and strict same-origin POST check as article-state.
    // No free-form URL, feed ID or secret profile can be supplied by the client.
    if(req.method==='POST'&&route==='/mobile/api/rss-refresh'){
      const b=await getBody(req);
      const profile=normalProfile(b.profileId);
      if(!profile)return writeJson(res,404,{error:'プロファイルがありません'});
      return writeJson(res,200,startMobileRssRefresh(profile.id));
    }
    if(req.method==='GET'&&route==='/mobile/api/rss-refresh-status'){
      return writeJson(res,200,mobileRefreshStatus());
    }
    if(req.method==='GET'&&route==='/mobile/api/overview'){
      const profile=normalProfile(url.searchParams.get('profile'));if(!profile)return writeJson(res,404,{error:'プロファイルがありません'});
      const o=overview(profile.id);
      return writeJson(res,200,{categories:o.categories.map(c=>({id:c.id,name:c.name,unread:c.unread})),
        feeds:o.feeds.map(f=>({id:f.id,title:f.title,categoryId:f.categoryId,unread:f.unread})),
        unread:o.unread,total:o.total});
    }
    if(req.method==='GET'&&route==='/mobile/api/articles'){
      const profile=normalProfile(url.searchParams.get('profile'));if(!profile)return writeJson(res,404,{error:'プロファイルがありません'});
      const q=new URLSearchParams();
      const page=Number(url.searchParams.get('page')||0);
      if(!Number.isInteger(page)||page<0||page>10000)return writeJson(res,400,{error:'ページが不正です'});
      q.set('page',String(page));
      const filter=url.searchParams.get('filter');if(['all','unread','starred'].includes(filter))q.set('filter',filter);
      const category=url.searchParams.get('category'),feed=url.searchParams.get('feed');
      if(category && /^\d{1,12}$/.test(category))q.set('category',category);
      if(feed && /^\d{1,12}$/.test(feed))q.set('feed',feed);
      q.set('q',(url.searchParams.get('q')||'').slice(0,100));
      const data=selectArticles(q,profile.id);
      return writeJson(res,200,{total:data.total,page:data.page,limit:data.limit,articles:data.articles.map(sanitizeArticle)});
    }
    // Fix103I: replace the old mobile 7:2:1 view with the PC's E2 results.
    // All routes are below the session gate; all POSTs require strict same-origin JSON.
    if(req.method==='GET'&&route==='/mobile/api/external'){
      const profile=normalProfile(url.searchParams.get('profile'));
      if(!profile)return writeJson(res,404,{error:'プロファイルがありません'});
      const result=mobileE2.status(profile.id);
      return writeJson(res,200,{items:(result.items||[]).map(sanitizeExternal),
        generatedAt:Number(result.generatedAt)||0,running:!!result.running,
        error:String(result.error||'').slice(0,180),
        progress:result.progress?{completed:Number(result.progress.completed)||0,total:Number(result.progress.total)||0}:null});
    }
    if(req.method==='POST'&&route==='/mobile/api/external/refresh'){
      const input=await getBody(req),profile=normalProfile(input.profileId);
      if(!profile)return writeJson(res,404,{error:'プロファイルがありません'});
      if(mobileE2.status(profile.id).running)return writeJson(res,200,{started:false,running:true});
      const now=Date.now();
      if(now-(lastE2Start.get(profile.id)||0)<30000)
        return writeJson(res,429,{error:'直前に探索を開始しました。少し時間を空けてください'});
      const result=mobileE2.start(profile.id);
      if(result.started)lastE2Start.set(profile.id,now);
      return writeJson(res,200,result);
    }
    // v0.2.4: explicit, authenticated, normal-profile-only condition exploration.
    // Never forward arbitrary URLs or generic PC API calls.
    if(req.method==='GET'&&route==='/mobile/api/conditional/catalog'){
      const profile=normalProfile(url.searchParams.get('profile'));
      if(!profile)return writeJson(res,404,{error:'プロファイルがありません'});
      return writeJson(res,200,{groups:mobileConditional.catalog()});
    }
    if(req.method==='GET'&&route==='/mobile/api/conditional'){
      const profile=normalProfile(url.searchParams.get('profile'));
      if(!profile)return writeJson(res,404,{error:'プロファイルがありません'});
      const result=mobileConditional.status(profile.id);
      const offset=Number(url.searchParams.get('offset')||0);
      if(!Number.isSafeInteger(offset)||offset<0||offset>1000)return writeJson(res,400,{error:'表示位置が不正です'});
      const items=result.items||[],page=items.slice(offset,offset+40);
      return writeJson(res,200,{items:page.map(sanitizeExternal),totalVisible:items.length,hasMore:offset+page.length<items.length,
        generatedAt:Number(result.generatedAt)||0,running:!!result.running,error:String(result.error||'').slice(0,180),
        order:result.order==='latest'?'latest':'random',progress:result.progress?{completed:Number(result.progress.completed)||0,total:Number(result.progress.total)||0}:null});
    }
    if(req.method==='POST'&&route==='/mobile/api/conditional/refresh'){
      const input=await getBody(req);
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['profileId','categories','useInterests','useLikes','order'].includes(k)))return writeJson(res,400,{error:'探索条件が不正です'});
      const profile=normalProfile(input.profileId);
      if(!profile)return writeJson(res,404,{error:'プロファイルがありません'});
      const {categories,useInterests,useLikes,order}=input;
      if(!Array.isArray(categories)||typeof useInterests!=='boolean'||typeof useLikes!=='boolean'||!['latest','random'].includes(order))return writeJson(res,400,{error:'探索条件が不正です'});
      const valid=new Set(mobileConditional.catalog().flatMap(group=>group.categories));
      if(categories.length>valid.size||new Set(categories).size!==categories.length||categories.some(x=>typeof x!=='string'||!valid.has(x)))return writeJson(res,400,{error:'ジャンルが不正です'});
      if(mobileConditional.status(profile.id).running)return writeJson(res,200,{started:false,running:true});
      const now=Date.now();
      if(now-(lastConditionalStart.get(profile.id)||0)<30000)return writeJson(res,429,{error:'直前に探索を開始しました。少し時間を空けてください'});
      const result=mobileConditional.start(profile.id,{categories,useInterests,useLikes,order});
      if(result.started)lastConditionalStart.set(profile.id,now);
      return writeJson(res,200,result);
    }
    if(req.method==='GET'&&route==='/mobile/api/recommendations')
      return writeJson(res,410,{error:'旧7：2：1表示は終了しました。AIセレクトをお使いください'});
    if(req.method==='POST'&&route==='/mobile/api/article-state'){
      const x=await getBody(req),profile=normalProfile(x.profileId);
      if(!profile)return writeJson(res,404,{error:'プロファイルがありません'});
      const id=Number(x.articleId);
      if(!Number.isSafeInteger(id)||id<1||!db.prepare('SELECT 1 FROM articles a JOIN profile_feeds pf ON pf.feed_id=a.feed_id WHERE a.id=? AND pf.profile_id=?').get(id,profile.id))
        return writeJson(res,404,{error:'このプロファイルに記事がありません'});
      if(typeof x.read!=='boolean'&&typeof x.starred!=='boolean')return writeJson(res,400,{error:'更新内容がありません'});
      if(typeof x.read==='boolean')db.prepare(`INSERT INTO profile_article_state(profile_id,article_id,read_at,starred)
        VALUES(?,?,?,0) ON CONFLICT(profile_id,article_id) DO UPDATE SET read_at=excluded.read_at`).run(profile.id,id,x.read?Date.now():null);
      if(typeof x.starred==='boolean')db.prepare(`INSERT INTO profile_article_state(profile_id,article_id,read_at,starred)
        VALUES(?,?,NULL,?) ON CONFLICT(profile_id,article_id) DO UPDATE SET starred=excluded.starred`).run(profile.id,id,x.starred?1:0);
      return writeJson(res,200,{ok:true});
    }
    return writeJson(res,404,{error:'見つかりません'});
  }
  async function start(host){
    if(listener){if(host===activeHost)return info();throw new Error('別のIPでモバイル版が既に起動しています。いったん停止してください。')}
    if(!localPrivateAddresses().includes(host))throw new Error('PCのLAN用IPv4アドレスのみ指定できます');
    activeHost=host;pin=String(randomInt(10000000,100000000));
    const s=http.createServer((req,res)=>{handle(req,res).catch(e=>{console.error('[MOBILE]',e.message);if(!res.headersSent)writeJson(res,400,{error:'処理できませんでした'});else res.end()})});
    s.on('error',e=>console.error('[MOBILE] listen:',e.message));
    try{await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(PORT,host,()=>{s.off('error',reject);resolve()})});listener=s;console.log('[MOBILE] enabled on '+host+':'+PORT);return info();}
    catch(e){activeHost='';pin='';try{s.close()}catch{}throw e}
  }
  return {start,stop,info,localPrivateAddresses};
}
module.exports={create,localPrivateAddresses};
