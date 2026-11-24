'use strict';
// One real Chrome tab navigates Nestrill <-> real X. Side panel is enabled
// ONLY for that tab: unrelated tabs never inherit a global Nestrill menu.
// No new tabs, browser windows, or tabs.update({active:true}) calls.
const STORE='nxOneTab01Sessions';
const HOST=/^http:\/\/(?:127\.0\.0\.1|localhost):8767(?:\/|$)/;
const XHOME='https://x.com/home';
const locks=new Set();
// Appearance snapshots are transient and scoped to the paired tab only.
const appearances=new Map();
const panelWidths=new Map();
// R9N: side-panel closure may be reported by both onClosed and pagehide.
// Serialize per-tab restoration to keep the operation idempotent.
const panelRestoreInFlight=new Map();
// Proof08: use CDP ONLY on the paired Nestrill tab at RSS -> X return.
// This is a privileged trial. Never attach on unrelated tabs or while X is being viewed.
const isNestrill=u=>typeof u==='string'&&HOST.test(u);
function isX(u){
  try{const p=new URL(u);return p.protocol==='https:'&&
    ['x.com','www.x.com','twitter.com','www.twitter.com'].includes(p.hostname);}
  catch{return false;}
}
function isXHome(u){if(!isX(u))return false;try{return new URL(u).pathname.replace(/\/$/,'')==='/home';}catch{return false;}}
const idKey=id=>String(id);
async function getSessions(){return (await chrome.storage.session.get(STORE))[STORE]||{};}
async function putSessions(s){await chrome.storage.session.set({[STORE]:s});}
async function tabById(id){
  if(!Number.isSafeInteger(id)||id<=0)return null;
  try{return await chrome.tabs.get(id);}catch{return null;}
}
// No global side_panel.default_path in manifest; keep fallback disabled.
// Per-tab options bind the menu to a *tab ID*, not a URL or a window.
const panelOptions=(tabId,enabled)=>({tabId,path:'panel.html',enabled});
async function enableTab(tabId){
  await chrome.sidePanel.setOptions(panelOptions(tabId,true));
}
async function disableTab(tabId){
  try{await chrome.sidePanel.setOptions(panelOptions(tabId,false));}
  catch(e){console.warn('tab panel disable skipped',tabId,e);}
}
async function configure(){
  // Critical: no default/global Nestrill panel in YouTube or other tabs.
  await chrome.sidePanel.setOptions({path:'panel.html',enabled:false});
  await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});
  const s=await getSessions();let dirty=false;
  const tabs=await chrome.tabs.query({});
  for(const [id,v] of Object.entries(s)){
    const tab=tabs.find(t=>idKey(t.id)===id);
    if(!tab||!(isNestrill(tab.url)||isX(tab.url))||!isNestrill(v.nestrillUrl)){
      delete s[id];dirty=true;
    }
  }
  if(dirty)await putSessions(s);
  for(const tab of tabs){
    if(!Number.isInteger(tab.id))continue;
    if(isNestrill(tab.url) || (s[idKey(tab.id)]&&isX(tab.url)))
      await enableTab(tab.id);
    else await disableTab(tab.id);
  }
}
// A URL change INSIDE a paired tab does not create a new tab. Keep that tab's
// panel enabled across its Nestrill <-> X navigations, hide elsewhere.
async function scopeChangedTab(tabId,url){
  const tab=await tabById(tabId);
  if(!tab)return;
  const current=url||tab.url||'';
  if(isNestrill(current)){await enableTab(tabId);return;}
  const sessions=await getSessions();
  if(isX(current)&&sessions[idKey(tabId)]?.nestrillUrl &&
     isNestrill(sessions[idKey(tabId)].nestrillUrl)){
    await enableTab(tabId);return;
  }
  // If a linked tab was navigated to an unrelated URL, cleanly end linkage.
  await disableTab(tabId);
  if(sessions[idKey(tabId)]){
    delete sessions[idKey(tabId)]; await putSessions(sessions);
  }
}
function assertPanel(sender){
  if(sender.id!==chrome.runtime.id||
      !String(sender.url||'').startsWith(chrome.runtime.getURL('panel.html')))
    throw Error('拡張機能の左ペインからのみ操作できます。');
}
async function activeTabFromPanel(sender,msg){
  assertPanel(sender);
  const tab=await tabById(msg.currentTabId);
  if(!tab||!tab.active)throw Error('操作対象のタブを確認できません。');
  return tab;
}
function createSession(url){return {nestrillUrl:url,compact:false,secretBlocked:false,menu:null,pendingIntent:null,returnIntent:null,
  reading:null,readingIntent:null,pendingReading:null,
  xHomeDeparted:false,xCdpReport:null,xSnapshot:null,xDiagAwait:false,overlayActive:false,overlayReady:false,xKeepReport:null};}
