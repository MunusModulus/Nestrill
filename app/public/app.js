'use strict';
const $=id=>document.getElementById(id);
const state={overview:null,theme:null,group:'all',category:null,feed:null,filter:'all',q:'',view:'list',page:0,total:0,articles:[],loading:false,settingsSlot:'general',settingsSnapshot:null,wallpaperRevision:0,placeholders:{missing:'',failed:''},placeholderSnapshot:null,installedFonts:[],fontDetected:false,profileId:0,profiles:[],lastThemeBeforePreset:null,secretToken:null,secretProfileId:0,regularProfileId:1,sourceKind:null,sourceAccountId:0,sourceChannelId:"",sourceAccounts:[],youtubeChannels:{},youtubeChannelVideos:[],youtubeChannelLoading:false,youtubeData:{accounts:[],videos:[],running:[]},youtubeBusy:false,aiKind:null};
const clone=o=>JSON.parse(JSON.stringify(o));
const collapsed=new Set();try{for(const id of JSON.parse(localStorage.getItem('nestrill-collapsed')||'[]'))collapsed.add(id)}catch{}
// Fix83A: browser-local AI RSS display rules. Never change cached scores or AI evidence.
const AI_VISIBILITY_KEY_PREFIX='nestrill-ai-visibility-v1:';
let secretAiVisibility=null;
function normalizeAiVisibility(raw){
 const src=raw&&typeof raw==='object'?raw:{};
 const terms=key=>Array.isArray(src[key])?[...new Set(src[key].filter(x=>typeof x==='string').map(x=>x.trim()).filter(Boolean).map(x=>x.slice(0,240)))].slice(0,40):[];
 return {hideYoutube:src.hideYoutube===true,titleTerms:terms('titleTerms'),domainTerms:terms('domainTerms')};
}
function readAiVisibility(){
 if(state.secretToken)return normalizeAiVisibility(secretAiVisibility);
 try{return normalizeAiVisibility(JSON.parse(localStorage.getItem(AI_VISIBILITY_KEY_PREFIX+String(state.profileId||1))||'{}'))}
 catch{return normalizeAiVisibility({})}
}
function saveAiVisibility(value){
 const clean=normalizeAiVisibility(value);
 if(state.secretToken)secretAiVisibility=clean; // Do not persist secret settings or IDs in localStorage.
 else localStorage.setItem(AI_VISIBILITY_KEY_PREFIX+String(state.profileId||1),JSON.stringify(clean));
}
function aiVisibleNorm(s){return String(s||'').normalize('NFKC').toLocaleLowerCase('ja-JP')}
function aiVisibleHost(url){try{const parsed=new URL(String(url||''));return /^https?:$/.test(parsed.protocol)?parsed.hostname.toLowerCase().replace(/^www\./,''):''}catch{return ''}}
function aiYoutubeVideo(item){
 const src=String(item.source||''),title=String(item.title||'');
 const hosts=[item.url,item.articleUrl,item.openUrl].map(aiVisibleHost);
 return hosts.some(h=>h==='youtube.com'||h.endsWith('.youtube.com')||h==='youtu.be'||h.endsWith('.youtu.be'))||
  /^\s*youtube\s*(?:[（(]|$)/i.test(src)||/\s[-–—]\s*youtube\s*$/i.test(title);
}
function aiItemDomainNames(item){
 const raw=String(item.source||'');
 const hosts=[item.url,item.articleUrl,item.openUrl].map(aiVisibleHost).filter(Boolean);
 for(const match of raw.matchAll(/(?:^|[^\w.-])([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=$|[^\w.-])/gi))hosts.push(match[1].toLowerCase().replace(/^www\./,''));
 if(aiYoutubeVideo(item))hosts.push('youtube.com');
 return [...new Set(hosts)];
}
function aiVisibleItem(item,prefs){
 if(prefs.hideYoutube&&aiYoutubeVideo(item))return false;
 const title=aiVisibleNorm(item.title);
 if(prefs.titleTerms.some(t=>title.includes(aiVisibleNorm(t))))return false;
 const hosts=aiItemDomainNames(item);
 return !prefs.domainTerms.some(term=>{
  const domain=aiVisibleHost('https://'+String(term).trim().replace(/^https?:\/\//i,''))||String(term).toLowerCase().replace(/^www\./,'');
  return domain&&hosts.some(h=>h===domain||h.endsWith('.'+domain));
 });
}
function aiFilterShownItems(items,kind){
 if(kind!=='rss'||!Array.isArray(items))return Array.isArray(items)?items:[];
 const prefs=readAiVisibility();return items.filter(it=>aiVisibleItem(it,prefs));
}
function renderAiVisibilitySettings(root){
 const section=persistentSettingsAccordion('ai-visibility','AIセレクトの表示・非表示',false,'ai-managed-details ai-exclusions-section');
 const cfg=readAiVisibility();
 section.append(elt('p','help','ここでの指定はE2記事一覧の表示だけに適用します。収集済み記事や評価履歴は変更しません。サイトやパスを候補から除外する場合は「除外サイト・URLパス一覧」をご利用ください。'));
 const toggle=elt('label','checkbox-label'),box=elt('input');box.type='checkbox';box.checked=cfg.hideYoutube;
 toggle.append(box,elt('span','','AIセレクトに含まれるYouTube動画を非表示にする（Googleニュース経由も含む）'));section.append(toggle);
 const titles=elt('textarea','ai-interests-textarea');titles.rows=3;titles.maxLength=9600;titles.placeholder='表示したくないタイトルの一部';titles.value=cfg.titleTerms.join('\n');
 section.append(field('非表示にする記事タイトルの一部（1行につき1語句）',titles));
 const domains=elt('textarea','ai-interests-textarea');domains.rows=2;domains.maxLength=9600;domains.placeholder='example.com\nyoutube.com';domains.value=cfg.domainTerms.join('\n');
 section.append(field('非表示にするドメイン（1行につき1ドメイン）',domains));
 const status=elt('p','help','このブラウザの現在のプロファイルに保存します。シークレットでは一時的な指定のみです。');
 status.setAttribute('role','status');
 const save=action('表示ルールを保存',()=>{
  const lines=boxValue=>boxValue.split(/\r?\n/g).map(x=>x.trim()).filter(Boolean);
  const t=lines(titles.value),d=lines(domains.value);
  if(t.length>40||d.length>40){status.textContent='各リストは最大40件です';return}
  try{
   saveAiVisibility({hideYoutube:box.checked,titleTerms:t,domainTerms:d});
   status.textContent='保存しました。現在の表示にも反映します（再生成は不要）。';
   if(state.aiKind==='rss')selectAiKind('rss').catch(err);
  }catch(e){status.textContent='保存できません：'+e.message}
 },false);
 section.append(save,status);
 section.append(action('除外サイト・URLパスを管理',()=>openAiSourceExclusionManager(()=>{state.settingsSlot='ai';renderSettings()}),false));
 root.append(section);
}
function hideAiTitleOnce(item){
 const title=String(item.title||'').trim();if(!title)return false;
 const cfg=readAiVisibility();
 if(!cfg.titleTerms.includes(title))cfg.titleTerms.push(title);
 saveAiVisibility(cfg);
 return true;
}
function renderNestrillAbout(root){
 root.append(elt('h3','','Nestrill'),elt('p','help','ローカルRSS・YouTubeリーダー'));
 const author=elt('p','','Author：');
 const link=elt('a','','Munus Modulus');link.href='https://github.com/MunusModulus/';link.target='_blank';link.rel='noopener noreferrer';
 author.append(link);root.append(author);
 const actions=elt('div','form-actions');actions.append(action('閉じる',closeDialog,false));root.append(actions);
}
// Make only the small profile label larger; keep the user's configured sidebar font intact.
(function installNestrillProfileLabelStyle(){
 const style=document.createElement('style');style.id='nestrill-fix83a-profile-label';
 style.textContent='.profile-bar label[for="profile-select"]{font-size:12px !important;}';
 document.head.append(style);
})();

const SIDEBAR_COLLAPSE_KEY='nestrill-sidebar-folded';
// RSS list icons are a browser-local appearance preference, not feed or profile data.
const FEED_ICON_PREF_KEY='nestrill-feed-icons';
state.feedIcons=localStorage.getItem(FEED_ICON_PREF_KEY)!=='0';
state.feedIconsDraft=null;
// Reading UI preference: browser-local display only, no changes to AI signals or profiles.
const AI_ACTION_MODE_KEY='nestrill-ai-action-display';
state.aiActionMode=localStorage.getItem(AI_ACTION_MODE_KEY)==='icons'?'icons':'text';
state.aiActionModeDraft=null;
function applyAiActionMode(){document.documentElement.classList.toggle('ai-actions-icons',state.aiActionMode==='icons')}
// Decode only presentation remnants from previously saved feed names.
function displayFeedTitle(value){return String(value??'').replace(/&(?:raquo|#0*187|#x0*bb);/gi,'»').replace(/&(?:laquo|#0*171|#x0*ab);/gi,'«')}
function setSidebarFolded(folded){
 document.documentElement.classList.toggle('nestrill-sidebar-collapsed',!!folded);
 $('sidebar-collapse-btn').setAttribute('aria-expanded',String(!folded));
 $('sidebar-expand-btn').setAttribute('aria-expanded',String(!folded));
 $('splitter').title=folded?'フィード一覧を展開すると幅を調整できます':'ドラッグして左ペインの幅を変更';
 localStorage.setItem(SIDEBAR_COLLAPSE_KEY,folded?'1':'0');
}

async function api(url,opts={}){const response=await fetch(url,{...opts,headers:{'X-Nestrill-Profile-ID':String(state.profileId||1),...(state.secretToken?{'X-Nestrill-Secret':state.secretToken}:{}),...(opts.body&&!opts.headers?{'Content-Type':'application/json'}:{}),...opts.headers}});const ct=response.headers.get('content-type')||'';const value=ct.includes('application/json')?await response.json():await response.text();if(!response.ok)throw Error(value.error||String(value));return value}
const post=(url,params)=>api(url,{method:'POST',body:JSON.stringify(params)});
const patch=(url,params)=>api(url,{method:'PATCH',body:JSON.stringify(params)});
const del=url=>api(url,{method:'DELETE',body:'{}',headers:{'Content-Type':'application/json'}});
function notify(msg){$('status-message').textContent=msg;clearTimeout(notify.timer);notify.timer=setTimeout(()=>{$('status-message').textContent=''},6500)}
function err(e){console.error(e);notify('エラー: '+e.message)}
function elt(tag,className='',text){const e=document.createElement(tag);if(className)e.className=className;if(text!=null)e.textContent=text;return e}
function fmtTime(time){let n=Date.now()-time;const mins=Math.max(0,Math.floor(n/60000));if(mins<1)return 'たった今';if(mins<60)return `${mins}分前`;if(mins<1440)return `${Math.floor(mins/60)}時間前`;if(mins<43200)return `${Math.floor(mins/1440)}日前`;return new Date(time).toLocaleDateString('ja-JP',{year:'numeric',month:'numeric',day:'numeric'})}
function closeMobile(){$('sidebar').classList.remove('open');$('mobile-scrim').classList.add('hidden')}
function currentCategory(){if(state.category)return state.overview?.categories.find(x=>x.id===state.category);if(state.feed)return state.overview?.categories.find(x=>x.id===state.overview?.feeds.find(f=>f.id===state.feed)?.categoryId);return null}
function titleOf(){if(state.feed)return displayFeedTitle(state.overview?.feeds.find(f=>f.id===state.feed)?.title||'RSS');if(state.category)return currentCategory()?.name||'カテゴリ';return ({all:'すべての記事',unread:'未読の記事',starred:'お気に入り'})[state.group]}
async function loadProfiles(){if(state.secretToken){$('profile-select').hidden=true;$('profile-manager-btn').hidden=true;$('secret-profile-label').hidden=false;return}
 $('profile-select').hidden=false;$('profile-manager-btn').hidden=false;$('secret-profile-label').hidden=true;
 const data=await api('/api/profiles');state.profiles=data.profiles||[];
 const stored=Number(localStorage.getItem('nestrill-profile-id')||1);
 if(!state.profiles.some(p=>p.id===state.profileId)){state.profileId=state.profiles.some(p=>p.id===stored)?stored:1}
 const select=$('profile-select');select.replaceChildren();for(const p of state.profiles){const o=elt('option','',p.name);o.value=p.id;select.append(o)}select.value=String(state.profileId);
}
async function switchProfile(id){if(state.secretToken||!state.profiles.some(p=>p.id===id))return;
 state.aiKind=null;state.sourceKind=null;state.sourceAccountId=0;state.sourceChannelId="";state.sourceAccounts=[];state.youtubeChannels={};state.youtubeChannelVideos=[];state.youtubeChannelLoading=false;state.youtubeData={accounts:[],videos:[],running:[]};setSourcePanelVisible(false);
 state.profileId=id;localStorage.setItem('nestrill-profile-id',String(id));state.category=null;state.feed=null;state.group='all';state.filter='all';$('filter-select').value='all';state.q='';$('search').value='';state.view=localStorage.getItem('nestrill-default-view')||'list';renderViewButtons();
 closeMobile();++youtubeChannelSerial;++youtubeSidebarSerial;youtubeCollapsedAccounts.clear();await loadProfiles();await loadSourceAccounts();await loadOverview();await loadArticles();notify('プロファイルを切り替えました。外観プリセットは変わりません。');
}
// Explicit, local-only view switch. Never persist secret token/profile in localStorage.
let secretSwitchBusy=false;
async function toggleSecret(){
 if(secretSwitchBusy)return;secretSwitchBusy=true;const entering=!state.secretToken;
 try{
  ++loadSerial;++youtubeChannelSerial;++youtubeSidebarSerial;youtubeCollapsedAccounts.clear();closeDialog();closeMobile();state.articles=[];state.total=0;state.overview=null;state.aiKind=null;state.sourceKind=null;state.sourceAccountId=0;state.sourceChannelId="";state.sourceAccounts=[];state.youtubeChannels={};state.youtubeChannelVideos=[];state.youtubeChannelLoading=false;state.youtubeData={accounts:[],videos:[],running:[]};setSourcePanelVisible(false);clearSourceAccountLists();$('view-title').textContent='すべての記事';$('article-count').textContent='0 件';
  $('article-list').replaceChildren();$('category-list').replaceChildren();
  if(entering){
   state.regularProfileId=state.profileId||1;
   // Enter without sending the previous profile ID as an authorization mechanism.
   const data=await post('/api/secret/enter',{});
   state.secretToken=data.token;state.secretProfileId=data.profileId;state.profileId=data.profileId;
  }else{
   await post('/api/secret/exit',{});
   state.secretToken=null;state.secretProfileId=0;state.profileId=state.regularProfileId||1;
  }
  document.documentElement.classList.toggle('secret-active',!!state.secretToken);
  state.category=null;state.feed=null;state.group='all';state.filter='all';state.q='';state.page=0;
  $('search').value='';$('filter-select').value='all';state.lastThemeBeforePreset=null;
  state.theme=await api('/api/theme');reloadAppearance();
  await loadProfiles();await loadSourceAccounts();await loadOverview();await loadArticles();
 }catch(e){
  // Fail closed: reset visual state, never leave secret content displayed after an error.
  state.secretToken=null;state.secretProfileId=0;state.profileId=state.regularProfileId||1;
  document.documentElement.classList.remove('secret-active');$('article-list').replaceChildren();
  await loadProfiles().catch(()=>{});await loadSourceAccounts().catch(()=>{});await loadOverview().catch(()=>{});await loadArticles().catch(()=>{});err(e);
 }finally{secretSwitchBusy=false}
}
function showProfileManager(){if(state.secretToken)return;const root=elt('div');root.append(elt('p','help','プロファイルによって表示するRSSソースとカテゴリを切り替えます。記事の取得データは共通です。外観プリセットは独立して切り替えられます。'));
 const list=elt('div','management-list');for(const p of state.profiles){const item=elt('div','management-row');const info=elt('div','management-name');info.append(elt('strong','',p.name),elt('small','',`${p.feedCount}ソース${p.id===state.profileId?' · 表示中':''}`));
 const actions=elt('div','management-actions');actions.append(action('選択',()=>{closeDialog();switchProfile(p.id).catch(err)},false));
 actions.append(action('改名',async()=>{const name=prompt('プロファイルの新しい名前',p.name);if(name==null)return;try{await patch('/api/profiles/'+p.id,{name});await loadProfiles();showProfileManager()}catch(e){err(e)}},false));
 actions.append(action('複製',async()=>{const name=prompt('複製するプロファイル名',p.name+' のコピー');if(name==null)return;try{await post('/api/profiles',{name,copyFrom:p.id});await loadProfiles();showProfileManager()}catch(e){err(e)}},false));
 if(p.id!==1)actions.append(action('削除',async()=>{if(!confirm(`「${p.name}」を削除しますか？\nRSSと記事データ本体は削除されません。`))return;try{await del('/api/profiles/'+p.id);if(state.profileId===p.id){state.profileId=1;localStorage.setItem('nestrill-profile-id','1');await loadOverview();await loadArticles()}await loadProfiles();await loadSourceAccounts();showProfileManager()}catch(e){err(e)}},false));
 item.append(info,actions);list.append(item)}root.append(list);
 const name=input('新しいプロファイル名');root.append(field('新規プロファイル（空で作成）',name));
 const foot=elt('div','form-actions');foot.append(action('閉じる',closeDialog,false),action('新規作成',async()=>{try{const result=await post('/api/profiles',{name:name.value});await loadProfiles();closeDialog();await switchProfile(result.id)}catch(e){err(e)}}));root.append(foot);openDialog('プロファイルを管理',root);
}
function showPresets(){const root=elt('div');root.append(elt('p','help',state.secretToken?'共通プリセットに加え、シークレット専用プリセットを表示しています。専用プリセットは通常モードから見えません。':'プリセットは外観のみを保存します。どのプロファイルからも共通で利用できます。RSS登録・既読・カテゴリは変更しません。'));
 const list=elt('div','management-list');const undo=action('適用前の外観に戻す',async()=>{if(!state.lastThemeBeforePreset)return;try{await post('/api/theme',state.lastThemeBeforePreset);state.theme=await api('/api/theme');state.lastThemeBeforePreset=null;reloadAppearance();showPresets();notify('適用前の外観に戻しました')}catch(e){err(e)}},false);undo.disabled=!state.lastThemeBeforePreset;root.append(undo);
 api('/api/presets').then(data=>{if(!$('dialog-body').contains(root))return;list.replaceChildren();const presets=data.presets||[];
  if(!presets.length)list.append(elt('p','help','プリセットはまだありません。現在の外観を名前付きで保存できます。'));
  for(const preset of presets){const item=elt('div','management-row'),info=elt('div','management-name');info.append(elt('strong','',preset.name+(preset.isSecret?'  🔒':'')));

   const controls=elt('div','management-actions');controls.append(action('適用',async()=>{try{const before=clone(state.theme);const data=await post('/api/presets/'+preset.id+'/apply',{});state.lastThemeBeforePreset=before;state.theme=data.theme;reloadAppearance();showPresets();notify('外観プリセット「'+preset.name+'」を適用しました')}catch(e){err(e)}},false));
   if(!state.secretToken||preset.isSecret)controls.append(action('改名',async()=>{const name=prompt('プリセットの新しい名前',preset.name);if(name==null)return;try{await patch('/api/presets/'+preset.id,{name});showPresets()}catch(e){err(e)}},false));
   controls.append(action('複製',async()=>{const name=prompt('複製後の名前',preset.name+' のコピー');if(name==null)return;try{await post('/api/presets/'+preset.id+'/duplicate',{name});showPresets()}catch(e){err(e)}},false));
   if(!state.secretToken||preset.isSecret)controls.append(action('削除',async()=>{if(!confirm(`プリセット「${preset.name}」を削除しますか？\n現在の外観設定は消えません。`))return;try{await del('/api/presets/'+preset.id);showPresets()}catch(e){err(e)}},false));
   item.append(info,controls);list.append(item)}
 }).catch(err);root.append(list);
 const name=input(state.secretToken?'例：シークレット01':'例：Blue Glass');root.append(field(state.secretToken?'シークレット専用プリセットとして現在の外観を保存':'現在の保存済み外観をプリセットとして登録',name,'外観の調整は［設定］→［設定を保存］で確定してから登録してください。'));
 if(state.secretToken){const setting=elt('div','secret-preset-default');
  const selector=elt('select');selector.append(new Option('指定なし（現在のシークレット外観を保持）','0'));
  Promise.all([api('/api/presets'),api('/api/secret/default-preset')]).then(([data,setting])=>{
   for(const preset of data.presets||[])if(preset.isSecret)selector.append(new Option(preset.name,String(preset.id)));
   selector.value=String(setting.id||0);
  }).catch(err);
  const saveDefault=action('入室時の外観に設定',async()=>{try{await post('/api/secret/default-preset',{id:Number(selector.value)});notify('シークレット入室時のプリセットを更新しました')}catch(e){err(e)}},false);
  setting.append(field('シークレット入室時に自動適用するプリセット',selector),saveDefault);
  root.append(setting);
 }
 const foot=elt('div','form-actions');foot.append(action('閉じる',closeDialog,false),action('名前を付けて保存',async()=>{try{await post('/api/presets',{name:name.value});showPresets();notify('外観プリセットを保存しました')}catch(e){err(e)}}));root.append(foot);openDialog('外観プリセット',root);
}
function reloadAppearance(){for(const slot of ['shared','left','right'])if(wallpaperState[slot])wallpaperState[slot].signature='';applyTheme();renderArticles();}
// The fallback category still exists in SQLite and remains available as a
// destination when registering/moving RSS feeds. It only appears in the
// sidebar while the CURRENT profile has at least one feed assigned to it.
// Count assigned feeds, not unread articles: a read or empty feed still counts.
function categoryVisibleInSidebar(c,overview){
 return c.name!=='未分類'||overview.feeds.some(f=>Number(f.categoryId)===Number(c.id));
}
async function loadOverview(){
 const token=state.secretToken,profile=state.profileId;
 const data=await api('/api/overview');
 if(token!==state.secretToken||profile!==state.profileId)return;
 state.overview=data;
 // If the last unclassified feed was moved away while this category was
 // selected, return to All rather than leave an invisible selection active.
 if(state.category&&!data.categories.some(c=>Number(c.id)===Number(state.category)&&categoryVisibleInSidebar(c,data))){
  state.category=null;state.feed=null;state.group='all';state.filter='all';$('filter-select').value='all';
 }
 renderSidebar();$('update-indicator').textContent=data.refreshing?'更新中…':'';
}
function renderSidebar(){const ov=state.overview;if(!ov)return;
 $('ai-rss').classList.toggle('active',state.aiKind==='rss');
 const railAi=$('rail-ai');if(railAi){
  const selected=state.aiKind==='rss';railAi.classList.toggle('active',selected);
  if(selected)railAi.setAttribute('aria-current','page');else railAi.removeAttribute('aria-current');
 }
 $('all-count').textContent=ov.total||'';$('unread-count').textContent=ov.unread||'';
 ['all','unread','starred'].forEach(g=>{const active=!state.sourceKind&&!state.aiKind&&!state.category&&!state.feed&&state.group===g;$('nav-'+g).classList.toggle('active',active);$('rail-'+g).classList.toggle('active',active)});
 $('rail-feeds').classList.toggle('active',!state.sourceKind&&!state.aiKind&&!!(state.category||state.feed));
 renderSourceSidebar();
 const list=$('category-list'), sidebar=$('sidebar'), rssOuterTop=sidebar?.scrollTop;
 // Keep expanded RSS category offsets when the sidebar is rebuilt.
 // These offsets are DOM-only and are not persisted across profile/secret changes.
 const rssOffsets=new Map();
 if(list._rssProfileId===state.profileId&&list._rssSecretToken===state.secretToken){
  for(const old of list.children){
   const feeds=old.querySelector('.rss-feed-list');
   if(feeds&&old._rssCategoryId!=null)rssOffsets.set(String(old._rssCategoryId),feeds.scrollTop);
  }
 }
 for(const old of list.children)old._youtubeScrollbarCleanup?.();
 list.replaceChildren();list._rssProfileId=state.profileId;list._rssSecretToken=state.secretToken;
 for(const c of ov.categories){if(!categoryVisibleInSidebar(c,ov))continue;const wrap=elt('section','category-block');const head=elt('div','cat-head');const row=elt('div','nav-item'+(state.category===c.id?' active':''));row.title=c.name;
 const toggle=elt('span','nav-symbol',collapsed.has(c.id)?'▸':'▾');toggle.title=collapsed.has(c.id)?'展開':'折りたたむ';toggle.onclick=e=>{e.stopPropagation();collapsed.has(c.id)?collapsed.delete(c.id):collapsed.add(c.id);localStorage.setItem('nestrill-collapsed',JSON.stringify([...collapsed]));renderSidebar()};row.append(toggle);row.append(elt('span','cat-name',c.name));row.lastChild.style.flex='1';if(c.unread)row.append(elt('b','count',String(c.unread)));
 row.onclick=()=>selectGroup('category',c.id);
 const more=elt('button','cat-more','⋯');more.title=c.name==='未分類'?'未分類について':'カテゴリの管理';more.onclick=()=>manageCategory(c);
 head.append(row,more);wrap.append(head);wrap._rssCategoryId=String(c.id);
 const rssFeeds=elt('div','rss-feed-list');
 for(const f of (collapsed.has(c.id)?[]:ov.feeds.filter(f=>f.categoryId===c.id))){const a=elt('div','feed-nav'+(state.feed===f.id?' active':''));a.dataset.feedId=f.id;a.title=f.error?`${displayFeedTitle(f.title)}\n取得エラー: ${f.error}`:f.url;
  if(state.feedIcons){
   a.classList.add('has-feed-icon');
   const icon=elt('img','feed-icon');icon.alt='';icon.loading='lazy';icon.decoding='async';
   icon.onerror=()=>{icon.onerror=null;icon.replaceWith(elt('span','feed-icon feed-icon-fallback'))};
   icon.src='/api/feed-icon/'+encodeURIComponent(f.id)+(state.secretToken?'?secret='+encodeURIComponent(state.secretToken):'');
   a.append(icon);
  }
  a.append(elt('span','name',displayFeedTitle(f.title)));if(f.unread)a.append(elt('span','count',String(f.unread)));if(f.error)a.append(elt('span','','!'));const manage=elt('button','feed-manage','⋯');manage.title='RSSの管理';manage.onclick=e=>{e.stopPropagation();manageFeed(f)};a.append(manage);a.onclick=()=>selectGroup('feed',f.id);rssFeeds.append(a)}
 if(rssFeeds.children.length){
  wrap.append(rssFeeds);
  const track=elt('div','youtube-persistent-scrollbar rss-persistent-scrollbar');
  const thumb=elt('div','youtube-persistent-scrollbar-thumb');
  track.append(thumb);track.setAttribute('role','scrollbar');
  track.setAttribute('aria-label',c.name+'のRSS一覧スクロール');
  track.setAttribute('aria-orientation','vertical');
  track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.tabIndex=0;
  wrap.append(track);
 }
 list.append(wrap);
 if(rssFeeds.children.length){
  if(rssOffsets.has(String(c.id)))rssFeeds.scrollTop=rssOffsets.get(String(c.id));
  const track=wrap.querySelector('.rss-persistent-scrollbar');
  setupYoutubePersistentScrollbar(wrap,rssFeeds,track,track.firstElementChild);
 }
 }
 if(sidebar&&Number.isFinite(rssOuterTop))sidebar.scrollTop=rssOuterTop;
}

// Source accounts: profile-scoped labels. YouTube CSV + public RSS; mail remains a placeholder.
const SOURCE_TITLES={youtube:'YouTube',mail:'メール'};
// Account expansion is session-local. Never store secret-profile channel state in localStorage.
const youtubeCollapsedAccounts=new Set();
let youtubeSidebarSerial=0,youtubeChannelSerial=0,youtubeRefreshSerial=0;
function clearSourceAccountLists(){for(const kind of ['youtube','mail']){
 $(kind+'-account-list').replaceChildren();$(kind+'-source-count').textContent='0';
}}
function setSourcePanelVisible(visible){
 $('source-panel').classList.toggle('hidden',!visible);
 $('article-list').classList.toggle('hidden',visible);
 $('empty-state').classList.toggle('hidden',visible);
 $('feed-summary').classList.toggle('hidden',visible||!state.feed);
 $('more-btn').classList.toggle('hidden',visible||state.articles.length>=state.total);
 $('search').closest('.search-box').classList.toggle('hidden',visible);
 $('filter-select').classList.toggle('hidden',visible);
 $('list-view').closest('.view-toggle').classList.toggle('hidden',visible);
 $('mark-read').classList.toggle('hidden',visible);
}
async function loadSourceAccounts(){
 const token=state.secretToken,pid=state.profileId;
 const data=await api('/api/source-accounts');
 if(token!==state.secretToken||pid!==state.profileId)return;
 state.sourceAccounts=data.accounts||[];state.youtubeChannels={};renderSourceSidebar();if(state.sourceKind)renderSourcePanel();
 await refreshYoutubeSidebarChannels();
}
async function refreshYoutubeSidebarChannels(){
 const pid=state.profileId,secret=state.secretToken,serial=++youtubeSidebarSerial;
 const accounts=state.sourceAccounts.filter(a=>a.service==='youtube');
 const results=await Promise.all(accounts.map(async a=>{
  try {const data=await api('/api/youtube/channels/'+a.id);return [a.id,data.channels||[]];}
  catch(e){console.warn('YouTubeチャンネル一覧の取得に失敗:',e);return [a.id,null];}
 }));
 if(pid!==state.profileId||secret!==state.secretToken||serial!==youtubeSidebarSerial)return;
 const old=state.youtubeChannels;state.youtubeChannels=Object.fromEntries(results.map(([id,channels])=>[id,channels===null?(old[id]||[]):channels]));renderSourceSidebar();
 if(state.sourceKind==='youtube'&&state.sourceChannelId){
  const valid=(state.youtubeChannels[state.sourceAccountId]||[]).some(x=>x.channelId===state.sourceChannelId);
  if(!valid&&results.some(([id,channels])=>id===state.sourceAccountId&&channels!==null))selectSource('youtube',state.sourceAccountId);
 }
}
function youtubeChannelTitle(accountId,channelId){
 return (state.youtubeChannels[accountId]||[]).find(c=>c.channelId===channelId)?.title||channelId;
}
// Rebuilding the YouTube source tree must not reset where the user was reading.
// The offsets are DOM-local (not stored in localStorage) and keyed by profile + group.
function youtubeSidebarScrollOffsets(list){
 const offsets=new Map();
 for(const section of list.children){
  const channelList=Array.from(section.children).find(child=>child.className==='youtube-channel-nav-list');
  if(channelList&&section._youtubeGroupId!=null)offsets.set(String(section._youtubeGroupId),channelList.scrollTop||0);
 }
 return offsets;
}
// Fix22: the right-pane scrollbar is positioned outside its scrolling content,
// so it never scrolls away while RSS/AI results move beneath it.
function setupMainPanePersistentScrollbar(){
 const workspace=$('workspace'),main=$('main');if(!workspace||!main)return;
 const track=elt('div','youtube-persistent-scrollbar main-persistent-scrollbar');
 const thumb=elt('div','youtube-persistent-scrollbar-thumb');
 track.append(thumb);track.setAttribute('role','scrollbar');
 track.setAttribute('aria-label','右ペインをスクロール');track.setAttribute('aria-valuemin','0');
 track.setAttribute('aria-valuemax','100');track.tabIndex=0;workspace.append(track);
 setupYoutubePersistentScrollbar(workspace,main,track,thumb);
 main.classList.add('nestrill-main-scroll-equipped');
 let pending=false;
 const update=()=>{if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;main.dispatchEvent(new Event('scroll'))})};
 if(typeof ResizeObserver!=='undefined'){
  const observer=new ResizeObserver(update);observer.observe(main.firstElementChild);
 }
 // Dynamically appended recommendations and RSS pages alter scrollHeight.
 const observer=new MutationObserver(update);
 observer.observe(main.firstElementChild,{childList:true,subtree:true,characterData:true});
 window.addEventListener('resize',update,{passive:true});update();
}

// An always-painted scrollbar for the YouTube channel list. Native overlay
// scrollbars disappear automatically on some Chromium/Windows configurations.
// The real list still owns scrolling; this track only mirrors/controls it.
function setupYoutubePersistentScrollbar(section, list, track, thumb, alwaysVisible=false){
 const redraw=()=>{
  const height=list.clientHeight;
  const content=list.scrollHeight;
  const canScroll=height>0&&content>height+1;
  track.hidden=height<=0||(!canScroll&&!alwaysVisible);
  if(!canScroll){
   // For editable topic lists, show a passive, full-height rail even when
   // there is no overflow. All other existing scrollbars keep old behavior.
   if(alwaysVisible&&height>0){
    track.style.top=list.offsetTop+'px';track.style.height=height+'px';
    thumb.style.height=height+'px';thumb.style.transform='translateY(0px)';
    track.setAttribute('aria-valuenow','0');track.setAttribute('aria-disabled','true');track.tabIndex=-1;
   }
   return;
  }
  track.removeAttribute('aria-disabled');track.tabIndex=0;
  track.style.top=list.offsetTop+'px';
  track.style.height=height+'px';
  const thumbHeight=Math.min(height,Math.max(25,height*height/content));
  const travel=Math.max(0,height-thumbHeight);
  const fraction=Math.min(1,Math.max(0,list.scrollTop/(content-height)));
  thumb.style.height=thumbHeight+'px';
  thumb.style.transform='translateY('+(travel*fraction)+'px)';
  track.setAttribute('aria-valuenow',String(Math.round(fraction*100)));
 };
 let dragging=null;
 const scrollToPointer=(event, grab)=>{
  const rect=track.getBoundingClientRect();
  const travel=Math.max(1,rect.height-thumb.offsetHeight);
  const fraction=Math.max(0,Math.min(1,(event.clientY-rect.top-grab)/travel));
  list.scrollTop=fraction*Math.max(0,list.scrollHeight-list.clientHeight);
  redraw();
 };
 track.addEventListener('pointerdown',event=>{
  if(track.getAttribute('aria-disabled')==='true')return;
  if(event.pointerType==='mouse'&&event.button!==0)return;
  const thumbRect=thumb.getBoundingClientRect();
  const onThumb=event.target===thumb;
  const grab=onThumb?event.clientY-thumbRect.top:thumb.offsetHeight/2;
  dragging={id:event.pointerId,grab};
  if(!onThumb)scrollToPointer(event,grab);
  if(track.setPointerCapture)track.setPointerCapture(event.pointerId);
  event.preventDefault();
 });
 track.addEventListener('pointermove',event=>{
  if(dragging&&dragging.id===event.pointerId)scrollToPointer(event,dragging.grab);
 });
 const endDrag=event=>{if(dragging&&dragging.id===event.pointerId)dragging=null;};
 track.addEventListener('pointerup',endDrag);
 track.addEventListener('pointercancel',endDrag);
 track.addEventListener('keydown',event=>{
  const step=Math.max(35,Math.round(list.clientHeight/4));
  if(event.key==='ArrowDown')list.scrollTop+=step;
  else if(event.key==='ArrowUp')list.scrollTop-=step;
  else if(event.key==='PageDown')list.scrollTop+=list.clientHeight;
  else if(event.key==='PageUp')list.scrollTop-=list.clientHeight;
  else if(event.key==='Home')list.scrollTop=0;
  else if(event.key==='End')list.scrollTop=list.scrollHeight;
  else return;
  event.preventDefault();redraw();
 });
 list.addEventListener('scroll',redraw,{passive:true});
 let observer=null;
 if(typeof ResizeObserver!=='undefined'){
  observer=new ResizeObserver(redraw);observer.observe(list);
 }
 section._youtubeScrollbarCleanup=()=>{if(observer)observer.disconnect();};
 redraw();
}
function renderSourceSidebar(){
 const sidebar=$('sidebar'),sidebarTop=sidebar?.scrollTop;
 for(const kind of ['youtube','mail']){
  const accounts=state.sourceAccounts.filter(a=>a.service===kind);
  $(kind+'-source-count').textContent=String(accounts.length);
  $('source-'+kind).classList.toggle('active',state.sourceKind===kind&&!state.sourceAccountId);
  $('rail-'+kind).classList.toggle('active',state.sourceKind===kind);
  const list=$(kind+'-account-list');
  const positions=kind==='youtube'&&list._youtubeProfileId===state.profileId?youtubeSidebarScrollOffsets(list):new Map();
  // Release observers from replaced channel lists to avoid retaining detached DOM.
  if(kind==='youtube')for(const oldSection of list.children)oldSection._youtubeScrollbarCleanup?.();
  list.replaceChildren();
  if(kind==='youtube')list._youtubeProfileId=state.profileId;
  for(const a of accounts){
   const section=elt('div',kind==='youtube'?'youtube-account-nav':'source-account-container');
   if(kind==='youtube')section._youtubeGroupId=String(a.id);
   const selected=state.sourceKind===kind&&state.sourceAccountId===a.id;
   const item=elt('div','source-account-item'+(selected&&!state.sourceChannelId?' active':''));
   if(kind==='youtube'){
    const expanded=!youtubeCollapsedAccounts.has(a.id);
    const toggle=elt('button','source-account-toggle',expanded?'▾':'▸');toggle.type='button';
    toggle.title=expanded?'登録チャンネルを折りたたむ':'登録チャンネルを展開';
    toggle.setAttribute('aria-label',a.label+'の登録チャンネルを'+(expanded?'折りたたむ':'展開'));
    toggle.setAttribute('aria-expanded',String(expanded));
    toggle.onclick=e=>{e.stopPropagation();expanded?youtubeCollapsedAccounts.add(a.id):youtubeCollapsedAccounts.delete(a.id);renderSourceSidebar()};
    item.append(toggle);
   }
   const select=elt('button','source-account-name',a.label);select.type='button';select.title=a.label;select.onclick=()=>selectSource(kind,a.id);
   item.append(select);
   if(kind==='youtube'){
    const channels=state.youtubeChannels[a.id]||[];
    if(channels.length)item.append(elt('span','source-account-total',String(channels.length)));
   }
   const more=elt('button','source-account-more','⋯');more.type='button';more.title=a.label+(kind==='youtube'?'のグループを管理':'の表示枠を管理');more.setAttribute('aria-label',more.title);more.onclick=()=>sourceAccountDialog(kind,a);
   item.append(more);section.append(item);
   if(kind==='youtube'&&!youtubeCollapsedAccounts.has(a.id)){
    const channels=state.youtubeChannels[a.id]||[];
    if(channels.length){
     const children=elt('div','youtube-channel-nav-list');children.setAttribute('aria-label',a.label+'の登録チャンネル');
     for(const c of channels){
      const active=selected&&state.sourceChannelId===c.channelId;
      const row=elt('div','youtube-channel-nav-row');
      const b=elt('button','youtube-channel-nav'+(active?' active':''),c.title||c.channelId);
      b.type='button';b.title=c.title+'\n'+c.channelId;b.setAttribute('aria-label',c.title||c.channelId);
      b.onclick=()=>selectYoutubeChannel(a.id,c.channelId);row.append(b);
      const edit=elt('button','youtube-channel-more','⋯');edit.type='button';edit.title=c.title+'の表示名を編集';edit.setAttribute('aria-label',edit.title);
      edit.onclick=e=>{e.stopPropagation();youtubeRenameChannel(a,c)};row.append(edit);children.append(row);
     }
     section.append(children);
     const track=elt('div','youtube-persistent-scrollbar');
     const thumb=elt('div','youtube-persistent-scrollbar-thumb');
     track.append(thumb);
     track.setAttribute('role','scrollbar');
     track.setAttribute('aria-label',a.label+'のチャンネル一覧スクロール');
     track.setAttribute('aria-orientation','vertical');
     track.setAttribute('aria-valuemin','0');
     track.setAttribute('aria-valuemax','100');
     track.tabIndex=0;
     section.append(track);
    }
   }
   list.append(section);
   // Critical: scrollTop must be restored AFTER attachment to the live DOM.
   // Setting it on an off-document node is clamped to zero in Chromium.
   if(kind==='youtube'&&positions.has(String(a.id))){
    const channelList=Array.from(section.children).find(child=>child.className==='youtube-channel-nav-list');
    if(channelList)channelList.scrollTop=positions.get(String(a.id));
   }
   if(kind==='youtube'){
    const channelList=Array.from(section.children).find(child=>child.className==='youtube-channel-nav-list');
    const track=Array.from(section.children).find(child=>child.className==='youtube-persistent-scrollbar');
    if(channelList&&track)setupYoutubePersistentScrollbar(section,channelList,track,track.firstElementChild);
   }
  }
 }
 // Restore the outer pane too: replacing its contents may otherwise clamp scrollTop.
 if(sidebar&&Number.isFinite(sidebarTop))sidebar.scrollTop=sidebarTop;
}
function selectSource(kind,accountId=0){
 if(!Object.hasOwn(SOURCE_TITLES,kind))return;
 const a=accountId?state.sourceAccounts.find(a=>a.id===accountId&&a.service===kind):null;
 if(accountId&&!a)return;
 ++loadSerial;++youtubeChannelSerial;state.aiKind=null;state.sourceKind=kind;state.sourceAccountId=accountId;state.sourceChannelId='';
 state.youtubeChannelVideos=[];state.youtubeChannelLoading=false;
 state.category=null;state.feed=null;state.group='all';
 renderSourceSidebar();renderSidebar();renderSourcePanel();closeMobile();if(kind==='youtube')refreshYoutubePanel().catch(err);
}
function selectYoutubeChannel(accountId,channelId){
 const account=state.sourceAccounts.find(a=>a.service==='youtube'&&a.id===accountId);
 if(!account||!(state.youtubeChannels[accountId]||[]).some(c=>c.channelId===channelId))return;
 ++loadSerial;state.aiKind=null;state.sourceKind='youtube';state.sourceAccountId=accountId;state.sourceChannelId=channelId;
 state.youtubeChannelVideos=[];state.youtubeChannelLoading=true;
 state.category=null;state.feed=null;state.group='all';
 renderSidebar();renderSourcePanel();closeMobile();refreshSelectedYoutubeChannel().catch(err);
}
async function refreshSelectedYoutubeChannel(){
 if(state.sourceKind!=='youtube'||!state.sourceChannelId)return;
 const pid=state.profileId,secret=state.secretToken,id=state.sourceAccountId,cid=state.sourceChannelId,serial=++youtubeChannelSerial;
 state.youtubeChannelLoading=true;state.youtubeChannelVideos=[];renderSourcePanel();
 try{
  const data=await api('/api/youtube/videos?accountId='+encodeURIComponent(id)+'&channelId='+encodeURIComponent(cid));
  if(serial!==youtubeChannelSerial||pid!==state.profileId||secret!==state.secretToken||state.sourceAccountId!==id||state.sourceChannelId!==cid)return;
  state.youtubeChannelVideos=data.videos||[];state.youtubeChannelLoading=false;renderSourcePanel();
 }catch(e){
  if(serial!==youtubeChannelSerial||pid!==state.profileId||secret!==state.secretToken)return;
  state.youtubeChannelLoading=false;state.youtubeChannelVideos=[];renderSourcePanel();err(e);
 }
}
async function refreshYoutubePanel(){
 const pid=state.profileId,token=state.secretToken,serial=++youtubeRefreshSerial;
 const selectedId=state.sourceKind==='youtube'?state.sourceAccountId:0;
 const [info,records,accountRecords]=await Promise.all([api('/api/youtube/status'),api('/api/youtube/videos'),selectedId?api('/api/youtube/videos?accountId='+selectedId):Promise.resolve(null)]);
 if(pid!==state.profileId||token!==state.secretToken||serial!==youtubeRefreshSerial)return;
 state.youtubeData={...info,videos:records.videos||[],accountVideos:accountRecords?.videos||[],selectedAccountId:selectedId};
 await refreshYoutubeSidebarChannels();
 if(pid!==state.profileId||token!==state.secretToken||serial!==youtubeRefreshSerial)return;
 if(state.sourceKind==='youtube'){
  if(state.sourceChannelId)await refreshSelectedYoutubeChannel();
  else renderSourcePanel();
 }
}
function youtubeCsvImport(account){
 const pane=elt('div');
 pane.append(elt('p','help','Google Takeout の subscriptions.csv を選択します。Google認証・APIキーは不要です。最初に差分を確認し、確定するまで登録内容は変更しません。'));
 const picker=elt('input');picker.type='file';picker.accept='.csv,text/csv';pane.append(field('登録チャンネルCSV',picker));
 const message=elt('div','discovery-message');message.hidden=true;pane.append(message);
 const actions=elt('div','form-actions');actions.append(action('キャンセル',closeDialog,false));
 actions.append(action('差分を確認',async()=>{try{
  const file=picker.files?.[0];if(!file)throw Error('CSVを選択してください');if(file.size>750000)throw Error('CSVは750KB以下にしてください');
  const pid=state.profileId,secret=state.secretToken;
  const preview=await post('/api/youtube/preview/'+account.id,{csv:await file.text()});
  if(pid!==state.profileId||secret!==state.secretToken)return;
  youtubeImportReview(account,preview);
 }catch(e){dialogInlineMessage(message,e.message,true)}}));pane.append(actions);
 openDialog('YouTube / CSV取込：'+account.label,pane);
}
function youtubeImportReview(account,result){
 const pane=elt('div');
 pane.append(elt('p','help',`CSV：有効 ${result.valid}件 / 新規 ${result.added.length}件 / 既存 ${result.unchanged}件 / 除外済み ${(result.ignored||[]).length}件 / 削除候補 ${result.absent.length}件。`));
 if(result.ignored?.length)pane.append(elt('p','help',`以前Nestrillで除外した ${(result.ignored||[]).length}件は再登録しません。再登録したい場合は「チャンネルを追加」から明示的に追加してください。`));
 if(result.invalid||result.duplicates)pane.append(elt('p','youtube-sync-error',`取込対象外 ${result.invalid}行、重複 ${result.duplicates}行。意図した内容か確認してください。`));
 if(result.added.length){pane.append(elt('strong','','新しく追加するチャンネル'));
  const list=elt('div','youtube-diff-list');for(const c of result.added)list.append(elt('div','',`${c.title} (${c.channelId})`));pane.append(list)}
 if(result.preserved.length){pane.append(elt('p','help',`手動登録 ${result.preserved.length}件はCSVに含まれていなくても維持します。`));}
 const removeBoxes=[];
 if(result.absent.length){
  pane.append(elt('strong','','CSVに見つからなかったチャンネル（初期状態ではすべて保持）'));
  const list=elt('div','youtube-diff-list');for(const c of result.absent){
   const line=elt('label','youtube-diff-checkbox');const ck=elt('input');ck.type='checkbox';ck.value=c.channelId;
   line.append(ck,elt('span','',`${c.title} (${c.channelId})`));list.append(line);removeBoxes.push(ck);
  }pane.append(list);
  pane.append(elt('p','help','この一覧でチェックしたチャンネルだけを登録解除します。チェックしなければ残ります。'));
 }
 const msg=elt('div','discovery-message');msg.hidden=true;pane.append(msg);
 const actions=elt('div','form-actions');actions.append(action('取り込み中止',closeDialog,false));
 actions.append(action('この内容で確定',async()=>{try{
  const removeIds=removeBoxes.filter(x=>x.checked).map(x=>x.value);
  const pid=state.profileId,secret=state.secretToken;
  const r=await post('/api/youtube/commit/'+account.id,{token:result.token,removeIds});
  if(pid!==state.profileId||secret!==state.secretToken)return;
  closeDialog();notify(`CSV取込：追加 ${r.added}件・削除 ${r.removed}件・登録計 ${r.retained}件`);
  await refreshYoutubePanel();youtubeAutoSyncAfterChange(account);
 }catch(e){dialogInlineMessage(msg,e.message,true)}}));pane.append(actions);
 openDialog('YouTube / CSV差分確認：'+account.label,pane);
}
function youtubeAddChannel(account){
 const pid=state.profileId,secret=state.secretToken;
 const groups=state.sourceAccounts.filter(a=>a.service==='youtube');
 const pane=elt('div');pane.append(elt('p','help','YouTubeのチャンネルURLをそのまま貼り付けてください。@ハンドル、/channel/UC…、UC… に対応します。@ハンドルは公開ページからチャンネルIDを自動確認します。'));
 const destination=elt('select');
 for(const group of groups){
  const option=elt('option','',group.label);option.value=String(group.id);destination.append(option);
 }
 destination.value=String(account.id);
 pane.append(field('登録先グループ',destination,'このプロファイル内のYouTubeグループを選択します。'));
 const cid=elt('input');cid.placeholder='https://www.youtube.com/@チャンネル名';pane.append(field('チャンネルURL / @ハンドル',cid));
 const name=elt('input');name.placeholder='任意（未入力なら公開名を取得できる場合は使用）';pane.append(field('表示名',name));
 const msg=elt('div','discovery-message');msg.hidden=true;pane.append(msg);
 const actions=elt('div','form-actions');actions.append(action('キャンセル',closeDialog,false));
 const submit=action('チャンネルを追加',async()=>{
  if(submit.disabled)return;
  submit.disabled=true;submit.textContent='チャンネルを確認中…';
  try{
   if(pid!==state.profileId||secret!==state.secretToken)throw Error('プロファイルが切り替わりました。追加画面を開き直してください');
   const target=state.sourceAccounts.find(a=>a.service==='youtube'&&String(a.id)===destination.value);
   if(!target||!groups.some(a=>a.id===target.id))throw Error('登録先グループが見つかりません。画面を開き直してください');
   await post('/api/youtube/add/'+target.id,{channel:cid.value,title:name.value});
   if(pid!==state.profileId||secret!==state.secretToken)return;
   closeDialog();notify('「'+target.label+'」にチャンネルを追加しました');
   await refreshYoutubePanel();youtubeAutoSyncAfterChange(target);
  }catch(e){dialogInlineMessage(msg,e.message,true)}
  finally{submit.disabled=false;submit.textContent='チャンネルを追加'}
 });actions.append(submit);pane.append(actions);
 openDialog('YouTube / チャンネル手動追加',pane);
}
function youtubeRenameChannel(account,channel,fromManager=false){
 const pid=state.profileId,secret=state.secretToken;
 const pane=elt('div');
 pane.append(elt('p','help','Nestrill内で表示するチャンネル名だけを変更します。YouTubeの登録状態・チャンネルIDは変わりません。CSV再取込でも編集名は保持されます。'));
 const name=elt('input');name.maxLength=200;name.value=channel.title||channel.channelId;pane.append(field('表示名',name));
 pane.append(elt('p','help','元のチャンネル名：'+(channel.originalTitle||channel.title)));
 const msg=elt('div','discovery-message');msg.hidden=true;pane.append(msg);
 const actions=elt('div','form-actions');actions.append(action('キャンセル',()=>fromManager?youtubeManageChannels(account,channel.channelId):closeDialog(),false));
 const save=async reset=>{try{
  if(pid!==state.profileId||secret!==state.secretToken)throw Error('プロファイルが切り替わりました');
  if(!reset&&!name.value.trim())throw Error('表示名を入力してください');
  await post('/api/youtube/rename/'+account.id,{channelId:channel.channelId,title:reset?'':name.value.trim()});
  if(pid!==state.profileId||secret!==state.secretToken)return;
  await refreshYoutubePanel();
  notify(reset?'表示名を元に戻しました':'表示名を変更しました');
  if(fromManager)youtubeManageChannels(account,channel.channelId);else closeDialog();
 }catch(e){dialogInlineMessage(msg,e.message,true)}};
 if(channel.customTitle)actions.append(action('元の名前に戻す',()=>save(true),false));
 actions.append(action('保存',()=>save(false)));pane.append(actions);
 openDialog('YouTube / チャンネル名を編集',pane);name.focus();name.select();
}
async function youtubeRemoveChannel(account,channel){
 if(!confirm(`「${channel.title}」を「${account.label}」から削除しますか？`))return;
 try{await post('/api/youtube/remove/'+account.id,{channelId:channel.channelId});notify('チャンネルを削除しました');await refreshYoutubePanel();youtubeManageChannels(account)}catch(e){err(e)}
}
async function youtubeManageChannels(account,focusId=''){
 try{
  const pid=state.profileId,secret=state.secretToken;
  const data=await api('/api/youtube/channels/'+account.id);if(pid!==state.profileId||secret!==state.secretToken)return;
  const pane=elt('div');pane.append(elt('p','help',`${data.channels.length}チャンネル。名前編集・削除・移動はNestrill内のみで行われ、YouTube側の登録状態は変わりません。除外したチャンネルはCSV再取込で復活しません。`));
  const list=elt('div','youtube-diff-list');let selectedRow=null;
  for(const c of data.channels){const line=elt('div','youtube-channel-row'+(c.channelId===focusId?' youtube-channel-focus':''));
   const info=elt('span','',`${c.title}（${c.origin==='manual'?'手動':'CSV'}）`);info.title=c.channelId;
   line.append(info);
   line.append(action('名前編集',()=>youtubeRenameChannel(account,c,true),false));
   const others=state.sourceAccounts.filter(a=>a.service==='youtube'&&a.id!==account.id);
   if(others.length)line.append(action('移動・複製',()=>youtubeTransferChannel(account,c,others),false));
   line.append(action('削除',()=>youtubeRemoveChannel(account,c),false));list.append(line);
   if(c.channelId===focusId)selectedRow=line;
  }pane.append(list);
  const actions=elt('div','form-actions');actions.append(action('閉じる',closeDialog,false),action('＋ チャンネル',()=>youtubeAddChannel(account),false));pane.append(actions);
  openDialog('YouTube / 登録チャンネル管理：'+account.label,pane);
  if(selectedRow){selectedRow.scrollIntoView({block:'nearest'});}
 }catch(e){err(e)}
}
function youtubeTransferChannel(account,channel,destinations){
 const pane=elt('div');pane.append(elt('p','help',`「${channel.title}」を別グループへ移動、または複製します。チャンネルID：${channel.channelId}`));
 const target=elt('select');for(const a of destinations){const option=elt('option','',a.label);option.value=String(a.id);target.append(option)}
 pane.append(field('移動・複製先グループ',target));
 const mode=elt('select');for(const [value,label] of [['move','移動：元グループから外す'],['copy','複製：両方のグループに残す']]){
  const option=elt('option','',label);option.value=value;mode.append(option)
 }pane.append(field('操作',mode));
 pane.append(elt('p','help','移動したチャンネルは移動元グループのCSVを再取込しても復活しません。複製先に既に登録されている場合は重複登録しません。'));
 const msg=elt('div','discovery-message');msg.hidden=true;pane.append(msg);
 const actions=elt('div','form-actions');actions.append(action('キャンセル',()=>youtubeManageChannels(account),false));
 const save=action('実行',async()=>{
  if(mode.value==='move'&&!confirm(`「${channel.title}」を「${account.label}」から「${destinations.find(x=>x.id===Number(target.value))?.label||''}」へ移動しますか？`))return;
  save.disabled=true;
  try{const pid=state.profileId,secret=state.secretToken;
   await post('/api/youtube/transfer/'+account.id,{channelId:channel.channelId,destinationId:Number(target.value),mode:mode.value});
   if(pid!==state.profileId||secret!==state.secretToken)return;
   notify(mode.value==='move'?'チャンネルを移動しました':'チャンネルを複製しました');await refreshYoutubePanel();youtubeManageChannels(account);
  }catch(e){dialogInlineMessage(msg,e.message,true)}finally{save.disabled=false}
 });actions.append(save);pane.append(actions);
 openDialog('YouTube / グループ間の移動・複製',pane);
}
function youtubeRefreshSettings(account,meta){
 const pane=elt('div');pane.append(elt('p','help',`「${account.label}」の新着動画取得方法を設定します。既存の動画一覧と登録チャンネルはどちらの設定でも保持されます。`));
 const mode=elt('select');for(const [value,title] of [['auto','自動取得（20分間隔）'],['manual','手動取得のみ']]){
  const o=elt('option','',title);o.value=value;mode.append(o)
 }mode.value=meta?.refreshMode==='manual'?'manual':'auto';pane.append(field('新着動画の取得方式',mode));
 pane.append(elt('p','help','手動取得のみ：Nestrill起動時や20分ごとの自動RSS取得は行いません。「新着を取得」を押したときだけ取得します。「表示を更新」は保存済み動画の再読み込みです。'));
 const msg=elt('div','discovery-message');msg.hidden=true;pane.append(msg);
 const actions=elt('div','form-actions');actions.append(action('キャンセル',closeDialog,false));
 const save=action('保存',async()=>{
  save.disabled=true;
  try{const pid=state.profileId,secret=state.secretToken;
   await post('/api/youtube/settings/'+account.id,{refreshMode:mode.value});
   if(pid!==state.profileId||secret!==state.secretToken)return;
   closeDialog();notify('取得方式を保存しました');await refreshYoutubePanel();
  }catch(e){dialogInlineMessage(msg,e.message,true)}finally{save.disabled=false}
 });actions.append(save);pane.append(actions);
 openDialog('YouTube / 更新設定：'+account.label,pane);
}
function youtubeAutoSyncAfterChange(account){
 const meta=state.youtubeData?.accounts?.find(a=>a.id===account.id);
 if(meta?.refreshMode!=='manual')youtubeRunSync(account);
}
// Fix87C: YouTube refresh controls previously called an undefined ytAsync.
// Centralize the busy guard; errors are surfaced instead of silently stopping.
async function ytAsync(task){
 if(state.youtubeBusy)return;
 state.youtubeBusy=true;
 try{await task()}catch(e){err(e)}finally{state.youtubeBusy=false}
}
async function youtubeRunSync(account){try{
 notify('YouTube公開RSSを取得しています…');const pid=state.profileId,secret=state.secretToken;
 const x=await post('/api/youtube/sync/'+account.id,{});
 if(pid!==state.profileId||secret!==state.secretToken)return;
 notify(`YouTube更新：${x.channels}チャンネル（成功 ${x.good} / 失敗 ${x.bad}）`);
 await refreshYoutubePanel();
 }catch(e){err(e);await refreshYoutubePanel().catch(()=>{})}}
// v0.2.0u4: Keep day-to-day viewing uncluttered; advanced YouTube controls live in a menu.
function youtubeManagementMenu(accounts,selected,info){
 const menu=elt('details','youtube-management-menu');
 const trigger=elt('summary','youtube-management-trigger','⋯ 管理');
 trigger.title='CSV取込・登録チャンネル管理・グループ設定';
 const visible=selected?[selected]:accounts;
 const failures=visible.filter(a=>(info.accounts||[]).find(m=>m.id===a.id)?.syncError);
 if(failures.length){
  const warning=elt('span','youtube-menu-warning','!');warning.title=failures.length+'グループで取得エラー';
  warning.setAttribute('aria-label',failures.length+'グループで取得エラー');trigger.append(warning);
 }
 menu.append(trigger);
 const pop=elt('div','youtube-management-popover');
 const menuAction=(label,fn)=>{
  const b=action(label,()=>{menu.open=false;fn()},false);
  b.classList.add('youtube-management-action');return b;
 };
 pop.append(menuAction('＋ グループを追加',()=>sourceAccountDialog('youtube')));
 if(!visible.length)pop.append(elt('p','youtube-management-hint','グループを追加すると、CSV取込や手動登録ができます。'));
 for(const a of visible){
  const meta=(info.accounts||[]).find(m=>m.id===a.id)||{};
  const section=elt('section','youtube-management-account');
  const heading=elt('div','youtube-management-heading');
  heading.append(elt('strong','',a.label),elt('span','',`${meta.channels||0}チャンネル`));section.append(heading);
  section.append(elt('p','youtube-management-meta',`CSV ${meta.csvChannels||0}件 / 手動 ${meta.manualChannels||0}件 ・ ${meta.refreshMode==='manual'?'手動取得':'20分ごとに自動取得'}${meta.lastRefresh?' ・ 最終取得 '+fmtTime(meta.lastRefresh):''}`));
  const actions=elt('div','youtube-management-grid');
  actions.append(
   menuAction('CSVを取り込む',()=>youtubeCsvImport(a)),
   menuAction('＋ チャンネルを追加',()=>youtubeAddChannel(a)),
   menuAction('登録チャンネル管理',()=>youtubeManageChannels(a)),
   menuAction('グループ設定',()=>sourceAccountDialog('youtube',a)),
   menuAction('更新設定',()=>youtubeRefreshSettings(a,meta))
  );
  if(!selected&&meta.channels)actions.append(menuAction('今すぐ動画取得',()=>ytAsync(()=>youtubeRunSync(a))));
  section.append(actions);
  if(meta.syncError){
   const detail=elt('details','youtube-management-error');
   const summary=elt('summary','','RSS取得エラーの詳細');detail.append(summary);
   // Name the channel (when imported) even for errors stored by an older release.
   const names=state.youtubeChannels[a.id]||[];
   const withNames=meta.syncError.replace(/(?<!\()\bUC[A-Za-z0-9_-]{22}\b/g,cid=>{
    const title=names.find(x=>x.channelId===cid)?.title;
    return title&&title!==cid?`${title} (${cid})`:cid;
   });
   detail.append(elt('p','',withNames));
   for(const cid of [...new Set([...meta.syncError.matchAll(/\bUC[A-Za-z0-9_-]{22}\b/g)].map(x=>x[0]))]){
    const matching=names.find(x=>x.channelId===cid);
    if(matching)detail.append(menuAction(`${matching.title} を登録チャンネル管理で確認`,()=>youtubeManageChannels(a,cid)));
   }
   section.append(detail);
  }
  pop.append(section);
 }
 menu.append(pop);return menu;
}
function renderYoutubePanel(root,accounts,selected){
 const info=state.youtubeData||{accounts:[],videos:[]};
 const channelId=state.sourceChannelId;
 const bar=elt('div','youtube-compact-bar');
 const context=elt('div','youtube-compact-context');
 if(channelId&&selected){
  const back=action('‹ '+selected.label+' に戻る',()=>selectSource('youtube',selected.id),false);
  back.classList.add('youtube-compact-back');context.append(back);
 }else{
  const tabs=elt('div','source-account-tabs youtube-inline-tabs');
  const all=elt('button','source-account-tab'+(!state.sourceAccountId?' active':''),'すべて');
  all.type='button';all.onclick=()=>selectSource('youtube');tabs.append(all);
  for(const a of accounts){
   const b=elt('button','source-account-tab'+(state.sourceAccountId===a.id?' active':''),a.label);
   b.type='button';b.onclick=()=>selectSource('youtube',a.id);tabs.append(b);
  }
  context.append(tabs);
 }
 const controls=elt('div','youtube-compact-actions');
 const refresh=action('表示を更新',()=>ytAsync(refreshYoutubePanel),false);
 refresh.title='Nestrillに保存された動画一覧を再読み込み';controls.append(refresh);
 const selectedMeta=selected?(info.accounts||[]).find(m=>m.id===selected.id):null;
 if(selected&&(selectedMeta?.channels||0)>0){
  const sync=action('新着を取得',()=>ytAsync(()=>youtubeRunSync(selected)),false);
  sync.title=selected.label+'の登録チャンネルから新着動画を今すぐ取得します';controls.append(sync);
 }
 controls.append(youtubeManagementMenu(accounts,selected,info));
 bar.append(context,controls);root.append(bar);
 if(!accounts.length){
  const empty=elt('div','source-panel-empty youtube-setup-empty');
  empty.append(elt('p','','まずYouTubeグループを追加し、Google TakeoutのCSVを取り込むか、チャンネルを手動登録してください。'));
  empty.append(action('＋ グループを追加',()=>sourceAccountDialog('youtube'),false));
  root.append(empty);
 }
 const items=channelId?state.youtubeChannelVideos:(selected&&info.selectedAccountId===selected.id?(info.accountVideos||[]):(info.videos?.filter(x=>!selected||x.accounts.includes(selected.id))||[]));
 if(!items.length&&accounts.length&&!state.youtubeChannelLoading){
  root.append(elt('p','source-panel-empty',channelId?'このチャンネルの取得済み動画はありません。':'まだ取得済み動画がありません。管理メニューでCSV取込または手動登録し、「新着を取得」を実行してください。'));
 }
 if(state.youtubeChannelLoading&&channelId)root.append(elt('p','youtube-loading-status','選択したチャンネルの動画を読み込み中…'));
 const list=elt('div','youtube-video-list');for(const v of items){
  const row=elt('div','youtube-video-row');const a=elt('a','youtube-video-link');a.href=v.openUrl||v.url;a.target='_blank';a.rel='noopener noreferrer';
  const img=elt('img','youtube-video-thumb');img.src=v.thumbnail;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';
  const txt=elt('div','youtube-video-text');txt.append(elt('strong','',v.title),elt('span','',v.channel||'YouTube'));
  const stamp=elt('span','',fmtTime(v.published));stamp.title=new Date(v.published).toLocaleString('ja-JP');txt.append(stamp);
  if(!selected&&v.labels?.length>1)txt.append(elt('small','',`対象: ${v.labels.join(' / ')}`));
  a.append(img,txt);row.append(a);list.append(row);
 }root.append(list);
}
function renderSourcePanel(){
 const kind=state.sourceKind;if(!kind)return;
 const accounts=state.sourceAccounts.filter(a=>a.service===kind);
 const selected=accounts.find(a=>a.id===state.sourceAccountId);
 if(state.sourceAccountId&&!selected){state.sourceAccountId=0;renderSourceSidebar()}
 $('view-title').textContent=(kind==='youtube'&&selected&&state.sourceChannelId)?youtubeChannelTitle(selected.id,state.sourceChannelId):(selected?.label||SOURCE_TITLES[kind]);
 setSourcePanelVisible(true);const root=$('source-panel');root.classList.toggle('youtube-compact-panel',kind==='youtube');root.replaceChildren();
 if(kind==='youtube'){
  renderYoutubePanel(root,accounts,selected);
  const list=state.youtubeData?.videos||[];
  $('article-count').textContent=state.sourceChannelId?(state.youtubeChannelLoading?'取得中':state.youtubeChannelVideos.length+' 件'):(selected&&state.youtubeData?.selectedAccountId===selected.id?(state.youtubeData.accountVideos||[]).length:selected?list.filter(x=>x.accounts.includes(selected.id)).length:list.length)+' 件';
  return;
 }
 $('article-count').textContent='未連携';
 const info=elt('div','source-panel-header');
 info.append(elt('strong','',`${SOURCE_TITLES[kind]}の表示枠`),elt('span','source-pending','取得機能は未実装'));root.append(info);
 root.append(elt('p','source-panel-note','メール表示枠の管理のみ可能です。認証や受信メールの取得はまだ実装していません。'));
 const tabs=elt('div','source-account-tabs');const all=elt('button','source-account-tab'+(!state.sourceAccountId?' active':''),'すべて');all.type='button';all.onclick=()=>selectSource(kind);tabs.append(all);
 for(const a of accounts){const b=elt('button','source-account-tab'+(state.sourceAccountId===a.id?' active':''),a.label);b.type='button';b.onclick=()=>selectSource(kind,a.id);tabs.append(b)}root.append(tabs);
 if(!accounts.length)root.append(elt('p','source-panel-empty','メールの表示枠はまだありません。'));
 else if(selected){const card=elt('div','source-account-card');card.append(elt('strong','',selected.label),elt('span','source-pending','未連携'));
  card.append(action('名前の変更・削除',()=>sourceAccountDialog(kind,selected),false));root.append(card)}
 else {for(const a of accounts){const card=elt('div','source-account-card');card.append(elt('strong','',a.label),elt('span','source-pending','未連携'));
   card.append(action('表示枠を開く',()=>selectSource(kind,a.id),false));root.append(card)}}
 root.append(action('＋ 表示枠を追加',()=>sourceAccountDialog(kind),false));
}

function sourceAccountDialog(kind,account=null){
 if(!Object.hasOwn(SOURCE_TITLES,kind))return;
 const pane=elt('div');pane.append(elt('p','help', kind==='youtube'?'これはNestrill内のチャンネル管理グループです。Google認証は不要で、作成後にCSVまたは手動でチャンネルを追加できます。':'メールはまだ表示枠の管理のみです。パスワードや認証コードは入力しないでください。'));
 const label=input('例：個人用、ゲーム用',account?.label||'');label.maxLength=80;pane.append(field(kind==='youtube'?'グループ名':'アカウント表示名（任意の呼び名）',label));
 const message=elt('div','discovery-message');message.hidden=true;pane.append(message);
 const actions=elt('div','form-actions');
 actions.append(action('キャンセル',closeDialog,false));
 if(account&&kind==='youtube'){
  const siblings=state.sourceAccounts.filter(a=>a.service==='youtube');
  const at=siblings.findIndex(a=>Number(a.id)===Number(account.id));
  for(const [direction,title,allowed] of [['up','↑ 上へ',at>0],['down','↓ 下へ',at>=0&&at<siblings.length-1]]){
   const move=action(title,async()=>{
    move.disabled=true;
    try{
     const result=await post('/api/source-accounts/order',{id:account.id,direction});
     if(result?.ok!==true)throw Error('並び替えの完了が確認できませんでした');
     await loadSourceAccounts();
     sourceAccountDialog(kind,state.sourceAccounts.find(a=>a.id===account.id)||account);
     notify('グループの並び順を変更しました');
    }catch(e){dialogInlineMessage(message,e.message,true);move.disabled=false}
   },false);
   move.disabled=!allowed;actions.append(move);
  }
 }
 if(account){actions.append(action('削除',async()=>{
  if(!confirm(`「${account.label}」の${kind==='youtube'?'グループ':'表示枠'}を削除しますか？\n既存RSSや記事は削除されません。`))return;
  try{await del('/api/source-accounts/'+account.id);closeDialog();if(state.sourceAccountId===account.id)state.sourceAccountId=0;await loadSourceAccounts();if(kind==='youtube')await refreshYoutubePanel();notify(kind==='youtube'?'グループを削除しました':'表示枠を削除しました')}
  catch(e){dialogInlineMessage(message,e.message,true)}
 },false))}
 const save=action(account?'名前を保存':(kind==='youtube'?'グループを追加':'表示枠を追加'),async()=>{
  save.disabled=true;
  try{if(account)await patch('/api/source-accounts/'+account.id,{label:label.value});
   else await post('/api/source-accounts',{service:kind,label:label.value});
   closeDialog();await loadSourceAccounts();if(kind==='youtube')await refreshYoutubePanel();notify(account?'名前を変更しました':(kind==='youtube'?'グループを追加しました':'表示枠を追加しました'));
  }catch(e){dialogInlineMessage(message,e.message,true)}finally{save.disabled=false}
 });actions.append(save);pane.append(actions);
 openDialog((account?(kind==='youtube'?'グループを管理：':'表示枠を管理：'):(kind==='youtube'?'グループを追加：':'表示枠を追加：'))+SOURCE_TITLES[kind],pane);
}

let resetRssScrollOnLoad=false;
function selectGroup(kind,id){const returningFromAi=!!state.aiKind;resetRssScrollOnLoad=returningFromAi;++youtubeChannelSerial;state.aiKind=null;state.sourceKind=null;state.sourceAccountId=0;state.sourceChannelId='';state.youtubeChannelVideos=[];state.youtubeChannelLoading=false;setSourcePanelVisible(false);if(returningFromAi)$('main').scrollTop=0;if(kind==='category'){state.group='category';state.category=id;state.feed=null}else if(kind==='feed'){state.group='feed';state.feed=id;state.category=null}else{state.group=kind;state.feed=null;state.category=null}
 state.filter=kind==='unread'?'unread':kind==='starred'?'starred':'all';$('filter-select').value=state.filter;
 const c=currentCategory();state.view=c?.mode||localStorage.getItem('nestrill-default-view')||'list';renderViewButtons();renderSidebar();closeMobile();loadArticles().catch(err)
}
function queryArticles(page){const q=new URLSearchParams({page:String(page),filter:state.filter});if(state.category)q.set('category',state.category);if(state.feed)q.set('feed',state.feed);if(state.q)q.set('q',state.q);return '/api/articles?'+q}
let loadSerial=0;
// Fix96A: RSS refreshes must not reset the reader's position or loaded pages.
// This capture/restore is specific to background refreshes; explicit navigation
// keeps its existing behavior (including its intentional reset after AI pages).
function rssRefreshViewKey(){
 return JSON.stringify([state.profileId,state.secretToken,state.group,state.category,state.feed,state.filter,state.q,state.view,state.aiKind,state.sourceKind]);
}
function captureRssReadingAnchor(){
 const pane=$('main'),list=$('article-list'),top=pane.scrollTop;
 if(top<=1)return {atTop:true,top};
 const visibleTop=pane.getBoundingClientRect().top;
 for(const row of list.children){
  const rect=row.getBoundingClientRect();
  if(rect.bottom>visibleTop+1){
   return {atTop:false,top,id:row.dataset.articleId||'',offset:rect.top-visibleTop};
  }
 }
 // If the user reached the more button below the rows, preserve its position
 // relative to the final row rather than jumping when new rows are inserted.
 const last=list.children[list.children.length-1];
 if(last)return {atTop:false,top,id:last.dataset.articleId||'',offset:last.getBoundingClientRect().top-visibleTop};
 return {atTop:false,top,id:'',offset:0};
}
function restoreRssReadingAnchor(anchor){
 const pane=$('main');
 if(anchor.atTop){pane.scrollTop=anchor.top;return}
 const row=Array.from($('article-list').children).find(el=>el.dataset.articleId===anchor.id);
 if(row){
  const delta=row.getBoundingClientRect().top-pane.getBoundingClientRect().top-anchor.offset;
  pane.scrollTop+=delta;
 }else pane.scrollTop=anchor.top;
}
function sameRssArticles(left,right){
 if(left.length!==right.length)return false;
 const fields=['id','title','url','openUrl','excerpt','thumbnail','published','readAt','starred','feedTitle','feedId'];
 return left.every((a,index)=>fields.every(field=>a[field]===right[index][field]));
}
// Unlike loadArticles(), this only runs on RSS refresh milestones. The backend
// is queried with the current view/filter and all currently displayed pages.
// If a new batch moves the visible row past the old last page, include it too.
async function syncArticlesAfterRssRefresh(){
 if(state.aiKind||state.sourceKind)return 'inactive';
 const key=rssRefreshViewKey(),sn=++loadSerial,firstPageCount=Math.max(1,state.page+1);
 let rows=[],total=0,nextPage=0;
 const stillCurrent=()=>sn===loadSerial&&key===rssRefreshViewKey()&&!state.aiKind&&!state.sourceKind;
 async function getPage(){
  const result=await api(queryArticles(nextPage));
  if(!stillCurrent())return false;
  rows.push(...result.articles);total=result.total;
  nextPage++;
  return true;
 }
 for(let i=0;i<firstPageCount;i++){
  if(!await getPage())return 'superseded';
  if(rows.length>=total)break;
 }
 if(!stillCurrent())return 'superseded';
 let anchor=captureRssReadingAnchor();
 // Look for the reader's visible article, not merely a numerical scroll offset.
 // This is usually just one extra page if several new articles arrived at top.
 let extra=0;
 while(anchor.id&& !rows.some(a=>String(a.id)===anchor.id) && rows.length<total && extra<5){
  if(!await getPage())return 'superseded';
  anchor=captureRssReadingAnchor(); // The user may scroll while requests run.
  extra++;
 }
 if(!stillCurrent())return 'superseded';
 anchor=captureRssReadingAnchor();
 if(anchor.id&&!rows.some(a=>String(a.id)===anchor.id)){
  // A changed filter or a very large new batch must never force the reader
  // away from the article being read. The next explicit view load can redraw.
  return 'deferred';
 }
 if(total===state.total&&sameRssArticles(state.articles,rows))return 'unchanged';
 state.total=total;
 state.page=Math.max(0,nextPage-1);
 state.articles=rows;
 renderArticles();
 restoreRssReadingAnchor(anchor);
 return 'updated';
}
async function loadArticles(append=false){const sn=++loadSerial;const token=state.secretToken;state.loading=true;const page=append?state.page+1:0;const doResetScroll=!append&&resetRssScrollOnLoad;resetRssScrollOnLoad=false;
 try{const data=await api(queryArticles(page));if(sn!==loadSerial||token!==state.secretToken)return;state.total=data.total;state.page=page;state.articles=append?state.articles.concat(data.articles):data.articles;renderArticles();if(doResetScroll)$('main').scrollTop=0;}
 finally{if(sn===loadSerial)state.loading=false}
}
function renderViewButtons(){$('list-view').classList.toggle('selected',state.view==='list');$('magazine-view').classList.toggle('selected',state.view==='magazine')}
const BUILTIN_FAILED_PLACEHOLDER='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABICAYAAAA9HjF/AAAABmJLR0QA/wD/AP+gvaeTAAAKAUlEQVR4nO2d7VNU1x2An3Pv3n3nVd5BRRQjUtRATNRo1GheNGlsXkw0M52mM006adqZdvof9Gtn0k+ZadPMZDLTaW2bxKZpUhNrlKhJGlCDI6IQUBQiLOBC2F327e7ph8UFKuAiuGQv9/m0cH/3nIPPnLPn/M65V8EobVLaXNf9L0ejsRdikpVSxhyYpA1CCJ+qiLNW1fJq4SLnO4nfA/T3B0oDMf3wSDBcpSgKqioQQsxfa01mjJSSaFQHIXDZtYOBRe79lUKERJuUNluf70wgGK5y2jSsmjrfbTW5TaSUhKM6I6EIbrvt72UFGc+KbwZ8vxz2h37nMOUahmA4SjQaw+W0Pq7ounxBKMKUayBsmkpMxojGYr9WdD260qKaco2EEAKLqhKJ6ustoDiU+W6RyZyjCAESt2W+G2ICjFxDBq5C9Nv4z5ZMhHMxOIpnXbQpeL6QEeg9ivTUI6TE5i5BtboA0H1+wl0HkUJBFGyDwm0gtNuqxhQ8D0hfB7S/gdVVSEblD9BchZPGRfy9DHefJNz7CWL5i+CumHFd4vK1IQlgt5muU8L1RmTnAXIqHsOWszypW0LedrwdHyLK90NObVL3BENRAMz5VQqRvg5k5wHyqvYlLRfAlrOcvKrnkJf/DL6OGdVpCk4VMgLtb5BT8RgWZ8GkIUdef4Ujr78y6TWLs4Ccit3I9jcgFk26WlNwqug9itVVOG3P7etsoq+zacrrtpwVWJ0F4DmWdLWm4BQhPfVklG6adTkZZZvAU590vCk4FYxcQ0g55Wx5JmiuovhwH+xJKt4UnAJkoAtrRumclWd1lSH9V5OKNQWngsggquaes+JUmxsiQ0nFmoJTggDkHJaXfFkLOrshgW88g3T1ehkJRrBaLRTnZbG0OBdFmcMTLVomut9/y7D8pWuTKk4P+cGZlVTsghXc0tHDx5+30D/ou+ma22lja10l99WUz8nRJeFcTLjr4C3jdrz0WlLlhf1diLJnkopdcIIlcOjEeT5rap8yxhcI8cHxc7Rd8bDv0XvQLLPcL3cUg1CJ+HtnPZOO+HtA0cBelFT8ghP8aWNbQq5Vs7Bp7TKqV5SQ7XbgC4Zou+zh+Ol2hgNBWjs9vHP4DPt23TPremXBAwx3f0buyienjDny+itIqbPzp7+fMma46yQUbE263gU1yeryDPJJw0UAMl12Xn52CzvuW0XRokzsNo28LDcb11bwi/3bKC3IBqC54xrNHddmXbco3E7Y30PI+/VtlxEcbCMc6If8bUnfs2AEh6NR3j58hlhMogjB3odrycuefOnisGs8v3s9ttFzaidOTz2cJ43QEMtfxNvxIdGAZ9KQHS+9NmXvjQY8DLYfQqx4EZTkB94FI/jQifMMjE6oNtcup7xk0YTrUV2f8HOmy866VUsA6O714h8Jz74R7grE0v30txyYUU8ODrbR33IAyveDq3xGVS6I7+CG5ss0NHcCUJyfxYPr75pw/dT5K7x3tIm61UvYs31sqVKUF+/hEnjr/S9YVV7EXeUFieH7tsitQ9hy8X79R6yes2SUbYqnHych4u9huOsk4UA/YuXPZywXFoBgfyDEvz49B4BA8MTWGlR14sD1Td9QfE3cNzE7pOtjCYVrfUNc6xviaMNFnt+1nqqK5Gaxk+Jahqj5DWHPMa63vQ8ygtVdhqqNHtmJ+An7ukBoyMKtiOXbZjQsj8fwgg8ebSIWi4uSSD7+vIUX9myMnzoc5aENq8jPcbNiaX7qGqZYEEU7oWgnBHsI+a+MHbpzZSJK94K9kNmuwg0tuKG5k4uXewFw2q0EgmEudQ/wWVMHm9eN7cvabRob1iy76X6n3Zr4XJSXSdWy4tkP0ZNhL0Ikua6dKYadZF0f8vPRyWYAnA4rP3n6frLc8Qcm6xtaCYZvfSrCbhs7yfjwxioevHfl3Mu9wxhScCwmefvwGUKR+Mz4ia015Ge72bmhCog/u3P2Ytd8NjFlGFJw/alWrvZ6AaitWkz18hIAaiqLcdjjvbLl0q03zG98dwOoIj3/qdKz1dNwtdfLscY2AHIynezeUpO4pioKFaXxiVR33+Aty/IFQonPDod1msjvLoYSHI5Eeec/Y9mqp3fenchG3WBRthOAkWCEcHT67+GegWEg/jDXoiznnWn0HcZQgv99opmBwfi+65a6FSwtzr0pRlXGhMf06TfO26/GU4oFuW6sWnouOAwj+MKlHhrPXwGgpCCL7etXThrnCwQBUFUFm3Vqad2eQfq88dTmXeWzPyw3XxhCsG8kxD+OnQVAs6jsfagWVZn8T7sx+crPdk+7mX+0oRWIH7a5ezQnnY6kvWAJHDzShH90QvToptVT7hL1DgzT0x/PFlWUTZ21unCpJ5EgWV1RTF62a24bnULSXnDDuU5aO+MyKpcUsL6mfMrYw1+0AKO9sqps0pj+IR/vfvIVABZV5eFNVXPa3lSTnjOHUfqHfHx08jwQz1Y9tWPdlLnbL89dTvTKqopiihZl3hTT5/Xx1j+/YCQYAWDX5mpys9K390IaC9ZjMd7++ExiqbNn2xrcTtuksV+eu8wHoztKdpvG7i3VE65L4KuWq3xw4hyh0RTmhjXLuPd7S+/cH5Ai0lZwfWMb3Z54sqKuagmrK25+3UHPwLcc+e9FLoxmrVRV4blH6hI5aV2PcaGzlxOn2+kanXwB3L+ugkfur76pvHQkLQVf7fFSfyqerRJC4HbZOH76a7zfBvAOBwiFIwwOBxn2BxP3WCwqaytL6PYM0trpoe2KhwGvHznuELndpvH4AzWsXTl3j5nMN2n3hH84EuW1v37K9aFbHyRPFouqUle9hO11lbimGObTjRtP+KeH1XF8eLx51nKFEAgR30woyc/ix3s2TtgaNBJpJbilo4dTLfFsVWlBNj/6/gbG5yqklIQiUWyaBSEEHV19/OXQKQD2P1qXWPtaNQuv/ukIQ8Mj5GQ6DSsX0kiwrsd4r34sW/XMQ7WJrb/xOMadwtDG5Y81zWJokVORVokOMTof2rW5Oq2zS6kkbXqwqir8bN8DDPuClCR5bEYZl49W/i83fSNXbfT3YqeNYIAMp50Mpz3p+MVF2VQuKUh8Hs/GNctobO6kbnX6biQkQ9otk0ySw3wR2gLBFGxwTMEGxxRscEzBBscUbHBMwQbHFGxwTMEGxxRscEzBBscUbHBMwQbHFGxwFAT+2Jy+y9jku0AMCQK/oiiiMRLRkdKUbCR0PYZFUVoVzaL+VhEi8cISk/QnEtWREiya+qYA6PIM/80XDO21WzXs0zwUbfLdJxLV8QcjZDiszYN57loLwEi++4cZA9ISCOpPhiMhLKqCwc+iGQ4JRPUYSMhwWJttQn2kWojwBI293sBTkYj+q7CurxNCzN1/E2JyxxFSjghFXLBZtTcHsh1/qBYiDPA/JvRoScDywD8AAAAASUVORK5CYII=';
function placeholderSrc(kind){return state.placeholders?.[kind]||(kind==='failed'?BUILTIN_FAILED_PLACEHOLDER:'/placeholder-missing.svg')}
function makeThumb(a){
 const img=elt('img','thumb');img.alt='';img.loading='lazy';
 img.referrerPolicy='no-referrer';
 const display=(src,type)=>{img.dataset.imageState=type;img.classList.toggle('favicon-thumb',type==='favicon');img.classList.toggle('placeholder-thumb',type==='missing'||type==='failed');img.style.backgroundImage=type==='favicon'?`url("${placeholderSrc('missing')}")`:'none';img.style.backgroundSize='cover';img.style.backgroundPosition='center';img.src=src};
 img.onerror=()=>{const kind=img.dataset.imageState;
  // A known absent article image can use its feed favicon; a broken article
  // thumbnail is a distinct failure and never silently becomes a favicon.
  if(kind==='favicon')display(placeholderSrc('missing'),'missing');
  else if(kind==='article')display(placeholderSrc('failed'),'failed');
  else if(!img.dataset.localFallback){img.dataset.localFallback='1';display(kind==='failed'?BUILTIN_FAILED_PLACEHOLDER:'/placeholder-missing.svg',kind==='failed'?'failed':'missing')}
  else {img.onerror=null;img.style.visibility='hidden'}
 };
 if(a.thumbnail)display(a.thumbnail,'article');else display(`/api/feed-icon/${a.feedId}${state.secretToken?'?secret='+encodeURIComponent(state.secretToken):''}`,'favicon');
 return img;
}
// UI06: unobtrusive RSS rating. Right-click article timestamp/row whitespace,
// not the article hyperlink or favorite star (native browser menus survive).
let rssRatingMenu=null;
function closeRssRatingMenu(){if(rssRatingMenu){rssRatingMenu.remove();rssRatingMenu=null}}
function openRssRatingMenu(article,x,y){
 closeRssRatingMenu();
 const pid=state.profileId,token=state.secretToken,id=String(article.id);
 const menu=elt('div','rss-rating-context-menu');menu.setAttribute('role','menu');
 menu.setAttribute('aria-label','記事の関心評価');menu.tabIndex=-1;
 menu.append(elt('div','rss-rating-context-heading','記事への関心を記録'));
 const add=(label,rating)=>{
  const b=elt('button','rss-rating-context-action',label);b.type='button';b.setAttribute('role','menuitem');
  b.onclick=async()=>{
   if(pid!==state.profileId||token!==state.secretToken||state.aiKind||state.sourceKind){closeRssRatingMenu();return}
   for(const node of menu.querySelectorAll('button'))node.disabled=true;
   try{
    const result=await post('/api/ai/feedback/rating',{kind:'rss',itemId:id,rating});
    if(pid===state.profileId&&token===state.secretToken){
     notify(rating===1?'「興味あり」を記録しました。次回AI生成から反映されます。':rating===-1?'「興味なし」を記録しました。次回AI生成から反映されます。':
      (result.comment?'関心評価を解除しました（感想は保持）。':'関心評価を解除しました。'));
    }
    closeRssRatingMenu();
   }catch(e){closeRssRatingMenu();if(pid===state.profileId&&token===state.secretToken)err(e)}
  };
  menu.append(b);
 };
 add('興味あり',1);add('興味なし',-1);add('関心評価を解除（感想は残す）',0);
 document.body.append(menu);
 const w=menu.offsetWidth,h=menu.offsetHeight;
 menu.style.left=Math.max(8,Math.min(x,window.innerWidth-w-8))+'px';
 menu.style.top=Math.max(8,Math.min(y,window.innerHeight-h-8))+'px';
 rssRatingMenu=menu;menu.focus({preventScroll:true});
}
$('article-list').addEventListener('contextmenu',event=>{
 if(state.aiKind||state.sourceKind||!$('dialog-overlay').classList.contains('hidden'))return;
 if(event.ctrlKey||event.shiftKey||event.altKey||event.target.closest('a, button'))return;
 const row=event.target.closest('.article-row');
 if(!row)return;
 const index=Array.prototype.indexOf.call($('article-list').children,row);
 const item=state.articles[index];if(!item||!Number.isSafeInteger(Number(item.id)))return;
 event.preventDefault();openRssRatingMenu(item,event.clientX,event.clientY);
});
document.addEventListener('pointerdown',event=>{if(rssRatingMenu&&!rssRatingMenu.contains(event.target))closeRssRatingMenu()});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeRssRatingMenu()});
$('main').addEventListener('scroll',closeRssRatingMenu,{passive:true});
window.addEventListener('resize',closeRssRatingMenu,{passive:true});

function renderArticles(){if(state.sourceKind||state.aiKind)return;setSourcePanelVisible(false);const title=titleOf();$('view-title').textContent=title;$('article-count').textContent=`${state.total.toLocaleString()} 件`;renderViewButtons();
 const summary=$('feed-summary');if(state.feed){const f=state.overview?.feeds.find(x=>x.id===state.feed);summary.textContent=f?.error?'取得エラー: '+f.error:f?.url||'';summary.classList.remove('hidden')}else summary.classList.add('hidden');
 const list=$('article-list');list.className='article-list '+state.view;list.replaceChildren();
 for(const a of state.articles){const row=elt('div','article-row '+(a.readAt==null?'unread':'read'));row.dataset.articleId=String(a.id);
 const main=elt('a','article-main');if(a.url){main.href=a.openUrl||a.url;main.target='_blank';main.rel='noopener noreferrer';}else{main.removeAttribute('href');main.title='元サイトへのリンクがありません'}
 main.addEventListener('click',()=>{if(a.readAt===null){a.readAt=Date.now();row.classList.remove('unread');row.classList.add('read');patch('/api/articles/'+a.id,{read:true}).then(loadOverview).catch(err)}});
 if(state.view==='list'){
  const source=elt('span','article-source',displayFeedTitle(a.feedTitle));const line=elt('span','article-title',a.title);line.title=a.title;
  if(a.excerpt){const detail=elt('span','article-excerpt-inline','  —  '+a.excerpt);line.append(detail)}
  main.append(source,line);
 }else{
  main.append(makeThumb(a));
  const copy=elt('div','magazine-copy');copy.append(elt('div','article-title',a.title));copy.append(elt('div','article-source',displayFeedTitle(a.feedTitle)));if(a.excerpt)copy.append(elt('div','article-excerpt',a.excerpt));main.append(copy);
 }
 const time=elt('span','article-time',fmtTime(a.published));time.title=new Date(a.published).toLocaleString('ja-JP')+' ／ 右クリックで記事を評価';
 const star=elt('button','star-button'+(a.starred?' active':''),a.starred?'★':'☆');star.title='お気に入りを切り替え';star.onclick=async()=>{a.starred=!a.starred;star.textContent=a.starred?'★':'☆';star.classList.toggle('active',!!a.starred);try{await patch('/api/articles/'+a.id,{starred:!!a.starred})}catch(e){err(e)}};
 row.append(main,time,star);list.append(row);
 }
 const empty=$('empty-state');if(!state.total){empty.classList.remove('hidden');empty.replaceChildren();const h=elt('h2','',state.overview?.feeds.length?'該当する記事がありません':'RSSフィードを登録しましょう');const p=elt('p','',state.overview?.feeds.length?'別のカテゴリや表示条件をお試しください。':'FeedlyからOPMLを取り込むこともできます。');empty.append(h,p);if(!state.overview?.feeds.length){const b=elt('button','primary-button','RSSを登録する');b.onclick=addFeedDialog;empty.append(b)}}else empty.classList.add('hidden');
 $('more-btn').classList.toggle('hidden',state.articles.length>=state.total);
}
async function setView(mode){state.view=mode;renderArticles();const c=currentCategory();try{if(c){await patch('/api/categories/'+c.id,{mode});c.mode=mode}else localStorage.setItem('nestrill-default-view',mode)}catch(e){err(e)}}
function openDialog(title,node){cleanupAiSourceScrollBoxes();cleanupAiTopicScrollBoxes();$('dialog-title').textContent=title;$('dialog-body').replaceChildren(node);const settings=!!node.querySelector('.settings-tabs');$('dialog').classList.toggle('settings-dialog',settings);$('dialog-overlay').classList.toggle('settings-overlay',settings);$('dialog-body').scrollTop=0;$('dialog-overlay').classList.remove('hidden');const first=node.querySelector('input:not([type=file]),select');if(first)first.focus()}
let pendingOpmlDecision=null;
function closeDialog(){cleanupAiSourceScrollBoxes();cleanupAiTopicScrollBoxes();state.feedIconsDraft=null;state.aiActionModeDraft=null;if(pendingOpmlDecision){const finish=pendingOpmlDecision;pendingOpmlDecision=null;finish(false)}if(state.settingsSnapshot){state.theme=state.settingsSnapshot;state.settingsSnapshot=null;applyTheme()}if(state.placeholderSnapshot){state.placeholders=state.placeholderSnapshot;state.placeholderSnapshot=null;renderArticles()}$('dialog-overlay').classList.add('hidden')}
function field(label,control,hint){const wrap=elt('div','form-field');wrap.append(elt('label','',label),control);if(hint)wrap.append(elt('div','help',hint));return wrap}
function input(placeholder='',value=''){const el=elt('input');el.placeholder=placeholder;el.value=value;return el}
function action(label,callback,primary=true){const b=elt('button',primary?'primary-button':'secondary-button',label);b.type='button';b.onclick=callback;return b}
function selectCategory(current){
 const sel=elt('select');
 const categories=state.overview?.categories||[];
 const fallback=categories.find(c=>c.name==='未分類');
 const uncategorizedHasFeeds=!!fallback&&(state.overview?.feeds||[]).some(f=>Number(f.categoryId)===Number(fallback.id));
 for(const c of categories){
  const label=c===fallback&&!uncategorizedHasFeeds?'カテゴリを指定しない':c.name;
  const option=elt('option','',label);option.value=c.id;sel.append(option);
 }
 // The no-category choice still references the internal fallback category.
 // Registering the first feed into it makes "未分類" visible in the sidebar.
 sel.value=String(current||categories[0]?.id||'');
 return sel;
}
function dialogInlineMessage(box,message,isError=false){box.textContent=message||'';box.classList.toggle('inline-error',!!isError);box.hidden=!message}
/* NESTRILL_CLEAN_FEED_REGISTER_5C */
function feedDiscoveryControls(urlInput,onSelect=()=>{}){
 const outer=elt('div','feed-discovery');
 const actions=elt('div','discovery-line');
 const token=Math.random().toString(36).slice(2);
 const msg=elt('div','discovery-message');
 msg.hidden=true;
 msg.setAttribute('role','status');

 const results=elt('div','discovery-results');
 let chosen='';
 let revision=0;
 let pending=null;

 const button=action('RSSを探す',()=>search(),false);

 async function search({requireChoiceForMultiple=false}={}){
  if(pending)return {status:'busy'};

  const query=urlInput.value.trim();

  if(!query){
   dialogInlineMessage(msg,'URLを入力してください。',true);
   return {status:'empty'};
  }

  const ticket=++revision;
  chosen='';
  results.replaceChildren();

  button.disabled=true;
  button.textContent='RSSを検索中…';

  dialogInlineMessage(
   msg,'WebサイトからRSS候補を確認しています。'
  );

  const work=(async()=>{
   try{
    const data=await post('/api/feed-discover',{url:query});

    // Ignore a result if the URL changed or dialog closed.
    if(ticket!==revision||
       urlInput.value.trim()!==query||
       !outer.isConnected){
     return {status:'stale'};
    }

    const candidates=Array.isArray(data.candidates)
     ?data.candidates:[];

    if(!candidates.length){
     dialogInlineMessage(
      msg,
      data.message||'有効なRSSは見つかりませんでした。',
      true
     );
     return {status:'none'};
    }

    const needsChoice=
     requireChoiceForMultiple&&candidates.length>1;

    for(const feed of candidates){
     const row=elt('label','discovered-item');
     const radio=elt('input');
     radio.type='radio';
     radio.name='rss-discovery-'+token;
     radio.value=feed.url;

     radio.onchange=()=>{
      chosen=feed.url;
      urlInput.value=feed.url;
      onSelect(feed);
      dialogInlineMessage(
       msg,'選択したRSSを登録できます。'
      );
     };

     if(!chosen&&!needsChoice){
      chosen=feed.url;
      radio.checked=true;
      urlInput.value=feed.url;
      onSelect(feed);
     }

     const wrap=elt('span');
     wrap.append(
      elt('strong','',displayFeedTitle(feed.title||new URL(feed.url).hostname)),
      elt('small','',feed.url)
     );
     row.append(radio,wrap);
     results.append(row);
    }

    if(needsChoice){
     dialogInlineMessage(
      msg,
      candidates.length+
       '件のRSSが見つかりました。候補を選択して、'+
       'もう一度「登録する」を押してください。'
     );
     return {status:'choice-required'};
    }

    dialogInlineMessage(
     msg,
     candidates.length+
      '件のRSSが見つかりました。'
    );

    return {status:'ready',url:chosen};
   }catch(e){
    if(ticket===revision&&outer.isConnected){
     dialogInlineMessage(msg,e.message||String(e),true);
    }
    return {status:'error'};
   }finally{
    button.disabled=false;
    button.textContent='RSSを探す';
    pending=null;
   }
  })();

  pending=work;
  return await work;
 }

 actions.append(
  button,
  elt('span','help',
   'サイトURL・RSS URLのどちらでも検索できます')
 );

 outer.append(actions,msg,results);

 urlInput.addEventListener('input',()=>{
  ++revision;
  chosen='';
  results.replaceChildren();
  dialogInlineMessage(msg,'');
 });

 return {
  element:outer,
  selected:()=>chosen,
  selectUrl:()=>chosen||urlInput.value.trim(),
  notice:msg,
  search
 };
}
// Show the RSS-provided title as the input value without silently creating a
// per-profile override. An override exists only when the user types a different
// name; clearing/resetting the name restores the live source title.
function feedDisplayNameControl(sourceTitle='',existingOverride=''){
 let original=displayFeedTitle(sourceTitle).trim(),forcedAuto=false,manualEdited=false;
 const alias=input('RSSの表示名',existingOverride?displayFeedTitle(existingOverride):original);alias.maxLength=250;
 const status=elt('span','feed-display-status');
 const reset=action('配信元の名前に戻す',()=>{forcedAuto=true;manualEdited=false;alias.value=original;render()},false);
 reset.classList.add('feed-name-reset');
 const row=elt('div','feed-display-helpers');row.append(status,reset);
 const wrapper=field('このプロファイルでの表示名',alias);wrapper.append(row);
 function render(){const current=alias.value.trim();const auto=forcedAuto||current===''||current===original;
  status.textContent=auto?'RSS配信元の名称を自動使用':'このプロファイル用の表示名';
  reset.disabled=auto;
 }
 alias.addEventListener('input',()=>{forcedAuto=false;manualEdited=alias.value.trim()!==original;render()});
 render();
 return {element:wrapper,alias,setSourceTitle:title=>{original=displayFeedTitle(title).trim();if(!existingOverride&&!manualEdited)alias.value=original;render()},
  /* NESTRILL_FEED_TITLE_RESET_5E */
  resetAfterUrlEdit:()=>{
   if(!manualEdited&&!existingOverride){
    original='';
    alias.value='';
    render();
   }
  },
  value:()=>forcedAuto||!alias.value.trim()||alias.value.trim()===original?'':alias.value.trim()};
}
function addFeedDialog(){
 const pane=elt('div');
 const url=input('https://example.com/');
 url.type='url';

 const cat=selectCategory(
  state.category||currentCategory()?.id
 );
 const displayName=feedDisplayNameControl();

 pane.append(field(
  'WebサイトまたはRSSのURL',
  url,
  'URLを入力して「登録する」を押すと、RSSを自動探索します。'
 ));

 const discovery=feedDiscoveryControls(
  url,
  feed=>displayName.setSourceTitle(
   feed.title||new URL(feed.url).hostname
  )
 );

 url.addEventListener('input',()=>displayName.resetAfterUrlEdit());
 pane.append(
  discovery.element,
  displayName.element,
  field('登録先カテゴリ',cat)
 );

 const buttons=elt('div','form-actions');
 const save=action('登録する',async()=>{
  if(!url.value.trim()&&!discovery.selected()){
   dialogInlineMessage(
    discovery.notice,'URLを入力してください。',true
   );
   return;
  }

  const profile=state.profileId;
  const secret=state.secretToken;

  save.disabled=true;
  save.textContent='RSSを確認中…';

  try{
   let verified=discovery.selected();

   if(!verified){
    const found=await discovery.search({
     requireChoiceForMultiple:true
    });

    if(found.status!=='ready')return;
    verified=discovery.selected();
   }

   if(!verified||!pane.isConnected)return;

   if(profile!==state.profileId||
      secret!==state.secretToken){
    return;
   }

   save.textContent='登録中…';

   const result=await post('/api/feeds',{
    url:verified,
    categoryId:Number(cat.value),
    displayTitle:displayName.value()
   });

   if(!pane.isConnected)return;

   closeDialog();

   notify(result.reused
    ?'登録済みRSSをこのプロファイルに追加しました。'
    :'RSSを登録しました。記事を取得しています。'
   );

   await loadOverview();
   await loadArticles();
  }catch(e){
   if(pane.isConnected){
    dialogInlineMessage(
     discovery.notice,e.message||String(e),true
    );
   }
  }finally{
   save.disabled=false;
   save.textContent='登録する';
  }
 });

 buttons.append(
  action('キャンセル',closeDialog,false),
  save
 );
 pane.append(buttons);
 openDialog('RSSを追加',pane);
}
function addCategoryDialog(){const pane=elt('div');const name=input('例：PC・ガジェット');pane.append(field('カテゴリ名',name));const actions=elt('div','form-actions');actions.append(action('キャンセル',closeDialog,false),action('追加',async()=>{try{await post('/api/categories',{name:name.value});closeDialog();await loadOverview()}catch(e){err(e)}}));pane.append(actions);openDialog('カテゴリを追加',pane)}
function appendRssSortButtons(actions,kind,item,context,message){
 const pid=state.profileId,secret=state.secretToken;
 const siblings=kind==='category'?(state.overview?.categories||[]).filter(c=>categoryVisibleInSidebar(c,state.overview))
  :(state.overview?.feeds||[]).filter(f=>f.categoryId===item.categoryId);
 const at=siblings.findIndex(c=>Number(c.id)===Number(item.id));
 for(const [direction,label,allowed] of [['up','↑ 上へ',at>0],['down','↓ 下へ',at>=0&&at<siblings.length-1]]){
  const move=action(label,async()=>{
   move.disabled=true;
   try{
    if(pid!==state.profileId||secret!==state.secretToken)throw Error('プロファイルが切り替わりました。管理画面を開き直してください');
    const result=await post(kind==='category'?'/api/categories/order':'/api/feeds/order',{id:item.id,direction});
    if(result?.ok!==true)throw Error('並び替えを確認できませんでした');
    if(pid!==state.profileId||secret!==state.secretToken)return;
    await loadOverview();
    if(pid!==state.profileId||secret!==state.secretToken)return;
    if(kind==='category')manageCategory(state.overview.categories.find(c=>Number(c.id)===Number(item.id))||item);
    else manageFeed(state.overview.feeds.find(f=>Number(f.id)===Number(item.id))||item);
    notify('RSS'+(kind==='category'?'カテゴリ':'')+'の並び順を変更しました');
   }catch(e){dialogInlineMessage(message,e.message,true);move.disabled=false}
  },false);
  move.disabled=!allowed;actions.append(move);
 }
}
function manageCategory(c){
 // The default category is a reserved fallback used by feed reassignment.
 // Never offer a rename form for it: that form was misleading and always failed.
 if(c.name==='未分類'){
  const pane=elt('div');
  pane.append(elt('p','help','「未分類」はRSSの移動先として使う固定カテゴリです。名前の変更・削除はできません。別の名前で分類したい場合は、新しいカテゴリを追加してください。'));
  const actions=elt('div','form-actions');const message=elt('div','discovery-message');message.hidden=true;pane.append(message);
  appendRssSortButtons(actions,'category',c,null,message);
  actions.append(action('閉じる',closeDialog,false),action('新規カテゴリを作成',()=>{closeDialog();addCategoryDialog()}));
  pane.append(actions);openDialog('未分類について',pane);return;
 }
 const pane=elt('div'),name=input('',c.name);
 pane.append(field('カテゴリ名',name));
 const message=elt('p','category-delete-feedback');message.hidden=true;message.setAttribute('role','alert');
 const actions=elt('div','form-actions');
 const showError=e=>{console.error('[Category]',e);message.textContent='操作を完了できませんでした: '+(e?.message||String(e));message.hidden=false};
 const rename=action('名前を変更',async()=>{message.hidden=true;try{await patch('/api/categories/'+c.id,{name:name.value});closeDialog();await loadOverview();renderArticles()}catch(e){showError(e)}});
 const remove=action('カテゴリを削除',async()=>{
  if(!confirm(`「${c.name}」を削除しますか？\n登録RSSは「未分類」に移動します。`))return;
  message.hidden=true;remove.disabled=true;
  try{
   const result=await del('/api/categories/'+c.id);
   if(!result?.ok||result.removed!==true)throw Error('削除APIが完了を確認できませんでした');
   const latest=await api('/api/overview');
   if(latest.categories?.some(x=>Number(x.id)===Number(c.id)))throw Error('削除後もこのプロファイルにカテゴリが残っています。再実行せずログを確認してください。');
   state.overview=latest;
   closeDialog();
   selectGroup('all');
   notify('カテゴリの登録をこのプロファイルから解除しました。');
  }catch(e){showError(e)}finally{remove.disabled=false}
 },false);
 remove.disabled=c.name==='未分類';
 appendRssSortButtons(actions,'category',c,null,message);
 actions.append(rename,remove);pane.append(message,actions);openDialog('カテゴリを管理',pane)
}
async function manageFeed(f){
 let info;try{info=await api('/api/feeds/'+f.id)}catch(e){err(e);return}
 const pane=elt('div');const old=info.feed;const users=info.usedBy||[];
 const url=input('https://example.com/feed.xml',old.url);url.type='url';
 const displayName=feedDisplayNameControl(old.title,old.displayTitle);
 const cat=selectCategory(old.categoryId);
 pane.append(field('RSSのURL（編集可能）',url,'WebサイトのURLを入力した場合は、下の「RSSを探す」で配信URLを検出してください。'));
 const discovery=feedDiscoveryControls(url);pane.append(discovery.element);
 pane.append(displayName.element,field('カテゴリ',cat));
 const scope=elt('select');for(const [value,label] of [['current','現在のプロファイルだけ変更'],['all',`利用中の全プロファイル（${users.length}件）で変更`]]){const o=elt('option','',label);o.value=value;scope.append(o)}
 if(users.length>1){pane.append(field('RSSのURLを差し替える範囲',scope,`共有中: ${users.map(x=>x.name).join(' / ')}。表示名・カテゴリの変更は現在のプロファイルにのみ反映されます。`))}
 const warning=elt('div','help','URLを変更すると、新しいRSSは別のフィードとして登録されます。古い記事・既読履歴は元のフィードに保持し、移行しません。');pane.append(warning);
 const message=elt('div','discovery-message');message.hidden=true;message.setAttribute('role','alert');pane.append(message);
 const actions=elt('div','form-actions');const save=action('変更を保存',async()=>{
  const newURL=url.value.trim(),changed=newURL!==old.url;save.disabled=true;
  try{
   if(changed){
    if(!discovery.selected()||newURL!==discovery.selected()){dialogInlineMessage(message,'先に「RSSを探す」を実行し、変更先のRSSを選択してください。',true);return}
    if(scope.value==='all'&&users.length>1&&!confirm(`${users.length}件のプロファイルでURLを差し替えます。よろしいですか？`))return;
    const replaced=await post('/api/feeds/'+f.id+'/replace',{url:newURL,scope:scope.value});
    await patch('/api/feeds/'+replaced.id,{categoryId:Number(cat.value),displayTitle:displayName.value()});
    state.feed=state.feed===f.id?replaced.id:state.feed;
    notify(`RSSのURLを差し替えました（${replaced.profilesChanged}プロファイル）。古い記事は保持しています。`);
   }else{
    await patch('/api/feeds/'+f.id,{categoryId:Number(cat.value),displayTitle:displayName.value()});notify('RSSの設定を保存しました。');
   }
   closeDialog();await loadOverview();await loadArticles();
  }catch(e){dialogInlineMessage(message,e.message,true)}finally{save.disabled=false}
 });
 appendRssSortButtons(actions,'feed',old,null,message);
 actions.append(action('キャンセル',closeDialog,false),save,action('RSSを削除',async()=>{
  if(!confirm(`このプロファイルから「${f.title}」を外しますか？\n他のプロファイルや取得済み記事は削除されません。`))return;
  try{await del('/api/feeds/'+f.id);closeDialog();await loadOverview();selectGroup('all')}catch(e){dialogInlineMessage(message,e.message,true)}
 },false));pane.append(actions);openDialog('RSSを管理',pane);
}
async function refresh(){try{const result=await post('/api/refresh',{});notify(result.busy?'すでに更新中です':'RSSの更新を開始しました');$('update-indicator').textContent='更新中…';setTimeout(checkRefresh,1400)}catch(e){err(e)}}
let firstPassShownRun=0;
async function checkRefresh(){
 try{
  const old=state.overview?.refreshing;
  await loadOverview();
  if(state.overview.refreshing){
   const runId=Number(state.overview.rssRefreshRunId)||0;
   if(runId>0&&Number(state.overview.firstPassCompletedRun)===runId&&firstPassShownRun!==runId){
    firstPassShownRun=runId;
    const result=await syncArticlesAfterRssRefresh();
    if(result==='updated')notify('取得済みの記事を先に反映しました。残りのフィードは更新中です');
   }
   setTimeout(checkRefresh,2000);
  }else if(old){
   const result=await syncArticlesAfterRssRefresh();
   notify(result==='deferred'?'RSSの更新が完了しました。閲覧中の記事表示を維持しています':'RSSの更新が完了しました');
  }
 }catch(e){err(e)}
}
function rgba(hex,pct){const h=hex.replace('#','');const n=parseInt(h,16);return `rgba(${n>>16&255},${n>>8&255},${n&255},${pct/100})`}
function textShadowValue(x){return x.shadow?`${x.shadowX??1}px ${x.shadowY??2}px ${x.shadowBlur??3}px ${rgba(x.shadowColor||'#121a2d',x.shadowOpacity??60)}`:'none'}
function safeCSSImage(url){return /^\/assets\/bg-(?:shared|left|right)-[\w-]+\.(?:png|apng|jpg|gif|webp)(?:\?v=\d+)?$/.test(url||'')?`url("${url}")`:'none'}

const wallpaperState={};
const mobileScreen=window.matchMedia('(max-width:700px)');
function isVideoUrl(url){return /\.(?:mp4|webm)(?:\?.*)?$/i.test(url||'')}
function shuffle(items){const a=items.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function ensureWallpaper(el,slot){
 let layer=el.querySelector(':scope > .wallpaper-layer');if(layer)return layer;
 layer=elt('div','wallpaper-layer');layer.dataset.wallpaperSlot=slot;
 const media=elt('div','wallpaper-media'),tint=elt('div','wallpaper-tint');
 const img=elt('div','wallpaper-image'),video=elt('video','wallpaper-video');
 video.muted=true;video.defaultMuted=true;video.volume=0;video.autoplay=true;video.playsInline=true;video.preload='metadata';
 video.setAttribute('muted','');video.setAttribute('playsinline','');
 media.append(img,video);layer.append(media,tint);el.prepend(layer);
 wallpaperState[slot]={layer,img,video,media,tint,token:'',timer:null,list:[],index:0,signature:'',slot,serial:0};
 if(slot!=='shared'){const adjust=()=>{layer.style.height=el.clientHeight+'px';layer.style.transform=`translateY(${el.scrollTop}px)`};el.addEventListener('scroll',adjust,{passive:true});new ResizeObserver(adjust).observe(el);requestAnimationFrame(adjust)}
 video.addEventListener('ended',()=>{
  const x=wallpaperState[slot];if(x&&x.list.length>1)nextWallpaper(slot);
 });
 video.addEventListener('error',()=>{const x=wallpaperState[slot];if(x&&x.list.length>1)nextWallpaper(slot);else video.style.display='none'});
 return layer;
}
function stopWallpaper(slot){const x=wallpaperState[slot];if(!x)return;clearTimeout(x.timer);x.timer=null;x.video.pause();x.video.removeAttribute('src');x.video.load();x.img.style.backgroundImage='none';x.list=[];x.index=0;x.serial++;}
function wallpaperUse(slot,item,b){
 const x=wallpaperState[slot];if(!x)return;
 x.video.pause();x.video.removeAttribute('src');x.video.load();x.img.style.backgroundImage='none';
 if(!item)return;
 if(item.video&&!mobileScreen.matches){x.img.style.display='none';x.video.style.display='block';x.video.loop=x.list.length===1&&b.loop!==false;x.video.playbackRate=b.speed||1;x.video.src=item.url;x.video.muted=true;x.video.volume=0;
  if(!document.hidden)x.video.play().catch(()=>{});
 }else{x.video.style.display='none';x.img.style.display='block';x.img.style.backgroundImage=`url(${JSON.stringify(item.url)})`}
}
function nextWallpaper(slot){const x=wallpaperState[slot];if(!x||!x.list.length)return;const b=state.theme[slot];
 if(x.index>=x.list.length){x.list=shuffle(x.list);if(x.list.length>1&&x.list[0]?.url===x.last)x.list.push(x.list.shift());x.index=0}
 const item=x.list[x.index++];x.last=item.url;wallpaperUse(slot,item,b);
 clearTimeout(x.timer);x.timer=null;
 if(!item.video||mobileScreen.matches){x.timer=setTimeout(()=>{if(!document.hidden)nextWallpaper(slot)},(b.interval||300)*1000)}
}
async function refreshWallpaper(slot,b){const x=wallpaperState[slot];if(!x)return;
 stopWallpaper(slot);const ticket=x.serial;const mobile=mobileScreen.matches;
 let items=[];
 const fromFolder=b.type==='folder'||(mobile&&(b.type==='video'||b.type==='folder'||(b.type==='image'&&isVideoUrl(b.image))));
 if(fromFolder){
  try{const json=await api(`/api/wallpaper/list?slot=${slot}${mobile?'&mobile=1':''}`);if(x.serial!==ticket)return;items=json.files||[];
   if(mobile&&!items.length&&(b.type==='folder'||b.type==='video')){
    // The PC directory may contain stills but no dedicated mobile directory.
    const alt=await api(`/api/wallpaper/list?slot=${slot}`);
    if(x.serial!==ticket)return;items=(alt.files||[]).filter(f=>!f.video&&/\.(?:png|jpe?g|webp)(?:\?.*)?$/i.test(f.name));
   }
  }catch(e){console.warn('Wallpaper scan:',e.message)}
 }else if(b.image&&b.type!=='color')items=[{url:b.image,video:b.type==='video'||isVideoUrl(b.image)}];
 if(mobile)items=items.filter(f=>!f.video);
 x.list=shuffle(items);x.index=0;nextWallpaper(slot);
}
function linkedSharedActive(theme){return theme.sharedLinked!==false}
function applyTheme(){const t=state.theme;if(!t)return;
 const elements={shared:$('app'),left:$('sidebar'),right:$('main')};
 const linked=linkedSharedActive(t);
 // Keep a single shared media layer behind both the toolbar and workspace.
 // The extension toggle changes only clipping, never creates another video.
 const header=t.header||{};
 const extended=header.extend!==false;
 const shell=$('app'),bar=document.querySelector('.topbar');
 shell.style.backgroundColor=t.baseColor||'#edf0f5';
 shell.classList.toggle('header-wallpaper-enabled',extended);
 shell.style.setProperty('--shared-wallpaper-top',extended?'0px':'var(--header-height)');
 bar.style.backgroundColor=extended?rgba(header.color||'#ffffff',header.opacity??75):'#ffffff';
 bar.style.backdropFilter=extended?`blur(${header.blur??10}px)`:'none';
 bar.style.webkitBackdropFilter=bar.style.backdropFilter;
 bar.style.borderBottom=extended&&header.borderEnabled===false?'none':`1px solid ${extended?rgba(header.borderColor||'#dce3ee',header.borderOpacity??50):'var(--line)'}`;
 bar.style.setProperty('--header-text-color',extended?(header.textColor||'#263c59'):'#263c59');
 for(const slot of ['shared','left','right']){
  const el=elements[slot],b=t[slot];ensureWallpaper(el,slot);const x=wallpaperState[slot];
  const hidden=linked&&slot!=='shared';
  x.layer.style.visibility=hidden?'hidden':'visible';
  if(hidden){
   if(x.signature!=='__shared_linked__'){stopWallpaper(slot);x.signature='__shared_linked__'}
   continue;
  }
  x.media.style.opacity=String((b.imageOpacity??100)/100);
  x.media.style.filter=`blur(${b.blur||0}px)`;
  x.img.style.backgroundPosition=b.position||'center';x.video.style.objectPosition=b.position||'center';
  x.tint.style.backgroundColor=rgba(b.color,b.colorOpacity);
  const sig=JSON.stringify([b.type,b.image,b.folder,b.mobileFolder,b.folderKind,b.interval,b.speed,b.loop,mobileScreen.matches]);
  if(x.signature!==sig){x.signature=sig;refreshWallpaper(slot,b).catch(err)}
 }
 for(const [el,slot] of [[elements.left,'left'],[elements.right,'right']]){
  const x=t.text[slot];el.style.setProperty(`--${slot}-font`,x.font);el.style.setProperty(`--${slot}-size`,x.size+'px');el.style.setProperty(`--${slot}-color`,x.color);el.style.setProperty(`--${slot}-stroke`,x.stroke+'px');el.style.setProperty(`--${slot}-stroke-color`,x.strokeColor);el.style.setProperty(`--${slot}-shadow`,textShadowValue(x));
 }
 const main=elements.right;
 for(const key of ['source','title','excerpt']){const a=t.articleStyle[key];
  for(const [part,value] of Object.entries({font:a.font,weight:a.weight,size:a.size+'px',color:a.color,stroke:a.stroke+'px','stroke-color':a.strokeColor,shadow:textShadowValue(a)}))main.style.setProperty(`--article-${key}-${part}`,value);
 }
 const z=t.stripe;main.style.setProperty('--stripe-odd',rgba(z.oddColor,z.enabled?z.oddOpacity:0));main.style.setProperty('--stripe-even',rgba(z.evenColor,z.enabled?z.evenOpacity:0));main.style.setProperty('--stripe-hover',rgba(z.hoverColor,z.hoverOpacity));
 for(const key of ['list','magazine']){const d=t.separators[key];
  main.style.setProperty(`--sep-${key}-border`,d.enabled?`${d.style==='double'?Math.max(3,d.width):d.width}px ${d.style} ${rgba(d.color,d.opacity)}`:'0px solid transparent');
  main.style.setProperty(`--sep-${key}-inset`,d.inset+'px');main.style.setProperty(`--sep-${key}-spacing`,d.spacing+'px');
 }
}
mobileScreen.addEventListener('change',()=>{for(const slot of ['shared','left','right']){const x=wallpaperState[slot];if(x)x.signature=''}applyTheme()});
document.addEventListener('visibilitychange',()=>{for(const x of Object.values(wallpaperState)){if(document.hidden)x.video.pause();else{if(x.video.src&&x.video.style.display!=='none')x.video.play().catch(()=>{});else if(!x.timer&&x.list.length)x.timer=setTimeout(()=>nextWallpaper(x.slot),3000)}}});
// Phase D3: optional local semantic scoring with D1 keyword fallback and D2 feedback.
let aiViewSerial=0;
async function selectAiKind(kind){
 if(kind!=='rss')return; // YouTube AI is frozen; normal channel viewer unaffected.
 ++loadSerial;++youtubeChannelSerial;++aiViewSerial;
 state.aiKind=kind;state.sourceKind=null;state.sourceAccountId=0;state.sourceChannelId='';
 state.category=null;state.feed=null;state.group='all';
 renderSidebar();closeMobile();setSourcePanelVisible(true);
 $('view-title').textContent='AIセレクト';$('article-count').textContent='—';
 const root=$('source-panel');root.replaceChildren();
 // Fix103H: the stable workflow explanation is available on demand, not a permanent banner.
 const guide=elt('details','e2-top-guide');
 const guideSummary=elt('summary','','AIセレクトのしくみ・注意事項');
 const guideBody=elt('div','e2-top-guide-body');
 guideBody.append(
  elt('p','help','関心リストとの関連性・好評履歴から推定した関心・未知の発見という3つの観点から、Googleニュース経由で登録外の記事を探します。閲覧履歴は好評とは区別し、微弱な補助材料としてのみ扱います。'),
  elt('p','help','探索設定の比率は候補を集める経路の優先配分であり、最終的に表示される記事の割合を保証するものではありません。関心テーマは設定した件数ずつランダム巡回します。探索は手動実行です。'),
  elt('p','help','AIは主に記事タイトルなど取得可能な情報をもとに判断します。記事本文の正確性や実際のリンク先の内容は確認していません。外部へ送信するのは検索語のみで、評価履歴・閲覧記事のタイトル・感想は送信しません。')
 );
 guide.append(guideSummary,guideBody);root.append(guide);
 mountAiExternalSection(root);
}

function readableAiReason(value){
 const reason=String(value||'').trim();
 // Gemma occasionally writes the evidence ID in the wrong JSON field.
 // Do not pretend that e2/none is an explanatory sentence.
 return /^(?:e\d+|none|null|n\/?a|unknown|不明|なし)$/i.test(reason)?'':reason;
}
function renderAiLivePreview(data){
 const panel=$('ai-blend-live-preview');if(!panel)return;
 const job=data.blendJob||{},items=aiFilterShownItems(data.blendPreviewItems,data.kind);
 const version=Number(job.previewVersion)||0;
 if(panel.dataset.version===String(version))return;
 panel.dataset.version=String(version);panel.replaceChildren();
 const count=items.length;
 panel.append(elt('h3','',`今回の生成途中：暫定推薦 ${count}件（評価 ${job.completed||0} / ${job.total||0}件）`));
 panel.append(elt('p','help','評価済みの記事から順次表示しています。枠の割当・順位・件数は後続の評価で変わります。ここでの結果は未保存で、最終完了時にのみ確定します。'));
 if(!count){panel.append(elt('p','help','最初の評価が完了すると、ここに推薦候補が表示されます。'));return}
 const labels={explicit:'70% 明示的関心',inferred:'20% AI推定',discovery:'10% 未知の発見'};
 for(const bucket of ['explicit','inferred','discovery']){
  const segment=items.filter(it=>it.bucket===bucket);if(!segment.length)continue;
  panel.append(elt('div','ai-live-bucket-title',labels[bucket]+'：'+segment.length+'件（暫定）'));
  for(const item of segment){
   const row=elt('div','ai-live-preview-item');
   const title=elt('a','',String(item.title||''));
   if(/^https?:\/\//i.test(String(item.url||''))){
    const tracked=String(item.openUrl||'');
    title.href=tracked.startsWith('/api/ai/open/')?tracked:(/^https?:\/\//i.test(tracked)?tracked:item.url);
    title.target='_blank';title.rel='noopener noreferrer';
   }
   else {const span=elt('span','',String(item.title||''));row.append(span)}
   if(title.href)row.append(title);
   row.append(elt('div','help',`${item.source||''} ・ ${item.origin==='external'?'登録外':'登録済み'} ・ 暫定関連度 ${item.semanticScore||0}/100`));
   const reason=readableAiReason(item.semanticReason);
   row.append(elt('div','help',reason?'AIの判定理由：'+reason:'AIの判定理由：未取得（説明文が不適切または空欄）'));
   panel.append(row);
  }
 }
}
// Fix32: read-only quality evidence. No AI decisions, feedback, or database writes.
// This export deliberately captures ONLY the persisted recommendation list and
// currently configured topics. It cannot establish missed candidates or past settings.
// Fix54: export-time normalization also repairs archived Fix53 cache diagnostics
// without changing scores, selections, SQLite, or triggering a new generation.
function inferredHypothesisStatusForExport(preference, storedStatus){
 const text=String(preference||'').trim(), old=String(storedStatus||'');
 if(!text)return 'none';
 if(/^仮説(?:\s*[:：]|$)/u.test(text))return 'hypothesis';
 if(/^保留(?:\s*[:：]|$)/u.test(text))return 'pending';
 if(old==='hypothesis'||old==='pending')return old;
 return 'unlabeled';
}
function buildAiQualityReport(data, interests, exclusions, exportedAt){
 const items=Array.isArray(data?.items)?data.items:[];
 const m=data?.blendMeta||{};
 const countByBucket={explicit:0,inferred:0,discovery:0,other:0};
 const seenUrl=new Set(),seenTitle=new Set();
 const dupUrls=[],dupTitles=[];
 const normalize=value=>String(value||'').trim().toLocaleLowerCase();
 const entries=items.map((item,index)=>{
  const title=String(item.title||''),url=String(item.url||'');
  const safeUrl=/^https?:\/\//i.test(url)?url:'';
  const bucket=['explicit','inferred','discovery'].includes(item.bucket)?item.bucket:'other';
  countByBucket[bucket]++;
  if(safeUrl){const key=normalize(safeUrl);if(seenUrl.has(key))dupUrls.push(index+1);else seenUrl.add(key)}
  const titleKey=normalize(title);if(titleKey){if(seenTitle.has(titleKey))dupTitles.push(index+1);else seenTitle.add(titleKey)}
  const reason=readableAiReason(item.semanticReason);
  return {number:index+1,bucket,origin:item.origin==='external'?'external':'registered',
   title,articleUrl:safeUrl,source:String(item.source||''),published:item.published??null,
   excerpt:String(item.excerpt||''),aiScore:Number.isFinite(Number(item.semanticScore))?Number(item.semanticScore):null,
   aiReason:reason,
   inferredBasisType:String(item.inferredBasisType||''),
   inferredBasisTitle:String(item.inferredBasisTitle||''),inferredWhy:String(item.inferredWhy||''),
   inferredPreference:String(item.inferredPreference||'').slice(0,95),discoveryWhy:String(item.discoveryWhy||'').slice(0,115),
   inferredHypothesisStatus:inferredHypothesisStatusForExport(item.inferredPreference,item.inferredHypothesisStatus),
   timeStatus:String(item.timeStatus||'unknown'),timeSensitive:!!item.timeSensitive,
   timeReason:String(item.timeReason||''),timeCheckedAt:Number(item.timeCheckedAt)||null,
   timeKind:String(item.timeKind||''),timeOpportunityStatus:String(item.timeOpportunityStatus||''),
   timeZoneQuote:String(item.timeZoneQuote||''),timeDeadlineQuote:String(item.timeDeadlineQuote||''),
   timeDeadlineAt:String(item.timeDeadlineAt||''),timeEvidenceAccepted:!!item.timeEvidenceAccepted,
   timeMetaIssue:String(item.timeMetaIssue||''),
   humanReview:{topicRelevance:'',explanationGrounding:'',sourceReliability:'',unexpectedValue:'',notes:''}};
 });
 const numericSummary=(obj)=>{
  if(!obj||typeof obj!=='object')return null;
  // Keep known diagnostic objects, not opaque API/profile/session fields.
  return JSON.parse(JSON.stringify(obj));
 };
 const normalizedInferenceAudit=numericSummary(m.inferredHypothesisAudit);
 if(normalizedInferenceAudit&&Array.isArray(m.scoringAudit)){
  const counts={hypothesis:0,pending:0,none:0,unlabeled:0};
  let pendingAboveThreshold=0;
  for(const item of m.scoringAudit){
   const status=inferredHypothesisStatusForExport(item.inferredPreference,item.inferredHypothesisStatus);
   counts[status]++;
   if(status==='pending'&&Number(item.inferred)>=55)pendingAboveThreshold++;
  }
  normalizedInferenceAudit.counts=counts;
  normalizedInferenceAudit.pendingAboveThreshold=pendingAboveThreshold;
  normalizedInferenceAudit.statusCountSource='export_normalized_from_cached_preference';
 }
 return {
  schema:'nestrill-next-ai-quality-review-v1',exportedAt:String(exportedAt),
  generatedAt:data?.generatedAt??null,kind:String(data?.kind||''),phase:String(data?.phase||''),
  viewerTimeZone:(typeof Intl!=='undefined'?Intl.DateTimeFormat().resolvedOptions().timeZone:'')||'',
  note:'Quality review of scored candidates including selected and rejected items where Fix34 diagnostics are present. Human review is still required; settings were read at export time, not necessarily generation time.',
  currentSettingsAtExport:{interests:Array.isArray(interests)?interests.map(String):[],exclusions:Array.isArray(exclusions)?exclusions.map(String):[]},
  targetAllocation:{explicit:21,inferred:6,discovery:3,...(m.target||{})},
  actualCounts:countByBucket,
  reviewGuide:{topicRelevance:'適切 / 微妙 / 不適切',explanationGrounding:'具体的な根拠あり / 弱い / 不明',sourceReliability:'問題なし / 要確認 / 問題あり',unexpectedValue:'有益 / 普通 / 不適切',notes:'評価・記事への所感（任意）'},
  mechanicalChecks:{sameUrlLaterRows:dupUrls,sameTitleLaterRows:dupTitles,missingAiReasonRows:entries.filter(e=>!e.aiReason).map(e=>e.number),externalRows:entries.filter(e=>e.origin==='external').map(e=>e.number)},
  diagnostics:{sampling:numericSummary(m.sampling),semanticAttribution:numericSummary(m.semanticAttribution),explicitDiagnostic:numericSummary(m.explicitDiagnostic),inferredDiagnostic:numericSummary(m.inferredDiagnostic),assignmentDiagnostic:numericSummary(m.assignmentDiagnostic),
   inferredHypothesisAudit:normalizedInferenceAudit,
   scoringAudit:Array.isArray(m.scoringAudit)?m.scoringAudit.map(x=>({
    inputEvidence:x.inputEvidence&&typeof x.inputEvidence==='object'?{
     titleInputChars:Number(x.inputEvidence.titleInputChars)||0,
     excerptInputChars:Number(x.inputEvidence.excerptInputChars)||0,
     excerptKind:String(x.inputEvidence.excerptKind||'unknown')}:null,
    id:String(x.id||''),title:String(x.title||''),articleUrl:/^https?:\/\//i.test(String(x.url||''))?String(x.url):'',
    origin:x.origin,searchRoute:String(x.searchRoute||''),queryLabel:String(x.queryLabel||''),
    searchInferenceLane:!!x.searchInferenceLane,searchDiscoveryLane:!!x.searchDiscoveryLane,
    discoveryApproach:String(x.discoveryApproach||''),published:x.published??null,
    timeStatus:String(x.timeStatus||'unknown'),timeSensitive:!!x.timeSensitive,
    timeReason:String(x.timeReason||''),timeCheckedAt:x.timeCheckedAt??null,timeBlocked:!!x.timeBlocked,
    timeKind:String(x.timeKind||''),timeOpportunityStatus:String(x.timeOpportunityStatus||''),
    timeZoneQuote:String(x.timeZoneQuote||''),timeDeadlineQuote:String(x.timeDeadlineQuote||''),
    timeDeadlineAt:String(x.timeDeadlineAt||''),timeEvidenceAccepted:!!x.timeEvidenceAccepted,
    timeMetaIssue:String(x.timeMetaIssue||''),
    explicit:x.explicit,explicitRaw:x.explicitRaw,explicitRelation:String(x.explicitRelation||''),
    explicitInterest:String(x.explicitInterest||''),explicitRelationGateApplied:!!x.explicitRelationGateApplied,
    inferred:x.inferred,discovery:x.discovery,
    excluded:!!x.excluded,selectedBucket:x.selectedBucket||null,sameReportSuppressedBy:String(x.sameReportSuppressedBy||""),qualifies:x.qualifies,
    aiReason:String(x.reason||''),inferredBasisType:String(x.inferredBasisType||''),
    inferredBasisTitle:String(x.inferredBasisTitle||''),inferredWhy:String(x.inferredWhy||''),
    inferredPreference:String(x.inferredPreference||'').slice(0,95),discoveryWhy:String(x.discoveryWhy||'').slice(0,115),
    inferredHypothesisStatus:inferredHypothesisStatusForExport(x.inferredPreference,x.inferredHypothesisStatus),
    humanReview:{topicRelevance:'',explanationGrounding:'',notes:''}
   })):null,
   performanceAudit:numericSummary(m.performanceAudit),discoverySearchAudit:numericSummary(m.discoverySearchAudit),
   storyDedupDiagnostic:numericSummary(m.storyDedupDiagnostic),
   inputEvidenceAudit:numericSummary(m.inputEvidenceAudit),temporalDiagnostic:numericSummary(m.temporalDiagnostic)},
  recommendations:entries
 };
}
async function exportAiQualityReport(data){
 const pid=state.profileId,token=state.secretToken,kind=state.aiKind;
 // All calls reuse Nestrill's existing authenticated, profile-scoped local API.
 const [interests,exclusions]=await Promise.all([api('/api/ai/interests'),api('/api/ai/exclusions')]);
 if(pid!==state.profileId||token!==state.secretToken||kind!==state.aiKind)throw Error('プロファイルが変わったため書き出しを中止しました');
 const report=buildAiQualityReport(data,interests.terms,exclusions.terms,new Date().toISOString());
 const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'});
 const link=document.createElement('a'),url=URL.createObjectURL(blob);
 link.href=url;
 link.download='nestrill-ai-quality-'+(state.secretToken?'secret-':'')+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
 document.body.append(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
 return report;
}

function renderAiPreview(data){
 if(state.aiKind!==data.kind)return;
 setSourcePanelVisible(true);const root=$('source-panel');root.replaceChildren();
 const displayItems=aiFilterShownItems(data.items,data.kind);
 const hiddenByUi=(Array.isArray(data.items)?data.items.length:0)-displayItems.length;
 const blended=data.phase==='blend-preview';
 const semanticActive=data.phase==='semantic-preview'||blended;
 const busy=!!(data.running||data.blendRunning);
 const note=elt('div','ai-preview-note',blended?
  '7：2：1（RSS）：明示的関心70%・AI推定20%・未知10%でGemma 4が別々に評価し、登録済み／登録外の比率を適用しました。件数不足は下に表示します。':semanticActive?
   'Phase D3：従来のローカルAI意味評価です。7：2：1を生成すると登録済み・登録外記事を統合し、3つの推薦枠に振り分けます。':
   (data.model&&data.model!=='none'?
   'Phase D3：現在は従来のキーワード候補です。D3で更新するか「7：2：1を生成」で統合推薦を実行してください。':
   'Phase D3：AIモデル未選択のため、D1のキーワード候補を表示しています。AI意味評価を利用するには設定からOllamaモデルを選んでください。'));
 root.append(note);
 const controls=elt('div','ai-preview-controls');
 const refresh=action(busy?'抽出中…':'D3候補を更新',async()=>{
  refresh.disabled=true;
  const pid=state.profileId,token=state.secretToken,kind=state.aiKind;
  try{
   await post('/api/ai/recommendations/refresh',{kind});
   if(pid!==state.profileId||token!==state.secretToken||state.aiKind!==kind)return;
   const current=await api('/api/ai/recommendations?kind='+kind);
   if(pid!==state.profileId||token!==state.secretToken||state.aiKind!==kind)return;
   renderAiPreview(current);
   if(current.running||current.blendRunning)pollAiPreview(pid,token,kind,aiViewSerial);
  }catch(e){err(e);refresh.disabled=false}
 },false);
 refresh.disabled=busy||!data.hasInterests;controls.append(refresh);
 if(data.kind==='rss'&&data.blendAvailable){
  const blendButton=action(busy?'7：2：1評価中…':'7：2：1を生成',async()=>{
   blendButton.disabled=true;
   const pid=state.profileId,token=state.secretToken,serial=aiViewSerial;
   try{
    await post('/api/ai/blend/refresh',{kind:'rss'});
    if(pid!==state.profileId||token!==state.secretToken||serial!==aiViewSerial||state.aiKind!=='rss')return;
    const d=await api('/api/ai/recommendations?kind=rss');
    if(pid!==state.profileId||token!==state.secretToken||serial!==aiViewSerial)return;
    renderAiPreview(d);
    if(d.running||d.blendRunning)pollAiPreview(pid,token,'rss',serial);
   }catch(e){err(e);blendButton.disabled=false}
  },false);
  blendButton.disabled=busy||!data.hasInterests;controls.append(blendButton);
 }
 root.append(controls);
 if(hiddenByUi)root.append(elt('p','help',`表示ルールにより${hiddenByUi}件を非表示にしています。採用済みの7：2：1枠・採点・品質JSONは変更していません。`));
 if(data.sourceHidden)root.append(elt('p','help',`リンク切れ報告・情報源の除外により${data.sourceHidden}件を非表示にしています。上の配分内訳は前回の生成時点の値です。`));
 if(data.blendMeta){
  if(data.blendFeedbackStale)root.append(elt('div','help','評価・感想が更新されました。現在の推薦一覧は保持しています。新しい嗜好を20%枠へ反映するには「7：2：1を生成」を実行してください。'));
  const m=data.blendMeta;
  const label={explicit:'明示的関心',inferred:'AI推定',discovery:'未知の発見'};
  const lines=['7：2：1の実績（登録済み／登録外）'];
  for(const k of ['explicit','inferred','discovery']){
   const c=m.counts?.[k]||{};
   lines.push(`${label[k]}：${(c.registered||0)+(c.external||0)}/${m.target?.[k]||0}件（${c.registered||0}／${c.external||0}）`);
  }
  if(m.assignmentDiagnostic?.mode==='simultaneous'){
   const ad=m.assignmentDiagnostic;
   lines.push(`枠の配置：3枠同時に割り当て（従来方式の${ad.previousTotal||0}件 → ${ad.currentTotal||0}件）。Gemma 4の評価基準は同じです`);
  }
  if(m.notice)lines.push(m.notice);
  if(Number.isFinite(m.sourceCap))lines.push(`出典の偏り抑制：登録外は同一出典${m.sourceCap}件まで${m.sourceCapSkipped?'（上限に達している未採用候補'+m.sourceCapSkipped+'件）':''}。出典の信頼性を保証するものではありません`);
  if(Number.isFinite(m.discoveryPool))lines.push('未知テーマからの評価候補：'+m.discoveryPool+'件（採用数とは異なります）');
  if(m.explicitDiagnostic){const q=m.explicitDiagnostic;lines.push(`70%枠の診断：基準以上${q.eligible||0}件・他枠に採用${q.assignedToOther||0}件・未採用${q.unselected||0}件（重複・出典上限等を含む）`)}
  const d=m.inferredDiagnostic;
  if(d){
   lines.push(`AI推定の判定：評価${d.positive||0}件・低評価${d.negative||0}件・感想${d.comments||0}件・閲覧${d.weakOpens||0}件（閲覧は微弱）`);
   if(Number.isFinite(d.unsupportedHigh))lines.push(`AI推定：具体的な評価・感想の根拠が確認できず不採用${d.unsupportedHigh}件`);
   if(Number.isFinite(d.evidenceRecallRegistered))lines.push(`過去の評価・感想から候補抽出：登録済み${d.evidenceRecallRegistered}件／登録外${d.evidenceRecallExternal||0}件（AI推定への採用とは別）`);
   if(!(m.counts?.inferred?.registered||m.counts?.inferred?.external)){
    if(!m.inferredEvidence)lines.push('AI推定：学習材料なし');
    else if(!d.eligible)lines.push(`AI推定：採点基準${d.threshold||55}点以上の候補なし（最高${d.topScore||0}点）。学習材料または候補記事が不足している可能性があります`);
    else lines.push(`AI推定：基準以上${d.eligible}件が他枠との重複等で採用されませんでした`);
   }
  }else if(!m.inferredEvidence)lines.push('評価・感想の証拠がないためAI推定枠は空欄です。');
  if(Object.values(m.shortages||{}).some(n=>n>0))lines.push('候補の質を優先し、不足分は無理に埋めていません。');
  root.append(elt('div','ai-preview-note',lines.join('　｜　')));
  // Expand only when the user wants a detailed funnel. Older cached
  // generations (pre-Fix24) legitimately have no sampling statistics.
  const q=m.explicitDiagnostic,sample=m.sampling;
  if(q&&sample&&Number.isFinite(q.alonePossible)){
   const details=elt('details','ai-explicit-audit');
   details.append(elt('summary','',`70%明示的関心：候補不足の内訳（詳細）`));
   const audit=[
    `評価対象に抽出：登録済み ${sample.registeredSampled||0}/${sample.registeredAvailable||0}件（関心リストに文字一致 ${sample.registeredDirect||0}件・その他 ${sample.registeredOther||0}件・過去の評価から再発見 ${sample.registeredEvidence||0}件、重複あり）`,
    `登録外：メタ情報検査を通過した候補 ${sample.externalQualityAvailable||0}件から ${sample.externalSampled||0}件を評価（未知の発見用 ${sample.externalDiscovery||0}件・評価履歴から再発見 ${sample.externalEvidence||0}件）`,
    ...(Number.isFinite(sample.registeredSourceSampled)?[
     `入力候補の広がり：登録済み配信元 ${sample.registeredSourceSampled}/${sample.registeredSourceAvailable}件・未評価の登録済み記事 ${sample.registeredUnscored}件（配信元を分散して抽出）`,
     `登録外の分散：出典 ${sample.externalPublisherSampled}/${sample.externalPublisherAvailable}件・検索経路 ${sample.externalQuerySampled}/${sample.externalQueryAvailable}件（候補抽出の統計であり、記事の信頼性を保証しません）`
    ]:[]),
    ...(Number.isFinite(sample.registeredSemanticReview)?[
     `意味的な事前探索：未評価の登録済み記事 ${sample.registeredSemanticReview}件を確認・AIが候補として提示 ${sample.registeredSemanticSuggested||0}件・最終評価枠へ新規採用 ${sample.registeredSemanticPromoted||0}件（状態：${sample.registeredSemanticStatus==='ok'?'完了':sample.registeredSemanticStatus==='fallback'?'不調のため従来抽出へ復帰':'対象なし'}、${Math.round((sample.registeredSemanticMs||0)/1000)}秒。ここでは適合点を付けず、採用判定は後段のGemma 4で実施）`
    ]:[]),
    ...(sample.registeredSemanticStatus==='ok'&&Number.isFinite(sample.registeredSemanticBatches)?[
     `意味探索の内訳：分割 ${sample.registeredSemanticCompleted||0}/${sample.registeredSemanticBatches||0}組・候補一次抽出 ${sample.registeredSemanticNominated||0}件・Ollama呼出 ${sample.registeredSemanticAttempts||0}回（形式再試行 ${sample.registeredSemanticRetries||0}回）。最終の選出は採点とは独立`
    ]:[]),
    ...(sample.registeredSemanticStatus==='fallback'&&sample.registeredSemanticReason?[
     `意味探索の復帰理由：${sample.registeredSemanticReason}（段階 ${sample.registeredSemanticPhase||'none'}・分割完了 ${sample.registeredSemanticCompleted||0}/${sample.registeredSemanticBatches||0}組・Ollama呼出 ${sample.registeredSemanticAttempts||0}回、再試行 ${sample.registeredSemanticRetries||0}回）。記事・関心の本文は記録していません`
    ]:[]),
    ...(sample.registeredSemanticStatus==='ok'&&Number.isFinite(sample.registeredSemanticIncumbentCompared)?[
     `Fix30候補比較：従来の入替対象 ${sample.registeredSemanticIncumbentCompared||0}件と新規意味候補をGemma 4が比較・従来候補を ${sample.registeredSemanticIncumbentKept||0}件維持・実際に評価枠へ追加 ${sample.registeredSemanticPromoted||0}件（重複等による探索前除外 ${sample.registeredSemanticDuplicateFiltered||0}件）。最終採点の閾値と件数上限は変更なし`
    ]:[]),
    ...(m.semanticAttribution&&Number.isFinite(m.semanticAttribution.scored)?[ (()=>{
     const a=m.semanticAttribution;
     return `意味候補の本採点結果：新規採用した ${a.scored}件中、70%基準55点以上 ${a.qualified}件（70%枠へ ${a.selectedExplicit}件・20%/10%枠へ ${a.selectedOther}件・基準以上でも未採用 ${a.qualifiedNotSelected}件）、基準未満 ${a.belowThreshold}件・AI除外 ${a.excluded}件。従来候補 ${a.baselineScored}件中の基準以上は ${a.baselineQualified}件（候補群が違うため単純な効果比較ではありません）`;
    })() ]:[]),
    `Gemma 4の70%評価：${q.threshold||55}点以上 ${q.eligible||0}件（登録済み ${q.eligibleRegistered||0}件・登録外 ${q.eligibleExternal||0}件）、基準未満 ${q.belowThreshold||0}件・AI除外 ${q.excluded||0}件`,
    `実際の採用：${q.selected||0}件・20%/10%へ割り当て ${q.assignedToOther||0}件・基準以上でも未採用 ${q.unselected||0}件`,
    ...(m.assignmentDiagnostic?.mode==='simultaneous'?[`旧方式との比較：70% ${m.assignmentDiagnostic.previous.explicit||0}→${m.assignmentDiagnostic.current.explicit||0}件、20% ${m.assignmentDiagnostic.previous.inferred||0}→${m.assignmentDiagnostic.current.inferred||0}件、10% ${m.assignmentDiagnostic.previous.discovery||0}→${m.assignmentDiagnostic.current.discovery||0}件`,
     `複数枠に適合 ${m.assignmentDiagnostic.overlappingCandidates||0}件・以前は他枠だった記事が70%へ ${m.assignmentDiagnostic.previouslyOtherNowExplicit||0}件（今回も全枠で重複掲載なし）`]:[]),
    `比較試算：同じ評価済み候補から70%を最優先で選ぶと最大 ${q.alonePossible||0}/${m.target?.explicit||21}件（20%/10%を維持できるという意味ではありません）`,
    `出典上限に達していた未採用候補：70%選考中 ${q.publisherLimitSkipped||0}件（枠間の重複を除いた採用可能数とは異なります）`
   ];
   details.append(elt('div','ai-explicit-audit-lines',audit.join('\n')));
   root.append(details);
  }
 }
 // Quality inspection is opt-in and read-only. Only finalized stored output is exported.
 if(blended&&!busy&&Array.isArray(data.items)&&data.items.length){
  const section=elt('div','ai-quality-audit');
  const heading=elt('strong','','推薦内容の品質確認（件数達成の評価ではありません）');
  const guidance=elt('p','help','確定した推薦記事のタイトル・概要・AI判定理由・出典・診断値をJSONで保存します。関心・除外リストは保存時点の設定を取得します。設定を変更した後は必ず再生成してください。ファイルはPC内に保存され、自動送信されません。');
  const status=elt('span','help');status.setAttribute('role','status');
  const download=action('品質検証データを保存（JSON）',async()=>{
   download.disabled=true;status.textContent='ローカル設定を取得中…';
   try{const report=await exportAiQualityReport(data);status.textContent='保存しました。記事 '+report.recommendations.length+'件（品質判定は未実施）';}
   catch(e){status.textContent='保存できません：'+e.message}
   finally{download.disabled=false}
  },false);
  section.append(heading,guidance,download,status);root.append(section);
 }
 if(data.blendError)root.append(elt('p','source-panel-empty','7：2：1生成エラー：'+data.blendError+(blended?'（前回の確定結果は保持しています）':'')));
 if(data.kind==='rss'&&data.blendAvailable&&!data.blendMeta)root.append(elt('div','help','7：2：1を生成する前に「おすすめを更新」を実行すると、URLや日付などを検査した外部候補も評価できます（リンク先・本文は未検証）。外部探索は手動実行のみです。'));
 if(data.generatedAt)root.append(elt('div','help','最終抽出：'+new Date(data.generatedAt).toLocaleString('ja-JP')));
 if(busy){
  const prog=elt('div','ai-progress-panel');prog.id='ai-progress-panel';prog.setAttribute('role','status');
  const msg=elt('div','ai-progress-message');msg.id='ai-progress-message';
  const track=elt('div','ai-progress-track');track.setAttribute('role','progressbar');track.setAttribute('aria-label','AIセレクトの評価進捗');
  track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');
  const fill=elt('div','ai-progress-fill');track.append(fill);prog.append(msg,track);root.append(prog);
  updateAiProgress(data);
  if(data.blendRunning){
   const partial=elt('section','ai-live-preview');partial.id='ai-blend-live-preview';root.append(partial);renderAiLivePreview(data);
  }
 }else if((data.blendJob?.status==='complete'||data.job?.status==='complete')&&semanticActive){
  root.append(elt('div','help','最終生成処理時間：'+aiElapsed((blended?data.blendJob:data.job)?.elapsedMs)));
 }
 if(data.error)root.append(elt('p','source-panel-empty','抽出エラー：'+data.error));
 if(!data.hasInterests)root.append(elt('p','source-panel-empty','設定 → AIセレクトで関心リストを登録してください。'));
 else if(!data.generatedAt&&!busy)root.append(elt('p','source-panel-empty','候補はまだ生成されていません。「候補を更新」を押してください。'));
 else if(busy&&!data.generatedAt)root.append(elt('p','source-panel-empty','候補を評価しています。ほかの画面にも移動できます。')); 
 else if(!displayItems.length)root.append(elt('p','source-panel-empty',hiddenByUi?'表示ルールによりすべての推薦を非表示にしています。設定 → AIセレクトから解除できます。':'関心リストに一致する取得済み記事・動画がありません。'));
 $('article-count').textContent=data.generatedAt?displayItems.length+' 件':'—';
 if(blended)root.append(elt('h3','',busy?'前回の確定結果（今回の生成完了まで維持）':'7：2：1の推薦結果'));
 // Show all three semantic quotas explicitly, including empty buckets.
 // The bucket is already persisted by ai-blend.js: this is presentation only.
 const groups=blended?[
  {key:'explicit',title:'70%｜明示的関心',short:'70% 明示的関心'},
  {key:'inferred',title:'20%｜AI推定',short:'20% AI推定'},
  {key:'discovery',title:'10%｜未知の発見',short:'10% 未知の発見'}
 ]:[{key:null}];
 for(const group of groups){
  const groupItems=blended?displayItems.filter(item=>item.bucket===group.key):displayItems;
  if(blended){
   const heading=elt('div','ai-blend-group-heading ai-blend-group-'+group.key);
   const target=Number(data.blendMeta?.target?.[group.key])||({explicit:21,inferred:6,discovery:3})[group.key];
   heading.append(elt('strong','',group.title),elt('span','ai-blend-group-count',groupItems.length+'件 / 目標'+target+'件'));
   root.append(heading);
   if(!groupItems.length){
    const diag=data.blendMeta?.inferredDiagnostic;
    root.append(elt('div','ai-blend-group-empty',group.key==='inferred'?
     (!data.blendMeta?.inferredEvidence?'今回は推薦なし（学習材料がありません）':
      diag?.eligible===0?`今回は推薦なし（推定関心度${diag.threshold}点以上の候補がありません。最高${diag.topScore}点）`:
      '今回は推薦なし（他の枠との重複、または採用条件による不足）'):
     '今回は推薦なし（基準を満たす候補がありません）'));
    continue;
   }
  }
  for(const item of groupItems){
  const row=elt('div','ai-preview-row');
  // Keep recommendation visuals aligned with Nestrill's existing thumbnail/favicons.
  let image;
  if(data.kind==='rss'&&item.feedId){image=makeThumb(item)}
  else{
   image=elt('img','thumb');image.alt='';image.loading='lazy';image.referrerPolicy='no-referrer';
   image.src=item.thumbnail||placeholderSrc('missing');
   image.onerror=()=>{image.onerror=null;image.src=placeholderSrc('failed')};
  }
  image.classList.add('ai-preview-image');row.append(image);
  const text=elt('div','ai-preview-text'),link=elt('a','',item.title);
  link.href=item.openUrl||item.url;link.target='_blank';link.rel='noopener noreferrer';
  if(blended){
   const head=elt('div','ai-blend-item-head');
   head.append(elt('span','ai-bucket-tag ai-bucket-'+group.key,group.short),link);
   text.append(head);
  }else text.append(link);
  text.append(elt('div','ai-preview-meta',[item.source,item.published?fmtTime(item.published):'',
   blended?(item.origin==='external'?'登録外':'登録済み')+' ・ AI関連度 '+item.semanticScore+' / 100':
   semanticActive?('AI関連度 '+item.semanticScore+' / 100'):((item.matched||[]).join(' / '))].filter(Boolean).join(' ・ ')));
  if(semanticActive&&blended){
   const reason=readableAiReason(item.semanticReason);
   text.append(elt('div','help',reason?'AIの判定理由：'+reason:'AIの判定理由：未取得（説明文が不適切または空欄）'));
  }else if(semanticActive&&item.semanticReason)text.append(elt('div','help','AIの判定理由：'+item.semanticReason));
  if(blended&&group.key==='inferred'){
   const evidenceType=String(item.inferredBasisType||'');
   const title=String(item.inferredBasisTitle||'');
   const why=String(item.inferredWhy||'');
   if(evidenceType&&title)text.append(elt('div','help',
    `推定の参考：${evidenceType}「${title}」${why?' ／ '+why:''}（AIによる関連付け・未検証）`));
  }
  if(item.excerpt)text.append(elt('div','ai-preview-excerpt',item.excerpt));
  const capturedProfile=state.profileId,capturedToken=state.secretToken,capturedKind=data.kind;
  text.append(makeAiFeedbackBar(item,data.kind,()=>capturedProfile===state.profileId&&capturedToken===state.secretToken&&capturedKind===state.aiKind&&row.isConnected));
  if(data.kind==='rss')text.append(makeAiSourceControls(item,()=>capturedProfile===state.profileId&&capturedToken===state.secretToken&&capturedKind===state.aiKind&&row.isConnected));
  if(item.origin==='external')text.append(elt('div','help','外部記事：RSSメタ情報（URL・日付・出典表記・重複）の検査のみ。リンク先の到達性・本文の信頼性は未検証です。'));
  row.append(text);root.append(row);
  }
 }
 // E2 candidate list is reference material: never put it above the primary E4 results.
 if(data.kind==='rss')mountAiExternalSection(root);
}


// Quality of the ARTICLE / PUBLISHER is independent from preference for its topic.
// Only explicit user action blocks a publisher. RSS publisher domains are not
// independently verified. Never infer a block from a single broken link.
// A quick manager for source exclusions. It uses the existing profile-scoped API.
// Removing a source restriction never clears article reports or RSS subscriptions.

// Edits publisher exclusions only, never topic interests, article reports or RSS feeds.
function aiSourceAddRow(reload,status,current){
 const row=elt('div','ai-source-domain-add');
 const input=elt('input','ai-source-domain-input');input.type='text';input.placeholder='例：example.com/sub1/（全体なら example.com）';
 input.setAttribute('aria-label','除外するドメインまたはURLパス');input.autocomplete='off';input.spellcheck=false;
 const add=action('除外対象を追加',async()=>{
  if(!current())return;
  add.disabled=true;
  try{
   await post('/api/ai/source-feedback',{action:'add_source',host:input.value.trim()});
   if(!current())return;
   input.value='';await reload();
  }catch(e){if(current())status.textContent='追加できません：'+e.message}
  finally{add.disabled=false}
 },false);
 input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();add.click()}});
 row.append(input,add);return row;
}
function renderAiSourceDomainRows(list,blocked,reload,status,current){
 list.replaceChildren();
 if(!blocked.length){list.append(elt('p','help','現在、除外しているドメイン・URLパスはありません。'));return}
 for(const source of blocked){
  const line=elt('div','ai-source-blocked-row');
  line.append(elt('span','',source.host));
  const edit=action('編集',()=>{
   if(!current())return;
   const input=elt('input','ai-source-domain-input');input.type='text';input.value=source.host;
   input.setAttribute('aria-label',source.host+' の編集');input.autocomplete='off';input.spellcheck=false;
   const save=action('変更を保存',async()=>{
    if(!current())return;
    const newHost=input.value.trim();
    if(newHost!==source.host&&!confirm('除外対象を変更しますか？\n'+source.host+' → '+newHost+'\n\n変更前の指定は解除されます。'))return;
    save.disabled=true;
    try{await post('/api/ai/source-feedback',{action:'rename_source',host:source.host,newHost});if(current())await reload()}
    catch(e){if(current()){status.textContent='変更できません：'+e.message;save.disabled=false}}
   },false);
   const cancel=action('キャンセル',()=>{if(current())reload()},false);
   input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();save.click()}else if(e.key==='Escape'){e.preventDefault();cancel.click()}});
   line.replaceChildren(input,save,cancel);line.classList.add('ai-source-editing');input.focus();input.select();
  },false);
  const remove=action('除外を解除',async()=>{
   if(!current()||!confirm('次の除外対象を解除しますか？\n'+source.host+'\n\n次回の推薦・探索で再び候補になる可能性があります。'))return;
   remove.disabled=true;
   try{await post('/api/ai/source-feedback',{action:'unblock',host:source.host});if(current())await reload()}
   catch(e){if(current()){status.textContent='解除できません：'+e.message;remove.disabled=false}}
  },false);
  line.append(edit,remove);list.append(line);
 }
}

// An always-visible position rail for long publisher/article exclusion lists.
// Chromium/Helium may fade out native overlay scrollbars, so reuse the sidebar rail.
function makeAiSourceScrollBox(list){
 const shell=elt('div','ai-source-scroll-shell');
 const track=elt('div','youtube-persistent-scrollbar ai-source-persistent-scrollbar');
 const thumb=elt('div','youtube-persistent-scrollbar-thumb');
 track.setAttribute('role','scrollbar');
 track.setAttribute('aria-label','除外一覧をスクロール');
 track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');
 track.tabIndex=0;track.append(thumb);shell.append(list,track);
 setupYoutubePersistentScrollbar(shell,list,track,thumb);
 // The list's client height can stay capped while rows are added/removed.
 // Refresh the thumb on content changes, not only on resize or scrolling.
 const changes=new MutationObserver(()=>{
  requestAnimationFrame(()=>{if(shell.isConnected)list.dispatchEvent(new Event('scroll'))});
 });
 changes.observe(list,{childList:true});
 const originalCleanup=shell._youtubeScrollbarCleanup;
 shell._aiSourceScrollbarCleanup=()=>{changes.disconnect();originalCleanup?.()};
 requestAnimationFrame(()=>{if(shell.isConnected)list.dispatchEvent(new Event('scroll'))});
 return shell;
}
function cleanupAiSourceScrollBoxes(){
 const body=$('dialog-body');
 if(!body)return;
 body.querySelectorAll('.ai-source-scroll-shell').forEach(shell=>shell._aiSourceScrollbarCleanup?.());
}

// Fix31: persistent position rails on the two editable AI topic lists.
// Their heights are fixed; textarea content may change without a resize.
function makeAiTopicScrollBox(area,label){
 const shell=elt('div','ai-topic-scroll-shell');
 const track=elt('div','youtube-persistent-scrollbar ai-topic-persistent-scrollbar');
 const thumb=elt('div','youtube-persistent-scrollbar-thumb');
 track.setAttribute('role','scrollbar');track.setAttribute('aria-label',label+'をスクロール');
 track.setAttribute('aria-orientation','vertical');
 track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');
 track.tabIndex=-1;track.append(thumb);shell.append(area,track);
 setupYoutubePersistentScrollbar(shell,area,track,thumb,true);
 const refresh=()=>requestAnimationFrame(()=>{
  if(shell.isConnected)area.dispatchEvent(new Event('scroll'));
 });
 area.addEventListener('input',refresh); // Typing does not resize the textarea.
 shell._aiTopicRefreshScrollbar=refresh;
 const cleanup=shell._youtubeScrollbarCleanup;
 shell._aiTopicScrollbarCleanup=()=>{cleanup?.()};
 refresh();
 return shell;
}
function cleanupAiTopicScrollBoxes(){
 const body=$('dialog-body');if(!body)return;
 body.querySelectorAll('.ai-topic-scroll-shell').forEach(shell=>shell._aiTopicScrollbarCleanup?.());
}

function aiSourceSearchInput(label,placeholder,onSearch){
 const input=elt('input','ai-source-search-input');
 input.type='search';input.placeholder=placeholder;input.setAttribute('aria-label',label);
 input.autocomplete='off';input.spellcheck=false;
 input.addEventListener('input',onSearch);
 return input;
}
function aiSourceFilterText(value){return String(value||'').normalize('NFKC').toLocaleLowerCase().trim()}
function openAiSourceExclusionManager(onBack){
 const pid=state.profileId,token=state.secretToken;
 const root=elt('div','ai-source-feedback-dialog');
 root.append(elt('p','help','ドメイン全体（example.com）またはディレクトリ配下（example.com/sub1/）を除外できます。URLパスは記事URLから確認できる場合のみ判定します。Googleニュース経由でリンク先パスが未確認の記事には、パス指定の除外は適用できません。既存のRSS登録や記事単位の報告は変更しません。'));
 const status=elt('p','help','一覧を取得中…');status.setAttribute('role','status');
 const list=elt('div','ai-source-blocked-list');
 const resultCount=elt('p','help ai-source-filter-count','');
 let blockedCache=[];
 const search=aiSourceSearchInput('除外サイト・URLパスを検索','サイト・URLパスを絞り込む',paint);
 root.append(status);
 const controls=elt('div','form-actions');
 controls.append(action('戻る',()=>{if(typeof onBack==='function')onBack();else closeDialog()},false));
 const current=()=>pid===state.profileId&&token===state.secretToken&&$('dialog-body').contains(root);
 root.append(aiSourceAddRow(refresh,status,current),search,resultCount,makeAiSourceScrollBox(list),controls);
 openDialog('除外サイト・URLパス一覧・編集',root);
 function paint(){
  const q=aiSourceFilterText(search.value);
  const rows=blockedCache.filter(s=>aiSourceFilterText(s.host).includes(q));
  resultCount.textContent='表示 '+rows.length+' / '+blockedCache.length+'件';
  if(rows.length)renderAiSourceDomainRows(list,rows,refresh,status,current);
  else list.replaceChildren(elt('p','help',blockedCache.length?'検索に一致する除外対象はありません。':'除外設定はありません。'));
 }
 async function refresh(){
  try{
   const data=await api('/api/ai/source-feedback');
   if(!current())return;
   blockedCache=Array.isArray(data.blocked)?data.blocked:[];
   status.textContent='除外設定：'+blockedCache.length+'件（追加・編集・解除できます）';
   paint();
  }catch(e){if(current())status.textContent='一覧の取得に失敗しました：'+e.message}
 }
 refresh();
}

function makeAiSourceControls(item,isActive,externalPreview=false){
 const id=externalPreview?'x:'+String(item.id):String(item.id);
 const button=action('出典・除外設定 ⋯',async()=>{
  if(!isActive())return;
  button.disabled=true;
  try{
   const detail=await api('/api/ai/source-feedback?itemId='+encodeURIComponent(id));
   if(!isActive())return;
   const container=elt('div','ai-source-feedback-dialog');
   container.append(elt('p','help','記事の内容への興味とは別の報告です。リンク切れや低品質の報告は、その記事だけをおすすめから外します。情報源全体の除外は確認後に実行します。'));
   container.append(elt('div','ai-source-info',detail.title));
   container.append(elt('p','help',detail.host?
    '情報源ドメイン：'+detail.host+(detail.unverified?'（RSS記載情報・未検証）':'（記事のURL）'):
    '情報源ドメイン不明：記事単位の報告のみ可能です。'));
   const reasonOptions=[
    ['dead_link','リンク切れ・アクセス不能'],
    ['low_quality','低品質・無関係なページ'],
    ['content_mismatch','リンク先が記事内容と一致しない']
   ];
   const reasonSet=new Set(detail.reportedTypes|| (detail.reported?[detail.reported]:[]));
   const group=elt('fieldset','ai-source-reason-group');
   group.append(elt('legend','','記事の除外理由（複数選択可）'));
   const checks=[];
   for(const [key,label] of reasonOptions){
    const row=elt('label','ai-source-reason-option');
    const input=elt('input');input.type='checkbox';input.value=key;input.checked=reasonSet.has(key);
    row.append(input,elt('span','',label));group.append(row);checks.push(input);
   }
   container.append(group);
   container.append(elt('p','help','理由を選び「この記事を除外」を押すと、その記事だけがAIセレクトから除外されます。理由はNestrill内に保存し、外部サイトには送信しません。'));
   const status=elt('p','settings-error');status.hidden=true;
   const actions=elt('div','ai-source-feedback-controls');
   const safe=()=>isActive()&&state.aiKind==='rss';
   async function apply(request,success){
    if(!safe())return;
    actions.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{
     await post('/api/ai/source-feedback',request);
     if(!safe())return;
     closeDialog();notify(success);
     await selectAiKind('rss');
    }catch(e){status.textContent=e.message;status.hidden=false;actions.querySelectorAll('button').forEach(b=>b.disabled=false);updateSubmit()}
   }
   const submit=action('この記事を除外',()=>{
    const types=checks.filter(c=>c.checked).map(c=>c.value);
    if(!types.length)return;
    apply({action:'flag',itemId:id,types},'この記事をおすすめから除外しました');
   });
   const updateSubmit=()=>{submit.disabled=!checks.some(c=>c.checked)};
   for(const c of checks)c.addEventListener('change',updateSubmit);
   updateSubmit();actions.append(submit);
   if(!externalPreview)actions.append(action('このタイトルを表示から隠す',()=>{
    if(!safe())return;try{hideAiTitleOnce(item);closeDialog();notify('このタイトルを表示から隠しました。再生成は不要です。');selectAiKind('rss').catch(err)}catch(e){err(e)}
   },false));
   if(detail.reported)actions.append(action('この記事の除外を解除',()=>apply({action:'clear',itemId:id},'報告を取り消しました'),false));
   if(detail.host&&!detail.blocked){
    actions.append(action('この情報源を除外',()=>{
     const verify=elt('div','ai-source-feedback-dialog');
     verify.append(elt('p','help','次の情報源ドメインを、このプロファイルのAIセレクトから除外します。元のRSS登録や記事そのものは削除しません。'));
     verify.append(elt('strong','',detail.host),elt('p','help',detail.unverified?'このドメインはRSSの出典欄から取得した未検証の情報です。':'このドメインは記事URLから取得しました。'));
     const msg=elt('p','settings-error');msg.hidden=true;
     const controls=elt('div','form-actions');
     controls.append(action('戻る',()=>openDialog('記事の出典と除外設定',container),false));
     const confirm=action('この情報源を除外',async()=>{
      confirm.disabled=true;
      try{await post('/api/ai/source-feedback',{action:'block',itemId:id,confirmHost:detail.host});
       if(!safe())return;closeDialog();notify('情報源 '+detail.host+' を除外しました');await selectAiKind('rss')}
      catch(e){msg.textContent=e.message;msg.hidden=false;confirm.disabled=false}
     });
     controls.append(confirm);verify.append(msg,controls);
     openDialog('情報源の除外を確認',verify);
    },false));
   }
   actions.append(action('除外サイト・URLパス一覧を確認・編集',()=>openAiSourceExclusionManager(()=>openDialog('記事の出典と除外設定',container)),false));
   container.append(actions,status);
   openDialog('記事の出典と除外設定',container);
  }catch(e){if(isActive())err(e)}finally{button.disabled=false}
 },false);
 button.classList.add('ai-source-feedback-button');
 return decorateAiAction(button,'source','出典・除外設定');
}

// Display-only icons: preserve original button callbacks, title, aria and pressed state.
const AI_ACTION_ICONS={
 like:['M7 10v12','M14 5.88 13 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 16.5 22H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 3a3.13 3.13 0 0 1 2 2.88Z'],
 dislike:['M17 14V2','M10 18.12 11 14H5.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 7.5 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 21a3.13 3.13 0 0 1-2-2.88Z'],
 comment:['M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z'],
 source:['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71','M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71']
};
function setAiActionLabel(button,label){
 const span=button.querySelector('.ai-action-label');if(span)span.textContent=label;
 button.title=label;button.setAttribute('aria-label',label);button.dataset.tooltip=label;
}
function decorateAiAction(button,type,label){
 button.classList.add('ai-compact-action');
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 svg.setAttribute('class','ai-action-icon');svg.setAttribute('viewBox','0 0 24 24');
 svg.setAttribute('width','16');svg.setAttribute('height','16');svg.setAttribute('aria-hidden','true');
 svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');
 svg.setAttribute('stroke-width','1.8');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');
 for(const d of AI_ACTION_ICONS[type]){const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',d);svg.append(p)}
 button.replaceChildren(svg,elt('span','ai-action-label',label));setAiActionLabel(button,label);
 return button;
}

// Shared feedback controls. E2 items use the same stable external x: ID as E4.
function makeAiFeedbackBar(item,kind,isActive){
  const feedbackBar=elt('div','ai-feedback-actions');
  const feedback={rating:item.feedback?.rating||0,comment:item.feedback?.comment||''};
  const capturedKind=kind;
  const positive=decorateAiAction(action('興味あり',()=>rateAiItem(1),false),'like','興味あり');
  const negative=decorateAiAction(action('興味なし',()=>rateAiItem(-1),false),'dislike','興味なし');
  const commentButton=decorateAiAction(action(feedback.comment?'感想を編集':'感想を書く',()=>openAiComment(),false),'comment',feedback.comment?'感想を編集':'感想を書く');
  const updateButtons=()=>{
   positive.classList.toggle('ai-feedback-selected',feedback.rating===1);
   negative.classList.toggle('ai-feedback-selected',feedback.rating===-1);
   positive.setAttribute('aria-pressed',String(feedback.rating===1));
   negative.setAttribute('aria-pressed',String(feedback.rating===-1));
   setAiActionLabel(commentButton,feedback.comment?'感想を編集':'感想を書く');
  };
  const stillActive=isActive;
  async function saveFeedback(rating,comment){
   if(!stillActive())return;
   for(const b of [positive,negative,commentButton])b.disabled=true;
   try{
    const r=await post('/api/ai/feedback',{kind:capturedKind,itemId:String(item.id),rating,comment});
    if(!stillActive())return;
    feedback.rating=r.rating;feedback.comment=r.comment;updateButtons();
   }catch(e){if(stillActive())err(e)}
   finally{if(stillActive())for(const b of [positive,negative,commentButton])b.disabled=false}
  }
  function rateAiItem(rating){saveFeedback(feedback.rating===rating?0:rating,feedback.comment)}
  function openAiComment(){
   if(!stillActive())return;
   const content=elt('div');content.append(elt('p','help','この感想はAI推定のための記録です。関心リストは変更されません。最大500文字。'));
   const area=elt('textarea','ai-comment-textarea');area.maxLength=500;area.value=feedback.comment;
   const validation=elt('div','settings-error');validation.hidden=true;content.append(area,validation);
   const buttons=elt('div','form-actions');buttons.append(action('キャンセル',closeDialog,false));
   const save=action('感想を保存',async()=>{
    if(!stillActive()){closeDialog();return}
    save.disabled=true;
    try{
     const r=await post('/api/ai/feedback',{kind:capturedKind,itemId:String(item.id),rating:feedback.rating,comment:area.value});
     if(!stillActive()){closeDialog();return}
     feedback.rating=r.rating;feedback.comment=r.comment;updateButtons();closeDialog();notify('感想を保存しました');
    }catch(e){validation.textContent=e.message;validation.hidden=false}
    finally{save.disabled=false}
   });buttons.append(save);content.append(buttons);
   openDialog('AIセレクト / 感想',content);
  }
  updateButtons();feedbackBar.append(positive,negative,commentButton);
  return feedbackBar;
}

// Fix103G: E2 presentation only. Scope all styles to external candidate rows.
// No changes to discovery, filtering, score, feedback IDs or API contracts.
function e2CompactStyles(){
 if(document.getElementById('nestrill-e2-compact-style'))return;
 const style=document.createElement('style');style.id='nestrill-e2-compact-style';
 style.textContent=`
 .ai-external-results .e2-compact-row{display:flex;align-items:flex-start;gap:11px;padding:9px 4px;margin:0;border-bottom:1px solid #91a2b336;min-width:0}
 .ai-external-section .ai-external-results .e2-compact-row{margin-top:0}
 .ai-external-results .e2-compact-row .ai-preview-image{flex:0 0 70px;width:70px;height:50px;object-fit:cover;border-radius:5px}
 .ai-external-results .e2-compact-row .ai-preview-image.favicon-thumb{object-fit:contain;padding:10px;background-color:#7891b00b;box-sizing:border-box}
 .ai-external-results .e2-compact-copy{min-width:0;flex:1}
 .ai-external-results .e2-compact-copy > a{font-weight:650;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
 .ai-external-results .e2-compact-meta-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:3px;min-width:0}
 .ai-external-results .e2-compact-meta{font-size:11px;opacity:.73;line-height:1.45;min-width:0;flex:1 1 55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .ai-external-results .e2-compact-excerpt{font-size:11px;line-height:1.45;opacity:.78;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 /* Fix103AT: map existing article text shadows to the E2 display only. */
 .ai-external-results .e2-compact-copy > a{text-shadow:var(--article-title-shadow,none)}
 .ai-external-results .e2-compact-meta{text-shadow:var(--article-source-shadow,none)}
 .ai-external-results .e2-compact-excerpt{text-shadow:var(--article-excerpt-shadow,none)}
 .ai-external-results .e2-compact-details{display:block;width:100%;margin-top:2px;font-size:11px;line-height:1.55;color:inherit}
 .ai-external-results .e2-compact-details summary{cursor:pointer;display:inline-block;list-style:none;color:var(--accent,#4c82c6);padding:2px 0;user-select:none}
 .ai-external-results .e2-compact-details summary::-webkit-details-marker{display:none}
 .ai-external-section .e2-search-settings{font-size:12px;line-height:1.5;margin:3px 0 9px}
 .ai-external-section .e2-search-settings>summary{display:inline-block;cursor:pointer;color:var(--accent,#4c82c6);user-select:none}
 .ai-external-section .e2-search-settings-body{max-width:510px;padding:10px 12px;border:1px solid #91a2b34d;border-radius:6px;margin-top:7px}
 .ai-external-section .e2-setting-line{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin:8px 0;font-size:12px}
 .ai-external-section .e2-setting-input{box-sizing:border-box;flex:0 0 90px;width:90px;padding:4px 6px;min-height:29px}
 .ai-external-section .e2-setting-group-title{font-weight:650;margin-top:14px}
 .ai-external-section .e2-search-settings-body .help{margin:3px 0 8px}
 .e2-top-guide,.ai-external-section .e2-search-diagnostics{font-size:12px;line-height:1.5;margin:4px 0 8px}
 .e2-top-guide summary,.ai-external-section .e2-search-diagnostics summary{display:inline-block;cursor:pointer;user-select:none;color:var(--accent,#4c82c6);list-style:none}
 .e2-top-guide summary::-webkit-details-marker,.ai-external-section .e2-search-diagnostics summary::-webkit-details-marker{display:none}
 .e2-top-guide summary::before,.ai-external-section .e2-search-diagnostics summary::before{content:'▸ ';font-size:11px}
 .e2-top-guide[open] summary::before,.ai-external-section .e2-search-diagnostics[open] summary::before{content:'▾ '}
 .e2-top-guide-body{border-left:2px solid #9bb2d1;background:#7891b00b;padding:6px 10px;margin-top:4px}
 .e2-top-guide-body .help{margin:4px 0}
 .ai-external-section .e2-search-brief{font-size:12px;line-height:1.5;margin:4px 0 2px;overflow-wrap:anywhere}
 .ai-external-section .e2-search-diagnostics .e2-search-log{margin-top:5px;border-left:2px solid #9bb2d1;background:#7891b00b;padding:6px 10px;overflow-wrap:anywhere}
 .ai-external-results .e2-compact-details summary::before{content:'▸ ';font-size:10px}
 .ai-external-results .e2-compact-details[open] summary::before{content:'▾ '}
 .ai-external-results .e2-compact-detail-body{margin:3px 0 3px;padding:7px 9px;border-left:2px solid #9bb2d1;background:#7891b00b;overflow-wrap:anywhere}
 .ai-external-results .e2-compact-detail-body > div + div{margin-top:5px}
 .ai-external-results .e2-compact-actions{display:flex;align-items:flex-start;justify-content:flex-end;gap:3px;flex:none;padding-top:2px}
 .ai-external-results .e2-compact-actions .ai-feedback-actions{display:flex;gap:3px;flex-wrap:nowrap;margin:0;padding:0}
 .ai-external-results .e2-compact-actions .ai-compact-action{display:inline-flex;align-items:center;justify-content:center;width:27px;min-width:27px;height:27px;min-height:27px;padding:3px;margin:0;line-height:1;border:1px solid #cdd6e4;border-radius:5px;background:#fff9;color:#62748c;vertical-align:top}
 .ai-external-results .e2-compact-actions .ai-compact-action .ai-action-icon{display:block;flex:none}
 .ai-external-results .e2-compact-actions .ai-compact-action .ai-action-label{display:none}
 .ai-external-results .e2-compact-actions .ai-feedback-selected{border-color:#4773ba;background:#dce8fb;color:#1b437e}
 .ai-external-results .e2-compact-actions .ai-compact-action:focus-visible{outline:2px solid #4c82c6;outline-offset:2px}
 @media(max-width:850px){
  .ai-external-results .e2-compact-row{flex-wrap:wrap;gap:7px}
  .ai-external-results .e2-compact-row .ai-preview-image{flex-basis:62px;width:62px;height:46px}
  .ai-external-results .e2-compact-copy{flex:1 1 calc(100% - 70px)}
  .ai-external-results .e2-compact-actions{margin-left:69px;padding:0;flex:1 1 100%;justify-content:flex-start}
 }
 `;
 document.head.appendChild(style);
}
function e2UniqueExcerpt(item){
 const excerpt=String(item.excerpt||'').trim();if(!excerpt)return '';
 const normalized=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s\u3000.,。!！?？:：;；|｜・･\-–—―_「」『』()（）\[\]【】]/g,'');
 const publisher=normalized(item.source);
 const trimPublisher=s=>publisher&&s.endsWith(publisher)?s.slice(0,-publisher.length):s;
 const text=normalized(excerpt),title=normalized(item.title);
 if(!text||text===title||trimPublisher(text)===trimPublisher(title))return '';
 return excerpt;
}

