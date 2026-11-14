'use strict';
// Optional, bounded metadata-only supplement to Google News RSS article search.
// Bing RSS is an unofficial/unversioned endpoint. Never scrape publisher sites,
// resolve arbitrary article URLs, or treat third-party snippets as verified text.
const MAX_BYTES=800_000, MAX_QUERIES=6, MAX_ITEMS_PER_FEED=20, MAX_SNIPPET=300;
const TIME_LIMIT_MS=5000, MAX_DATE_DELTA_MS=2*86400_000;
const {xmlTree,plain}=require('./feed');
const {normalizedTitle}=require('./ai-source-quality');
const clean=s=>String(s||'').normalize('NFKC').replace(/\s+/gu,' ').trim();
const id=s=>clean(s).toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');
function publisherOfGoogle(x){return clean(String(x.source||'').replace(/（Googleニュース経由）$/u,''));}
function titleIdentity(s,publisher=''){
 // Strip ONLY the exact matching publisher suffix. We never use fuzzy matching.
 let t=clean(s),p=clean(publisher);
 if(p&&t.endsWith(' - '+p))t=t.slice(0,-(' - '+p).length).trim();
 return id(t);
}
function seemsHeadlineOnly(x){
 const pub=publisherOfGoogle(x);
 const a=titleIdentity(x.title,pub);
 const b=titleIdentity(x.excerpt,pub);
 return !!(a&&b&&(a===b||b===id(clean(x.title))));
}
function genuineSummary(description,title,publisher){
 const s=clean(description);
 if(s.length<42||s.length>3000)return '';
 if(/^(続きを読む|read more|詳細はこちら|続きはこちら)[\s.。…]*$/iu.test(s))return '';
 if(titleIdentity(s,publisher)===titleIdentity(title,publisher))return '';
 // A source may repeat headline and then add details. Treat as unverified
 // editorial metadata, never as independently confirmed article content.
 return s.slice(0,MAX_SNIPPET);
}
function extractBingMetadata(xml){
 const root=xmlTree(xml),rss=root.children.find(x=>x.name==='rss');
 const channel=rss?.children.find(x=>x.name==='channel');
 return (channel?.children||[]).filter(x=>x.name==='item').slice(0,MAX_ITEMS_PER_FEED).map(n=>{
  const get=(...names)=>n.children.find(x=>names.includes(x.name));
  const text=c=>String(c?.parts?.join('')||'').trim();
  const publisher=clean(text(get('news:source','source')));
  const title=clean(text(get('title')));
  const desc=clean(plain(text(get('description'))));
  const date=Date.parse(text(get('pubdate','published','dc:date')));
  return {title,publisher,summary:genuineSummary(desc,title,publisher),published:Number.isFinite(date)?date:0};
 }).filter(x=>x.title&&x.publisher&&x.summary&&x.published>0);
}
async function fetchBingXml(term){
 const u=new URL('https://www.bing.com/news/search');
 u.searchParams.set('q',String(term||'').slice(0,100));
 u.searchParams.set('format','rss');u.searchParams.set('setmkt','ja-JP');
 if(u.protocol!=='https:'||u.hostname!=='www.bing.com'||u.pathname!=='/news/search'||u.port||u.username||u.password)throw Error('Bing News endpoint invalid');
 const resp=await fetch(u.toString(),{redirect:'error',signal:AbortSignal.timeout(TIME_LIMIT_MS),headers:{'Accept':'application/rss+xml,application/xml;q=0.9','User-Agent':'Nestrill-Next/0.2 (personal RSS reader)'}});
 if(!resp.ok)throw Error('Bing RSS HTTP '+resp.status);
 const mime=(resp.headers.get('content-type')||'').toLowerCase();
 if(mime&&!/xml|rss|text\/plain/.test(mime))throw Error('Bing News did not provide RSS XML');
 if(Number(resp.headers.get('content-length')||0)>MAX_BYTES)throw Error('Bing RSS exceeded size limit');
 const body=resp.body;
 if(!body)throw Error('Bing RSS empty body');
 const chunks=[];const reader=body.getReader();let total=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;
  total+=value.length;if(total>MAX_BYTES){await reader.cancel();throw Error('Bing RSS exceeded size limit')}
  chunks.push(Buffer.from(value));}}
 finally{reader.releaseLock()}
 return Buffer.concat(chunks).toString('utf8');
}
function selectQueries(items,maxQueries=MAX_QUERIES){
 const groups={explicit:new Map(),discovery:new Map()};
 for(const x of items){if(!seemsHeadlineOnly(x))continue;
  const term=clean(x.queryLabel);if(!term||term.length>100)continue;
  const bucket=x.discoveryLane?'discovery':'explicit';
  groups[bucket].set(term,(groups[bucket].get(term)||0)+1);
 }
 const sort=m=>[...m].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
 const explicit=sort(groups.explicit),discovery=sort(groups.discovery),chosen=[];
 // Preserve both known-interest and unknown-discovery coverage when present.
 for(let n=0;chosen.length<maxQueries&&(explicit.length||discovery.length);n++){
  for(const arr of [discovery,explicit]){if(chosen.length>=maxQueries)break;
   if(arr.length){const t=arr.shift();if(!chosen.includes(t))chosen.push(t)}}
 }
 return chosen;
}
function enrichByFeed(items,term,xml){
 const stories=extractBingMetadata(xml),replacements=[];
 for(const x of items){
  if(clean(x.queryLabel)!==term||!seemsHeadlineOnly(x)||!Number.isFinite(x.published)||x.published<=0)continue;
  const googleTitle=titleIdentity(x.title,publisherOfGoogle(x));
  const publisher=id(publisherOfGoogle(x));
  // Requiring an exact headline, publisher name, and close publication time
  // avoids attaching a plausible-looking snippet from a different story.
  const matches=stories.filter(y=>titleIdentity(y.title,y.publisher)===googleTitle&&
   id(y.publisher)===publisher&&Math.abs(y.published-x.published)<=MAX_DATE_DELTA_MS);
  if(matches.length!==1)continue;
  replacements.push({article:x,newExcerpt:matches[0].summary});
 }
 for(const r of replacements){
  r.article.excerpt=r.newExcerpt;
  r.article.qualityNotes=String(r.article.qualityNotes||'').slice(0,180)+' / Bingニュース検索RSSの説明文（本文未検証）';
  r.article.externalExcerptSource='bing_rss_unverified';
 }
 return replacements.length;
}
async function enrich(items,{fetchXml=fetchBingXml,maxQueries=MAX_QUERIES}={}){
 const stats={provider:'Bingニュース検索RSS（非公式）',attemptedQueries:0,failedQueries:0,matchedItems:0,unchangedItems:items.length,disabled:false};
 const queries=selectQueries(items,Math.max(0,Math.min(MAX_QUERIES,Math.floor(maxQueries))));
 // Two sequential lanes at most; no new prompt, model call or publisher fetch.
 for(let j=0;j<queries.length;j+=2){
  const batch=queries.slice(j,j+2);
  await Promise.all(batch.map(async term=>{
   stats.attemptedQueries++;
   try{const xml=await fetchXml(term);stats.matchedItems+=enrichByFeed(items,term,xml)}
   catch{stats.failedQueries++} // Always preserve Google-derived candidates.
  }));
 }
 stats.unchangedItems=items.length-stats.matchedItems;
 return stats;
}
module.exports={enrich,extractBingMetadata,enrichByFeed,selectQueries,seemsHeadlineOnly,fetchBingXml,titleIdentity};
