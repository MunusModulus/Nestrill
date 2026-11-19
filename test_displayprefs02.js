'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const path=require('path');
const script=fs.readFileSync(path.join(__dirname,'app/public/app.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'app/public/style.css'),'utf8');
const start=script.indexOf('const LEAD_TEXT_PREF_KEY=');
const end=script.indexOf('function applyAiActionMode()',start);
assert(start>0&&end>start,'display prefs code present');
const prefsSrc=script.slice(start,end);
function sim(store){
 const classes=new Set();const state={};
 const context={state,localStorage:{getItem:k=>store.get(k)||null},document:{documentElement:{classList:{toggle:(c,on)=>on?classes.add(c):classes.delete(c)}}}};
 vm.runInNewContext(prefsSrc+'\napplyDisplayPreferences();\n',context);
 return {state,classes,apply:()=>vm.runInNewContext('applyDisplayPreferences()',context)};
}
let obj=sim(new Map());
assert(obj.state.showLeadText&&obj.state.showSidebarCounts);
assert(!obj.classes.has('nestrill-hide-lead-text')&&!obj.classes.has('nestrill-hide-sidebar-counts'));
obj.state.showLeadText=false;obj.state.showSidebarCounts=false;obj.apply();
assert(obj.classes.has('nestrill-hide-lead-text')&&obj.classes.has('nestrill-hide-sidebar-counts'));
obj=sim(new Map([['nestrill-show-lead-text','0'],['nestrill-show-sidebar-counts','0']]));
assert(!obj.state.showLeadText&&!obj.state.showSidebarCounts);
assert(obj.classes.has('nestrill-hide-lead-text')&&obj.classes.has('nestrill-hide-sidebar-counts'));
for(const s of ['.article-excerpt-inline','.article-excerpt,','.ai-preview-excerpt','.e2-compact-excerpt','.e2-excerpt-detail','.e2-excerpt-only-details','#sidebar .count','#sidebar #youtube-source-count','#sidebar #mail-source-count','#sidebar .source-account-total'])assert(css.includes(s),s);
for(const s of ['state.showSidebarCountsDraft=countsBox.checked','state.showLeadTextDraft=readingBox.checked','localStorage.setItem(LEAD_TEXT_PREF_KEY','localStorage.setItem(SIDEBAR_COUNTS_PREF_KEY','state.showLeadTextDraft=null;state.showSidebarCountsDraft=null'])assert(script.includes(s),s);
for(const s of [
 'おすすめの保存先（通常インストール版の例）',
 String.raw`C:\Users\ユーザー名\AppData\Local\Programs\Nestrill\data\backgrounds`,
 String.raw`ポータブル版：Nestrillを展開したフォルダー内の data\backgrounds`,
 'bgFileField.append(bgSaveHint)',
 'picker.onchange=async()=>',
])assert(script.includes(s),`background hint: ${s}`);
assert(css.includes('.nestrill-bg-path-hint code'));
console.log('PASS: display prefs 2 toggles and background file path hints');
