'use strict';
// RandomTrial01: user-triggered, interest-independent discovery.
// No Ollama, interest lists, feedback, browsing history, or DB mutations.
// The random sample is limited to a public RSS search provider and the fixed,
// deliberately broad topic universe below. It is NOT a uniform sample of the web.
const {randomInt,createHash}=require('node:crypto');
const {parseFeed,xmlTree}=require('./feed');
const {fetchNewsXml}=require('./ai-external');
const quality=require('./ai-source-quality');

const GROUPS=[
 ['自然・生物',['動植物 研究','野生動物 発見','昆虫 生態']],
 ['深海・海洋',['深海 生物','海洋探査','珊瑚礁 調査']],
 ['宇宙・天文',['天文学 発見','惑星 観測','宇宙望遠鏡']],
 ['地学・火山',['地質学 研究','火山 調査','鉱物 発見']],
 ['気象・気候',['気象 研究','雲 気象','気候 観測']],
 ['考古学',['発掘 遺跡','考古学 発見','古代文明 研究']],
 ['歴史・古文書',['古文書 発見','歴史資料 調査','文化財 研究']],
 ['建築・都市',['建築 デザイン','都市計画 事例','建築物 修復']],
 ['美術・造形',['美術展 作品','彫刻 展覧会','現代美術 制作']],
 ['写真・映像',['写真展 開催','映像技術 研究','写真家 作品']],
 ['演劇・舞踊',['演劇 公演','舞踊 文化','舞台芸術']],
 ['音楽',['音楽祭','楽器 製作','音楽 研究']],
 ['文学・出版',['文学賞','新刊 エッセイ','翻訳 文学']],
 ['言語・文字',['言語学 研究','方言 調査','文字 解読']],
 ['教育・学習',['教育 研究','学校 新しい取り組み','学習 科学']],
 ['数学',['数学 研究','数学 定理','数学者 研究']],
 ['物理',['物理学 研究','量子 研究','新素材 物理']],
 ['化学',['化学 研究','触媒 発見','分子 研究']],
 ['医学・健康',['医療 研究','臨床研究 発表','公衆衛生 調査']],
 ['心理・行動',['心理学 研究','行動科学 実験','認知科学']],
 ['食文化',['郷土料理','世界の食文化','伝統食品']],
 ['農業',['農業 技術','新しい作物 栽培','農村 取り組み']],
 ['漁業・水産',['水産業 研究','養殖 技術','漁業 取り組み']],
 ['工芸・手仕事',['伝統工芸','染織 技術','陶芸 作品']],
 ['ファッション',['服飾文化','ファッション デザイン','繊維 研究']],
 ['スポーツ',['スポーツ 新競技','競技 大会','スポーツ科学']],
 ['交通・乗り物',['鉄道 車両','航空 技術','船舶 研究']],
 ['製造・工場',['製造技術','工場 自動化','ものづくり 現場']],
 ['ロボット',['ロボット 開発','ロボティクス 研究','ロボット 実証']],
 ['情報技術',['計算機科学','オープンソース 開発','情報技術 研究']],
 ['エネルギー',['再生可能エネルギー 技術','発電 研究','蓄電池 開発']],
 ['環境・リサイクル',['資源循環','環境保全 活動','リサイクル 技術']],
 ['地域・暮らし',['地域 祭り','商店街 新しい取り組み','まちづくり']],
 ['文化・風習',['世界の祭り','民俗学 調査','伝統行事']],
 ['旅・地理',['世界の風景','地理 発見','地域 旅行']],
 ['経済・産業',['中小企業 取り組み','経済 研究','新産業 動向']],
 ['政治・制度',['行政 新制度','議会 議論','政策 研究']],
 ['法律・社会',['法制度 改正','社会調査','裁判 研究']],
 ['ゲーム・遊び',['ボードゲーム','ゲーム文化','遊び 研究']],
 ['博物館・収集',['博物館 展示','標本 コレクション','資料館 企画']],
 ['園芸・植物',['植物園 研究','園芸 新品種','樹木 調査']],
];
// Editorial grouping for user-directed genre sampling; each existing topic appears once.
// Grouping determines search scope only. No article quality or taste judgment.
const CATEGORY_GROUPS=[
 ['自然・科学',['自然・生物','深海・海洋','宇宙・天文','地学・火山','気象・気候']],
 ['歴史・文化',['考古学','歴史・古文書','文化・風習','博物館・収集']],
 ['芸術',['建築・都市','美術・造形','写真・映像','演劇・舞踊','音楽','文学・出版']],
 ['学問',['言語・文字','教育・学習','数学','物理','化学','心理・行動']],
 ['生活',['医学・健康','食文化','農業','漁業・水産','工芸・手仕事','ファッション','園芸・植物']],
 ['技術',['交通・乗り物','製造・工場','ロボット','情報技術','エネルギー','環境・リサイクル']],
 ['社会',['地域・暮らし','経済・産業','政治・制度','法律・社会']],
 ['その他',['スポーツ','旅・地理','ゲーム・遊び']],
];
const TOPIC_NAMES=new Set(GROUPS.map(x=>x[0]));
const listed=CATEGORY_GROUPS.flatMap(x=>x[1]);
if(new Set(listed).size!==TOPIC_NAMES.size||listed.some(x=>!TOPIC_NAMES.has(x)))throw Error('ジャンル一覧と検索テーマの整合性がありません');
function catalog(){return CATEGORY_GROUPS.map(([name,categories])=>({name,categories:[...categories]}))}
function validateCategories(raw){
 if(!Array.isArray(raw)||raw.length>TOPIC_NAMES.size)throw Error('ジャンルの指定が不正です');
 const seen=new Set();
 for(const category of raw){
  if(typeof category!=='string'||!TOPIC_NAMES.has(category)||seen.has(category))throw Error('未知または重複したジャンルです');
  seen.add(category);
 }
 return [...seen];
}
const TOPICS_PER_RUN=12;
const MAX_ITEMS=40;
const PER_TOPIC=32;
const MAX_PER_PUBLISHER=5;
const jobs=new Map();

