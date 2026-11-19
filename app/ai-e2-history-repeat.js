'use strict';
// E2 only. Compare new Google News RSS candidates against profile-local,
// explicitly rated historical articles. No glossary, score adjustments, or
// new search topics. A doubtful comparison MUST preserve the new article.
const quality=require('./ai-source-quality');
const MAX_AI_PAIRS=6;
function normalize(t){return quality.normalizedTitle(t||'')}
function grams(s){const out=new Set();for(let i=0;i+3<=s.length;i++)out.add(s.slice(i,i+3));return out}
function numberConflict(a,b){
 const x=[...String(a||'').normalize('NFKC').matchAll(/[0-9]+/g)].map(m=>m[0]);
 const y=[...String(b||'').normalize('NFKC').matchAll(/[0-9]+/g)].map(m=>m[0]);
 return x.length>0&&y.length>0&&JSON.stringify(x)!==JSON.stringify(y);
}
function proximity(a,b){
 if(numberConflict(a,b))return 0;
 const left=normalize(a),right=normalize(b);
 if(left.length<16||right.length<16)return 0;
 const x=grams(left),y=grams(right);let common=0;
 for(const g of x)if(y.has(g))common++;
 if(common<4)return 0;
 return 2*common/(x.size+y.size);
}
function definiteMatch(a,b){
 const u1=quality.urlKey(a.url),u2=quality.urlKey(b.url);
 if(u1&&u2&&u1===u2)return 'url';
 const t1=normalize(a.title),t2=normalize(b.title);
 if(t1.length>=18&&t1===t2)return 'title';
 return '';
}
function shortlist(candidates,history,maxPairs=MAX_AI_PAIRS){
 const fixed=new Set(),reasons={url:0,title:0};
 const candidatesForAI=[];const eligible=[];
 for(const candidate of candidates){
  let match='';
  for(const old of history){if((match=definiteMatch(candidate,old)))break}
  if(match){fixed.add(String(candidate.id));reasons[match]++;continue}
  eligible.push(candidate);
  let best=null;
  for(const old of history){
   const score=proximity(candidate.title,old.title);
   if(score<0.24)continue;
   if(!best||score>best.score)best={score,old};
  }
  if(best)candidatesForAI.push({id:String(candidate.id),newArticle:candidate,oldArticle:best.old,score:best.score});
 }
 // Keep output independent of the retrieval order for capped model candidates.
 candidatesForAI.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id,'en'));
 return {eligible,fixed,reasons,pairs:candidatesForAI.slice(0,maxPairs),notCompared:Math.max(0,candidatesForAI.length-maxPairs)};
}
async function removeRatedRepeats({candidates,history,judge,model,maxPairs=MAX_AI_PAIRS}){
 const stats={ratedHistory:history.length,exactUrl:0,exactTitle:0,aiCompared:0,aiSame:0,aiDistinct:0,aiUncertain:0,aiUnavailable:0,notCompared:0};
 if(!candidates.length||!history.length)return {items:candidates,stats};
 const plan=shortlist(candidates,history,maxPairs);
 stats.exactUrl=plan.reasons.url;stats.exactTitle=plan.reasons.title;stats.notCompared=plan.notCompared;
 const suppressed=new Set(plan.fixed);
 if(plan.pairs.length&&model&&typeof judge==='function'){
  try{
   const result=await judge({model,pairs:plan.pairs});
   const ids=new Set(plan.pairs.map(x=>x.id));const seen=new Set();
   for(const row of result?.items||[]){
    if(!ids.has(String(row?.id))||seen.has(String(row?.id)))continue;
    seen.add(String(row.id));stats.aiCompared++;
    if(row.relation==='same'&&!numberConflict(plan.pairs.find(p=>p.id===String(row.id)).newArticle.title,plan.pairs.find(p=>p.id===String(row.id)).oldArticle.title)){suppressed.add(String(row.id));stats.aiSame++}
    else if(row.relation==='different')stats.aiDistinct++;
    else stats.aiUncertain++;
   }
   stats.aiUnavailable=plan.pairs.length-seen.size;
  }catch{stats.aiUnavailable=plan.pairs.length}
 }else stats.aiUnavailable=plan.pairs.length;
 return {items:candidates.filter(x=>!suppressed.has(String(x.id))),stats};
}
module.exports={normalize,definiteMatch,numberConflict,proximity,shortlist,removeRatedRepeats,MAX_AI_PAIRS};
