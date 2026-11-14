'use strict';
// E4: deterministic 7:2:1 allocation. Model judges semantic roles; application
// owns counts, source origin, hard vetoes, caching and profile boundaries.
const quality=require('./ai-source-quality');
const {inspect:inspectInputEvidence}=require('./ai-input-evidence');
const {titleMatchesExclusion}=require('./ai-exclusion');
const TARGET=30;
const QUOTAS={explicit:21,inferred:6,discovery:3};
const THRESHOLDS={explicit:55,inferred:55,discovery:60};
const LABELS={explicit:'明示的関心',inferred:'AI推定',discovery:'未知の発見'};
const FRESH_EXTERNAL=7*86400000;
// Editorial diversity only: not a domain block or independent trust verdict.
const MAX_RECOMMENDATIONS_PER_EXTERNAL_PUBLISHER=3;
// Candidate sampling may use a generic literal-similarity signal for discovery
// recall, but ALL recommendation relevance remains a model judgment. No topic
// vocabulary / synonym dictionary, and no feedback text is sent to search sites.
function titleAffinity(candidate, positive){
 if(!positive.length)return 0;
 const grams=value=>{
  const normalized=String(value||'').normalize('NFKC').toLocaleLowerCase()
   .replace(/[^\p{L}\p{N}]+/gu,' ').slice(0,180);
  const out=new Set();
  for(const word of normalized.split(/\s+/u)){
   if(word.length<3)continue;
   for(let i=0;i<=word.length-3;i++)out.add(word.slice(i,i+3));
  }
  return out;
 };
 const item=grams(candidate.title);if(!item.size)return 0;
 return positive.reduce((best,e)=>{
  const source=grams(e.title);if(!source.size)return best;
  let overlap=0;for(const x of item)if(source.has(x))overlap++;
  return Math.max(best,overlap/Math.max(4,Math.min(item.size,source.size)));
 },0);
}
// Registered RSS links can use HTTP because the regular RSS reader accepts
// the publisher-provided scheme. The external-search quality gate stays HTTPS-
// only. Never synthesize HTTPS from an HTTP link without verifying its server.
// Retain the same public-host, credentials and default-port constraints.
function registeredArticleUrlKey(input){
 const secure=quality.urlKey(input);
 if(secure)return secure;
 try{
  const u=new URL(String(input||''));
  if(u.protocol!=='http:'||u.username||u.password||!u.hostname||u.port&&u.port!=='80')return '';
  if(!quality.hostOf(u.toString()))return ''; // blocks localhost, IPs and non-public hosts
  u.hash='';u.hostname=u.hostname.toLowerCase();
  for(const k of [...u.searchParams.keys()])if(/^(utm_.+|fbclid|gclid|oc|ref|source)$/i.test(k))u.searchParams.delete(k);
  u.searchParams.sort();
  return u.toString(); // keep HTTP if that was the publisher's real link
 }catch{return ''}
}
// Candidate *retrieval* diversity only. Feed/source identity and collection order
// are sampling signals, not semantic interest, quality, or recommendation scores.
function roundRobinDiscovery(items){
 const queues=new Map(),result=[];
 for(const x of items){const key=String(x.queryLabel||'');if(!queues.has(key))queues.set(key,[]);queues.get(key).push(x)}
 let more=true;
 while(more){more=false;for(const queue of queues.values())if(queue.length){result.push(queue.shift());more=true}}
 return result;
}
function candidateOriginKey(x, origin){
 if(origin==='registered'&&x.feedId!=null&&String(x.feedId))return 'feed:'+String(x.feedId);
 const source=String(x.publisherHost||x.source||'').normalize('NFKC').trim().toLowerCase();
 if(source)return 'source:'+source;
 try{return 'url:'+new URL(String(x.url||'')).hostname.toLowerCase()}catch{return 'unknown'}
}
// Within a retrieval lane, take candidates in round-robin source order; give
// sources already selected by other lanes a proportionally lower turn priority.
// Preserve input order within each feed; don't invent any topic classifications.
function diverseRegistered(items,limit,selected=[]){
 const groups=new Map(),used=new Map();
 for(const x of selected){const k=candidateOriginKey(x,'registered');used.set(k,(used.get(k)||0)+1)}
 for(const x of items){const k=candidateOriginKey(x,'registered');
  if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x);
 }
 const result=[];
 while(result.length<limit){
  let chosen='';let min=Infinity;
  for(const [key,queue] of groups){if(!queue.length)continue;
   const count=used.get(key)||0;
   if(count<min){min=count;chosen=key}
  }
  if(!chosen)break;
  result.push(groups.get(chosen).shift());used.set(chosen,(used.get(chosen)||0)+1);
 }
 return result;
}
// Fix51: provenance ONLY, not a quality score or a reason to veto content.
// Reflect the exact text limits sent to the semantic model and avoid claiming
// that headline repetition provides independent article-body evidence.
function inputEvidenceTrace(x){
 const view=inspectInputEvidence({title:x.title,excerpt:x.excerpt,source:x.source});
 return {titleInputChars:view.title.length,excerptInputChars:view.excerpt.length,
  excerptRawChars:view.rawChars,evidenceScope:view.scope,relatedRemoved:view.relatedRemoved,
  excerptKind:!view.excerpt.trim()?(view.scope==='headline_only'?'headline_like':'missing'):'additional_text_unverified'};
}
function evidenceCounts(evidence){
 return {positive:evidence.filter(e=>e.rating===1).length,
  negative:evidence.filter(e=>e.rating===-1).length,
  comments:evidence.filter(e=>!!String(e.comment||'').trim()).length,
  weakOpens:evidence.filter(e=>e.signal==='opened').length};
}