function sameReadingIntent(a,b){
  if(!a||!b||a.kind!==b.kind)return false;
  switch(a.kind){
    case 'feed':return a.id===b.id&&a.categoryIndex===b.categoryIndex&&a.label===b.label;
    case 'category':return a.index===b.index&&a.label===b.label;
    case 'group':return a.value===b.value;
    default:return false;
  }
}
async function captureRssReading(tab,session){
  // Only standard RSS scrolling; never collect article text or X contents.
  session.reading=null;session.readingIntent=null;
  if(!isNestrill(tab.url)||!session.returnIntent)return;
  if(!['feed','category','group'].includes(session.returnIntent.kind))return;
  try{
    const r=await chrome.tabs.sendMessage(tab.id,{type:'NX4_CAPTURE_READING'});
    const v=r?.reading;
    if(!r?.ok||!v||!Number.isFinite(v.top)||v.top<0||v.top>10000000||
       typeof v.id!=='string'||v.id.length>70||!Number.isFinite(v.offset)||
       Math.abs(v.offset)>20000||!Number.isSafeInteger(v.loaded)||v.loaded<0||v.loaded>2000||
       typeof v.viewTitle!=='string'||v.viewTitle.length>160||
       !Number.isSafeInteger(v.profile)||v.profile<1)return;
    session.reading={top:v.top,id:v.id,offset:v.offset,loaded:v.loaded,
      viewTitle:v.viewTitle,profile:v.profile};
    session.readingIntent=session.returnIntent;
  }catch(e){console.warn('RSS reading capture skipped',e);}
}
async function getSession(tab){
  const s=await getSessions(),key=idKey(tab.id);
  if(!s[key]&&isNestrill(tab.url))s[key]=createSession(tab.url);
  const session=s[key];
  if(!session||!isNestrill(session.nestrillUrl)||!(isNestrill(tab.url)||isX(tab.url)))
    throw Error('連携対象のNestrillタブではありません。');
  if(isNestrill(tab.url))session.nestrillUrl=tab.url;
  return {all:s,session,key};
}
function inferReturnIntent(menu){
  if(!menu||typeof menu!=='object')return null;
  for(const c of menu.categories||[]){
    for(const f of c.feeds||[])if(f.active)return {
      kind:'feed',id:f.id,label:f.label,categoryIndex:f.categoryIndex,categoryLabel:f.categoryLabel};
    if(c.active)return {kind:'category',index:c.index,label:c.label};
  }
  for(const value of ['all','unread','starred'])if(menu.selected?.[value])return {kind:'group',value};
  if(menu.selected?.ai)return {kind:'ai'};
  for(const value of ['youtube','mail'])if(menu.selected?.[value])return {kind:'source',value};
  return null;
}
function acceptMenuSnapshot(session,menu){
  if(!menu||!Number.isSafeInteger(menu.profileId)||menu.profileId<=0||
     typeof menu.profile!=='string'||!Array.isArray(menu.categories))return false;
  const changed=!!session.menu&&(
    Number.isSafeInteger(session.menu.profileId)
      ? session.menu.profileId!==menu.profileId
      : session.menu.profile!==menu.profile);
  session.menu=menu;
  session.returnIntent=changed?{kind:'group',value:'all'}:
    (inferReturnIntent(menu)||{kind:'group',value:'all'});
  if(changed){
    // Article scroll/selection from another profile must never be replayed.
    session.reading=null;session.readingIntent=null;session.pendingReading=null;
  }
  return true;
}
// R9H: Nestrill intentionally omits feed DOM nodes for collapsed categories.
// The mirrored X menu must not mistake "not rendered" for "no registered feeds".
// Read the same normal-profile overview from the local Nestrill server; never
// touch the database, change collapse state, or contact the X service.
async function fillHiddenCategoryFeeds(session){
  const menu=session.menu;
  if(!menu||session.secretBlocked||!isNestrill(session.nestrillUrl)||
     !Number.isSafeInteger(menu.profileId)||menu.profileId<=0||
     !Array.isArray(menu.categories))return false;
  const missing=menu.categories.filter(c=>Array.isArray(c.feeds)&&c.feeds.length===0);
  if(!missing.length)return false;
  try{
    const url=new URL('/api/overview',session.nestrillUrl);
    // Restrict requests to the paired loopback Nestrill origin only.
    if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='8767')return false;
    const response=await fetch(url.href,{
      method:'GET',headers:{'X-Nestrill-Profile-ID':String(menu.profileId)},
      cache:'no-store',signal:AbortSignal.timeout(1800)
    });
    if(!response.ok||session.menu!==menu)return false;
    const overview=await response.json();
    if(session.menu!==menu||!Array.isArray(overview?.categories)||!Array.isArray(overview?.feeds))return false;
    // Must match the native menu's actual visible category order exactly.
    // Nestrill hides the empty default "未分類" category in the sidebar.
    const visible=overview.categories.filter(c=>c.name!=='未分類'||
      overview.feeds.some(f=>Number(f.categoryId)===Number(c.id)));
    if(visible.length!==menu.categories.length||
       visible.some((c,i)=>!Number.isSafeInteger(c.id)||c.name!==menu.categories[i].label))return false;
    let completed=false;
    for(let i=0;i<visible.length;i++){
      const entry=menu.categories[i];
      if(!Array.isArray(entry.feeds)||entry.feeds.length!==0)continue;
      const full=overview.feeds.filter(f=>Number(f.categoryId)===visible[i].id)
        .slice(0,200).filter(f=>Number.isSafeInteger(f.id)&&f.id>0)
        .map(f=>({id:f.id,categoryIndex:entry.index,categoryLabel:entry.label,
          label:String(f.title??'').replace(/&(?:raquo|#0*187|#x0*bb);/gi,'»')
            .replace(/&(?:laquo|#0*171|#x0*ab);/gi,'«').trim().slice(0,150),
          active:false})).filter(f=>f.label);
      if(full.length){entry.feeds=full;completed=true;}
    }
    return completed;
  }catch(_){
    // If the service is unavailable, preserve the current cached menu.
    return false;
  }
}
async function captureMenu(tab,session){
  if(!isNestrill(tab.url))return;
  try{
    const r=await chrome.tabs.sendMessage(tab.id,{type:'NX2_MENU_SNAPSHOT'});
    if(r?.ok){
      // The last valid menu remains available until the native rebuild is
      // positively confirmed; an empty profile is a valid completed result.
      acceptMenuSnapshot(session,r.menu);
    }
  }catch(e){console.warn('Nestrill menu capture skipped',e);}
}
function isValidIntent(intent){
  if(!intent||typeof intent!=='object')return false;
  if(intent.kind==='group')return ['all','unread','starred'].includes(intent.value);
  if(intent.kind==='ai')return true;
  if(intent.kind==='source')return ['youtube','mail'].includes(intent.value);
  if(intent.kind==='category')return Number.isInteger(intent.index)&&typeof intent.label==='string';
  if(intent.kind==='feed')return Number.isInteger(intent.id)&&Number.isInteger(intent.categoryIndex)&&
    typeof intent.label==='string'&&typeof intent.categoryLabel==='string';
  if(intent.kind==='account')return Number.isInteger(intent.index)&&['youtube','mail'].includes(intent.source)&&typeof intent.label==='string';
  if(intent.kind==='channel')return Number.isInteger(intent.accountIndex)&&Number.isInteger(intent.channelIndex)&&typeof intent.label==='string';
  return false;
}
async function localFrameMessage(tabId,type,extra={}){
  // When the top-level URL is X, local Nestrill is the ONLY frame with
  // NX2_* message listeners; x-overlay.js handles NX9_* instead.
  return chrome.tabs.sendMessage(tabId,{type,...extra});
}
async function snapshotEmbedded(tab,session){
  if(!isX(tab.url)||!session.overlayActive)return;
  try{
    const r=await localFrameMessage(tab.id,'NX2_MENU_SNAPSHOT');
    if(r?.ok){
      acceptMenuSnapshot(session,r.menu);
      // A menu snapshot is NOT the end of initial navigation/restoration.
    }
  }catch(_){/* Initial iframe may still be loading; retain last valid menu. */}
}
async function navigateSameTab(tab,toX,intent){
 const key=idKey(tab.id);
 if(locks.has(key))throw Error('切り替え中です。');
 locks.add(key);
 try{
   if(Number.isInteger(tab.splitViewId)&&tab.splitViewId!==-1)
     throw Error('Heliumの分割表示を解除してから操作してください。');
   const {all,session}=await getSession(tab);
   if(session.secretBlocked)throw Error('Nestrill X Extensionではシークレットを使用できません。Nestrillのsから通常表示へ戻してください。');
   if(toX){
     if(isX(tab.url)){
       const result=await chrome.tabs.sendMessage(tab.id,{type:'NX9_HIDE_OVERLAY'});
       if(!result?.ok)throw Error(result?.error||'Xの表示へ戻せませんでした。');
       session.overlayActive=false;
       session.xKeepReport={before:result.xScrollBefore,after:result.xScrollAfter,delta:result.delta};
       await putSessions(all);
       return {ok:true,tabId:tab.id,view:'x'};
     }
     await captureMenu(tab,session);
     await captureRssReading(tab,session);
     if(!session.menu)throw Error('Nestrillのメニューを取得できません。');
     session.overlayActive=false;
     await putSessions(all);
     // Only FIRST visit navigates away from Nestrill. After this, keep X alive.
     await chrome.tabs.update(tab.id,{url:XHOME});
     return {ok:true,tabId:tab.id,view:'x'};
   }
   if(isNestrill(tab.url)){
     if(intent){
       const r=await localFrameMessage(tab.id,'NX2_MAIN_NAV',{intent});
       if(!r?.ok)throw Error(r?.error||'記事選択に失敗しました。');
       await captureMenu(tab,session);await putSessions(all);
     }
     return {ok:true,tabId:tab.id,view:'rss'};
   }
   if(!isX(tab.url))throw Error('連携対象ではありません。');
   // Store the intent BEFORE first overlay frame loads so NX1_PAGE_READY can apply it.
   // A shared menu accompanies every X-hosted RSS overlay. Persist this
   // BEFORE creating/revealing the iframe so its early/content scripts agree.
   session.compact=true;
   session.pendingIntent=intent||session.returnIntent||{kind:'group',value:'all'};
   session.pendingReading=sameReadingIntent(session.pendingIntent,session.readingIntent)?session.reading:null;
   await putSessions(all);
   const result=await chrome.tabs.sendMessage(tab.id,{type:'NX9_SHOW_OVERLAY'});
   if(!result?.ok){
     session.pendingIntent=null;session.pendingReading=null;
     await putSessions(all);
     throw Error(result?.error||'X上にRSSを表示できません。');
   }
   session.overlayActive=true;
   await putSessions(all);
   // If the iframe has already loaded, send navigation directly; otherwise
   // NX1_PAGE_READY consumes pendingIntent once the local page is ready.
   try{
     const nav=await localFrameMessage(tab.id,'NX2_MAIN_NAV',{intent:session.pendingIntent});
     if(nav?.ok){session.pendingIntent=null;session.pendingReading=null;await snapshotEmbedded(tab,session);await putSessions(all);}
   }catch(_){/* iframe asynchronous load. */}
   return {ok:true,tabId:tab.id,view:'rss'};
 }finally{locks.delete(key);}
}
// End the retained background X document, without closing the Nestrill tab.
// Unlike a normal RSS<->X switch, this intentionally discards X scroll state.
// location.replace() replaces X's history entry, avoiding BFCache retention of
// the replaced X page. The normal keep-alive path above is unchanged.
async function closeBackgroundX(tab){
  const key=idKey(tab.id);
  if(locks.has(key))throw Error('切り替え中です。');
  locks.add(key);
  try{
    if(Number.isInteger(tab.splitViewId)&&tab.splitViewId!==-1)
      throw Error('Heliumの分割表示を解除してから操作してください。');
    const {all,session}=await getSession(tab);
    if(session.secretBlocked)throw Error('シークレット中は利用できません。');
    if(!isX(tab.url)||!session.overlayActive)
      throw Error('背面で保持しているXはありません。RSS表示中に操作してください。');
    if(!isNestrill(session.nestrillUrl))throw Error('戻り先のNestrillを確認できません。');

    // Capture the currently selected RSS view from the genuine local frame.
    // Do not capture X posts, contents or cookies.
    await snapshotEmbedded(tab,session);
    const intent=session.returnIntent||{kind:'group',value:'all'};
    let reading=null;
    if(['feed','category','group'].includes(intent.kind)){
      try{
        const r=await localFrameMessage(tab.id,'NX4_CAPTURE_READING');
        const v=r?.reading;
        if(r?.ok&&v&&Number.isFinite(v.top)&&v.top>=0&&v.top<=10000000&&
           typeof v.id==='string'&&v.id.length<=70&&Number.isFinite(v.offset)&&
           Math.abs(v.offset)<=20000&&Number.isSafeInteger(v.loaded)&&v.loaded>=0&&v.loaded<=2000&&
           typeof v.viewTitle==='string'&&v.viewTitle.length<=160&&
           Number.isSafeInteger(v.profile)&&v.profile>0)
          reading={top:v.top,id:v.id,offset:v.offset,loaded:v.loaded,
            viewTitle:v.viewTitle,profile:v.profile};
      }catch(_){/* No live reading snapshot; keep RSS selection without scroll. */}
    }
    // Keep an immutable rollback if navigation was not accepted.
    const original={...session};
    session.pendingIntent=intent;
    session.pendingReading=reading||(
      sameReadingIntent(intent,session.readingIntent)?session.reading:null);
    session.overlayActive=false;
    session.overlayReady=false;
    session.xKeepReport=null;
    session.xSnapshot=null;
    await putSessions(all);
    try{
      const ack=await chrome.tabs.sendMessage(tab.id,{
        type:'NX9_REPLACE_X_WITH_NESTRILL',targetUrl:session.nestrillUrl});
      if(!ack?.ok)throw Error(ack?.error||'Xを終了できませんでした。');
      // Acknowledgement only means replace was requested. Confirm URL change.
      let returned=false;
      for(let n=0;n<70;n++){
        const current=await tabById(tab.id);
        if(!current)throw Error('対象タブが閉じられました。');
        if(isNestrill(current.url)){returned=true;break;}
        if(!isX(current.url))throw Error('戻り先以外のページが表示されました。');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(!returned)throw Error('XからNestrillへの移動を確認できませんでした。');
      return {ok:true,view:'rss',xClosed:true,tabId:tab.id};
    }catch(e){
      // If X is still active, restore the keep-alive state; do not strand the UI.
      const current=await tabById(tab.id);
      if(current&&isX(current.url)){
        all[key]=original;
        await putSessions(all);
      }
      throw e;
    }
  }finally{locks.delete(key);}
}

// Native dialog first launch can outlast the initial overlay mount / local app startup.
// Bound the waiting without pretending the dialog has opened. Closing the overlay
// while the request waits cancels the pending action rather than opening it unseen.
const NATIVE_DIALOG_MAX_ATTEMPTS = 96; // max ~24 seconds on cold start
// Only the authorized shared side-panel may request these two native dialogs.
// On X, reveal the EXISTING overlay first, without tab navigation; X stays alive.
async function openNativeDialogForTab(tab,action){
  if(!['settings','add-feed','profiles'].includes(action))throw Error('未対応の管理操作です。');
  if(isX(tab.url)){
    const {session}=await getSession(tab);
    if(!session.overlayActive)await navigateSameTab(tab,false,null);
  }
  // The embedded Nestrill iframe and async init() may load later.
  // Track the last stage to distinguish a missing iframe from incomplete app init.
  let lastPhase='Nestrillフレーム接続待ち';
  for(let attempt=0;attempt<NATIVE_DIALOG_MAX_ATTEMPTS;attempt++){
    const active=await tabById(tab.id);
    if(!active||!active.active||!(isNestrill(active.url)||isX(active.url)))
      throw Error('操作中に対象タブが切り替わりました。もう一度お試しください。');
    if(isX(active.url)){
      const {session}=await getSession(active);
      if(!session.overlayActive)
        throw Error('X画面へ戻ったため、管理画面を開く処理を中止しました。');
      // First overlay mount: do not click a native dialog until the embedded
      // Nestrill content script has completed its pending navigation/restore.
      if(!session.overlayReady){
        lastPhase='RSS重ね表示の初期ナビゲーション完了待ち';
        await new Promise(resolve=>setTimeout(resolve,250));
        continue;
      }
    }
    try{
      const result=await localFrameMessage(tab.id,'NX9_NATIVE_DIALOG',{action});
      if(result?.ok)return {ok:true,action,view:'rss',dialogOpened:true};
      if(result?.retry===true){lastPhase=result.error||result.phase||'Nestrill本体の準備待ち';}
      else throw Error(result?.error||'Nestrillの管理画面を開けませんでした。');
    }catch(e){
      // Content script may not exist yet when the overlay iframe is first mounted.
      if(!String(e?.message||e).includes('Receiving end does not exist')&&
         !String(e?.message||e).includes('Could not establish connection'))throw e;
      lastPhase='Nestrillフレームへの接続待ち';
    }
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw Error('初回設定の起動を確認できませんでした（最終状態：'+lastPhase+'）。');
}
// R9L: native category-manager relay. No direct writes and no new tab.
async function openCategoryManageForTab(tab,category){
  if(!category||!Number.isSafeInteger(category.index)||category.index<0||
     typeof category.label!=='string'||!category.label||category.label.length>150||
     !Number.isSafeInteger(category.profileId)||category.profileId<=0)
    throw Error('カテゴリの指定が不正です。');
  const {session}=await getSession(tab);
  if(session.secretBlocked)throw Error('シークレット中はカテゴリを管理できません。');
  const snapshot=session.menu;
  if(!snapshot||snapshot.profileId!==category.profileId||
     !(snapshot.categories||[]).some(c=>c.index===category.index&&c.label===category.label))
    throw Error('選択中のカテゴリが変わりました。左ペインを再確認してください。');
  if(isX(tab.url)&&!session.overlayActive)await navigateSameTab(tab,false,null);
  let phase='Nestrillのカテゴリ一覧待ち';
  for(let attempt=0;attempt<NATIVE_DIALOG_MAX_ATTEMPTS;attempt++){
    const active=await tabById(tab.id);
    if(!active||!active.active||!(isNestrill(active.url)||isX(active.url)))
      throw Error('操作中に対象タブが切り替わりました。');
    if(isX(active.url)){
      const state=(await getSession(active)).session;
      if(!state.overlayActive)throw Error('X画面に戻ったため、カテゴリ管理を中断しました。');
      if(!state.overlayReady){
        phase='RSS重ね表示の準備待ち';
        await new Promise(resolve=>setTimeout(resolve,250));continue;
      }
    }
    try{
      const result=await localFrameMessage(tab.id,'NX9_NATIVE_CATEGORY_MANAGE',{category});
      if(result?.ok)return {ok:true,view:'rss',categoryManaged:true};
      if(result?.retry===true)phase=result.error||'カテゴリ画面の準備待ち';
      else throw Error(result?.error||'カテゴリの管理画面を開けませんでした。');
    }catch(e){
      if(!String(e?.message||e).includes('Receiving end does not exist')&&
         !String(e?.message||e).includes('Could not establish connection'))throw e;
      phase='Nestrillフレームへの接続待ち';
    }
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw Error('カテゴリ管理画面を開けませんでした（最終状態：'+phase+'）。');
}
async function compactChange(tab,on){
  const {all,session}=await getSession(tab);
  if(!isNestrill(tab.url) && !(isX(tab.url)&&session.overlayActive))
    throw Error('元メニューの切替はNestrillのRSS画面で行ってください。');
  if(on&&session.secretBlocked)throw Error('シークレット終了後に共通ペインを開いてください。');
  // On X, this message has a receiver only in the local Nestrill subframe.
  // Never send an arbitrary navigation or modify the retained X document.
  let result;
  try{result=await localFrameMessage(tab.id,'NX4_COMPACT_CHANGED',{enabled:!!on});}
  catch(_){throw Error('Nestrillの元メニューに接続できません。');}
  if(!result?.ok || result.hidden!==!!on)
    throw Error(result?.error||'Nestrillの元メニューの表示状態を確認できませんでした。');
  session.compact=!!on;
  await putSessions(all);
  return {ok:true,compact:!!on,verified:true};
}
// R9N: closing the Helium/Chromium side panel MUST release the hidden native
// menu. Keep the action scoped to the exact tab-specific extension panel.
// Closing a panel while the real X page is in front does not navigate X.
async function restoreNativeOnPanelClose(tabId,reason){
  if(!Number.isSafeInteger(tabId)||tabId<=0)return {ok:false,reason:'invalid-tab'};
  if(panelRestoreInFlight.has(tabId))return panelRestoreInFlight.get(tabId);
  const action=(async()=>{
    const tab=await tabById(tabId);
    if(!tab || !(isNestrill(tab.url)||isX(tab.url)))return {ok:true,skipped:'out-of-scope'};
    const all=await getSessions();
    const session=all[idKey(tabId)];
    if(!session || !isNestrill(session.nestrillUrl) || !session.compact)
      return {ok:true,skipped:'already-native'};
    // When X itself is visible, there is no native menu in the top document.
    // Disarm the persisted compact preference without changing X or its scroll.
    if(isX(tab.url) && !session.overlayActive){
      session.compact=false;
      await putSessions(all);
      return {ok:true,restored:'x-session-disarmed'};
    }
    try{
      const r=await compactChange(tab,false);
      if(!r?.ok || !r.verified)throw Error('native visibility not verified');
      return {ok:true,restored:'live-native'};
    }catch(e){
      // A frame may disappear while closing. At least prevent its next load
      // from inheriting the hidden state; never reload X or terminate a tab.
      const current=await getSessions();
      const now=current[idKey(tabId)];
      if(now && isNestrill(now.nestrillUrl)){
        now.compact=false;
        await putSessions(current);
      }
      console.warn('R9N native restoration deferred until reload',reason,tabId,e);
      return {ok:false,deferred:true};
    }
  })();
  panelRestoreInFlight.set(tabId,action);
  try{return await action;}
  finally{if(panelRestoreInFlight.get(tabId)===action)panelRestoreInFlight.delete(tabId);}
}
async function panelState(sender,msg){
  const tab=await activeTabFromPanel(sender,msg);
  const {session}=await getSession(tab);
  if(isNestrill(tab.url)&&!session.secretBlocked){
    await captureMenu(tab,session);
    const all=await getSessions();
    all[idKey(tab.id)]=session;await putSessions(all);
  }
  let nativeMenuHiddenVerified=true;
  if(isX(tab.url)&&session.overlayActive){
    await snapshotEmbedded(tab,session);
    if(session.compact){
      // Do not report ON as verified merely because the session flag says so.
      // Chromium's nested-frame stylesheet can be missing or the iframe can
      // have reloaded; inspect real computed visibility and repair once.
      let r=null;
      try{r=await localFrameMessage(tab.id,'NX4_VERIFY_COMPACT');}catch(_){}
      if(!r?.ok||r.hidden!==true){
        try{r=await localFrameMessage(tab.id,'NX4_COMPACT_CHANGED',{enabled:true});}
        catch(_){}
      }
      nativeMenuHiddenVerified=!!(r?.ok&&r.hidden===true);
    }
  }
  return {ok:true,view:isX(tab.url)&&!session.overlayActive?'x':'rss',compact:!!session.compact,
    nativeMenuHiddenVerified,tabId:tab.id,hasMenu:!!session.menu,xCdpReport:null,xKeepReport:session.xKeepReport||null,overlayActive:!!session.overlayActive,overlayReady:!!session.overlayReady,
    xSnapshot:session.xSnapshot||null,secretBlocked:!!session.secretBlocked};
}
async function panelMenu(sender,msg){
  const tab=await activeTabFromPanel(sender,msg);
  const {all,session}=await getSession(tab);
  if(session.secretBlocked)throw Error('Nestrill X Extensionではシークレットに対応していません。');
  if(isNestrill(tab.url))await captureMenu(tab,session);
  if(isX(tab.url)&&session.overlayActive)await snapshotEmbedded(tab,session);
  if(!session.menu)throw Error('Nestrillでメニューを読み込んでください。');
  await fillHiddenCategoryFeeds(session);
  await putSessions(all);
  return {ok:true,menu:session.menu};
}
async function expandMenu(sender,msg){
  const tab=await activeTabFromPanel(sender,msg);
  const {all,session}=await getSession(tab);
  const intent=msg.intent;
  if(!intent||!['category','youtube-account'].includes(intent.kind)||
      typeof intent.expanded!=='boolean')throw Error('開閉要求が不正です。');
  if(isX(tab.url)&&!session.overlayActive){
    // Preserve accordion UX on X from a cached menu. Real Nestrill state is
    // not changed until the Nestrill page is displayed again.
    const m=session.menu;
    if(intent.kind==='category'){
      const c=(m?.categories||[]).find(v=>v.index===intent.index&&v.label===intent.label);
      if(!c)throw Error('カテゴリが見つかりません。');
      c.expanded=intent.expanded;
    }else{
      const a=(m?.accounts||[]).find(v=>v.kind==='youtube')?.accounts?.find(v=>v.index===intent.index&&v.label===intent.label);
      if(!a)throw Error('YouTubeアカウントが見つかりません。');
      a.expanded=intent.expanded;
    }
    await putSessions(all);return {ok:true};
  }
  const r=await localFrameMessage(tab.id,'NX5_SET_EXPANDED',{intent});
  if(!r?.ok)throw Error(r?.error||'展開できませんでした。');
  await captureMenu(tab,session);await putSessions(all);
  return {ok:true};
}
async function handle(msg,sender){
  switch(msg.type){
    case 'NX9_SECRET_STATE':{
      if(!sender.tab||!isNestrill(sender.url||'')||
         !(isNestrill(sender.tab.url)||isX(sender.tab.url)) ||
         (isNestrill(sender.tab.url)&&sender.frameId!==0) ||
         (isX(sender.tab.url)&&!(sender.frameId>0)) ||
         typeof msg.active!=='boolean')
        throw Error('不正なシークレット状態通知です。');
      const {all,session}=await getSession(sender.tab);
      session.secretBlocked=msg.active;
      if(msg.active){
        session.menu=null;session.returnIntent=null;session.reading=null;
        session.readingIntent=null;session.pendingReading=null;session.pendingIntent=null;
      }
      await putSessions(all);
      chrome.runtime.sendMessage({type:'NX9_SECRET_UPDATED',tabId:sender.tab.id}).catch(()=>{});
      return {ok:true};
    }
    case 'NX4_STATUS_FOR_TAB':{
      if(!sender.tab||!isNestrill(sender.url||sender.tab.url))throw Error('Nestrillから操作してください。');
      const {session}=await getSession(sender.tab);
      return {ok:true,compact:!!session.compact};
    }
    case 'NX1_PAGE_READY':{
      if(!sender.tab||!isNestrill(sender.url||sender.tab.url))throw Error('Nestrillページではありません。');
      const {all,session}=await getSession(sender.tab);
      const intent=session.pendingIntent;
      const reading=session.pendingReading||null;
      // This is only the start of extension-side initialization; the embedded
      // document will send NX9_EMBEDDED_READY after its pending work finishes.
      session.pendingIntent=null;session.pendingReading=null;
      await putSessions(all);
      return {ok:true,compact:!!session.compact,pendingIntent:intent||null,pendingReading:reading};
    }
    case 'NX9_EMBEDDED_READY':{
      // Only the local Nestrill subframe inside the paired X tab can mark
      // initial overlay work complete. Never accept an unrelated tab/frame.
      if(!sender.tab||!isX(sender.tab.url)||!isNestrill(sender.url||'')||
         !Number.isSafeInteger(sender.frameId)||sender.frameId<=0)
        throw Error('不正なフレームからの準備完了通知です。');
      const {all,session}=await getSession(sender.tab);
      if(!session.overlayActive)throw Error('RSSの重ね表示が終了しています。');
      // An embedded page can be "ready" while its native sidebar remains
      // visible. Verify the exact sender frame before declaring overlay ready.
      if(session.compact){
        let result;
        try{
          result=await chrome.tabs.sendMessage(sender.tab.id,
            {type:'NX4_COMPACT_CHANGED',enabled:true},{frameId:sender.frameId});
        }catch(_){throw Error('RSS内の標準ペインを確認できません。');}
        if(!result?.ok||result.hidden!==true)
          throw Error(result?.error||'RSS内の標準ペインが非表示になっていません。');
      }
      session.overlayReady=true;
      await putSessions(all);
      return {ok:true};
    }
    case 'NX4_GET_STATE':return panelState(sender,msg);
    case 'NX4_GET_MENU':return panelMenu(sender,msg);
    case 'NX9_CLOSE_BACKGROUND_X':{
      const tab=await activeTabFromPanel(sender,msg);
      return closeBackgroundX(tab);
    }
    case 'NX4_SWITCH_X':{
      const tab=await activeTabFromPanel(sender,msg);
      return navigateSameTab(tab,true);
    }
    case 'NX4_NAVIGATE':
    case 'NX4_BACK_RSS':{
      const tab=await activeTabFromPanel(sender,msg);
      if(msg.intent&&!isValidIntent(msg.intent))throw Error('選択項目の形式が不正です。');
      return navigateSameTab(tab,false,msg.intent||null);
    }
    case 'NX4_SET_COMPACT':{
      const tab=await activeTabFromPanel(sender,msg);
      if(typeof msg.enabled!=='boolean')throw Error('切替設定が不正です。');
      return compactChange(tab,msg.enabled);
    }
    case 'NX5_SET_EXPANDED':return expandMenu(sender,msg);
    case 'NX9_OPEN_NATIVE_DIALOG':{
      const tab=await activeTabFromPanel(sender,msg);
      return openNativeDialogForTab(tab,msg.action);
    }
    case 'NX9_OPEN_CATEGORY_MANAGE':{
      const tab=await activeTabFromPanel(sender,msg);
      return openCategoryManageForTab(tab,msg.category);
    }
    case 'NX9_APPEARANCE_PUSH': {
      if(!sender.tab||!isNestrill(sender.url||'')||
         !(isNestrill(sender.tab.url)||isX(sender.tab.url)))
        throw Error('Nestrill以外からの外観通知です。');
      const {session}=await getSession(sender.tab);
      if(!session)throw Error('Nestrill連携がありません。');
      const raw=msg.appearance;
      if(!raw||typeof raw!=='object'||JSON.stringify(raw).length>10000)
        throw Error('外観情報が不正です。');
      // Secret mode is private to the Nestrill document, never mirror its media.
      appearances.set(sender.tab.id,raw.secret?{secret:true}:raw);
      try{await chrome.runtime.sendMessage({type:'NX9_APPEARANCE_UPDATED',tabId:sender.tab.id});}
      catch(_){}
      const width=panelWidths.get(sender.tab.id);
      if(width)chrome.tabs.sendMessage(sender.tab.id,{type:'NX9_PANEL_METRICS',width}).catch(()=>{});
      return {ok:true};
    }
    case 'NX9_GET_APPEARANCE': {
      const tab=await activeTabFromPanel(sender,msg);
      await getSession(tab);
      let v=appearances.get(tab.id);
      if(!v){
        const r=await chrome.tabs.sendMessage(tab.id,{type:'NX9_APPEARANCE_SNAPSHOT'});
        if(r?.ok&&r.appearance)v=r.appearance;
      }
      return {ok:true,appearance:v||null};
    }
    case 'NX9_PANEL_WIDTH': {
      const tab=await activeTabFromPanel(sender,msg);
      await getSession(tab);
      const w=Number(msg.width);
      if(!Number.isFinite(w)||w<160||w>900)throw Error('左ペインの幅が不正です。');
      panelWidths.set(tab.id,w);
      chrome.tabs.sendMessage(tab.id,{type:'NX9_PANEL_METRICS',width:w}).catch(()=>{});
      return {ok:true};
    }
    case 'NX9_RESTORE_NATIVE_FROM_PANEL':{
      const tab=await activeTabFromPanel(sender,msg);
      const {session}=await getSession(tab);
      if(isX(tab.url)&&!session.overlayActive)
        throw Error('X表示中は、RSSの記事一覧へ戻ってから操作してください。');
      await compactChange(tab,false);
      let panelClosed=false;
      try{
        if(typeof chrome.sidePanel.close==='function'){
          await chrome.sidePanel.close({tabId:tab.id});
          panelClosed=true;
        }
      }catch(e){console.warn('Panel close was not supported; use the panel X button',e);}
      return {ok:true,compact:false,verified:true,panelClosed};
    }
    case 'NX9_PANEL_PAGEHIDE':{
      // Fallback for Chromium derivatives that omit sidePanel.onClosed.
      // A navigation/reload of panel.html may also fire this event; in that
      // case a safe, reversible native restoration is preferable to a blank UI.
      assertPanel(sender);
      if(!Number.isSafeInteger(msg.currentTabId)||msg.currentTabId<=0)
        throw Error('サイドパネルの対象タブが不正です。');
      return restoreNativeOnPanelClose(msg.currentTabId,'pagehide');
    }
    case 'NX4_RESTORE_NATIVE':{
      // Legacy local page recovery message. The floating button was removed.
      if(!sender.tab||!isNestrill(sender.url||sender.tab.url))throw Error('Nestrillページではありません。');
      return compactChange(sender.tab,false);
    }
  }
  throw Error('不明な操作です。');
}
chrome.runtime.onInstalled.addListener(()=>configure().catch(console.error));
chrome.runtime.onStartup.addListener(()=>configure().catch(console.error));
// Chrome 142+: authoritative tab-specific panel close event. Some
// Chromium forks do not expose it, so panel.js also sends a pagehide signal.
// Ignore window/global events: never modify a different tab's menu.
if(typeof chrome.sidePanel?.onClosed?.addListener==='function'){
  chrome.sidePanel.onClosed.addListener(info=>{
    const path=String(info?.path||'');
    if(path && !/(?:^|\/)panel\.html(?:[?#]|$)/.test(path))return;
    if(!Number.isSafeInteger(info?.tabId)||info.tabId<=0)return;
    restoreNativeOnPanelClose(info.tabId,'sidePanel.onClosed')
      .catch(e=>console.warn('R9N panel-close restoration failed',info.tabId,e));
  });
}
// Re-apply tab-specific enable/disable on every actual tab switch.
// This also covers previously-open tabs that did not generate onUpdated.
chrome.tabs.onActivated.addListener(({tabId})=>{
  scopeChangedTab(tabId).catch(e=>console.warn('tab scope on activation',tabId,e));
});
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{
  if(change.url || change.status==='loading'){
    scopeChangedTab(tabId,change.url||tab.url).catch(e=>console.warn('scope',tabId,e));
  }
});
// R9O: sidePanel.open() MUST be called synchronously inside the message
// listener triggered by the user's click. An async secret check, setOptions,
// or Promise.resolve().then(handle) here loses Chromium's transient gesture.
// Panel options are already enabled per tab on tab activation/navigation.
function openPanelDirectlyFromClick(sender,respond){
  if(!sender.tab || !Number.isSafeInteger(sender.tab.id) || sender.tab.id<=0 ||
     !isNestrill(sender.url||sender.tab.url) || sender.id!==chrome.runtime.id){
    respond({ok:false,error:'Nestrill画面から開いてください。'});
    return;
  }
  try{
    // Do not await anything before this call. Also never use windowId:
    // the panel belongs only to this specific paired Nestrill/X tab.
    const opening=chrome.sidePanel.open({tabId:sender.tab.id});
    Promise.resolve(opening).then(
      ()=>respond({ok:true}),
      async e=>{
        // If activation raced with per-tab setup, prepare for the NEXT click
        // rather than silently retrying without a user gesture.
        try{await enableTab(sender.tab.id);}catch(_){}
        console.warn('R9O side-panel open failed',sender.tab.id,e);
        respond({ok:false,error:'共通ペインを開けませんでした。もう一度押してください。'+String(e?.message||e)});
      }
    );
  }catch(e){
    console.warn('R9O synchronous side-panel open failed',sender.tab.id,e);
    // A fork may throw synchronously when per-tab options are not ready.
    // Prepare for the next explicit click, never re-open without its gesture.
    Promise.resolve().then(()=>enableTab(sender.tab.id)).catch(()=>{}).finally(()=>
      respond({ok:false,error:'共通ペインを開けませんでした。もう一度押してください。'+String(e?.message||e)})
    );
  }
}
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
  if(msg?.type==='NX1_OPEN_PANEL'){
    openPanelDirectlyFromClick(sender,respond);
    return true; // respond when the open promise resolves; open() was synchronous.
  }
  if(!msg||!['NX4_STATUS_FOR_TAB','NX1_PAGE_READY','NX9_EMBEDDED_READY','NX4_GET_STATE',
     'NX4_GET_MENU','NX4_SWITCH_X','NX9_CLOSE_BACKGROUND_X','NX4_NAVIGATE','NX4_BACK_RSS','NX4_SET_COMPACT',
     'NX5_SET_EXPANDED','NX9_OPEN_NATIVE_DIALOG','NX9_OPEN_CATEGORY_MANAGE','NX4_RESTORE_NATIVE','NX9_RESTORE_NATIVE_FROM_PANEL',
     'NX9_APPEARANCE_PUSH','NX9_GET_APPEARANCE','NX9_PANEL_WIDTH',
     'NX9_SECRET_STATE','NX9_PANEL_PAGEHIDE'].includes(msg.type))return false;
  Promise.resolve().then(()=>handle(msg,sender)).then(respond)
    .catch(e=>respond({ok:false,error:String(e.message||e)}));
  return true;
});
chrome.tabs.onRemoved.addListener(async tabId=>{
  try{const s=await getSessions();appearances.delete(tabId);panelWidths.delete(tabId);
    if(s[idKey(tabId)]){delete s[idKey(tabId)];await putSessions(s);}}
  catch(e){console.warn('session cleanup',e);}
});
