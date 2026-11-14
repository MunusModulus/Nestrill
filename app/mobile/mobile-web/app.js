'use strict';
const $=id=>document.getElementById(id);
const state={profile:1,mode:'rss',filter:'all',category:'',feed:'',q:'',page:0,total:0,limit:60,request:0,feeds:[]};
const API='/mobile/api/';
async function api(route,options){
 const response=await fetch(API+route,{credentials:'same-origin',cache:'no-store',...options});
 let data={};try{data=await response.json()}catch{}
 if(response.status===401){showLogin();throw new Error('認証の有効期限が切れました。再接続してください')}
 if(!response.ok)throw new Error(data.error||'通信できませんでした');
 return data;
}
function post(route,obj){return api(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)})}
function showLogin(){ clearMobileBackground();$('login').classList.remove('hide');$('app').classList.add('hide');$('logout').classList.add('hide'); }
function showApp(){ $('login').classList.add('hide');$('app').classList.remove('hide');$('logout').classList.remove('hide'); }
function notify(message){$('notice').textContent=message||''}
function element(tag,className,text){const x=document.createElement(tag);if(className)x.className=className;if(text!==undefined)x.textContent=String(text);return x;}
function dateText(ms){try{return ms?new Intl.DateTimeFormat('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(ms)):''}catch{return ''}}
function safeLink(raw){try{const u=new URL(raw);return ['http:','https:'].includes(u.protocol)?u.href:''}catch{return ''}}
function clear(el){el.replaceChildren()}
function getProfile(){return String(state.profile)}
async function loadOverview(){
 const o=await api('overview?profile='+getProfile());state.feeds=o.feeds;
 // Mobile hides aggregate unread / article counts; category/feed pickers keep their counts.
 const cat=$('category');const old=state.category;clear(cat);cat.append(new Option('すべてのカテゴリ',''));
 // 未分類でもフィードがあれば表示する。未読0件だけで隠すと既読記事を参照できなくなる。
 const visibleCategories=o.categories.filter(c=>String(c.name||'').trim()!=='未分類'||
  state.feeds.some(f=>String(f.categoryId)===String(c.id)));
 for(const item of visibleCategories)cat.append(new Option(`${item.name} (${item.unread})`,String(item.id)));
 if(visibleCategories.some(c=>String(c.id)===old))cat.value=old;else state.category=cat.value='';
 populateFeeds();
 refreshPickerButtons();
}
function populateFeeds(){
 const feed=$('feed'),previous=state.feed;clear(feed);feed.append(new Option('すべてのフィード',''));
 for(const item of state.feeds.filter(x=>!state.category||String(x.categoryId)===state.category))
  feed.append(new Option(`${item.title} (${item.unread})`,String(item.id)));
 if(state.feeds.some(x=>String(x.id)===previous&&(!state.category||String(x.categoryId)===state.category)))feed.value=previous;
 else state.feed=feed.value='';
 refreshPickerButtons();
}
function renderArticle(a){
 const row=element('article','item '+(a.readAt===null?'unread':'read'));
 // Fix84E: show rarely used actions next to site/date, leaving the title its own full-width row.
 const meta=element('div','meta has-actions');
 const details=element('div','meta-info');
 details.append(element('span','meta-source',a.feedTitle||'RSS'),element('span','meta-date',dateText(a.published)));
 meta.append(details);
 const actions=element('div','meta-actions');
 const read=element('button','mini-action read-toggle');read.type='button';
 read.addEventListener('click',async()=>{read.disabled=true;try{await updateArticle(a,{read:a.readAt===null},row)}catch(e){notify(e.message)}finally{read.disabled=false}});
 const starred=element('button','mini-action favorite-toggle');starred.type='button';
 starred.addEventListener('click',async()=>{starred.disabled=true;try{await updateArticle(a,{starred:!a.starred},row)}catch(e){notify(e.message)}finally{starred.disabled=false}});
 actions.append(read,starred);meta.append(actions);row.append(meta);
 const link=element('a','title',a.title||'（タイトルなし）');const target=safeLink(a.url);
 if(target){link.href=target;link.target='_blank';link.rel='noopener noreferrer';link.addEventListener('click',()=>{if(a.readAt===null)updateArticle(a,{read:true},row).catch(e=>notify(e.message))});}
 else{link.removeAttribute('href');link.title='記事のURLが不正なため開けません';}
 row.append(link);
 row.refresh=()=>{
  const isUnread=a.readAt===null,readLabel=isUnread?'既読にする':'未読に戻す',starLabel=a.starred?'お気に入りを解除':'お気に入りにする';
  row.classList.toggle('unread',isUnread);row.classList.toggle('read',!isUnread);
  read.textContent=isUnread?'✓':'↩';read.setAttribute('aria-label',readLabel);read.title=readLabel;
  starred.textContent=a.starred?'★':'☆';starred.setAttribute('aria-label',starLabel);starred.setAttribute('aria-pressed',String(Boolean(a.starred)));starred.title=starLabel;starred.classList.toggle('selected',Boolean(a.starred));
 };row.refresh();
 return row;
}
async function updateArticle(a,change,row){
 await post('article-state',{profileId:state.profile,articleId:a.id,...change});
 if(typeof change.read==='boolean')a.readAt=change.read?Date.now():null;
 if(typeof change.starred==='boolean')a.starred=change.starred;
 row.refresh();await loadOverview();
}
async function loadArticles(){
 const request=++state.request;const list=$('articles');clear(list);list.append(element('div','empty','記事を読み込んでいます…'));notify('');
 const q=new URLSearchParams({profile:getProfile(),page:String(state.page),filter:state.filter});
 if(state.category)q.set('category',state.category);if(state.feed)q.set('feed',state.feed);if(state.q)q.set('q',state.q);
 try{
  const data=await api('articles?'+q);
  if(request!==state.request)return;
  state.total=data.total;state.limit=data.limit;clear(list);
  if(!data.articles.length)list.append(element('div','empty','条件に合う記事はありません'));
  for(const item of data.articles)list.append(renderArticle(item));
  const last=Math.max(1,Math.ceil(data.total/data.limit));$('page').textContent=`${state.page+1} / ${last} ページ`;
  $('prev').disabled=state.page===0;$('next').disabled=state.page+1>=last;
 }catch(e){if(request===state.request){clear(list);list.append(element('div','empty','読み込めませんでした'));notify(e.message)}}
}
// Fix103I: E2 replaces the retired E4/7:2:1 mobile presentation.
function renderExternal(item){
 const row=element('article','item');
 const meta=element('div','meta');
 meta.append(element('span','',item.source||'記事'));
 if(item.published)meta.append(element('span','',dateText(item.published)));
 if(item.queryLabel)meta.append(element('span','',item.queryLabel));
 row.append(meta);
 const link=element('a','title',item.title||'（タイトルなし）');const target=safeLink(item.url);
 if(target){link.href=target;link.target='_blank';link.rel='noopener noreferrer';}
 else{link.removeAttribute('href');link.title='記事のURLが不正なため開けません';}
 row.append(link);return row;
}
let e2PollTimer=null;
function clearE2Polling(){if(e2PollTimer!==null){clearTimeout(e2PollTimer);e2PollTimer=null;}}
async function loadExternal(){
 clearE2Polling();
 const request=++state.request,profile=state.profile,target=$('ai-items'),button=$('e2-refresh');
 // Preserve the previous list while checking status; do not flash 90 items on every poll.
 try{
  const result=await api('external?profile='+getProfile());
  if(request!==state.request||state.mode!=='ai'||profile!==state.profile)return;
  button.disabled=!!result.running;
  $('ai-status').textContent=result.running
   ?'PCで記事を探索中…'+(result.progress&&result.progress.total?'（'+result.progress.completed+'/'+result.progress.total+'）':'')
   :result.error?'前回の探索でエラー：'+result.error
   :result.generatedAt?'最終探索：'+new Date(result.generatedAt).toLocaleString('ja-JP')+' ・ '+result.items.length+'件'
   :'まだ探索結果がありません';
  clear(target);
  if(!result.items.length)target.append(element('div','empty',result.running?'探索結果を取得中です':'PCまたはスマホから「おすすめを更新」を実行してください'));
  else for(const item of result.items)target.append(renderExternal(item));
  if(result.running)e2PollTimer=setTimeout(()=>{if(state.mode==='ai'&&request===state.request&&profile===state.profile)loadExternal()},2500);
 }catch(e){
  if(request===state.request&&state.mode==='ai'){
   button.disabled=false;clear(target);target.append(element('div','empty','記事一覧を読み込めませんでした'));
   notify(e.message);
  }
 }
}
async function startExternal(){
 const button=$('e2-refresh');if(button.disabled)return;
 button.disabled=true;notify('PCでおすすめ記事の更新を開始しています…');
 try{
  const result=await post('external/refresh',{profileId:state.profile});
  if(result.started)notify('PCで探索を実行中です。完了すると一覧が更新されます');
  else if(result.running)notify('PCで探索が進行中です');
  await loadExternal();
 }catch(e){button.disabled=false;notify(e.message||'探索を開始できませんでした');}
}
async function refreshView(){if(state.mode==='ai')return loadExternal();clearE2Polling();return loadArticles()}
async function setMode(mode){clearE2Polling();state.mode=mode;state.request++;$('rss-view').classList.toggle('hide',mode!=='rss');$('ai-view').classList.toggle('hide',mode!=='ai');$('tab-rss').classList.toggle('active',mode==='rss');$('tab-ai').classList.toggle('active',mode==='ai');await refreshView()}
// Fix100A: mobile-only palette. Never refer to the PC theme or read external fonts.
const MOBILE_PRESETS={
 light:{header:'#ffffff',card:'#ffffff',text:'#172339',muted:'#61738c',accent:'#2563eb',control:'#edf2fa',border:'#dce5ef'},
 dark:{header:'#182436',card:'#182436',text:'#e9eff8',muted:'#9aabc2',accent:'#7ba8ff',control:'#29384c',border:'#34435a'}
};
const MOBILE_CSS_PROPERTIES=['--paper','--text','--muted','--accent','--chip','--line','--mobile-header','--mobile-control','--mobile-title-size'];
function clearMobilePalette(){
 const html=document.documentElement;
 html.removeAttribute('data-mobile-palette');
 for(const prop of MOBILE_CSS_PROPERTIES)html.style.removeProperty(prop);
}
function applyMobilePalette(saved){
 clearMobilePalette();
 const html=document.documentElement;
 html.style.setProperty('--mobile-title-size',String(Number.isInteger(saved?.titleSize)&&saved.titleSize>=14&&saved.titleSize<=19?saved.titleSize:15)+'px');
 const mode=saved?.mode;
 if(!['light','dark','custom'].includes(mode))return; // system: retain the original OS-following CSS
 const palette=mode==='custom'?saved.colors:MOBILE_PRESETS[mode];
 if(!palette||!['header','card','text','muted','accent','control','border'].every(k=>/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(palette[k]||'')))return;
 html.setAttribute('data-mobile-palette',mode);
 for(const [k,v] of Object.entries({'--paper':palette.card,'--text':palette.text,'--muted':palette.muted,
  '--accent':palette.accent,'--chip':palette.control,'--line':palette.border,
  '--mobile-header':palette.header,'--mobile-control':palette.control}))html.style.setProperty(k,v);
}

// Fix99A: one optional static background, cached on the authenticated device.
const MOBILE_BG_CACHE_KEY='nestrill-mobile-static-bg-v1';
function clearMobileBackground(){
 document.body.style.removeProperty('--mobile-bg-image');document.body.style.removeProperty('--mobile-bg-color');clearMobilePalette();
 try{localStorage.removeItem(MOBILE_BG_CACHE_KEY)}catch{}
}
function readMobileBgCache(version){
 try{
  const saved=JSON.parse(localStorage.getItem(MOBILE_BG_CACHE_KEY)||'null');
  if(saved?.version===version&&typeof saved.url==='string'&&saved.url.length<700000&&
   /^data:image\/webp;base64,[a-zA-Z0-9+/=]+$/.test(saved.url))return saved.url;
 }catch{}
 return '';
}
async function applyMobileBackground(){
 try{
  const cfg=await api('appearance');
  applyMobilePalette(cfg.palette);
  document.body.style.setProperty('--mobile-bg-color',cfg.color);
  if(cfg.mode!=='image'||!/^[0-9a-f]{24}$/.test(cfg.version)){
   document.body.style.setProperty('--mobile-bg-image','none');
   try{localStorage.removeItem(MOBILE_BG_CACHE_KEY)}catch{}
   return;
  }
  let dataUrl=readMobileBgCache(cfg.version);
  if(!dataUrl){
   const resp=await fetch('/mobile/api/background-image?v='+cfg.version,{credentials:'same-origin',cache:'no-store'});
   if(resp.status===401){showLogin();return}
   if(!resp.ok)throw Error('背景画像を読み込めませんでした');
   const blob=await resp.blob();
   if(blob.type!=='image/webp'||blob.size>500000)throw Error('背景画像の形式が不正です');
   dataUrl=await new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('画像の読み込みに失敗しました'));reader.readAsDataURL(blob);
   });
   try{localStorage.setItem(MOBILE_BG_CACHE_KEY,JSON.stringify({version:cfg.version,url:dataUrl}))}catch{}
  }
  document.body.style.setProperty('--mobile-bg-image',`url("${dataUrl}")`);
 }catch(e){
  document.body.style.setProperty('--mobile-bg-image','none');
  console.warn('スマホ背景設定を読み込めません:',e.message);
 }
}
async function init(){
 const profiles=await api('profiles');const select=$('profile');clear(select);for(const p of profiles.profiles)select.append(new Option(p.name,String(p.id)));
 if(!profiles.profiles.length)throw new Error('通常プロファイルがありません');
 const saved=localStorage.getItem('nestrill-mobile-last-profile');
 if(saved&&profiles.profiles.some(p=>String(p.id)===saved))select.value=saved;
 state.profile=Number(select.value);showApp();await applyMobileBackground();await loadOverview();await refreshView();
}