// Fix103Y: UI-only move of E2 controls to the article exploration settings tab.
// Keep the existing endpoint, values, validation and relative-weight semantics unchanged.
function renderE2ExplorationSettings(root){
 const pid=state.profileId,token=state.secretToken;
 const current=()=>state.settingsSlot==='ai'&&state.profileId===pid&&state.secretToken===token&&root.isConnected;
 if(!document.getElementById('nestrill-e2-exploration-settings-style')){
  const style=document.createElement('style');style.id='nestrill-e2-exploration-settings-style';
  style.textContent=`
   .e2-search-settings-pane .e2-search-settings-body{max-width:560px;padding:9px 2px 6px}
   .e2-search-settings-pane .e2-setting-line{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:9px;margin:9px 0;font-size:12px}
   .e2-search-settings-pane .e2-setting-input{box-sizing:border-box;flex:0 0 90px;width:90px;padding:5px 7px;min-height:29px}
   .e2-search-settings-pane .e2-setting-group-title{font-weight:650;margin-top:14px}
   .e2-search-settings-pane .e2-search-settings-body .help{margin:3px 0 8px}
  `;
  document.head.appendChild(style);
 }
 // Fix103M: persistent search controls. These are independent of the legacy E4 UI.
 const configPanel=persistentSettingsAccordion('e2-exploration-settings','探索設定（関心テーマ数・記事上限・探索比率）',false,'ai-managed-details ai-exclusions-section e2-search-settings-pane');
 const configBody=elt('div','e2-search-settings-body');
 const fields={};
 function numberField(key,label,min,max){
  const line=elt('label','e2-setting-line');
  line.append(elt('span','',label));
  const input=elt('input','e2-setting-input');input.type='number';input.min=String(min);input.max=String(max);input.step='1';
  input.autocomplete='off';fields[key]=input;line.append(input);configBody.append(line);
 }
 numberField('topicCount','1回に直接検索する関心テーマ数',1,40);
 configBody.append(elt('p','help','登録した関心をランダム巡回します。一巡するまで同じテーマを原則繰り返しません。'));
 numberField('maxItems','採用記事数の上限',20,200);
 configBody.append(elt('p','help','20～200件。採用される記事数は検索結果や品質判定により少なくなります。'));
 configBody.append(elt('div','e2-setting-group-title','探索経路の候補確保比率（％）'));
 configBody.append(elt('p','help','記事数ではなく、探索経路ごとの優先比率です。合計100％で指定してください。'));
 numberField('directWeight','明示関心（％）',1,98);
 numberField('inferenceWeight','AI推定（％）',1,98);
 numberField('discoveryWeight','未知探索（％）',1,98);
 // The server stores positive relative weights, including legacy 7:8:15 and
 // 28:28:40. Show percentages only. Largest remainder keeps the total 100
 // without changing persisted settings until the user explicitly saves them.
 function toPercentWeights(raw){
  const values=raw.map(v=>Math.max(0,Number(v)||0));
  const total=values.reduce((a,b)=>a+b,0);
  if(!total)return [29,29,42];
  const exact=values.map(v=>v*100/total),out=exact.map(Math.floor);
  let remaining=100-out.reduce((a,b)=>a+b,0);
  const order=[0,1,2].sort((a,b)=>(exact[b]-out[b])-(exact[a]-out[a])||a-b);
  for(let i=0;i<remaining;i++)out[order[i]]++;
  // Every legacy lane weight was positive. Preserve that requirement.
  for(let i=0;i<3;i++)if(values[i]>0&&out[i]===0){
   let biggest=0;for(let j=1;j<3;j++)if(out[j]>out[biggest])biggest=j;
   if(out[biggest]>1){out[biggest]--;out[i]++;}
  }
  return out;
 }
 const ratioText=elt('p','help');configBody.append(ratioText);
 for(const name of ['directWeight','inferenceWeight','discoveryWeight'])fields[name].oninput=()=>{
  const v=['directWeight','inferenceWeight','discoveryWeight'].map(k=>Number(fields[k].value)||0);
  const sum=v.reduce((a,b)=>a+b,0);
  ratioText.textContent=sum===100?'合計：100％':`合計：${sum}％（100％になるよう調整してください）`;
 };
 const settingsMessage=elt('div','help');
 const saveSettings=action('探索設定を保存',async()=>{
  if(!current())return;
  const values={};
  for(const [key,input] of Object.entries(fields)){
   const value=Number(input.value);
   if(!input.value.trim()||!Number.isSafeInteger(value)||value<Number(input.min)||value>Number(input.max)){
    settingsMessage.textContent='設定値を確認してください：'+key;return;
   }
   values[key]=value;
  }
  if(values.directWeight+values.inferenceWeight+values.discoveryWeight!==100){
   settingsMessage.textContent='探索比率の合計を100％にしてください。';return;
  }
  saveSettings.disabled=true;
  try{await post('/api/ai/external/settings',values);if(current())settingsMessage.textContent='保存しました。次回のAIセレクトから反映します。';}
  catch(e){if(current())settingsMessage.textContent='保存できません：'+e.message;}
  finally{if(current())saveSettings.disabled=false;}
 },false);
 configBody.append(saveSettings,settingsMessage);configPanel.append(configBody);root.append(configPanel);

 // Load settings directly from the existing E2 endpoint, even when article exploration was never opened.
 const loadSettings=async()=>{
  try{
   const data=await api('/api/ai/external');if(!current())return;
   if(!data.settings){settingsMessage.textContent='探索設定を取得できませんでした。';saveSettings.disabled=true;return;}
   const normalized=toPercentWeights([data.settings.directWeight,data.settings.inferenceWeight,data.settings.discoveryWeight]);
   const percentKeys=['directWeight','inferenceWeight','discoveryWeight'];
   for(const [key,input] of Object.entries(fields)){
    const index=percentKeys.indexOf(key);
    input.value=String(index<0?data.settings[key]:normalized[index]);
    if(key==='topicCount')input.max=String(Math.min(40,Math.max(1,data.interestCount||1)));
    input.disabled=!!data.running;
   }
   fields.directWeight.oninput();
   saveSettings.disabled=!!data.running;
   if(data.running)settingsMessage.textContent='探索中は変更できません。探索完了後に設定を開き直してください。';
  }catch(e){if(current()){settingsMessage.textContent='探索設定を読み込めません：'+e.message;saveSettings.disabled=true;}}
 };
 saveSettings.disabled=true;
 if(configPanel.open)loadSettings();
 else configPanel.addEventListener('toggle',()=>{if(configPanel.open)loadSettings()},{once:true});
}

