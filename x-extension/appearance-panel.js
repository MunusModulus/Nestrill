/* Proof09 R6: Pixel-aligned appearance mirror for shared still images.
   Static image/color only; NEVER creates a video or animated-image player. */
'use strict';
(() => {
 const $=id=>document.getElementById(id);
 const root=$('nx9-wallpaper'),media=$('nx9-wallpaper-media'),tint=$('nx9-wallpaper-tint');
 const rgba=(hex,percent)=>{const h=hex.slice(1);return 'rgba('+[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)).join(',')+','+(percent/100)+')';};
 const validColor=x=>/^#[0-9a-f]{6}$/i.test(x||'');
 const safeImage=url=>{
   try {const u=new URL(url);if(!['http://127.0.0.1:8767','http://localhost:8767'].includes(u.origin))return '';
      if(!/^\/(?:assets\/bg-(?:shared|left|right)-[\w-]+\.(?:png|apng|jpe?g|webp)|api\/wallpaper\/file\/(?:shared|left|right)\/[\w.%()+-]+)$/i.test(u.pathname))return '';
      if(u.searchParams.has('secret')||/\.(?:apng|gif|mp4|webm)$/i.test(u.pathname))return '';
      return u.href;
   }catch{return '';}
 };
 // Translate the real Nestrill wallpaper rectangle into sidebar coordinates.
 // Both surfaces normally share the bottom edge of Helium's content area,
 // but their TOP edges can differ because the sidebar has separate chrome.
 // Thus rightViewportHeight - panelViewportHeight is the vertical origin gap.
 function alignedGeometry(canvas,panelWidth,panelHeight){
   if(!canvas || ![canvas.panelWidth,canvas.viewportHeight,canvas.left,canvas.top,
       canvas.width,canvas.height,canvas.clipTop].every(Number.isFinite))return null;
   if(Math.abs(canvas.panelWidth-panelWidth)>2||canvas.width<100||canvas.height<100)return null;
   const originGap=canvas.viewportHeight-panelHeight;
   // A much larger discrepancy suggests the frame is not laid out as the
   // expected same-window sidebar + tab pair; fall back to R5 placement.
   if(Math.abs(originGap)>240)return null;
   return {left:canvas.left+canvas.panelWidth,top:canvas.top-originGap,
     width:canvas.width,height:canvas.height,clipTop:canvas.clipTop-originGap};
 }
 let current=null,lastWidth=0,lastHeight=0;
 function render(snapshot){
   if(!snapshot||snapshot.secret){
     current=null;media.style.backgroundImage='none';root.hidden=true;document.body.classList.remove('nx9-themed');return;
   }
   current=snapshot;
      const sharedStatic=snapshot.linked && !!safeImage(snapshot.shared?.image)&&!snapshot.shared?.animated;
   const animated=snapshot.linked&&(snapshot.shared?.animated || snapshot.shared?.type==='video' ||
      (snapshot.shared?.type==='folder'&&snapshot.shared?.animated));
   let url=sharedStatic?safeImage(snapshot.shared.image):!snapshot.linked?safeImage(snapshot.left?.image):'';
   let paint=snapshot.linked&&!animated?snapshot.shared:snapshot.left;
   // In shared animation mode use only the saved LEFT still image or color.
   if(animated){url=safeImage(snapshot.left?.fallback);paint=snapshot.left;}
   const body=document.body,style=body.style;
   const text=snapshot.text||{};
   const native=snapshot.nativeMenu||{};
   const safeNumber=(value,low,high)=>Number.isFinite(value)&&value>=low&&value<=high?value:null;
   const nativeFont=typeof native.font==='string'&&native.font.length<=180&&
     !/[{}<>;\\]/.test(native.font)?native.font:null;
   if(nativeFont)style.setProperty('--nx-native-font',nativeFont);
   for(const [prop,value,lo,hi] of [
     ['--nx-native-menu-size',native.size,11,24],
     ['--nx-native-menu-weight',native.weight,100,900],
     ['--nx-native-icon-size',native.iconSize,11,26],
     ['--nx-native-triangle-size',native.triangleSize,11,26],
     ['--nx-native-feed-size',native.feedSize,10,23]
   ]){
     const n=safeNumber(value,lo,hi);
     if(n!==null)style.setProperty(prop,n+(prop.includes('weight')?'':'px'));
   }
   if(typeof native.showCounts==='boolean'){
     body.dataset.nxShowCounts=native.showCounts?'1':'0';
   }
   // X Edition sidebar has an opaque white backing even when overlay opacity is 0%.
   // The saved Nestrill theme and right pane keep their original baseColor.
   style.setProperty('--nx-base','#ffffff');
   if(validColor(text.color))style.setProperty('--nx-left-color',text.color);
   if(validColor(text.strokeColor))style.setProperty('--nx-left-stroke-color',text.strokeColor);
   if(Number.isFinite(text.size))style.setProperty('--nx-left-size',text.size+'px');
   if(Number.isFinite(text.stroke))style.setProperty('--nx-left-stroke',text.stroke+'px');
   if(typeof text.font==='string')style.setProperty('--nx-left-font',text.font);
   if(Number.isFinite(text.weight))style.setProperty('--nx-left-weight',text.weight);
   const shadow=text.shadow&&validColor(text.shadowColor)?
     `${text.shadowX??1}px ${text.shadowY??2}px ${text.shadowBlur??3}px ${rgba(text.shadowColor,text.shadowOpacity??60)}`:'none';
   style.setProperty('--nx-left-shadow',shadow);
   root.hidden=false;body.classList.add('nx9-themed');
   const header=snapshot.header||{};
   const h=header.extend===false?53:0;
   style.setProperty('--nx-header-bg',header.extend!==false&&validColor(header.color)?rgba(header.color,header.opacity??75):'#ffffff');
   style.setProperty('--nx-header-text',validColor(header.textColor)?header.textColor:'#263c59');
   style.setProperty('--nx-header-blur',(header.extend!==false?(header.blur??10):0)+'px');
   const w=window.innerWidth,ht=window.innerHeight;
   const rightW=Number(snapshot.viewport?.width)||0;
   const geometry=sharedStatic?alignedGeometry(snapshot.sharedCanvas,w,ht):null;
   if(geometry){
     // Clamp clipping to this viewport; keep the media's original position
     // and size so background-size:cover has precisely the SAME scale.
     const clipTop=Math.max(0,geometry.clipTop);
     root.style.top=clipTop+'px';
     media.style.left=geometry.left+'px';
     media.style.top=(geometry.top-clipTop)+'px';
     media.style.width=geometry.width+'px';
     media.style.height=geometry.height+'px';
   }else{
     // Independent/animated background, or first snapshot before metrics.
     root.style.top=h+'px';
     media.style.left='-48px';media.style.top='-48px';
     media.style.width=(sharedStatic&&rightW>0?w+rightW+96:w+96)+'px';
     media.style.height=Math.max(0,ht-h+96)+'px';
   }
   media.style.backgroundImage=url?'url('+JSON.stringify(url)+')':'none';
   media.style.backgroundPosition=paint?.position||'center';
   media.style.opacity=String((paint?.imageOpacity??100)/100);
   media.style.filter='blur('+(paint?.blur??0)+'px)';
   tint.style.backgroundColor=validColor(paint?.color)?rgba(paint.color,paint.colorOpacity??100):'transparent';
   // We mirror only the left appearance; the real app retains responsibility for right media.
   body.dataset.nxWallpaper=sharedStatic?'shared-image':animated?(url?'animated-right-left-image':'animated-right-left-color'):
      (url?'independent-image':'solid-color');
 }
 let pending=0;
 async function read(){
   try{const t=(await chrome.tabs.query({active:true,currentWindow:true}))[0];
     if(!t?.id)return;
     const r=await chrome.runtime.sendMessage({type:'NX9_GET_APPEARANCE',currentTabId:t.id});
     if(r?.ok && r.appearance){render(r.appearance);await size();}
     // Do not clear old appearance on a transient frame load.
   }catch(_){/* A non-Nestrill unrelated tab is handled by per-tab panel scoping. */}
 }
 async function size(){
   if(!current)return;
   if(window.innerWidth!==lastWidth || window.innerHeight!==lastHeight){
     lastWidth=window.innerWidth;lastHeight=window.innerHeight;
     render(current);
     try{const t=(await chrome.tabs.query({active:true,currentWindow:true}))[0];
       if(t?.id)await chrome.runtime.sendMessage({type:'NX9_PANEL_WIDTH',currentTabId:t.id,width:window.innerWidth});
     }catch(_){ }
   }
 }
 chrome.runtime.onMessage.addListener(m=>{
   if(m?.type==='NX9_APPEARANCE_UPDATED'){
     chrome.tabs.query({active:true,currentWindow:true}).then(ts=>{
       if(ts[0]?.id===m.tabId){clearTimeout(pending);pending=setTimeout(()=>read(),120);}
     }).catch(()=>{});
   }
 });
 chrome.tabs.onActivated.addListener(()=>{setTimeout(()=>{read();size();},240);});
 chrome.tabs.onUpdated.addListener((_id,change)=>{if(change.status==='complete')setTimeout(()=>{read();size();},300);});
 window.addEventListener('resize',()=>size(),{passive:true});
 read().then(size);
 // The native sidebar's appearance can update without a tab navigation.
 setInterval(read,6000);
})();
