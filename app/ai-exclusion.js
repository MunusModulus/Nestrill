'use strict';
// Text mechanics only: NO vocabulary, synonym, topic, or product dictionary.
// Latin tokens need alphanumeric boundaries ("AI" must not match "chair").
// Japanese phrases are matched as a contiguous literal string; semantic matches
// and paraphrases are delegated to the explicitly selected local AI model.
function titleMatchesExclusion(title,terms){
 const value=String(title||'').toLocaleLowerCase();
 return terms.some(raw=>{
  const term=String(raw||'').trim().toLocaleLowerCase();
  if(!term)return false;
  if(/^[\x00-\x7f]+$/.test(term)&&/[a-z0-9]/.test(term)){
   const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   const re=new RegExp('(?<![a-z0-9])'+escaped+'(?![a-z0-9])','iu');
   return re.test(value);
  }
  return value.includes(term);
 });
}
module.exports={titleMatchesExclusion};
