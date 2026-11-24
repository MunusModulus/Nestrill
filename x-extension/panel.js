'use strict';
// Global browser side panel; Nestrill and X navigate inside ONE actual tab.
const el=id=>document.getElementById(id);
let currentView=null,lastTabId=null,busy=false,compact=false,serial=0;
let nativeHiddenVerified=true;
let displayedProfileId=null;
// Proof08 R1: initialization errors must not be silently labeled "out of scope".
// Retrying is bounded and canceled on a successful state/menu snapshot.
let initRetryTimer=null,initRetryCount=0;
const MAX_INIT_RETRIES=10;
function clearInitRetry(){
  if(initRetryTimer!==null)clearTimeout(initRetryTimer);
  initRetryTimer=null;initRetryCount=0;
  el('retry-init').hidden=true;
}
function scheduleInitRetry(message){
  if(initRetryTimer!==null)clearTimeout(initRetryTimer);
  initRetryTimer=null;
  if(initRetryCount>=MAX_INIT_RETRIES){
    status(message+' 再試行が終了しました。下の「再確認」を押してください。');
    el('retry-init').hidden=false;
    return;
  }
  initRetryCount++;
  status(message+' 自動再確認中（'+initRetryCount+'/'+MAX_INIT_RETRIES+'）');
  initRetryTimer=setTimeout(()=>{
    initRetryTimer=null;
    syncContext(true).catch(e=>status('再確認失敗：'+String(e?.message||e)));
  },Math.min(350+initRetryCount*300,1700));
}
function status(t){el('status').textContent=String(t||'');}
function makeButton(label,intent,active=false){
  const b=document.createElement('button');b.type='button';b.textContent=label;
  b.classList.toggle('selected',!!active);b.addEventListener('click',()=>navigate(intent));return b;
}
async function activeTab(){
  const t=(await chrome.tabs.query({active:true,currentWindow:true}))[0];
  if(!t || !Number.isInteger(t.id))throw Error('タブが確認できません。');return t;
}
async function requestForTab(type,tabId,extra={}){
  const r=await chrome.runtime.sendMessage({type,currentTabId:tabId,...extra});
  if(!r?.ok)throw Error(r?.error||'処理できませんでした。');return r;
}
async function request(type,extra={}){
  const t=await activeTab();return requestForTab(type,t.id,extra);
}
function renderCdpStatus(report){
  const note=el('x-cdp-result');
  if(currentView!=='x'||!report){note.textContent='';note.hidden=true;return;}
  const labels={
    'history-command-sent':'CDP：X/Homeの履歴IDへ復帰要求済（スクロール復元は実機判定）',
    'first-visit':'初回X表示：通常遷移',
    'no-x-home-entry':'CDP：X/Homeの履歴がないため通常表示',
    'debugger-unavailable':'CDP：デバッグ接続不可のため通常表示',
    'history-unavailable':'CDP：履歴を取得できず通常表示',
    'history-invalid':'CDP：履歴データ不正のため通常表示',
    'current-page-mismatch':'CDP：現在ページが一致せず処理中止',
    'history-command-failed':'CDP：履歴復帰指示エラー（再遷移せず中止）',
    'pending':'CDP：履歴確認中'
  };
  let summary=labels[report.reason]||'CDP：'+report.mode;
  if(report.page){
    const d=report.page;
    summary+='\nX文書の再利用（BFCache）：'+(d.persisted?'はい':'いいえ');
    summary+='\n同じ文書：'+(d.docSame?'はい':'いいえ');
    summary+='\n離脱時と復帰時のスクロール：'+
      (d.oldScrollY===null?'取得不可':String(d.oldScrollY))+' → '+
      (d.newScrollY===null?'取得不可':String(d.newScrollY));
    summary+='\n同じ投稿が現在の画面に表示：'+
      (d.oldPostCaptured?(d.samePost?'はい':'いいえ'):'離脱時の投稿ID取得不可');
    summary+='\nBFCache不使用理由：'+
      (d.persisted?'該当なし':d.reasons?.length?d.reasons.join(', '):
        d.reasonAvailable?'取得結果なし':'取得不可');
  }else if(report.reason==='history-command-sent'){
    summary+='\nXページ再利用の診断結果を確認中…';
  }
  note.textContent=summary;
  note.hidden=false;
}
function applyMode(){
  const warning=compact&&currentView==='rss'&&!nativeHiddenVerified;
  el('compact-indicator').textContent='共通左ペイン：'+
    (warning?'ON（標準ペインの非表示を確認できません）':
      compact?'ON（Nestrill元メニュー非表示）':'OFF（元メニュー表示）');
  el('compact-indicator').classList.toggle('enabled',!!compact&&!warning);
  el('compact-indicator').classList.toggle('warning',warning);
  el('restore-native-pane').hidden=!compact||currentView!=='rss';
  el('enable-banner').hidden=compact||currentView!=='rss';
  el('x-switch').classList.toggle('selected',currentView==='x');
  document.body.dataset.view=currentView||'none';
}
function makeDetails(key,label,expanded,body,expandKind,meta){
  const d=document.createElement('details');d.dataset.key=key;d.open=!!expanded;
  const summary=document.createElement('summary');summary.textContent=label;
  // Category and YouTube-account accordions control the original Nestrill menu.
  // Source headers are local-only.
  if(expandKind!=='source-display-only')summary.addEventListener('click',e=>{e.preventDefault();setExpanded({kind:expandKind,expanded:!d.open,...meta});});
  d.append(summary,body);return d;
}
function renderMenu(m){
  const scroller=el('scrollpane');
  const changed=displayedProfileId!==null&&
    Number.isSafeInteger(m.profileId)&&m.profileId!==displayedProfileId;
  const offset=changed?0:scroller.scrollTop;
  const cats=el('categories');cats.replaceChildren();
  for(const c of (m.categories||[])){
    // R9K: match native Nestrill's split actions.
    // The disclosure triangle only expands/collapses the site list;
    // clicking the category name opens that category's combined RSS articles.
    const entry=document.createElement('div');
    entry.className='category-entry';
    entry.dataset.key='c:'+c.index+':'+c.label;
    entry.classList.toggle('active',!!c.active);
    const head=document.createElement('div');head.className='category-head';
    const triangle=document.createElement('button');triangle.type='button';
    triangle.className='category-toggle';
    triangle.textContent=c.expanded?'▾':'▸';
    triangle.title=c.expanded?'登録サイトを折りたたむ':'登録サイトを展開';
    triangle.setAttribute('aria-label',c.label+'の登録サイトを'+(c.expanded?'折りたたむ':'展開'));
    triangle.setAttribute('aria-expanded',String(!!c.expanded));
    const body=document.createElement('div');body.className='nested category-feeds';
    body.id='nx-category-feeds-'+c.index;
    body.hidden=!c.expanded;
    triangle.setAttribute('aria-controls',body.id);
    triangle.addEventListener('click',()=>setExpanded({
      kind:'category',expanded:!c.expanded,index:c.index,label:c.label
    }));
    const categoryButton=makeButton(c.label,
      {kind:'category',index:c.index,label:c.label},c.active);
    categoryButton.classList.add('category-select');
    categoryButton.title=c.label+'の記事を表示';
    categoryButton.setAttribute('aria-label',c.label+'の全記事を表示');
    const manage=document.createElement('button');manage.type='button';
    manage.className='category-manage';manage.textContent='⋯';
    manage.title=c.label==='未分類'?'未分類について':'カテゴリの管理';
    manage.setAttribute('aria-label',c.label+'のカテゴリ管理を開く');
    manage.addEventListener('click',()=>openCategoryManage({
      index:c.index,label:c.label,profileId:m.profileId
    }));
    if(m.showCounts && /^\d{1,8}$/.test(c.count||'')){
      const count=document.createElement('span');count.className='nx-native-count';
      count.textContent=c.count;categoryButton.append(count);
    }
    head.append(triangle,categoryButton,manage);
    for(const f of c.feeds||[])body.append(makeButton(f.label,
      {kind:'feed',id:f.id,label:f.label,categoryIndex:f.categoryIndex,categoryLabel:f.categoryLabel},f.active));
    entry.append(head,body);cats.append(entry);
  }
  if(!cats.children.length){const p=document.createElement('p');p.className='empty-note';p.textContent='カテゴリは登録されていません';cats.append(p);}
  const sources=el('sources');sources.replaceChildren();
  for(const source of m.accounts||[]){
    const body=document.createElement('div');body.className='nested';
    body.append(makeButton(source.label+'の記事',{kind:'source',value:source.kind},!!m.selected?.[source.kind]));
    for(const a of source.accounts||[]){
      if(source.kind==='youtube'){
        const sub=document.createElement('div');sub.className='nested';
        sub.append(makeButton(a.label+'の一覧',{kind:'account',source:source.kind,index:a.index,label:a.label}));
        for(const c of a.channels||[])sub.append(makeButton(c.label,
          {kind:'channel',accountIndex:a.index,channelIndex:c.index,label:c.label}));
        body.append(makeDetails('a:'+a.index+':'+a.label,a.label,!!a.expanded,sub,
          'youtube-account',{index:a.index,label:a.label}));
      }else body.append(makeButton(a.label,{kind:'account',source:source.kind,index:a.index,label:a.label}));
    }
    // Keep the source header visible, matching the normal Nestrill menu.
    const sourceDetail=makeDetails('s:'+source.kind,source.label,true,body,'source-display-only',{});
    if(source.kind==='youtube'){
      // R9Q: match native Nestrill's 16x12 red YouTube mark (presentation only).
      sourceDetail.classList.add('nx-source-youtube');
      const mark=document.createElement('span');
      mark.className='nx-source-youtube-mark';mark.setAttribute('aria-hidden','true');
      sourceDetail.querySelector('summary')?.prepend(mark);
    }
    sources.append(sourceDetail);
  }
  if(!sources.children.length){const p=document.createElement('p');p.className='empty-note';p.textContent='追加情報源なし';sources.append(p);}
  el('profile-name').textContent=m.profile||'（不明）';
  if(Number.isSafeInteger(m.profileId))displayedProfileId=m.profileId;
  // Show the same category/article count preference as the native menu.
  // Only mirrored numeric DOM text is used; the extension does not query DB.
  for(const name of ['all','unread']){
    const button=document.querySelector('.main-links [data-value="'+name+'"]');
    if(!button)continue;
    button.querySelector('.nx-native-count')?.remove();
    const count=m.counts?.[name];
    if(m.showCounts && /^\d{1,8}$/.test(count||'')){
      const badge=document.createElement('span');badge.className='nx-native-count';
      badge.textContent=count;button.append(badge);
    }
  }
  for(const b of document.querySelectorAll('.main-links [data-kind],.nav-ai')){
    const kind=b.dataset.kind,which=b.dataset.value;
    b.classList.toggle('selected',kind==='ai'?!!m.selected?.ai:!!m.selected?.[which]);
  }
  scroller.scrollTop=offset;
}
async function refreshMenu(tabId=null,expectedSerial=serial){
  const id=tabId??(await activeTab()).id;
  const r=await requestForTab('NX4_GET_MENU',id);
  if(expectedSerial!==serial)return;
  renderMenu(r.menu);
}
async function syncContext(forceMenu=false){
  const id=++serial;
  let tab,state;
  try{
    tab=await activeTab();
    state=await requestForTab('NX4_GET_STATE',tab.id);
  }catch(e){
    if(serial!==id)return;
    currentView=null;compact=false;lastTabId=null;
    renderCdpStatus(null);
    el('close-x').hidden=true;
    el('link-menu').hidden=true;el('enable-banner').hidden=true;
    const msg=String(e?.message||e);
    const trulyOutside=!!tab && !/^http:\/\/(?:127\.0\.0\.1|localhost):8767(?:\/|$)/.test(tab.url||'') &&
      !/^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)(?:\/|$)/.test(tab.url||'');
    el('out-of-scope').hidden=!trulyOutside;
    el('profile-name').textContent=trulyOutside?'対象外':'状態確認待ち…';
    el('compact-indicator').textContent='共通左ペイン：状態を確認できません';
    if(trulyOutside){clearInitRetry();status('');}
    else scheduleInitRetry('状態取得失敗：'+msg);
    return;
  }
  if(serial!==id)return;
  currentView=state.view;compact=!!state.compact;
  nativeHiddenVerified=state.nativeMenuHiddenVerified!==false;
  el('close-x').hidden=!(state.view==='rss'&&state.overlayActive);
  if(state.secretBlocked){
    lastTabId=null;displayedProfileId=null;
    el('profile-name').textContent='—';
    el('close-x').hidden=true;
    el('link-menu').hidden=true;
    el('categories').replaceChildren();el('sources').replaceChildren();
    el('enable-banner').hidden=true;
    el('out-of-scope').hidden=true;
    el('compact-indicator').textContent='';
    clearInitRetry();
    status('Nestrill X Extensionではシークレットに対応していません。Nestrillのsから通常表示へ戻してください。');
    return;
  }
  el('out-of-scope').hidden=true;
  el('link-menu').hidden=false;
  applyMode();renderCdpStatus(state.xCdpReport);
  if(state.overlayActive){
    const n=el('x-cdp-result');n.hidden=false;
    n.textContent='Nestrill表示：'+(state.overlayReady?'接続確認済':'読込確認中');
  }
  if(currentView==='x'&&state.xKeepReport){
    const n=el('x-cdp-result');n.hidden=false;
    n.textContent='Xの閲覧位置（切替前後）：'+
      state.xKeepReport.before+' → '+state.xKeepReport.after;
  }
  try{
    if(forceMenu||lastTabId!==state.tabId){
      // Keep lastTabId unset until a complete menu was actually rendered.
      await refreshMenu(tab.id,id);
      if(serial!==id)return;
      lastTabId=state.tabId;
    }
    if(serial!==id)return;
    clearInitRetry();status('');
  }catch(e){
    if(serial!==id)return;
    lastTabId=null;
    el('profile-name').textContent='一覧取得待ち…';
    scheduleInitRetry('RSSメニュー取得失敗：'+String(e?.message||e));
  }
}
async function execute(fn){
  if(busy)return;busy=true;status('');
  try{await fn();}catch(e){status(e.message||e);}finally{busy=false;}
}
function navigate(intent){
  execute(async()=>{await request('NX4_NAVIGATE',{intent});});
}
function openCategoryManage(category){
  execute(async()=>{
    // The background script resolves this to Nestrill's existing category
    // management dialog; it never duplicates edit/delete/order logic.
    await request('NX9_OPEN_CATEGORY_MANAGE',{category});
    await syncContext(false);
  });
}
async function setExpanded(intent){
  await execute(async()=>{await request('NX5_SET_EXPANDED',{intent});await refreshMenu();});
}
el('x-switch').addEventListener('click',()=>execute(async()=>{await request('NX4_SWITCH_X');await syncContext(false);}));
el('close-x').addEventListener('click',()=>{
  // Closing destroys the current X scroll state; require explicit confirmation.
  if(!window.confirm('背面のXを終了します。現在のXの閲覧位置は失われ、次回は新しく読み込みます。よろしいですか？'))return;
  execute(async()=>{
    await request('NX9_CLOSE_BACKGROUND_X');
    await syncContext(true);
  });
});