// E2 is the only active RSS AI discovery view. Legacy 7:2:1 remains dormant
// for safe rollback; neither its scoring endpoint nor 30-item view is called.
function mountAiExternalSection(root){
 e2CompactStyles();
 const pid=state.profileId,token=state.secretToken,serial=aiViewSerial;
 const active=()=>state.aiKind==='rss'&&state.profileId===pid&&state.secretToken===token&&aiViewSerial===serial&&section.isConnected;
 const section=elt('section','ai-external-section');
 section.append(elt('h3','','AIが見つけた記事（登録外）'));
 const controls=elt('div','ai-preview-controls');
 const run=action('おすすめを更新',async()=>{
  run.disabled=true;
  try{await post('/api/ai/external/refresh',{});if(active())await refresh()}
  catch(e){if(active())err(e)}
  finally{if(active())run.disabled=false}
 },false);
 controls.append(run);section.append(controls);
 const info=elt('div','help e2-search-log','外部候補を読み込み中…');
 const brief=elt('div','e2-search-brief','外部候補を読み込み中…');
 const diagnostics=elt('details','e2-search-diagnostics');
 diagnostics.append(elt('summary','','探索ログ・計測の詳細'),info);
 const results=elt('div','ai-external-results');
 // Fix103N: preserve DOM nodes (and the user's position/details/buttons) as
 // already-seen rows remain stable and only newly completed rows append.
 let displayedIds=[];
 section.append(brief,diagnostics,results);root.append(section);
 async function refresh(){
  if(!active())return;
  try{
   const data=await api('/api/ai/external');if(!active())return;
   const p=data.progress;

   const headline=data.running?(p?.published?`探索継続中 ・ ${p.published}件を公開済み ・ 経過${aiElapsed(data.elapsedMs||0)}`:(p?.stage==='planning'?'ローカルAIで未知の探索テーマを検討中…':p?.stage==='excluding'||p?.stage==='excluding_preview'?`除外話題をAIで確認中：${p?.completed||0}/${p?.total||0}件`:p?.stage==='quality'?'外部記事の品質を確認中…':`登録外の記事を探索中：${p?.completed||0}/${p?.total||0}件`)):
    (data.generatedAt?'最終探索：'+new Date(data.generatedAt).toLocaleString('ja-JP')+' ・ '+data.items.length+'件'+(data.elapsedMs?' ・ 探索 '+aiElapsed(data.elapsedMs):''):'記事はまだ探索されていません。');
   info.textContent=headline;
   brief.textContent=headline;
   if(data.exclusionMode==='literal')info.textContent+=' ・ 除外判定：タイトルの直接一致のみ（AI未適用）';
   else if(data.exclusionMode==='literal_fallback')info.textContent+=' ・ 注意：AI除外は失敗。直接一致のみ（意味判定未完了）';
   else if(data.exclusionMode==='semantic')info.textContent+=' ・ 除外判定：ローカルAI';
   if(data.qualityStats){
    const q=data.qualityStats;
    info.textContent+=` ・ RSSメタ情報検査：採用${q.accepted||0}件／類似・重複${q.duplicates||0}件／出典不明${q.unverified||0}件／日付等不備${q.invalid||0}件／期限外${q.stale||0}件／同一出典上限${q.sourceLimit||0}件／関心除外${q.excluded||0}件（リンク先の実在・本文は未検証）`;
    if(q.stageTimings&&Number.isFinite(q.stageTimings.totalMs)){
     const t=q.stageTimings;
     info.textContent+=' ・ 内訳：テーマ生成 '+aiElapsed(t.planningMs||0)+
      '／検索RSS取得 '+aiElapsed(t.rssFetchMs||0)+
      '／意味照合 '+aiElapsed(t.semanticMs||0)+
      '／候補不足時の追加探索 '+aiElapsed(t.rescueMs||0)+
      '／AI除外 '+aiElapsed(t.exclusionMs||0);
     if(t.semanticBudget?.enabled){
      const b=t.semanticBudget;
      info.textContent+=' ・ 少数件数の段階照合：'+(b.stoppedEarly?'候補確保で判定を早期終了':'全候補を確認')+
       '（意味照合'+b.processedTasks+'/'+b.totalTasks+'組、未判定'+b.deferredItems+'件）';
     }
     if(t.cache){
      info.textContent+=' ・ 同条件の判定再利用：検索意味照合'+(t.cache.screenHits||0)+'件／AI除外'+(t.cache.exclusionHits||0)+'件（最大'+(t.cache.ttlHours||48)+'時間）';
     }
     if(t.ollama&&Number.isFinite(t.ollama.calls)){
      const o=t.ollama;
      info.textContent+=' ・ Ollama実測：'+o.calls+'回（内訳取得'+o.reportedCalls+'回）';
      if(o.reportedCalls){
       info.textContent+='／モデル読込'+aiElapsed(o.loadMs||0)+'（最大'+aiElapsed(o.maxLoadMs||0)+', 1秒以上'+(o.loadOver1sCalls||0)+'回）'+
        '／入力処理'+aiElapsed(o.promptMs||0)+'（'+(o.promptTokens||0)+'tok）'+
        '／応答生成'+aiElapsed(o.generationMs||0)+'（'+(o.generationTokens||0)+'tok）';
      }
      const p=o.byPhase||{};
      info.textContent+='／工程別呼出：計画'+(p.planning?.calls||0)+'・意味'+(p.semantic?.calls||0)+
       '・追加'+(p.rescue?.calls||0)+'・除外'+(p.exclusion?.calls||0);
      if(o.failedCalls)info.textContent+='／通信失敗'+o.failedCalls+'回';
     }
    }
    if(q.discoveryCount!==undefined)info.textContent+=` ・ 未知テーマ候補${q.discoveryCount||0}件`;
    if(q.directTopics?.length)info.textContent+=' ・ 直接検索テーマ：'+q.directTopics.join(' / ');
    if(q.discoveryTopics?.length)info.textContent+=' ・ 探索テーマ：'+q.discoveryTopics.map(x=>x.topic).join(' / ');
    if(q.discoveryWarning)info.textContent+=' ・ '+q.discoveryWarning;
    // Nestrill Fix81: display optional third-party headline synopsis results.
   }else if(data.generatedAt)info.textContent+=' ・ 旧キャッシュ（品質検査前）：今回の検査結果ではありません';
   if(data.sourceHidden)info.textContent+=' ・ 品質報告／情報源除外により'+data.sourceHidden+'件を非表示';
   if(data.error)info.textContent+=' ・ '+data.error;
   // Keep warnings and progress visible even when the detailed measurements are folded.
   if(data.exclusionMode==='literal_fallback')brief.textContent+=' ・ 注意：AI除外の意味判定未完了';
   if(data.qualityStats?.discoveryWarning)brief.textContent+=' ・ 追加探索に注意あり';
   if(data.error)brief.textContent+=' ・ 注意：'+data.error;
   run.disabled=!!data.running||!data.hasInterests;
   const visibleItems=aiFilterShownItems(data.items,'rss');
   $('article-count').textContent=String(visibleItems.length)+' 件';
   const nextIds=visibleItems.map(x=>String(x.id));
   const appendOnly=!results.querySelector('.e2-empty-state')&&nextIds.length>=displayedIds.length&&
    displayedIds.every((id,i)=>id===nextIds[i])&&
    results.querySelectorAll('.e2-compact-row').length===displayedIds.length;
   if(!appendOnly){results.replaceChildren();displayedIds=[]}
   // Each poll previously replaced every row. Appending instead avoids
   // closing expanded details, losing the focus, and jumping the scroll.
   for(const item of visibleItems.slice(displayedIds.length)){
    const row=elt('div','ai-preview-row e2-compact-row');
    const img=elt('img','thumb ai-preview-image');img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';
    // Fix103L: E2 has a publisher hostname even when Google News gives no image.
    // Fetch the favicon through Nestrill's guarded icon proxy, never from an
    // arbitrary client-supplied remote URL. Keep normal article-image failures
    // distinct from a missing favicon.
    if(item.thumbnail){
     img.src=item.thumbnail;
     img.onerror=()=>{img.onerror=null;img.src=placeholderSrc('failed')};
    }else if(!state.secretToken&&Number.isSafeInteger(Number(state.profileId))&&Number(state.profileId)>0&&/^[a-f0-9]{32}$/.test(String(item.id||''))){
     img.classList.add('favicon-thumb');
     img.src='/api/ai/external-icon/'+Number(state.profileId)+'/'+item.id;
     img.onerror=()=>{img.onerror=null;img.classList.remove('favicon-thumb');img.src=placeholderSrc('missing')};
    }else{
     img.src=placeholderSrc('missing');
    }
    const content=elt('div','ai-preview-text e2-compact-copy'),link=elt('a','',item.title);
    link.href=item.openUrl||item.url;link.target='_blank';link.rel='noopener noreferrer';content.append(link);
    const route=item.discoveryLane?'未知':item.inferenceLane?'推定':'関心';
    const meta=[item.source,item.published?fmtTime(item.published):'',
     item.queryLabel?route+'：'+item.queryLabel:route].filter(Boolean).join(' ・ ');
    const metaRow=elt('div','e2-compact-meta-row'),metaLine=elt('span','e2-compact-meta',meta);
    metaLine.title=meta;metaRow.append(metaLine);content.append(metaRow);
    const excerpt=e2UniqueExcerpt(item);
    if(excerpt){const snippet=elt('div','e2-compact-excerpt',excerpt);snippet.title=excerpt;content.append(snippet)}
    const detailLines=[];
    if(item.discoveryLane&&item.discoveryBridge)detailLines.push('未知探索の理由：'+item.discoveryBridge);
    else if(item.inferenceLane)detailLines.push('好評履歴を参考にした推定探索');
    if(item.publisherHost)detailLines.push('RSS記載の出典：'+item.publisherHost);
    if(excerpt)detailLines.push('記事の抜粋：'+excerpt);
    if(String(item.qualityNotes||'').includes('Bingニュース検索RSS'))detailLines.push('概要補足：Bingニュース検索RSS由来（記事本文は未検証）');
    if(detailLines.length){
     const details=elt('details','e2-compact-details'),summary=elt('summary','','おすすめ理由・詳細');
     const detailBody=elt('div','e2-compact-detail-body');
     for(const line of detailLines)detailBody.append(elt('div','',line));
     details.append(summary,detailBody);content.append(details);
    }
    const actions=elt('div','e2-compact-actions');
    // E2 IDs are the raw URL hash; prefix them exactly as E4 recommendations.
    // Ownership and current-candidate validity are independently checked server-side.
    if(data.qualityApplied&&/^[a-f0-9]{32}$/.test(String(item.id||''))){
     const feedbackItem={...item,id:'x:'+item.id};
     actions.append(makeAiFeedbackBar(feedbackItem,'rss',()=>active()&&row.isConnected));
     actions.append(makeAiSourceControls(item,()=>active()&&row.isConnected,true));
    }
    row.append(img,content,actions);results.append(row);
   }
   displayedIds=nextIds;
   if(data.running)setTimeout(refresh,2000);
   else if(data.generatedAt&&!data.items.length&&!results.querySelector('.e2-empty-state')){const empty=elt('p','help e2-empty-state','条件に合う外部記事が見つかりませんでした。');results.append(empty)}
  }catch(e){if(active()){info.textContent='登録外候補を取得できません：'+e.message;brief.textContent=info.textContent;run.disabled=false}}
 }
 refresh();
}
function aiElapsed(ms){
 const sec=Math.floor(Math.max(0,Number(ms)||0)/1000);
 return sec<60?sec+'秒':Math.floor(sec/60)+'分'+String(sec%60).padStart(2,'0')+'秒';
}
function updateAiProgress(data){
 const msg=$('ai-progress-message');
 if(!msg)return;
 const job=(data.blendRunning?data.blendJob:data.job)||{},done=Number(job.completed)||0,total=Number(job.total)||0;
 const elapsed=aiElapsed(job.elapsedMs||0);
 const diagnostic=job.stage==='diagnostic';
 const temporal=job.stage==='temporal'||job.stage==='temporal_retrying';
 const timeDone=Math.max(0,Number(job.timeCompleted)||0),timeTotal=Math.max(0,Number(job.timeTotal)||0);
 const phaseDone=(temporal||diagnostic)?timeDone:done,phaseTotal=(temporal||diagnostic)?timeTotal:total;
 if(diagnostic){
  msg.textContent='一度限りの採点再現性診断中：'+timeDone+' / '+timeTotal+'回 ・ 経過 '+elapsed;
 }else if(temporal){
  const label=job.stage==='temporal_retrying'?'時間判定の応答を再確認中':'時間的な有効性を確認中';
  msg.textContent=label+'：'+timeDone+' / '+timeTotal+'件 ・ 経過 '+elapsed;
 }else if(job.stage==='finalizing'){
  msg.textContent='推薦結果を確定中 ・ 経過 '+elapsed;
 }else{
  msg.textContent=total?(job.stage==='retrying'?'採点の応答形式を再確認中':'AI評価中')+'：'+done+' / '+total+'件 ・ 経過 '+elapsed
   :(job.stage==='recalling'?'Gemma 4で未評価記事の意味候補を探索中 ・ 経過 ':'AI評価の準備中 ・ 経過 ')+elapsed;
 }
 const progress=document.querySelector('#ai-progress-panel [role="progressbar"]');
 if(progress){
  const pct=phaseTotal?Math.min(100,Math.round(phaseDone/phaseTotal*100)):0;
  progress.setAttribute('aria-valuenow',String(pct));
  progress.setAttribute('aria-label',temporal?'AIセレクトの時間判定進捗':'AIセレクトの評価進捗');
  const fill=progress.querySelector('.ai-progress-fill');if(fill)fill.style.width=pct+'%';
 }
}
async function pollAiPreview(pid,token,kind,serial){
 const active=()=>pid===state.profileId&&token===state.secretToken&&state.aiKind===kind&&serial===aiViewSerial;
 let errors=0;
 while(active()){
  await new Promise(resolve=>setTimeout(resolve,2000));
  if(!active())return;
  try{
   const data=await api('/api/ai/recommendations?kind='+kind);
   if(!active())return;
   errors=0;
   if(!data.running&&!data.blendRunning){renderAiPreview(data);return}
   updateAiProgress(data);
   if(data.blendRunning)renderAiLivePreview(data);
  }catch(e){
   if(++errors>=3){
    if(active()){
     const msg=$('ai-progress-message');
     if(msg)msg.textContent='進捗の取得に失敗しました。AI評価はサーバー側で継続している可能性があります。再表示して確認してください。';
    }
    return;
   }
  }
 }
}
async function renderAiInterestSettings(root){
 const pid=state.profileId,token=state.secretToken;
  // Fix90B: YouTube AI is frozen. Display only the existing RSS interest list.
  // The YouTube/shared lists stay in SQLite unchanged for potential future use.
  const interestsSection=persistentSettingsAccordion('ai-interests-section','関心リスト',true,'ai-managed-details ai-exclusions-section');
  interestsSection.append(elt('p','help','AIセレクトに使用します。改行またはカンマで区切って登録します。'));
  const area=elt('textarea','ai-interests-textarea ai-fixed-scroll-area ai-interests-entry');area.placeholder='PC\nAI\nマウス';
  const message=elt('div','settings-error');message.hidden=true;
  const interestsStatus=elt('p','help','関心リストを読み込み中…');interestsStatus.setAttribute('role','status');
  interestsSection.append(makeAiTopicScrollBox(area,'関心リスト'),interestsStatus,message);
  interestsSection.addEventListener('toggle',()=>{if(interestsSection.open)area.parentElement?._aiTopicRefreshScrollbar?.()});
  root.append(interestsSection);
 // Fix83C: exclusions use the same persistent accordion as interests.
 const excludeSection=persistentSettingsAccordion('ai-exclusions-section','除外リスト',true,'ai-managed-details ai-exclusions-section');
 excludeSection.append(elt('p','help',
  'AIセレクトで表示したくない話題を、関心リストとは別に入力します（改行・カンマ区切り）。Gemmaの検索テーマ生成・候補除外に使います。AIが自動変更することはありません。'));
 const excludedArea=elt('textarea','ai-interests-textarea ai-exclusions-textarea ai-fixed-scroll-area ai-exclusions-entry');

 const excludedStatus=elt('p','help','除外リストを読み込み中…');excludedStatus.setAttribute('role','status');
 const saveExcluded=action('除外リストを保存',async()=>{
  saveExcluded.disabled=true;excludedStatus.textContent='保存中…';
  try{
   if(pid!==state.profileId||token!==state.secretToken)throw Error('プロファイルが切り替わりました');
   const data=await post('/api/ai/exclusions',{text:excludedArea.value});
   if(pid!==state.profileId||token!==state.secretToken)return;
   excludedArea.value=data.terms.join('\n');excludedArea.parentElement._aiTopicRefreshScrollbar();
   excludedStatus.textContent='保存しました。新しい除外条件は次回の「おすすめを更新」で反映されます。';
   if(state.aiKind)selectAiKind(state.aiKind).catch(err);
  }catch(e){excludedStatus.textContent='保存エラー：'+e.message}
  finally{saveExcluded.disabled=false}
 },false);
 excludeSection.append(makeAiTopicScrollBox(excludedArea,'除外リスト'),saveExcluded,excludedStatus);
 excludeSection.addEventListener('toggle',()=>{if(excludeSection.open)excludedArea.parentElement._aiTopicRefreshScrollbar?.()});
 root.append(excludeSection);
 renderE2ExplorationSettings(root);
 renderAiVisibilitySettings(root);
 api('/api/ai/exclusions').then(data=>{
  if(pid!==state.profileId||token!==state.secretToken||!root.isConnected)return;
  excludedArea.value=data.terms.join('\n');excludedArea.parentElement._aiTopicRefreshScrollbar();excludedStatus.textContent='保存済みの除外項目：'+data.terms.length+'件。ローカルAIが使えるときは意味で判定します。';
 }).catch(e=>{if(pid===state.profileId&&token===state.secretToken){excludedStatus.textContent='読み込みエラー：'+e.message;saveExcluded.disabled=true}});

 // Fix19: history never loads until expanded; no Ollama work or feed refresh.
 const history=elt('details','ai-feedback-history ai-exclusions-section');
 const historySummary=elt('summary','','評価履歴（興味あり・興味なし・感想）');
 const historyBody=elt('div','ai-feedback-history-body');
 historyBody.append(elt('p','help','保存済みの評価を確認・検索・修正できます。関心リストと記事の除外理由は変更しません。過去の記事が配信元から消えても、保存済み評価は編集できます。なお、表示された全履歴が今回の20%推薦に使われたという意味ではありません。'));
 const historyControls=elt('div','ai-feedback-history-controls');
 const historySearch=elt('input','ai-source-search-input');historySearch.type='search';historySearch.placeholder='記事名・感想で検索';
 historySearch.setAttribute('aria-label','評価履歴を検索');historySearch.maxLength=100;
 const historyFilter=elt('select');historyFilter.setAttribute('aria-label','評価の種類');
 [['all','すべての評価'],['liked','興味あり'],['disliked','興味なし'],['comment','感想あり']].forEach(([v,label])=>historyFilter.append(new Option(label,v)));
 const historyKind=elt('select');historyKind.setAttribute('aria-label','記事の情報源');
 [['rss','RSS']].forEach(([v,label])=>historyKind.append(new Option(label,v)));
 historyControls.append(historySearch,historyFilter);historyBody.append(historyControls);
 const historyCount=elt('p','help ai-source-filter-count','');historyCount.setAttribute('role','status');historyBody.append(historyCount);
 const historyList=elt('div','ai-feedback-history-list');historyBody.append(historyList);
 const historyBulk=elt('div','rss-history-bulk');
 const selectPage=elt('input');selectPage.type='checkbox';selectPage.setAttribute('aria-label','このページのRSS評価をすべて選択');
 const selectedCount=elt('span','help','選択 0件');
 const deleteSelected=action('選択した評価を削除',async()=>{
  if(!historyActive())return;
  const ids=[...historyList.querySelectorAll('input.rss-history-select:checked')].map(c=>c.value);
  if(!ids.length)return;
  if(!confirm(ids.length+'件のRSS評価・感想を削除しますか？\n記事・既読・お気に入りは残ります。'))return;
  deleteSelected.disabled=true;deleteAll.disabled=true;
  try{const result=await post('/api/ai/feedback/history/bulk',{action:'selected',kind:'rss',itemIds:ids});
   if(historyActive()){await loadHistory(historyPage);historyCount.textContent=result.removed+'件の評価・感想を削除しました。'}
  }catch(e){if(historyActive())err(e)}finally{deleteSelected.disabled=false;deleteAll.disabled=false}
 },false);
 const deleteAll=action('RSSの評価履歴をすべて破棄',async()=>{
  if(!historyActive()||!historyTotal)return;
  if(!confirm('このプロファイルのRSS評価・感想を【全件】削除します。\n検索・表示条件に関わらずすべてが対象です。記事・既読・お気に入り・関心語は残ります。'))return;
  if(prompt('取り消せません。実行する場合は「破棄」と入力してください。')!=='破棄')return;
  deleteAll.disabled=true;deleteSelected.disabled=true;
  try{const result=await post('/api/ai/feedback/history/bulk',{action:'all',kind:'rss',confirm:'DELETE_ALL_RSS_FEEDBACK'});
   if(historyActive()){await loadHistory(0);historyCount.textContent=result.removed+'件のRSS評価・感想を破棄しました。次回の推薦生成から反映されます。'}
  }catch(e){if(historyActive())err(e)}finally{deleteAll.disabled=false;deleteSelected.disabled=false}
 },false);
 historyBulk.append(selectPage,selectedCount,deleteSelected,deleteAll);historyBody.append(historyBulk);
 const selectedChanged=()=>{const boxes=[...historyList.querySelectorAll('input.rss-history-select')];const chosen=boxes.filter(x=>x.checked).length;selectedCount.textContent='選択 '+chosen+'件';selectPage.checked=boxes.length>0&&chosen===boxes.length;deleteSelected.disabled=chosen===0};
 selectPage.onchange=()=>{historyList.querySelectorAll('input.rss-history-select').forEach(x=>{x.checked=selectPage.checked});selectedChanged()};
 deleteSelected.disabled=true;deleteAll.disabled=true;
 
 const historyPaging=elt('div','ai-feedback-history-paging');
 const prev=action('前の30件',()=>loadHistory(Math.max(0,historyPage-1)),false);
 const next=action('次の30件',()=>loadHistory(historyPage+1),false);
 historyPaging.append(prev,next);historyBody.append(historyPaging);history.append(historySummary,historyBody);root.append(history);
 let historyPage=0,historyTotal=0,historySerial=0,historyTimer=null;
 const historyActive=()=>history.open&&history.isConnected&&pid===state.profileId&&token===state.secretToken;
 function renderHistoryRow(item){
  const line=elt('div','ai-feedback-history-row');
  const pick=elt('input','rss-history-select');pick.type='checkbox';pick.value=item.itemId;pick.setAttribute('aria-label','このRSS評価を選択');pick.addEventListener('change',selectedChanged);line.append(pick);
  const info=elt('div','ai-feedback-history-info');
  const top=elt('div','ai-feedback-history-title',item.title);
  const ratingName=item.rating===1?'興味あり':item.rating===-1?'興味なし':'評価なし';
  const meta=elt('p','help',`${item.kind==='youtube'?'YouTube':'RSS'} ・ ${ratingName} ・ ${new Date(item.updatedAt).toLocaleString('ja-JP')}`);
  info.append(top,meta);
  if(item.comment)info.append(elt('div','ai-feedback-history-note',item.comment));
  const actions=elt('div','ai-feedback-history-actions');
  const edit=action('評価を編集',()=>{
   if(!historyActive())return;
   const editor=elt('div','ai-feedback-history-editor');
   const rating=elt('select');rating.setAttribute('aria-label','評価を変更');
   [['1','興味あり'],['-1','興味なし'],['0','未評価']].forEach(([v,label])=>rating.append(new Option(label,v)));
   rating.value=String(item.rating);
   const comment=elt('textarea','ai-comment-textarea');comment.maxLength=500;comment.value=item.comment||'';
   comment.placeholder='感想（500文字以内）';comment.setAttribute('aria-label','感想を編集');
   const warning=elt('p','settings-error');warning.hidden=true;warning.setAttribute('role','alert');
   const controls=elt('div','ai-feedback-history-actions');
   const cancel=action('キャンセル',()=>{if(historyActive()){editor.remove();actions.hidden=false}},false);
   const save=action('変更を保存',async()=>{
    if(!historyActive())return;
    const newRating=Number(rating.value),newComment=comment.value.trim();
    if(newRating===0&&!newComment&&!confirm('この評価と感想を完全に取り消しますか？'))return;
    save.disabled=true;cancel.disabled=true;warning.hidden=true;
    try{
     const result=await post('/api/ai/feedback/history',{kind:item.kind,itemId:item.itemId,rating:newRating,comment:newComment});
     if(historyActive()){
      await loadHistory(historyPage);
      historyCount.textContent=result.deleted?'評価を取り消しました。':'評価を保存しました。推薦に反映するには次回の生成が必要です。';
     }
    }catch(e){if(historyActive()){warning.textContent='保存エラー：'+e.message;warning.hidden=false}}
    finally{save.disabled=false;cancel.disabled=false}
   },false);
   controls.append(cancel,save);editor.append(rating,comment,warning,controls);
   line.append(editor);actions.hidden=true;
  },false);
  const remove=action('この評価を削除',async()=>{
   if(!historyActive())return;
   if(!confirm(`「${item.title}」の評価・感想を削除しますか？\n記事本体・既読・お気に入りは削除されません。`))return;
   edit.disabled=true;remove.disabled=true;
   try{
    const result=await post('/api/ai/feedback/history',{kind:item.kind,itemId:item.itemId,rating:0,comment:''});
    if(historyActive()){
     await loadHistory(historyPage);
     if(result.deleted)historyCount.textContent='評価・感想を削除しました。次回のAI生成から反映されます。';
    }
   }catch(e){if(historyActive())err(e)}
   finally{edit.disabled=false;remove.disabled=false}
  },false);
  remove.classList.add('ai-feedback-delete-button');
  actions.append(edit,remove);line.append(info,actions);return line;
 }
 async function loadHistory(page=0){
  if(!historyActive())return;
  const serial=++historySerial;
  historyPage=page;historyCount.textContent='評価履歴を読み込み中…';
  const params=new URLSearchParams({filter:historyFilter.value,kind:historyKind.value,q:historySearch.value.trim(),page:String(page)});
  try{
   const data=await api('/api/ai/feedback/history?'+params.toString());
   if(!historyActive()||serial!==historySerial)return;
   historyTotal=data.total;historyPage=data.page;
   historyList.replaceChildren();selectPage.checked=false;
   for(const item of data.items||[])historyList.append(renderHistoryRow(item));
   selectedChanged();deleteAll.disabled=data.total===0;
   if(!data.items?.length)historyList.append(elt('p','help',data.total?'このページには履歴がありません。':'該当する評価履歴はありません。'));
   historyCount.textContent=`${data.total}件中 ${data.total?data.page*data.limit+1:0}～${Math.min(data.total,(data.page+1)*data.limit)}件を表示`;
   prev.disabled=data.page===0;next.disabled=(data.page+1)*data.limit>=data.total;
   historyPaging.hidden=next.disabled&&prev.disabled;
  }catch(e){if(historyActive()&&serial===historySerial){historyCount.textContent='履歴の取得に失敗しました：'+e.message;historyList.replaceChildren();historyPaging.hidden=true}}
 }
 history.addEventListener('toggle',()=>{if(history.open)loadHistory(0);else{historySerial++;if(historyTimer)clearTimeout(historyTimer)}});
 function updateHistorySearch(){if(!historyActive())return;if(historyTimer)clearTimeout(historyTimer);historyTimer=setTimeout(()=>loadHistory(0),250)}
 historySearch.addEventListener('input',updateHistorySearch);
 historyFilter.addEventListener('change',()=>loadHistory(0));historyKind.addEventListener('change',()=>loadHistory(0));

 // Independent managed groups. Toggle state survives closing/reopening Settings.
 const blockedSection=persistentSettingsAccordion('ai-blocked-domains','除外サイト・URLパス一覧（編集・解除）',false,'ai-managed-details ai-exclusions-section');
 const blockedSummary=blockedSection.querySelector('summary');
 blockedSection.append(elt('p','help','ドメイン全体（example.com）とディレクトリ配下（example.com/sub1/）を指定できます。パスの照合には確認できる記事URLが必要です。Googleニュースなどリンク先パスが不明な場合はドメイン全体の除外だけが確実です。記事単位の報告は別管理です。'));
 const reportsSection=persistentSettingsAccordion('ai-blocked-articles','除外した記事（理由の編集・解除）',false,'ai-managed-details ai-exclusions-section');
 const reportsSummary=reportsSection.querySelector('summary');
 reportsSection.append(elt('p','help','除外した記事の理由を確認・編集・解除できます。ドメインの除外とは別管理です。'));
 const updateManagedHeadings=()=>{
  blockedSummary.textContent=`除外サイト・URLパス一覧（編集・解除） · ${sourceCache.blocked.length}件`;
  reportsSummary.textContent=`除外した記事（理由の編集・解除） · ${sourceCache.reports.length}件`;
 };
 const blockedStatus=elt('div','help','情報源を確認中…');blockedStatus.setAttribute('role','status');
 const blockedList=elt('div','ai-source-blocked-list');
 const reportsList=elt('div','ai-source-blocked-list');
 const blockedCount=elt('p','help ai-source-filter-count','');
 const reportsCount=elt('p','help ai-source-filter-count','');
 let sourceCache={blocked:[],reports:[]};
 const domainSearch=aiSourceSearchInput('除外サイト・URLパスを検索','ドメイン・URLパスで検索',paintSourceLists);
 const reportSearch=aiSourceSearchInput('除外記事を検索','記事名・報告理由で検索',paintSourceLists);
 const currentBlocked=()=>pid===state.profileId&&token===state.secretToken&&root.isConnected;
 blockedSection.append(blockedStatus,aiSourceAddRow(reloadBlocked,blockedStatus,currentBlocked),domainSearch,blockedCount,makeAiSourceScrollBox(blockedList));
 reportsSection.append(reportSearch,reportsCount,makeAiSourceScrollBox(reportsList));
 root.append(blockedSection,reportsSection);
 for(const [section,list] of [[blockedSection,blockedList],[reportsSection,reportsList]]){
  section.addEventListener('toggle',()=>{
   if(section.open)requestAnimationFrame(()=>{if(section.isConnected)list.dispatchEvent(new Event('scroll'))});
  });
 }
 const typeLabels={dead_link:'リンク切れ・アクセス不能',low_quality:'低品質・無関係なページ',content_mismatch:'リンク先と記事内容の不一致'};
 function renderReportedArticle(line,entry){
  const reportTypes=Array.isArray(entry.types)&&entry.types.length?entry.types:[entry.type];
  const title=elt('span','',entry.title+'（'+reportTypes.map(t=>typeLabels[t]||'その他').join('／')+'）');
  const buttons=elt('div','ai-source-report-actions');
  const edit=action('理由を編集',()=>{
   if(!currentBlocked())return;
   const editor=elt('div','ai-source-report-editor');
   const fieldset=elt('fieldset','ai-source-reason-group');
   fieldset.append(elt('legend','','この除外記事の理由を修正'));
   const inputs=[];
   for(const [reason,label] of Object.entries(typeLabels)){
    const labelEl=elt('label','ai-source-reason-option');
    const checkbox=elt('input');checkbox.type='checkbox';checkbox.value=reason;checkbox.checked=reportTypes.includes(reason);
    labelEl.append(checkbox,elt('span','',label));fieldset.append(labelEl);inputs.push(checkbox);
   }
   const errors=elt('div','settings-error');errors.hidden=true;errors.setAttribute('role','alert');
   const actions=elt('div','ai-source-report-actions');
   const cancel=action('キャンセル',()=>{if(currentBlocked()){line.replaceChildren(title,buttons);line.classList.remove('ai-source-report-editing')}},false);
   const save=action('理由を保存',async()=>{
    if(!currentBlocked())return;
    const types=inputs.filter(i=>i.checked).map(i=>i.value);
    if(!types.length){errors.hidden=false;errors.textContent='理由を1つ以上選択してください';return}
    save.disabled=true;cancel.disabled=true;
    try{
     await post('/api/ai/source-feedback',{action:'update_report',itemId:entry.itemKey,types});
     if(currentBlocked())await reloadBlocked();
    }catch(e){if(currentBlocked()){errors.hidden=false;errors.textContent='理由を保存できません：'+e.message}}
    finally{if(currentBlocked()){save.disabled=false;cancel.disabled=false}}
   },false);
   actions.append(cancel,save);editor.append(fieldset,errors,actions);
   line.replaceChildren(title,editor);line.classList.add('ai-source-report-editing');
  },false);
  const undo=action('記事の除外を解除',async()=>{
   if(!currentBlocked()||!confirm('この記事の除外を解除しますか？\n'+entry.title))return;
   undo.disabled=true;
   try{await post('/api/ai/source-feedback',{action:'clear',itemId:entry.itemKey});if(currentBlocked())await reloadBlocked()}
   catch(e){if(currentBlocked()){blockedStatus.textContent='報告を解除できません：'+e.message;undo.disabled=false}}
  },false);
  buttons.append(edit,undo);line.append(title,buttons);
 }
 function paintSourceLists(){
  if(!currentBlocked())return;
  const bd=aiSourceFilterText(domainSearch.value),ar=aiSourceFilterText(reportSearch.value);
  const domains=sourceCache.blocked.filter(entry=>aiSourceFilterText(entry.host).includes(bd));
  const articles=sourceCache.reports.filter(entry=>{
   const names=(entry.types||[entry.type]).map(t=>typeLabels[t]||'').join(' ');
   return aiSourceFilterText(entry.title+' '+names).includes(ar);
  });
  blockedCount.textContent='表示 '+domains.length+' / '+sourceCache.blocked.length+'件';
  reportsCount.textContent='表示 '+articles.length+' / '+sourceCache.reports.length+'件';
  if(domains.length)renderAiSourceDomainRows(blockedList,domains,reloadBlocked,blockedStatus,currentBlocked);
  else blockedList.replaceChildren(elt('p','help',sourceCache.blocked.length?'検索に一致する除外対象はありません。':'除外設定はありません。'));
  reportsList.replaceChildren();
  for(const entry of articles){const line=elt('div','ai-source-blocked-row ai-source-report-row');renderReportedArticle(line,entry);reportsList.append(line)}
  if(!articles.length)reportsList.append(elt('p','help',sourceCache.reports.length?'検索に一致する記事はありません。':'記事単位の除外はありません。'));
 }
 async function reloadBlocked(){
  try{
   const data=await api('/api/ai/source-feedback');
   if(!currentBlocked())return;
   sourceCache={blocked:Array.isArray(data.blocked)?data.blocked:[],reports:Array.isArray(data.reports)?data.reports:[]};
   blockedStatus.textContent='除外設定 '+sourceCache.blocked.length+'件 ・ 除外記事 '+sourceCache.reports.length+'件';
   updateManagedHeadings();paintSourceLists();
  }catch(e){if(currentBlocked())blockedStatus.textContent='情報源の一覧を取得できません：'+e.message}
 }
 reloadBlocked();
 // Diagnostic only: open events never trigger automatic inference.
 const openSection=elt('section','ai-source-mix-section');
 openSection.append(elt('h3','','閲覧シグナル（微弱）'),elt('p','help',
  '記事を実際に開いた操作だけを記録します。通常クリック・ホイールクリック・リンクURLを開くスーパードラッグは同じ扱いです。1記事につき24時間に1回まで。好評・感想より大幅に弱い情報として、次回のE2探索時にのみ参考にします。'));
 const openStatus=elt('p','help','閲覧シグナルを確認中…');openStatus.setAttribute('role','status');
 const openAlive=()=>pid===state.profileId&&token===state.secretToken&&root.isConnected;
 const paintOpenStatus=data=>{openStatus.textContent='記録済み '+data.total+'記事'+(data.lastOpenedAt?' ・ 最終検知：'+new Date(data.lastOpenedAt).toLocaleString('ja-JP'):' ・ まだ記録はありません')};
 let openBusy=false;
 const refreshOpen=action('記録状況を更新',async()=>{
  if(openBusy)return;openBusy=true;refreshOpen.disabled=true;resetOpen.disabled=true;
  try{const data=await api('/api/ai/open-status');if(openAlive())paintOpenStatus(data)}
  catch(e){if(openAlive())openStatus.textContent='記録状況を確認できません：'+e.message}
  finally{openBusy=false;refreshOpen.disabled=false;resetOpen.disabled=false}
 },false);
 const resetOpen=action('閲覧シグナルをリセット',async()=>{
  if(openBusy)return;openBusy=true;refreshOpen.disabled=true;resetOpen.disabled=true;
  try{
   const data=await api('/api/ai/open-status');
   if(!openAlive())return;
   paintOpenStatus(data);
   if(!data.total){openStatus.textContent='記録済み 0記事 ・ リセット対象はありません';return}
   if(!confirm('このプロファイルの閲覧シグナル '+data.total+'記事分を削除しますか？\n取り消せません。興味あり・興味なし・感想、RSS記事・既読・お気に入りは削除されません。'))return;
   if(!openAlive())return;
   const result=await post('/api/ai/open-signals/reset',{confirm:'reset-open-signals',expectedTotal:data.total});
   if(!openAlive())return;
   paintOpenStatus(result);
   openStatus.textContent+=' ・ '+result.deleted+'記事分の閲覧シグナルをリセットしました。次回のAIセレクトから反映されます。';
  }catch(e){if(openAlive())openStatus.textContent='リセットできませんでした：'+e.message+'（記録件数が変わった場合は「記録状況を更新」で再確認してください）'}
  finally{openBusy=false;refreshOpen.disabled=false;resetOpen.disabled=false}
 },false);
 const openControls=elt('div','ai-open-signal-controls');openControls.style.display='flex';openControls.style.gap='8px';openControls.style.flexWrap='wrap';
 openControls.append(refreshOpen,resetOpen);openSection.append(openStatus,openControls);root.append(openSection);refreshOpen.click();
 // Model choice is explicit and isolated per profile. Model selection is NOT an automatic inference trigger.
 const llmSection=elt('section','ai-model-section');
 llmSection.append(elt('h3','','AIセレクトのローカルAI（E2）'),
  elt('p','help','AIセレクトに使用するOllamaモデルを選択します。探索は「おすすめを更新」を押した場合だけ実行し、通常の閲覧中には自動実行しません。'));
 const modelSelect=elt('select');modelSelect.append(new Option('使用しない（キーワード候補のみ）',''));
 const modelStatus=elt('div','help','ローカルOllamaを確認中…');
 const saveModelButton=action('AIモデル設定を保存',async()=>{
  saveModelButton.disabled=true;modelStatus.textContent='モデル設定を保存中…';
  try{
   if(pid!==state.profileId||token!==state.secretToken)throw Error('プロファイルが切り替わりました');
   await post('/api/ai/model',{model:modelSelect.value});
   if(pid!==state.profileId||token!==state.secretToken)return;
   modelStatus.textContent=modelSelect.value?'モデルを保存しました。次回の「おすすめを更新」で使用します。':'モデルを無効にしました。AIによる検索テーマ生成は行いません。';
  }catch(e){modelStatus.textContent='設定エラー：'+e.message}
  finally{saveModelButton.disabled=false}
 },false);
 llmSection.append(field('使用するOllamaモデル',modelSelect),modelStatus,saveModelButton);root.append(llmSection);
 Promise.all([api('/api/ai/model'),api('/api/ai/models')]).then(([cfg,list])=>{
  if(pid!==state.profileId||token!==state.secretToken||!root.isConnected)return;
  for(const m of list.models||[])modelSelect.append(new Option(m,m));
  if(cfg.model&&!(list.models||[]).includes(cfg.model))modelSelect.append(new Option(cfg.model+'（現在利用不可）',cfg.model));
  modelSelect.value=cfg.model||'';
  if(list.error)modelStatus.textContent='Ollamaに接続できません：'+list.error+'（キーワード抽出は利用できます）';
  else modelStatus.textContent=(list.models||[]).length+' 件のローカルモデルを検出しました。';
 }).catch(e=>{modelStatus.textContent='Ollama確認エラー：'+e.message});
  const save=action('関心リストを保存',async()=>{
   save.disabled=true;message.hidden=true;area.readOnly=true;
   try{
    if(pid!==state.profileId||token!==state.secretToken)throw Error('プロファイルが切り替わりました');
    const result=await api('/api/ai/interests',{method:'POST',body:JSON.stringify({scope:'rss',text:area.value})});
    if(pid!==state.profileId||token!==state.secretToken||!root.isConnected)return;
    area.value=result.terms.join('\n');area.parentElement?._aiTopicRefreshScrollbar?.();
    interestsStatus.textContent='RSSの関心リスト '+result.terms.length+'件を保存しました。';
    if(state.aiKind==='rss')selectAiKind('rss').catch(err);
   }catch(e){message.textContent=e.message;message.hidden=false;interestsStatus.textContent='保存エラー';}
   finally{area.readOnly=false;save.disabled=false}
  });save.disabled=true;
  const interestsActions=elt('div','form-actions');interestsActions.append(save);interestsSection.append(interestsActions);
  root.append(elt('div','form-actions'));root.lastChild.append(action('閉じる',closeDialog,false));
  try{
   const data=await api('/api/ai/interests?scope=rss');
   if(pid===state.profileId&&token===state.secretToken&&state.settingsSlot==='ai'&&root.isConnected){
    area.value=data.terms.join('\n');area.parentElement?._aiTopicRefreshScrollbar?.();
    interestsStatus.textContent='RSSの関心リストを表示しています。';save.disabled=false;
   }
  }catch(e){message.textContent=e.message;message.hidden=false;interestsStatus.textContent='読み込みに失敗しました';save.disabled=true}

}