// A temporal decision is separate from 70/20/10. In particular do not
// fabricate interest scores to compensate for unavailable or expired offers.
function temporalGate(x){
 if(x.timeMetaIssue==='future_published')return 'future_published';
 if(x.timeStatus==='expired'&&x.timeSensitive===true)return 'expired';
 if(x.timeStatus==='uncertain'&&x.timeSensitive===true)return 'uncertain_time_sensitive';
 return '';
}
// Fix72: conservative same-report grouping AFTER semantic evaluation. This is
// headline overlap only, never a claim that two stories are semantically equal.
// Require several shared word segments and high bidirectional overlap; if in
// doubt, keep both. Distinct numeric model/version claims are never merged.
const storySegmenter=new Intl.Segmenter('ja',{granularity:'word'});
function storyWords(title){
 return new Set([...storySegmenter.segment(String(title||'').normalize('NFKC').toLocaleLowerCase())]
  .filter(v=>v.isWordLike).map(v=>v.segment).filter(w=>w.length>=2));
}
function numericClaims(title){
 return (String(title||'').normalize('NFKC').match(/[0-9]+/g)||[]).join('|');
}
function sameReport(a,b,wordA,wordB){
 if(!a?.title||!b?.title)return false;
 const pa=Number(a.published)||0,pb=Number(b.published)||0;
 // Fail open if dates are missing or far apart: these may be follow-up reports.
 if(!pa||!pb||Math.abs(pa-pb)>3*86400000)return false;
 const numsA=numericClaims(a.title),numsB=numericClaims(b.title);
 if(numsA&&numsB&&numsA!==numsB)return false;
 if(quality.nearDuplicate(a.title,b.title,a.source,b.source))return true;
 const A=wordA||storyWords(a.title),B=wordB||storyWords(b.title);
 let common=0;for(const w of A)if(B.has(w))common++;
 if(common<4)return false;
 const overlap=common/(A.size+B.size-common);
 return overlap>=0.27;
}
function storyRole(x){
 if(x.excluded||temporalGate(x))return null;
 if(Number(x.explicit)>=THRESHOLDS.explicit)return {role:'explicit',priority:0,margin:Number(x.explicit)-THRESHOLDS.explicit};
 if(Number(x.inferred)>=THRESHOLDS.inferred)return {role:'inferred',priority:1,margin:Number(x.inferred)-THRESHOLDS.inferred};
 if(Number(x.discovery)>=THRESHOLDS.discovery&&Number(x.explicit)<=75)
  return {role:'discovery',priority:2,margin:Number(x.discovery)-THRESHOLDS.discovery};
 return null;
}
function deduplicateReports(scored){
 // Do not remove unqualified articles; they stay visible in scoringAudit.
 const active=scored.filter(x=>storyRole(x));
 const words=active.map(x=>storyWords(x.title));
 const parent=active.map((_,i)=>i);
 const find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i]}return i};
 for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++){
  if(sameReport(active[i],active[j],words[i],words[j])){
   const p=find(i),q=find(j);if(p!==q)parent[q]=p;
  }
 }
 const groups=new Map();
 for(let i=0;i<active.length;i++){
  const key=find(i);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(active[i]);
 }
 const removed=new Set(),clusters=[];
 for(const items of groups.values()){
  if(items.length<2)continue;
  const ranked=[...items].sort((a,b)=>{
   const A=storyRole(a),B=storyRole(b);
   return A.priority-B.priority||B.margin-A.margin||
    (Number(b.qualityScore)||0)-(Number(a.qualityScore)||0)||
    (Number(b.published)||0)-(Number(a.published)||0)||
    String(a.id).localeCompare(String(b.id),'en');
  });
  for(const x of ranked.slice(1))removed.add(x.id);
  clusters.push({kept:String(ranked[0].id),suppressed:ranked.slice(1).map(x=>String(x.id))});
 }
 return {items:scored.filter(x=>!removed.has(x.id)),clusters,suppressedIds:[...removed]};
}
// Fix102O-R1: conservative evidence/query diversity among otherwise-qualified
// 20%/10% recommendations. No new E4B calls, score alteration or quotas.
function selectionDiversityKey(x,role){
 if(role==='inferred'&&x.inferredBasisType&&x.inferredBasisTitle)
  return 'basis:'+String(x.inferredBasisTitle).normalize('NFKC').toLocaleLowerCase().trim();
 if(role==='discovery'&&x.origin==='external'&&x.discoveryLane&&String(x.queryLabel||'').trim())
  return 'query:'+String(x.queryLabel).normalize('NFKC').toLocaleLowerCase().trim();
 return '';
}
function refineSelectedDiversity(scored, selected, eligible){
 const chosen=[...selected],swaps=[];
 // Preserve all publisher limits across the complete 30, not per lane.
 const host=x=>x.origin==='external'?String(x.publisherHost||'').trim().toLowerCase():'';
 const qualityValue=x=>Number.isFinite(Number(x.qualityScore))?Math.max(0,Math.min(100,Number(x.qualityScore))):0;
 const preference=(x,k)=>Number(x[k])*100+qualityValue(x)*0.1;
 for(const role of ['inferred','discovery']){
  // At most one conservative swap per role. A lack of qualified diversity must
  // never push a lower-scored/irrelevant article into a fixed quota.
  const lane=chosen.filter(x=>x.bucket===role);
  if(lane.length<2)continue;
  const occurrences=new Map();
  for(const x of lane){const key=selectionDiversityKey(x,role);if(key)occurrences.set(key,(occurrences.get(key)||0)+1)}
  const duplicates=lane.filter(x=>{const key=selectionDiversityKey(x,role);return key&&(occurrences.get(key)||0)>1})
   .sort((a,b)=>preference(a,role)-preference(b,role)||String(a.id).localeCompare(String(b.id),'en'));
  if(!duplicates.length)continue;
  const selectedIds=new Set(chosen.map(x=>x.id));
  const candidates=scored.filter(x=>!selectedIds.has(x.id)&&eligible(x,role)&&selectionDiversityKey(x,role)&&
   !occurrences.has(selectionDiversityKey(x,role)));
  let best=null;
  for(const old of duplicates){
   for(const candidate of candidates){
    // Keep origin quotas exactly unchanged and never accept a lower E4 score.
    if(candidate.origin!==old.origin||Number(candidate[role])<Number(old[role]))continue;
    if(qualityValue(candidate)<qualityValue(old)-10)continue;
    const publisher=host(candidate);
    if(publisher){
     const used=chosen.filter(x=>x.id!==old.id&&host(x)===publisher).length;
     if(used>=MAX_RECOMMENDATIONS_PER_EXTERNAL_PUBLISHER)continue;
    }
    // Existing dedup removes high-confidence same reports from the pool;
    // do not reintroduce an overlapping headline through this refinement.
    if(chosen.some(x=>x.id!==old.id&&sameReport(candidate,x)))continue;
    const gain=preference(candidate,role)-preference(old,role);
    if(gain< -1)continue;
    if(!best||gain>best.gain||gain===best.gain&&
      String(candidate.id).localeCompare(String(best.candidate.id),'en')<0)
     best={old,candidate,gain};
   }
  }
  if(!best)continue;
  const replacement={...best.candidate,bucket:role,semanticScore:best.candidate[role],
   semanticReason:best.candidate.reason||'',score:best.candidate[role]};
  const i=chosen.findIndex(x=>x.id===best.old.id);
  if(i<0)continue;
  chosen[i]=replacement;
  swaps.push({role,reason:role==='inferred'?'shared_feedback_basis':'shared_discovery_query',
   from:String(best.old.id),to:String(best.candidate.id),
   scoreFrom:Number(best.old[role]),scoreTo:Number(best.candidate[role]),
   origin:best.old.origin});
 }
 return {items:chosen,audit:{mode:'same_or_higher_e4_score_same_origin_tie_refinement',swaps,
  note:'Only duplicated validated feedback basis (20%) or repeated E2 discovery query (10%) can trigger a same-origin, non-lower-scored swap. This does not identify different-news retellings or prove discovery value.'}};
}