for(const b of document.querySelectorAll('[data-kind]'))b.addEventListener('click',()=>navigate(
  b.dataset.kind==='group'?{kind:'group',value:b.dataset.value}:{kind:b.dataset.kind}));
el('enable-compact').addEventListener('click',()=>execute(async()=>{
  const r=await request('NX4_SET_COMPACT',{enabled:true});
  if(!r.verified)throw Error('Nestrill側で元メニューの非表示を確認できませんでした。');
  compact=true;nativeHiddenVerified=true;applyMode();}));
el('restore-native-pane').addEventListener('click',()=>execute(async()=>{
  const r=await request('NX9_RESTORE_NATIVE_FROM_PANEL');
  compact=false;nativeHiddenVerified=true;applyMode();
  if(!r.panelClosed)status('標準ペインを復元しました。共通サイドパネルは右上の×で閉じてください。');
}));
// Open a dialog in the real Nestrill document (top-level or embedded overlay).
// Never change X's top-level URL, close/reopen its document or enable native sidebar.
function nativeDialog(action){
  execute(async()=>{
    await request('NX9_OPEN_NATIVE_DIALOG',{action});
    await syncContext(false);
  });
}
el('manage').addEventListener('click',()=>nativeDialog('settings'));
el('manage-bottom').addEventListener('click',()=>nativeDialog('settings'));
el('add-feed').addEventListener('click',()=>nativeDialog('add-feed'));
el('manage-profiles').addEventListener('click',()=>nativeDialog('profiles'));
el('reload').addEventListener('click',()=>execute(refreshMenu));
el('retry-init').addEventListener('click',()=>{initRetryCount=0;syncContext(true).catch(console.warn);});
chrome.tabs.onActivated.addListener(()=>{syncContext(true).catch(console.warn);});
chrome.tabs.onUpdated.addListener((_id,change)=>{if(change.status==='complete')syncContext(true).catch(console.warn);});
chrome.runtime.onMessage.addListener((msg,sender)=>{
  if(msg?.type==='NX1_MENU_CHANGED' && sender.tab?.id)
    syncContext(true).catch(console.warn);
  if(msg?.type==='NX8_REPORT_UPDATED')
    syncContext(false).catch(console.warn);
  if(msg?.type==='NX9_SECRET_UPDATED')
    syncContext(true).catch(console.warn);
});
syncContext(true).catch(console.warn);

// R9N: fallback restoration on real panel-document destruction. Do not use
// visibilitychange: merely switching to another browser tab hides the panel
// temporarily and must NOT disable the shared menu.
window.addEventListener('pagehide',()=>{
  if(!Number.isSafeInteger(lastTabId)||lastTabId<=0 || !compact)return;
  try{
    chrome.runtime.sendMessage({type:'NX9_PANEL_PAGEHIDE',currentTabId:lastTabId})
      .catch(()=>{});
  }catch(_){/* onClosed remains the authoritative mechanism */}
});