function settingsError(message){const msg=$('settings-error');if(msg){msg.textContent=message;msg.hidden=false;msg.scrollIntoView({block:'nearest'});}else notify('エラー: '+message)}
function settingsDialog(){state.feedIconsDraft=state.feedIcons;state.aiActionModeDraft=state.aiActionMode;state.settingsSlot='general';state.settingsSnapshot=clone(state.theme);state.placeholderSnapshot=clone(state.placeholders);renderSettings()}
function settingColor(title,target,key){
 const row=elt('div','color-field');row.style.flexWrap='wrap';
 const color=elt('input');color.type='color';color.value=target[key]||'#ffffff';color.setAttribute('aria-label',title+' カラー選択');
 const code=elt('input');code.type='text';code.maxLength=7;code.value=color.value.toUpperCase();code.setAttribute('aria-label',title+' 16進数');code.spellcheck=false;code.autocomplete='off';code.style.cssText='width:105px;max-width:100%;font:inherit;letter-spacing:.025em;';
 function applyHex(value){if(!/^#[0-9a-f]{6}$/i.test(value))return false;const hex=value.toUpperCase();target[key]=hex;color.value=hex;code.value=hex;code.removeAttribute('aria-invalid');applyTheme();updatePreview();return true}
 color.oninput=()=>applyHex(color.value);
 code.oninput=()=>{if(!applyHex(code.value))code.setAttribute('aria-invalid','true')};
 code.onblur=()=>{code.value=(target[key]||'#ffffff').toUpperCase();code.removeAttribute('aria-invalid')};
 row.append(color,code);return field(title,row)
}

// HEX-first color selection. Native <input type=color> popups choose RGB/HEX UI themselves.
// Keep the swatch and existing input handlers, but show our own HEX-first editor on click.
function installHexFirstColorPicker(){
 if(document.documentElement.dataset.nestrillHexPicker==='1')return;
 document.documentElement.dataset.nestrillHexPicker='1';
 const style=document.createElement('style');style.id='nestrill-hex-first-style';
 style.textContent=`
 .nestrill-hex-picker{position:fixed;z-index:2147483640;width:238px;box-sizing:border-box;background:#fff;color:#223148;border:1px solid #c9d4e4;border-radius:9px;padding:12px;box-shadow:0 6px 22px #101b2c35;font:12px/1.4 system-ui,sans-serif}
 .nestrill-hex-picker *{box-sizing:border-box}
 .nestrill-hex-picker label{font-weight:600;display:block;margin-bottom:5px}
 .nestrill-hex-picker input[type=text]{width:100%;padding:7px 8px;background:#fff;color:#223148;border:1px solid #b9c7d9;border-radius:5px;font:inherit;font-size:13px}
 .nestrill-hex-picker input[aria-invalid=true]{border-color:#b42318}
 .nestrill-hex-picker .nestrill-hex-plane{height:150px;position:relative;border:1px solid #cbd5e1;border-radius:5px;cursor:crosshair;touch-action:none;margin:9px 0;overflow:hidden}
 .nestrill-hex-picker .nestrill-hex-marker{position:absolute;width:12px;height:12px;transform:translate(-50%,-50%);border:2px solid #fff;box-shadow:0 0 1px 2px #172339;pointer-events:none;border-radius:50%}
 .nestrill-hex-picker input[type=range]{display:block;width:100%;height:16px;padding:0;margin:5px 0 0;accent-color:#2563eb}
 .nestrill-hex-picker .nestrill-hex-actions{display:flex;justify-content:flex-end;margin-top:8px}
 .nestrill-hex-picker .nestrill-hex-close{padding:3px 11px;border:1px solid #cbd5e1;border-radius:4px;color:#223148;background:#f4f7fb;font:inherit;cursor:pointer}
 `;
 document.head.append(style);
 let panel=null,swatch=null;
 const valid=x=>/^#[0-9a-f]{6}$/i.test(x);
 function rgbToHsv(r,g,b){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d){if(max===r)h=60*((g-b)/d%6);else if(max===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4)}return [(h+360)%360,max===0?0:d/max,max]}
 function hsvToHex(h,s,v){const c=v*s,x=c*(1-Math.abs(h/60%2-1)),m=v-c;let rgb;if(h<60)rgb=[c,x,0];else if(h<120)rgb=[x,c,0];else if(h<180)rgb=[0,c,x];else if(h<240)rgb=[0,x,c];else if(h<300)rgb=[x,0,c];else rgb=[c,0,x];return '#'+rgb.map(n=>Math.round((n+m)*255).toString(16).padStart(2,'0')).join('').toUpperCase()}
 function close(){if(panel){panel.remove();panel=null;swatch=null}}
 function open(target){
  close();swatch=target;
  let value=valid(target.value)?target.value.toUpperCase():'#FFFFFF';
  let [h,s,v]=rgbToHsv(...[1,3,5].map(i=>parseInt(value.slice(i,i+2),16)));
  const host=elt('div','nestrill-hex-picker');host.setAttribute('role','dialog');host.setAttribute('aria-label','16進数の色を選択');
  const title=elt('label','','色（HEX）');const code=elt('input');code.type='text';code.maxLength=7;code.value=value;code.setAttribute('aria-label','カラーコード（16進数）');code.spellcheck=false;
  const plane=elt('div','nestrill-hex-plane');plane.setAttribute('role','slider');plane.setAttribute('aria-label','彩度と明るさ');plane.tabIndex=0;
  const marker=elt('div','nestrill-hex-marker');plane.append(marker);
  const hueLabel=elt('label','','色相');const hue=elt('input');hue.type='range';hue.min=0;hue.max=359;hue.step=1;hue.value=String(Math.round(h));hue.setAttribute('aria-label','色相');
  hue.style.background='linear-gradient(to right,red,#ff0,lime,cyan,blue,magenta,red)';
  const actions=elt('div','nestrill-hex-actions');const done=elt('button','nestrill-hex-close','閉じる');done.type='button';done.onclick=close;actions.append(done);
  host.append(title,code,plane,hueLabel,hue,actions);document.body.append(host);panel=host;
  const rect=target.getBoundingClientRect();const W=host.offsetWidth||238,H=host.offsetHeight||320;
  host.style.left=Math.max(8,Math.min(window.innerWidth-W-8,rect.left))+'px';
  host.style.top=(rect.bottom+H+6<=window.innerHeight?rect.bottom+6:Math.max(8,rect.top-H-6))+'px';
  function paint(){plane.style.background=`linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${h},100%,50%))`;marker.style.left=(s*100)+'%';marker.style.top=((1-v)*100)+'%';hue.value=String(Math.round(h));code.value=hsvToHex(h,s,v);code.removeAttribute('aria-invalid');}
  function commit(hex){if(!valid(hex)||!swatch||!swatch.isConnected)return;swatch.value=hex;swatch.dispatchEvent(new Event('input',{bubbles:true}));}
  function putFromPlane(e){const r=plane.getBoundingClientRect();s=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));v=1-Math.max(0,Math.min(1,(e.clientY-r.top)/r.height));paint();commit(code.value)}
  plane.addEventListener('pointerdown',e=>{if(e.button!==0)return;plane.setPointerCapture(e.pointerId);putFromPlane(e)});
  plane.addEventListener('pointermove',e=>{if(e.buttons===1)putFromPlane(e)});
  plane.addEventListener('keydown',e=>{const step=e.shiftKey?.1:.02;if(e.key==='ArrowRight')s=Math.min(1,s+step);else if(e.key==='ArrowLeft')s=Math.max(0,s-step);else if(e.key==='ArrowUp')v=Math.min(1,v+step);else if(e.key==='ArrowDown')v=Math.max(0,v-step);else return;e.preventDefault();paint();commit(code.value)});
  hue.oninput=()=>{h=Number(hue.value);paint();commit(code.value)};
  code.oninput=()=>{if(valid(code.value)){const hex=code.value.toUpperCase();[h,s,v]=rgbToHsv(...[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)));paint();commit(hex)}else code.setAttribute('aria-invalid','true')};
  code.onblur=()=>{if(!valid(code.value))paint()};
  paint();code.focus();code.select();
 }
 function isColor(target){return target instanceof HTMLInputElement&&target.type==='color'&&target.closest('#dialog-overlay')}
 document.addEventListener('pointerdown',e=>{if(isColor(e.target))e.preventDefault();else if(panel&&!panel.contains(e.target))close()},true);
 document.addEventListener('click',e=>{if(isColor(e.target)){e.preventDefault();e.stopPropagation();open(e.target)}},true);
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&panel){e.preventDefault();e.stopPropagation();close()}else if(isColor(e.target)&&(e.key==='Enter'||e.key===' ')){e.preventDefault();open(e.target)}},true);
 document.addEventListener('scroll',e=>{if(panel&&!panel.contains(e.target))close()},true);
}
installHexFirstColorPicker();

