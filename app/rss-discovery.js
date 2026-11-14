'use strict';
// RSS autodiscovery: metadata only. No article-page scraping, no HTML execution.
// Network and feed-parser functions are injected for deterministic tests.
function attr(tag,name){
 const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const re=new RegExp('(?:^|\\s)'+escaped+'\\s*=\\s*(?:"([^"]*)"|\x27([^\x27]*)\x27|([^\\s>]+))','i');
 const x=re.exec(tag);return x?(x[1]??x[2]??x[3]):'';
}
function unescapeHtml(v){return String(v||'').replace(/&(?:amp|quot|apos|lt|gt|#(\d+)|#x([0-9a-f]+));/gi,(m,d,h)=>{
 if(d||h){const n=parseInt(d||h,h?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):m}
 return {'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'}[m.toLowerCase()]||m;
 });}
function linksFromHtml(html,base){
 const found=[];for(const match of html.matchAll(/<link\b(?:"[^"]*"|'[^']*'|[^'">])*?>/gi)){
  const tag=match[0];const rel=attr(tag,'rel').toLowerCase().split(/\s+/);const type=attr(tag,'type').toLowerCase().split(';')[0].trim();
  if(!rel.includes('alternate')||!['application/rss+xml','application/atom+xml','application/rdf+xml','application/xml+rss'].includes(type))continue;
  try{const u=new URL(unescapeHtml(attr(tag,'href')),base);if(['http:','https:'].includes(u.protocol)){u.hash='';found.push({url:u.toString(),title:unescapeHtml(attr(tag,'title')).trim(),source:'html'})}}catch{}
 }
 return found;
}
async function readPublicPage(url,{checkRemote,fetchImpl},depth=0){
 if(depth>3)throw Error('リダイレクト回数を超えました');
 await checkRemote(url);
 const res=await fetchImpl(url,{redirect:'manual',headers:{'Accept':'text/html,application/rss+xml,application/atom+xml,application/xml;q=.9,*/*;q=.2','User-Agent':'Nestrill/0.2.0e (personal RSS reader)'},signal:AbortSignal.timeout(11000)});
 if(res.status>=300&&res.status<400){const loc=res.headers.get('location');if(!loc)throw Error('リダイレクト先が不明です');const next=new URL(loc,url).toString();return readPublicPage(next,{checkRemote,fetchImpl},depth+1)}
 if(!res.ok)throw Error(`Webサイトに接続できません（HTTP ${res.status}）`);
 const len=Number(res.headers.get('content-length')||0);if(len>450_000)throw Error('Webページが大きすぎます');
 let size=0;const chunks=[];
 for await(const x of res.body){size+=x.byteLength;if(size>450_000)throw Error('Webページが大きすぎます');chunks.push(Buffer.from(x))}
 const bytes=Buffer.concat(chunks);const charset=res.headers.get('content-type')?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]||'utf-8';
 let contents;try{contents=new TextDecoder(charset).decode(bytes)}catch{contents=bytes.toString('utf8')}
 return {url,html:contents};
}
/* NESTRILL_DISCOVERY_FALLBACK_5B */
async function discoverRss(url,{fetchFeed,checkRemote,fetchImpl,validHttpUrl}){
 const input=validHttpUrl(url);
 let directError='';

 // First, accept a verified direct RSS/Atom URL.
 try{
  const result=await fetchFeed(input);
  if(result.feed){
   return {
    candidates:[{
     url:input,
     title:result.feed.title,
     siteUrl:result.feed.siteUrl||'',
     source:'direct'
    }],
    scanned:1
   };
  }
 }catch(e){
  directError=String(e.message||e);
 }

 // Enforce the existing remote-address policy before probing.
 try{
  await checkRemote(input);
 }catch(e){
  return {
   candidates:[],
   scanned:0,
   message:'接続先を検証できませんでした: '+String(e.message||e)
  };
 }

 let page=null;
 let pageError='';

 try{
  page=await readPublicPage(input,{checkRemote,fetchImpl});
 }catch(e){
  pageError=String(e.message||e);
 }

 // HTML autodiscovery is preferred when the page is available.
 const htmlLinks=page
  ?linksFromHtml(page.html,page.url)
  :[];

 // An HTML failure (including HTTP 403) does not prevent
 // probing a small number of conventional RSS endpoints.
 // No external search engine and no browser-cookie bypass.
 const base=new URL(input);
 /* NESTRILL_DISCOVERY_PATHS_5E */
 const currentPath=base.pathname.replace(/\/+$/,'')||'/';
 const paths=[];

 // Resolve feeds relative to the original page path first.
 if(currentPath!=='/'){
  paths.push(
   currentPath+'/feed.atom',
   currentPath+'/feed',
   currentPath+'.atom',
   currentPath+'/feed.xml',
   currentPath+'/rss.xml'
  );
 }

 // Generic site-wide RSS routes remain supported.
 paths.push(
  '/feed',
  '/rss.xml',
  '/feed.xml',
  '/atom.xml',
  '/rss',
  '/index.xml'
 );
 const guesses=paths.map(path=>({
  url:new URL(path,base.origin).toString(),
  title:'',
  source:'guess'
 }));

 // Prefer explicit HTML links; bound total probes to eight.
 const unique=[];
 const seen=new Set();

 for(const item of [...htmlLinks.slice(0,5),...guesses]){
  let identity;
  try{
   const u=new URL(item.url);
   u.hash='';
   u.pathname=u.pathname.replace(/\/+$/,'')||'/';
   identity=u.toString();
  }catch{
   continue;
  }

  if(seen.has(identity))continue;
  seen.add(identity);
  unique.push(item);
  if(unique.length>=8)break;
 }
 const results=new Array(unique.length).fill(null);
 let cursor=0;

 // Maximum three concurrent checks. Every candidate passes
 // the existing URL validation, remote check and feed parser.
 await Promise.all(
  Array.from({length:Math.min(3,unique.length)},async()=>{
   while(true){
    const index=cursor++;
    if(index>=unique.length)return;

    const item=unique[index];

    try{
     const checkedUrl=validHttpUrl(item.url);
     const checked=await fetchFeed(checkedUrl);

     if(checked.feed){
      results[index]={
       url:checkedUrl,
       title:item.title||checked.feed.title,
       siteUrl:checked.feed.siteUrl||'',
       source:item.source
      };
     }
    }catch(_){
     // Invalid or unavailable candidates are not offered.
    }
   }
  })
 );

 // Preserve discovery priority independent of response timing.
 /* NESTRILL_DISCOVERY_DEDUP_5D */
 const seenCandidates=new Set();
 const candidates=results.filter(Boolean).filter(item=>{
  const u=new URL(item.url);
  u.hash='';
  // /feed and /feed/ refer to one logical candidate.
  // Keep the query string to distinguish real feed variants.
  u.pathname=u.pathname.replace(/\/+$/,'')||'/';
  const identity=u.toString();

  if(seenCandidates.has(identity))return false;
  seenCandidates.add(identity);
  return true;
 });

 let message='';
 if(!candidates.length){
  message='有効なRSSフィードを検出できませんでした。';
  if(directError && !(page && directError.includes('DTDを含むXML')))message+=' 直接URL: '+directError;
  if(pageError)message+=' サイト取得: '+pageError;
 }

 return {
  candidates,
  scanned:unique.length,
  message
 };
}
module.exports={discoverRss,linksFromHtml,readPublicPage};