// Keep scores independent while assigning each candidate to its HIGHEST
// qualified role: explicit (70) > inferred (20) > discovery (10). A bucket
// being full never permits relabeling an explicitly relevant article as a
// user-preference inference or serendipitous discovery. Preserve the global
// allocation within those role-locked candidates for source diversity.
function allocate(scored, ratios, target=QUOTAS){
 const storyDedup=deduplicateReports(scored);
 scored=storyDedup.items;
 const kinds=['explicit','inferred','discovery'];
 const requested=Object.fromEntries(kinds.map(k=>[k,Math.max(0,Math.floor(Number(target?.[k])||0))]));
 const rawEligible=(x,k)=>!x.excluded&&!temporalGate(x)&&Number.isFinite(Number(x[k]))&&Number(x[k])>=THRESHOLDS[k]&&
  (k!=='discovery'||Number(x.explicit)<=75);
 const eligible=(x,k)=>rawEligible(x,k)&&
  (k==='explicit'||(k==='inferred'?!rawEligible(x,'explicit'):
   !rawEligible(x,'explicit')&&!rawEligible(x,'inferred')));
 const candidates=[...scored].filter(x=>kinds.some(k=>eligible(x,k)))
  .sort((a,b)=>String(a.id).localeCompare(String(b.id),'en'));
 const network=[];
 const node=()=>{network.push([]);return network.length-1};
 const edge=(a,b,capacity,cost)=>{
  const f={to:b,rev:network[b].length,cap:capacity,cost};
  const r={to:a,rev:network[a].length,cap:0,cost:-cost};
  network[a].push(f);network[b].push(r);return f;
 };
 const source=node(),sink=node();
 const bucketNodes={},originNodes={};
 const hasRatio=k=>Number.isInteger(ratios?.[k])?Math.max(0,Math.min(100,ratios[k])):40;
 for(const k of kinds){
  bucketNodes[k]=node();originNodes[k]={registered:node(),external:node()};
  const n=requested[k],r=Math.round(n*hasRatio(k)/100);
  for(const [origin,goal] of [['registered',r],['external',n-r]]){
   // Favor the user's preferred registered/external mix, but allow fallback.
   edge(originNodes[k][origin],bucketNodes[k],goal,0);
   edge(originNodes[k][origin],bucketNodes[k],n,9000);
  }
  // Early slots are more valuable in an underfilled category. This only
  // selects among already-eligible articles: no thresholds are lowered.
  for(let slot=0;slot<n;slot++){
   const balance=Math.round(1500*(n-slot)/n);
   edge(bucketNodes[k],sink,1,-balance);
  }
 }
 const hostNodes=new Map(),chosenEdges=[];
 for(const x of candidates){
  const cn=node();
  if(x.origin==='external'&&String(x.publisherHost||'').trim()){
   const host=String(x.publisherHost).trim().toLowerCase();
   if(!hostNodes.has(host)){
    const hn=node();hostNodes.set(host,hn);
    edge(source,hn,MAX_RECOMMENDATIONS_PER_EXTERNAL_PUBLISHER,0);
   }
   edge(hostNodes.get(host),cn,1,0);
  }else edge(source,cn,1,0);
  for(const k of kinds){
   if(!eligible(x,k))continue;
   // Margins above each role's unchanged threshold are comparable on a
   // normalized 0..1 scale, without requiring role scores to be identical.
   const relative=(Number(x[k])-THRESHOLDS[k])/(100-THRESHOLDS[k]);
   const quality=Number.isFinite(Number(x.qualityScore))?Math.min(100,Math.max(0,Number(x.qualityScore))):0;
   const reward=Math.round(relative*3700)+Math.round(quality*0.75);
   const e=edge(cn,originNodes[k][x.origin==='external'?'external':'registered'],1,-reward);
   chosenEdges.push({candidate:x,kind:k,edge:e});
  }
 }
 // Successive shortest augmenting paths. The network has <=52 candidates
 // in production; unlike a greedy pass, residual paths can reassign earlier
 // candidates when another bucket has a more exclusive fit.
 let flow=0;
 const limit=kinds.reduce((n,k)=>n+requested[k],0);
 while(flow<limit){
  const dist=Array(network.length).fill(Infinity),prevNode=Array(network.length).fill(-1),prevEdge=Array(network.length).fill(-1);
  dist[source]=0;
  const queue=[source],queued=Array(network.length).fill(false);queued[source]=true;
  let head=0,relaxations=0;
  while(head<queue.length){
   const u=queue[head++];queued[u]=false;
   for(let ei=0;ei<network[u].length;ei++){
    const e=network[u][ei];if(e.cap<1)continue;
    const nd=dist[u]+e.cost;
    if(nd>=dist[e.to])continue;
    dist[e.to]=nd;prevNode[e.to]=u;prevEdge[e.to]=ei;
    if(!queued[e.to]){queue.push(e.to);queued[e.to]=true}
    if(++relaxations>120000)throw Error('枠間の割り当て計算が収束しませんでした。保存しません。');
   }
  }
  if(prevNode[sink]===-1)break;
  for(let v=sink;v!==source;v=prevNode[v]){
   const u=prevNode[v],e=network[u][prevEdge[v]];
   e.cap--;network[v][e.rev].cap++;
  }
  flow++;
 }
 const counts={},shortages={},result=[],publisherCounts=new Map();
 for(const k of kinds)counts[k]={target:requested[k],registered:0,external:0};
 for(const {candidate:x,kind:k,edge:e} of chosenEdges){
  if(e.cap!==0)continue;
  const origin=x.origin==='external'?'external':'registered';
  counts[k][origin]++;
  if(origin==='external'){
   const host=String(x.publisherHost||'').trim().toLowerCase();
   if(host)publisherCounts.set(host,(publisherCounts.get(host)||0)+1);
  }
  result.push({...x,bucket:k,semanticScore:x[k],semanticReason:x.reason||'',score:x[k]});
 }
 const refined=refineSelectedDiversity(scored,result,eligible);
 result.splice(0,result.length,...refined.items);
 // Source totals and the publisher cap diagnostic must reflect *final* items.
 for(const k of kinds){counts[k].registered=0;counts[k].external=0}
 publisherCounts.clear();
 for(const x of result){
  const origin=x.origin==='external'?'external':'registered';
  counts[x.bucket][origin]++;
  if(origin==='external'&&String(x.publisherHost||'').trim()){
   const h=String(x.publisherHost).trim().toLowerCase();
   publisherCounts.set(h,(publisherCounts.get(h)||0)+1);
  }
 }
 const included=new Set(result.map(x=>x.id));
 const skippedByBucket={};
 const skippedTotal=new Set();
 for(const k of kinds){
  shortages[k]=requested[k]-counts[k].registered-counts[k].external;
  const skipped=candidates.filter(x=>x.origin==='external'&&!included.has(x.id)&&eligible(x,k)&&
   !!String(x.publisherHost||'').trim()&&
   (publisherCounts.get(String(x.publisherHost).trim().toLowerCase())||0)>=MAX_RECOMMENDATIONS_PER_EXTERNAL_PUBLISHER);
  skippedByBucket[k]=skipped.length;
  skipped.forEach(x=>skippedTotal.add(x.id));
 }
 return {items:result.sort((a,b)=>kinds.indexOf(a.bucket)-kinds.indexOf(b.bucket)||Number(b.score)-Number(a.score)||String(a.id).localeCompare(String(b.id),'en')),
  counts,shortages,target:limit,sourceCapSkipped:skippedTotal.size,
  sourceCap:MAX_RECOMMENDATIONS_PER_EXTERNAL_PUBLISHER,sourceCapSkippedByBucket:skippedByBucket,
  diversityAudit:refined.audit,
  storyDedup:{clusters:storyDedup.clusters,suppressedIds:storyDedup.suppressedIds}};
}

// Counterfactual for diagnostics only. This is the former 10%->20%->70%
// sequential assignment, not used for display, previews or SQLite items.
function allocateSequential(scored,ratios,target=QUOTAS){
 const used=new Set(),result=[],counts={},shortages={},publisherCounts=new Map();
 const kinds=['discovery','inferred','explicit'];
 const canUse=x=>!used.has(x.id)&&(
  x.origin!=='external'||!String(x.publisherHost||'').trim()||
  (publisherCounts.get(String(x.publisherHost).trim().toLowerCase())||0)<MAX_RECOMMENDATIONS_PER_EXTERNAL_PUBLISHER);
 const take=(x,k)=>{
  used.add(x.id);counts[k][x.origin]++;
  if(x.origin==='external'){
   const h=String(x.publisherHost||'').trim().toLowerCase();
   if(h)publisherCounts.set(h,(publisherCounts.get(h)||0)+1);
  }
  result.push({...x,bucket:k});
 };
 for(const k of kinds){
  const n=Math.max(0,Math.floor(Number(target?.[k])||0));
  const fraction=Number.isInteger(ratios?.[k])?ratios[k]:40;
  const r=Math.round(n*fraction/100),goal={registered:r,external:n-r};
  counts[k]={target:n,registered:0,external:0};
  const ranked=[...scored].filter(x=>!x.excluded&&!temporalGate(x)&&Number(x[k])>=THRESHOLDS[k]&&
   (k!=='discovery'||Number(x.explicit)<=75))
   .sort((a,b)=>Number(b[k])-Number(a[k])||Number(b.qualityScore||0)-Number(a.qualityScore||0)||Number(b.published||0)-Number(a.published||0));
  for(const origin of ['registered','external'])for(const x of ranked){
   if(counts[k][origin]>=goal[origin]||x.origin!==origin||!canUse(x))continue;
   take(x,k);
  }
  for(const x of ranked){
   if(counts[k].registered+counts[k].external>=n)break;
   if(canUse(x))take(x,k);
  }
  shortages[k]=n-counts[k].registered-counts[k].external;
 }
 return {items:result,counts,shortages};
}

