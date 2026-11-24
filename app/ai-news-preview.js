'use strict';
// Trial05. Optional, bounded article-page metadata lookup for CONDITIONAL
// discovery only. Never runs during RSS refresh, recommendation ranking, or
// when the user has disabled article-image retrieval. Google-news links must
// first be resolved by ai-open's existing checked background prefetcher.
const https=require('node:https');
const dns=require('node:dns');
const net=require('node:net');
const {URL}=require('node:url');
const MAX_HTML_BYTES=260000,MAX_ENTRIES=100,MAX_QUEUE=24,MAX_ACTIVE=2;
function privateIP(value){
 const family=net.isIP(value);
 if(family===4){const x=value.split('.').map(Number);return x[0]===0||x[0]===10||x[0]===127||x[0]>=224||(x[0]===169&&x[1]===254)||(x[0]===172&&x[1]>=16&&x[1]<=31)||(x[0]===192&&x[1]===168)||(x[0]===100&&x[1]>=64&&x[1]<=127)||(x[0]===192&&x[1]===0)||(x[0]===198&&[18,19].includes(x[1]))||(x[0]===198&&x[1]===51&&x[2]===100)||(x[0]===203&&x[1]===0&&x[2]===113)}
 if(family===6){const s=value.toLowerCase();return s==='::'||s==='::1'||s.startsWith('fe80:')||s.startsWith('fc')||s.startsWith('fd')||s.startsWith('ff')||s.startsWith('::ffff:')||s.startsWith('2001:db8:')}
 return true;
}
function validPublicHttps(value){
 try{const u=new URL(String(value||''));const host=u.hostname.toLowerCase();
  if(u.protocol!=='https:'||u.port||u.username||u.password||value.length>2048||net.isIP(host)||host==='localhost'||host.endsWith('.local')||host.endsWith('.localhost')||host.endsWith('.internal')||!/^([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(host))return '';
  if(host.split('.').some(x=>x.length>63||x.startsWith('-')||x.endsWith('-')))return '';
  return u.toString();}catch{return ''}
}
function htmlEntities(value){return String(value||'').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,(whole,code)=>{
 if(code[0]==='#'){const number=code[1].toLowerCase()==='x'?parseInt(code.slice(2),16):parseInt(code.slice(1),10);return number>0&&number<0x110000&&!(number>=0xd800&&number<=0xdfff)?String.fromCodePoint(number):'';}
 return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}[code.toLowerCase()]||whole;
})}
function metadataFromHtml(html,pageUrl){
 const found=new Map();const tags=String(html||'').slice(0,MAX_HTML_BYTES).match(/<meta\b[^>]{0,2500}>/gi)||[];
 for(const tag of tags){const attrs={};const attr=/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;let m;
  while((m=attr.exec(tag))){attrs[m[1].toLowerCase()]=htmlEntities(m[2]??m[3]??m[4]);}
  const key=String(attrs.property||attrs.name||'').toLowerCase();if(key&&!found.has(key))found.set(key,String(attrs.content||''));
 }
 const raw=found.get('og:image:secure_url')||found.get('og:image')||found.get('twitter:image')||'';
 let thumbnail='';try{if(raw){const resolved=new URL(raw,pageUrl).toString();if(!/\.svg(?:$|[?#])/i.test(new URL(resolved).pathname))thumbnail=validPublicHttps(resolved);}}catch{}
 const excerpt=String(found.get('og:description')||found.get('description')||found.get('twitter:description')||'').replace(/\s+/g,' ').trim().slice(0,260);
 return {thumbnail,excerpt};
}
// Do not surface arbitrary network error text (which can contain URLs or local
// environment details) to the browser. Map errors to small, stable reason codes.
function publisherFailureReason(e){
 const message=String(e?.message||''),code=String(e?.code||'').toUpperCase();
 // Our own deliberately emitted errors already use stable codes.
 if(/^(?:UNSAFE_URL|UNSAFE_DNS|CROSS_PUBLISHER_REDIRECT|PUBLISHER_REDIRECT_DENIED|META_TIMEOUT|HTML_LIMIT|RESPONSE_ABORTED|CONTENT_TYPE_NOT_HTML|CONTENT_ENCODING_UNSUPPORTED|HTML_TOO_LARGE|NO_IMAGE_TAG|HTTP_[1-5][0-9]{2})$/.test(message))return message;
 if(code==='ERR_INVALID_IP_ADDRESS')return 'DNS_LOOKUP_RESULT_INVALID';
 if(['ENOTFOUND','ENODATA','EAI_NODATA'].includes(code))return 'DNS_NOT_FOUND';
 if(code==='EAI_AGAIN')return 'DNS_TEMPORARY';
 if(['ENETUNREACH','EHOSTUNREACH','EADDRNOTAVAIL'].includes(code))return 'NETWORK_UNREACHABLE';
 if(['ECONNREFUSED'].includes(code))return 'CONNECT_REFUSED';
 if(code==='ETIMEDOUT'||code==='ESOCKETTIMEDOUT')return 'CONNECT_TIMEOUT';
 if(['ECONNRESET','EPIPE','ERR_SOCKET_CLOSED'].includes(code))return 'CONNECTION_RESET';
 if(['CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_GET_ISSUER_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code))return 'TLS_CERTIFICATE_ERROR';
 if(code==='EPROTO'||code.startsWith('ERR_SSL_')||code.startsWith('ERR_TLS_'))return 'TLS_HANDSHAKE_ERROR';
 if(/before (?:a )?secure TLS connection was established/i.test(message))return 'TLS_DISCONNECTED';
 if(/socket hang up|connection reset/i.test(message))return 'CONNECTION_RESET';
 if(/certificate|self.signed|cert verify/i.test(message))return 'TLS_CERTIFICATE_ERROR';
 if(/getaddrinfo|dns lookup/i.test(message))return 'DNS_FAILURE';
 if(/timeout|timed out/i.test(message))return 'CONNECT_TIMEOUT';
 return 'NETWORK_OTHER';
}
// Node >=20 may request lookup(..., {all:true}, callback) for Happy Eyeballs.
// For that mode callback MUST receive an array, not (address, family).
// Validate every resolved address before giving any to the HTTPS socket.
function safeDnsLookup(hostname,opts,callback,resolver=dns.lookup){
 resolver(hostname,{all:true},(error,addresses)=>{
  if(error){callback(error);return}
  if(!Array.isArray(addresses)||!addresses.length||addresses.some(x=>!x||![4,6].includes(x.family)||privateIP(x.address))){callback(Error('UNSAFE_DNS'));return}
  const ordered=addresses.slice().sort((a,b)=>(a.family===4?0:1)-(b.family===4?0:1));
  if(opts&&opts.all)callback(null,ordered.map(({address,family})=>({address,family})));
  else callback(null,ordered[0].address,ordered[0].family);
 });
}
function fetchPublisherMetadata(url,hops=0,originalHost='',get=https.get){
 const address=validPublicHttps(url);if(!address)return Promise.reject(Error('UNSAFE_URL'));
 const parsed=new URL(address),baseHost=originalHost||parsed.hostname.replace(/^www\./,'');
 if(parsed.hostname.replace(/^www\./,'')!==baseHost)return Promise.reject(Error('CROSS_PUBLISHER_REDIRECT'));
 return new Promise((resolve,reject)=>{
  let settled=false,received=0;const chunks=[];
  const done=(error,data)=>{if(settled)return;settled=true;if(error)reject(error);else resolve(data)};
  const req=get({hostname:parsed.hostname,port:443,path:parsed.pathname+parsed.search,method:'GET',
   headers:{'User-Agent':'Mozilla/5.0 (compatible; NestrillPreview/0.2; +local)', 'Accept':'text/html,application/xhtml+xml;q=0.8','Accept-Encoding':'identity'},
   lookup:safeDnsLookup},res=>{
    const status=Number(res.statusCode)||0,type=String(res.headers['content-type']||'').toLowerCase();
    if([301,302,303,307,308].includes(status)){
     const location=String(res.headers.location||'');let next='';
     try{next=validPublicHttps(new URL(location,address).toString())}catch{}
     res.resume();
     if(!next||hops>=2||new URL(next).hostname.replace(/^www\./,'')!==baseHost){done(Error('PUBLISHER_REDIRECT_DENIED'));return}
     fetchPublisherMetadata(next,hops+1,baseHost,get).then(data=>done(null,data),done);
     return;
    }
    if(status!==200){res.resume();done(Error('HTTP_'+(status>=100&&status<=599?status:500)));return}
    if(!/text\/html|application\/xhtml\+xml/.test(type)){res.resume();done(Error('CONTENT_TYPE_NOT_HTML'));return}
    if(!['','identity'].includes(String(res.headers['content-encoding']||''))){res.resume();done(Error('CONTENT_ENCODING_UNSUPPORTED'));return}
    if(Number(res.headers['content-length']||0)>MAX_HTML_BYTES){res.resume();done(Error('HTML_TOO_LARGE'));return}
    res.on('data',chunk=>{received+=chunk.length;if(received>MAX_HTML_BYTES){req.destroy(Error('HTML_LIMIT'));return}chunks.push(chunk)});
    res.on('end',()=>done(null,metadataFromHtml(Buffer.concat(chunks).toString('utf8'),address)));
    res.on('aborted',()=>done(Error('RESPONSE_ABORTED')));
    res.on('error',e=>done(e));
   });
  req.setTimeout(4500,()=>req.destroy(Error('META_TIMEOUT')));
  req.on('error',e=>done(e));
 });
}
function create({newsLookup,fetchMetadata=fetchPublisherMetadata,clock=()=>Date.now()}={}){
 if(typeof newsLookup!=='function')throw Error('newsLookup required');
 const cache=new Map(),queue=[];let active=0;
 function pump(){while(active<MAX_ACTIVE&&queue.length){const entry=queue.shift();if(entry.state!=='queued')continue;entry.state='running';active++;
  Promise.resolve().then(()=>fetchMetadata(entry.url)).then(data=>{
   entry.state='ready';entry.thumbnail=validPublicHttps(data?.thumbnail)||'';
   entry.excerpt=String(data?.excerpt||'').slice(0,260);
   entry.reason=entry.thumbnail?'':'NO_IMAGE_TAG';
  }).catch(e=>{entry.state='unavailable';entry.thumbnail='';entry.excerpt='';
   entry.reason=publisherFailureReason(e);
  }).finally(()=>{
   entry.elapsedMs=clock()-entry.started;active--;pump();
  });
 }}
 function request(item){
  const link=String(item?.url||''),host=String(item?.publisherHost||'').trim().toLowerCase();
  if(!/^https:\/\/news\.google\.com\/((rss\/)?articles|read)\//.test(link))return {status:'unavailable',phase:'link',reason:'INVALID_NEWS_LINK'};
  if(!validPublicHttps('https://'+host+'/'))return {status:'unavailable',phase:'link',reason:'INVALID_PUBLISHER_HOST'};
  const resolved=newsLookup(link,host);
  if(resolved.status==='failed'||resolved.status==='unsupported')return {status:'unavailable',phase:'link',reason:resolved.reason||'LINK_UNAVAILABLE'};
  if(resolved.status!=='ready'||!resolved.destination)return {status:'pending',phase:'link',detail:resolved.phase||'waiting'};
  if(!validPublicHttps(resolved.destination))return {status:'unavailable',phase:'link',reason:'NON_HTTPS_DESTINATION'};
  const key=link+'|'+host;let entry=cache.get(key);
  if(entry&&clock()-entry.started>12*3600000){cache.delete(key);entry=null}
  if(!entry){
   if(queue.length>=MAX_QUEUE)return {status:'unavailable',phase:'metadata',reason:'METADATA_QUEUE_FULL'};
   while(cache.size>=MAX_ENTRIES)cache.delete(cache.keys().next().value);
   entry={state:'queued',started:clock(),url:resolved.destination,thumbnail:'',excerpt:'',elapsedMs:0};
   cache.set(key,entry);queue.push(entry);pump();
  }
  return entry.state==='ready'?{status:'ready',thumbnail:entry.thumbnail,excerpt:entry.excerpt,reason:entry.reason||'',phase:'metadata',elapsedMs:entry.elapsedMs}:
    entry.state==='unavailable'?{status:'unavailable',phase:'metadata',reason:entry.reason||'PUBLISHER_FETCH_FAILED',elapsedMs:entry.elapsedMs}:
    {status:'pending',phase:'metadata',detail:entry.state};
 }
 return {request};
}
module.exports={create,privateIP,validPublicHttps,metadataFromHtml,fetchPublisherMetadata,publisherFailureReason,safeDnsLookup};
