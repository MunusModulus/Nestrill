/* Proof09 R6: read-only bridge; measure actual shared media geometry.
   Never writes to /api/theme, Nestrill DB or extension settings.
   Does not copy full theme, folder paths, secret tokens or user data. */
'use strict';
(() => {
  if(location.protocol!=='http:'||!['127.0.0.1','localhost'].includes(location.hostname)||location.port!=='8767')return;
  const app=document.getElementById('app');if(!app)return;
  const allowedPath=u=>/^\/(?:assets\/bg-(?:shared|left|right)-[\w-]+\.(?:png|apng|jpe?g|webp|gif|mp4|webm)|api\/wallpaper\/file\/(?:shared|left|right)\/[\w.%()+-]+)(?:\?(?:[\w%=&.+-]+))?$/i.test(u);
  const cleanImage=u=>{
    try {if(!u)return '';
      const v=new URL(u,location.origin);
      // Same server only. Never send remote URLs, arbitrary local files or credentials.
      if(v.origin!==location.origin || !allowedPath(v.pathname+v.search))return '';
      // A secret background URL carries an access token: never leak it into a stored session.
      if(v.searchParams.has('secret'))return '';
      return v.href;
    }catch{return '';}
  };
  const readBg=el=>{
    const val=el?.style.backgroundImage||'';
    const m=/^url\(["']?(.*?)["']?\)$/.exec(val);
    return m?cleanImage(m[1]):'';
  };
  const hex=(x,backup)=>/^#[0-9a-f]{6}$/i.test(x||'')?x:backup;
  const num=(x,lo,hi,backup)=>Number.isFinite(Number(x))?Math.max(lo,Math.min(hi,Number(x))):backup;
  const isAnimated=u=>/\.(?:mp4|webm|apng|gif)(?:\?|$)/i.test(u||'');
  const safeFont=x=>typeof x==='string'&&x.length<=180&&!/[{}<>;\\]/.test(x)?x:'Meiryo, sans-serif';
  function readSlot(slot,theme){
    const layer=slot==='shared'?document.querySelector('#app > .wallpaper-layer'):
      document.querySelector((slot==='left'?'#sidebar':'#main')+' > .wallpaper-layer');
    const img=layer?.querySelector('.wallpaper-image'),video=layer?.querySelector('.wallpaper-video');
    const v=video?.style.display==='block'?cleanImage(video.getAttribute('src')||''):'';
    const selected=v||readBg(img);
    const o=theme?.[slot]||{};
    let staticFallback='';
    // The existing left slot is intentionally stopped while shared-linked.
    // A saved still image is valid as a fallback; a video/animated image is not.
    if(o.type==='image')staticFallback=cleanImage(o.image);
    if(isAnimated(staticFallback))staticFallback='';
    return {image:selected,animated:!!v||isAnimated(selected),
      fallback:staticFallback,
      type:['color','image','video','folder'].includes(o.type)?o.type:'color',
      position:['center','left','right','top','bottom'].includes(o.position)?o.position:'center',
      color:hex(o.color,'#ffffff'),colorOpacity:num(o.colorOpacity,0,100,100),
      imageOpacity:num(o.imageOpacity,0,100,100),blur:num(o.blur,0,40,0)};
  }
  let last=null,lastSignature='',timer=0,busy=false,retry=false;
  let panelWidth=0;
  function applyWidth(width){
    const n=Number(width);
    if(!Number.isFinite(n)||n<160||n>900)return;
    if(panelWidth===n)return;
    panelWidth=n;
    document.documentElement.style.setProperty('--nx9-panel-width',n+'px');
    document.documentElement.classList.toggle('nx9-shared-static',
      !!(last?.linked && last?.shared?.image && !last.shared.animated &&
         document.documentElement.classList.contains('nx4-hide-native-menu')));
    // The width rule must take effect BEFORE measuring. Avoid a stale canvas
    // when Helium's side-panel splitter moves while the image stays the same.
    requestAnimationFrame(()=>sync(true));
  }
  const css=document.createElement('style');css.id='nx9-r5-static-align';
  css.textContent=`html.nx9-shared-static #app > .wallpaper-layer > .wallpaper-media {
    left:calc(-48px - var(--nx9-panel-width, 0px)) !important;
  }`;
  document.documentElement.append(css);
  // Measure the actual Nestrill wallpaper media, not an approximation based
  // on independent left/right viewport dimensions. Coordinates are in the
  // right document's viewport, including the -48px blur bleed and the
  // leftward extension used while the original Nestrill menu is hidden.
  function sharedCanvas(s){
    if(!s.linked||!s.shared?.image||s.shared.animated||
       !document.documentElement.classList.contains('nx9-shared-static')||!panelWidth)return null;
    const layer=document.querySelector('#app > .wallpaper-layer');
    const media=layer?.querySelector(':scope > .wallpaper-media');
    if(!media)return null;
    const r=media.getBoundingClientRect(),clip=layer.getBoundingClientRect();
    const vals=[r.left,r.top,r.width,r.height,clip.top,window.innerWidth,window.innerHeight];
    if(vals.some(v=>!Number.isFinite(v))||r.width<100||r.height<100)return null;
    const round=v=>Math.round(v*100)/100;
    return {panelWidth,viewportWidth:round(window.innerWidth),viewportHeight:round(window.innerHeight),
      left:round(r.left),top:round(r.top),width:round(r.width),height:round(r.height),
      clipTop:round(clip.top)};
  }
  // R9P: read native, browser-local presentation only (no feeds, titles, history,
  // settings writes, or user content). CSS computed values work even while the
  // native sidebar is hidden by R9O's shared-menu mode.
  function readNativeMenuStyle(){
    const sidebar=document.querySelector('#sidebar');
    const nav=document.querySelector('#nav-all');
    const glyph=nav?.querySelector('.nav-symbol');
    const category=document.querySelector('#category-list .cat-head .nav-symbol');
    const feed=document.querySelector('#category-list .feed-nav');
    if(!sidebar||!nav||!glyph)return null;
    const css=e=>e?getComputedStyle(e):null;
    const p=css(sidebar),n=css(nav),g=css(glyph),c=css(category),f=css(feed);
    const font=safeFont(p?.fontFamily);
    // R9Q: nav-all is normally ACTIVE (font-weight 700). R9P sampled that
    // value as the *base* for the entire shared panel and unintentionally
    // made every row bold. Native sidebar's own computed weight is the true
    // user-configured left-pane base; selected rows independently use 700.
    // Clamp values before they leave the Nestrill document. Never accept CSS
    // expressions or URLs from content as an extension style token.
    return {
      font,
      size:num(parseFloat(n?.fontSize),11,24,13),
      weight:num(parseFloat(p?.fontWeight),100,900,400),
      iconSize:num(parseFloat(g?.fontSize),11,26,16),
      triangleSize:num(parseFloat(c?.fontSize),11,26,16),
      feedSize:num(parseFloat(f?.fontSize),10,23,12),
      showCounts:!document.documentElement.classList.contains('nestrill-hide-sidebar-counts')
    };
  }
  const snapshot=async()=>{
    if(document.documentElement.classList.contains('secret-active'))return {secret:true};
    // Current Nestrill theme API, fetched by its own document with same-origin privileges.
    const rsp=await fetch('/api/theme',{credentials:'same-origin',cache:'no-store'});
    if(!rsp.ok)throw Error('theme '+rsp.status);
    const t=await rsp.json();
    if(!t||typeof t!=='object')throw Error('theme missing');
    const linked=t.sharedLinked!==false;
    const left=readSlot('left',t),shared=readSlot('shared',t),right=readSlot('right',t);
    const x=t.text?.left||{};const header=t.header||{};
    return {linked,left,shared,right,baseColor:hex(t.baseColor,'#edf0f5'),
      header:{extend:header.extend!==false,color:hex(header.color,'#ffffff'),
        opacity:num(header.opacity,0,100,75),blur:num(header.blur,0,40,10),
        textColor:hex(header.textColor,'#263c59')},
      text:{font:safeFont(x.font),size:num(x.size,11,24,13),weight:num(x.weight,100,900,400),color:hex(x.color,'#273349'),
        stroke:num(x.stroke,0,3,0),strokeColor:hex(x.strokeColor,'#000000'),
        shadow:!!x.shadow,shadowColor:hex(x.shadowColor,'#121a2d'),
        shadowOpacity:num(x.shadowOpacity,0,100,60),shadowX:num(x.shadowX,-20,20,1),
        shadowY:num(x.shadowY,-20,20,2),shadowBlur:num(x.shadowBlur,0,20,3)},
      nativeMenu:readNativeMenuStyle(),
      viewport:{width:window.innerWidth,height:window.innerHeight},
      // Secret profile appearance never leaves its own page.
      secret:document.documentElement.classList.contains('secret-active')};
  };
  async function sync(force=false){
    if(busy){retry=true;return;}
    busy=true;
    try{
      const s=await snapshot();last=s;
      document.documentElement.classList.toggle('nx9-shared-static',
        !!(s.linked && s.shared.image && !s.shared.animated &&
           document.documentElement.classList.contains('nx4-hide-native-menu')));
      // getBoundingClientRect forces CSS layout after the extension class
      // and size variables have been applied.
      s.sharedCanvas=sharedCanvas(s);
      const key=JSON.stringify(s);
      if(force||key!==lastSignature){
        lastSignature=key;
        await chrome.runtime.sendMessage({type:'NX9_APPEARANCE_PUSH',appearance:s}).catch(()=>{});
      }
    }catch(e){console.warn('Nestrill Nestrill X Extension appearance check:',String(e.message||e));}
    finally{busy=false;if(retry){retry=false;schedule();}}
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(()=>sync(),180);}
  chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{
    if(msg?.type==='NX9_APPEARANCE_SNAPSHOT'){
      // An asynchronous snapshot is returned only to the paired extension panel.
      sync(true).then(()=>reply({ok:true,appearance:last})).catch(e=>reply({ok:false,error:String(e)}));
      return true;
    }
    if(msg?.type==='NX9_PANEL_METRICS'){
      applyWidth(msg.width);reply({ok:true});return false;
    }
    return false;
  });
  // Watch wallpaper changes (including folder random changes and preset application).
  // Ignore article DOM changes and user-generated HTML.
  const observer=new MutationObserver(ms=>{
    if(ms.some(m=>m.target instanceof Element && (
      m.target.closest('.wallpaper-layer')||
      m.target.matches('#app, #sidebar, #main, #app > .topbar'))))schedule();
  });
  observer.observe(app,{subtree:true,attributes:true,attributeFilter:['style','src','class'],childList:true});
  const secretObserver=new MutationObserver(schedule);
  secretObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  window.addEventListener('resize',schedule,{passive:true});
  // Re-sync after frame initialization and when settings are saved with no media changes.
  setTimeout(()=>sync(true),700);
  setInterval(()=>{if(document.visibilityState==='visible')sync();},5500);
})();
