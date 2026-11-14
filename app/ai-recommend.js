'use strict';
const semantic=require('./ai-semantic');
const {titleMatchesExclusion}=require('./ai-exclusion');
const {inspect:inspectInputEvidence}=require('./ai-input-evidence');
const blendModule=require('./ai-blend');
// Phase D1: offline keyword candidate preview. NOT semantic AI / 7:2:1 allocation.
function create({db}) {
 db.exec(`CREATE TABLE IF NOT EXISTS ai_interest_lists (
   profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
   terms_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ai_interest_lists_scoped (
   profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
   scope TEXT NOT NULL CHECK(scope IN ('youtube','shared')),
   terms_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
   PRIMARY KEY(profile_id,scope));
 CREATE TABLE IF NOT EXISTS ai_exclusion_lists (
   profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
   terms_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ai_candidate_cache (
   profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
   kind TEXT NOT NULL CHECK(kind IN ('rss','youtube')),
   items_json TEXT NOT NULL DEFAULT '[]', generated_at INTEGER NOT NULL,
   interest_updated_at INTEGER NOT NULL,
   PRIMARY KEY(profile_id,kind));
 CREATE TABLE IF NOT EXISTS ai_item_feedback (
   profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
   kind TEXT NOT NULL CHECK(kind IN ('rss','youtube')),
   item_id TEXT NOT NULL,
   rating INTEGER NOT NULL CHECK(rating IN (-1,0,1)),
   comment TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
   PRIMARY KEY(profile_id,kind,item_id));
 CREATE INDEX IF NOT EXISTS idx_ai_feedback_profile ON ai_item_feedback(profile_id,kind);
 CREATE TABLE IF NOT EXISTS ai_external_feedback_meta (
   profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
   item_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
   excerpt TEXT NOT NULL DEFAULT '',
   PRIMARY KEY(profile_id,item_id));
 CREATE TABLE IF NOT EXISTS ai_model_config (
   profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
   model TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ai_source_mix (
   profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
   explicit_registered INTEGER NOT NULL DEFAULT 40 CHECK(explicit_registered BETWEEN 0 AND 100),
   inferred_registered INTEGER NOT NULL DEFAULT 40 CHECK(inferred_registered BETWEEN 0 AND 100),
   discovery_registered INTEGER NOT NULL DEFAULT 20 CHECK(discovery_registered BETWEEN 0 AND 100),
   updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ai_semantic_cache (
   profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
   kind TEXT NOT NULL CHECK(kind IN ('rss','youtube')),
   model TEXT NOT NULL,items_json TEXT NOT NULL,generated_at INTEGER NOT NULL,
   interest_updated_at INTEGER NOT NULL,feedback_updated_at INTEGER NOT NULL,
   PRIMARY KEY(profile_id,kind));`);
 // Additive migration: keep every pre-Fix61 rating/comment and every profile row.
 if(!db.prepare('PRAGMA table_info(ai_external_feedback_meta)').all().some(c=>c.name==='excerpt'))
  db.exec("ALTER TABLE ai_external_feedback_meta ADD COLUMN excerpt TEXT NOT NULL DEFAULT ''");
 const running=new Set(),failures=new Map(),jobs=new Map();let semanticBusy=false;
 function jobStatus(key){
  const x=jobs.get(key);
  return x?{...x,elapsedMs:Math.max(0,(x.finishedAt||Date.now())-x.startedAt)}:null;
 }
 function updateJob(key,p){
  const x=jobs.get(key);if(!x||x.status!=='running')return;
  x.completed=Math.max(x.completed,Math.min(p.total,Number(p.completed)||0));
  x.total=Number(p.total)||0;x.stage=p.stage||'evaluating';
 }
 const validKind=k=>k==='rss'||k==='youtube';
 // Original ai_interest_lists is never migrated or rewritten: it remains RSS-only.
 // Shared terms are applied to both effective lists without duplicating stored data.
 function interestsScoped(pid,scope){
  if(!['rss','youtube','shared'].includes(scope))throw Error('関心リストの対象が不正です');
  const row=scope==='rss'
   ?db.prepare('SELECT terms_json,updated_at FROM ai_interest_lists WHERE profile_id=?').get(pid)
   :db.prepare('SELECT terms_json,updated_at FROM ai_interest_lists_scoped WHERE profile_id=? AND scope=?').get(pid,scope);
  return {scope,terms:row?JSON.parse(row.terms_json):[],updatedAt:row?.updated_at||0};
 }
 function interests(pid,kind='rss'){
  if(!['rss','youtube'].includes(kind))throw Error('関心リストの対象が不正です');
  const own=interestsScoped(pid,kind),common=interestsScoped(pid,'shared');
  const seen=new Set(),terms=[];
  for(const t of [...own.terms,...common.terms]){
   const key=String(t).normalize('NFKC').toLocaleLowerCase();
   if(!seen.has(key)){seen.add(key);terms.push(t)}
  }
  return {terms,updatedAt:Math.max(own.updatedAt,common.updatedAt)};
 }
 function exclusions(pid){
  const row=db.prepare('SELECT terms_json,updated_at FROM ai_exclusion_lists WHERE profile_id=?').get(pid);
  return {terms:row?JSON.parse(row.terms_json):[],updatedAt:row?.updated_at||0};
 }
 function isLiteralExcluded(item,terms){return titleMatchesExclusion(item.title,terms)}
 function putExclusions(pid,input){
  const terms=normalize(input),stamp=Date.now();
  db.prepare(`INSERT INTO ai_exclusion_lists(profile_id,terms_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(profile_id) DO UPDATE SET terms_json=excluded.terms_json,updated_at=excluded.updated_at`).run(pid,JSON.stringify(terms),stamp);
  // Never reuse a ranked list or external search from before a veto changed.
  db.prepare('DELETE FROM ai_candidate_cache WHERE profile_id=?').run(pid);
  db.prepare('DELETE FROM ai_semantic_cache WHERE profile_id=?').run(pid);
  db.prepare('DELETE FROM ai_external_articles WHERE profile_id=?').run(pid);
  failures.delete(pid+':rss');failures.delete(pid+':youtube');
  return {terms,updatedAt:stamp};
 }
 function normalize(input){
  if(typeof input!=='string'||input.length>8000)throw Error('関心・除外リストは8000文字以内で入力してください');
  const seen=new Set(),terms=[];
  for(const v of input.split(/[\r\n,、，]+/u)){
   const term=v.trim().replace(/\s+/g,' ');
   if(!term)continue;
   if(term.length>80||/[\x00-\x1f\x7f]/.test(term))throw Error('各項目は1件80文字以内で入力してください');
   const key=term.toLocaleLowerCase();if(!seen.has(key)){seen.add(key);terms.push(term)}
  }
  if(terms.length>100)throw Error('各リストは100件まで登録できます');
  return terms;
 }
 function putInterests(pid,input,scope='rss'){
  if(!['rss','youtube','shared'].includes(scope))throw Error('関心リストの対象が不正です');
  const terms=normalize(input);
  // Keep effective lists within the existing Gemma 100-term input budget.
  const shared=scope==='shared'?terms:interestsScoped(pid,'shared').terms;
  for(const kind of ['rss','youtube']){
   const owned=scope===kind?terms:interestsScoped(pid,kind).terms;
   const unique=new Set([...owned,...shared].map(t=>String(t).normalize('NFKC').toLocaleLowerCase()));
   if(unique.size>100)throw Error(kind+' と共通の関心語は、重複を除いて合計100件以内にしてください');
  }
  // Distinct timestamps even when two tabs are saved within the same millisecond:
  // effective cache versions are the max of their contributing lists.
  const latest=Math.max(...['rss','youtube','shared'].map(s=>interestsScoped(pid,s).updatedAt));
  const stamp=Math.max(Date.now(),latest+1);
  if(scope==='rss')db.prepare(`INSERT INTO ai_interest_lists(profile_id,terms_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(profile_id) DO UPDATE SET terms_json=excluded.terms_json,updated_at=excluded.updated_at`).run(pid,JSON.stringify(terms),stamp);
  else db.prepare(`INSERT INTO ai_interest_lists_scoped(profile_id,scope,terms_json,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(profile_id,scope) DO UPDATE SET terms_json=excluded.terms_json,updated_at=excluded.updated_at`).run(pid,scope,JSON.stringify(terms),stamp);
  const kinds=scope==='shared'?['rss','youtube']:[scope];
  for(const kind of kinds){
   db.prepare('DELETE FROM ai_candidate_cache WHERE profile_id=? AND kind=?').run(pid,kind);
   db.prepare('DELETE FROM ai_semantic_cache WHERE profile_id=? AND kind=?').run(pid,kind);
   failures.delete(pid+':'+kind);
  }
  return {scope,terms,updatedAt:stamp};
 }
 function rows(pid,kind){
  if(kind==='rss')return db.prepare(`SELECT a.id,a.title,a.excerpt,a.url,a.published,
   a.feed_id AS feedId,a.thumbnail AS thumbnail,
   COALESCE(NULLIF(pf.display_title,''),f.title) AS source
   FROM articles a JOIN profile_feeds pf ON pf.feed_id=a.feed_id AND pf.profile_id=?
   JOIN feeds f ON f.id=a.feed_id ORDER BY a.published DESC,a.id DESC LIMIT 1200`).all(pid);
  // This join ensures secret and other profiles cannot see unregistered channels.
  return db.prepare(`SELECT v.video_id AS id,v.title,v.excerpt,v.url,v.published,
   MAX(v.thumbnail) AS thumbnail,
   MAX(COALESCE(NULLIF(s.custom_title,''),s.title)) AS source
   FROM youtube_videos_local v
   JOIN youtube_subscriptions_local s ON s.channel_id=v.channel_id
   JOIN source_accounts sa ON sa.id=s.account_id AND sa.profile_id=? AND sa.service='youtube'
   GROUP BY v.video_id ORDER BY v.published DESC LIMIT 1000`).all(pid);
 }
 function generate(pid,kind){
  const config=interests(pid,kind),denied=exclusions(pid),terms=config.terms.map(x=>[x,x.toLocaleLowerCase()]);
  if(!terms.length)return {items:[],interestUpdatedAt:config.updatedAt,excludedUpdatedAt:denied.updatedAt};
  const out=[],keys=new Set();
  for(const r of (sourceFilter&&kind==='rss'?sourceFilter(pid,rows(pid,kind)):rows(pid,kind))){
   if(isLiteralExcluded(r,denied.terms))continue;
   const title=String(r.title||'').toLocaleLowerCase(),excerpt=String(r.excerpt||'').toLocaleLowerCase();
   const matches=terms.filter(([,t])=>title.includes(t)||excerpt.includes(t));
   if(!matches.length)continue;
   const url=String(r.url||'');if(!/^https?:\/\//i.test(url))continue;
   const key=url;if(keys.has(key))continue;keys.add(key);
   const score=matches.reduce((n,[,t])=>n+(title.includes(t)?2:0)+(excerpt.includes(t)?1:0),0);
   out.push({id:String(r.id),title:String(r.title||''),excerpt:String(r.excerpt||'').slice(0,500),
    url:String(r.url||''),source:String(r.source||''),published:Number(r.published)||0,
    ...(kind==='rss'?{feedId:Number(r.feedId)||0}:{}),thumbnail:String(r.thumbnail||''),
    matched:matches.map(([t])=>t),score});
  }
  out.sort((a,b)=>b.score-a.score||b.published-a.published);
  return {items:out.slice(0,30),interestUpdatedAt:config.updatedAt,excludedUpdatedAt:denied.updatedAt};
 }
 function modelConfig(pid){
  const r=db.prepare('SELECT model,updated_at FROM ai_model_config WHERE profile_id=?').get(pid);
  // The default applies only when no choice has been saved for this profile.
  // A saved empty string remains an explicit 'do not use AI' choice.
  return r?{model:r.model,updatedAt:r.updated_at||0}:{model:'gemma4:e4b-it-qat',updatedAt:0};
 }
 async function setModel(pid,value){
  if(typeof value!=='string'||value.length>120)throw Error('モデル名が不正です');
  if(value){const available=await semantic.models();if(!available.includes(value))throw Error('Ollamaに存在しないモデルです')}
  const stamp=Date.now();
  db.prepare(`INSERT INTO ai_model_config(profile_id,model,updated_at) VALUES(?,?,?)
   ON CONFLICT(profile_id) DO UPDATE SET model=excluded.model,updated_at=excluded.updated_at`).run(pid,value,stamp);
  db.prepare('DELETE FROM ai_semantic_cache WHERE profile_id=?').run(pid);
  return {model:value,updatedAt:stamp};
 }
 // E4: source-mix now guides RSS blend allocation; D3 preview remains independent.
 const SOURCE_MIX_DEFAULT=Object.freeze({explicit:40,inferred:40,discovery:20});
 function sourceMix(pid){
  const row=db.prepare('SELECT explicit_registered,inferred_registered,discovery_registered,updated_at FROM ai_source_mix WHERE profile_id=?').get(pid);
  return {ratios:row?{
    explicit:row.explicit_registered,inferred:row.inferred_registered,discovery:row.discovery_registered
   }:{...SOURCE_MIX_DEFAULT},updatedAt:row?.updated_at||0,applied:false};
 }
 function putSourceMix(pid,data){
  if(!data||typeof data!=='object'||Array.isArray(data)||!data.ratios||typeof data.ratios!=='object'||Array.isArray(data.ratios))throw Error('情報源の配分形式が不正です');
  const v=data.ratios,keys=['explicit','inferred','discovery'];
  if(Object.keys(v).length!==3||!keys.every(k=>Object.prototype.hasOwnProperty.call(v,k)&&Number.isInteger(v[k])&&v[k]>=0&&v[k]<=100&&v[k]%10===0))throw Error('登録済みの割合は0～100%、10%刻みで指定してください');
  const stamp=Date.now();
  db.prepare(`INSERT INTO ai_source_mix(profile_id,explicit_registered,inferred_registered,discovery_registered,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET
    explicit_registered=excluded.explicit_registered,inferred_registered=excluded.inferred_registered,
    discovery_registered=excluded.discovery_registered,updated_at=excluded.updated_at`)
    .run(pid,v.explicit,v.inferred,v.discovery,stamp);
  return sourceMix(pid);
 }
 function feedbackStamp(pid,kind='rss'){
  // Weak opens are consumed on the next explicit generation; they must NOT invalidate
  // a displayed recommendation cache merely because the user reads an article.
  return Number(db.prepare('SELECT MAX(updated_at) AS value FROM ai_item_feedback WHERE profile_id=? AND kind=?').get(pid,kind)?.value)||0;
 }
 function feedbackEvidence(pid,kind='rss'){
  const out=[];
  const rss=db.prepare(`SELECT 'rss' AS kind,a.title,COALESCE(a.excerpt,'') AS excerpt,af.rating,af.comment,af.updated_at
    FROM ai_item_feedback af JOIN articles a ON af.kind='rss' AND CAST(a.id AS TEXT)=af.item_id
    JOIN profile_feeds pf ON pf.feed_id=a.feed_id AND pf.profile_id=af.profile_id
    WHERE af.profile_id=? ORDER BY af.updated_at DESC LIMIT 24`).all(pid);
  // Keep explicit feedback for external discoveries even after the next RSS
  // search replaces the short-lived external candidate cache.
  // Legacy feedback had no excerpt. Recover from the current in-profile
  // search cache only if exact URL, title and canonical x: ID all agree.
  // Do not guess missing excerpts or join a different profile's content.
  const ext=db.prepare(`SELECT 'rss' AS kind,m.title,
    COALESCE(NULLIF(m.excerpt,''),(
      SELECT a.excerpt FROM ai_external_articles a
      WHERE a.profile_id=m.profile_id AND ('x:'||a.id)=m.item_id
      AND a.title=m.title AND a.url=m.url LIMIT 1),'') AS excerpt,
    af.rating,af.comment,af.updated_at
    FROM ai_item_feedback af JOIN ai_external_feedback_meta m
    ON m.profile_id=af.profile_id AND m.item_id=af.item_id
    WHERE af.profile_id=? AND af.kind='rss'
    ORDER BY af.updated_at DESC LIMIT 24`).all(pid);
  const yt=db.prepare(`SELECT 'youtube' AS kind,MAX(v.title) AS title,COALESCE(MAX(v.excerpt),'') AS excerpt,af.rating,af.comment,af.updated_at
    FROM ai_item_feedback af JOIN youtube_videos_local v ON af.kind='youtube' AND v.video_id=af.item_id
    JOIN youtube_subscriptions_local s ON s.channel_id=v.channel_id
    JOIN source_accounts sa ON sa.id=s.account_id AND sa.profile_id=af.profile_id AND sa.service='youtube'
    WHERE af.profile_id=? GROUP BY af.item_id ORDER BY af.updated_at DESC LIMIT 24`).all(pid);
  const source=kind==='youtube'?yt:[...rss,...ext];
  for(const r of source.sort((a,b)=>b.updated_at-a.updated_at).slice(0,24)){
   const weight=semantic.evidenceWeight(r.updated_at);
   if(weight>=.03)out.push({kind:r.kind,title:r.title,excerpt:String(r.excerpt||'').slice(0,180),rating:r.rating,comment:r.comment,weight});
  }
  // Opened links are weak curiosity signals, not approval. Explicit feedback stays first.
  const openRows=(openSignals?.evidence(pid)||[]).filter(r=>r.kind===kind);
  const recentOpen=openRows.filter(r=>!out.some(e=>e.title===r.title&&e.kind===r.kind)).slice(0,4).map(r=>({
   kind:r.kind,title:r.title,rating:0,comment:'',signal:'opened',weight:Number((0.03*semantic.evidenceWeight(r.updated_at)).toFixed(4))}));
  return [...out.slice(0,18),...recentOpen];
 }
 function candidatePool(pid,kind,{forBlend=false}={}){
  // Two discovery lanes: D1's literal matches AND recent articles without the term.
  // E4 only: broaden the *retrieval* window, not the number sent to the LLM.
  // A match here is a sampling hint, never an inferred-preference judgment.
  // No curated term expansion or hard-coded semantic synonym lists.
  const terms=interests(pid,kind).terms.map(x=>String(x).normalize('NFKC').toLocaleLowerCase());
  const denied=exclusions(pid).terms;
  const all=(sourceFilter&&kind==='rss'?sourceFilter(pid,rows(pid,kind)):rows(pid,kind)).filter(x=>/^https?:\/\//i.test(String(x.url||''))&&!isLiteralExcluded(x,denied));
  const matching=[],other=[],seen=new Set();
  for(const r of all){
   const id=String(r.id);
   // Retrieval should not treat a related-story footer or navigation-only
   // placeholder as interest evidence when Gemma receives neither as content.
   const view=inspectInputEvidence({title:r.title,excerpt:r.excerpt,source:r.source});
   const text=(view.title+' '+view.excerpt).normalize('NFKC').toLocaleLowerCase();
   if(seen.has(id))continue;seen.add(id);
   const item={id,title:String(r.title||''),excerpt:String(r.excerpt||''),url:String(r.url),source:String(r.source||''),published:Number(r.published)||0,
    thumbnail:String(r.thumbnail||''),...(kind==='rss'?{feedId:Number(r.feedId)||0}:{})};
   if(forBlend){item.retrievalLane=terms.some(t=>text.includes(t))?'direct':'other';}
   (terms.some(t=>text.includes(t))?matching:other).push(item);
  }
  // D3 uses its unchanged 36 candidates; E4 can look further back within 21
  // days before selecting the same 26 registered LLM evaluation slots.
  return forBlend?[...matching.slice(0,65),...other.slice(0,55)]:
   [...matching.slice(0,20),...other.slice(0,16)].slice(0,36);
 }
 async function generateSemantic(pid,kind,onProgress){
  const interest=interests(pid,kind),denied=exclusions(pid),config=modelConfig(pid),fbStamp=feedbackStamp(pid,kind);
  const candidates=candidatePool(pid,kind);
  const ranked=await semantic.score({model:config.model,interests:interest.terms,
   evidence:feedbackEvidence(pid,kind),exclusions:denied.terms,candidates,onProgress});
  const ratingById=new Map(ranked.map(x=>[x.id,x]));
  const ordered=candidates.filter(x=>ratingById.has(x.id)&&!ratingById.get(x.id).excluded
   &&!isLiteralExcluded(x,denied.terms)&&ratingById.get(x.id).score>=40).map(x=>({
   ...x,matched:[],semanticScore:ratingById.get(x.id).score,
   semanticReason:ratingById.get(x.id).reason,score:ratingById.get(x.id).score
  })).sort((a,b)=>b.semanticScore-a.semanticScore||b.published-a.published).slice(0,30);
  // Reject changed interests, new feedback, or changed model before touching the cache.
  if(interests(pid,kind).updatedAt!==interest.updatedAt||exclusions(pid).updatedAt!==denied.updatedAt||modelConfig(pid).model!==config.model||
     modelConfig(pid).updatedAt!==config.updatedAt||feedbackStamp(pid,kind)!==fbStamp)return false;
  db.prepare(`INSERT INTO ai_semantic_cache(profile_id,kind,model,items_json,generated_at,interest_updated_at,feedback_updated_at)
   VALUES(?,?,?,?,?,?,?) ON CONFLICT(profile_id,kind) DO UPDATE SET
   model=excluded.model,items_json=excluded.items_json,generated_at=excluded.generated_at,
   interest_updated_at=excluded.interest_updated_at,feedback_updated_at=excluded.feedback_updated_at`)
   .run(pid,kind,config.model,JSON.stringify(ordered),Date.now(),interest.updatedAt,fbStamp);
  return true;
 }
 function start(pid,kind){
  if(!validKind(kind))throw Error('種別が不正です');
  const key=pid+':'+kind;
  if(running.has(key))return {started:false,running:true};
  const model=modelConfig(pid).model;
  if(model&&semanticBusy){failures.set(key,'別のAI評価を実行中です。完了後に再度お試しください');return {started:false,running:false}}
  if(model)semanticBusy=true;
  running.add(key);failures.delete(key);
  jobs.set(key,{status:'running',stage:'preparing',completed:0,total:0,startedAt:Date.now(),finishedAt:0});
  setImmediate(async()=>{
   let completed=false;
   try{
    if(model){completed=await generateSemantic(pid,kind,progress=>updateJob(key,progress))===true}
    else {
     const result=generate(pid,kind);
     if(interests(pid,kind).updatedAt===result.interestUpdatedAt&&exclusions(pid).updatedAt===result.excludedUpdatedAt){
      db.prepare(`INSERT INTO ai_candidate_cache(profile_id,kind,items_json,generated_at,interest_updated_at)
       VALUES(?,?,?,?,?) ON CONFLICT(profile_id,kind) DO UPDATE SET
       items_json=excluded.items_json,generated_at=excluded.generated_at,interest_updated_at=excluded.interest_updated_at`)
       .run(pid,kind,JSON.stringify(result.items),Date.now(),result.interestUpdatedAt);
      completed=true;
     }
    }
    if(!completed)failures.set(key,'処理中に関心リストまたは評価設定が変更されました。もう一度更新してください');
   }catch(e){failures.set(key,String(e.message).slice(0,180))}
   finally{
    const job=jobs.get(key);
    if(job){job.status=failures.has(key)?'error':'complete';job.stage=job.status;job.finishedAt=Date.now()}
    running.delete(key);if(model)semanticBusy=false;
   }
  });
  return {started:true,running:true};
 }
 // Upgrade only the presentation fields of pre-D1-UI01 cached results.
 // Metadata queries repeat the same profile joins as candidate selection: no cross-profile lookup.
 function withMedia(pid,kind,items){
  if(!items.some(it=>it.thumbnail===undefined||(kind==='rss'&&it.feedId===undefined)))return items;
  const ids=[...new Set(items.map(it=>String(it.id)))];if(!ids.length)return items;
  const marks=ids.map(()=>'?').join(',');let media=[];
  if(kind==='rss')media=db.prepare(`SELECT a.id,a.feed_id AS feedId,a.thumbnail
   FROM articles a JOIN profile_feeds pf ON pf.feed_id=a.feed_id AND pf.profile_id=?
   WHERE a.id IN (${marks})`).all(pid,...ids);
  else media=db.prepare(`SELECT v.video_id AS id,MAX(v.thumbnail) AS thumbnail
   FROM youtube_videos_local v JOIN youtube_subscriptions_local s ON s.channel_id=v.channel_id
   JOIN source_accounts sa ON sa.id=s.account_id AND sa.profile_id=? AND sa.service='youtube'
   WHERE v.video_id IN (${marks}) GROUP BY v.video_id`).all(pid,...ids);
  const lookup=new Map(media.map(m=>[String(m.id),m]));
  return items.map(it=>{const m=lookup.get(String(it.id));return {...it,
    ...(kind==='rss'?{feedId:Number(m?.feedId)||0}:{}),thumbnail:String(m?.thumbnail||'')};});
 }
 // Feedback is explicit user evidence for future AI-inferred recommendations.
 // It does not edit the interest list and does not pretend to perform semantic analysis.
 // Only accept feedback for current E2 candidates or saved E4 recommendations
 // belonging to this profile. Never trust browser-supplied title/URL.
 function externalFeedbackItem(pid,id){
  if(!/^x:[a-f0-9]{32}$/.test(id))return null;
  const row=db.prepare(`SELECT items_json,interest_stamp,exclusion_stamp,mix_stamp,model_stamp,external_stamp
    FROM ai_blend_cache WHERE profile_id=? AND kind='rss'`).get(pid);
  const external=externalStatus?.(pid);
  // First authorize any E2 candidate in the CURRENT, profile-scoped, quality-gated
  // external preview. Old/expired/deleted/excluded search results are not accepted.
  if(external?.qualityApplied && external.generatedAt>0 &&
     Date.now()-external.generatedAt<7*86400000){
   const candidate=external.items.find(x=>x&&'x:'+x.id===id);
   if(candidate&&typeof candidate.title==='string'&&/^https:\/\//i.test(candidate.url||''))
    return {title:candidate.title.slice(0,350),url:candidate.url.slice(0,2000),excerpt:String(candidate.excerpt||'').replace(/\s+/g,' ').trim().slice(0,180)};
  }
  // E4 recommendations may be available without an E2 preview; preserve Fix02.
  if(!row || row.interest_stamp!==interests(pid).updatedAt ||
     row.exclusion_stamp!==exclusions(pid).updatedAt ||
     row.mix_stamp!==sourceMix(pid).updatedAt ||
     row.model_stamp!==modelConfig(pid).updatedAt ||
     row.external_stamp!==(external?.generatedAt||0))return null;
  let items;try{items=JSON.parse(row.items_json)}catch{return null}
  if(!Array.isArray(items))return null;
  const item=items.find(x=>x&&x.id===id&&x.origin==='external');
  if(!item || typeof item.title!=='string' || !/^https:\/\//i.test(item.url||''))return null;
  return {title:item.title.slice(0,350),url:item.url.slice(0,2000),excerpt:String(item.excerpt||'').replace(/\s+/g,' ').trim().slice(0,180)};
 }
 function itemOwned(pid,kind,itemId){
  if(kind==='rss'){
   if(itemId.startsWith('x:'))return !!externalFeedbackItem(pid,itemId);
   if(!/^[1-9]\d{0,15}$/.test(itemId))return false;
   return !!db.prepare(`SELECT 1 FROM articles a JOIN profile_feeds pf
    ON pf.feed_id=a.feed_id AND pf.profile_id=? WHERE a.id=? LIMIT 1`).get(pid,Number(itemId));
  }
  return !!db.prepare(`SELECT 1 FROM youtube_videos_local v
   JOIN youtube_subscriptions_local s ON s.channel_id=v.channel_id
   JOIN source_accounts sa ON sa.id=s.account_id AND sa.profile_id=? AND sa.service='youtube'
   WHERE v.video_id=? LIMIT 1`).get(pid,itemId);
 }
 function putFeedback(pid,x){
  if(!x||!validKind(x.kind))throw Error('対象種別が不正です');
  const id=String(x.itemId??'');
  if(!id||id.length>100||/[\x00-\x1f\x7f]/.test(id))throw Error('対象IDが不正です');
  if(![-1,0,1].includes(x.rating))throw Error('評価は興味あり・興味なし・未評価から選択してください');
  if(typeof x.comment!=='string'||x.comment.length>500||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(x.comment))throw Error('感想は500文字以内で入力してください');
  const external=x.kind==='rss'&&id.startsWith('x:')?externalFeedbackItem(pid,id):null;
  if(!external&&!itemOwned(pid,x.kind,id))throw Error('このプロファイルの項目ではありません');
  const comment=x.comment.trim(),stamp=Date.now();
  // External titles are server-derived and retained to train future AI-inferred
  // recommendations after the ephemeral discovery candidate expires.
  db.exec('BEGIN');
  try{
   if(x.rating===0&&!comment){
    db.prepare('DELETE FROM ai_item_feedback WHERE profile_id=? AND kind=? AND item_id=?').run(pid,x.kind,id);
    if(external)db.prepare('DELETE FROM ai_external_feedback_meta WHERE profile_id=? AND item_id=?').run(pid,id);
   }else{
    if(external)db.prepare(`INSERT INTO ai_external_feedback_meta(profile_id,item_id,title,url,excerpt)
      VALUES(?,?,?,?,?) ON CONFLICT(profile_id,item_id) DO UPDATE SET
      title=excluded.title,url=excluded.url,
      excerpt=CASE WHEN excluded.excerpt<>'' THEN excluded.excerpt
       WHEN ai_external_feedback_meta.title=excluded.title AND ai_external_feedback_meta.url=excluded.url
       THEN ai_external_feedback_meta.excerpt ELSE '' END`)
      .run(pid,id,external.title,external.url,external.excerpt);
    db.prepare(`INSERT INTO ai_item_feedback(profile_id,kind,item_id,rating,comment,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(profile_id,kind,item_id) DO UPDATE SET
      rating=excluded.rating,comment=excluded.comment,updated_at=excluded.updated_at`)
      .run(pid,x.kind,id,x.rating,comment,stamp);
   }
   db.prepare('DELETE FROM ai_semantic_cache WHERE profile_id=?').run(pid);
   db.exec('COMMIT');
  }catch(err){db.exec('ROLLBACK');throw err}
  return {itemId:id,rating:x.rating,comment,updatedAt:x.rating===0&&!comment?0:stamp};
 }
 // UI06: regular RSS rating without touching saved comments.
 // Use existing authorization, upsert, and semantic-cache invalidation.
 function setFeedbackRating(pid,x){
  if(!x||x.kind!=='rss'||![-1,0,1].includes(x.rating))throw Error('評価の指定が不正です');
  const id=String(x.itemId??'');
  if(!/^[1-9]\d{0,15}$/.test(id)||!itemOwned(pid,'rss',id))throw Error('このプロファイルの記事ではありません');
  const previous=db.prepare('SELECT comment FROM ai_item_feedback WHERE profile_id=? AND kind=? AND item_id=?')
   .get(pid,'rss',id);
  return putFeedback(pid,{kind:'rss',itemId:id,rating:x.rating,comment:previous?.comment||''});
 }
 // Explicit feedback history is fetched only when the user expands the settings panel.
 // Titles are resolved *only* via profile-owned RSS/YouTube records or the
 // profile-scoped metadata preserved for external E2/E4 articles. Missing items
 // remain editable as feedback rows, but receive no unrelated title or URL.
 const historyTitleSQL=`CASE WHEN af.kind='rss' AND af.item_id LIKE 'x:%' THEN
    (SELECT m.title FROM ai_external_feedback_meta m WHERE m.profile_id=af.profile_id AND m.item_id=af.item_id)
   WHEN af.kind='rss' THEN
    (SELECT a.title FROM articles a JOIN profile_feeds pf ON pf.feed_id=a.feed_id AND pf.profile_id=af.profile_id
     WHERE CAST(a.id AS TEXT)=af.item_id LIMIT 1)
   ELSE
    (SELECT v.title FROM youtube_videos_local v
     JOIN youtube_subscriptions_local s ON s.channel_id=v.channel_id
     JOIN source_accounts sa ON sa.id=s.account_id AND sa.profile_id=af.profile_id AND sa.service='youtube'
     WHERE v.video_id=af.item_id LIMIT 1) END`;
 function feedbackHistory(pid,x={}){
  const q=String(x.q||'').trim().slice(0,100),filter=String(x.filter||'all');
  const kind=String(x.kind||'all'),page=Number(x.page??0);
  if(!['all','liked','disliked','comment'].includes(filter)||!['all','rss','youtube'].includes(kind) ||
     !Number.isSafeInteger(page)||page<0||page>1000)throw Error('履歴の表示条件が不正です');
  const terms=['af.profile_id=?'],args=[pid];
  if(kind!=='all'){terms.push('af.kind=?');args.push(kind)}
  if(filter==='liked')terms.push('af.rating=1');
  if(filter==='disliked')terms.push('af.rating=-1');
  if(filter==='comment')terms.push("length(trim(af.comment))>0");
  const titleExpr=`COALESCE((${historyTitleSQL}), '')`;
  // Escape LIKE wildcards so a search is literal (not a pattern).
  if(q){terms.push(`(LOWER(${titleExpr}) LIKE ? ESCAPE '\\' OR LOWER(af.comment) LIKE ? ESCAPE '\\')`);
   const like='%'+q.toLocaleLowerCase().replace(/[\\%_]/g,m=>'\\'+m)+'%';args.push(like,like)}
  const from=' FROM ai_item_feedback af WHERE '+terms.join(' AND ');
  const total=db.prepare('SELECT COUNT(*) AS total'+from).get(...args).total;
  const limit=30,offset=page*limit;
  const data=db.prepare(`SELECT af.kind,af.item_id AS itemId,af.rating,af.comment,af.updated_at AS updatedAt,
    ${titleExpr} AS title
    ${from} ORDER BY af.updated_at DESC,af.kind,af.item_id LIMIT ? OFFSET ?`).all(...args,limit,offset);
  return {items:data.map(r=>({...r,title:r.title||'（元の記事情報がありません）'})),total,page,limit};
 }
 // Editing from history requires an EXISTING feedback row under this profile.
 // In particular, expired external article caches cannot be used to create new
 // feedback or edit another profile's history through item IDs supplied by UI.
 function editFeedbackHistory(pid,x){
  if(!x||!validKind(x.kind))throw Error('対象種別が不正です');
  const id=String(x.itemId??'');
  if(!id||id.length>100||/[\x00-\x1f\x7f]/.test(id))throw Error('対象IDが不正です');
  if(![-1,0,1].includes(x.rating))throw Error('評価が不正です');
  if(typeof x.comment!=='string'||x.comment.length>500||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(x.comment))throw Error('感想は500文字以内で入力してください');
  const saved=db.prepare('SELECT 1 FROM ai_item_feedback WHERE profile_id=? AND kind=? AND item_id=?').get(pid,x.kind,id);
  if(!saved)throw Error('このプロファイルには該当する評価履歴がありません');
  const comment=x.comment.trim(),deleted=x.rating===0&&!comment,stamp=Date.now();
  db.exec('BEGIN');
  try{
   if(deleted){
    db.prepare('DELETE FROM ai_item_feedback WHERE profile_id=? AND kind=? AND item_id=?').run(pid,x.kind,id);
    if(x.kind==='rss'&&id.startsWith('x:'))
     db.prepare('DELETE FROM ai_external_feedback_meta WHERE profile_id=? AND item_id=?').run(pid,id);
   }else{
    db.prepare('UPDATE ai_item_feedback SET rating=?,comment=?,updated_at=? WHERE profile_id=? AND kind=? AND item_id=?')
     .run(x.rating,comment,stamp,pid,x.kind,id);
   }
   db.prepare('DELETE FROM ai_semantic_cache WHERE profile_id=?').run(pid);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  return {itemId:id,rating:x.rating,comment,updatedAt:deleted?0:stamp,deleted};
 }
 // Fix91A: delete only explicit RSS ratings/comments; never touch article/read/star data.
 function deleteFeedbackBulk(pid,x){
  if(!x||x.kind!=='rss'||!['selected','all'].includes(x.action))throw Error('削除対象はRSS評価履歴のみ指定できます');
  let keys=[];
  if(x.action==='selected'){
   if(!Array.isArray(x.itemIds)||!x.itemIds.length||x.itemIds.length>100)throw Error('選択件数が不正です（1～100件）');
   keys=[...new Set(x.itemIds.map(id=>String(id)))];
   if(keys.some(id=>!id||id.length>100||/[\x00-\x1f\x7f]/.test(id)))throw Error('評価IDが不正です');
  }else if(x.confirm!=='DELETE_ALL_RSS_FEEDBACK')throw Error('全件削除の確認が必要です');
  db.exec('BEGIN');
  try{
   let removed=0;
   if(x.action==='all'){
    removed=db.prepare("DELETE FROM ai_item_feedback WHERE profile_id=? AND kind='rss'").run(pid).changes;
    db.prepare("DELETE FROM ai_external_feedback_meta WHERE profile_id=? AND NOT EXISTS (SELECT 1 FROM ai_item_feedback f WHERE f.profile_id=ai_external_feedback_meta.profile_id AND f.kind='rss' AND f.item_id=ai_external_feedback_meta.item_id)").run(pid);
   }else{
    const check=db.prepare("SELECT 1 FROM ai_item_feedback WHERE profile_id=? AND kind='rss' AND item_id=?");
    const del=db.prepare("DELETE FROM ai_item_feedback WHERE profile_id=? AND kind='rss' AND item_id=?");
    const meta=db.prepare('DELETE FROM ai_external_feedback_meta WHERE profile_id=? AND item_id=?');
    for(const id of keys){if(!check.get(pid,id))throw Error('選択した評価が見つかりません。再読み込みしてください');}
    for(const id of keys){removed+=del.run(pid,id).changes;if(id.startsWith('x:'))meta.run(pid,id)}
   }
   if(removed){
    db.prepare("DELETE FROM ai_semantic_cache WHERE profile_id=? AND kind='rss'").run(pid);
    // 7:2:1 cached results may contain stale inferred rankings from deleted feedback.
    db.prepare("DELETE FROM ai_blend_cache WHERE profile_id=? AND kind='rss'").run(pid);
   }
   db.exec('COMMIT');return {ok:true,removed,kind:'rss'};
  }catch(e){db.exec('ROLLBACK');throw e}
 }
 function withFeedback(pid,kind,items){
  if(!items.length)return items;
  const ids=[...new Set(items.map(i=>String(i.id)))];
  const marks=ids.map(()=>'?').join(',');
  const records=db.prepare(`SELECT item_id,rating,comment,updated_at FROM ai_item_feedback
   WHERE profile_id=? AND kind=? AND item_id IN (${marks})`).all(pid,kind,...ids);
  const map=new Map(records.map(r=>[r.item_id,r]));
  return items.map(it=>{
   const r=map.get(String(it.id));
   return {...it,feedback:{rating:r?.rating||0,comment:r?.comment||'',updatedAt:r?.updated_at||0}};
  });
 }
 function getLegacy(pid,kind){
  if(!validKind(kind))throw Error('種別が不正です');
  const config=interests(pid,kind),key=pid+':'+kind,model=modelConfig(pid).model;
  const semanticRow=model?db.prepare('SELECT * FROM ai_semantic_cache WHERE profile_id=? AND kind=?').get(pid,kind):null;
  if(semanticRow&&semanticRow.model===model&&semanticRow.interest_updated_at===config.updatedAt&&
     semanticRow.feedback_updated_at===feedbackStamp(pid,kind)){
   return {kind,phase:'semantic-preview',ratioApplied:false,model,
    items:withFeedback(pid,kind,JSON.parse(semanticRow.items_json).filter(x=>!isLiteralExcluded(x,exclusions(pid).terms))),generatedAt:semanticRow.generated_at,
    running:running.has(key),job:jobStatus(key),error:failures.get(key)||'',hasInterests:config.terms.length>0};
  }
  const row=db.prepare('SELECT items_json,generated_at,interest_updated_at FROM ai_candidate_cache WHERE profile_id=? AND kind=?').get(pid,kind);
  const valid=!!row&&row.interest_updated_at===config.updatedAt;
  return {kind,phase:'keyword-preview',ratioApplied:false,model:model||'none',
   items:valid?withFeedback(pid,kind,withMedia(pid,kind,JSON.parse(row.items_json).filter(x=>!isLiteralExcluded(x,exclusions(pid).terms)))):[],generatedAt:valid?row.generated_at:0,
   running:running.has(key),job:jobStatus(key),error:failures.get(key)||'',hasInterests:config.terms.length>0};
 }
 let ruleOutputFilter=null;
 function attachOutputFilter(fn){if(typeof fn!=='function')throw Error('非表示フィルターが不正です');ruleOutputFilter=fn}
 function outputFiltered(pid,answer){if(!ruleOutputFilter||answer.kind!=='rss')return answer;
  return {...answer,items:ruleOutputFilter(pid,answer.items||[]),...(Array.isArray(answer.blendPreviewItems)?{blendPreviewItems:ruleOutputFilter(pid,answer.blendPreviewItems)}:{})};
 }
 let sourceFilter=null;
 function attachSourceFilter(fn){if(typeof fn!=='function')throw Error('情報源フィルターが不正です');sourceFilter=fn;}
 let openSignals=null;
 function attachOpenSignals(provider){if(!provider||typeof provider.evidence!=='function')throw Error('閲覧シグナルの接続先が不正です');openSignals=provider}
 let externalStatus=null;
 let blend=null;
 function attachExternal(statusFn){
  if(typeof statusFn!=='function')throw Error('外部候補の接続先が不正です');
  externalStatus=statusFn;
  blend=blendModule.create({db,semantic,interests,exclusions,sourceMix,modelConfig,
   feedbackEvidence,feedbackStamp,candidatePool,externalStatus});
 }
 function startBlend(pid,kind){
  if(kind!=='rss')throw Error('7:2:1の登録外統合は現在RSSのみ対応です');
  if(!blend)throw Error('外部候補機能を初期化できません');
  return blend.start(pid);
 }
 function get(pid,kind){
  const legacy=getLegacy(pid,kind);
  if(kind!=='rss'||!blend)return outputFiltered(pid,{...legacy,blendAvailable:false});
  const x=blend.status(pid);
  if(!x.ratioApplied){
   return outputFiltered(pid,{...legacy,blendAvailable:true,blendRunning:x.running,
    blendJob:x.job,blendPreviewItems:(x.previewItems||[]).map(it=>it.origin==='registered'?{...it,id:it.id.slice(2)}:it),blendError:x.error,blendHasExternal:x.hasExternal});
  }
  // Registered IDs retain their legacy article IDs; external recommendations
  // use stable x:<URL hash> IDs in the existing RSS feedback table.
  const items=withFeedback(pid,kind,x.items.map(it=>it.origin==='registered'?{...it,id:it.id.slice(2)}:it));
  return outputFiltered(pid,{...legacy,phase:'blend-preview',ratioApplied:true,items,generatedAt:x.generatedAt,
   running:x.running,job:x.job,error:x.error||'',blendAvailable:true,blendRunning:x.running,
   blendJob:x.job,blendPreviewItems:(x.previewItems||[]).map(it=>it.origin==='registered'?{...it,id:it.id.slice(2)}:it),blendError:x.error,blendMeta:x.meta,blendHasExternal:x.hasExternal,
   blendFeedbackStale:x.feedbackStale});
 }
 return {interests,interestsScoped,putInterests,exclusions,putExclusions,putFeedback,setFeedbackRating,feedbackHistory,editFeedbackHistory,deleteFeedbackBulk,get,start,startBlend,attachExternal,attachOpenSignals,attachSourceFilter,attachOutputFilter,
  modelConfig,setModel,sourceMix,putSourceMix,listModels:semantic.models};
}
module.exports={create};
