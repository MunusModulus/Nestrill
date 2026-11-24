'use strict';
// ConditionTrial01: explicit, per-search source controls for an ISOLATED TEST app.
// The production E2 7:2:1 pipeline is deliberately untouched.
// "useLikes" can affect locally planned SEARCH TOPICS only; it does not rank or veto articles.
const {randomInt}=require('node:crypto');
const random=require('./ai-random');
const {fetchNewsXml}=require('./ai-external');
const semantic=require('./ai-semantic');
const diversity=require('./ai-condition-diversity');
const latest=require('./ai-latest');
const MAX_SEARCHES=12;
const jobs=new Map();
function shuffle(items){const out=[...items];for(let i=out.length-1;i>0;i--){const j=randomInt(i+1);[out[i],out[j]]=[out[j],out[i]]}return out}
function inputOptions(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('探索条件が不正です');
 if(Object.keys(input).some(k=>!['categories','useInterests','useLikes','order'].includes(k)))throw Error('許可されない探索設定です');
 if(typeof input.useInterests!=='boolean'||typeof input.useLikes!=='boolean')throw Error('利用する関心情報をON/OFFで指定してください');
 const order=input.order??'random';if(!['random','latest'].includes(order))throw Error('記事の探し方が不正です');
 return {categories:random.validateCategories(input.categories??[]),useInterests:input.useInterests,useLikes:input.useLikes,order};
}
function uniqueTerms(terms){const seen=new Set(),out=[];for(const term of terms){if(typeof term!=='string')continue;const value=term.trim().replace(/[\r\n]/g,' ');const key=value.normalize('NFKC').toLocaleLowerCase();if(!value||value.length>80||seen.has(key))continue;seen.add(key);out.push(value)}return out}
function combineTopics(categories,interests,inferred){
 const interestSignals=shuffle(interests.map(term=>({term,source:'interest'})));
 const likeSignals=shuffle(inferred.map(term=>({term,source:'like'})));
 // An unrestricted, personalized search retains the previous random ordering.
 // (Both ON + no genre is handled by the existing 7:2:1 screen.)
 if(!categories.length)return shuffle([...interestSignals,...likeSignals]).slice(0,MAX_SEARCHES)
  .map(({term,source})=>({category:source==='interest'?'関心リスト':'興味あり',term,origin:source}));
 const base=random.chooseTopics(categories);
 // Keep genre-only searches: preference terms refine the chosen genre, not replace it.
 const limit=Math.min(4,Math.max(0,MAX_SEARCHES-Math.min(8,base.length)));
 const selected=[],seen=new Set();
 function take(source,signals,count){
  for(const entry of signals){
   if(count<=0||selected.length>=limit)break;
   const key=entry.term.normalize('NFKC').toLocaleLowerCase().trim();
   if(!key||seen.has(key))continue;
   seen.add(key);selected.push(entry);count--;
  }
 }
 if(interestSignals.length && likeSignals.length){
  // Guarantee an opportunity for BOTH enabled sources when they provide distinct
  // terms. This is a search-query budget, not a quota on resulting articles.
  take('interest',interestSignals,2);
  take('like',likeSignals,2);
 }
 // Use free slots instead of padding with made-up interests. With one source ON,
 // all four refinement slots remain available to it.
 if(selected.length<limit){
  const remaining=shuffle([...interestSignals,...likeSignals]);
  take('remaining',remaining,limit-selected.length);
 }
 const paired=selected.map((signal,index)=>{
  const anchor=base[index%base.length];
  return {category:anchor.category,term:`${anchor.term} ${signal.term}`.slice(0,150),origin:signal.source};
 });
 const plain=base.slice(0,MAX_SEARCHES-paired.length).map(x=>({...x,origin:'genre'}));
 const unique=new Map();
 for(const x of [...plain,...paired]){
  const key=x.term.normalize('NFKC').toLocaleLowerCase();
  if(!unique.has(key))unique.set(key,x);
 }
 return shuffle([...unique.values()]);
}
function create({db,fetchXml=fetchNewsXml,planLikedTopics=semantic.planLikedSearchQueries,clock=()=>Date.now()}={}){
 if(!db)throw Error('Conditional exploration requires a database');
 function readInterests(pid){
  const rss=db.prepare('SELECT terms_json FROM ai_interest_lists WHERE profile_id=?').get(pid);
  const shared=db.prepare("SELECT terms_json FROM ai_interest_lists_scoped WHERE profile_id=? AND scope='shared'").get(pid);
  let values=[];for(const row of [rss,shared]){try{values.push(...JSON.parse(row?.terms_json||'[]'))}catch{}}
  return uniqueTerms(values);
 }
 function positives(pid){
  // Same profile-scoped explicit positive evidence as E2 (not negative ratings or opens).
  return db.prepare(`SELECT title,excerpt,comment,1 AS rating FROM (
   SELECT a.title,COALESCE(a.excerpt,'') AS excerpt,f.comment,f.updated_at
   FROM ai_item_feedback f JOIN articles a ON f.kind='rss' AND CAST(a.id AS TEXT)=f.item_id
   JOIN profile_feeds pf ON pf.feed_id=a.feed_id AND pf.profile_id=f.profile_id
   WHERE f.profile_id=? AND f.rating=1
   UNION ALL
   SELECT m.title,COALESCE(m.excerpt,'') AS excerpt,f.comment,f.updated_at
   FROM ai_item_feedback f JOIN ai_external_feedback_meta m
    ON m.profile_id=f.profile_id AND m.item_id=f.item_id
   WHERE f.profile_id=? AND f.kind='rss' AND f.rating=1
   UNION ALL
   SELECT MAX(v.title) AS title,COALESCE(MAX(v.excerpt),'') AS excerpt,f.comment,f.updated_at
   FROM ai_item_feedback f JOIN youtube_videos_local v ON f.kind='youtube' AND v.video_id=f.item_id
   JOIN youtube_subscriptions_local sub ON sub.channel_id=v.channel_id
   JOIN source_accounts ac ON ac.id=sub.account_id AND ac.profile_id=f.profile_id AND ac.service='youtube'
   WHERE f.profile_id=? AND f.rating=1 GROUP BY f.item_id
  ) ORDER BY updated_at DESC LIMIT 18`).all(pid,pid,pid);
 }
 function weakOpens(pid){
  return db.prepare(`SELECT o.title,o.kind,MIN(o.open_days,3) AS open_days FROM ai_article_open_signals o
   WHERE o.profile_id=? AND o.last_opened_at>? AND TRIM(o.title)<>''
   AND NOT EXISTS (SELECT 1 FROM ai_item_feedback f
     WHERE f.profile_id=o.profile_id AND f.kind=o.kind AND f.item_id=o.item_id
     AND (f.rating<>0 OR TRIM(COALESCE(f.comment,''))<>''))
   ORDER BY o.last_opened_at DESC LIMIT 6`).all(pid,clock()-90*86400000);
 }
 function effectiveModel(pid){const saved=db.prepare('SELECT model FROM ai_model_config WHERE profile_id=?').get(pid);return saved?saved.model:'gemma4:e4b-it-qat'}
 function status(pid){
  const job=jobs.get(pid);
  if(!job)return {items:[],running:false,generatedAt:0,error:'',progress:null,mode:'none'};
  let data;
  if(job.phase==='planning')data={items:[],running:true,generatedAt:0,error:'',progress:{completed:0,total:1}};
  else if(job.phase==='error')data={items:[],running:false,generatedAt:job.finishedAt,error:job.error,progress:null};
  else data=job.engine.status(pid);
  let ratingMap=new Map();
  const ids=(data.items||[]).map(x=>'x:'+x.id);
  if(ids.length){const records=db.prepare(`SELECT item_id,rating FROM ai_item_feedback WHERE profile_id=? AND kind='rss' AND item_id IN (${ids.map(()=>'?').join(',')})`).all(pid,...ids);ratingMap=new Map(records.map(x=>[x.item_id,x.rating]));}
  return {...data,items:(data.items||[]).map(x=>({...x,liked:ratingMap.get('x:'+x.id)===1})),
   mode:job.mode,order:job.options.order,selectedCategories:job.options.categories,sourceOptions:{useInterests:job.options.useInterests,useLikes:job.options.useLikes},
   queryCount:job.topics?.length||0,notes:job.notes||[],phase:job.phase};
 }
 function start(pid,input){
  const options=inputOptions(input);
  if(!Number.isSafeInteger(pid)||pid<1)throw Error('プロファイルが不正です');
  if(status(pid).running)return {started:false,running:true};
  const job={options,mode:options.order==='latest'?'latest':(!options.useInterests&&!options.useLikes?'random':'personalized_topics'),phase:'planning',notes:[],engine:null,topics:[],finishedAt:0,error:''};
  jobs.set(pid,job);
  // No preference evidence is used for search when both switches are OFF.
  if(!options.useInterests&&!options.useLikes){
   job.engine=options.order==='latest'?latest.create({fetchXml,clock}):random.create({fetchXml,clock});
   if(options.order==='latest')job.topics=latest.querySpecs(options.categories);
   job.phase='fetching';
   return job.engine.start(pid,{categories:options.categories});
  }
  setImmediate(async()=>{
   try{
    const interests=options.useInterests?readInterests(pid):[];
    if(options.useInterests&&!interests.length)throw Error('関心リストONですが、登録済みの関心語がありません。関心リストを設定してください。');
    const liked=options.useLikes?positives(pid):[];
    if(options.useLikes&&!liked.length){
     if(!options.useInterests)throw Error('「興味あり」ONですが評価履歴がありません。まず探索結果に「興味あり」を付けてください。');
     job.notes.push('興味あり評価がないため、今回は関心リストだけを使用しました。');
    }
    let topics=[];
    if(options.useLikes&&liked.length){
     const model=effectiveModel(pid);
     if(!model){
      if(!options.useInterests)throw Error('興味ありから検索テーマを作るにはローカルAIモデルが必要です。');
      job.notes.push('モデル未設定のため、興味ありによる検索テーマ生成は省略しました。');
     }else{
      try{
       const anchors=diversity.chooseLikedAnchors(liked,8);
       const results=await planLikedTopics({model,interests:options.useInterests?interests:[],feedback:anchors,
        weakOpens:weakOpens(pid),exclusions:[]});
       topics=uniqueTerms(diversity.distinctLikedQueries(results||[]).map(x=>x.topic)).slice(0,4);
       job.notes.push(`興味あり${liked.length}件から異なる主題${anchors.length}件を確認し、検索語${topics.length}件を採用しました。`);
       if(!topics.length)job.notes.push('興味ありの記事から検索テーマを作れませんでした（AIから有効な検索語が返されませんでした）。');
      }catch(e){
       if(!options.useInterests)throw Error('興味ありのAI検索テーマ生成に失敗しました：'+String(e.message||e).slice(0,110));
       job.notes.push('興味ありのAIテーマ生成が利用できず、関心リストを使用しました：'+String(e.message||e).slice(0,75));
      }
     }
    }
    const personalTerms=options.useInterests?shuffle(interests).slice(0,4):[];
    const queries=combineTopics(options.categories,personalTerms,topics);
    if(!queries.length)throw Error('探索条件から有効な検索テーマを作れませんでした。');
    if(options.categories.length){
     const counts={genre:0,interest:0,like:0};
     for(const item of queries)if(Object.hasOwn(counts,item.origin))counts[item.origin]++;
     job.notes.push(`検索語の配分：ジャンル単独${counts.genre}件・関心リスト由来${counts.interest}件・興味あり由来${counts.like}件（記事の件数配分ではありません）。`);
    }
    job.topics=queries;job.engine=options.order==='latest'?latest.create({fetchXml,clock}):random.create({fetchXml,clock,choose:()=>queries,
     ...(options.useLikes?{similar:diversity.sameReportedEvent}:{})});job.phase='fetching';
    job.engine.start(pid,{categories:options.categories,...(options.order==='latest'?{personalTopics:queries}:{})});
   }catch(e){job.error=String(e?.message||e).slice(0,220);job.finishedAt=clock();job.phase='error'}
  });
  return {started:true,running:true};
 }
 function rate(pid,input){
  if(!Number.isSafeInteger(pid)||pid<1||!input||typeof input!=='object')throw Error('評価指定が不正です');
  if(Object.keys(input).some(k=>!['id','rating'].includes(k))||![0,1].includes(input.rating))throw Error('評価は「興味あり」または解除のみです');
  const id=String(input.id||'');if(!/^[a-f0-9]{32}$/.test(id))throw Error('記事IDが不正です');
  const job=jobs.get(pid),data=job?.engine?.status(pid);
  if(!data||!data.generatedAt||clock()-data.generatedAt>7*86400000)throw Error('評価対象の探索結果が期限切れです');
  const article=(data.items||[]).find(x=>x.id===id);
  if(!article||!/^https:\/\//.test(article.url))throw Error('現在のプロファイルの探索記事ではありません');
  const key='x:'+id,stamp=clock();db.exec('BEGIN');
  try{
   if(input.rating===1){
    db.prepare(`INSERT INTO ai_external_feedback_meta(profile_id,item_id,title,url,excerpt) VALUES(?,?,?,?,?)
     ON CONFLICT(profile_id,item_id) DO UPDATE SET title=excluded.title,url=excluded.url,excerpt=excluded.excerpt`)
     .run(pid,key,String(article.title).slice(0,350),String(article.url).slice(0,2000),String(article.excerpt||'').slice(0,180));
    db.prepare(`INSERT INTO ai_item_feedback(profile_id,kind,item_id,rating,comment,updated_at) VALUES(?,'rss',?,1,'',?)
     ON CONFLICT(profile_id,kind,item_id) DO UPDATE SET rating=1,updated_at=excluded.updated_at`)
     .run(pid,key,stamp);
   }else{
    db.prepare("DELETE FROM ai_item_feedback WHERE profile_id=? AND kind='rss' AND item_id=?").run(pid,key);
    db.prepare('DELETE FROM ai_external_feedback_meta WHERE profile_id=? AND item_id=?').run(pid,key);
   }
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  return {id,rating:input.rating};
 }
 return {start,status,rate,readInterests};
}
module.exports={create,inputOptions,combineTopics};
