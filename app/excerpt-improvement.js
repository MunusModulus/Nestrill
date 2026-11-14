'use strict';
// Fix82: conservative, same-GUID RSS excerpt repair during normal feed refresh.
// No external fetch, semantic inference, timestamp edits, or profile edits.
const {inspect}=require('./ai-input-evidence');
const {clipRelated}=require('./feed-excerpt-refiner');
function usable(text,title){
 const view=inspect({title,excerpt:text});
 return view.scope==='publisher_excerpt_unverified'&&!!view.excerpt.trim();
}
function shouldRepairExcerpt(oldExcerpt,newExcerpt,title){
 const old=String(oldExcerpt||''),next=String(newExcerpt||'');
 if(!next||old===next||!usable(next,title))return false;
 const oldView=inspect({title,excerpt:old});
 // A saved headline echo, a navigation stub or an empty excerpt supplies no
 // independent evidence. A NEW independent publisher excerpt can replace it.
 if(['no_excerpt','navigation_only','headline_only'].includes(oldView.scope))return true;
 // Only allow clipping an explicit related-article section when the exact
 // retained prefix is present in the same GUID's next excerpt.
 const clipped=clipRelated(old);
 return clipped.removed&&clipped.text===next;
}
module.exports={shouldRepairExcerpt,usable};