// Fix84D: custom compact picker for category/feed. Native Android <select> menus ignore CSS font-size.
const compactPickers=new Map();
let pickerSource=null,pickerPreviousFocus=null;
let pickerBackdrop=null,pickerHeading=null,pickerSearch=null,pickerItems=null,pickerClose=null;
function refreshPickerButtons(){
 for(const [select,button] of compactPickers){
  const option=select.selectedOptions[0];
  button.querySelector('.compact-select-label').textContent=option?option.textContent:'すべて';
  button.setAttribute('aria-label',(select.id==='category'?'カテゴリ':'フィード')+'：'+(option?option.textContent:'すべて'));
 }
}
function fillPicker(){
 if(!pickerSource)return;
 const query=pickerSearch.value.trim().toLocaleLowerCase();clear(pickerItems);
 const items=Array.from(pickerSource.options).filter(option=>option.textContent.toLocaleLowerCase().includes(query));
 if(!items.length){pickerItems.append(element('p','picker-empty','一致する候補がありません'));return}
 for(const option of items){
  const row=element('button','picker-option');row.type='button';
  const isSelected=option.value===pickerSource.value;
  row.setAttribute('role','radio');row.setAttribute('aria-checked',String(isSelected));
  if(isSelected)row.classList.add('selected');
  const label=element('span','picker-option-label',option.textContent);
  const tick=element('span','picker-option-tick',isSelected?'●':'○');tick.setAttribute('aria-hidden','true');
  row.append(label,tick);
  row.addEventListener('click',()=>{
   if(pickerSource.value!==option.value){pickerSource.value=option.value;pickerSource.dispatchEvent(new Event('change',{bubbles:true}))}
   refreshPickerButtons();closeCompactPicker();
  });
  pickerItems.append(row);
 }
}
function openCompactPicker(select){
 pickerSource=select;pickerPreviousFocus=document.activeElement;
 pickerHeading.textContent=select.id==='category'?'カテゴリを選択':'フィードを選択';
 pickerSearch.value='';pickerSearch.placeholder=select.id==='category'?'カテゴリ名で絞り込み':'フィード名で絞り込み';
 fillPicker();pickerBackdrop.classList.remove('hide');document.body.classList.add('picker-open');
 pickerClose.focus({preventScroll:true});
 const current=pickerItems.querySelector('.selected');if(current)current.scrollIntoView({block:'nearest'});
}
function closeCompactPicker(){
 if(!pickerBackdrop||pickerBackdrop.classList.contains('hide'))return;
 pickerBackdrop.classList.add('hide');document.body.classList.remove('picker-open');pickerSource=null;
 if(pickerPreviousFocus&&pickerPreviousFocus.isConnected)pickerPreviousFocus.focus({preventScroll:true});
 pickerPreviousFocus=null;
}
function setupCompactPickers(){
 pickerBackdrop=element('div','picker-backdrop hide');pickerBackdrop.id='compact-picker-backdrop';
 const panel=element('div','picker-panel');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','compact-picker-heading');
 const head=element('div','picker-head');pickerHeading=element('h2','picker-heading');pickerHeading.id='compact-picker-heading';
 pickerClose=element('button','picker-close','×');pickerClose.type='button';pickerClose.setAttribute('aria-label','閉じる');
 head.append(pickerHeading,pickerClose);
 pickerSearch=element('input','picker-search');pickerSearch.type='search';pickerSearch.setAttribute('aria-label','候補を絞り込み');
 pickerItems=element('div','picker-options');pickerItems.setAttribute('role','radiogroup');pickerItems.setAttribute('aria-label','選択肢');
 panel.append(head,pickerSearch,pickerItems);pickerBackdrop.append(panel);document.body.append(pickerBackdrop);
 pickerClose.addEventListener('click',closeCompactPicker);
 pickerBackdrop.addEventListener('click',event=>{if(event.target===pickerBackdrop)closeCompactPicker()});
 pickerSearch.addEventListener('input',fillPicker);
 pickerBackdrop.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();closeCompactPicker();return}
  if(event.key!=='Tab')return;
  const reachable=Array.from(panel.querySelectorAll('button:not([disabled]),input:not([disabled])'));
  const first=reachable[0],last=reachable[reachable.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
 });
 for(const id of ['category','feed']){
  const select=$(id);const container=element('div','compact-select');
  select.parentNode.insertBefore(container,select);container.append(select);
  select.hidden=true;select.tabIndex=-1;
  const button=element('button','compact-select-trigger');button.type='button';
  button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls',pickerBackdrop.id);
  const label=element('span','compact-select-label');const arrow=element('span','compact-select-arrow','⌄');arrow.setAttribute('aria-hidden','true');
  button.append(label,arrow);container.append(button);compactPickers.set(select,button);
  button.addEventListener('click',()=>openCompactPicker(select));
 }
 refreshPickerButtons();
}

