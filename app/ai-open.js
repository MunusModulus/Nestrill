'use strict';
// Nestrill-Next: navigation-confirmed, very weak inferred-interest evidence.
// The browser always opens an encrypted Nestrill link, whose GET performs the
// redirect AND records the event. It does not guess from drag/click events.
const fs=require('node:fs');
const path=require('node:path');
const {createHash,createCipheriv,createDecipheriv,randomBytes}=require('node:crypto');
const AGE_MS=7*86400000; // Old tabs should work for a week without reloading.
const SECRET_AGE_MS=2*60*60*1000;
const RETAIN_MS=180*86400000;
const DAILY_MS=24*60*60*1000;
const isHttpUrl=s=>{try{const u=new URL(s);return (u.protocol==='https:'||u.protocol==='http:')&&!u.username&&!u.password&&s.length<2100}catch{return false}};
const hashSecret=s=>createHash('sha256').update(String(s)).digest('hex');

// Fix103Z: Optional, non-blocking E2 Google News URL resolution.
// Only the final, already-visible E2 items are queued. Never wait on this at click time;
// failed, incomplete, mismatched, or rate-limited resolutions use the original Google link.
// No publisher pages are fetched. No data is persisted and no AI jobs are started.
const https=require('node:https');
function newsGoogleId(link){
 try{
  const u=new URL(link);
  if(u.protocol!=='https:'||u.hostname!=='news.google.com'||u.username||u.password)return null;
  const match=u.pathname.match(/^\/(?:rss\/)?(?:articles|read)\/([A-Za-z0-9_-]{20,1600})\/?$/);
  if(!match)return null;
  const ceid=u.searchParams.get('ceid')||'JP:ja';
  const region=/^[A-Z]{2}:[a-z]{2}(?:-[A-Z]{2})?$/.test(ceid)?ceid:'JP:ja';
  const query=new URLSearchParams();
  for(const key of ['hl','gl','ceid']){
   const value=u.searchParams.get(key);
   if(value&&value.length<=20&&/^[A-Za-z0-9:_-]+$/.test(value))query.set(key,value);
  }
  // Request an explicit locale; Google may otherwise return a 302 before HTML.
  if(!query.has('hl'))query.set('hl',region.split(':')[1]);
  if(!query.has('gl'))query.set('gl',region.split(':')[0]);
  if(!query.has('ceid'))query.set('ceid',region);
  return {id:match[1],region,query:query.toString()};
 }catch{return null}
}
function newsPublisherHost(host){
 const text=String(host||'').trim().toLowerCase();
 if(text.length<4||text.length>180||!/^([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(text))return '';
 return text.replace(/^www\./,'');
}
function newsHostMatches(destination,host){
 const expected=newsPublisherHost(host);
 if(!expected)return false;
 try{
  const u=new URL(destination),actual=newsPublisherHost(u.hostname);
  return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&
   !!actual&&actual!=='news.google.com'&&destination.length<2100&&
   (actual===expected||actual.endsWith('.'+expected));
 }catch{return false}
}
// Only issue HTTP requests to a hard-coded Google host, never to a decoded URL.
function newsGoogleRequest(route,method='GET',body='',hops=0){
 return new Promise((resolve,reject)=>{
  let settled=false;
  const headers={
   'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
   'Accept':'text/html,application/json;q=0.9,*/*;q=0.8',
   'Accept-Language':'ja-JP,ja;q=0.9,en-US;q=0.7',
   'Accept-Encoding':'identity',
   'Cookie':'CONSENT=PENDING+987'
  };
  if(method==='POST'){
   headers['Content-Type']='application/x-www-form-urlencoded;charset=UTF-8';
   headers['Content-Length']=Buffer.byteLength(body);
   headers['Origin']='https://news.google.com';
   headers['Referer']='https://news.google.com/';
  }
  const req=https.request({hostname:'news.google.com',port:443,protocol:'https:',path:route,method,headers},res=>{
   const chunks=[];let size=0;
   res.on('data',chunk=>{
    size+=chunk.length;
    if(size>2*1024*1024){req.destroy(Error('NEWS_SIZE_LIMIT'));return}
    chunks.push(chunk);
   });
   res.on('end',()=>{
    if(settled)return;
    settled=true;clearTimeout(timer);
    if(res.statusCode===429||res.statusCode===403){reject(Error('NEWS_RATE_LIMIT'));return}
    // Follow locale redirects only on the same Google News article path.
    if(method==='GET'&&[301,302,303,307,308].includes(res.statusCode)){
     if(hops>=3){reject(Error('NEWS_REDIRECT_LIMIT'));return}
     let target;
     try{target=new URL(String(res.headers.location||''),'https://news.google.com'+route)}
     catch{reject(Error('NEWS_BAD_REDIRECT'));return}
     const original=new URL('https://news.google.com'+route);
     if(target.protocol!=='https:'||target.hostname!=='news.google.com'||
        target.username||target.password||target.pathname!==original.pathname){
      reject(Error('NEWS_REDIRECT_OUTSIDE'));return;
     }
     resolve(newsGoogleRequest(target.pathname+target.search,'GET','',hops+1));return;
    }
    if(res.statusCode!==200){reject(Error('NEWS_HTTP_'+res.statusCode));return}
    resolve(Buffer.concat(chunks).toString('utf8'));
   });
   res.on('error',err=>{if(!settled){settled=true;clearTimeout(timer);reject(err)}});
  });
  const timer=setTimeout(()=>req.destroy(Error('NEWS_TIMEOUT')),5500);
  req.on('error',err=>{if(!settled){settled=true;clearTimeout(timer);reject(err)}});
  if(body)req.write(body);
  req.end();
 });
}
function newsRpcUrl(response){
 for(const line of String(response).split('\n')){
  const candidate=line.trim();
  if(!candidate.startsWith('[')||!candidate.includes('wrb.fr'))continue;
  try{
   const rows=JSON.parse(candidate);
   function findRow(value,depth=0){
    if(depth>4||!Array.isArray(value))return null;
    if(value[0]==='wrb.fr'&&value[1]==='Fbv4je')return value;
    for(const element of value){const found=findRow(element,depth+1);if(found)return found}
    return null;
   }
   const row=findRow(rows);
   if(!row||typeof row[2]!=='string')continue;
   const data=JSON.parse(row[2]);
   if(Array.isArray(data)&&data[0]==='garturlres'&&typeof data[1]==='string')return data[1];
  }catch{}
 }
 return '';
}
async function newsResolveGoogleUrl(source){
 const info=newsGoogleId(source);if(!info)return '';
 const path='/rss/articles/'+info.id+(info.query?'?'+info.query:'');
 const html=await newsGoogleRequest(path);
 const sg=html.match(/data-n-a-sg="([^"]{4,500})"/);
 const ts=html.match(/data-n-a-ts="([0-9]{8,16})"/);
 if(!sg||!ts)return '';
 const request=['garturlreq',
  [['X','X',['X','X'],null,null,1,1,info.region,null,1,null,null,null,null,null,0,1],
   'X','X',1,[1,1,1],1,1,null,0,0,null,0],info.id,Number(ts[1]),sg[1]];
 const fReq=JSON.stringify([[['Fbv4je',JSON.stringify(request),null,'generic']]]);
 const body=new URLSearchParams({'f.req':fReq}).toString();
 return newsRpcUrl(await newsGoogleRequest('/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je','POST',body));
}
function createNewsPrefetch(){
 const cached=new Map(),queue=[];
 let active=0,pausedUntil=0,ok=0,failed=0,mismatched=0;
 const failureReasons=Object.create(null);
 function failure(reason){failureReasons[reason]=(failureReasons[reason]||0)+1}
 const MAX_CACHE=160,MAX_QUEUE=50,MAX_ACTIVE=2;
 function pump(){
  if(Date.now()<pausedUntil)return;
  while(active<MAX_ACTIVE&&queue.length){
   const url=queue.shift(),entry=cached.get(url);
   if(!entry||entry.status!=='queued')continue;
   entry.status='running';active++;
   newsResolveGoogleUrl(url).then(value=>{
    if(newsHostMatches(value,entry.publisherHost)){
     entry.status='ready';entry.destination=value;ok++;
    }else{entry.status='failed';if(value){mismatched++;failure('SOURCE_MISMATCH')}else{failed++;failure('NO_URL')}}
   }).catch(err=>{
    entry.status='failed';failed++;
    failure(String(err?.message||'OTHER').slice(0,80));
    if(err&&err.message==='NEWS_RATE_LIMIT'){
     pausedUntil=Date.now()+15*60*1000;
     for(const waiting of queue){const x=cached.get(waiting);if(x)x.status='failed'}
     queue.length=0;
     console.log('[Nestrill E2 link prefetch] Google rate-limited; normal Google links retained.');
    }
   }).finally(()=>{
    active--;
    if(!queue.length&&!active&&(ok||failed||mismatched)){
     console.log('[Nestrill E2 link prefetch] ready='+ok+' failed='+failed+' sourceMismatch='+mismatched+
      ' reasons='+JSON.stringify(failureReasons)+' (click never waits)');
    }
    pump();
   });
  }
 }
 function warm(url,publisherHost){
  if(!newsGoogleId(url))return;
  const host=newsPublisherHost(publisherHost);if(!host||Date.now()<pausedUntil)return;
  const existing=cached.get(url);
  if(existing){
   const ttl=existing.status==='ready'?2*86400000:20*60000;
   if(Date.now()-existing.created<ttl)return;
   if(existing.status==='queued'||existing.status==='running')return;
   cached.delete(url);
  }
  if(queue.length>=MAX_QUEUE)return;
  while(cached.size>=MAX_CACHE){cached.delete(cached.keys().next().value)}
  cached.set(url,{created:Date.now(),publisherHost:host,status:'queued',destination:''});
  queue.push(url);pump();
 }
 function redirect(url,host){
  const entry=cached.get(url);
  return entry?.status==='ready'&&newsHostMatches(entry.destination,host)?entry.destination:'';
 }
 return {warm,redirect};
}

function create({db,dataDir,secretId,secretSessions}){
 const newsPrefetch=createNewsPrefetch();
 const keyPath=path.join(dataDir,'ai-open-link.key');
 let key;
 if(fs.existsSync(keyPath)){key=Buffer.from(fs.readFileSync(keyPath,'utf8').trim(),'base64');if(key.length!==32)throw Error('AI open-link key has invalid length')}
 else{key=randomBytes(32);try{fs.writeFileSync(keyPath,key.toString('base64'),{flag:'wx',mode:0o600})}
  catch(e){if(e.code!=='EEXIST')throw e;key=Buffer.from(fs.readFileSync(keyPath,'utf8').trim(),'base64')}}
 db.exec(`CREATE TABLE IF NOT EXISTS ai_article_open_signals(
   profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
   kind TEXT NOT NULL CHECK(kind IN ('rss','youtube')),
   item_id TEXT NOT NULL,title TEXT NOT NULL,
   first_opened_at INTEGER NOT NULL,last_opened_at INTEGER NOT NULL,
   open_days INTEGER NOT NULL DEFAULT 1,
   PRIMARY KEY(profile_id,kind,item_id));
 CREATE INDEX IF NOT EXISTS idx_ai_open_recent ON ai_article_open_signals(profile_id,last_opened_at DESC);`);
 db.prepare('DELETE FROM ai_article_open_signals WHERE last_opened_at < ?').run(Date.now()-RETAIN_MS);
 function href(pid,kind,item,req){
  const url=String(item?.url||''),title=String(item?.title||'').slice(0,250),id=String(item?.id??'');
  if(!isHttpUrl(url)||!['rss','youtube'].includes(kind)||!id||id.length>120)return url;
  if(!Number.isSafeInteger(pid)||pid<=0)return url;
  const secret=pid===secretId;
  if(secret&&(!req._secret||!req._secretToken))return url;
  const isE2=kind==='rss'&&id.startsWith('x:');
  const publisherHost=isE2?newsPublisherHost(item?.publisherHost):'';
  if(publisherHost)newsPrefetch.warm(url,publisherHost);
  const record={v:1,pid,kind,id,title,url,expires:Date.now()+(secret?SECRET_AGE_MS:AGE_MS),
   ...(publisherHost?{publisherHost}:{}),
   ...(secret?{secretHash:hashSecret(req._secretToken)}:{})};
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(record),'utf8'),cipher.final()]);
  const token=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
  return '/api/ai/open/'+token;
 }
 function decode(token){
  if(!/^[a-zA-Z0-9_-]{40,5000}$/.test(token))return null;
  try{
   const buf=Buffer.from(token,'base64url');if(buf.length<30)return null;
   const dec=createDecipheriv('aes-256-gcm',key,buf.subarray(0,12));dec.setAuthTag(buf.subarray(12,28));
   const value=JSON.parse(Buffer.concat([dec.update(buf.subarray(28)),dec.final()]).toString('utf8'));
   if(value.v!==1||!Number.isSafeInteger(value.pid)||value.pid<=0||
    !['rss','youtube'].includes(value.kind)||typeof value.id!=='string'||value.id.length>120||
    typeof value.title!=='string'||value.title.length>250||!isHttpUrl(value.url)||
    typeof value.expires!=='number'||value.expires<Date.now()||value.expires>Date.now()+AGE_MS)return null;
   if(value.pid===secretId){
    if(!value.secretHash||!([...secretSessions].some(([secret,expires])=>expires>Date.now()&&hashSecret(secret)===value.secretHash)))return null;
   }else if(value.secretHash||!db.prepare('SELECT 1 FROM profiles WHERE id=? AND is_secret=0').get(value.pid))return null;
   return value;
  }catch{return null}
 }
 function record(v){
  const now=Date.now();const row=db.prepare('SELECT last_opened_at FROM ai_article_open_signals WHERE profile_id=? AND kind=? AND item_id=?').get(v.pid,v.kind,v.id);
  if(row&&now-row.last_opened_at<DAILY_MS)return false;
  db.prepare(`INSERT INTO ai_article_open_signals(profile_id,kind,item_id,title,first_opened_at,last_opened_at,open_days)
   VALUES(?,?,?,?,?,?,1) ON CONFLICT(profile_id,kind,item_id) DO UPDATE SET
   title=excluded.title,last_opened_at=excluded.last_opened_at,open_days=MIN(ai_article_open_signals.open_days+1,30)`)
   .run(v.pid,v.kind,v.id,v.title,now,now);
  return true;
 }
 function handle(req,res,token){
  const v=decode(token);if(!v){res.writeHead(410,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end('リンクの有効期限が切れています。Nestrillのページを再読み込みしてください。');return}
  const prefetch=String(req.headers.purpose||'')+' '+String(req.headers['sec-purpose']||'');
  // Do not learn from speculative loads; only from actual navigation attempts.
  const dest=String(req.headers['sec-fetch-dest']||'');const mode=String(req.headers['sec-fetch-mode']||'');
  const realNavigation=!/prefetch|prerender/i.test(prefetch)&&(!dest||dest==='document')&&(!mode||mode==='navigate');
  if(realNavigation)record(v);
  const direct=v.kind==='rss'&&v.id.startsWith('x:')?newsPrefetch.redirect(v.url,v.publisherHost):'';
  res.writeHead(302,{'Location':direct||v.url,'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
   'X-Nestrill-Link-Mode':direct?'direct-prefetched':'google-original',
   'X-Content-Type-Options':'nosniff'});res.end();
 }
 function evidence(pid){return db.prepare(`SELECT kind,title,last_opened_at AS updated_at FROM ai_article_open_signals
   WHERE profile_id=? AND last_opened_at>? ORDER BY last_opened_at DESC LIMIT 6`).all(pid,Date.now()-90*86400000)}
 function stamp(pid){return Number(db.prepare('SELECT MAX(last_opened_at) AS value FROM ai_article_open_signals WHERE profile_id=?').get(pid)?.value)||0}
 function status(pid){const row=db.prepare('SELECT COUNT(*) AS total,MAX(last_opened_at) AS latest FROM ai_article_open_signals WHERE profile_id=?').get(pid);
  return {total:row?.total||0,lastOpenedAt:row?.latest||0,weakOnly:true};}
 function reset(pid,expectedTotal){
  if(!Number.isSafeInteger(pid)||pid<=0||!Number.isSafeInteger(expectedTotal)||expectedTotal<0)throw Error('リセット条件が不正です');
  // Only the currently authenticated profile is affected. Feedback and article state are untouched.
  const before=status(pid);
  if(before.total!==expectedTotal)throw Error('記録件数が変更されました。更新してから再確認してください');
  const result=db.prepare('DELETE FROM ai_article_open_signals WHERE profile_id=?').run(pid);
  return {...status(pid),deleted:Number(result.changes)};
 }
 return {href,handle,evidence,stamp,status,reset};
}
module.exports={create};
