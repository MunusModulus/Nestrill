'use strict';
// ConditionTrial-only diversity helpers. No preferences are inferred or scored here.
// Lexical heuristics are conservative: related topics may survive, and different
// news events must not be merged merely because they mention the same franchise.
const quality=require('./ai-source-quality');
const segmenter=new Intl.Segmenter('ja',{granularity:'word'});
function tokens(value){
 const text=String(value||'').normalize('NFKC').toLocaleLowerCase();
 return [...new Set([...segmenter.segment(text)]
  .filter(x=>x.isWordLike).map(x=>x.segment.trim())
  .filter(x=>x.length>=3 && !/^\d+$/.test(x)))];
}
function overlap(a,b){
 const ta=new Set(tokens(a)),tb=new Set(tokens(b));
 const shared=[...ta].filter(t=>tb.has(t));
 return {shared, count:shared.length, a:ta.size,b:tb.size};
}
function similarLikedSubjects(a,b){
 // Protect different publications about the same clearly named subject,
 // without treating a generic word such as "研究" as an event identifier.
 const left=quality.normalizedTitle(a),right=quality.normalizedTitle(b);
 if(quality.nearDuplicate(a,b))return true;
 const x=overlap(a,b);
 return x.count>=2 && (x.count/Math.min(x.a||1,x.b||1)>=0.35);
}
function chooseLikedAnchors(rows,limit=8){
 const valid=rows.filter(x=>x&&typeof x.title==='string'&&x.title.trim());
 if(!valid.length)return [];
 // First pass: favor different subject areas, most recent first.
 const chosen=[],extras=[];
 for(const item of valid){
  if(chosen.some(old=>similarLikedSubjects(old.title,item.title)))extras.push(item);
  else chosen.push(item);
  if(chosen.length>=limit)break;
 }
 // A narrow interest set is still valid; do not fabricate other interests.
 return chosen;
}
function similarSearchTopics(a,b){
 const x=overlap(a,b);
 // A shared distinctive Japanese/Latin topic root is sufficient to avoid
 // querying multiple variations of the same general subject in one run.
 return x.shared.some(t=>t.length>=4) || x.count>=2;
}
function distinctLikedQueries(queries,limit=4){
 const out=[],seenSources=new Set();
 for(const row of queries){
  if(!row||typeof row.topic!=='string'||typeof row.source_id!=='string')continue;
  if(seenSources.has(row.source_id))continue;
  if(out.some(old=>similarSearchTopics(old.topic,row.topic)))continue;
  out.push(row);seenSources.add(row.source_id);
  if(out.length>=limit)break;
 }
 return out;
}
function differentNumbers(a,b){
 // Distinct numbered versions and dates are particularly unsafe to conflate.
 const nums=x=>[...String(x).matchAll(/\d+(?:\.\d+)*/g)].map(m=>m[0]).sort();
 return JSON.stringify(nums(a))!==JSON.stringify(nums(b));
}
function sameReportedEvent(a,b){
 if(quality.nearDuplicate(a.title,b.title,a.source,b.source))return true;
 const ta=quality.normalizedTitle(a.title,a.source),tb=quality.normalizedTitle(b.title,b.source);
 if(differentNumbers(ta,tb))return false;
 // Must share at least three significant word segments. "ドラクエ コラボ" alone
 // is not enough to suppress news about two different collaboration partners.
 const x=overlap(ta,tb);
 return x.count>=3 && x.count/Math.min(x.a||1,x.b||1)>=0.58;
}
module.exports={tokens,overlap,chooseLikedAnchors,similarLikedSubjects,similarSearchTopics,distinctLikedQueries,sameReportedEvent};
