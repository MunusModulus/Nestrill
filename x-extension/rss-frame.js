'use strict';
// No cross-origin DOM access. The Nestrill page fetches data from its own origin.
const target=document.getElementById('rss');
target.addEventListener('load',()=>{document.getElementById('loader').textContent='Nestrillフレーム読込完了（内容の表示は未判定）';
  setTimeout(()=>{const l=document.getElementById('loader');if(l)l.hidden=true;},2500);});
target.src='http://127.0.0.1:8767/';