function settingRange(title,target,key,min,max,step,unit){const input=elt('input');input.type='range';input.min=min;input.max=max;input.step=step;input.value=target[key]??min;const display=elt('output','',`${input.value}${unit}`);const row=elt('div','range-line');row.append(input,display);input.oninput=()=>{target[key]=Number(input.value);display.textContent=`${input.value}${unit}`;applyTheme();updatePreview()};return field(title,row)}
function settingSelect(title,target,key,options){const select=elt('select');for(const [label,value] of options){const opt=elt('option','',label);opt.value=value;select.append(opt)}select.value=target[key];select.onchange=()=>{target[key]=select.value;applyTheme();updatePreview()};return field(title,select)}
function settingToggle(title,target,key){const label=elt('label','checkbox-label');const box=elt('input');box.type='checkbox';box.checked=!!target[key];box.onchange=()=>{target[key]=box.checked;applyTheme();updatePreview()};label.append(box,elt('span','',title));return label}
function fontPicker(target,key='font'){
 const outer=elt('div','font-picker');
 const search=elt('input','font-search');search.type='search';search.placeholder='候補を検索（例：ゴシック）';search.setAttribute('aria-label','フォント候補を検索');
 const sel=elt('select','font-chooser');sel.setAttribute('aria-label','フォントを選択');
 const preview=elt('div','font-sample','あいうえお ABC 123 — Nestrill');
 const names=state.installedFonts||[];
 const original=String(target[key]||'');
 let chosen=original;
 function renderOptions(query=''){
  const q=query.trim().toLocaleLowerCase();const matches=names.filter(name=>name.toLocaleLowerCase().includes(q));
  sel.replaceChildren();
  if(chosen&&!names.includes(chosen)){
   const o=elt('option','',`現在の設定：${chosen}`);o.value=chosen;sel.append(o);
  }
  const limited=matches.slice(0,700);
  for(const name of limited){const o=elt('option','',name);o.value=name;sel.append(o)}
  if(chosen&&!Array.from(sel.options).some(o=>o.value===chosen)){
   const o=elt('option','',`選択中：${chosen}`);o.value=chosen;sel.insertBefore(o,sel.firstChild);
  }
  if(!sel.options.length){const o=elt('option','','候補なし');o.value='';sel.append(o)}
  sel.value=chosen;if(sel.selectedIndex<0&&sel.options.length)sel.selectedIndex=0;
 }
 search.oninput=()=>renderOptions(search.value);
 sel.onchange=()=>{if(!sel.value)return;chosen=sel.value;target[key]=chosen;preview.style.fontFamily=chosen;applyTheme()};
 preview.style.fontFamily=chosen;
 renderOptions();outer.append(search,sel,preview);
 if(!names.length)outer.append(elt('small','help','フォント候補を読み込めませんでした。ブラウザを再読み込みしてください。'));
 return outer;
}
// E4 Fix23: individual setting accordions preserve open/closed state between dialogs.
// Presentation-only keys; no profile preferences or recommendation data are modified.
const SETTINGS_ACCORDION_PREFIX='nestrill-settings-fold-v1:';
function persistentSettingsAccordion(key,label,initiallyOpen=false,cssClass='font-card'){
 const wrap=elt('details',cssClass);
 const saved=localStorage.getItem(SETTINGS_ACCORDION_PREFIX+key);
 wrap.open=saved===null?initiallyOpen:saved==='1';
 wrap.append(elt('summary','',label));
 wrap.addEventListener('toggle',()=>localStorage.setItem(SETTINGS_ACCORDION_PREFIX+key,wrap.open?'1':'0'));
 return wrap;
}
function settingFont(root,target,title){const wrap=persistentSettingsAccordion('article-font-'+({ 'サイト名':'source','記事タイトル':'title','リード文':'excerpt' }[title]||title),title,title==='記事タイトル');
 const grid=elt('div','settings-grid');
 grid.append(field('フォントを選択',fontPicker(target))); grid.append(settingSelect('フォントウェイト',target,'weight',[100,200,300,400,500,600,700,800,900].map(x=>[String(x),String(x)])));
 grid.append(settingRange('文字サイズ',target,'size',9,36,1,'px'));grid.append(settingColor('文字色',target,'color'));
 grid.append(settingColor('縁取り色',target,'strokeColor'));grid.append(settingRange('縁取り幅',target,'stroke',0,3,.2,'px'));
 const shadowGrid=elt('div','settings-grid');shadowGrid.append(settingColor('影の色',target,'shadowColor'),settingRange('影の濃さ',target,'shadowOpacity',0,100,1,'%'),settingRange('影の横位置',target,'shadowX',-20,20,1,'px'),settingRange('影の縦位置',target,'shadowY',-20,20,1,'px'),settingRange('影のぼかし',target,'shadowBlur',0,20,1,'px'));wrap.append(grid,settingToggle('文字に影を付ける',target,'shadow'),shadowGrid);root.append(wrap);
}
// Fix98A: RSS hide rules belong to ordinary article display, not AI configuration.
function renderRssHideRulesSettings(root){
 const pid=state.profileId,token=state.secretToken;
 // Fix91A: RSS list + AI hidden-article rules (each rule: domain AND title; multiple OR).
 const hideSection=persistentSettingsAccordion('rss-hide-rules-section','RSS記事の非表示ルール',false,'ai-managed-details ai-exclusions-section');
 hideSection.append(elt('p','help','通常のRSS一覧とAIセレクトの両方に適用します。記事や既読・お気に入りは削除されません。ドメインを空欄にすると全RSSサイトが対象です。追加・削除はその場で保存され、下の「設定を保存」や「キャンセル」では取り消されません。'));
 const hideDomain=elt('input');hideDomain.placeholder='example.com（空欄＝全サイト）';hideDomain.maxLength=253;
 const hideMode=elt('select');[['contains','タイトルに含む'],['exact','タイトルと完全一致'],['all','このドメインの全記事']].forEach(([v,t])=>hideMode.append(new Option(t,v)));
 const hideTitle=elt('input');hideTitle.placeholder='非表示にしたい語句・タイトル';hideTitle.maxLength=120;
 hideMode.addEventListener('change',()=>{hideTitle.disabled=hideMode.value==='all';if(hideTitle.disabled)hideTitle.value=''});
 const hideStatus=elt('p','help','非表示ルールを読み込み中…');hideStatus.setAttribute('role','status');
 const hideList=elt('div','rss-hide-rules-list');
 const hideAlive=()=>pid===state.profileId&&token===state.secretToken&&state.settingsSlot==='articles'&&hideSection.isConnected;
 function paintHideRules(rules){
  hideList.replaceChildren();if(!rules.length){hideList.append(elt('p','help','登録されたルールはありません。'));return}
  for(const r of rules){
   const line=elt('div','rss-hide-rule-row');
   const label=(r.domain||'すべてのRSSサイト')+' ／ '+(r.titleMode==='all'?'全記事':r.titleMode==='exact'?'完全一致：「'+r.titleText+'」':'含む：「'+r.titleText+'」');
   const desc=elt('span','',label);desc.title=label;
   const remove=action('削除',async()=>{
    if(!hideAlive()||!confirm('この非表示ルールを解除しますか？\n'+label))return;
    remove.disabled=true;
    try{
     const data=await api('/api/rss/hide-rules',{method:'DELETE',body:JSON.stringify({id:r.id})});
     if(!hideAlive())return;
     paintHideRules(data.rules);hideStatus.textContent='解除しました。RSS記事を再表示すると反映されます。';
     await loadOverview();if(!state.sourceKind&&!state.aiKind)await loadArticles(false);
     if(state.aiKind==='rss')selectAiKind('rss').catch(err);
    }catch(e){if(hideAlive())hideStatus.textContent='解除に失敗しました：'+e.message}
    finally{remove.disabled=false}
   },false);line.append(desc,remove);hideList.append(line);
  }
 }
 const addHide=action('非表示ルールを追加',async()=>{
  if(!hideAlive())return;
  addHide.disabled=true;
  try{
   const data=await post('/api/rss/hide-rules',{domain:hideDomain.value.trim(),titleMode:hideMode.value,titleText:hideMode.value==='all'?'':hideTitle.value});
   if(!hideAlive())return;
   paintHideRules(data.rules);hideTitle.value='';hideStatus.textContent='保存しました。記事一覧とAIセレクトの表示に反映されます。';
   await loadOverview();if(!state.sourceKind&&!state.aiKind)await loadArticles(false);
   if(state.aiKind==='rss')selectAiKind('rss').catch(err);
  }catch(e){if(hideAlive())hideStatus.textContent='保存に失敗しました：'+e.message}
  finally{addHide.disabled=false}
 },false);
 const hideInputs=elt('div','rss-hide-inputs');hideInputs.append(field('対象ドメイン（任意）',hideDomain),field('タイトル条件',hideMode),field('語句・タイトル',hideTitle),addHide);
 hideSection.append(hideInputs,hideStatus,hideList);root.append(hideSection);
 api('/api/rss/hide-rules').then(data=>{if(hideAlive()){paintHideRules(data.rules);hideStatus.textContent='登録済み：'+data.rules.length+'件';}}).catch(e=>{if(hideAlive())hideStatus.textContent='読み込みエラー：'+e.message});

}