$('login-form').addEventListener('submit',async e=>{e.preventDefault();$('login-error').textContent='';try{await post('login',{code:$('pairing').value.trim()});$('pairing').value='';await init()}catch(err){$('login-error').textContent=err.message}});
$('logout').addEventListener('click',async()=>{try{await post('logout',{})}catch{}showLogin();});
$('profile').addEventListener('change',async()=>{clearE2Polling();state.profile=Number($('profile').value);localStorage.setItem('nestrill-mobile-last-profile',String(state.profile));state.page=0;state.category='';state.feed='';await loadOverview();await refreshView()});
$('tab-rss').addEventListener('click',()=>setMode('rss'));$('tab-ai').addEventListener('click',()=>setMode('ai'));
$('e2-refresh').addEventListener('click',startExternal);
$('category').addEventListener('change',()=>{state.category=$('category').value;state.feed='';populateFeeds();refreshPickerButtons();state.page=0;loadArticles()});
$('feed').addEventListener('change',()=>{state.feed=$('feed').value;refreshPickerButtons();state.page=0;loadArticles()});
$('search-btn').addEventListener('click',()=>{state.q=$('search').value.trim();state.page=0;loadArticles()});
$('search').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();state.q=$('search').value.trim();state.page=0;loadArticles()}});
for(const btn of document.querySelectorAll('.chip'))btn.addEventListener('click',()=>{state.filter=btn.dataset.filter;state.page=0;for(const b of document.querySelectorAll('.chip'))b.classList.toggle('active',b===btn);loadArticles()});
// Fix93A: update the selected normal profile's RSS on the PC, then reload mobile view.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let mobileRefreshPending=false;
async function refreshMobileRss(){
 if(mobileRefreshPending)return;
 mobileRefreshPending=true;
 const button=$('reload'),label=button.textContent;
 button.disabled=true;button.textContent='取得中…';notify('PCで新着記事を取得しています…');
 try{
  const started=await post('rss-refresh',{profileId:state.profile});
  if(started.empty){notify('このプロファイルにはRSSが登録されていません');return}
  if(started.cooldown){
   await loadOverview();await refreshView();notify('直前に新着取得を実行済みです');return;
  }
  if(!started.started&&!started.busy)throw new Error('新着取得を開始できませんでした');
  const runId=Number(started.runId);
  if(!Number.isSafeInteger(runId)||runId<1)throw new Error('取得状態を確認できませんでした');
  const deadline=Date.now()+10*60*1000;
  let result=null,partialShown=false;
  while(Date.now()<deadline){
   await sleep(1800);
   const status=await api('rss-refresh-status');
   if(Number(status.completedRun)>=runId){result=status;break}
   if(!partialShown&&status.running&&Number(status.firstPassCompletedRun)===runId){
    partialShown=true;
    await loadOverview();await refreshView();
    notify('取得済みの記事を先に反映しました。残りのフィードは更新中です');
   }
  }
  if(!result){notify('PCの新着取得が継続中の可能性があります。しばらくして再確認してください');return}
  await loadOverview();await refreshView();
  notify(result.failed?'新着取得でエラーが発生しました。記事一覧は再読み込みしました':'新着取得が完了しました');
 }catch(e){notify(e.message||'新着取得の状態を確認できませんでした')}
 finally{button.disabled=false;button.textContent=label;mobileRefreshPending=false}
}
$('reload').addEventListener('click',refreshMobileRss);
$('prev').addEventListener('click',()=>{if(state.page>0){state.page--;loadArticles();window.scrollTo({top:0,behavior:'smooth'})}});
$('next').addEventListener('click',()=>{state.page++;loadArticles();window.scrollTo({top:0,behavior:'smooth'})});
setupCompactPickers();
api('session').then(s=>{if(s.authenticated)return init();showLogin()}).catch(e=>{$('login-error').textContent=e.message;showLogin()});