function shuffle(values){const a=[...values];for(let i=a.length-1;i>0;i--){const j=randomInt(i+1);[a[i],a[j]]=[a[j],a[i]]}return a}
function chooseTopics(selectedCategories=[]){
 const requested=validateCategories(selectedCategories);
 if(!requested.length)return shuffle(GROUPS).slice(0,TOPICS_PER_RUN).map(([category,terms])=>({category,term:terms[randomInt(terms.length)]}));
 // Give each checked topic one search before any topic receives another;
 // for one narrow topic use its 3 distinct phrases, not only one RSS query.
 const wanted=new Set(requested);
 const groups=shuffle(GROUPS.filter(([category])=>wanted.has(category)))
  .map(([category,terms])=>({category,terms:shuffle(terms)}));
 const selected=[];
 for(let round=0;round<3 && selected.length<TOPICS_PER_RUN;round++){
  for(const group of groups){
   if(selected.length>=TOPICS_PER_RUN)break;
   if(group.terms[round])selected.push({category:group.category,term:group.terms[round]});
  }
 }
 return shuffle(selected);
}
function publishersOf(xml){
 const tree=xmlTree(xml);const rss=tree.children.find(x=>x.name==='rss');
 const channel=rss?.children.find(x=>x.name==='channel');
 return (channel?.children||[]).filter(x=>x.name==='item').slice(0,250).map(item=>{
  const src=item.children.find(x=>x.name==='source');
  const pub=item.children.find(x=>['pubdate','published','dc:date','date'].includes(x.name));
  const date=Date.parse(String(pub?.parts?.join('')||''));
  return {host:quality.hostOf(src?.attrs?.url),name:String(src?.parts?.join('')||'').trim().slice(0,120),published:Number.isFinite(date)?date:0};
 });
}
function normalizeCandidate(item,info,topic,now){
 const title=String(item.title||'').slice(0,350),url=quality.urlKey(item.url);
 const published=info.published||0;
 // Strict structural checks only; NO relevance, taste, quality or age ranking.
 if(!quality.checkArticle({title,url,sourceHost:info.host,published,now}).accepted)return null;
 return {id:createHash('sha256').update(url).digest('hex').slice(0,32),
  title,url,excerpt:String(item.excerpt||'').slice(0,360),
  source:info.name?info.name+'（Googleニュース経由）':'Googleニュース',
  publisherHost:info.host,published,thumbnail:'',
  category:topic.category};
}
function sampleCandidates(topicRows,maxItems=MAX_ITEMS,similar=(a,b)=>quality.nearDuplicate(a.title,b.title,a.source,b.source)){
 // Equal *opportunities* for nonempty categories; randomly select headlines
 // inside each category. Neither newest-first nor quality-score sorting.
 const baskets=shuffle(topicRows.map(rows=>shuffle(rows)).filter(rows=>rows.length));
 const selected=[],seenUrls=new Set(),titles=[],sources=new Map();
 while(baskets.length&&selected.length<maxItems){
  for(let index=baskets.length-1;index>=0;index--){
   const group=baskets[index];
   while(group.length){
    const row=group.pop();
    if(seenUrls.has(row.url)||titles.some(previous=>similar(previous,row)))continue;
    if((sources.get(row.publisherHost)||0)>=MAX_PER_PUBLISHER)continue;
    seenUrls.add(row.url);titles.push(row);sources.set(row.publisherHost,(sources.get(row.publisherHost)||0)+1);
    selected.push(row);break;
   }
   if(!group.length)baskets.splice(index,1);
   if(selected.length>=maxItems)break;
  }
 }
 return shuffle(selected);
}
function create({fetchXml=fetchNewsXml,clock=()=>Date.now(),choose=chooseTopics,similar}={}){
 function status(pid){
  const entry=jobs.get(pid);
  if(!entry)return {items:[],running:false,generatedAt:0,error:'',progress:null,provider:'Googleニュース検索RSS',scope:'fixed_topics_not_whole_web'};
  return {items:entry.items||[],running:entry.running,generatedAt:entry.generatedAt||0,
   error:entry.error||'',progress:entry.running?{completed:entry.completed,total:entry.total}:null,
   provider:'Googleニュース検索RSS',scope:'fixed_topics_not_whole_web',topics:entry.running?[]:entry.topics||[], selectedCategories:entry.selectedCategories||[]};
 }
 function start(pid,options={}){
  const selectedCategories=validateCategories(options.categories??[]);
  if(!Number.isSafeInteger(pid)||pid<1)throw Error('プロファイルが不正です');
  if(jobs.get(pid)?.running)return {started:false,running:true};
  const topics=choose(selectedCategories),startTime=clock();
  if(!Array.isArray(topics)||!topics.length)throw Error('探索テーマがありません');
  const entry={running:true,completed:0,total:topics.length,items:[],generatedAt:0,error:'',topics:[],selectedCategories};
  jobs.set(pid,entry);
  setImmediate(async()=>{
   const collected=new Array(topics.length).fill(null).map(()=>[]),failures=[];
   let nextIndex=0;
   async function worker(){
    while(nextIndex<topics.length){
     const i=nextIndex++,topic=topics[i];
     try{
      const u=new URL('https://news.google.com/rss/search');
      u.searchParams.set('q',topic.term+' when:7d');
      u.searchParams.set('hl','ja');u.searchParams.set('gl','JP');u.searchParams.set('ceid','JP:ja');
      const xml=await fetchXml(u.toString());
      const feed=parseFeed(xml,u.toString()),publishers=publishersOf(xml);
      collected[i]=feed.items.slice(0,PER_TOPIC).map((item,j)=>normalizeCandidate(item,publishers[j]||{},topic,startTime)).filter(Boolean);
     }catch(e){failures.push(String(e?.message||e).slice(0,90))}
     finally{entry.completed++}
    }
   }
   try{
    await Promise.all(Array.from({length:Math.min(3,topics.length)},()=>worker()));
    entry.items=sampleCandidates(collected,MAX_ITEMS,similar);
    entry.topics=topics.map(x=>x.category);
    if(failures.length)entry.error=`${failures.length}/${topics.length}検索の取得に失敗しました。取得できた記事のみ表示しています。`;
    if(!entry.items.length&&!entry.error)entry.error='今回の探索では記事を取得できませんでした。';
    entry.generatedAt=clock();
   }catch(e){entry.error='探索失敗：'+String(e?.message||e).slice(0,120)}
   finally{entry.running=false}
  });
  return {started:true,running:true};
 }
 return {status,start,catalog};
}
module.exports={create,chooseTopics,validateCategories,catalog,sampleCandidates,normalizeCandidate,publishersOf,GROUPS};
