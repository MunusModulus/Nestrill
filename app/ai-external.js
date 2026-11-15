'use strict';
// E2: on-demand external RSS search preview. This is NOT the 7:2:1 recommendation engine.
// A fixed public search-RSS provider avoids user-supplied URLs / SSRF.
const {parseFeed,xmlTree}=require('./feed');
const {createHash,randomInt}=require('node:crypto');
const {titleMatchesExclusion}=require('./ai-exclusion');
const quality=require('./ai-source-quality');
// Fix82: no secondary news lookup; use original Google RSS metadata only.
// Fix102F: widen independent E2 search *candidate* collection for the quality trial.
// No recommendation quota or per-article score changes.
// Fix102G: bound retrieval by topics, quality and search-lane reserves.
// Fallbacks are ONE planning round, not a recommendation-count filler.
// Overlap bounded Google RSS I/O only; leave local Ollama calls sequential.
const RSS_FETCH_CONCURRENCY=3;
const MAX_PER_TERM=20;
const E2_DEFAULT={topicCount:4,maxItems:40,directWeight:25,inferenceWeight:25,discoveryWeight:50};
const E2_MAX_DIRECT_TOPICS=40,E2_MAX_ITEMS=200;
const MAX_SEMANTIC_PER_TOPIC=16;
const MAX_BYTES=1_500_000;
const MAX_AGE=7*24*60*60*1000;
// Fix103C: reuse only fully validated, profile-local E2 decisions for identical
// model + topic/exclusions + article metadata. A short TTL bounds staleness.
// This never invents a score or changes the search/quality/selection criteria.
const E2_CACHE_TTL=48*60*60*1000;
const E2_CACHE_VERSION='Fix103C-screen-v1-exclusion-v1';
const jobs=new Map();
// Preserve retrieval diversity without inventing a topic/value score. Each
// query gets a turn before another query consumes the discovery reserve.
function roundRobinQueries(items){
 const groups=new Map(),out=[];
 for(const x of items){const key=String(x.queryLabel||'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(x)}
 let more=true;
 while(more){more=false;for(const queue of groups.values())if(queue.length){out.push(queue.shift());more=true}}
 return out;
}
// Fix103Q: for small E2 article caps, sample one AI batch from every
// quality-approved search topic before considering an early stop. Treat
// unexamined candidates as UNEXAMINED, never as an AI rejection. For larger
// runs, keep the Fix103P task order and full evaluation unchanged.
function interleaveTopicTasks(tasks){
 const buckets=new Map(),out=[];
 for(const t of tasks){if(!buckets.has(t.qi))buckets.set(t.qi,[]);buckets.get(t.qi).push(t)}
 let more=true;
 while(more){more=false;for(const queue of buckets.values())if(queue.length){out.push(queue.shift());more=true}}
 return out;
}
function smallRunPoolSufficient({maxItems,reserves,audits,remainingTasks,ready,previewRejected,touched}){
 // Avoid a premature cut that never looks at late search topics.
 for(let i=0;i<audits.length;i++)if(audits[i]?.qualityApproved>0&&!touched.has(i))return false;
 // An incomplete AI response must not make unverified direct-interest
 // candidates a reason to skip remaining semantic checks.
 if(audits.some(q=>q?.semanticUnavailable>0))return false;
 const candidates=[...ready.values()].filter(x=>!previewRejected.has(x.id));
 const safety=Math.max(8,Math.ceil(maxItems/4));
 if(candidates.length<maxItems+safety)return false;
 const lanes=['direct','inference','discovery'];
 const passed={direct:0,inference:0,discovery:0},pending={direct:0,inference:0,discovery:0};
 const laneOf=x=>x.discoveryLane?'discovery':x.inferenceLane?'inference':'direct';
 for(const x of candidates)passed[laneOf(x)]++;
 for(const task of remainingTasks)pending[task.lane]+=task.rows.length;
 // The reserves are priorities, not mandatory quotas. If a lane still has
 // unexamined candidates that might fulfil its reserve, do not abandon them.
 for(const lane of lanes)if(passed[lane]<reserves[lane]&&pending[lane]>0)return false;
 return true;
}
// Fix82C: one bounded broadening step ONLY if a discovery search returned
// zero RSS entries. Do not use this for explicit or inferred searches, and
// never substitute a user-interest query or invent articles.
function discoveryQueryVariants(term,lane){
 const words=String(term||'').trim().split(/\s+/u).filter(Boolean);
 if(lane!==1||words.length<=2)return [term];
 const shorter=words.slice(0,2).join(' ');
 return shorter&&shorter!==term?[term,shorter]:[term];
}
function keyOf(url){try{const u=new URL(url);u.hash='';return u.toString()}catch{return ''}}
function cleanTitle(t){return String(t||'').replace(/\s+-\s+[^-]{2,80}$/u,'').trim().toLocaleLowerCase()}
function siteHost(url){try{return new URL(url).hostname.toLowerCase().replace(/^www\./,'')}catch{return ''}}
// Fix103V: collapse only highly convincing repeated HEADLINE reports before any
// E2 row is streamed. This is NOT a news-category/attractiveness classifier.
// Keep doubtful rewrites, reviews and articles about different developments.
function reportTitle(title){
 const main=String(title||'').normalize('NFKC').split(/\s+-\s+(?=[^-]{2,80}$)/u)[0].split(/\s+\|\s+/u)[0];
 return main.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
}
function reportShingles(title){
 const out=new Set();for(let i=0;i+3<=title.length;i++)out.add(title.slice(i,i+3));return out;
}
function twoDistinctSharedRuns(shorter,longer){
 // A shorter rewrite can be recognised if it contains two separated,
 // substantive phrases also present in the longer headline; one shared
 // product/model name alone is not evidence of the same news event.
 let blocks=0,last=-100;
 for(let i=0;i+6<=shorter.length;i++){
  if(!longer.includes(shorter.slice(i,i+6)))continue;
  if(i>last+6)blocks++;
  last=i;
  if(blocks>=2)return true;
 }
 return false;
}
function sameClearReport(a,b){
 const first=reportTitle(a),second=reportTitle(b);
 if(first.length<20||second.length<20)return false;
 if(first===second)return true;
 const aSet=reportShingles(first),bSet=reportShingles(second);
 let shared=0;for(const s of aSet)if(bSet.has(s))shared++;
 const dice=2*shared/(aSet.size+bSet.size);
 const shorterCoverage=shared/Math.min(aSet.size,bSet.size);
 if(dice>=0.64&&shorterCoverage>=0.78)return true;
 return dice>=0.45&&shorterCoverage>=0.55&&
  twoDistinctSharedRuns(first.length<=second.length?first:second,
    first.length<=second.length?second:first);
}
function reportPublisher(row){
 return String(row.sourceHost||row.source||'').trim().toLocaleLowerCase();
}
function repeatAcrossRows(a,b){
 // Two separate posts from the SAME outlet can be a review and an update,
 // even if their product or event vocabulary strongly overlaps. Do not
 // collapse those unless the normalized headline itself is identical.
 const publisherA=reportPublisher(a),publisherB=reportPublisher(b);
 if(publisherA&&publisherB&&publisherA===publisherB&&reportTitle(a.title)!==reportTitle(b.title))return false;
 return sameClearReport(a.title,b.title);
}
function collapseRepeatedReports(items){
 // Preserve the earliest group's position; within an unmistakable repeat
 // choose the already-scored, more informative headline, never by publisher.
 const groups=[];
 for(const item of items){
  let g=null;
  for(const group of groups){
   if(group.all.some(x=>repeatAcrossRows(x,item))){g=group;break}
  }
  if(!g){groups.push({best:item,all:[item]});continue}
  g.all.push(item);
  const a=g.best,b=item;
  const aScore=Number.isFinite(Number(a.qualityScore))?Number(a.qualityScore):0;
  const bScore=Number.isFinite(Number(b.qualityScore))?Number(b.qualityScore):0;
  if(bScore>aScore||(bScore===aScore&&reportTitle(b.title).length>reportTitle(a.title).length))g.best=b;
 }
 const kept=groups.map(x=>x.best);
 const suppressed=items.length-kept.length;
 return {items:kept,suppressed};
}

function publisherOf(xml){
 // Google News RSS often supplies <source url="https://publisher...">Publisher</source>.
 // Preserve order to pair it with parseFeed's item list; no remote publisher request.
 const tree=xmlTree(xml),rss=tree.children.find(x=>x.name==='rss');
 const channel=rss?.children.find(x=>x.name==='channel');
 return (channel?.children||[]).filter(x=>x.name==='item').slice(0,250).map(x=>{
  const node=x.children.find(c=>c.name==='source');
  const dateNode=x.children.find(c=>['pubdate','published','dc:date','date'].includes(c.name));
  const published=Date.parse(String(dateNode?.parts?.join('')||'').trim());
  return {host:quality.hostOf(node?.attrs?.url),name:String(node?.parts?.join('')||'').trim().slice(0,120),
   published:Number.isFinite(published)&&published>0?published:0};
 });
}
function create({db,fetchXml=fetchNewsXml,semantic=require('./ai-semantic')}){
 db.exec(`CREATE TABLE IF NOT EXISTS ai_external_articles (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  id TEXT NOT NULL, title TEXT NOT NULL, excerpt TEXT NOT NULL,
  url TEXT NOT NULL, source TEXT NOT NULL, published INTEGER NOT NULL,
  thumbnail TEXT NOT NULL, query_label TEXT NOT NULL,
  collected_at INTEGER NOT NULL,
  interest_updated_at INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id)
 ); CREATE INDEX IF NOT EXISTS idx_ai_external_profile_time
 ON ai_external_articles(profile_id,collected_at DESC);`);
 db.exec(`CREATE TABLE IF NOT EXISTS ai_external_quality_runs (
  profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  collected_at INTEGER NOT NULL, interest_updated_at INTEGER NOT NULL,
  exclusion_updated_at INTEGER NOT NULL, stats_json TEXT NOT NULL DEFAULT '{}');`);
 // Derived metadata only: normal E2 articles/ratings/history are never modified.
 db.exec(`CREATE TABLE IF NOT EXISTS ai_e2_decision_cache (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, context_digest TEXT NOT NULL, item_digest TEXT NOT NULL,
  decision_json TEXT NOT NULL, cached_at INTEGER NOT NULL,
  PRIMARY KEY(profile_id,kind,context_digest,item_digest));
 CREATE INDEX IF NOT EXISTS idx_ai_e2_decision_cache_age
  ON ai_e2_decision_cache(profile_id,cached_at);`);
 // Fix103M: per-profile E2 controls and a persistent, shuffled interest cycle.
 // Only new, independent tables are added. Existing articles and ratings remain untouched.
 db.exec(`CREATE TABLE IF NOT EXISTS ai_e2_settings (
  profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  topic_count INTEGER NOT NULL DEFAULT 4,
  max_items INTEGER NOT NULL DEFAULT 40,
  direct_weight INTEGER NOT NULL DEFAULT 25,
  inference_weight INTEGER NOT NULL DEFAULT 25,
  discovery_weight INTEGER NOT NULL DEFAULT 50,
  updated_at INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS ai_e2_topic_rotation (
  profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  topics_hash TEXT NOT NULL, remaining_json TEXT NOT NULL, updated_at INTEGER NOT NULL
 );`);
 function settings(pid){
  const row=db.prepare(`SELECT topic_count,max_items,direct_weight,inference_weight,discovery_weight,updated_at
   FROM ai_e2_settings WHERE profile_id=?`).get(pid);
  return row?{topicCount:row.topic_count,maxItems:row.max_items,directWeight:row.direct_weight,
   inferenceWeight:row.inference_weight,discoveryWeight:row.discovery_weight,updatedAt:row.updated_at}:
   {...E2_DEFAULT,updatedAt:0};
 }
 function updateSettings(pid,input){
  if(jobs.get(pid)?.state==='running')throw Error('探索中は設定を変更できません');
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('設定データが不正です');
  const keys=['topicCount','maxItems','directWeight','inferenceWeight','discoveryWeight'];
  if(Object.keys(input).some(k=>!keys.includes(k))||keys.some(k=>!Number.isSafeInteger(input[k])))throw Error('各設定には整数を指定してください');
  if(input.topicCount<1||input.topicCount>E2_MAX_DIRECT_TOPICS)throw Error('関心テーマ数は1～40件です');
  if(input.maxItems<20||input.maxItems>E2_MAX_ITEMS)throw Error('探索上限は20～200件です');
  if(['directWeight','inferenceWeight','discoveryWeight'].some(k=>input[k]<1||input[k]>100))throw Error('各探索比率は1～100です');
  const interest=db.prepare('SELECT terms_json FROM ai_interest_lists WHERE profile_id=?').get(pid);
  const all=JSON.parse(interest?.terms_json||'[]');
  const usable=[...new Set(all.filter(x=>typeof x==='string'&&x.trim()&&x.length<=80).map(x=>x.trim()))];
  if(input.topicCount>usable.length)throw Error('直接検索するテーマ数が登録済み関心語数を超えています');
  const prev=settings(pid),stamp=Math.max(Date.now(),Number(prev.updatedAt)+1);
  db.prepare(`INSERT INTO ai_e2_settings (profile_id,topic_count,max_items,direct_weight,inference_weight,discovery_weight,updated_at)
   VALUES (?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET topic_count=excluded.topic_count,
   max_items=excluded.max_items,direct_weight=excluded.direct_weight,inference_weight=excluded.inference_weight,
   discovery_weight=excluded.discovery_weight,updated_at=excluded.updated_at`)
   .run(pid,input.topicCount,input.maxItems,input.directWeight,input.inferenceWeight,input.discoveryWeight,stamp);
  return settings(pid);
 }
 function normalizeTopic(x){return String(x).normalize('NFKC').trim().toLocaleLowerCase()}
 function shuffle(list){
  const a=[...list];
  for(let i=a.length-1;i>0;i--){const j=randomInt(i+1);[a[i],a[j]]=[a[j],a[i]]}
  return a;
 }
 function topicSelection(pid,terms,count){
  const unique=new Map();
  for(const raw of terms){if(typeof raw!=='string'||!raw.trim()||raw.length>80)continue;
   const key=normalizeTopic(raw);if(!unique.has(key))unique.set(key,raw.trim())}
  const keys=[...unique.keys()];
  if(!keys.length)throw Error('有効な関心語がありません');
  const topicsHash=digest([...keys].sort());
  const old=db.prepare('SELECT topics_hash,remaining_json FROM ai_e2_topic_rotation WHERE profile_id=?').get(pid);
  let queue=[];
  if(old?.topics_hash===topicsHash){
   try{const saved=JSON.parse(old.remaining_json);if(Array.isArray(saved)){
    const seen=new Set();queue=saved.filter(k=>typeof k==='string'&&unique.has(k)&&!seen.has(k)&&!!seen.add(k));
   }}catch{}
  }
  if(!queue.length)queue=shuffle(keys);
  const selected=[];
  while(selected.length<Math.min(count,keys.length)){
   if(!queue.length){
    // Once a cycle ends, reshuffle. Avoid a duplicate within this same search.
    queue=[...shuffle(keys.filter(k=>!selected.includes(k))),...shuffle(keys.filter(k=>selected.includes(k)))];
    if(!queue.length)break;
   }
   const next=queue.shift();if(!selected.includes(next))selected.push(next);
  }
  return {selected:selected.map(k=>unique.get(k)),topicsHash,remaining:queue};
 }
 function reserveSizes(cfg){
  const weights=[cfg.directWeight,cfg.inferenceWeight,cfg.discoveryWeight],total=weights.reduce((a,b)=>a+b,0);
  const scaled=weights.map(w=>cfg.maxItems*w/total),counts=scaled.map(Math.floor);
  const remaining=cfg.maxItems-counts.reduce((a,b)=>a+b,0);
  const priority=[0,1,2].sort((a,b)=>(scaled[b]-counts[b])-(scaled[a]-counts[a]));
  for(let i=0;i<remaining;i++)counts[priority[i]]++;
  return {direct:counts[0],inference:counts[1],discovery:counts[2]};
 }
 const cacheGet=db.prepare(`SELECT decision_json FROM ai_e2_decision_cache
  WHERE profile_id=? AND kind=? AND context_digest=? AND item_digest=? AND cached_at>=?`);
 const cachePut=db.prepare(`INSERT INTO ai_e2_decision_cache
  (profile_id,kind,context_digest,item_digest,decision_json,cached_at)
  VALUES (?,?,?,?,?,?) ON CONFLICT(profile_id,kind,context_digest,item_digest)
  DO UPDATE SET decision_json=excluded.decision_json,cached_at=excluded.cached_at`);
 const cachePurge=db.prepare(`DELETE FROM ai_e2_decision_cache WHERE profile_id=? AND cached_at<?`);
 function digest(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex')}
 function articleDigest(x){return digest([String(x.id),String(x.title||''),String(x.excerpt||''),String(x.url||''),Number(x.published)||0])}
 // Caching is optional acceleration: a damaged/unavailable cache must never
 // prevent the normal model from handling an article.
 function readCached(pid,kind,context,x){
  try{
   const entry=cacheGet.get(pid,kind,context,articleDigest(x),Date.now()-E2_CACHE_TTL);
   if(!entry)return null;
   const decision=JSON.parse(entry.decision_json);
   if(kind==='exclude')return typeof decision.excluded==='boolean'?decision:null;
   return ['direct','adjacent','unrelated','uncertain'].includes(decision.relation)
    &&typeof decision.why==='string'?decision:null;
  }catch{return null}
 }
 function saveCached(pid,kind,context,x,decision){
  try{cachePut.run(pid,kind,context,articleDigest(x),JSON.stringify(decision),Date.now())}
  catch{/* Failed cache writes never weaken semantic checking. */}
 }
 for(const [column,ddl] of [['exclusion_mode',"TEXT NOT NULL DEFAULT 'none'"],['exclusion_updated_at','INTEGER NOT NULL DEFAULT 0'],
  ['publisher_host',"TEXT NOT NULL DEFAULT ''"],['quality_score','INTEGER NOT NULL DEFAULT 0'],
  ['quality_notes',"TEXT NOT NULL DEFAULT ''"],['discovery_lane','INTEGER NOT NULL DEFAULT 0'],['discovery_bridge',"TEXT NOT NULL DEFAULT ''"],['inference_lane','INTEGER NOT NULL DEFAULT 0']]){
  if(!db.prepare('PRAGMA table_info(ai_external_articles)').all().some(c=>c.name===column))
   db.exec(`ALTER TABLE ai_external_articles ADD COLUMN ${column} ${ddl}`);
 }
 // Fix103N: appended order is immutable for articles already shown to readers.
 if(!db.prepare('PRAGMA table_info(ai_external_articles)').all().some(c=>c.name==='display_order'))
  db.exec('ALTER TABLE ai_external_articles ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0');
 function getExclusions(pid){
  const r=db.prepare('SELECT terms_json,updated_at FROM ai_exclusion_lists WHERE profile_id=?').get(pid);
  return {terms:r?JSON.parse(r.terms_json):[],updatedAt:r?.updated_at||0};
 }
 const status=pid=>{
  const cfg=db.prepare('SELECT terms_json,updated_at FROM ai_interest_lists WHERE profile_id=?').get(pid);
  const stamp=Number(cfg?.updated_at)||0,exStamp=getExclusions(pid).updatedAt;
  const opts=settings(pid);
  const r=db.prepare('SELECT MAX(collected_at) AS stamp,MAX(exclusion_mode) AS mode FROM ai_external_articles WHERE profile_id=? AND interest_updated_at=? AND exclusion_updated_at=?').get(pid,stamp,exStamp);
  const recent=Number(r?.stamp)||0;
  const items=recent?db.prepare(`SELECT id,title,excerpt,url,source,published,thumbnail,query_label AS queryLabel
   ,publisher_host AS publisherHost,quality_score AS qualityScore,quality_notes AS qualityNotes,discovery_lane AS discoveryLane,discovery_bridge AS discoveryBridge,inference_lane AS inferenceLane
   FROM ai_external_articles WHERE profile_id=? AND interest_updated_at=? AND exclusion_updated_at=? AND collected_at>=?
   ORDER BY CASE WHEN display_order>0 THEN display_order ELSE 999999 END ASC,published DESC LIMIT ?`).all(pid,stamp,exStamp,Date.now()-MAX_AGE,E2_MAX_ITEMS):[];
  const run=db.prepare(`SELECT stats_json,collected_at FROM ai_external_quality_runs
   WHERE profile_id=? AND interest_updated_at=? AND exclusion_updated_at=?`).get(pid,stamp,exStamp);
  const qualityStats=run&&(!recent||run.collected_at===recent)?JSON.parse(run.stats_json):null;
  const job=jobs.get(pid);
  const denied=getExclusions(pid).terms;
  const visible=items.filter(x=>!titleMatchesExclusion(x.title,denied));
  // Return existing feedback in the E2 preview, without exposing other profiles.
  // x: is the same canonical external feedback ID used by E4 recommendations.
  let withFeedback=visible;
  if(visible.length){
   const ids=visible.map(x=>'x:'+x.id);
   const records=db.prepare(`SELECT item_id,rating,comment,updated_at FROM ai_item_feedback
     WHERE profile_id=? AND kind='rss' AND item_id IN (${ids.map(()=>'?').join(',')})`).all(pid,...ids);
   const byId=new Map(records.map(x=>[x.item_id,x]));
   withFeedback=visible.map(x=>{
    const r=byId.get('x:'+x.id);
    return {...x,feedback:{rating:r?.rating||0,comment:r?.comment||'',updatedAt:r?.updated_at||0}};
   });
  }
  return {items:withFeedback,generatedAt:recent||(qualityStats?run.collected_at:0)||(job?.state==='done'&&!job.error?job.finishedAt:0),running:job?.state==='running',
   progress:job?{completed:job.completed,total:job.total,stage:job.stage||'fetching',published:job.publishedCount||0,firstPublishedMs:job.firstPublishedMs||0}:null,
   exclusionMode:job?.exclusionMode||r?.mode||'none',
   error:job?.error||'',provider:'Googleニュース検索RSS',
   enabled:!!cfg,hasInterests:!!(cfg&&JSON.parse(cfg.terms_json||'[]').length),
   manualOnly:true,ratioApplied:false,qualityStats,qualityApplied:!!qualityStats||!!(job?.state==='running'&&job.publishedCount),elapsedMs:job?.state==='running'?Date.now()-job.startedAt:qualityStats?.elapsedMs||0,
   settings:opts,interestCount:cfg?JSON.parse(cfg.terms_json||'[]').filter(t=>typeof t==='string'&&t.trim()&&t.length<=80).length:0};
 };
 // Positive feedback remains the primary basis for inferred searches.
 // Each query is strictly profile-scoped, including secret profiles.
 function positiveFeedback(pid){
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
   WHERE f.profile_id=? AND f.rating=1
   GROUP BY f.item_id
  ) ORDER BY updated_at DESC LIMIT 10`).all(pid,pid,pid);
 }
 // Navigation-confirmed opens are very weak supplemental hints, never likes.
 // Exclude anything with an explicit rating or comment; no cross-profile reads.
 // Do not introduce new event tracking, alter the open-history table, or export
 // article titles/comments to Google News. Only generated topic queries leave PC.
 function weakOpenSignals(pid){
  return db.prepare(`SELECT o.title,o.kind,MIN(o.open_days,3) AS open_days
   FROM ai_article_open_signals o
   WHERE o.profile_id=? AND o.last_opened_at>? AND TRIM(o.title)<>''
   AND NOT EXISTS (SELECT 1 FROM ai_item_feedback f
    WHERE f.profile_id=o.profile_id AND f.kind=o.kind AND f.item_id=o.item_id
    AND (f.rating<>0 OR TRIM(COALESCE(f.comment,''))<>''))
   ORDER BY o.last_opened_at DESC LIMIT 6`).all(pid,Date.now()-90*86400000);
 }
 // Keep E2's effective model identical to AI model settings: an absent row
 // means the default E4B QAT; an explicitly saved empty value means disabled.
 function effectiveModel(pid){
  const saved=db.prepare('SELECT model FROM ai_model_config WHERE profile_id=?').get(pid);
  return saved?saved.model:'gemma4:e4b-it-qat';
 }
 function start(pid){
  const cfg=db.prepare('SELECT terms_json,updated_at FROM ai_interest_lists WHERE profile_id=?').get(pid);
  if(!cfg)throw Error('関心リストがありません');
  const terms=JSON.parse(cfg.terms_json),denied=getExclusions(pid);
  const model=effectiveModel(pid);
  const feedbackStamp=Number(db.prepare('SELECT MAX(updated_at) AS t FROM ai_item_feedback WHERE profile_id=?').get(pid)?.t)||0;
  if(!Array.isArray(terms)||!terms.length)throw Error('関心リストを登録してください');
  if(jobs.get(pid)?.state==='running')return {started:false,running:true};
  const opts=settings(pid);
  const rotation=topicSelection(pid,terms,opts.topicCount);
  const selected=rotation.selected,reserves=reserveSizes(opts);
  if(!selected.length)throw Error('有効な関心語がありません');
  const job={state:'running',stage:'planning',completed:0,total:selected.length,error:'',startedAt:Date.now(),exclusionMode:'none',publishedCount:0,firstPublishedMs:0};jobs.set(pid,job);
  setImmediate(async()=>{
   const e2Perf={phase:'planning',samples:[]};
   if(typeof semantic.enterE2PerfScope==='function')semantic.enterE2PerfScope(e2Perf);
   try{
    const known=db.prepare(`SELECT a.url,a.title FROM articles a JOIN profile_feeds pf
     ON pf.feed_id=a.feed_id AND pf.profile_id=? ORDER BY a.published DESC LIMIT 5000`).all(pid);
    const knownUrls=new Set(known.map(x=>keyOf(x.url))),knownTitles=new Set(known.map(x=>cleanTitle(x.title)));
    const registered=db.prepare(`SELECT f.url,f.site_url FROM feeds f JOIN profile_feeds pf
     ON pf.feed_id=f.id AND pf.profile_id=?`).all(pid);
    const registeredHosts=new Set(registered.flatMap(r=>[siteHost(r.url),siteHost(r.site_url)]).filter(Boolean));
    const collected=[];
    const failures=[];
    const cacheStats={screenHits:0,screenMisses:0,exclusionHits:0,exclusionMisses:0};
    try{cachePurge.run(pid,Date.now()-E2_CACHE_TTL)}catch{}
    // Keep all verdicts tied to the exact model/prompt revision. In particular
    // a positive 'opened' event never enters the search-screening cache key.
    async function screenWithCache({topic,candidates,explicitInterests=[]}){
     const ctx=digest([E2_CACHE_VERSION,'search',model,topic,explicitInterests]);
     const stored=new Map(),misses=[];
     for(const x of candidates){
      const hit=readCached(pid,'screen',ctx,x);
      if(hit){stored.set(String(x.id),{id:String(x.id),relation:hit.relation,why:hit.why});cacheStats.screenHits++}
      else{misses.push(x);cacheStats.screenMisses++}
     }
     if(misses.length){
      // Same existing classifier; same 6-item maximum and uncertain handling.
      const checked=await semantic.screenExternalSearch({model,topic,candidates:misses,explicitInterests});
      for(const x of checked.items||[]){
       const row=misses.find(v=>String(v.id)===String(x.id));
       if(!row||!['direct','adjacent','unrelated','uncertain'].includes(x.relation)||typeof x.why!=='string')continue;
       stored.set(String(x.id),x);
       saveCached(pid,'screen',ctx,row,{relation:x.relation,why:x.why});
      }
     }
     const items=candidates.map(x=>stored.get(String(x.id))).filter(Boolean);
     return {items,unavailable:candidates.length-items.length};
    }
    async function excludeWithCache(candidates,onProgress){
     const ctx=digest([E2_CACHE_VERSION,'exclude',model,denied.terms]);
     const misses=[],alreadyRejected=new Set();
     for(const x of candidates){
      const hit=readCached(pid,'exclude',ctx,x);
      if(hit){cacheStats.exclusionHits++;if(hit.excluded)alreadyRejected.add(String(x.id))}
      else{cacheStats.exclusionMisses++;misses.push(x)}
     }
     let acceptedNew=[];
     if(misses.length){
      const result=await semantic.filterExcluded({model,exclusions:denied.terms,candidates:misses,
       onProgress:p=>onProgress({completed:cacheStats.exclusionHits+p.completed,total:candidates.length})});
      const good=new Set(result.items.map(x=>String(x.id)));
      // Commit only after a successful complete batch sequence; existing
      // fallback behavior remains unchanged if the model throws.
      for(const x of misses){saveCached(pid,'exclude',ctx,x,{excluded:!good.has(String(x.id))})}
      acceptedNew=result.items;
     }else onProgress({completed:candidates.length,total:candidates.length});
     const permitted=new Set(acceptedNew.map(x=>String(x.id)));
     const missesIds=new Set(misses.map(x=>String(x.id)));
     return {items:candidates.filter(x=>!alreadyRejected.has(String(x.id))&&
      (!missesIds.has(String(x.id))||permitted.has(String(x.id)))&&
      !titleMatchesExclusion(x.title,denied.terms)),mode:'semantic'};
    }
    // Fix51: query-level provenance only. Counts distinguish a quiet 7-day
    // search from later quality/cap filtering; never change which items pass.
    const queryAudit=[],queryResults=[];
    const timings={};
    // Fix103D: known explicit-interest searches can run during LOCAL topic
    // planning. Fetches are queued serially by lane and preserved in their
    // original deterministic order; no Ollama requests are parallelized.
    let initialQueryCount=Number.MAX_SAFE_INTEGER;
    const directQueries=selected.map(term=>({term,lane:0,bridge:''}));
    const directStart=Date.now();
    // Settle errors immediately; prevent an unhandled rejection while the
    // local model is still planning other topics.
    const directPrefetch=fetchBatch(directQueries,0).then(
      ()=>({ok:true}),error=>({ok:false,error}));
    // Retain only a small, local rotation history; it prevents repetition,
    // never treats an enjoyable subject as an inferred user preference.
    const previous=db.prepare('SELECT stats_json FROM ai_external_quality_runs WHERE profile_id=?').get(pid);
    let recentTopics=[];
    try{const stats=JSON.parse(previous?.stats_json||'{}');
     recentTopics=[...new Set([...(Array.isArray(stats.recentDiscoveryTopics)?stats.recentDiscoveryTopics:[]),
       ...(Array.isArray(stats.discoveryTopics)?stats.discoveryTopics:[]).map(x=>x.topic)]
       .filter(x=>typeof x==='string'&&x.trim()))].slice(-12);
    }catch{}
    // Fix103T: optional standby topics are planned with the *existing* Ollama call.
    // They are NOT searched unless a primary discovery query yields almost no usable RSS items.
    let discoveryTopics=[],discoveryStandby=[],discoveryWarning='';
    if(model){
     try{
      const planned=await semantic.planDiscovery({model,interests:terms,exclusions:denied.terms,recentTopics,standbyCount:2});
      discoveryTopics=planned.slice(0,5);discoveryStandby=planned.slice(5,7);
     }catch(e){
      // Search the explicit-interest queries even if the local topic planner fails.
      discoveryWarning='未知探索テーマを生成できませんでした：'+String(e.message||e).slice(0,95);
     }
    }else discoveryWarning='モデル未設定のため未知テーマ探索は未実施です';
    const discoveryQueries=discoveryTopics.map(x=>({term:x.topic,lane:1,bridge:x.bridge||''}));
    // Discovery RSS I/O starts as soon as the direct lane completes,
    // independently of the ensuing inferred-topic LLM planning.
    const discoveryPrefetch=directPrefetch.then(async state=>{
     if(!state.ok)return state;
     try{await fetchBatch(discoveryQueries,selected.length);return {ok:true,finishedAt:Date.now()}}
     catch(error){return {ok:false,error,finishedAt:Date.now()}}
    });
    // This is a USER-INITIATED remote search. The local model sees positive
    // feedback and generates general TOPICS; article feedback text itself never
    // appears in the outbound RSS URL. Failure does not prevent normal searches.
    let inferenceTopics=[],inferenceWarning='';
    if(model&&feedbackStamp){
     try{inferenceTopics=await semantic.planInferenceQueries({model,interests:terms,
       exclusions:denied.terms,feedback:positiveFeedback(pid),weakOpens:weakOpenSignals(pid)});
     }catch(e){inferenceWarning='嗜好探索テーマを生成できませんでした：'+String(e.message||e).slice(0,95)}
    }
    const already=new Set([...selected,...discoveryTopics.map(x=>x.topic)].map(x=>String(x).normalize('NFKC').toLocaleLowerCase()));
    inferenceTopics=inferenceTopics.filter(x=>{const key=x.topic.normalize('NFKC').toLocaleLowerCase();
     if(already.has(key))return false;already.add(key);return true}).slice(0,4);
    const inferenceQueries=inferenceTopics.map(x=>({term:x.topic,lane:2,bridge:''}));
    const queries=[...directQueries,...discoveryQueries,...inferenceQueries];
    initialQueryCount=queries.length;
    timings.planningMs=Date.now()-job.startedAt;
    // Common audited fetch path for initial queries and ONE optional sparse
    // rescue round. This never fetches from arbitrary URLs: fetchXml itself
    // verifies the hard-coded Google News RSS endpoint.
    async function fetchQuery({term,lane,bridge},queryIndex){
     const trace={topic:String(term).slice(0,80),lane:lane===1?'discovery':lane===2?'inferred_search':'direct',
      rssItems:0,considered:0,collected:0,skippedRegisteredHost:0,
      skippedKnownOrInvalid:0,qualityApproved:0,semanticInspected:0,semanticDirect:0,semanticAdjacent:0,semanticUnrelated:0,semanticUncertain:0,semanticUnavailable:0,semanticNotInspected:0,semanticExamples:[],cacheSelected:0,
      afterExclusion:0,stored:0,requestFailed:false,rescue:queryIndex>=initialQueryCount};
     queryAudit[queryIndex]=trace;
     // Keep each query's articles private until the full I/O round completes.
     // Completion order must not change deduplication or publisher limits.
     const rows=[];const started=Date.now();
     try{
      let feed=null,publishers=null;
      const variants=discoveryQueryVariants(term,lane);
      for(const searchedTerm of variants){
       const query=new URL('https://news.google.com/rss/search');
       query.searchParams.set('q',searchedTerm+' when:7d');
       query.searchParams.set('hl','ja');query.searchParams.set('gl','JP');query.searchParams.set('ceid','JP:ja');
       const xml=await fetchXml(query.toString());
       feed=parseFeed(xml,query.toString());publishers=publisherOf(xml);
       trace.searchedTerm=searchedTerm;
       trace.shortenedSearch=searchedTerm!==term;
       if(feed.items.length)break;
      }
      trace.rssItems=feed.items.length;
      trace.considered=Math.min(feed.items.length,MAX_PER_TERM);
      for(const [index,item] of feed.items.slice(0,MAX_PER_TERM).entries()){
       const publisher=publishers[index]||{};
       if(publisher.host&&registeredHosts.has(publisher.host)){trace.skippedRegisteredHost++;continue}
       const url=keyOf(item.url),title=String(item.title||'').slice(0,350),titleKey=cleanTitle(title);
       if(!url||!/^https:\/\//i.test(url)||!titleKey||knownUrls.has(url)){
        trace.skippedKnownOrInvalid++;continue;
       }
       const date=publisher.published||0;
       rows.push({id:createHash('sha256').update(url).digest('hex').slice(0,32),title,
        excerpt:String(item.excerpt||'').slice(0,360),url,
        source:publisher.name?publisher.name+'（Googleニュース経由）':'Googleニュース（出典未確認）',thumbnail:String(item.thumbnail||'').slice(0,900),
        published:date,queryLabel:term,sourceHost:publisher.host,discoveryLane:lane===1,inferenceLane:lane===2,discoveryBridge:bridge,
        _queryAuditIndex:queryIndex});
       trace.collected++;
      }
     }catch(e){trace.requestFailed=true;failures.push(String(e?.message||e).slice(0,120))}
     finally{
      queryResults[queryIndex]=rows;
      trace.fetchElapsedMs=Date.now()-started;
      job.completed++;
     }
    }
    // No more than 3 concurrent network requests, and zero concurrent Ollama
    // requests. Never alter source/topic order based on response speed.
    async function fetchBatch(batch,beginIndex){
     for(let at=0;at<batch.length;at+=RSS_FETCH_CONCURRENCY){
      const slice=batch.slice(at,at+RSS_FETCH_CONCURRENCY);
      await Promise.all(slice.map((q,i)=>fetchQuery(q,beginIndex+at+i)));
     }
     for(let i=beginIndex;i<beginIndex+batch.length;i++)collected.push(...(queryResults[i]||[]));
    }
    job.stage='fetching';job.total=initialQueryCount;
    // rssFetchMs is residual fetch time AFTER planning, and excludes work
    // already overlapped by the direct/discovery prefetch. It is not total
    // RSS network work (see rssPrefetchElapsedMs).
    const rssStarted=Date.now();
    const prefetchResult=await discoveryPrefetch;
    if(!prefetchResult.ok)throw prefetchResult.error;
    timings.rssPrefetchElapsedMs=(prefetchResult.finishedAt||Date.now())-directStart;
    await fetchBatch(inferenceQueries,selected.length+discoveryQueries.length);
    timings.rssFetchMs=Date.now()-rssStarted;
    // Fix103T: recover lost *search opportunities* only; do not rank article
    // attractiveness, enforce equal topic shares, or fill an E2 article quota.
    // A primary discovery search with 0/1 usable RSS rows lost its opportunity
    // BEFORE meaning scoring. Only then search up to two reserved, distinct topics.
    // No second model call or extra network traffic if the initial topics worked.
    const firstDiscoveryAudit=queryAudit.slice(selected.length,selected.length+discoveryQueries.length);
    const sparseDiscovery=firstDiscoveryAudit.filter(x=>x&&!x.requestFailed&&x.collected<2);
    const standbyUsed=[];
    if(discoveryStandby.length&&sparseDiscovery.length){
     const used=new Set([...queries].map(q=>String(q.term||'').normalize('NFKC').trim().toLocaleLowerCase()));
     const backups=[];
     for(const t of discoveryStandby){
      if(backups.length>=Math.min(2,sparseDiscovery.length))break;
      const key=String(t.topic||'').normalize('NFKC').trim().toLocaleLowerCase();
      if(!key||used.has(key))continue;
      used.add(key);backups.push({term:t.topic,lane:1,bridge:t.bridge||''});standbyUsed.push(t.topic);
      discoveryTopics.push(t);
     }
     if(backups.length){
      const begin=initialQueryCount;
      // These queries belong to the initial audited retrieval, not the later
      // AI-driven rescue. Reserve their indices first to preserve provenance.
      initialQueryCount+=backups.length;
      queries.push(...backups);
      await fetchBatch(backups,begin);
     }
    }
    timings.discoveryStandby={mode:'rss_opportunity_only',minimumUsableRows:2,
     primaryQueries:discoveryQueries.length,plannedStandby:discoveryStandby.length,
     sparsePrimary:sparseDiscovery.map(x=>({topic:x.topic,collected:x.collected,rssItems:x.rssItems})),
     usedTopics:standbyUsed};
    if(!collected.length&&failures.length)throw Error('外部RSS取得失敗：'+failures[0]);
    // Structural, explainable quality gate; never infer trust from a TLD/country.
    // Suspicious/undated/duplicate items are not presented as recommendations.
    // Apply one global quality/near-duplicate/source gate, then reserve a modest
    // fraction of its approved candidates for discovery. Without this, recent
    // direct-match searches can crowd every novel topic out of a 40-item cache.
    // Review all bounded per-query results before the three lane reserves.
    // Otherwise early direct/discovery queries could push late inference queries
    // beyond the old global limit before semantic review.
    const qualityStarted=Date.now();
    const gated=quality.qualityGate(collected,{knownTitles:known.map(r=>r.title),limit:Math.max(opts.maxItems+64,collected.length)});
    // Collapse clear same-event cross-publisher headlines BEFORE semantic
    // screening and first publication, never delete anything already visible.
    const reportCollapse=collapseRepeatedReports(gated.items);
    gated.items=reportCollapse.items;
    gated.stats.reportRepeatsCollapsed=reportCollapse.suppressed;
    gated.stats.reportDuplicateMode='conservative_title_only_before_preview';
    timings.qualityGateMs=Date.now()-qualityStarted;
    const semanticStarted=Date.now();
    e2Perf.phase='semantic';
    for(const x of gated.items)queryAudit[x._queryAuditIndex].qualityApproved++;
    // Fix103N: nothing is published before the complete global RSS quality gate.
    // Semantic decisions are processed per topic in a balanced sequence so one
    // early topic/lane cannot monopolize the first visible batch.
    const semanticWarnings=[];
    const passedIds=new Set();
    const ready=new Map(),previewRejected=new Set(),published=[],publishedIds=new Set();
    const publication={runStamp:Math.max(Date.now(),job.startedAt+1),started:false,batches:0};
    const laneOf=x=>x.discoveryLane?'discovery':x.inferenceLane?'inference':'direct';
    const insertArticle=db.prepare(`INSERT INTO ai_external_articles
     (profile_id,id,title,excerpt,url,source,published,thumbnail,query_label,collected_at,interest_updated_at,exclusion_mode,exclusion_updated_at,publisher_host,quality_score,quality_notes,discovery_lane,discovery_bridge,inference_lane,display_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    function insertVisible(x,order){
     insertArticle.run(pid,x.id,x.title,x.excerpt,x.url,x.source,x.published,x.thumbnail,x.queryLabel,publication.runStamp,cfg.updated_at,job.exclusionMode,denied.updatedAt,
      x.sourceHost,x.qualityScore,x.qualityNotes,x.discoveryLane?1:0,String(x.discoveryBridge||'').slice(0,100),x.inferenceLane?1:0,order);
    }
    function streamOrder(candidates,allowOverflow=false){
     const current={direct:0,inference:0,discovery:0};
     for(const x of published)current[laneOf(x)]++;
     const capacities={direct:reserves.direct,inference:reserves.inference,discovery:reserves.discovery};
     const queues={direct:[],inference:[],discovery:[]};
     for(const lane of Object.keys(queues)){
      const eligible=candidates.filter(x=>laneOf(x)===lane&&!publishedIds.has(x.id)&&!previewRejected.has(x.id));
      queues[lane]=roundRobinQueries(eligible);
     }
     const output=[];
     const used={...current};
     let moving=true;
     while(moving&&published.length+output.length<opts.maxItems){
      moving=false;
      for(const lane of ['direct','discovery','inference']){
       if(!queues[lane].length||(!allowOverflow&&used[lane]>=capacities[lane]))continue;
       output.push(queues[lane].shift());used[lane]++;moving=true;
       if(published.length+output.length>=opts.maxItems)break;
      }
     }
     return output;
    }
    // Publish full, validated batches. Keep 20-item E2 requests atomic;
    // at larger settings first public batch is 25, then normally 20+.
    async function publishReady(force=false){
     if(published.length>=opts.maxItems)return;
     if(!force&&opts.maxItems<=25)return;
     if(!force&&publication.started&&opts.maxItems-published.length<20)return;
     let choices=streamOrder([...ready.values()],force);
     const normalThreshold=publication.started?Math.min(20,opts.maxItems-published.length):Math.min(25,opts.maxItems);
     // Safety valve for unusually slow screens: a 50+-article run may start
     // with 15 verified articles after 60s, rather than withholding them.
     const slowStart=!publication.started&&opts.maxItems>=50&&
      Date.now()-job.startedAt>=60_000&&choices.length<25;
     const threshold=slowStart?15:normalThreshold;
     if(!force&&choices.length<threshold)return;
     // Do not spend minutes excluding the entire final pool just to show 25.
     // At most one small extra group is checked for potential semantic vetoes.
     choices=choices.slice(0,Math.min(choices.length,threshold+8));
     // Only fully screened candidate articles can enter this exclusion phase.
     if(denied.terms.length&&choices.length){
      choices=choices.filter(x=>!titleMatchesExclusion(x.title,denied.terms));
      if(model&&choices.length){
       const previousStage=job.stage,previousDone=job.completed,previousTotal=job.total;
       job.stage='excluding_preview';
       try{
        const result=await excludeWithCache(choices,()=>{});
        const valid=new Set(result.items.map(x=>x.id));
        for(const x of choices)if(!valid.has(x.id))previewRejected.add(x.id);
        choices=result.items;
        job.exclusionMode='semantic';
       }catch(e){
        // Do not reveal unverified exclusions. Final legacy fallback will
        // handle failures consistently with the previous E2 behavior.
        semanticWarnings.push('先行公開の除外判定を完了できませんでした: '+String(e.message||e).slice(0,80));
        return;
       }finally{job.stage=previousStage;job.completed=previousDone;job.total=previousTotal}
      }else if(!model)job.exclusionMode='literal';
     }
     if(!force&&choices.length<threshold)return;
     const additions=choices.slice(0,force?opts.maxItems-published.length:threshold);
     if(!additions.length)return;
     // Interest/exclusion edits midway must never publish stale results.
     if(Number(db.prepare('SELECT updated_at FROM ai_interest_lists WHERE profile_id=?').get(pid)?.updated_at)!==Number(cfg.updated_at)
      ||getExclusions(pid).updatedAt!==denied.updatedAt
      ||(effectiveModel(pid))!==model
      ||settings(pid).updatedAt!==opts.updatedAt)throw Error('探索中に設定が変更されたため先行公開を中止しました');
     db.exec('BEGIN');
     try{
      if(!publication.started)db.prepare('DELETE FROM ai_external_articles WHERE profile_id=?').run(pid);
      for(let j=0;j<additions.length;j++)insertVisible(additions[j],published.length+j+1);
      db.exec('COMMIT');
     }catch(e){db.exec('ROLLBACK');throw e}
     for(const x of additions){published.push(x);publishedIds.add(x.id)}
     publication.started=true;publication.batches++;
     job.publishedCount=published.length;
     if(!job.firstPublishedMs){job.firstPublishedMs=Date.now()-job.startedAt;job.firstPublishedCount=additions.length}
    }
    function registerReady(x){if(!passedIds.has(x.id))return;ready.set(x.id,x)}
    const semanticTasks={direct:[],inference:[],discovery:[]};
    const groups=new Map();
    for(const row of gated.items){
     const qi=row._queryAuditIndex;
     if(!groups.has(qi))groups.set(qi,[]);
     groups.get(qi).push(row);
    }
    for(const [qi,rows] of groups){
     const audit=queryAudit[qi],lane=audit.lane==='direct'?'direct':audit.lane==='discovery'?'discovery':'inference';
     // Only direct interests can pass on an uncertain response. Other lanes
     // retain the exact fixed 16-per-query meaning-screen limit.
     const samples=lane==='direct'?rows:rows.slice(0,MAX_SEMANTIC_PER_TOPIC);
     if(lane!=='direct')audit.semanticNotInspected+=Math.max(0,rows.length-samples.length);
     for(let at=0;at<samples.length;at+=6)semanticTasks[lane].push({qi,rows:samples.slice(at,at+6),lane});
    }
    // Small caps get broad topic coverage before later batches of one topic.
    // 96+ article searches retain the original Fix103P work schedule exactly.
    const smallRunBudgetEnabled=opts.maxItems<=48&&Boolean(model)&&typeof semantic.screenExternalSearch==='function';
    if(smallRunBudgetEnabled)for(const lane of ['direct','discovery','inference'])
     semanticTasks[lane]=interleaveTopicTasks(semanticTasks[lane]);
    // Alternating lanes is a presentation-readiness strategy, not a change to
    // the AI meaning checker or its accept/reject semantics.
    const tasks=[];
    while(Object.values(semanticTasks).some(arr=>arr.length))
     for(const lane of ['direct','discovery','inference'])if(semanticTasks[lane].length)tasks.push(semanticTasks[lane].shift());
    job.stage='screening';job.completed=0;job.total=tasks.length;
    const touchedQueries=new Set();
    let earlyStopped=false,processedTasks=0;
    for(let taskIndex=0;taskIndex<tasks.length;taskIndex++){
     const task=tasks[taskIndex];
     const {qi,rows:batch,lane}=task,audit=queryAudit[qi];
     processedTasks++;
     touchedQueries.add(qi);
     if(!model||typeof semantic.screenExternalSearch!=='function'){
      audit.semanticUnavailable+=batch.length;
      if(lane==='direct')for(const x of batch){passedIds.add(x.id);registerReady(x)}
      else semanticWarnings.push(audit.topic+': local search checker unavailable');
      job.completed++;await publishReady();continue;
     }
     try{
      const checked=await screenWithCache({topic:audit.topic,candidates:batch,
       ...(lane==='direct'?{explicitInterests:selected}:{})});
      const byId=new Map((checked.items||[]).map(x=>[String(x.id),x]));
      for(const x of batch){
       const decision=byId.get(String(x.id));
       if(!decision){audit.semanticUnavailable++;if(lane==='direct'){passedIds.add(x.id);registerReady(x)}continue}
       audit.semanticInspected++;
       if(decision.relation==='direct'){audit.semanticDirect++;passedIds.add(x.id);registerReady(x)}
       else if(decision.relation==='adjacent'){audit.semanticAdjacent++;passedIds.add(x.id);registerReady(x)}
       else if(decision.relation==='unrelated'){
        audit.semanticUnrelated++;
        if(audit.semanticExamples.length<5)audit.semanticExamples.push({relation:'unrelated',title:String(x.title||'').slice(0,160),why:String(decision.why||'').slice(0,120)});
       }else{
        audit.semanticUncertain++;
        if(lane==='direct'){passedIds.add(x.id);registerReady(x)}
        else if(audit.semanticExamples.length<5)audit.semanticExamples.push({relation:'uncertain',title:String(x.title||'').slice(0,160),why:String(decision.why||'').slice(0,120)});
       }
      }
      if(checked.unavailable)semanticWarnings.push(audit.topic+': incomplete model response');
     }catch(e){
      audit.semanticUnavailable+=batch.length;
      if(lane==='direct')for(const x of batch){passedIds.add(x.id);registerReady(x)}
      semanticWarnings.push(audit.topic+': '+String(e.message||e).slice(0,95));
     }
     job.completed++;
     await publishReady();
     if(smallRunBudgetEnabled&&smallRunPoolSufficient({
      maxItems:opts.maxItems,reserves,audits:queryAudit,
      remainingTasks:tasks.slice(taskIndex+1),ready,previewRejected,touched:touchedQueries
     })){
      earlyStopped=taskIndex+1<tasks.length;
      if(earlyStopped)break;
     }
    }
    const deferredTasks=earlyStopped?tasks.slice(processedTasks):[];
    for(const task of deferredTasks){
     const q=queryAudit[task.qi];
     q.semanticNotInspected+=task.rows.length;
     q.semanticBudgetDeferred=(q.semanticBudgetDeferred||0)+task.rows.length;
    }
    timings.semanticBudget={enabled:smallRunBudgetEnabled,stoppedEarly:earlyStopped,
     processedTasks,totalTasks:tasks.length,deferredTasks:deferredTasks.length,
     deferredItems:deferredTasks.reduce((n,t)=>n+t.rows.length,0),
     readyCount:[...ready.values()].filter(x=>!previewRejected.has(x.id)).length,
     // With a small cap, keeping an excess verified pool compensates for later
     // exclusions; it cannot guarantee every run reaches the configured cap.
     safetyBuffer:Math.max(8,Math.ceil(opts.maxItems/4))};
    timings.semanticMs=Date.now()-semanticStarted;
    const rescueStarted=Date.now();
    e2Perf.phase='rescue';
    // Fix102G: One bounded rescue for sparse 20%/10% retrieval. A weak
    // search is diagnosed by verified semantic hits (<2), NOT by a quota
    // of recommendations. Ambiguous/unavailable semantic responses do not
    // trigger this retry and never become 20%/10% verified candidates.
    const weak=lane=>queryAudit.filter(q=>q.lane===lane&&!q.requestFailed&&
      q.semanticUnavailable===0&&(q.semanticDirect+q.semanticAdjacent)<2);
    // A fully covered and sufficiently large verified pool need not trigger
    // extra topic planning in a deliberately small run. Deferred queries are
    // not mistaken for failed or sparse searches.
    const weak20=earlyStopped?[]:weak('inferred_search');
    const weak10=earlyStopped?[]:weak('discovery');
    const rescueAudit={mode:earlyStopped?'not_needed_small_run_sufficient_pool':'one_bounded_replan_only_if_sparse',triggerVerifiedBelow:2,
      initialQueryCount,initialSparseInferred:weak20.map(x=>({topic:x.topic,rssItems:x.rssItems,verified:x.semanticDirect+x.semanticAdjacent})),
      initialSparseDiscovery:weak10.map(x=>({topic:x.topic,rssItems:x.rssItems,verified:x.semanticDirect+x.semanticAdjacent})),
      attempted:{inferred_search:0,discovery:0},planned:[],approved:0,verified:0,
      warnings:[],attemptedOnce:!earlyStopped,skippedForSmallRunPool:earlyStopped};
    const usedTopics=new Set(queries.map(q=>String(q.term).normalize('NFKC').toLocaleLowerCase()));
    const extra=[];
    const offer=(topic,lane,bridge)=>{
     const key=String(topic||'').normalize('NFKC').toLocaleLowerCase();
     if(!key||usedTopics.has(key))return false;
     usedTopics.add(key);extra.push({term:topic,lane,bridge});return true;
    };
    if(model&&weak20.length&&typeof semantic.planInferenceQueries==='function'){
     try{
      const proposed=await semantic.planInferenceQueries({model,interests:terms,exclusions:denied.terms,
       feedback:positiveFeedback(pid),weakOpens:weakOpenSignals(pid),avoidTopics:inferenceTopics.map(x=>x.topic)});
      let count=0;
      for(const t of proposed||[]){if(count>=2)break;if(offer(t.topic,2,'')){
       inferenceTopics.push(t);count++;
      }}
     }catch(e){rescueAudit.warnings.push('inference replan: '+String(e.message||e).slice(0,90))}
    }
    if(model&&weak10.length&&typeof semantic.planDiscovery==='function'){
     try{
      const proposed=await semantic.planDiscovery({model,interests:terms,exclusions:denied.terms,
       recentTopics:[...recentTopics,...discoveryTopics.map(x=>x.topic)].slice(-16)});
      let count=0;
      for(const t of proposed||[]){if(count>=3)break;if(offer(t.topic,1,t.bridge||'')){
       discoveryTopics.push(t);count++;
      }}
     }catch(e){rescueAudit.warnings.push('discovery replan: '+String(e.message||e).slice(0,90))}
    }
    // The model is free to return zero topics. Never invent a genre or
    // query solely to fill an E2 count.
    if(extra.length){
     job.stage='recovering';job.completed=0;job.total=extra.length;
     const prevLength=collected.length;
     for(const q of extra){
      queries.push(q);
      rescueAudit.attempted[q.lane===1?'discovery':'inferred_search']++;
      rescueAudit.planned.push({topic:q.term,lane:q.lane===1?'discovery':'inferred_search'});
     }
     await fetchBatch(extra,initialQueryCount);
     const rescueCollected=collected.slice(prevLength);
     if(rescueCollected.length){
      const rescueGated=quality.qualityGate(rescueCollected,{
       knownTitles:[...known.map(r=>r.title),...gated.items.map(x=>x.title)],
       limit:Math.max(opts.maxItems+64,rescueCollected.length)});
      gated.stats.rescueQualityInspected=Number(rescueGated.stats.inspected)||rescueCollected.length;
      gated.stats.inspected=(Number(gated.stats.inspected)||0)+(Number(rescueGated.stats.inspected)||rescueCollected.length);
      // The initial and rescue quality gates run separately to preserve
      // already-verified initial candidates. Enforce the original GLOBAL
      // source cap and article identity across both phases as well.
      const sourceCounts=new Map(),knownIds=new Set();
      for(const row of gated.items){
       sourceCounts.set(row.sourceHost,(sourceCounts.get(row.sourceHost)||0)+1);
       knownIds.add(row.id);
      }
      const rescueApproved=[];
      for(const row of rescueGated.items){
       if(knownIds.has(row.id)||(sourceCounts.get(row.sourceHost)||0)>=6)continue;
       // Rescue candidates must not reintroduce an already-screened event.
       if([...gated.items,...rescueApproved].some(x=>repeatAcrossRows(x,row))){
        gated.stats.reportRepeatsCollapsed++;continue;
       }
       knownIds.add(row.id);
       sourceCounts.set(row.sourceHost,(sourceCounts.get(row.sourceHost)||0)+1);
       rescueApproved.push(row);
      }
      rescueAudit.sourceCapOrIdentitySkipped=rescueGated.items.length-rescueApproved.length;
      for(const row of rescueApproved)queryAudit[row._queryAuditIndex].qualityApproved++;
      const grouped=new Map();
      for(const row of rescueApproved){
       const qi=row._queryAuditIndex;
       if(!grouped.has(qi))grouped.set(qi,[]);
       grouped.get(qi).push(row);
      }
      for(const [qi,group] of grouped){
       const audit=queryAudit[qi],samples=group.slice(0,MAX_SEMANTIC_PER_TOPIC);
       audit.semanticNotInspected+=Math.max(0,group.length-samples.length);
       for(let at=0;at<samples.length;at+=6){
        const part=samples.slice(at,at+6);
        if(!model||typeof semantic.screenExternalSearch!=='function'){
         audit.semanticUnavailable+=part.length;continue;
        }
        try{
         const checked=await screenWithCache({topic:audit.topic,candidates:part});
         const byId=new Map((checked.items||[]).map(x=>[x.id,x]));
         for(const row of part){
          const res=byId.get(row.id);
          if(!res){audit.semanticUnavailable++;continue}
          audit.semanticInspected++;
          if(res.relation==='direct'){audit.semanticDirect++;passedIds.add(row.id);rescueAudit.verified++}
          else if(res.relation==='adjacent'){audit.semanticAdjacent++;passedIds.add(row.id);rescueAudit.verified++}
          else if(res.relation==='unrelated'){
           audit.semanticUnrelated++;
           if(audit.semanticExamples.length<5)audit.semanticExamples.push({relation:'unrelated',title:String(row.title||'').slice(0,160),why:String(res.why||'').slice(0,120)});
          }else{
           audit.semanticUncertain++;
           if(audit.semanticExamples.length<5)audit.semanticExamples.push({relation:'uncertain',title:String(row.title||'').slice(0,160),why:String(res.why||'').slice(0,120)});
          }
         }
         if(checked.unavailable)semanticWarnings.push(audit.topic+': incomplete rescue check');
        }catch(e){
         audit.semanticUnavailable+=part.length;
         semanticWarnings.push(audit.topic+': rescue check failed: '+String(e.message||e).slice(0,95));
        }
       }
      }
      gated.items.push(...rescueApproved);
      for(const x of rescueApproved)registerReady(x);
      await publishReady();
      rescueAudit.approved=rescueApproved.length;
     }
    }
    timings.rescueMs=Date.now()-rescueStarted;
    gated.stats.sparseRescue=rescueAudit;
    gated.stats.searchSemanticAudit={mode:'direct_negative_veto_plus_20_10_positive_screen',maxPerTopic:MAX_SEMANTIC_PER_TOPIC,
     directSearchChecked:queryAudit.filter(x=>x.lane==='direct').reduce((sum,q)=>sum+q.semanticInspected,0),
     directSearchUnrelatedVeto:queryAudit.filter(x=>x.lane==='direct').reduce((sum,q)=>sum+q.semanticUnrelated,0),
     directSearchUnavailable:queryAudit.filter(x=>x.lane==='direct').reduce((sum,q)=>sum+q.semanticUnavailable,0),
     inferredDiscoveryCheckMode:'fail_closed_on_uncertain_or_unavailable',
     trialMaxPerInferredDiscoveryTopic:MAX_SEMANTIC_PER_TOPIC,trialScreenBatchMax:6,
     warnings:semanticWarnings.slice(0,12),
     examined:queryAudit.reduce((sum,q)=>sum+q.semanticInspected,0),
     direct:queryAudit.reduce((sum,q)=>sum+q.semanticDirect,0),
     adjacent:queryAudit.reduce((sum,q)=>sum+q.semanticAdjacent,0),
     unrelated:queryAudit.reduce((sum,q)=>sum+q.semanticUnrelated,0),
     uncertain:queryAudit.reduce((sum,q)=>sum+q.semanticUncertain,0),
     unavailable:queryAudit.reduce((sum,q)=>sum+q.semanticUnavailable,0)};
    gated.items=gated.items.filter(x=>passedIds.has(x.id));
    const selectedItems=[...published],selectedKeys=new Set(publishedIds);
    const pick=x=>{if(selectedItems.length<opts.maxItems&&!selectedKeys.has(x.id)){
      selectedKeys.add(x.id);selectedItems.push(x)}};
    // E2 storage is intentionally discovery/inference-rich. E4 still
    // independently checks all items and role-locks 70 > 20 > 10.
    // Protect up to 28 valid direct-interest E2 candidates BEFORE the
    // expanded exploratory lanes. Other free slots remain fully shared.
    roundRobinQueries(gated.items.filter(x=>!x.discoveryLane&&!x.inferenceLane)).slice(0,reserves.direct).forEach(pick);
    roundRobinQueries(gated.items.filter(x=>x.discoveryLane)).slice(0,reserves.discovery).forEach(pick);
    roundRobinQueries(gated.items.filter(x=>x.inferenceLane&&!x.discoveryLane)).slice(0,reserves.inference).forEach(pick);
    gated.items.filter(x=>!x.discoveryLane&&!x.inferenceLane).forEach(pick);
    gated.items.forEach(pick);
    gated.items=selectedItems;
    // Fix103N: previously presented items are never removed or rearranged.
    for(const x of selectedItems)queryAudit[x._queryAuditIndex].cacheSelected++;
    gated.stats.accepted=selectedItems.length;
    gated.stats.sourceMixTrial={mode:'candidate_supply_only',cacheMax:opts.maxItems,
     discoveryReserveMax:reserves.discovery,inferredReserveMax:reserves.inference,directProtect:reserves.direct,perTopicSemanticMax:MAX_SEMANTIC_PER_TOPIC,perTopicFetchMax:MAX_PER_TERM,
     note:'Not a forced registered/external recommendation allocation.'};
    // Fix82: no additional Bing searches. RSS candidate collection stays unchanged.
    job.stage='quality';job.completed=gated.stats.inspected;job.total=gated.stats.inspected;
    // Exclude explicit topics before any candidate becomes visible.
    // With a configured local model, apply contextual semantic vetoes, including
    // paraphrases; otherwise use transparent direct title phrase matching only.
    let accepted=gated.items;
    let fallbackNotice='';
    const exclusionStarted=Date.now();
    e2Perf.phase='exclusion';
    if(denied.terms.length){
     accepted=accepted.filter(x=>!titleMatchesExclusion(x.title,denied.terms));
     if(model&&accepted.length){
      job.stage='excluding';job.completed=0;job.total=accepted.length;
      try{
       const result=await excludeWithCache(accepted,p=>{job.completed=p.completed;job.total=p.total});
       accepted=result.items;job.exclusionMode='semantic';
      }catch(e){
       // The quality gate has already completed. Preserve that useful result
       // but NEVER mislabel a failed semantic veto as AI-verified.
       // These are unscored candidates, not recommendations.
       job.exclusionMode='literal_fallback';
       fallbackNotice='AI除外が完了しませんでした。直接一致のみを除外（意味判定は未確認）：'+String(e.message||e).slice(0,100);
      }
     }else job.exclusionMode='literal';
    }
    // If preview-excluded articles were AI rejected, the same cached decision
    // is reused here. Already visible items stay in their original positions.
    const acceptedIdSet=new Set(accepted.map(x=>x.id));
    for(const x of published)if(!acceptedIdSet.has(x.id)){accepted.push(x);acceptedIdSet.add(x.id)}
    accepted.sort((a,b)=>{const i=published.findIndex(x=>x.id===a.id),j=published.findIndex(x=>x.id===b.id);return i>=0&&j>=0?i-j:i>=0?-1:j>=0?1:0});
    // Fix103P: earlier visible rows are immutable. The remainder used to
    // inherit reserve-group order (direct -> discovery -> inference), which
    // could clump topics in the final append. Reuse the already-tested
    // per-lane and per-query round robin *only for not-yet-visible rows*.
    // Do not change selection, meaning checks, exclusions or stored counts.
    const finalVisible=accepted.filter(x=>publishedIds.has(x.id));
    const finalPending=accepted.filter(x=>!publishedIds.has(x.id));
    const wovenPending=streamOrder(finalPending,true);
    const wovenIds=new Set(wovenPending.map(x=>x.id));
    const safePending=wovenPending.length===finalPending.length&&wovenIds.size===finalPending.length&&
     finalPending.every(x=>wovenIds.has(x.id))?wovenPending:finalPending;
    accepted=[...finalVisible,...safePending];
    for(const x of accepted)queryAudit[x._queryAuditIndex].afterExclusion++;
    gated.stats.excluded=gated.items.length-accepted.length;
    gated.stats.accepted=accepted.length;
    gated.stats.queryAudit=queryAudit;
    gated.stats.discoveryCount=accepted.filter(x=>x.discoveryLane).length;
    gated.stats.inferenceSearchCount=accepted.filter(x=>x.inferenceLane).length;
    gated.stats.inferenceSearchTopics=inferenceTopics.map(x=>x.topic);
    gated.stats.inferenceHypotheses=inferenceTopics.map(x=>({topic:x.topic,basis:String(x.basis||'').slice(0,100)}));
    gated.stats.inferenceWarning=inferenceWarning;
    gated.stats.discoveryTopics=discoveryTopics.map(x=>({topic:x.topic,bridge:x.bridge,approach:x.approach}));
    gated.stats.directTopics=selected;gated.stats.e2Settings={...opts,reserves};
    gated.stats.recentDiscoveryTopics=[...recentTopics,...discoveryTopics.map(x=>x.topic)].slice(-12);
    gated.stats.discoveryWarning=discoveryWarning;
    gated.stats.queryFailures=failures.length;
    timings.exclusionMs=Date.now()-exclusionStarted;
    timings.totalMs=Date.now()-job.startedAt;
    timings.reportRepeatsCollapsed=gated.stats.reportRepeatsCollapsed;
    gated.stats.stageTimings={...timings,rssConcurrency:RSS_FETCH_CONCURRENCY,
     rssQueryCount:queryAudit.length,failedQueries:failures.length,
     cache:{...cacheStats,ttlHours:E2_CACHE_TTL/3600000},
     ...(typeof semantic.summarizeE2Perf==='function'?{ollama:semantic.summarizeE2Perf(e2Perf)}:{})};
    gated.stats.elapsedMs=timings.totalMs;
    gated.stats.streamPreview={firstPublishedMs:job.firstPublishedMs,firstPublishedCount:job.firstPublishedCount||0,batches:publication.batches,earlyPublished:published.length,initialBatchTarget:Math.min(25,opts.maxItems)};
    // Interest, exclusion or model edits must not install stale results.
    // Feedback written while reading the first batch must NOT abort the run: it
    // is a new signal for the next search, not a change to this search's plan.
    if(Number(db.prepare('SELECT updated_at FROM ai_interest_lists WHERE profile_id=?').get(pid)?.updated_at)!==Number(cfg.updated_at)
      ||getExclusions(pid).updatedAt!==denied.updatedAt
      ||(effectiveModel(pid))!==model
      ||settings(pid).updatedAt!==opts.updatedAt){
     throw Error('探索中に関心・除外・モデル設定が変更されたため結果を破棄しました');
    }
    const now=Date.now();
    db.exec('BEGIN');
    try{
     db.prepare('DELETE FROM ai_external_articles WHERE profile_id=?').run(pid);
     const insert=db.prepare(`INSERT INTO ai_external_articles
      (profile_id,id,title,excerpt,url,source,published,thumbnail,query_label,collected_at,interest_updated_at,exclusion_mode,exclusion_updated_at,publisher_host,quality_score,quality_notes,discovery_lane,discovery_bridge,inference_lane,display_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
     for(const [index,i] of accepted.entries()){
      insert.run(pid,i.id,i.title,i.excerpt,i.url,i.source,i.published,i.thumbnail,i.queryLabel,now,cfg.updated_at,job.exclusionMode,denied.updatedAt,
       i.sourceHost,i.qualityScore,i.qualityNotes,i.discoveryLane?1:0,String(i.discoveryBridge||'').slice(0,100),i.inferenceLane?1:0,index+1);
      queryAudit[i._queryAuditIndex].stored++;
     }
     db.prepare(`INSERT INTO ai_external_quality_runs
       (profile_id,collected_at,interest_updated_at,exclusion_updated_at,stats_json)
       VALUES(?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET
       collected_at=excluded.collected_at,interest_updated_at=excluded.interest_updated_at,
       exclusion_updated_at=excluded.exclusion_updated_at,stats_json=excluded.stats_json`)
       .run(pid,now,cfg.updated_at,denied.updatedAt,JSON.stringify(gated.stats));
     // Advance the interest cycle only if this search was successfully committed.
     db.prepare(`INSERT INTO ai_e2_topic_rotation(profile_id,topics_hash,remaining_json,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET topics_hash=excluded.topics_hash,
      remaining_json=excluded.remaining_json,updated_at=excluded.updated_at`)
      .run(pid,rotation.topicsHash,JSON.stringify(rotation.remaining),now);
     db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e}
    if(failures.length)job.error=`一部の検索に失敗しました（${failures.length}/${queries.length}件）`;
    if(fallbackNotice)job.error=(job.error?job.error+'。':'')+fallbackNotice;
    if(semanticWarnings.length)job.error=(job.error?job.error+'。':'')+'一部の登録外検索記事で意味照合が完了しませんでした（'+semanticWarnings.length+'件）';
   }catch(e){job.error=String(e.message||e).slice(0,180)}
   finally{job.state='done';job.finishedAt=Date.now()}
  });
  return {started:true,running:true};
 }
 return {status,start,updateSettings};
}
async function fetchNewsXml(url){
 // Hard-code provider hostname and path; never fetch a user-provided remote URL.
 const parsed=new URL(url);
 if(parsed.protocol!=='https:'||parsed.hostname!=='news.google.com'||parsed.pathname!=='/rss/search'||parsed.port||parsed.username||parsed.password)throw Error('許可されていない外部情報源です');
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(12000),headers:{'Accept':'application/rss+xml, application/xml;q=0.8','User-Agent':'Nestrill-Next/0.2 (personal RSS reader)'}});
 if(!response.ok)throw Error('外部RSS HTTP '+response.status);
 const declared=Number(response.headers.get('content-length')||0);
 if(declared>MAX_BYTES)throw Error('外部RSSのサイズ制限を超えました');
 const reader=response.body.getReader(),chunks=[];let n=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;n+=value.byteLength;if(n>MAX_BYTES){await reader.cancel();throw Error('外部RSSのサイズ制限を超えました')}chunks.push(Buffer.from(value))}}
 finally{reader.releaseLock()}
 return Buffer.concat(chunks).toString('utf8');
}
module.exports={create,fetchNewsXml};
