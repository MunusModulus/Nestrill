'use strict';
// Lightweight XML reader for RSS 2.0, RDF/RSS 1.0, Atom and OPML.
// No DTD/entity expansion; never renders HTML from feeds.
const entities = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', raquo:'»', laquo:'«', hellip:'…', mdash:'—', ndash:'–', copy:'©', reg:'®', trade:'™', rsquo:'’', lsquo:'‘', ldquo:'“', rdquo:'”', bull:'•', middot:'·'};
function decode(text='') {
  return String(text).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g,(m,e)=> {
    if(e[0]==='#') {const n=e[1]?.toLowerCase()==='x'?parseInt(e.slice(2),16):parseInt(e.slice(1),10);return n>0 && n<=0x10ffff && !(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'�';}
    return Object.prototype.hasOwnProperty.call(entities,e)?entities[e]:m;
  });
}
function xmlTree(raw) {
  if (typeof raw!=='string' || raw.length>5_000_000) throw Error('XMLのサイズが大きすぎます');
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw Error('DTDを含むXMLには対応していません');
  const root={name:'#document',attrs:{},children:[],parts:[]};
  const stack=[root];
  const re=/<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<\?[^]*?\?>|<\![^>]*>|<\/[^>]+>|<(?:"[^"]*"|'[^']*'|[^'">])*?>|[^<]+/g;
  let token;
  while((token=re.exec(raw))){
    const s=token[0]; const curr=stack[stack.length-1];
    if(s.startsWith('<!--')||s.startsWith('<?')||s.startsWith('<!')&&!s.startsWith('<![CDATA['))continue;
    if(s.startsWith('<![CDATA[')){curr.parts.push(s.slice(9,-3));continue;}
    if(s.startsWith('</')){if(stack.length>1)stack.pop();continue;}
    if(s[0]==='<'){
      const m=/^<([^\s/>]+)([^]*?)\/?\s*>$/.exec(s);if(!m)continue;
      const attrs={};
      const rx=/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;let a;
      while((a=rx.exec(m[2])))attrs[a[1].toLowerCase()]=decode(a[2]??a[3]);
      const child={name:m[1].toLowerCase(),attrs,children:[],parts:[]};curr.children.push(child);
      if(!/\/\s*>$/.test(s))stack.push(child);
    }else curr.parts.push(decode(s));
  }
  return root;
}
const first=(node,name)=>node?.children.find(x=>x.name===name || x.name.split(':').pop()===name);
const all=(node,name)=>node?.children.filter(x=>x.name===name || x.name.split(':').pop()===name)||[];
function txt(node){return node?node.parts.join('').trim():'';}
function field(node, names){for(const name of names){const f=first(node,name);if(f){const v=txt(f);if(v)return v;}}return '';}
function plain(html){return decode(String(html||'').replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim()).slice(0,1100);}
// Preserve meaningful source-supplied article text before semantic evaluation.
// RSS descriptions are often CDATA, while Atom XHTML embeds text in child
// nodes. This is a bounded plain-text extraction: never render feed HTML.
function nestedText(node, depth=0){
 if(!node||depth>12||/^(script|style)$/i.test(node.name||''))return '';
 return [txt(node),...(node.children||[]).map(x=>nestedText(x,depth+1))]
  .filter(Boolean).join(' ');
}
function articleExcerpt(item){
 const names=['summary','description','content:encoded','content'];
 const alternatives=[];
 for(const name of names){
  const node=first(item,name);
  if(!node)continue;
  const raw=(node.children&&node.children.length)?nestedText(node):txt(node);
  const cleaned=plain(raw);
  if(cleaned)alternatives.push(cleaned);
 }
 if(!alternatives.length)return '';
 // Honor the publisher's summary unless it contains effectively no usable
 // article evidence and the same feed supplies a substantially richer field.
 // This never fetches websites and never changes the semantic threshold.
 const firstText=alternatives[0];
 if(firstText.length>=28)return firstText.slice(0,360);
 const richer=alternatives.find(x=>x.length>=80&&x.length>=firstText.length+50);
 return (richer||firstText).slice(0,360);
}
// YouTube Atom stores its video synopsis inside media:group/media:description,
// not in an entry-level summary/description. Do not alter regular RSS excerpts.
// Accept only the known public YouTube channel Atom URL; never fetch a video page.
function youtubeAtomExcerpt(item,sourceUrl){
  let u;try{u=new URL(sourceUrl)}catch{return ''}
  if(u.protocol!=='https:'||u.hostname!=='www.youtube.com'||u.pathname!=='/feeds/videos.xml'||
     !/^UC[A-Za-z0-9_-]{22}$/.test(u.searchParams.get('channel_id')||''))return '';
  const group=item?.children.find(x=>x.name==='media:group');
  const description=group?.children.find(x=>x.name==='media:description');
  if(!description)return '';
  return plain(nestedText(description)).slice(0,360);
}
function normalizeUrl(value,base){try{const u=new URL(String(value||''),base);if(!['http:','https:'].includes(u.protocol))return '';u.hash='';return u.toString();}catch{return '';}}
function pickLink(node,base){
 const links=all(node,'link');
 for(const l of links){if(l.attrs.href && (!l.attrs.rel||l.attrs.rel==='alternate'))return normalizeUrl(l.attrs.href,base);}
 for(const l of links){if(l.attrs.href)return normalizeUrl(l.attrs.href,base);}
 return normalizeUrl(txt(links[0]),base);
}
function imageOf(item,base){
 const media=item.children.find(x=>['media:thumbnail','media:content','thumbnail'].includes(x.name)&&x.attrs.url&&(!x.attrs.type||x.attrs.type.startsWith('image/')));
 if(media){const u=normalizeUrl(media.attrs.url,base);if(u)return u;}
 const enclosure=first(item,'enclosure');if(enclosure?.attrs.url && (!enclosure.attrs.type||enclosure.attrs.type.startsWith('image/')))return normalizeUrl(enclosure.attrs.url,base);
 const html=field(item,['content:encoded','description','summary','content']);
 const m=/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(html);
 return m?normalizeUrl(decode(m[1]||m[2]||m[3]),base):'';
}
function parseFeed(xml,sourceUrl){
 const root=xmlTree(xml); const feed=first(root,'feed')||first(root,'rss')||first(root,'rdf')||first(root,'rdf:rdf');
 if(!feed)throw Error('RSS/Atomフィードではありません');
 const atom=feed.name==='feed';const chan=first(feed,'channel')||feed;
 const items=atom?all(feed,'entry'):(all(chan,'item').length?all(chan,'item'):all(feed,'item')); 
 const title=plain(field(chan,['title']))||sourceUrl;
 const siteUrl=pickLink(chan,sourceUrl);
 const out=[];
 for(const item of items.slice(0,250)){
   const url=pickLink(item,siteUrl||sourceUrl);
   const itemTitle=plain(field(item,['title']))||'(タイトルなし)';
   const id=field(item,['guid','id'])||url;
   if(!id&&!url)continue;
   const date=field(item,['published','pubdate','updated','dc:date','date']);
   const parsed=Date.parse(date);
   out.push({guid:String(id).slice(0,1500),url,title:itemTitle.slice(0,500),excerpt:(articleExcerpt(item)|| (atom?youtubeAtomExcerpt(item,sourceUrl):'')),thumbnail:imageOf(item,siteUrl||sourceUrl),published: Number.isFinite(parsed)&&parsed>0 ? parsed : Date.now()});
 }
 return {title,siteUrl,items:out};
}
function parseOpml(xml){
 const root=xmlTree(xml);const opml=first(root,'opml');const body=first(opml,'body');
 if(!body)throw Error('OPMLのbodyが見つかりません');
 const result=[];
 function walk(node,parts){
   for(const x of all(node,'outline')){
     const url=x.attrs.xmlurl||x.attrs['xmlurl'];
     if(url){result.push({url,title:x.attrs.title||x.attrs.text||'',category:parts.join(' / ')||'未分類'});}
     else{const title=(x.attrs.title||x.attrs.text||'').trim();walk(x,title?[...parts,title]:parts);}
   }
 }
 walk(body,[]);return result;
}
function escapeXml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));}
module.exports={parseFeed,parseOpml,xmlTree,escapeXml,normalizeUrl,plain,decode};

// Nestrill Fix80 (reversible, conservative RSS excerpt refinement).
// The original parseFeed remains the canonical parser for all metadata.
const _fix80OriginalParseFeed = module.exports.parseFeed;
module.exports.parseFeed = function fix80ParseFeed(xml, sourceUrl) {
  const parsed = _fix80OriginalParseFeed(xml, sourceUrl);
  return require('./feed-excerpt-refiner').refine({xml,parsed,xmlTree:module.exports.xmlTree,plain:module.exports.plain});
};
