'use strict';
// Manual, bounded newest-first news retrieval. Never AI-rank items or fetch
// publisher webpages. Google News RSS is not a comprehensive news index.
const {parseFeed}=require('./feed');
const {createHash}=require('node:crypto');
const {fetchNewsXml}=require('./ai-external');
const random=require('./ai-random');
const quality=require('./ai-source-quality');
const diversity=require('./ai-condition-diversity');
const {publishersOf}=random;
const jobs=new Map();
const MAX_SEARCHES=12, PER_SEARCH=60, MAX_POOL=220, MAX_SOURCE=30, RECENT_MS=2*86400000;
const GENERAL_QUERIES=['ニュース 国内','ニュース 国際','政治 ニュース','経済 ニュース','社会 ニュース','科学 技術 ニュース','文化 ニュース','スポーツ ニュース'];
function querySpecs(categories=[],personalTopics=[]){
 const chosen=random.validateCategories(categories);
 if(personalTopics.length){
  return personalTopics.slice(0,MAX_SEARCHES).map(x=>({category:x.category||'指定条件',term:String(x.term||'').slice(0,150),origin:x.origin||'personal'})).filter(x=>x.term);
 }
 if(chosen.length){
  // No taste or date scoring affects topic selection. Each selected category
  // gets a search before the next phrase is used for that category.
  const wanted=new Map(random.GROUPS.filter(([name])=>chosen.includes(name)));
  const queries=[];
  for(let pass=0;pass<3;pass++)for(const cat of chosen){
   if(queries.length>=MAX_SEARCHES)break;
   const term=wanted.get(cat)?.[pass];if(term)queries.push({category:cat,term,origin:'genre'});
  }
  return queries;
 }
 return [{category:'主要ニュース',top:true,origin:'headlines'},...GENERAL_QUERIES.map(term=>({category:'最新ニュース',term,origin:'general'}))];
}
function newsUrl(q){
 const u=new URL(q.top?'https://news.google.com/rss':'https://news.google.com/rss/search');
 if(!q.top)u.searchParams.set('q',q.term+' when:2d');
 u.searchParams.set('hl','ja');u.searchParams.set('gl','JP');u.searchParams.set('ceid','JP:ja');
 return u.toString();
}
function normalize(item,pub,topic,now){
 const url=quality.urlKey(item.url),title=String(item.title||'').slice(0,350);
 const published=pub.published||0;
 if(!quality.checkArticle({title,url,sourceHost:pub.host,published,now}).accepted||now-published>RECENT_MS)return null;
 return {id:createHash('sha256').update(url).digest('hex').slice(0,32),url,title,
  published,source:pub.name?pub.name+'（Googleニュース経由）':'Googleニュース',
  publisherHost:pub.host,thumbnail:quality.urlKey(item.thumbnail)||'',
  excerpt:String(item.excerpt||'').slice(0,360),category:topic.category};
}
function newestCandidates(groups,{max=MAX_POOL,similar=diversity.sameReportedEvent}={}){
 const list=groups.flat().sort((a,b)=>b.published-a.published||a.id.localeCompare(b.id));
 const seen=new Set(),titles=[],sources=new Map(),out=[];
 for(const item of list){
  if(seen.has(item.url)||titles.some(x=>similar(x,item)))continue;
  if((sources.get(item.publisherHost)||0)>=MAX_SOURCE)continue;
  seen.add(item.url);titles.push(item);sources.set(item.publisherHost,(sources.get(item.publisherHost)||0)+1);
  out.push(item);if(out.length>=max)break;
 }
 return out;
}
function create({fetchXml=fetchNewsXml,clock=()=>Date.now()}={}){
 function status(pid){
  const e=jobs.get(pid);
  if(!e)return {items:[],running:false,generatedAt:0,error:'',progress:null,totalAvailable:0,scope:'google_news_rss_limited'};
  return {items:e.items,running:e.running,generatedAt:e.generatedAt,error:e.error,
   progress:e.running?{completed:e.completed,total:e.total}:null,
   totalAvailable:e.items.length,scope:'google_news_rss_limited',topics:e.topics,
   selectedCategories:e.categories};
 }
 function start(pid,{categories=[],personalTopics=[]}={}){
  if(!Number.isSafeInteger(pid)||pid<1)throw Error('プロファイルが不正です');
  if(jobs.get(pid)?.running)return {started:false,running:true};
  const topics=querySpecs(categories,personalTopics),entry={items:[],running:true,generatedAt:0,error:'',completed:0,
   total:topics.length,topics:topics.map(t=>t.category),categories:[...categories]};
  if(!topics.length)throw Error('検索テーマがありません');
  jobs.set(pid,entry);
  setImmediate(async()=>{
   const groups=Array.from({length:topics.length},()=>[]),failed=[];let next=0;
   async function worker(){while(next<topics.length){
    const i=next++,topic=topics[i],url=newsUrl(topic);
    try{
     const xml=await fetchXml(url),feed=parseFeed(xml,url),publishers=publishersOf(xml),now=clock();
     groups[i]=feed.items.slice(0,PER_SEARCH).map((x,j)=>normalize(x,publishers[j]||{},topic,now)).filter(Boolean);
    }catch(e){failed.push(String(e?.message||e).slice(0,90))}
    finally{entry.completed++}
   }}
   try{
    await Promise.all(Array.from({length:Math.min(3,topics.length)},()=>worker()));
    entry.items=newestCandidates(groups);
    if(failed.length)entry.error=`${failed.length}/${topics.length}検索の取得に失敗しました。取得できた記事のみ表示しています。`;
    if(!entry.items.length&&!entry.error)entry.error='直近48時間の対象ニュースを取得できませんでした。';
    entry.generatedAt=clock();
   }catch(e){entry.error='新着取得失敗：'+String(e.message||e).slice(0,110);entry.generatedAt=clock()}
   finally{entry.running=false}
  });
  return {started:true,running:true};
 }
 return {status,start};
}
module.exports={create,querySpecs,newsUrl,newestCandidates};
