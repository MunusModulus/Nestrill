'use strict';
// Structural checks for Google News RSS candidates. No country/TLD blocklist,
// keyword or topic dictionary; source metadata is NOT independent verification.
const DAY=86400000;
function urlKey(input){
 try{
  const u=new URL(String(input||''));
  if(u.protocol!=='https:'||u.username||u.password||!u.hostname||u.port&&u.port!=='443')return '';
  if(!isPublicHostname(u.hostname))return '';
  u.hash='';u.hostname=u.hostname.toLowerCase();
  for(const k of [...u.searchParams.keys()])if(/^(utm_.+|fbclid|gclid|oc|ref|source)$/i.test(k))u.searchParams.delete(k);
  u.searchParams.sort();
  return u.toString();
 }catch{return ''}
}
function isPublicHostname(host){
 const h=String(host||'').toLowerCase().replace(/\.$/,'');
 if(!h||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal')||!h.includes('.'))return false;
 if(/^\d+\.\d+\.\d+\.\d+$/.test(h)||h.includes(':'))return false;
 if(/[^a-z0-9.\-]/.test(h)||h.length>253)return false;
 return h.split('.').every(x=>x.length>=1&&x.length<=63&&!x.startsWith('-')&&!x.endsWith('-'));
}
function hostOf(url){
 try{const u=new URL(String(url||''));return ['https:','http:'].includes(u.protocol)&&isPublicHostname(u.hostname)?u.hostname.toLowerCase().replace(/^www\./,''):''}
 catch{return ''}
}
// Prefer the actual RSS publisher metadata over guessing where a title ends.
// Publisher names such as J-CAST contain a hyphen and defeated the old suffix
// regex. This is an exact headline identity check, NOT topic/meaning scoring.
function normalizedTitle(title,source=''){
 const raw=String(title||'').normalize('NFKC').trim();
 const publisher=String(source||'').replace(/（Googleニュース経由）$/u,'')
  .normalize('NFKC').trim();
 const suffix=publisher?' - '+publisher:'';
 const withoutPublisher=suffix&&raw.endsWith(suffix)?raw.slice(0,-suffix.length):raw;
 return withoutPublisher.replace(/\s+-\s+[^-]{2,90}$/u,'')
  .toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');
}
function grams(s){const set=new Set();for(let i=0;i<s.length-1;i++)set.add(s.slice(i,i+2));return set}
function nearDuplicate(left,right,leftSource='',rightSource=''){
 const a=normalizedTitle(left,leftSource),b=normalizedTitle(right,rightSource);
 if(!a||!b)return false;
 if(a===b)return true;
 // Preserve distinct model/version numbers (e.g. RX 9060 vs RX 9070).
 if(JSON.stringify(a.match(/[0-9]+/g)||[])!==JSON.stringify(b.match(/[0-9]+/g)||[]))return false;
 if(Math.min(a.length,b.length)<19)return false;
 if(Math.max(a.length,b.length)/Math.min(a.length,b.length)>1.18)return false;
 const ga=grams(a),gb=grams(b);
 let common=0;for(const g of ga)if(gb.has(g))common++;
 return 2*common/(ga.size+gb.size)>=0.91;
}
function checkArticle({title,url,sourceHost,published,now=Date.now()}){
 const reasons=[];
 if(!urlKey(url))reasons.push('記事URLが不正');
 if(!sourceHost||!isPublicHostname(sourceHost))reasons.push('RSSの出典ドメインが確認できない');
 if(!Number.isFinite(published)||published<=0)reasons.push('公開日時が不明');
 else if(published>now+3600000)reasons.push('未来の公開日時');
 else if(published<now-7*DAY)reasons.push('7日より古い記事');
 const normalized=normalizedTitle(title);
 if(normalized.length<9)reasons.push('記事タイトルが短すぎる');
 if(normalized.length>320)reasons.push('記事タイトルが長すぎる');
 if(/(.)\1{12,}/u.test(normalized))reasons.push('不自然な反復文字');
 const age=Number.isFinite(published)?Math.max(0,now-published):7*DAY;
 const quality=Math.max(50,100-Math.round(22*age/(7*DAY)));
 return {accepted:reasons.length===0,score:quality,reasons};
}
function makeStats(){return {inspected:0,accepted:0,duplicates:0,invalid:0,stale:0,unverified:0,sourceLimit:0,excluded:0}}
function qualityGate(candidates,{knownTitles=[],limit=40,maxPublisherItems=6,now=Date.now()}={}){
 const stats=makeStats();const pool=[],seenUrls=new Set(),seenTitles=[],known=knownTitles.map(t=>normalizedTitle(t)).filter(Boolean);
 const sorted=[...candidates].sort((a,b)=>Number(b.published||0)-Number(a.published||0));
 for(const x of sorted){
  stats.inspected++;
  const check=checkArticle({...x,now});
  if(!check.accepted){
   if(check.reasons.includes('7日より古い記事'))stats.stale++;
   else if(check.reasons.includes('RSSの出典ドメインが確認できない'))stats.unverified++;
   else stats.invalid++;
   continue;
  }
  const key=urlKey(x.url),tit=normalizedTitle(x.title,x.source);
  if(seenUrls.has(key)||seenTitles.some(t=>nearDuplicate(t.title,x.title,t.source,x.source))||known.some(t=>nearDuplicate(t,x.title,'',x.source))){stats.duplicates++;continue}
  seenUrls.add(key);seenTitles.push({title:x.title,source:x.source});
  pool.push({...x,url:x.url,qualityScore:check.score,qualityNotes:'公開RSSの出典情報（独立検証なし）'});
 }
 const perSource=new Map(),results=[];
 pool.sort((a,b)=>b.qualityScore-a.qualityScore||b.published-a.published);
 for(const x of pool){
  if(results.length>=limit)break;
  const domain=x.sourceHost;
  if((perSource.get(domain)||0)>=maxPublisherItems){stats.sourceLimit++;continue}
  perSource.set(domain,(perSource.get(domain)||0)+1);results.push(x);
 }
 stats.accepted=results.length;
 return {items:results,stats};
}
module.exports={urlKey,hostOf,normalizedTitle,nearDuplicate,checkArticle,qualityGate};