function create({db,semantic,interests,exclusions,sourceMix,modelConfig,feedbackEvidence,feedbackStamp,candidatePool,externalStatus}){
 db.exec(`CREATE TABLE IF NOT EXISTS ai_blend_cache(
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('rss')),
  model TEXT NOT NULL, items_json TEXT NOT NULL, meta_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL, interest_stamp INTEGER NOT NULL,
  exclusion_stamp INTEGER NOT NULL, feedback_stamp INTEGER NOT NULL,
  mix_stamp INTEGER NOT NULL, external_stamp INTEGER NOT NULL,
  model_stamp INTEGER NOT NULL,
  PRIMARY KEY(profile_id,kind));`);
 const jobs=new Map(),failures=new Map(),running=new Set();
 const config=pid=>{
  const i=interests(pid),e=exclusions(pid),m=sourceMix(pid),model=modelConfig(pid),external=externalStatus(pid);
  return {i,e,m,model,external,fb:feedbackStamp(pid)};
 };
 function pool(pid,cfg,evidence){
  const now=Date.now(),seenTitles=[],seenUrls=new Set(),out=[];
  const discoveryApproaches=new Map((cfg.external.qualityStats?.discoveryTopics||[])
   .filter(x=>typeof x?.topic==='string').map(x=>[x.topic,String(x.approach||'')]));
  let sameHeadlineFiltered=0;
  // Record the ACTUAL acceptance test. A reservation is not necessarily an
  // evaluated article: URL, exclusion and headline checks happen in push().
  // These totals contain no titles/URLs and do not modify the AI's judgments.
  const registeredRejects={invalidUrl:0,emptyTitle:0,excludedTitle:0,duplicateUrl:0,duplicateTitle:0};
  const reject=(origin,reason)=>{if(origin==='registered')registeredRejects[reason]++;};
  const push=(x,origin)=>{
   const url=origin==='registered'?registeredArticleUrlKey(x.url):quality.urlKey(x.url),title=String(x.title||'');
   if(!url){reject(origin,'invalidUrl');return;}
   if(!title){reject(origin,'emptyTitle');return;}
   if(titleMatchesExclusion(title,cfg.e.terms)){reject(origin,'excludedTitle');return;}
   if(seenUrls.has(url)){reject(origin,'duplicateUrl');return;}
   // RSS publisher metadata disambiguates headline suffixes containing '-'.
   // This also cleans older external-search caches without another fetch.
   if(seenTitles.some(t=>quality.nearDuplicate(t.title,title,t.source,x.source))){
    if(origin==='external')sameHeadlineFiltered++;
    reject(origin,'duplicateTitle');
    return;
   }
   seenUrls.add(url);seenTitles.push({title,source:String(x.source||'')});
   out.push({...x,id:(origin==='registered'?'r:':'x:')+String(x.id),origin,inferenceLane:!!x.inferenceLane,discoveryLane:!!x.discoveryLane,discoveryBridge:String(x.discoveryBridge||'').slice(0,100),
    discoveryApproach:origin==='external'&&x.discoveryLane?(discoveryApproaches.get(String(x.queryLabel||''))||'legacy'):'',
    excerpt:String(x.excerpt||'').slice(0,360),
    title,source:String(x.source||''),url,thumbnail:String(x.thumbnail||''),published:Number(x.published)||0,
    qualityScore:Number(x.qualityScore)||0});
  };
  // Strong candidate-recall hints can come from likes or user-written comments.
  // They do NOT establish inferred interest; the model still must cite a valid
  // in-profile evidence ref and satisfy the independent inferred threshold.
  const related=evidence.filter(e=>e.signal!=='opened' &&
   (e.rating===1||(e.rating!==-1&&!!String(e.comment||'').trim())));
  // Fix70: apply the SAME static eligibility checks as push() BEFORE
  // reserving a scarce Gemma evaluation slot. Retain the original, already-
  // capped source pool for comparable counts and keep the original order.
  // NOTE: upstream candidatePool's 65/55 caps are unchanged here.
  const regRaw=candidatePool(pid,'rss',{forBlend:true}).filter(x=>x.published>=now-21*86400000);
  const registeredPreflightRejected={invalidUrl:0,emptyTitle:0,excludedTitle:0};
  const regAll=regRaw.filter(x=>{
   if(!registeredArticleUrlKey(x.url)){registeredPreflightRejected.invalidUrl++;return false}
   const title=String(x.title||'');
   if(!title){registeredPreflightRejected.emptyTitle++;return false}
   if(titleMatchesExclusion(title,cfg.e.terms)){registeredPreflightRejected.excludedTitle++;return false}
   return true;
  });
  const regSelected=[];
  const addRegistered=(x,fromEvidence=false)=>{
   if(regSelected.length>=26||regSelected.some(y=>y.id===x.id))return;
   regSelected.push({...x,evidenceRecall:!!fromEvidence});
  };
  // Preserve room for direct user interests and semantic discovery, even if
  // the same feedback title matches many articles.
  if(related.length){
   const ranked=[...regAll].map(x=>({x,affinity:titleAffinity(x,related)}))
    .filter(v=>v.affinity>0).sort((a,b)=>b.affinity-a.affinity);
   // First rank by the generic title overlap, then distribute only among the
   // strongest candidates. This cannot establish 20% eligibility.
   for(const x of diverseRegistered(ranked.slice(0,18).map(v=>v.x),6,regSelected))
    addRegistered(x,true);
  }
  const addLane=(lane,max)=>{
   const eligible=regAll.filter(x=>x.retrievalLane===lane&&!regSelected.some(y=>y.id===x.id));
   for(const x of diverseRegistered(eligible,max,regSelected))addRegistered(x);
  };
  // Keep the same lane reservation as Fix25; only diversify who gets scored.
  addLane('direct',18);
  addLane('other',4);
  for(const x of diverseRegistered(regAll.filter(x=>!regSelected.some(y=>y.id===x.id)),26-regSelected.length,regSelected))
   addRegistered(x);
  regSelected.forEach(x=>push(x,'registered'));
  const registeredInitiallyAccepted=out.filter(x=>x.origin==='registered').length;
  // Fix69: a selected candidate may be rejected by push() (HTTPS validation,
  // an exclusion, or deduplication). Preserve the original 26 selections,
  // THEN refill only vacant evaluation slots from the remaining registered
  // pool. No scores, quotas, relevance rules or source-mix preferences change.
  // Try each unused candidate at most once; never pull older/out-of-window
  // material, and never substitute a candidate failing the existing checks.
  let registeredRefillAttempted=0,registeredRefillAccepted=0;
  if(registeredInitiallyAccepted<26){
   const unused=regAll.filter(x=>!regSelected.some(y=>y.id===x.id));
   const alreadyAccepted=out.filter(x=>x.origin==='registered');
   for(const x of diverseRegistered(unused,unused.length,alreadyAccepted)){
    if(registeredInitiallyAccepted+registeredRefillAccepted>=26)break;
    registeredRefillAttempted++;
    const before=out.length;
    push(x,'registered');
    if(out.length>before)registeredRefillAccepted++;
   }
  }
  const registeredActual=registeredInitiallyAccepted+registeredRefillAccepted;
  // Only quality-gated (and unexpired) external candidates; never treat the raw
  // external search preview as a vetted recommendation.
  const ext=cfg.external;
  let externalQualityAvailable=0,externalPublisherAvailable=0,externalQueryAvailable=0;
  if(ext.qualityApplied && ext.generatedAt && now-ext.generatedAt<FRESH_EXTERNAL){
   const perQuery=new Map();
   const accepted=x=>Number(x.qualityScore)>=50&&!!x.publisherHost&&Number(x.published)>=now-FRESH_EXTERNAL;
   const qualityItems=ext.items.filter(accepted);
   externalQualityAvailable=qualityItems.length;
   externalPublisherAvailable=new Set(qualityItems.map(x=>candidateOriginKey(x,'external'))).size;
   externalQueryAvailable=new Set(qualityItems.map(x=>String(x.queryLabel||''))).size;
   const countExternal=()=>out.filter(y=>y.origin==='external').length;
   const put=x=>{
    const q=String(x.queryLabel||'');if((perQuery.get(q)||0)>=8||!accepted(x))return;
    const prev=out.length;push(x,'external');if(out.length>prev)perQuery.set(q,(perQuery.get(q)||0)+1);
   };
   // Preserve a meaningful discovery lane in the limited candidate pool.
   for(const x of roundRobinDiscovery(ext.items.filter(x=>x.discoveryLane))){
    if(out.filter(y=>y.origin==='external'&&y.discoveryLane).length>=6)break;put(x);
   }
   // Reserve candidate EVALUATION opportunities for searches based on explicit
   // positive feedback, without raising inferred scores or filling a quota.
   // All such articles still face the same source, exclusion, time and Gemma gates.
   let inferredRecall=0;
   for(const x of roundRobinDiscovery(ext.items.filter(x=>x.inferenceLane&&!x.discoveryLane))){
    if(inferredRecall>=6||countExternal()>=26)break;
    const before=countExternal();put(x);
    if(countExternal()>before)inferredRecall++;
   }
   if(related.length){
    // Recall only. A later LLM score must still exceed the inferred threshold.
    const preferred=[...ext.items].filter(x=>!x.discoveryLane)
     .sort((a,b)=>titleAffinity(b,related)-titleAffinity(a,related));
    let added=0;
    for(const x of preferred){
     if(added>=6||countExternal()>=26)break;
     if(titleAffinity(x,related)<=0)break;
     const before=countExternal();put({...x,evidenceRecall:true});
     if(countExternal()>before)added++;
    }
   }
   // Do not let the RSS results from the first query consume the remaining
   // slots before results of other explicit-interest queries are considered.
   // Query labels are discovery metadata, NOT a semantic relevance judgment.
   const perQueryQueue=new Map();
   for(const x of ext.items){
    if(x.discoveryLane)continue; // The discovery reserve was sampled above.
    const key=String(x.queryLabel||'');
    if(!perQueryQueue.has(key))perQueryQueue.set(key,[]);
    perQueryQueue.get(key).push(x);
   }
   // Prefer publisher diversity while rotating query results, then relax
   // only this temporary sampling cap if fewer than 26 quality candidates
   // would otherwise be shown to Gemma. Final publisher rule remains 3.
   for(const softPublisherCap of [4,Infinity]){
    let progress=true;
    while(countExternal()<26&&progress){
     progress=false;
     for(const queue of perQueryQueue.values()){
      if(!queue.length)continue;
      const i=queue.findIndex(x=>softPublisherCap===Infinity||
       out.filter(y=>y.origin==='external'&&candidateOriginKey(y,'external')===candidateOriginKey(x,'external')).length<softPublisherCap);
      if(i<0)continue;
      const item=queue.splice(i,1)[0],before=countExternal();
      put(item);
      progress=true;
      if(countExternal()>=26)break;
     }
    }
    if(countExternal()>=26)break;
   }
  }
  // Fix74: baseline-preserving scoring recall. Only AFTER the original
  // registered selection and the complete external sampling have finished,
  // offer up to eight additional fresh registered articles to Gemma.
  // This preserves EVERY accepted baseline evaluation candidate and its
  // ordering. It never assigns a recommendation role without semantic scoring.
  // The supplement is a bounded opportunity for non-literal titles in clearly
  // relevant feeds, NOT a quota of recommendations or a relevance score.
  const coreCandidateCount=out.length;
  const supplementalBudget=8;
  let supplementalRegisteredAccepted=0,supplementalRegisteredAttempted=0;
  let supplementalOther=0,supplementalDirect=0;
  const supplementTried=new Set(regSelected.map(x=>String(x.id)));
  const interestTerms=cfg.i.terms.map(s=>String(s).normalize('NFKC').toLocaleLowerCase()).filter(Boolean);
  const hasPublisherContext=x=>interestTerms.some(t=>String(x.source||'').normalize('NFKC').toLocaleLowerCase().includes(t));
  const trySupplement=(lane,target,requirePublisherContext=false)=>{
   if(target<1||supplementalRegisteredAccepted>=supplementalBudget)return;
   const fresh=regAll.filter(x=>x.retrievalLane===lane&&!supplementTried.has(String(x.id))&&
    (!requirePublisherContext||hasPublisherContext(x)));
   const existing=out.filter(x=>x.origin==='registered');
   for(const x of diverseRegistered(fresh,fresh.length,existing)){
    if(supplementalRegisteredAccepted>=supplementalBudget||target<=0)break;
    supplementTried.add(String(x.id));supplementalRegisteredAttempted++;
    const before=out.length;
    push({...x,supplementalRecall:true},'registered');
    if(out.length!==before){supplementalRegisteredAccepted++;target--;
     if(lane==='other')supplementalOther++;else supplementalDirect++;
    }
   }
  };
  // Score additional candidate articles only when a cheap, existing evidence
  // signal already exists: either the title/excerpt mentions a user interest
  // (direct) or the feed's own name names that interest (other). The latter
  // catches examples such as a game article whose headline says only a game
  // series name, WITHOUT a game-specific word or any hard-coded topic map.
  // No arbitrary filler from wholly unrelated feeds. Gemma still decides.
  trySupplement('other',4,true);
  trySupplement('direct',4);
  const registeredFinal=registeredActual+supplementalRegisteredAccepted;
  // Fix102F: Keep ALL baseline RSS/Google candidates unchanged and append
  // optional evidence-search and serendipity candidates from the *verified*
  // E2 cache. Targets are comparable sampling OPPORTUNITIES, not labels or
  // mandatory 20%/10% recommendation shares. Each article is still scored
  // independently against all three roles by E4, with unchanged priority.
  const trialExternalTargets={inferred_search:12,discovery:18};
  const trialStartIndex=out.length;
  const trialBefore={inferred_search:out.filter(x=>x.origin==='external'&&x.inferenceLane&&!x.discoveryLane).length,
   discovery:out.filter(x=>x.origin==='external'&&x.discoveryLane).length};
  const trialAttempted={inferred_search:0,discovery:0};
  const trialAdded={inferred_search:0,discovery:0};
  if(ext.qualityApplied&&ext.generatedAt&&now-ext.generatedAt<FRESH_EXTERNAL){
   const valid=x=>Number(x.qualityScore)>=50&&!!x.publisherHost&&Number(x.published)>=now-FRESH_EXTERNAL;
   for(const [lane,test] of [['inferred_search',x=>x.inferenceLane&&!x.discoveryLane],
                              ['discovery',x=>x.discoveryLane]]){
    const max=trialExternalTargets[lane];
    for(const x of roundRobinDiscovery(ext.items.filter(test))){
     if(trialBefore[lane]+trialAdded[lane]>=max)break;
     if(!valid(x))continue;
     // Keep the existing per-query candidate diversity safeguard.
     if(out.filter(y=>y.origin==='external'&&y.queryLabel===x.queryLabel).length>=8)continue;
     if(out.some(y=>y.id==='x:'+String(x.id)))continue;
     trialAttempted[lane]++;
     const length=out.length;
     push({...x,sourceMixTrialRecall:lane},'external');
     if(out.length>length)trialAdded[lane]++;
    }
   }
  }
  // Counters are attached to this one-shot candidate array; they are never
  // persisted as articles or used as a substitute for Gemma's semantic scores.
  Object.defineProperty(out,'sampling',{value:{
   // Keep the Fix69 denominators comparable with historical quality JSONs.
   registeredAvailable:regRaw.length,
   registeredSourceAvailable:new Set(regRaw.map(x=>candidateOriginKey(x,'registered'))).size,
   registeredPreflightEligible:regAll.length,
   registeredPreflightRejected,
   registeredPreflightAfterUpstreamCap:true,
   registeredSourceSampled:new Set(out.filter(x=>x.origin==='registered').map(x=>candidateOriginKey(x,'registered'))).size,
   // The old registeredSampled counter counted reservations, not articles
   // that actually reached Gemma. Keep both values for audit compatibility.
   registeredUnscored:Math.max(0,regRaw.length-registeredFinal),
   registeredSampled:registeredFinal,
   registeredReserved:regSelected.length,
   coreCandidateCount,
   registeredCoreSampled:registeredActual,
   registeredSupplementalSampled:supplementalRegisteredAccepted,
   registeredSupplementalAttempted:supplementalRegisteredAttempted,
   registeredSupplementalOther:supplementalOther,
   registeredSupplementalDirect:supplementalDirect,
   registeredInitiallyAccepted,registeredRefillAttempted,registeredRefillAccepted,
   registeredRejectReasons:registeredRejects,
   registeredDirect:out.filter(x=>x.origin==='registered'&&x.retrievalLane==='direct').length,
   registeredOther:out.filter(x=>x.origin==='registered'&&x.retrievalLane==='other').length,
   registeredEvidence:out.filter(x=>x.origin==='registered'&&x.evidenceRecall).length,
   externalQualityAvailable,externalPublisherAvailable,externalQueryAvailable,
   externalPublisherSampled:new Set(out.filter(x=>x.origin==='external').map(x=>candidateOriginKey(x,'external'))).size,
   externalQuerySampled:new Set(out.filter(x=>x.origin==='external').map(x=>String(x.queryLabel||''))).size,
   externalSampled:out.filter(x=>x.origin==='external').length,
   externalDiscovery:out.filter(x=>x.origin==='external'&&x.discoveryLane).length,
   externalInferredSearch:out.filter(x=>x.origin==='external'&&x.inferenceLane).length,
   externalSameHeadlineFiltered:sameHeadlineFiltered,
   sourceMixTrial:{mode:'candidate_opportunity_not_role_quota',
    targets:{inferredExternal:12,discoveryExternal:18},
    baseline:trialBefore,attempted:trialAttempted,added:trialAdded,
    registeredPositiveEvidence:out.filter(x=>x.origin==='registered'&&x.evidenceRecall).length,
    registeredOther:out.filter(x=>x.origin==='registered'&&x.retrievalLane==='other').length,
    trialStartIndex,trialTotal:out.length-trialStartIndex,
    note:'Registered candidates are all scored against all roles. The 3:7/1:9 hypotheses are not deterministic pre-score role labels.'},
   externalEvidence:out.filter(x=>x.origin==='external'&&x.evidenceRecall).length
  },enumerable:false});
  return out;
 }
 function validCache(pid,cfg){
  const row=db.prepare('SELECT * FROM ai_blend_cache WHERE profile_id=? AND kind=?').get(pid,'rss');
  return row&&row.model===cfg.model.model&&row.interest_stamp===cfg.i.updatedAt&&
   row.exclusion_stamp===cfg.e.updatedAt&&row.mix_stamp===cfg.m.updatedAt&&
   row.model_stamp===cfg.model.updatedAt&&row.external_stamp===(cfg.external.generatedAt||0)?row:null;
 }
 // Only finished, validated 7:2:1 generations are stored in SQLite.
 // While scoring, keep a separate in-memory preview scoped to this profile.
 function status(pid){
  const cfg=config(pid),row=validCache(pid,cfg),job=jobs.get(pid),isRunning=running.has(pid);
  const {previewItems:_privatePreview,...jobPublic}=job||{};
  return {ratioApplied:!!row,feedbackStale:!!row&&row.feedback_stamp!==cfg.fb,
   items:row?JSON.parse(row.items_json):[],meta:row?JSON.parse(row.meta_json):null,
   generatedAt:row?.generated_at||0,running:isRunning,
   job:job?{...jobPublic,elapsedMs:(job.finishedAt||Date.now())-job.startedAt}:null,
   previewItems:isRunning?(job?.previewItems||[]):[],
   error:failures.get(pid)||'',available:!!cfg.model.model,hasExternal:cfg.external.qualityApplied&&cfg.external.items.length>0};
 }
 function enrichBlendResult(candidate,grade,evidence){
  const item={...candidate,...grade,timeCheckedAt:Date.now()};
  // The same evidence validation is used for provisional and final allocation.
  // A guessed or opened-only feedback reference NEVER establishes inferred interest.
  const ref=String(item.inferredBasis||'');
  const index=/^e(?:0|[1-9]\d*)$/.test(ref)?Number(ref.slice(1)):-1;
  const proof=index>=0&&index<20?evidence[index]:null;
  const valid=!!proof&&proof.signal!=='opened'&&(
   proof.rating===1||(proof.rating!==-1&&!!String(proof.comment||'').trim()));
  if(valid){
   item.inferredBasisType=proof.rating===1?'興味あり':'感想';
   item.inferredBasisTitle=String(proof.title||'').slice(0,110);
   item.inferredWhy=String(item.inferredWhy||'').slice(0,100);
  }else{
   item.inferred=0;item.inferredBasisType='';item.inferredBasisTitle='';item.inferredWhy='';
  }
  delete item.inferredBasis;
  return item;
 }
 function start(pid){
  const cfg=config(pid);
  if(!cfg.model.model)throw Error('設定でOllamaモデルを選択してください');
  if(!cfg.i.terms.length)throw Error('関心リストを登録してください');
  if(running.has(pid))return {started:false,running:true};
  const evidence=feedbackEvidence(pid);
  const candidates=pool(pid,cfg,evidence);
  if(!candidates.length)throw Error('新しい候補がありません。登録済み記事または外部記事を取得してください');
  running.add(pid);failures.delete(pid);
  jobs.set(pid,{status:'running',stage:'preparing',completed:0,total:candidates.length,timeCompleted:0,timeTotal:0,
   startedAt:Date.now(),finishedAt:0,previewItems:[],previewVersion:0});
  setImmediate(async()=>{
   try{
    const candidateById=new Map(candidates.map(x=>[x.id,x]));
    const provisional=new Map();
    // Fix74: score the EXISTING pool in its original batch grouping first.
    // New recall candidates are scored in a separate call: no changes to the
    // original model prompts/batches even when the core count is not a multiple of 6.
    const coreCount=candidates.sampling?.coreCandidateCount??candidates.length;
    const gradeGroup=(group,offset)=>semantic.scoreBlend({model:cfg.model.model,interests:cfg.i.terms,
     evidence,exclusions:cfg.e.terms,candidates:group,profileScope:pid,
     temporalEligible:g=>!g.excluded&&(
      Number(g.explicit)>=THRESHOLDS.explicit||Number(g.inferred)>=THRESHOLDS.inferred||
      (Number(g.discovery)>=THRESHOLDS.discovery&&Number(g.explicit)<=75)),
     onProgress:p=>{
      const job=jobs.get(pid);
      if(!job||job.status!=='running')return;
      job.completed=offset+p.completed;job.total=candidates.length;job.stage=p.stage;
      if(Number.isFinite(p.timeCompleted))job.timeCompleted=p.timeCompleted;
      if(Number.isFinite(p.timeTotal))job.timeTotal=p.timeTotal;
      if(Array.isArray(p.batch)&&p.batch.length){
       for(const rating of p.batch){
        const candidate=candidateById.get(rating.id);
        if(candidate)provisional.set(rating.id,enrichBlendResult(candidate,rating,evidence));
       }
       job.previewItems=allocate([...provisional.values()],cfg.m.ratios).items;
       job.previewVersion++;
      }
     }});
    const coreGraded=await gradeGroup(candidates.slice(0,coreCount),0);
    // Original registered RSS supplement remains a separate scoring group.
    const regEnd=coreCount+Number(candidates.sampling?.registeredSupplementalSampled||0);
    let supplementGraded=[],supplementalScoreError='';
    if(regEnd>coreCount){
     try{supplementGraded=await gradeGroup(candidates.slice(coreCount,regEnd),coreCount)}
     catch(e){supplementalScoreError=String(e.message||e).slice(0,160)}
    }
    // Bounded optional trial groups: failures cannot erase successful base
    // grades, and an 8-item group is never mixed with historical model calls.
    let trialGraded=[],trialScoreErrors=[],trialTiming=[];
    for(let from=regEnd;from<candidates.length;from+=6){
     const group=candidates.slice(from,Math.min(from+6,candidates.length));
     try{const part=await gradeGroup(group,from);trialGraded.push(...part);trialTiming.push(...(part.timing||[]))}
     catch(e){trialScoreErrors.push({from,count:group.length,error:String(e.message||e).slice(0,140)})}
    }
    const graded=[...coreGraded,...supplementGraded,...trialGraded];
    Object.defineProperty(graded,'timing',{value:[...(coreGraded.timing||[]),...(supplementGraded.timing||[]),...trialTiming]});
    candidates.sampling.registeredSupplementalScored=supplementGraded.length;
    candidates.sampling.registeredSupplementalScoreError=supplementalScoreError;
    candidates.sampling.sourceMixTrial.scored=trialGraded.length;
    candidates.sampling.sourceMixTrial.scoreErrors=trialScoreErrors;
    const byId=new Map(graded.map(x=>[x.id,x]));
    const scored=candidates.filter(x=>byId.has(x.id)).map(x=>enrichBlendResult(x,byId.get(x.id),evidence));
    // Inferred 20% is genuinely evidence-based, never silently rebranded as keyword interest.
    if(!evidence.length)for(const x of scored)x.inferred=0;
    const allocated=allocate(scored,cfg.m.ratios);
    // Compare both selections ON THE SAME Gemma scores. This does not affect
    // display, but makes any lost/gained original recommendations auditable.
    // Keep the old registered supplement diagnostic isolated from the new
    // external-source trial. Both comparisons use the SAME successfully scored
    // article set, and never affect selection.
    const coreSelection=allocate(scored.filter(x=>!x.supplementalRecall&&!x.sourceMixTrialRecall),cfg.m.ratios);
    const preTrialSelection=allocate(scored.filter(x=>!x.sourceMixTrialRecall),cfg.m.ratios);
    const coreSelectedIds=new Set(coreSelection.items.map(x=>x.id));
    const preTrialSelectedIds=new Set(preTrialSelection.items.map(x=>x.id));
    const finalSelectedIds=new Set(allocated.items.map(x=>x.id));
    const supplementalDiagnostic={
     evaluated:scored.filter(x=>x.supplementalRecall).length,
     qualifiedExplicit:scored.filter(x=>x.supplementalRecall&&!x.excluded&&!temporalGate(x)&&Number(x.explicit)>=THRESHOLDS.explicit).length,
     selectedSupplemental:preTrialSelection.items.filter(x=>x.supplementalRecall).map(x=>String(x.id)),
     displacedCore:coreSelection.items.filter(x=>!preTrialSelectedIds.has(x.id)).map(x=>String(x.id)),
     gainedAgainstCore:preTrialSelection.items.filter(x=>!coreSelectedIds.has(x.id)).map(x=>String(x.id)),
     note:'Same-run pretrial registered supplement counterfactual; no change to article scores.'
    };
    // Fix34: audit-only snapshot, no changes to thresholds, sampling or allocation.
    // Retain scores for nonselected items so a human can review false negatives.
    const assigned=new Map(allocated.items.map(x=>[x.id,x.bucket]));
    const scoringAudit=scored.map(x=>({
     inputEvidence:inputEvidenceTrace(x),
     id:String(x.id),title:String(x.title||'').slice(0,180),url:String(x.url||'').slice(0,500),
     origin:x.origin==='external'?'external':'registered',
     supplementalRecall:!!x.supplementalRecall,
     sourceMixTrialRecall:String(x.sourceMixTrialRecall||''),
     searchRoute:x.origin==='registered'?'registered':(x.discoveryLane?'exploration':(x.inferenceLane?'inferred_search':'direct')),
     queryLabel:x.origin==='external'?String(x.queryLabel||'').slice(0,70):'',
     discoveryApproach:String(x.discoveryApproach||''),searchInferenceLane:!!x.inferenceLane,searchDiscoveryLane:!!x.discoveryLane,
     explicit:Number(x.explicit),explicitRaw:Number(x.explicitRaw??x.explicit),
     explicitRelation:String(x.explicitRelation||''),explicitInterest:String(x.explicitInterest||''),
     explicitRelationGateApplied:!!x.explicitRelationGateApplied,
     inferred:Number(x.inferred),discovery:Number(x.discovery),
     published:Number(x.published)||0,timeStatus:String(x.timeStatus||'uncertain'),
     timeSensitive:!!x.timeSensitive,timeReason:String(x.timeReason||'').slice(0,100),
     timeKind:String(x.timeKind||''),timeOpportunityStatus:String(x.timeOpportunityStatus||''),timeZoneQuote:String(x.timeZoneQuote||''),timeDeadlineQuote:String(x.timeDeadlineQuote||''),
     timeDeadlineAt:String(x.timeDeadlineAt||''),timeEvidenceAccepted:!!x.timeEvidenceAccepted,
     timeMetaIssue:String(x.timeMetaIssue||''),
     timeCheckedAt:Number(x.timeCheckedAt)||0,timeBlocked:!!temporalGate(x),
     excluded:!!x.excluded,selectedBucket:assigned.get(x.id)||null,
     sameReportSuppressedBy:(allocated.storyDedup.clusters.find(g=>g.suppressed.includes(String(x.id)))?.kept)||'',
     inferredBasisType:String(x.inferredBasisType||''),inferredBasisTitle:String(x.inferredBasisTitle||'').slice(0,110),
     reason:String(x.reason||'').slice(0,240),inferredWhy:String(x.inferredWhy||'').slice(0,100),
     inferredPreference:String(x.inferredPreference||'').slice(0,95),discoveryWhy:String(x.discoveryWhy||'').slice(0,115),
     inferredHypothesisStatus:String(x.inferredHypothesisStatus||'unlabeled'),
     inferenceStatus:String(x.inferenceStatus||''),
     qualifies:{explicit:!x.excluded&&!temporalGate(x)&&x.explicit>=THRESHOLDS.explicit,
      inferred:!x.excluded&&!temporalGate(x)&&x.inferred>=THRESHOLDS.inferred,
      discovery:!x.excluded&&!temporalGate(x)&&x.discovery>=THRESHOLDS.discovery&&x.explicit<=75}
    }));
    // Compare with the old sequential assignment using exactly the same
    // candidates and Gemma scores. This comparison NEVER changes selection.
    // Compare assignment policies on the SAME deduplicated candidate set.
    const sequential=allocateSequential(deduplicateReports(scored).items,cfg.m.ratios);
    const assignments=new Map(sequential.items.map(x=>[x.id,x.bucket]));
    const assignmentDiagnostic={
     mode:'simultaneous_priority_locked',priorityOrder:['explicit','inferred','discovery'],
     priorityViolations:allocated.items.filter(x=>
      (x.bucket==='inferred'&&Number(x.explicit)>=THRESHOLDS.explicit)||
      (x.bucket==='discovery'&&(Number(x.explicit)>=THRESHOLDS.explicit||Number(x.inferred)>=THRESHOLDS.inferred))).length,
     previous:Object.fromEntries(['explicit','inferred','discovery'].map(k=>[k,sequential.counts[k].registered+sequential.counts[k].external])),
     current:Object.fromEntries(['explicit','inferred','discovery'].map(k=>[k,allocated.counts[k].registered+allocated.counts[k].external])),
     previousTotal:sequential.items.length,currentTotal:allocated.items.length,
     gained:allocated.items.length-sequential.items.length,
     overlappingCandidates:scored.filter(x=>!x.excluded&&!temporalGate(x)&&['explicit','inferred','discovery'].filter(k=>Number(x[k])>=THRESHOLDS[k]&&(k!=='discovery'||Number(x.explicit)<=75)).length>1).length,
     previouslyOtherNowExplicit:allocated.items.filter(x=>x.bucket==='explicit'&&assignments.has(x.id)&&assignments.get(x.id)!=='explicit').length,
     previouslyExplicitNowOther:allocated.items.filter(x=>x.bucket!=='explicit'&&assignments.get(x.id)==='explicit').length,
     switchedBucket:allocated.items.filter(x=>assignments.has(x.id)&&assignments.get(x.id)!==x.bucket).length
    };
    const evidenceSummary=evidenceCounts(evidence);
    const inferredEligible=scored.filter(x=>!x.excluded&&!temporalGate(x)&&Number(x.inferred)>=THRESHOLDS.inferred);
    const unsupportedHigh=scored.filter(x=>!x.excluded&&!temporalGate(x)&&!x.inferredBasisType&&Number(byId.get(x.id)?.inferred||0)>=THRESHOLDS.inferred).length;
    const inferredMax=scored.filter(x=>!x.excluded&&!temporalGate(x)).reduce((v,x)=>Math.max(v,Number(x.inferred)||0),0);
    const newCfg=config(pid);
    if(newCfg.i.updatedAt!==cfg.i.updatedAt||newCfg.e.updatedAt!==cfg.e.updatedAt||
     newCfg.m.updatedAt!==cfg.m.updatedAt||newCfg.model.updatedAt!==cfg.model.updatedAt||
     newCfg.fb!==cfg.fb||newCfg.external.generatedAt!==cfg.external.generatedAt)throw Error('生成中に設定か外部候補が変わりました。再生成してください');
    const qualifyingExplicit=scored.filter(x=>!x.excluded&&!temporalGate(x)&&x.explicit>=THRESHOLDS.explicit);
    const selectedOther=new Set(allocated.items.filter(x=>x.bucket!=='explicit').map(x=>x.id));
    const selectedExplicit=new Set(allocated.items.filter(x=>x.bucket==='explicit').map(x=>x.id));
    // Compare the actual allocation with a counterfactual explicit-only
    // selection of THE SAME scored candidates. This isolates the potential
    // impact of bucket priority without weakening semantic thresholds.
    const explicitOnly=allocate(scored,cfg.m.ratios,{explicit:QUOTAS.explicit,inferred:0,discovery:0});
    const temporalDiagnostic={assessedAt:Date.now(),
     usable:scored.filter(x=>x.timeStatus==='usable').length,
     expired:scored.filter(x=>x.timeStatus==='expired').length,
     uncertain:scored.filter(x=>x.timeStatus==='uncertain').length,
     timeSensitiveUncertain:scored.filter(x=>x.timeStatus==='uncertain'&&x.timeSensitive===true).length,
     limited:scored.filter(x=>x.timeKind==='limited').length,
     mixed:scored.filter(x=>x.timeKind==='mixed').length,
     timeCheckedCandidates:scored.filter(x=>x.timeKind!=='not_assessed').length,
     opportunityUnverified:scored.filter(x=>x.timeOpportunityStatus==='unverified').length,
     deadlineEvidenceAccepted:scored.filter(x=>!!x.timeEvidenceAccepted).length,
     futurePublished:scored.filter(x=>x.timeMetaIssue==='future_published').length,
     blocked:scored.filter(x=>!!temporalGate(x)).length,
     note:'Snapshot based only on supplied metadata; no live verification or automatic recheck.'};
    const explicitDiagnostic={eligible:qualifyingExplicit.length,
     eligibleRegistered:qualifyingExplicit.filter(x=>x.origin==='registered').length,
     eligibleExternal:qualifyingExplicit.filter(x=>x.origin==='external').length,
     selected:selectedExplicit.size,
     assignedToOther:qualifyingExplicit.filter(x=>selectedOther.has(x.id)).length,
     unselected:qualifyingExplicit.filter(x=>!selectedOther.has(x.id)&&!selectedExplicit.has(x.id)).length,
     belowThreshold:scored.filter(x=>!x.excluded&&!temporalGate(x)&&Number(x.explicit)<THRESHOLDS.explicit).length,
     excluded:scored.filter(x=>x.excluded).length,
     alonePossible:explicitOnly.counts.explicit.registered+explicitOnly.counts.explicit.external,
     publisherLimitSkipped:allocated.sourceCapSkippedByBucket.explicit||0,
     threshold:THRESHOLDS.explicit};
    const timing=Array.isArray(graded.timing)?graded.timing:[];
    const performanceAudit={generationWallMs:Date.now()-jobs.get(pid).startedAt,
     calls:timing.filter(x=>x.phase!=='temporal_cache').length,
     cachedTemporal:timing.filter(x=>x.phase==='temporal_cache').length,
     failedCalls:timing.filter(x=>x.status==='error').length,
     batches:timing,scoredCandidates:scored.length,
     semanticCalls:timing.filter(x=>x.phase==='semantic').length,temporalCalls:timing.filter(x=>x.phase==='temporal').length};
    const inputEvidenceAudit={
     counts:Object.fromEntries(['missing','headline_like','additional_text_unverified'].map(kind=>
      [kind,scoringAudit.filter(x=>x.inputEvidence.excerptKind===kind).length])),
     externalCounts:Object.fromEntries(['missing','headline_like','additional_text_unverified'].map(kind=>
      [kind,scoringAudit.filter(x=>x.origin==='external'&&x.inputEvidence.excerptKind===kind).length])),
     note:'Excerpt comparison is a heuristic of supplied text, NOT a claim about full article content or truth.'};
    // Status is Gemma's own trace, not a lexical or numeric interest rule.
    // 'pending' is a valid uncertain outcome, not a negative rating.
    const inferredHypothesisAudit={
     counts:Object.fromEntries(['hypothesis','pending','none','unlabeled'].map(k=>
      [k,scored.filter(x=>x.inferredHypothesisStatus===k).length])),
     pendingAboveThreshold:scored.filter(x=>x.inferredHypothesisStatus==='pending'&&x.inferred>=THRESHOLDS.inferred).length,
     note:'Diagnostic only. Pending is not a rejection; past positive feedback does not establish why an article was liked.'};
    const meta={target:QUOTAS,counts:allocated.counts,shortages:allocated.shortages,explicitDiagnostic,assignmentDiagnostic,temporalDiagnostic,
     inferredHypothesisAudit,selectionDiversityAudit:allocated.diversityAudit,supplementalDiagnostic,
     inputEvidenceAudit,scoringAudit,performanceAudit,sampling:candidates.sampling,
     sourceMixTrialDiagnostic:{mode:'same_run_candidate_opportunity_trial',
      baselineTotal:scored.filter(x=>!x.sourceMixTrialRecall).length,trialExtraScored:scored.filter(x=>!!x.sourceMixTrialRecall).length,
      baselineSelected:preTrialSelection.items.length,trialSelected:allocated.items.length,
      gained:allocated.items.filter(x=>!preTrialSelectedIds.has(x.id)).map(x=>({id:String(x.id),bucket:x.bucket,title:String(x.title||'').slice(0,130),origin:x.origin})),
      displaced:preTrialSelection.items.filter(x=>!finalSelectedIds.has(x.id)).map(x=>({id:String(x.id),bucket:x.bucket,title:String(x.title||'').slice(0,130),origin:x.origin})),
      sourceCounts:Object.fromEntries(['explicit','inferred','discovery'].map(k=>[k,{registered:allocated.counts[k].registered,external:allocated.counts[k].external}])),
      note:'Same-run counterfactual; quality requires manual assessment. No fixed candidate-to-role origin ratio is enforced.'},
     storyDedupDiagnostic:{mode:'conservative_headline_overlap',clusters:allocated.storyDedup.clusters,
      suppressed:allocated.storyDedup.suppressedIds.length,
      note:'Only qualified same-report candidates are collapsed before allocation. Headline overlap is heuristic, not semantic proof.'},
     discoverySearchAudit:{sparseRescue:cfg.external.qualityStats?.sparseRescue||null,topics:(cfg.external.qualityStats?.discoveryTopics||[]).map(x=>({
      topic:String(x.topic||'').slice(0,60),approach:String(x.approach||'legacy'),hook:String(x.bridge||'').slice(0,100)})),
      recentTopicCount:(cfg.external.qualityStats?.recentDiscoveryTopics||[]).length,
      collectedAt:Number(cfg.external.generatedAt)||0,
      searchSemanticAudit:cfg.external.qualityStats?.searchSemanticAudit||null,
      inferenceHypotheses:Array.isArray(cfg.external.qualityStats?.inferenceHypotheses)?cfg.external.qualityStats.inferenceHypotheses.map(x=>({topic:String(x.topic||'').slice(0,80),basis:String(x.basis||'').slice(0,100)})):[],
      queryAudit:Array.isArray(cfg.external.qualityStats?.queryAudit)?cfg.external.qualityStats.queryAudit.map(x=>({
       topic:String(x.topic||'').slice(0,80),lane:['direct','inferred_search','discovery'].includes(x.lane)?x.lane:'unknown',
       ...Object.fromEntries(['rssItems','considered','collected','skippedRegisteredHost',
        'skippedKnownOrInvalid','qualityApproved','semanticInspected','semanticDirect','semanticAdjacent','semanticUnrelated','semanticUncertain','semanticUnavailable','semanticNotInspected','cacheSelected','afterExclusion','stored'].map(k=>[k,Number(x[k])||0])),
       requestFailed:!!x.requestFailed,rescue:!!x.rescue,
       semanticExamples:Array.isArray(x.semanticExamples)?x.semanticExamples.slice(0,5).map(e=>({relation:String(e.relation||''),title:String(e.title||'').slice(0,160),why:String(e.why||'').slice(0,120)})):[],
       scored:candidates.filter(c=>c.origin==='external'&&String(c.queryLabel||'')===String(x.topic||'')&&
        (c.discoveryLane?'discovery':(c.inferenceLane?'inferred_search':'direct'))===x.lane).length
      })):null},
     inspected:candidates.length,discoveryPool:candidates.filter(x=>x.discoveryLane).length,externalAvailable:cfg.external.qualityApplied,
     sourceCap:allocated.sourceCap,sourceCapSkipped:allocated.sourceCapSkipped,
     exclusionMode:cfg.external.exclusionMode||'none',inferredEvidence:evidence.length,
     inferredDiagnostic:{...evidenceSummary,threshold:THRESHOLDS.inferred,
      eligible:inferredEligible.length,
      eligibleAfterPriority:inferredEligible.filter(x=>Number(x.explicit)<THRESHOLDS.explicit).length,
      topScore:inferredMax,
      unsupportedHigh,
      selected:allocated.counts.inferred.registered+allocated.counts.inferred.external,
      unavailable:scored.filter(x=>x.inferenceStatus==='unavailable').length,
      candidateRegistered:candidates.filter(x=>x.origin==='registered').length,
      candidateExternal:candidates.filter(x=>x.origin==='external').length,
      evidenceRecallRegistered:candidates.filter(x=>x.origin==='registered'&&x.evidenceRecall).length,
      evidenceRecallExternal:candidates.filter(x=>x.origin==='external'&&x.evidenceRecall).length},
     notice:!cfg.external.qualityApplied?'登録外のメタ情報検査済み候補がありません。先に「登録外の記事を探す」を実行してください。':''};
    db.prepare(`INSERT INTO ai_blend_cache(profile_id,kind,model,items_json,meta_json,generated_at,interest_stamp,exclusion_stamp,feedback_stamp,mix_stamp,external_stamp,model_stamp)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,kind) DO UPDATE SET
     model=excluded.model,items_json=excluded.items_json,meta_json=excluded.meta_json,generated_at=excluded.generated_at,
     interest_stamp=excluded.interest_stamp,exclusion_stamp=excluded.exclusion_stamp,feedback_stamp=excluded.feedback_stamp,
     mix_stamp=excluded.mix_stamp,external_stamp=excluded.external_stamp,model_stamp=excluded.model_stamp`)
     .run(pid,'rss',cfg.model.model,JSON.stringify(allocated.items),JSON.stringify(meta),Date.now(),cfg.i.updatedAt,cfg.e.updatedAt,cfg.fb,
       cfg.m.updatedAt,cfg.external.generatedAt||0,cfg.model.updatedAt);
   }catch(e){failures.set(pid,String(e.message||e).slice(0,180))}
   finally{const job=jobs.get(pid);if(job){job.status=failures.has(pid)?'error':'complete';job.stage=job.status;job.finishedAt=Date.now();job.previewItems=[]}running.delete(pid)}
  });
  return {started:true,running:true};
 }
 return {status,start,allocate};
}
module.exports={create,allocate,QUOTAS,LABELS};
