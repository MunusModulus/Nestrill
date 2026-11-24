'use strict';
// Runs only in local Nestrill. The SAME browser tab is navigated to X.
// The genuine Nestrill sidebar is preserved unless the user opts in.
(() => {
  if (location.protocol !== 'http:' ||
      !['127.0.0.1','localhost'].includes(location.hostname) || location.port !== '8767') return;
  if (!document.getElementById('source-nav')) return;
  if (document.getElementById('nx4-open-x')) return;
  document.documentElement.classList.add('nx4-nestrill-active');
  // Nestrill X Extension does not offer secret mode. The native Nestrill logo's 's'
  // is its sole documented entry point. Intercept before its onclick handler;
  // leave exit working if an already-secret document is encountered (upgrade/
  // reload recovery). This affects only local Nestrill with this addon enabled.
  const secretActive = () => document.documentElement.classList.contains('secret-active');
  document.addEventListener('click', event => {
    if (secretActive()) return; // Never trap a pre-existing secret session.
    const node = event.target;
    if (!(node instanceof Element) || !node.closest('#brand-s')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  const nav = document.getElementById('source-nav');
  const group = document.createElement('div');
  group.className='source-nav-group nx4-x-group';
  const btn = document.createElement('button');
  btn.id='nx4-open-x';btn.type='button';
  btn.className='source-nav-heading';
  btn.textContent='𝕏  X（共通ペインを開く）';
  btn.title='共通左ペインを開く（Xへの移動は共通ペインから行います）';
  group.append(btn);nav.append(group);
  const rail = document.getElementById('sidebar-rail');
  let railBtn = null;
  if(rail) {
    railBtn = document.createElement('button');
    railBtn.id='nx4-open-x-rail';railBtn.type='button';railBtn.className='rail-button';
    railBtn.textContent='𝕏';railBtn.title='X（Twitter）';
    rail.append(railBtn);
  }
  const status = document.createElement('div');
  status.id='nx4-x-status'; status.setAttribute('role','status');
  group.insertAdjacentElement('afterend',status);
  let busy=false;
  async function openX() {
    if(busy)return;
    // R9O: the Nestrill-side click is the verified user gesture. Reject
    // secret mode right here, before message dispatch (which must open now).
    if(secretActive()){
      status.textContent='シークレット表示中はNestrill X Extensionの共通ペインを開けません。';
      return;
    }
    busy=true;btn.disabled=true;if(railBtn)railBtn.disabled=true;
    status.textContent='';
    try {
      const result=await chrome.runtime.sendMessage({type:'NX1_OPEN_PANEL'});
      if(!result?.ok)throw Error(result?.error||'左ペインを開けませんでした。');
      status.textContent='左ペインのX（Twitter）を選ぶと、このタブ内で切り替わります。';
    } catch (e) { status.textContent='X切替: '+String(e.message||e); }
    finally {busy=false;btn.disabled=false;if(railBtn)railBtn.disabled=false;}
  }
  btn.addEventListener('click',openX);
  railBtn?.addEventListener('click',openX);

  // R9M: apply the shared-menu state to the REAL Nestrill document, whether
  // top-level or embedded in the X keep-alive overlay. The old floating restore
  // button was removed: its control is now in the extension's common side pane.
  // Some Chromium iframe configurations run content.js without content.css.
  // Use the extension stylesheet first, then a reversible inline fallback.
  const compactInline = new Map();
  function nativeParts(){
    return {
      sidebar:document.querySelector('#workspace > #sidebar'),
      splitter:document.querySelector('#workspace > #splitter'),
      main:document.querySelector('#workspace > #main')
    };
  }
  function actuallyHidden(parts){
    return !!parts.sidebar && !!parts.splitter &&
      getComputedStyle(parts.sidebar).display==='none' &&
      getComputedStyle(parts.splitter).display==='none';
  }
  function saveAndSet(node,property,value){
    if(!node)return;
    let saved=compactInline.get(node);
    if(!saved){saved=new Map();compactInline.set(node,saved);}
    if(!saved.has(property)){
      saved.set(property,{value:node.style.getPropertyValue(property),
        priority:node.style.getPropertyPriority(property),applied:value});
    }
    node.style.setProperty(property,value,'important');
  }
  function restoreInline(){
    for(const [node,properties] of compactInline){
      for(const [property,saved] of properties){
        // Do not overwrite unrelated page changes that occurred since hiding.
        if(node.style.getPropertyValue(property)!==saved.applied ||
           node.style.getPropertyPriority(property)!=='important')continue;
        if(saved.value)node.style.setProperty(property,saved.value,saved.priority);
        else node.style.removeProperty(property);
      }
    }
    compactInline.clear();
  }
  function applyCompact(enabled){
    const parts=nativeParts();
    if(enabled && (!parts.sidebar || !parts.splitter || !parts.main))
      return {ok:false,hidden:false,error:'Nestrillの左ペイン構造を確認できません。変更は中止しました。'};
    document.documentElement.classList.remove('nx1-boot-guard');
    document.documentElement.classList.toggle('nx4-hide-native-menu',!!enabled);
    if(!enabled){
      restoreInline();
      return {ok:true,hidden:actuallyHidden(parts)};
    }
    // Prefer the R9L class rule, but do not trust it inside nested iframes.
    if(!actuallyHidden(parts)){
      saveAndSet(parts.sidebar,'display','none');
      saveAndSet(parts.splitter,'display','none');
      saveAndSet(parts.main,'flex','1 1 auto');
      saveAndSet(parts.main,'min-width','0px');
      saveAndSet(parts.main,'width','100%');
    }
    const hidden=actuallyHidden(parts);
    if(!hidden){
      document.documentElement.classList.remove('nx4-hide-native-menu');
      restoreInline();
      return {ok:false,hidden:false,error:'元ペインの非表示を検証できませんでした。'};
    }
    return {ok:true,hidden:true};
  }
  chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{
    if(msg?.type==='NX4_COMPACT_CHANGED'){
      reply(applyCompact(msg.enabled===true)); return false;
    }
    return false;
  });
  // The panel remains a browser-owned extension document across top-level
  // navigations. On Nestrill's return, restore native-hide preference and the
  // last requested menu item without relying on the old page's JavaScript.

  function text(el){return String(el?.textContent||'').trim().slice(0,150);}
  function n(el){const id=Number(el);return Number.isSafeInteger(id)&&id>0?id:null;}
  const countText=node=>{
    const value=String(node?.textContent||'').trim();
    return /^\d{1,8}$/.test(value)?value:'';
  };
  const max = (arr, limit) => Array.from(arr).slice(0,limit);
  // Chrome extension content scripts run in an isolated JavaScript world.
  // Nestrill's _rssCategoryId is a JS expando property and cannot be read here.
  // Use only the visible DOM index + category label, and validate both when
  // the click is relayed. Feed DOM data-feed-id is a real HTML attribute.
  function categorySections(){
    return max(document.querySelectorAll('#category-list .category-block'),100);
  }
  function categoryLabel(section){
    return text(section?.querySelector('.cat-head .cat-name'));
  }
  function getMenu(){
    const categories=categorySections().map((section,index)=>({
      index, label:categoryLabel(section),
      expanded:text(section.querySelector('.cat-head .nav-symbol'))==='▾',
      active:!!section.querySelector('.cat-head .nav-item.active'),
      count:countText(section.querySelector('.cat-head .count')),
      feeds:max(section.querySelectorAll('.feed-nav[data-feed-id]'),200).map(f=>({
        id:n(f.dataset.feedId),categoryIndex:index,categoryLabel:categoryLabel(section),
        label:text(f.querySelector('.name')||f),
        active:f.classList.contains('active')
      })).filter(f=>f.id && f.label)
    })).filter(c=>c.label);
    // Hidden sources (such as the unfinished Mail module) should not be
    // represented as clickable items in the side panel.
    const accounts=['youtube','mail'].filter(kind=>{
      const root=document.getElementById(kind==='mail'?'mail-source-nav':'source-youtube');
      return !!root && getComputedStyle(root).display!=='none';
    }).map(kind=>({
      kind, label:kind==='youtube'?'YouTube':'メール',
      accounts:max(document.querySelectorAll('#'+kind+'-account-list > *'),40).map((a,i)=>({
        index:i,label:text(a.querySelector('.source-account-name')),
        expanded:a.querySelector('.source-account-toggle')?.getAttribute('aria-expanded')==='true',
        channels:kind==='youtube'?max(a.querySelectorAll('.youtube-channel-nav'),200).map((c,j)=>({
          index:j,label:text(c)
        })):[]
      })).filter(a=>a.label)
    }));
    const selected= max(document.querySelectorAll('#profile-select option:checked'),1)[0];
    return {profile:text(selected)||'（不明）',
      profileId:n(document.getElementById('profile-select')?.value),
      categories, accounts,
      showCounts:!document.documentElement.classList.contains('nestrill-hide-sidebar-counts'),
      counts:{all:countText(document.getElementById('all-count')),
        unread:countText(document.getElementById('unread-count'))},
      selected:{
        all:!!document.getElementById('nav-all')?.classList.contains('active'),
        unread:!!document.getElementById('nav-unread')?.classList.contains('active'),
        starred:!!document.getElementById('nav-starred')?.classList.contains('active'),
        ai:!!document.getElementById('ai-rss')?.classList.contains('active'),
        youtube:!!document.getElementById('source-youtube')?.classList.contains('active'),
        mail:!!document.getElementById('source-mail')?.classList.contains('active')
      }};
  }
  function validIndex(index,maxExclusive){
    return Number.isSafeInteger(index)&&index>=0&&index<maxExclusive;
  }
  function resolveCategory(index,label){
    const sections=categorySections();
    if(!validIndex(index,sections.length) || typeof label!=='string')return null;
    const section=sections[index];
    return categoryLabel(section)===label?section:null;
  }
  function clickValid(intent) {
    if(!intent || typeof intent!=='object')return {ok:false,error:'操作内容が不正です。'};
    let target=null;
    const byId=id=>document.getElementById(id);
    if(intent.kind==='group' && ['all','unread','starred'].includes(intent.value))
      target=byId('nav-'+intent.value);
    else if(intent.kind==='ai')target=byId('ai-rss');
    else if(intent.kind==='source' && ['youtube','mail'].includes(intent.value)) {
      const root=byId(intent.value==='mail'?'mail-source-nav':'source-youtube');
      if(root && getComputedStyle(root).display!=='none')target=byId('source-'+intent.value);
    } else if(intent.kind==='category') {
      const section=resolveCategory(intent.index,intent.label);
      target=section?.querySelector('.cat-head .nav-item')||null;
    } else if(intent.kind==='feed' && n(intent.id)) {
      let section=resolveCategory(intent.categoryIndex,intent.categoryLabel);
      const findFeed=()=>Array.from(section?.querySelectorAll('.feed-nav[data-feed-id]')||[])
        .find(el=>n(el.dataset.feedId)===intent.id && text(el.querySelector('.name')||el)===intent.label)||null;
      target=findFeed();
      // R9H: a feed selected from X can belong to a category collapsed in
      // native Nestrill. Expand only that category before resolving the item.
      // The native toggle synchronously recreates its RSS feed DOM nodes.
      if(!target && section){
        const toggle=section.querySelector('.cat-head .nav-symbol');
        if(text(toggle)==='▸'){
          toggle.click();
          section=resolveCategory(intent.categoryIndex,intent.categoryLabel);
          target=findFeed();
        }
      }
    } else if(intent.kind==='account' && ['youtube','mail'].includes(intent.source) &&
        validIndex(intent.index,40)){
      const section=byId(intent.source+'-account-list')?.children[intent.index];
      target=section?.querySelector('.source-account-name')||null;
      if(text(target)!==intent.label)target=null;
    } else if(intent.kind==='channel' && validIndex(intent.accountIndex,40) &&
        validIndex(intent.channelIndex,200)){
      const section=byId('youtube-account-list')?.children[intent.accountIndex];
      target=section?.querySelectorAll('.youtube-channel-nav')[intent.channelIndex]||null;
      if(text(target)!==intent.label)target=null;
    }
    if (!target || !target.isConnected)return {ok:false,error:'Nestrill側に該当項目が見つかりません。一覧を更新してから再試行してください。'};
    cancelReadingRestore++;
    target.click();
    return {ok:true};
  }
  function setExpanded(intent){
    if(!intent || typeof intent!=='object' || typeof intent.expanded!=='boolean')
      return {ok:false,error:'展開操作が不正です。'};
    if(intent.kind==='category'){
      const section=resolveCategory(intent.index,intent.label);
      const control=section?.querySelector('.cat-head .nav-symbol');
      if(!control)return {ok:false,error:'対象カテゴリが変わりました。一覧を更新してください。'};
      const current=text(control)==='▾';
      if(current!==intent.expanded)control.click();
      return {ok:true};
    }
    if(intent.kind==='youtube-account'){
      const a=document.querySelector('#youtube-account-list')?.children[intent.index];
      if(!validIndex(intent.index,40) || !a)return {ok:false,error:'表示枠が見つかりません。'};
      const label=text(a.querySelector('.source-account-name'));
      const toggle=a.querySelector('.source-account-toggle');
      if(label!==intent.label || !toggle)return {ok:false,error:'表示枠が変更されました。一覧を更新してください。'};
      if((toggle.getAttribute('aria-expanded')==='true')!==intent.expanded)toggle.click();
      return {ok:true};
    }
    return {ok:false,error:'未対応の展開操作です。'};
  }
  // Capture only a lightweight article anchor, not RSS content or credentials.
  // Never collect private/secret-profile reading state, search queries, or X data.
  function captureReading(){
    if(document.documentElement.classList.contains('secret-active')||
       document.getElementById('search')?.value.trim()||
       document.getElementById('filter-select')?.value!=='all'||
       document.getElementById('source-panel')?.classList.contains('hidden')!==true||
       document.getElementById('ai-rss')?.classList.contains('active'))return null;
    const pane=document.getElementById('main');
    const list=document.getElementById('article-list');
    const title=document.getElementById('view-title')?.textContent.trim()||'';
    const profile=Number(document.getElementById('profile-select')?.value);
    if(!pane||!list||!Number.isSafeInteger(profile)||profile<=0||!title)return null;
    const top=pane.scrollTop,base=pane.getBoundingClientRect().top;
    if(!Number.isFinite(top))return null;
    const rows=[...list.querySelectorAll(':scope > .article-row')];
    let row=rows.find(r=>r.getBoundingClientRect().bottom>base+1);
    if(!row)row=rows[rows.length-1];
    const offset=row?row.getBoundingClientRect().top-base:0;
    return {top,id:String(row?.dataset.articleId||''),offset,loaded:rows.length,
      viewTitle:title,profile};
  }
  let cancelReadingRestore=0;
  // User navigation/scrolling overrides an in-flight automatic restoration.
  document.addEventListener('pointerdown',e=>{
    if(e.target.closest('#main,#sidebar,#source-nav,#category-list,#ai-nav'))cancelReadingRestore++;
  },true);
  document.getElementById('main')?.addEventListener('wheel',()=>{cancelReadingRestore++;},{passive:true});
  async function restoreReading(saved,navSucceeded){
    if(!navSucceeded||!saved||typeof saved!=='object'||
       !Number.isFinite(saved.top)||saved.top<0||saved.top>10000000||
       !Number.isInteger(saved.loaded)||saved.loaded>2000||
       typeof saved.id!=='string'||saved.id.length>70||
       !Number.isFinite(saved.offset)||Math.abs(saved.offset)>20000||
       document.documentElement.classList.contains('secret-active'))return;
    const pane=document.getElementById('main');const list=document.getElementById('article-list');
    const profile=Number(document.getElementById('profile-select')?.value);
    if(!pane||!list||profile!==saved.profile)return;
    const ticket=cancelReadingRestore;
    const alive=()=>ticket===cancelReadingRestore&&document.contains(pane)&&
      document.getElementById('view-title')?.textContent.trim()===saved.viewTitle&&
      document.getElementById('filter-select')?.value==='all'&&
      !document.getElementById('search')?.value.trim()&&
      document.getElementById('source-panel')?.classList.contains('hidden')===true;
    const rows=()=>list.querySelectorAll(':scope > .article-row');
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    // Wait for Nestrill's asynchronous articles query after the menu selection.
    let ready=false;
    for(let i=0;i<55;i++){
      if(ticket!==cancelReadingRestore)return;
      if(alive() && (rows().length>0||document.getElementById('empty-state')?.classList.contains('hidden')===false)){
        ready=true;break;
      }
      await pause(100);
    }
    if(!ready||!alive())return;
    let target=null;
    // One more page request at a time. Never run an unlimited replay.
    for(let page=0;page<=5;page++){
      if(!alive())return;
      target=saved.id?[...rows()].find(r=>r.dataset.articleId===saved.id):null;
      if(target||rows().length>=saved.loaded||page===5)break;
      const more=document.getElementById('more-btn');
      if(!more||more.classList.contains('hidden')||more.disabled)return;
      const previous=rows().length;
      more.click();
      let grown=false;
      for(let t=0;t<45;t++){
        if(!alive())return;
        await pause(100);
        if(rows().length>previous){grown=true;break;}
        if(more.classList.contains('hidden'))break;
      }
      if(!grown)break;
    }
    if(!alive())return;
    if(target?.isConnected){
      pane.scrollTop+=target.getBoundingClientRect().top-pane.getBoundingClientRect().top-saved.offset;
    }else{
      // If articles changed, use a bounded numerical fallback instead of
      // resetting to the top. No page data is modified.
      pane.scrollTop=saved.top;
    }
  }
  // Invoke existing Nestrill app handlers instead of rebuilding settings forms.
  // Extension isolated world can click real DOM nodes; verify the native dialog
  // actually opened (otherwise Nestrill app.js may still be initializing).
  function openNativeDialog(action){
    const ids={settings:'settings-btn','add-feed':'add-feed-btn',profiles:'profile-manager-btn'};
    const id=ids[action];
    if(!id)return {ok:false,error:'未対応の管理操作です。'};
    if(action==='profiles' && document.documentElement.classList.contains('secret-active'))
      return {ok:false,error:'シークレットモード中は通常プロファイルを管理できません。'};
    const button=document.getElementById(id);
    const overlay=document.getElementById('dialog-overlay');
    const title=document.getElementById('dialog-title');
    if(!button||!overlay||!title)return {ok:false,retry:true,error:'Nestrillの設定画面を準備中です。'};
    const matches=()=>action==='settings'
      ? title.textContent.trim().startsWith('設定 →')
      : title.textContent.trim()===(action==='profiles'?'プロファイルを管理':'RSSを追加');
    if(!overlay.classList.contains('hidden')){
      if(matches())return {ok:true,alreadyOpen:true};
      return {ok:false,error:'別の入力画面が開いています。先に閉じてください。'};
    }
    // The native buttons exist before /app.js (defer) finishes running.
    // Wait for document load rather than reading .onclick, which may not be
    // exposed between the page world and the extension's isolated world.
    // Nestrill's init() runs asynchronously AFTER the document's load event.
    // Its profile selector is populated only after /api/theme and loadProfiles()
    // have completed. Waiting just for readyState==='complete' was insufficient.
    const profile=document.getElementById('profile-select');
    if(document.readyState!=='complete')
      return {ok:false,retry:true,phase:'document',error:'HTMLの読み込み完了待ち'};
    if(!profile||!profile.options.length||!profile.value)
      return {ok:false,retry:true,phase:'nestrill-init',error:'Nestrill本体の初期化待ち（プロファイル未読込）'};
    button.click();
    if(overlay.classList.contains('hidden')||!matches())
      return {ok:false,retry:true,phase:'dialog-click',error:'本体初期化済みですが設定画面が開かず再試行'};
    return {ok:true,phase:'dialog-opened',dialogTitle:title.textContent.trim()};
  }
  // R9L: invoke Nestrill's EXISTING category manager, including rename,
  // order and deletion. Validate the selected profile and category by DOM
  // index + exact name; do not construct a second management API in the add-on.
  function openNativeCategoryManage(category){
    if(!category||!Number.isSafeInteger(category.index)||category.index<0||
       typeof category.label!=='string'||!category.label||
       !Number.isSafeInteger(category.profileId)||category.profileId<=0)
      return {ok:false,error:'カテゴリの指定が不正です。'};
    if(secretActive())return {ok:false,error:'シークレット中はカテゴリを管理できません。'};
    const activeProfile=n(document.getElementById('profile-select')?.value);
    if(!activeProfile||document.readyState!=='complete')
      return {ok:false,retry:true,error:'Nestrillの初期化待ちです。'};
    if(activeProfile!==category.profileId)
      return {ok:false,error:'プロファイルが切り替わりました。カテゴリを選び直してください。'};
    const section=resolveCategory(category.index,category.label);
    if(!section)return {ok:false,retry:true,error:'カテゴリの一覧を読み込み中です。'};
    const button=section.querySelector('.cat-head .cat-more');
    const overlay=document.getElementById('dialog-overlay');
    const title=document.getElementById('dialog-title');
    if(!button||!overlay||!title)return {ok:false,retry:true,error:'カテゴリ管理画面の準備待ちです。'};
    const expected=category.label==='未分類'?'未分類について':'カテゴリを管理';
    if(!overlay.classList.contains('hidden')){
      if(title.textContent.trim()===expected)return {ok:false,error:'管理画面が既に開いています。'};
      return {ok:false,error:'別の入力画面が開いています。先に閉じてください。'};
    }
    button.click();
    if(overlay.classList.contains('hidden')||title.textContent.trim()!==expected)
      return {ok:false,retry:true,error:'カテゴリ管理画面を開く処理を確認中です。'};
    return {ok:true,dialogTitle:expected};
  }
  // Fail-closed compatibility for a page that was ALREADY in secret mode
  // before this extension was enabled, or switched via a legacy addon.
  let lastSecretReported=null;
  function notifySecretState(){
    const active=secretActive();
    if(lastSecretReported===active)return;
    lastSecretReported=active;
    chrome.runtime.sendMessage({type:'NX9_SECRET_STATE',active}).catch(()=>{});
  }
  new MutationObserver(notifySecretState).observe(document.documentElement,
    {attributes:true,attributeFilter:['class']});
  notifySecretState();

  // A profile change replaces #profile-select before the async loadOverview()
  // rebuilds #category-list. Never publish the NEW profile name alongside the
  // OLD profile's categories. This gate observes real DOM rebuilding, not a
  // guessed delay, and also supports profiles with zero RSS categories.
  const profileSelect=document.getElementById('profile-select');
  const categoryList=document.getElementById('category-list');
  const articleList=document.getElementById('article-list');
  let acceptedProfileId=null,categoryRebuiltFor=null,articlesRebuiltFor=null;
  const currentProfileId=()=>n(profileSelect?.value);
  let observedProfileId=currentProfileId();
  function detectProfileChange(){
    const id=currentProfileId();
    if(id!==observedProfileId){
      observedProfileId=id;categoryRebuiltFor=null;articlesRebuiltFor=null;
    }
  }
  function menuReady(menu){
    detectProfileChange();
    if(document.documentElement.classList.contains('secret-active'))
      return {ok:false,error:'シークレット中は通常プロファイルのメニューを共有しません。'};
    if(!menu.profileId||menu.profile==='（不明）')
      return {ok:false,retry:true,error:'Nestrillのプロファイルを読み込み中です。'};
    const reconstructed=categoryRebuiltFor===menu.profileId||
      (!menu.categories.length&&articlesRebuiltFor===menu.profileId);
    if(acceptedProfileId!==null && acceptedProfileId!==menu.profileId && !reconstructed)
      return {ok:false,retry:true,error:'プロファイルのRSS一覧を更新中です。'};
    if(!menu.categories.length&&!reconstructed)
      return {ok:false,retry:true,error:'空のプロファイルの一覧確定を待っています。'};
    return {ok:true};
  }
  function committedMenu(){
    const menu=getMenu();const check=menuReady(menu);
    if(check.ok)acceptedProfileId=menu.profileId;
    return {check,menu};
  }
  chrome.runtime.onMessage.addListener((msg,_sender,respond)=>{
    if(msg?.type==='NX9_SECRET_CHECK'){
      respond({ok:true,secret:secretActive()});return false;
    }
    if(msg?.type==='NX4_VERIFY_COMPACT'){
      const parts=nativeParts();
      respond({ok:true,hidden:actuallyHidden(parts),
        modeRequested:document.documentElement.classList.contains('nx4-hide-native-menu')});
      return false;
    }
    if(msg?.type==='NX4_CAPTURE_READING'){
      try{respond({ok:true,reading:captureReading()});}
      catch(e){respond({ok:false,error:String(e.message||e)});}
      return false;
    }
    if(msg?.type==='NX5_SET_EXPANDED'){
      try{respond(setExpanded(msg.intent));}catch(e){respond({ok:false,error:String(e.message||e)});}
      return false;
    }
    if(msg?.type==='NX2_MENU_SNAPSHOT') {
      try {
        const {check,menu}=committedMenu();
        respond(check.ok?{ok:true,menu}:check);
      } catch(e){respond({ok:false,error:String(e.message||e)});}
      return false;
    }
    if(msg?.type==='NX2_MAIN_NAV') {
      try{respond(clickValid(msg.intent));}catch(e){respond({ok:false,error:String(e.message||e)});}
      return false;
    }
    if(msg?.type==='NX9_NATIVE_CATEGORY_MANAGE'){
      try{
        const result=openNativeCategoryManage(msg.category);
        if(!result.ok){respond(result);return false;}
        setTimeout(()=>{
          const overlay=document.getElementById('dialog-overlay');
          const title=document.getElementById('dialog-title');
          const expected=msg.category.label==='未分類'?'未分類について':'カテゴリを管理';
          respond(overlay&&!overlay.classList.contains('hidden')&&
            title?.textContent?.trim()===expected
            ? result : {ok:false,retry:true,error:'カテゴリ管理画面の表示を再確認中です。'});
        },150);
        return true;
      }catch(e){respond({ok:false,error:String(e.message||e)});return false;}
    }
    if(msg?.type==='NX9_NATIVE_DIALOG') {
      try{
        const result=openNativeDialog(msg.action);
        if(!result.ok){respond(result);return false;}
        // The first cold-start attempt may overlap an outstanding Nestrill
        // initialization callback. Verify after yielding to the event loop.
        setTimeout(()=>{
          const overlay=document.getElementById('dialog-overlay');
          const title=document.getElementById('dialog-title');
          const expected=msg.action==='settings'?'設定 →':
            msg.action==='profiles'?'プロファイルを管理':'RSSを追加';
          const visible=overlay&&!overlay.classList.contains('hidden')&&
            (msg.action==='settings'?title?.textContent?.trim()?.startsWith(expected):
              title?.textContent?.trim()===expected);
          respond(visible?result:{ok:false,retry:true,phase:'dialog-vanished',
            error:'初回の設定画面が閉じたため再確認中'});
        },150);
        return true;
      }catch(e){respond({ok:false,error:String(e.message||e)});return false;}
    }
    return false;
  });
  async function applyPending(intent){
    if(!intent) return true;
    // Nestrill can populate its category/feed DOM asynchronously after load.
    // A bounded retry is safer than declaring success before an item exists.
    for(let i=0;i<32;i++){
      const r=clickValid(intent);
      if(r.ok){
        chrome.runtime.sendMessage({type:'NX1_MENU_CHANGED'}).catch(()=>{});
        return true;
      }
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    status.textContent='元の記事一覧への復帰はできましたが、選択項目の復元には失敗しました。';
    return false;
  }
  // Nestrill renders RSS categories AFTER the document's load event.
  // The extension's side-panel snapshot can therefore be taken too early.
  // Notify the panel when the real category list becomes available, without
  // changing any Nestrill data, app rendering, or the one-tab navigation.
  let menuReadyTimer=0,lastReadySignature='';
  function scheduleMenuReady(){
    clearTimeout(menuReadyTimer);
    menuReadyTimer=setTimeout(()=>{
      try{
        const {check,menu}=committedMenu();
        if(!check.ok)return;
        const signature=JSON.stringify([menu.profileId,menu.profile,menu.categories,
          menu.accounts,menu.selected,menu.showCounts,menu.counts]);
        if(signature===lastReadySignature)return;
        lastReadySignature=signature;
        chrome.runtime.sendMessage({type:'NX1_MENU_CHANGED'}).catch(()=>{});
      }catch(e){console.warn('OneTab menu readiness check skipped',e);}
    },240);
  }
  const menuReadyObserver=new MutationObserver(records=>{
    // The native app replaces category and article nodes when a new profile
    // finishes rendering; their DOM changes provide the necessary barrier.
    detectProfileChange();
    for(const record of records){
      if(record.type==='childList' && record.target===categoryList)
        categoryRebuiltFor=currentProfileId();
      if(record.type==='childList' && record.target===articleList)
        articlesRebuiltFor=currentProfileId();
    }
    scheduleMenuReady();
  });
  if(categoryList)menuReadyObserver.observe(categoryList,{childList:true,subtree:true});
  if(articleList)menuReadyObserver.observe(articleList,{childList:true});
  if(profileSelect)menuReadyObserver.observe(profileSelect,{childList:true,subtree:true});
  profileSelect?.addEventListener('change',scheduleMenuReady);
  scheduleMenuReady();

  chrome.runtime.sendMessage({type:'NX1_PAGE_READY'}).then(async r=>{
    if(!r?.ok){console.warn('OneTab session not ready',r);return;}
    applyCompact(r.compact===true);
    const restored=await applyPending(r.pendingIntent);
    // Initial selection is now applied. Do not wait for a potentially long
    // scroll restoration before allowing the user to open management dialogs.
    // Navigation selection is the activity that may compete with the first modal.
    if(window.top!==window){
      chrome.runtime.sendMessage({type:'NX9_EMBEDDED_READY'}).catch(e=>
        console.warn('OneTab embedded ready acknowledgement failed',e));
    }
    await restoreReading(r.pendingReading,restored);
  }).catch(e=>console.warn('OneTab ready failed',e));

})();
