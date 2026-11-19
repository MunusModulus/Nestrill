'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const repeat=require('./app/ai-e2-history-repeat');
const semantic=require('./app/ai-semantic');
const ext=fs.readFileSync(require.resolve('./app/ai-external'),'utf8');
const old={title:'AMD RX 9060 XTが正式発表。搭載メモリ16GBと発売日を公開',url:'https://example.jp/tech/rx9060',excerpt:'AMDがRX 9060 XTを発表。発売日は6月。'};
const sameUrl={id:'a',title:'AMD Radeon RX 9060 XT 正式発表について',url:'https://example.jp/tech/rx9060#section',excerpt:''};
const sameTitle={id:'b',title:old.title,url:'https://other.jp/amd/article',excerpt:''};
const review={id:'c',title:'AMD RX 9060 XTを実機レビュー。ゲームで性能を比較',url:'https://example.jp/review',excerpt:'新しいベンチマークを測定'};
const rephrase={id:'d',title:'AMD RX 9060 XTの正式発表、搭載メモリ16GBを明らかに',url:'https://example.jp/rewrite',excerpt:'発表内容を報告'};
const unrelated={id:'e',title:'リンゴ農家が収穫量を報告しました',url:'https://example.jp/apple',excerpt:''};
(async()=>{
 let r=repeat.shortlist([sameUrl,sameTitle,review,rephrase,unrelated],[old]);
 assert.equal(r.fixed.size,2);assert.equal(r.reasons.url,1);assert.equal(r.reasons.title,1);
 assert.ok(r.pairs.some(x=>x.id==='d'));assert.ok(!r.pairs.some(x=>x.id==='e'));
 let calls=0;
 let result=await repeat.removeRatedRepeats({candidates:[sameUrl,sameTitle,review,rephrase,unrelated],history:[old],model:'mock',judge:async({pairs})=>{
  calls++;return {items:pairs.map(x=>({id:x.id,relation:x.id==='d'?'same':x.id==='c'?'different':'uncertain'}))};
 }});
 assert.deepEqual(result.items.map(x=>x.id),['c','e']);assert.equal(calls,1);
 assert.equal(result.stats.exactUrl,1);assert.equal(result.stats.exactTitle,1);assert.equal(result.stats.aiSame,1);
 // Gemini/Gemma unavailable, malformed or uncertain -> keep the article.
 result=await repeat.removeRatedRepeats({candidates:[review,rephrase],history:[old],model:'mock',judge:async()=>{throw Error('offline')}});
 assert.deepEqual(result.items.map(x=>x.id),['c','d']);
 result=await repeat.removeRatedRepeats({candidates:[review,rephrase],history:[old],model:''});
 assert.deepEqual(result.items.map(x=>x.id),['c','d']);
 result=await repeat.removeRatedRepeats({candidates:[review],history:[old],model:'mock',maxPairs:0,judge:async()=>{throw Error('called')}});
 assert.equal(result.items.length,1);
 // Model response mapping uses abbreviated IDs, and cannot delete an article
 // when the output is incomplete, invalid, or says 'uncertain'.
 const originalFetch=global.fetch;
 try{
  global.fetch=async(_url,{body})=>{
   const payload=JSON.parse(body);assert.equal(payload.messages.length,2);
   const ids=JSON.parse(payload.messages[1].content).comparisons.map(x=>x.id);
   assert.deepEqual(ids,['0','1']);
   return {ok:true,headers:new Headers(),text:async()=>JSON.stringify({message:{content:JSON.stringify({items:[
    {id:'0',relation:'different'}, {id:'1',relation:'same'}]})}})};
  };
  const compared=await semantic.compareRatedE2Reports({model:'gemma4:e4b-it-qat',pairs:[
   {id:'c',oldArticle:old,newArticle:review},{id:'d',oldArticle:old,newArticle:rephrase}]});
  assert.deepEqual(compared.items,[{id:'c',relation:'different'},{id:'d',relation:'same'}]);
 }finally{global.fetch=originalFetch}
 assert.match(ext,/ratedHistoryRepeats/);
 assert.match(ext,/history:ratedHistory/);
 assert.match(ext,/await ratedRepeat\.removeRatedRepeats/);
 assert.match(ext,/gated\.items=repeated\.items/);
 assert.match(ext,/rescueGated\.items=rescueRepeats\.items/);
 console.log('PASS: 14 assertions groups: url/title, ambiguity, fail-open, model mapping, E2 integration');
})().catch(e=>{console.error(e);process.exitCode=1});
