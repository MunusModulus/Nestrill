'use strict';
// Nestrill Fix80: conservative, source-grounded RSS excerpt refinement.
// Operates in memory after the original parseFeed (Fix73); does NOT fetch URLs,
// update SQLite, discard articles, change GUIDs, or alter timestamps.
// Only replaces an excerpt when the original is navigation/headline-only, or
// removes a clearly delimited related-link tail.
const names = new Set(['summary','description','content:encoded','content']);
function first(node,name){return node?.children?.find(x=>x.name===name || (name.indexOf(':')<0 && x.name.split(':').pop()===name));}
function all(node,name){return node?.children?.filter(x=>x.name===name || (name.indexOf(':')<0 && x.name.split(':').pop()===name))||[];}
function field(item,name){const n=item?.children?.find(x=>x.name===name);if(!n)return '';return textOf(n).trim();}
function textOf(n){
 if(!n)return '';
 // For normal HTML-in-CDATA, parts already contain the complete text. A nested
 // XHTML Atom <content> may carry child elements instead; this is a fallback.
 if(n.parts?.some(x=>String(x).trim()))return n.parts.join('');
 return (n.children||[]).map(textOf).join(' ');
}
function plainText(s,plain){return String(plain(s)||'').replace(/\s+/g,' ').trim().slice(0,360)}
function normalized(s){return String(s||'').normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu,'')}
function isNavigation(s){return /^(?:続きを読む|続き(?:を読む|はこちら|を表示)|もっと見る|read\s+more|continue\s+reading|詳細(?:はこちら|を見る)|記事を読む)[\s.!。…»›＞>]*$/iu.test(String(s||'').trim())}
function isHeadlineOnly(title,text){const a=normalized(title),b=normalized(text);return !!a&&a===b;}
// Marker must explicitly signal a separate *related articles* section. Never
// erase free prose just because it shares a word with another topic.
const RELATED=/(?:^|[\s。.!?！？])(?:※\s*関連記事|関連記事\s*[:：]|あわせて読みたい\s*[:：]?|こちらもおすすめ\s*[:：])\s*/u;
function clipRelated(s){
 const match=RELATED.exec(s);
 if(!match)return {text:s,removed:false};
 // The marker boundary may be sentence-ending punctuation; keep it.
 const boundary=match[0][0];
 const before=(s.slice(0,match.index)+(/[。.!?！？]/u.test(boundary)?boundary:'')).trimEnd();
 // Preserve content when a marker appears as the subject itself or when the
 // preceding article information is too short to trust.
 if(before.length<18)return {text:s,removed:false};
 return {text:before,removed:true};
}
function entriesOf(xmlTree,xml){
 const doc=xmlTree(xml),root=doc?.children?.find(x=>['feed','rss','rdf','rdf:rdf'].includes(x.name));
 if(!root)return [];
 const atom=root.name==='feed';const chan=first(root,'channel')||root;
 return atom?all(root,'entry'):(all(chan,'item').length?all(chan,'item'):all(root,'item'));
}
function substantive(s,title){return !!s && s.length>=30 && !isNavigation(s) && !isHeadlineOnly(title,s)}
function refine({xml,parsed,xmlTree,plain}){
 // Fail open: never prevent RSS display because a metadata improvement fails.
 try{
  if(!parsed?.items?.length || typeof xml!=='string'|| typeof xmlTree!=='function'||typeof plain!=='function')return parsed;
  // Avoid parsing the same XML twice on feeds whose existing excerpts are
  // already substantive and contain no explicit related-story divider.
  if(parsed.items.every(item=>substantive(String(item.excerpt||''),item.title) && !RELATED.test(String(item.excerpt||''))))return parsed;
  const nodes=entriesOf(xmlTree,xml);
  // Original parseFeed may skip malformed entries with no GUID/URL. If the
  // original and parsed sequences differ, leave the entire feed untouched.
  if(nodes.length!==parsed.items.length)return parsed;
  for(let i=0;i<parsed.items.length;i++){
   const item=parsed.items[i],node=nodes[i];
   const before=String(item.excerpt||'');
   const section=clipRelated(before);
   let next=section.text;
   // Prefer independent content only if the primary summary is unusable.
   // Avoid replacing useful headlines, article metadata, or short valid prose.
   // A short but independent passage is better than a navigation stub.
   // Do NOT replace a usable current excerpt merely to expand its length.
   const currentUnusable=!next.trim()||isNavigation(next)||isHeadlineOnly(item.title,next);
   if(!substantive(next,item.title)){
    let shortIndependent='';
    for(const key of ['content:encoded','content','description','summary']){
     const value=field(node,key);
     if(!value)continue;
     const view=clipRelated(plainText(value,plain));
     if(substantive(view.text,item.title)){
      if(currentUnusable)next=view.text;
      break;
     }
     if(currentUnusable&&!shortIndependent&&view.text&&!isNavigation(view.text)&&!isHeadlineOnly(item.title,view.text))
      shortIndependent=view.text;
    }
    if(currentUnusable&&(isNavigation(next)||isHeadlineOnly(item.title,next)||!next.trim())&&shortIndependent)
     next=shortIndependent;
   }
   // Clip an explicit related section or replace a truly unusable original.
   // A short valid original is not discarded just for being short.
   if(next!==before && (section.removed || (currentUnusable&&next.trim()&&!isNavigation(next)&&!isHeadlineOnly(item.title,next)))){
    item.excerpt=next.slice(0,360);
   }
  }
 }catch{/* Original parseFeed remains authoritative on any extraction fault. */}
 return parsed;
}
module.exports={refine,clipRelated,isNavigation,isHeadlineOnly};