function renderArticleSettings(root){
 renderRssHideRulesSettings(root);
 const theme=state.theme;root.append(elt('p','help','サイト名・記事タイトル・リード文の文字設定を個別に調整できます。インストール済みフォントを選択してください。候補の検索もできます。'));
 if(state.aiActionModeDraft===null)state.aiActionModeDraft=state.aiActionMode;
 const actionMode=elt('select');
 for(const [label,value] of [['文字で表示（初期値）','text'],['アイコンのみ','icons']]){const opt=elt('option','',label);opt.value=value;actionMode.append(opt)}
 actionMode.value=state.aiActionModeDraft;actionMode.setAttribute('aria-label','AI記事の操作ボタン表示');
 actionMode.onchange=()=>{state.aiActionModeDraft=actionMode.value};
 const actionSetting=elt('section','header-settings');
 actionSetting.append(elt('h3','','AI記事の操作ボタン'),field('興味・感想・出典／除外設定の表示',actionMode),elt('p','help','「アイコンのみ」ではボタンにポインターを合わせると機能名を表示します。Tabキーで選択した際にも確認できます。AIセレクトの候補に適用され、評価・記事データは変更しません。'));
 root.append(actionSetting);

 for(const [k,label] of [['source','サイト名'],['title','記事タイトル'],['excerpt','リード文']])settingFont(root,theme.articleStyle[k],label);
 const zebra=persistentSettingsAccordion('article-zebra','記事の交互背景色（ゼブラ表示）',true);zebra.append(settingToggle('奇数行・偶数行の背景色を分ける',theme.stripe,'enabled'));
 const stripes=elt('div','settings-grid');for(const [label,key] of [['奇数行の色','oddColor'],['偶数行の色','evenColor'],['ホバー色','hoverColor']])stripes.append(settingColor(label,theme.stripe,key));for(const [label,key] of [['奇数行の不透明度','oddOpacity'],['偶数行の不透明度','evenOpacity'],['ホバー色の不透明度','hoverOpacity']])stripes.append(settingRange(label,theme.stripe,key,0,100,5,'%'));zebra.append(stripes);root.append(zebra);
 root.append(elt('hr'),elt('h3','','記事の区切り罫線'));
 for(const [mode,label] of [['list','一覧表示'],['magazine','マガジン表示']]){const d=theme.separators[mode],block=persistentSettingsAccordion('article-separator-'+mode,label,mode==='list');block.append(settingToggle('区切り罫線を表示する',d,'enabled'));const grid=elt('div','settings-grid');grid.append(settingColor('線の色',d,'color'),settingRange('不透明度',d,'opacity',0,100,5,'%'),settingRange('太さ',d,'width',1,5,1,'px'),settingSelect('線種',d,'style',[['実線','solid'],['破線','dashed'],['点線','dotted'],['二重線','double']]),settingRange('左右の余白',d,'inset',0,60,2,'px'),settingRange('上下の余白',d,'spacing',0,24,1,'px'));block.append(grid);root.append(block)}
 root.append(elt('div','help','画面上の変更は即時反映されます。設定を保存するまでは確定しません。'));
 const message=elt('div','settings-error');message.id='settings-error';message.hidden=true;message.setAttribute('role','alert');root.append(message);const actions=elt('div','form-actions');actions.append(action('キャンセル',closeDialog,false),action('設定を保存',saveSettings));root.append(actions);
}
// Fix99A: PC-controlled, independent static/solid mobile background.
async function renderMobileBackgroundSettings(root){
 const note=elt('p','help','スマホ版の背景はPC版と独立しています。標準は単色で背景画像の通信は発生しません。画像は1枚だけ、PCで縮小・WebP変換して保存します。');
 root.append(note);
 const loading=elt('p','help','スマホの背景設定を読み込んでいます…');root.append(loading);
 let saved;
 try{saved=await api('/api/mobile-background')}catch(e){loading.textContent='設定を読み込めませんでした: '+e.message;return}
 if(!root.isConnected||state.settingsSlot!=='mobile')return;
 loading.remove();
 let savedPalette;
 try{savedPalette=await api('/api/mobile-palette')}catch(e){root.append(elt('p','help','スマホ配色設定を読み込めませんでした: '+e.message));return}
 if(!root.isConnected||state.settingsSlot!=='mobile')return;
 const palette={mode:savedPalette.mode,titleSize:savedPalette.titleSize,colors:{...savedPalette.colors}};
 const draft={mode:saved.mode,color:saved.color,image:saved.image};
 const type=settingSelect('背景タイプ',draft,'mode',[['単色（通信なし）','color'],['静止画像（1枚）','image']]);
 const bgColorInput=elt('input');bgColorInput.type='color';bgColorInput.value=draft.color;
 const bgCode=elt('input');bgCode.type='text';bgCode.value=draft.color.toUpperCase();bgCode.maxLength=7;
 bgCode.setAttribute('aria-label','背景色（16進数）');bgCode.style.cssText='width:108px;font:inherit;letter-spacing:.025em;';
 const bgRow=elt('div','color-field');bgRow.append(bgColorInput,bgCode);
 bgColorInput.oninput=()=>{draft.color=bgColorInput.value.toUpperCase();bgCode.value=draft.color;paintPalette();markMobileUnsaved()};
 bgCode.oninput=()=>{if(/^#[0-9a-f]{6}$/i.test(bgCode.value)){draft.color=bgCode.value.toUpperCase();bgColorInput.value=draft.color;bgCode.removeAttribute('aria-invalid');paintPalette();markMobileUnsaved()}else bgCode.setAttribute('aria-invalid','true')};
 bgCode.onblur=()=>{bgCode.value=draft.color;bgCode.removeAttribute('aria-invalid')};
 const color=field('背景色',bgRow);
 const imageRow=elt('div');
 const fileInput=elt('input');fileInput.type='file';fileInput.accept='.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
 const info=elt('p','help',draft.image?'選択済み：軽量化されたWebP画像があります。':'静止画像が未選択です。');
 const status=elt('p','help');status.setAttribute('role','status');
 function markMobileUnsaved(){status.textContent='未保存の変更があります。［スマホ表示を保存］で確定してください。'}
 imageRow.append(field('スマホに配信する画像を選択',fileInput,'画像は1024px以下・最大約500KBに変換します。アップロードした画像はPC内にのみ保存されます。'),info);
 function updateForm(){imageRow.hidden=draft.mode!=='image'}
 type.querySelector('select').addEventListener('change',()=>{updateForm();markMobileUnsaved()});
 fileInput.addEventListener('change',async()=>{
  const file=fileInput.files?.[0];if(!file)return;
  if(file.size>20_000_000){status.textContent='元画像は20MB以内にしてください';return}
  status.textContent='画像を縮小・圧縮しています…';fileInput.disabled=true;
  let bmp;
  try{
   bmp=await createImageBitmap(file);
   if(!bmp.width||!bmp.height||bmp.width>12000||bmp.height>12000)throw Error('画像の大きさを確認してください');
   let blob=null;
   for(const [max,quality] of [[1024,.75],[900,.68],[720,.60],[600,.50]]){
    const scale=Math.min(1,max/Math.max(bmp.width,bmp.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bmp.width*scale));canvas.height=Math.max(1,Math.round(bmp.height*scale));
    canvas.getContext('2d').drawImage(bmp,0,0,canvas.width,canvas.height);
    blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',quality));
    if(blob&&blob.type==='image/webp'&&blob.size<=480000)break;
   }
   if(!blob||blob.type!=='image/webp'||blob.size>480000)throw Error('500KB以内に圧縮できませんでした。別の画像を選んでください');
   const result=await api('/api/mobile-background/image',{method:'POST',body:blob,headers:{'Content-Type':'image/webp'}});
   draft.image=result.image;draft.mode='image';type.querySelector('select').value='image';updateForm();
   info.textContent=`画像を準備しました（${file.name} → WebP ${Math.round(result.size/1024)}KB）。右下の［スマホ背景を保存］で確定します。`;
   markMobileUnsaved();
  }catch(e){status.textContent='画像を読み込めませんでした: '+e.message}
  finally{bmp?.close();fileInput.disabled=false}
 });
 root.append(type,color,imageRow,elt('p','help','動画・APNG・ランダム切り替えは使用しません。スマホの画像は認証済み端末のブラウザ内に保持し、設定変更時・ログアウト後の再接続時に新しい画像を取得します。'));
 updateForm();
 // Fix100B: clear mode semantics; hex RGBA + opacity and live preview.
 const HEX6=/^#[0-9A-F]{6}$/i,HEX8=/^#[0-9A-F]{8}$/i;
 const asHex8=v=>HEX8.test(v||'')?v.toUpperCase():HEX6.test(v||'')?(v.toUpperCase()+'FF'):'#FFFFFFFF';
 const opacityOf=v=>Math.round(parseInt(asHex8(v).slice(7,9),16)*100/255);
 const alphaHex=p=>Math.round(Math.max(0,Math.min(100,p))*255/100).toString(16).padStart(2,'0').toUpperCase();
 const setOpacity=(v,p)=>asHex8(v).slice(0,7)+alphaHex(p);
 for(const key of Object.keys(palette.colors))palette.colors[key]=asHex8(palette.colors[key]);
 const lightColors={header:'#FFFFFFFF',card:'#FFFFFFFF',text:'#172339FF',muted:'#61738CFF',accent:'#2563EBFF',control:'#EDF2FAFF',border:'#DCE5EFFF'};
 const darkColors={header:'#182436FF',card:'#182436FF',text:'#E9EFF8FF',muted:'#9AABC2FF',accent:'#7BA8FFFF',control:'#29384CFF',border:'#34435AFF'};
 const paletteSection=elt('section','header-settings');
 paletteSection.append(elt('h3','','スマホ専用の配色・文字'),elt('p','help','PC版とは独立した設定です。色は #RRGGBBAA（末尾AAが不透明度）の16進数で編集できます。各色の不透明度スライダーからも調整できます。'));
 const paletteSelect=elt('select');
 for(const [label,value] of [['端末に合わせる（従来の動作）','system'],['ライト（明るい配色）','light'],['ダーク（濃い配色）','dark'],['カスタム（各色を指定）','custom']])paletteSelect.append(new Option(label,value));
 paletteSelect.value=palette.mode;
 const paletteColors=elt('div','settings-grid');
 const mobilePaletteLabels=[['ヘッダー背景','header'],['記事カード背景','card'],['記事タイトル・本文の文字色','text'],['サイト名・日時など補助文字色','muted'],['選択・アクセント色','accent'],['操作欄・ボタン背景','control'],['罫線・カード枠の色','border']];
 const modeNote=elt('p','help');
 const palettePreview=elt('div');palettePreview.style.cssText='border:1px solid #cbd5e1;border-radius:12px;overflow:hidden;margin:10px 0 8px;';
 const previewTop=elt('div');previewTop.style.cssText='padding:12px 14px;font-weight:700;display:flex;justify-content:space-between;align-items:center;';
 const previewBrand=elt('span','','◇ Nestrill Mobile');const previewExit=elt('span','','接続解除');previewExit.style.fontSize='11px';previewTop.append(previewBrand,previewExit);
 const previewContent=elt('div');previewContent.style.cssText='padding:12px 13px 15px;';
 const previewStatus=elt('div','','Main　｜　10928 未読・10944 記事');previewStatus.style.cssText='font-size:11px;display:flex;justify-content:space-between;padding:5px;';
 const previewTabs=elt('div');previewTabs.style.cssText='border-radius:8px;padding:5px;display:flex;gap:5px;margin:7px 0;';
 const previewTabOn=elt('div','','RSS記事');const previewTabOff=elt('div','','AIセレクト');
 for(const el of [previewTabOn,previewTabOff])el.style.cssText='flex:1;padding:7px 4px;border-radius:6px;text-align:center;font-size:12px;font-weight:650;';
 previewTabs.append(previewTabOn,previewTabOff);
 const previewControls=elt('div');previewControls.style.cssText='padding:8px;border-radius:7px;font-size:12px;margin:7px 0;';previewControls.textContent='すべてのカテゴリ　⌄　　検索';
 const previewCard=elt('div');previewCard.style.cssText='padding:12px 14px;margin-top:8px;border-radius:9px;border:1px solid;';
 const previewMeta=elt('div','','サイト名　11/9 00:56　　✓　☆');previewMeta.style.fontSize='11px';
 const previewTitle=elt('div','','スマホ記事タイトルの表示例');previewTitle.style.cssText='font-weight:700;margin:5px 0;';
 const previewChip=elt('span','','未読　お気に入り');previewChip.style.cssText='display:inline-block;border-radius:6px;padding:4px 8px;margin-top:5px;font-size:11px;';
 previewCard.append(previewMeta,previewTitle,previewChip);
 previewContent.append(previewStatus,previewTabs,previewControls,previewCard);palettePreview.append(previewTop,previewContent);
 const systemSimWrap=elt('div');const systemSimSelect=elt('select');
 for(const [label,value] of [['端末をダークモードと想定','dark'],['端末をライトモードと想定','light']])systemSimSelect.append(new Option(label,value));
 systemSimSelect.value='dark';systemSimWrap.append(field('「端末に合わせる」場合のプレビュー条件',systemSimSelect,'PCからスマホ本体の配色設定は取得できません。ここで想定モードを切り替えられます。'));
 function resolvedColors(){return palette.mode==='custom'?palette.colors:palette.mode==='dark'?darkColors:palette.mode==='light'?lightColors:systemSimSelect.value==='dark'?darkColors:lightColors}
 const colorInputs={};
 function syncInputs(){for(const [key,controls] of Object.entries(colorInputs)){
  const value=asHex8(resolvedColors()[key]);
  if(document.activeElement!==controls.hex)controls.hex.value=value;
  controls.picker.value=value.slice(0,7);
  controls.range.value=String(opacityOf(value));controls.percent.textContent=opacityOf(value)+'%';
 }}
 function paintPalette(){
  systemSimWrap.hidden=palette.mode!=='system';systemSimWrap.style.display=palette.mode==='system'?'':'none';
  modeNote.textContent=palette.mode==='system'?'端末連動中：個別色はスマホへ適用されません。色を編集すると「カスタム」へ自動切替します。':palette.mode==='custom'?'カスタム色が適用されます。変更はプレビューに即時反映し、スマホには保存後の再読み込みで反映されます。':'プリセット配色が適用されます。個別色を編集すると「カスタム」へ自動切替します。';
  const c=resolvedColors();
  // The phone wallpaper itself may be an image; simulate the solid color underneath only.
  palettePreview.style.background=draft.color;
  previewTop.style.background=c.header;previewBrand.style.color=c.text;previewExit.style.color=c.muted;
  previewStatus.style.color=c.muted;
  previewTabs.style.background=c.control;previewTabOn.style.background=c.card;previewTabOn.style.color=c.accent;previewTabOff.style.color=c.muted;
  previewControls.style.background=c.control;previewControls.style.border='1px solid '+c.border;previewControls.style.color=c.text;
  previewCard.style.background=c.card;previewCard.style.borderColor=c.border;
  previewMeta.style.color=c.muted;previewTitle.style.color=c.text;previewTitle.style.fontSize=palette.titleSize+'px';
  previewChip.style.background=c.control;previewChip.style.color=c.accent;
  paletteSelect.value=palette.mode;syncInputs();
 }
 function editColor(key,newHex){
  const v=asHex8(newHex);
  if(palette.mode!=='custom'){
   const c=resolvedColors();palette.colors=Object.fromEntries(Object.entries(c).map(([k,value])=>[k,asHex8(value)]));
   palette.mode='custom';
  }
  palette.colors[key]=v;syncInputs();paintPalette();markMobileUnsaved();
 }
 for(const [label,key] of mobilePaletteLabels){
  const picker=elt('input');picker.type='color';picker.value=palette.colors[key].slice(0,7);picker.setAttribute('aria-label',label+' カラーピッカー');
  const hex=elt('input');hex.type='text';hex.maxLength=9;hex.value=palette.colors[key];hex.setAttribute('aria-label',label+' 16進数');hex.style.cssText='width:116px;max-width:100%;font:inherit;letter-spacing:.025em;';
  const range=elt('input');range.type='range';range.min='0';range.max='100';range.step='1';range.value=String(opacityOf(palette.colors[key]));range.setAttribute('aria-label',label+' 不透明度');
  const percent=elt('output','',range.value+'%');percent.style.cssText='min-width:40px;text-align:right;font-variant-numeric:tabular-nums;';
  colorInputs[key]={picker,hex,range,percent};
  const row=elt('div','color-field');row.style.flexWrap='wrap';row.append(picker,hex);
  const alphaRow=elt('div','range-line');alphaRow.append(range,percent);
  const container=elt('div');container.append(row,elt('div','help','不透明度（100% = 透過なし）'),alphaRow);paletteColors.append(field(label,container));
  picker.oninput=()=>editColor(key,picker.value.toUpperCase()+asHex8(resolvedColors()[key]).slice(7));
  hex.oninput=()=>{const v=hex.value.trim().toUpperCase();if(HEX6.test(v)||HEX8.test(v)){
   editColor(key,v);hex.removeAttribute('aria-invalid');
  }else hex.setAttribute('aria-invalid','true')};
  hex.onblur=()=>{hex.value=asHex8(resolvedColors()[key]);hex.removeAttribute('aria-invalid')};
  range.oninput=()=>editColor(key,setOpacity(resolvedColors()[key],Number(range.value)));
 }
 paletteSelect.onchange=()=>{palette.mode=paletteSelect.value;paintPalette();markMobileUnsaved()};
 systemSimSelect.onchange=paintPalette;
 const titleSize=elt('select');for(const px of [14,15,16,17,18,19])titleSize.append(new Option(px+'px'+(px===15?'（標準）':''),String(px)));
 titleSize.value=String(palette.titleSize);titleSize.onchange=()=>{palette.titleSize=Number(titleSize.value);paintPalette();markMobileUnsaved()};
 paletteSection.append(field('配色モード',paletteSelect),field('記事タイトルの文字サイズ',titleSize),modeNote,paletteColors,systemSimWrap,elt('h3','','保存前のスマホ表示プレビュー'),palettePreview,
  elt('p','help','プレビューの色・文字サイズはすぐ変わります。スマホ画面は「スマホ表示を保存」後に再読み込みしてください。画像背景の実物はプレビューに表示されません。'));
 root.append(paletteSection);syncInputs();paintPalette();
 const actions=elt('div','form-actions');
 const save=action('スマホ表示を保存',async()=>{
  status.textContent='';save.disabled=true;
  try{
   if(draft.mode==='image'&&!draft.image)throw Error('静止画像を選択してください');
   const result=await post('/api/mobile-background',draft);
   saved=result;
   try{await post('/api/mobile-palette',palette)}catch(e){throw Error('背景は保存されましたが、配色設定の保存に失敗しました: '+e.message)}
   status.textContent='スマホの背景と配色を保存しました。スマホ版を再読み込みすると反映されます。';
  }catch(e){status.textContent='保存できませんでした: '+e.message}
  finally{save.disabled=false}
 });
 actions.append(action('閉じる',closeDialog,false),save);
 root.append(status,actions);
}

// RC01-R9: computer-wide Windows autostart; applied immediately, outside appearance Save/Cancel.
async function renderGeneralSettings(root){
 const section=elt('section','header-settings');
 section.append(elt('h3','','起動と動作'));
 const label=elt('label','checkbox-label');
 const checkbox=elt('input');checkbox.type='checkbox';checkbox.disabled=true;
 label.append(checkbox,elt('span','','Windowsサインイン時にNestrillを自動起動する'));
 const detail=elt('p','help','ONにすると、次回以降のWindowsサインイン時にサーバーだけ起動します。ブラウザは自動で開きません。初期状態はOFFです。');
 const status=elt('p','help','Windowsの設定を確認しています…');status.setAttribute('role','status');
 const note=elt('p','help','この項目は変更時にすぐWindowsへ反映されます。外観設定の「保存」「キャンセル」とは独立しています。');
 section.append(label,detail,status,note);
 root.append(section);
 const actions=elt('div','form-actions');actions.append(action('閉じる',closeDialog,false));root.append(actions);
 const current=()=>state.settingsSlot==='general'&&root.isConnected;
 function present(data){
  if(!current())return;
  checkbox.checked=!!data.enabled;
  checkbox.disabled=!data.supported||!!data.conflict;
  if(!data.supported)status.textContent='この機能はWindows PC専用です。';
  else if(data.conflict)status.textContent='別のNestrillフォルダが自動起動を登録しています。旧フォルダ側で解除してから設定してください（ここでは変更しません）。';
  else status.textContent=data.enabled?'現在の設定：ON':'現在の設定：OFF';
 }
 try{present(await api('/api/_local/autostart'))}
 catch(e){if(current()){checkbox.disabled=true;status.textContent='状態を確認できませんでした: '+e.message}}
 checkbox.onchange=async()=>{
  const desired=checkbox.checked;
  checkbox.disabled=true;status.textContent='Windowsの設定を変更しています…';
  try{
   const result=await post('/api/_local/autostart',{enabled:desired});
   present(result);
  }catch(e){
   if(!current())return;
   checkbox.checked=!desired;
   status.textContent='変更できませんでした: '+e.message;
   try{const actual=await api('/api/_local/autostart');if(current()){checkbox.checked=!!actual.enabled;checkbox.disabled=!actual.supported||!!actual.conflict;}}
   catch{checkbox.disabled=true}
  }
 };
}
function renderSettings(){const root=elt('div');const tabs=elt('div','settings-tabs');for(const [key,label] of [['general','一般'],['left','左ペイン'],['right','右ペイン'],['shared','共通背景'],['mobile','スマホ表示'],['articles','記事表示'],['thumbs','サムネイル'],['motion','画面遷移'],['ai','AIセレクト'],['about','About']]){const button=elt('button',key===state.settingsSlot?'active':'',label);button.onclick=()=>{state.settingsSlot=key;renderSettings()};tabs.append(button)}root.append(tabs);
 if(state.settingsSlot==='general'){openDialog('設定 → 一般',root);renderGeneralSettings(root);return}
 if(state.settingsSlot==='ai'){openDialog('設定 → AIセレクト',root);renderAiInterestSettings(root);return}
 if(state.settingsSlot==='mobile'){openDialog('設定 → スマホ表示',root);renderMobileBackgroundSettings(root);return}
 if(state.settingsSlot==='about'){renderNestrillAbout(root);openDialog('設定 → About',root);return}
 if(state.settingsSlot==='thumbs'){renderThumbnailSettings(root);openDialog('外観をカスタマイズ',root);return}
 if(state.settingsSlot==='articles'){renderArticleSettings(root);openDialog('設定 → 記事表示',root);return}
 if(state.settingsSlot==='motion'){window.__uxCleanRenderSettings(root);openDialog('外観をカスタマイズ',root);return}
 const slot=state.settingsSlot,b=state.theme[slot];
 if(slot==='left'){
  const section=elt('section','header-settings');
  section.append(elt('h3','','RSSフィード一覧'));
  const label=elt('label','checkbox-label'),checkbox=elt('input');checkbox.type='checkbox';
  checkbox.checked=state.feedIconsDraft!==false;
  checkbox.onchange=()=>{state.feedIconsDraft=checkbox.checked};
  label.append(checkbox,elt('span','','各RSSのファビコンを表示'));
  section.append(label,elt('p','help','取得できない場合はNestrillの鳥アイコンを表示します。'));
  root.append(section);
 }
 if(slot==='shared'){
  const linkedToggle=settingToggle('共通背景を左右ペインに連動適用（背景色は一度だけ重ねる）',state.theme,'sharedLinked');linkedToggle.querySelector('input').addEventListener('change',renderSettings);root.append(linkedToggle);
  root.append(elt('p','help',state.theme.sharedLinked?'共通背景が単色・画像・動画・フォルダのいずれの場合も、左右ペインには一枚の共通背景を適用します。個別設定は保持し、連動OFFで復帰します。':'左右ペインの背景を独立して表示します。'));
  // Header appearance is independent from the shared wallpaper opacity/tint.
  const head=state.theme.header;
  const headerGroup=elt('section','header-settings');
  headerGroup.append(elt('h3','','上部ヘッダーの背景'));
  headerGroup.append(settingToggle('共通背景をヘッダーまで広げる',head,'extend'));
  headerGroup.append(elt('p','help','ONでは共通背景の動画・画像が最上部まで一続きで表示され、ヘッダーの色をその上に一度だけ重ねます。OFFでは従来の白いヘッダーに戻ります。'));
  const options=elt('div','settings-grid');
  options.append(settingColor('ヘッダー背景色',head,'color'),settingRange('背景色の不透明度',head,'opacity',0,100,1,'%'));
  options.append(settingRange('すりガラスのぼかし',head,'blur',0,40,1,'px'),settingColor('ヘッダー文字色',head,'textColor'));
  options.append(settingColor('下部罫線の色',head,'borderColor'),settingRange('罫線の不透明度',head,'borderOpacity',0,100,1,'%'));
  headerGroup.append(options,settingToggle('ヘッダー下部の罫線を表示',head,'borderEnabled'));
  root.append(headerGroup);
 }else if(linkedSharedActive(state.theme)){
  root.append(elt('p','linked-background-note','共通背景の連動がONです。このペインの背景は一時的に非表示ですが、ここでの設定は保存され、連動OFFで復帰します。'));
 }
 const backgroundType=settingSelect('背景タイプ',b,'type',[['単色','color'],['画像・APNG・GIF','image'],['動画（無音）','video'],['フォルダからランダム','folder']]);backgroundType.querySelector('select').addEventListener('change',renderSettings);root.append(backgroundType);
 const colorOpacityField=settingRange('背景色の不透明度',b,'colorOpacity',0,100,1,'%');
 colorOpacityField.append(elt('div','help','※ 背景画像・動画を使用している場合、背景色の不透明度を100%にすると、背景色に覆われて画像・動画が見えなくなります。'));
 const grid=elt('div','settings-grid');
 if(slot==='shared')grid.append(settingColor('ベース背景色（最下層）',state.theme,'baseColor'));
 grid.append(settingColor('背景色',b,'color'));
 if(slot==='shared')grid.append(settingRange('背景メディアの不透明度',b,'imageOpacity',0,100,1,'%'),colorOpacityField);
 else grid.append(colorOpacityField,settingRange('背景メディアの不透明度',b,'imageOpacity',0,100,1,'%'));
 grid.append(settingRange('背景ブラー',b,'blur',0,40,1,'px'),settingSelect('表示位置',b,'position',[['中央','center'],['上','top'],['下','bottom'],['左','left'],['右','right']]));root.append(grid);
 if(slot==='shared')root.append(elt('p','help','ベース背景色は全体の最下層です。上の背景色が透明な場合に見え、画像・動画がある場合はその背後に表示されます。'));
 if(b.type==='image'||b.type==='video'){
  const picker=elt('input');picker.type='file';picker.accept=b.type==='image'?'.png,.apng,.jpg,.jpeg,.webp,.gif':'video/mp4,video/webm,.mp4,.webm';
  picker.onchange=async()=>{const file=picker.files?.[0];if(!file)return;const max=b.type==='video'?256_000_000:20_000_000;if(file.size>max)return notify(`ファイルは${b.type==='video'?'256':'20'}MB以内を選んでください`);
   const ext=file.name.split('.').pop().toLowerCase();const type=file.type||{apng:'image/apng',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',mp4:'video/mp4',webm:'video/webm'}[ext];
   try{const response=await api('/api/background/'+slot,{method:'POST',body:file,headers:{'Content-Type':type}});b.image=response.image;applyTheme();updatePreview();notify('画像・動画を読み込みました。［設定を保存］で確定します。')}catch(e){err(e)}
  };
  root.append(field('背景ファイルを選択',picker,`現在: ${b.image?b.image.split('?')[0].split('/').pop():'なし'}`));
  root.append(action('この背景ファイルを解除',()=>{b.image='';applyTheme();renderSettings()},false));
 }
 if(b.type==='folder'||b.type==='video'){
  function folderField(title,key,help,placeholder){
   const pathInput=elt('input');pathInput.type='text';pathInput.value=b[key]||'';pathInput.placeholder=placeholder;
   pathInput.oninput=()=>{b[key]=pathInput.value.trim()};
   pathInput.onchange=()=>applyTheme();
   const browse=action('参照…',async()=>{
    browse.disabled=true;
    const previous=browse.textContent;browse.textContent='選択中…';
    try{
     const data=await post('/api/pick-folder',{initialDirectory:pathInput.value.trim()});
     if(!data.cancelled&&data.path){pathInput.value=data.path;b[key]=data.path;applyTheme()}
    }catch(e){settingsError('フォルダの選択に失敗しました: '+e.message)}
    finally{browse.disabled=false;browse.textContent=previous}
   },false);
   browse.classList.add('folder-browse-button');
   const line=elt('div','folder-input-row');line.append(pathInput,browse);
   return field(title,line,help);
  }
  root.append(folderField('PC側の背景フォルダ', 'folder', '「参照…」でWindowsのフォルダを選べます。手入力・貼り付けも可能です。','参照…からフォルダを選択'));
  if(b.type==='folder')root.append(settingSelect('ランダム対象',b,'folderKind',[['画像と動画','all'],['画像のみ','images'],['動画のみ','videos']]));
 }
 if(b.type==='folder'||b.type==='image'||b.type==='video')root.append(settingRange('静止画像の切替間隔',b,'interval',5,3600,5,'秒'));
 if(b.type==='video'||b.type==='folder')root.append(settingRange('動画再生速度',b,'speed',.25,2,.05,'倍'),settingToggle('単独動画をループ再生',b,'loop'));
 root.append(elt('p','help','PC版の動画は常時ミュートです。スマホ専用閲覧版の背景は［スマホ表示］タブで別に設定します。'));
 if(slot!=='shared'){
  root.append(elt('hr'),elt('h3','','ペインの基本文字設定'));
  const t=state.theme.text[slot],tg=elt('div','settings-grid');tg.append(field('フォントを選択',fontPicker(t)),settingColor('文字色',t,'color'),settingRange('文字サイズ',t,'size',11,24,1,'px'),settingColor('縁取り色',t,'strokeColor'),settingRange('縁取り幅',t,'stroke',0,3,.2,'px'));const shadowGrid=elt('div','settings-grid');shadowGrid.append(settingColor('影の色',t,'shadowColor'),settingRange('影の濃さ',t,'shadowOpacity',0,100,1,'%'),settingRange('影の横位置',t,'shadowX',-20,20,1,'px'),settingRange('影の縦位置',t,'shadowY',-20,20,1,'px'),settingRange('影のぼかし',t,'shadowBlur',0,20,1,'px'));root.append(tg,settingToggle('文字に影をつける',t,'shadow'),shadowGrid);
 }
 const message=elt('div','settings-error');message.id='settings-error';message.hidden=true;message.setAttribute('role','alert');root.append(message);const actions=elt('div','form-actions');actions.append(action('キャンセル',closeDialog,false),action('設定を保存',saveSettings));root.append(actions);
 openDialog('外観をカスタマイズ',root);
}
function updatePreview(){}
function renderThumbnailSettings(root){
 root.append(elt('p','help','画像のない記事は、サイトのfaviconを試します。faviconもない場合と、記事画像の読込失敗時では異なる代替画像を使えます。'));
 for(const [kind,label,help] of [['missing','画像なし・faviconも取得できない場合','Nestrillの鳥アイコン（通常版）が標準です。'],['failed','記事画像の読み込みに失敗した場合','警告マーク付きの鳥アイコンが標準です。']]){
  const block=elt('div','placeholder-setting');block.append(elt('strong','',label));
  const sample=elt('img','placeholder-sample');sample.alt='プレビュー';sample.src=placeholderSrc(kind);sample.onerror=()=>{sample.onerror=null;sample.src=kind==='failed'?BUILTIN_FAILED_PLACEHOLDER:'/placeholder-missing.svg'};
  const picker=elt('input');picker.type='file';picker.accept='.png,.apng,.jpg,.jpeg,.gif,.webp,image/png,image/apng,image/jpeg,image/gif,image/webp';
  picker.onchange=async()=>{const file=picker.files?.[0];if(!file)return;if(file.size>5_000_000){notify('代替画像は5MB以下にしてください');return}
   try{const type=file.type||({apng:'image/apng',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'}[file.name.split('.').pop().toLowerCase()]);const data=await api('/api/placeholder/'+kind,{method:'POST',body:file,headers:{'Content-Type':type}});state.placeholders[kind]=data.image;sample.src=placeholderSrc(kind);renderArticles();notify('画像を仮適用しました。［設定を保存］で確定します。')}catch(e){err(e)}
  };
  const reset=action('標準に戻す',()=>{state.placeholders[kind]='';sample.src=placeholderSrc(kind);picker.value='';renderArticles()},false);
  const controls=elt('div','placeholder-controls');controls.append(picker,reset);block.append(sample,elt('div','help',help),controls);root.append(block);
 }
 root.append(elt('div','help','※ 画像はPC内に保存されます。元のRSS画像が表示できる場合は、代替画像を使いません。'));
 const message=elt('div','settings-error');message.id='settings-error';message.hidden=true;message.setAttribute('role','alert');root.append(message);const actions=elt('div','form-actions');actions.append(action('キャンセル',closeDialog,false),action('設定を保存',saveSettings));root.append(actions);
}
async function saveSettings(){
 const msg=$('settings-error');if(msg){msg.hidden=true;msg.textContent=''}
 for(const slot of ['shared','left','right']){
  const b=state.theme[slot];
  if(b.type==='folder'&&!b.folder){
   state.settingsSlot=slot;renderSettings();settingsError('フォルダランダムを使うにはPC側の背景フォルダを指定してください。');return;
  }
 }
 const button=[...$('dialog-body').querySelectorAll('button')].find(b=>b.textContent==='設定を保存');
 if(button){button.disabled=true;button.textContent='保存中…'}
 try{
  await post('/api/theme',state.theme);
  await post('/api/placeholders',state.placeholders);
  if(state.feedIconsDraft!==null){
   localStorage.setItem(FEED_ICON_PREF_KEY,state.feedIconsDraft?'1':'0');
   state.feedIcons=state.feedIconsDraft;
  }
  if(state.aiActionModeDraft!==null){
   state.aiActionMode=state.aiActionModeDraft==='icons'?'icons':'text';
   localStorage.setItem(AI_ACTION_MODE_KEY,state.aiActionMode);applyAiActionMode();
  }
  renderSidebar();
  state.settingsSnapshot=null;state.placeholderSnapshot=null;
  closeDialog();
  for(const slot of ['shared','left','right'])if(wallpaperState[slot])wallpaperState[slot].signature='';
  applyTheme();renderArticles();notify('外観設定を保存しました');
 }catch(e){settingsError('設定を保存できませんでした: '+e.message)}
 finally{if(button){button.disabled=false;button.textContent='設定を保存'}}
}
async function init(){try{applyAiActionMode();setSidebarFolded(localStorage.getItem(SIDEBAR_COLLAPSE_KEY)==='1');const sidebarWidth=Number(localStorage.getItem('nestrill-sidebar-width'));if(sidebarWidth>=175&&sidebarWidth<=600)document.documentElement.style.setProperty('--sidebar-width',sidebarWidth+'px');state.theme=await api('/api/theme');state.placeholders=await api('/api/placeholders');applyTheme();
 api('/api/fonts').then(data=>{state.installedFonts=Array.isArray(data.fonts)?data.fonts:[];state.fontDetected=!!data.detected;}).catch(e=>console.warn('フォント一覧の取得に失敗:',e));await loadProfiles();await loadSourceAccounts();await loadOverview();state.view=localStorage.getItem('nestrill-default-view')||'list';await loadArticles();if(state.overview.refreshing)setTimeout(checkRefresh,1600)}catch(e){err(e)}}
// Fix103Y: replace the AI recommendation heading + child with one article discovery nav item.
// Manipulate only the existing elements; no static index.html version assumptions.
function setupStandaloneArticleDiscoveryNav(){
 const wrap=$('ai-nav'),button=$('ai-rss');if(!wrap||!button)return;
 const heading=wrap.querySelector('.sidebar-heading');if(heading)heading.remove();
 wrap.classList.add('e2-standalone-nav');wrap.setAttribute('aria-label','AIセレクト');
 button.replaceChildren(elt('span','nav-symbol ai-nav-icon','▤'),elt('span','ai-nav-label','AIセレクト'));button.title='AIセレクト';button.setAttribute('aria-label','AIセレクト');
 if(!document.getElementById('nestrill-e2-standalone-nav-style')){
  const style=document.createElement('style');style.id='nestrill-e2-standalone-nav-style';
  style.textContent='#ai-nav.e2-standalone-nav{padding-top:6px}#ai-nav.e2-standalone-nav .ai-nav-button{font-size:inherit;min-height:36px;padding:8px 10px;font-weight:400;display:flex;align-items:center;gap:6px;line-height:1.6;overflow:visible}#ai-nav.e2-standalone-nav .ai-nav-button .ai-nav-label{display:block;line-height:1.6;padding-block:2px;font-weight:600}';
  document.head.appendChild(style);
 }
}
setupStandaloneArticleDiscoveryNav();
// Fix103AL: a distinct AI Select shortcut in the desktop collapsed sidebar rail.
// Reuse the existing rail-button style and the same AI view navigation as the expanded pane.
function setupCollapsedAiSelectNav(){
 const rail=$('sidebar-rail'),youtube=$('rail-youtube');
 if(!rail||!youtube){console.error('[Fix103AL] Collapsed sidebar rail is missing.');return}
 let button=$('rail-ai');
 if(!button){
  button=elt('button','rail-button','AI');button.id='rail-ai';button.type='button';
  button.title='AIセレクト';button.setAttribute('aria-label','AIセレクト');
  button.style.fontSize='14px';
  rail.insertBefore(button,youtube);
 }
 button.onclick=()=>selectAiKind('rss').catch(err);
}
setupCollapsedAiSelectNav();
setupMainPanePersistentScrollbar();
$('mobile-menu').onclick=()=>{$('sidebar').classList.toggle('open');$('mobile-scrim').classList.toggle('hidden')};$('mobile-scrim').onclick=closeMobile;
$('sidebar-collapse-btn').onclick=()=>setSidebarFolded(true);$('sidebar-expand-btn').onclick=()=>setSidebarFolded(false);$('rail-feeds').onclick=()=>{setSidebarFolded(false);$('sidebar-collapse-btn').focus()};
for(const g of ['all','unread','starred'])$('rail-'+g).onclick=()=>selectGroup(g);
for(const kind of ['youtube','mail']){$('source-'+kind).onclick=()=>selectSource(kind);$('rail-'+kind).onclick=()=>selectSource(kind);$('add-'+kind+'-account').onclick=()=>sourceAccountDialog(kind)}
for(const g of ['all','unread','starred'])$('nav-'+g).onclick=()=>selectGroup(g);
$('brand-s').onclick=()=>toggleSecret().catch(err);$('config-backup-btn').onclick=showConfigBackup;
$('profile-select').onchange=e=>switchProfile(Number(e.target.value)).catch(err);$('profile-manager-btn').onclick=showProfileManager;$('presets-btn').onclick=showPresets;
$('ai-rss').onclick=()=>selectAiKind('rss').catch(err);
$('add-category-btn').onclick=addCategoryDialog;$('add-feed-btn').onclick=addFeedDialog;$('settings-btn').onclick=settingsDialog;$('refresh-btn').onclick=refresh;
// Close the compact YouTube menu on outside click or Escape (without affecting dialogs).
document.addEventListener('click',event=>{
 for(const menu of document.querySelectorAll('.youtube-management-menu[open]'))if(!menu.contains(event.target))menu.open=false;
});
document.addEventListener('keydown',event=>{
 if(event.key==='Escape')for(const menu of document.querySelectorAll('.youtube-management-menu[open]'))menu.open=false;
});
$('dialog-close').onclick=closeDialog;$('dialog-overlay').onclick=e=>{if(e.target===$('dialog-overlay'))closeDialog()};document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDialog()});
$('list-view').onclick=()=>setView('list');$('magazine-view').onclick=()=>setView('magazine');$('more-btn').onclick=()=>loadArticles(true).catch(err);
$('filter-select').onchange=e=>{state.filter=e.target.value;loadArticles().catch(err)};
let searchTimeout;$('search').oninput=e=>{clearTimeout(searchTimeout);searchTimeout=setTimeout(()=>{state.q=e.target.value.trim();loadArticles().catch(err)},250)};
$('mark-read').onclick=async()=>{if(!confirm('現在のカテゴリ／フィードの記事をすべて既読にしますか？'))return;try{await post('/api/mark-read',{categoryId:state.category||undefined,feedId:state.feed||undefined});await Promise.all([loadOverview(),loadArticles()]);notify('既読にしました')}catch(e){err(e)}};
function confirmPartialOpml(){
 return new Promise(resolve=>{
  if(pendingOpmlDecision){pendingOpmlDecision(false);pendingOpmlDecision=null}
  pendingOpmlDecision=resolve;
  const pane=elt('div');
  pane.append(elt('p','','一部に取り込みできないRSSが含まれています。'),
   elt('p','','取り込み可能なRSSだけを登録しますか？'),
   elt('p','help','取り込みできないRSSはスキップされます。'));
  const actions=elt('div','form-actions');
  actions.append(action('取り込み中止',closeDialog,false),action('OK',()=>{
   if(pendingOpmlDecision){const finish=pendingOpmlDecision;pendingOpmlDecision=null;finish(true)}closeDialog();
  }));
  pane.append(actions);openDialog('OPMLの取り込み確認',pane);
 });
}
// UI05: registration-only backup, separate normal/secret export and import.
function showConfigBackup(){
 const secret=!!state.secretToken,pid=state.profileId,token=state.secretToken;
 const pane=elt('div');pane.append(elt('p','help',secret?
  '現在のシークレット領域のRSS・YouTube登録構成だけを保存／復元します。通常プロファイルは含まれません。':
  '通常プロファイル全体のRSS・YouTube登録構成を保存／復元します。シークレットは含まれません。'));
 pane.append(elt('p','help','※ 記事の本文・既読・お気に入り・外観・背景素材・AI学習情報は対象外です。構成ファイルは暗号化されていません。'));
 const actions=elt('div','form-actions');
 actions.append(action('構成を書き出す',async()=>{
  try{
   if(pid!==state.profileId||token!==state.secretToken)throw Error('モードが切り替わりました');
   const config=await api('/api/config-backup');
   if(pid!==state.profileId||token!==state.secretToken)throw Error('モードが切り替わりました');
   const bytes=new Blob([JSON.stringify(config,null,2)],{type:'application/json;charset=utf-8'});
   const url=URL.createObjectURL(bytes),link=document.createElement('a');
   link.href=url;link.download=`nestrill-${secret?'secret':'regular'}-config-${new Date().toISOString().slice(0,10)}.json`;
   document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
   notify('Nestrill登録構成を書き出しました');
  }catch(e){err(e)}
 },false));
 const upload=elt('input');upload.type='file';upload.accept='.json,application/json';upload.hidden=true;
 upload.onchange=async()=>{
  const file=upload.files?.[0];if(!file)return;
  try{
   if(file.size>5_000_000)throw Error('構成ファイルが大きすぎます（最大5MB）');
   if(pid!==state.profileId||token!==state.secretToken)throw Error('モードが切り替わりました');
   const config=JSON.parse(await file.text());
   const info=await post('/api/config-backup/preview',config);
   if(pid!==state.profileId||token!==state.secretToken)throw Error('モードが切り替わりました');
   const text=`${secret?'シークレットへ追加します。既存の登録は削除しません。':'通常プロファイルを新しく作成します。現在のプロファイルは上書きしません。'}\n\n`+
      `対象：${info.profiles}プロファイル、${info.categories}カテゴリ、${info.feeds} RSS、${info.groups} YouTubeグループ、${info.channels} チャンネル、${info.exclusions} 除外登録\n\n復元を実行しますか？`;
   if(!confirm(text))return;
   if(pid!==state.profileId||token!==state.secretToken)throw Error('モードが切り替わりました');
   const result=await post('/api/config-backup/commit',{ticket:info.ticket});
   notify(`構成を追加しました：RSS ${result.feeds}件、YouTube ${result.channels}件`);
   closeDialog();await loadProfiles();await loadOverview();await loadSourceAccounts();
  }catch(e){err(e)}finally{upload.value=''}
 };
 actions.append(action('構成ファイルを取り込む',()=>upload.click(),false));
 pane.append(actions,upload);openDialog(secret?'シークレットの構成バックアップ':'通常の構成バックアップ',pane);
}

$('import-btn').onclick=()=>$('opml-input').click();$('export-btn').onclick=async()=>{try{
 const xml=await api('/api/opml');const blob=new Blob([xml],{type:'application/xml;charset=utf-8'});
 const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=state.secretToken?'nestrill-secret.opml':'nestrill.opml';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(e){err(e)}};$('opml-input').onchange=async e=>{
 const file=e.target.files?.[0];if(!file)return;
 const startingProfile=state.profileId,startingSession=state.secretToken;
 try{
  const xml=await file.text();
  const plan=await api('/api/opml/preview',{method:'POST',body:xml,headers:{'Content-Type':'application/xml'}});
  if(startingProfile!==state.profileId||startingSession!==state.secretToken)return;
  if(plan.status==='none'){
   notify('取り込みできるRSSがありませんでした。登録内容は変更していません。');return;
  }
  if(plan.needsConfirmation){
   const approved=await confirmPartialOpml();
   if(!approved)return;
  }
  if(startingProfile!==state.profileId||startingSession!==state.secretToken)return;
  const result=await post('/api/opml/commit',{ticket:plan.ticket,acceptPartial:plan.needsConfirmation});
  notify(result.partial?`OPML登録: ${result.added}件追加。一部のRSSは取り込まれませんでした。`:`OPML登録: ${result.added}件追加、${result.skipped}件スキップ。更新を開始します。`);
  await loadOverview();refresh();
 }catch(e){err(e)}finally{e.target.value=''}
};
const splitter=$('splitter');splitter.addEventListener('pointerdown',e=>{if(window.innerWidth<=700||document.documentElement.classList.contains('nestrill-sidebar-collapsed'))return;splitter.setPointerCapture(e.pointerId);function drag(ev){let w=Math.max(175,Math.min(window.innerWidth*.42,ev.clientX));document.documentElement.style.setProperty('--sidebar-width',w+'px');localStorage.setItem('nestrill-sidebar-width',String(w))}function end(){splitter.removeEventListener('pointermove',drag);splitter.removeEventListener('pointerup',end)}splitter.addEventListener('pointermove',drag);splitter.addEventListener('pointerup',end)});
$('category-list').addEventListener('contextmenu',e=>{const target=e.target.closest('.feed-nav');if(!target)return;e.preventDefault();const f=state.overview?.feeds.find(x=>x.id===Number(target.dataset.feedId));if(f)manageFeed(f)});
init();
