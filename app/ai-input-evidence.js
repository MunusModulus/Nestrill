'use strict';
// Evidence provenance for AI prompts, not a topic or article quality verdict.
// Never fetch pages, make a relevance decision, or modify stored RSS content.
const squash=s=>String(s||'').normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');
function publisherOf(source){return String(source||'').replace(/（Googleニュース経由）$/u,'').normalize('NFKC').trim();}
function withoutPublisher(value,publisher){
 const s=String(value||'').normalize('NFKC').trim(),p=publisherOf(publisher);
 if(!p||!s.endsWith(p))return s;
 const head=s.slice(0,-p.length);
 // Only remove a verified complete trailing publisher, separated by whitespace,
 // a dash or a pipe. Never strip arbitrary trailing words or numeric claims.
 if(!/(?:\s+[-—–|｜]\s*|\s{2,})$/u.test(head))return s;
 return head.replace(/(?:\s+[-—–|｜]\s*|\s{2,})$/u,'').trim();
}
function inspect({title='',excerpt='',source=''}={}){
 const titleInput=String(title||'').slice(0,170);
 const raw=String(excerpt||'').slice(0,220);
 const text=raw.trim();
 if(!text)return {title:titleInput,excerpt:'',scope:'no_excerpt',rawChars:raw.length,relatedRemoved:false};
 if(/^(?:続きを読む|続き(?:を読む|はこちら|を表示)|もっと見る|read\s+more|continue\s+reading|詳細を見る|記事を読む)[\s.!。…»›＞>]*$/iu.test(text))
  return {title:titleInput,excerpt:'',scope:'navigation_only',rawChars:raw.length,relatedRemoved:false};
 // Match exact publisher-stripped headline repetition. A Google News RSS
 // description can be only `title    publisher`; it is not independent text.
 const publisher=publisherOf(source);
 const a=squash(withoutPublisher(titleInput,publisher));
 const b=squash(withoutPublisher(text,publisher));
 if(a&&b&&a===b)return {title:titleInput,excerpt:'',scope:'headline_only',rawChars:raw.length,relatedRemoved:false};
 // Clip explicit related-story/navigation sections. Do not guess whether
 // unmarked content is unrelated or rewrite the publisher's substantive text.
 const marker=/(?:\s+|^)(?:※\s*関連記事|関連(?:記事|リンク)\s*[:：])/u.exec(raw);
 const cut=marker?raw.slice(0,marker.index).trimEnd():raw;
 if(!cut.trim())return {title:titleInput,excerpt:'',scope:'navigation_only',rawChars:raw.length,relatedRemoved:!!marker};
 return {title:titleInput,excerpt:cut,scope:'publisher_excerpt_unverified',rawChars:raw.length,relatedRemoved:!!marker};
}
module.exports={inspect};
