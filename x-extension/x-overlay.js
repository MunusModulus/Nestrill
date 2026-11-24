'use strict';
// Proof09: Never navigate, modify X posts, or touch its scroll/history.
// Mount exactly one extension-origin overlay in the SAME top-level X document.
(() => {
  if (window.top!==window || !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(location.hostname))return;
  const ROOT_ID='nx9-keepalive-layer';
  let root=null,frame=null,opened=false,originScroll=null;
  const scrollY=()=>Math.round(window.scrollY||document.scrollingElement?.scrollTop||0);
  function mount(){
    if(root?.isConnected)return;
    root=document.createElement('div');
    root.id=ROOT_ID;
    // CSS with important priority to minimize interference from X styles.
    const rules={position:'fixed',inset:'0',width:'100vw',height:'100vh',zIndex:'2147483647',
      background:'#fff',visibility:'hidden',pointerEvents:'none',margin:'0',padding:'0',border:'0'};
    for(const [key,val] of Object.entries(rules))root.style.setProperty(key.replace(/[A-Z]/g,m=>'-'+m.toLowerCase()),val,'important');
    const shadow=root.attachShadow({mode:'closed'});
    frame=document.createElement('iframe');
    frame.title='NestrillのRSS';
    frame.src=chrome.runtime.getURL('rss-frame.html');
    frame.allow='local-network; loopback-network';
    frame.referrerPolicy='no-referrer';
    frame.style.cssText='display:block;width:100%;height:100%;border:0;margin:0;padding:0;background:#fff';
    shadow.appendChild(frame);
    document.body.appendChild(root);
  }
  function show(){
    mount();
    if(!opened){originScroll=scrollY();opened=true;}
    root.style.setProperty('visibility','visible','important');
    root.style.setProperty('pointer-events','auto','important');
    return {ok:true,mode:'overlay',xDocumentRetained:true,xScrollAtHide:originScroll};
  }
  function hide(){
    if(root?.isConnected){
      root.style.setProperty('visibility','hidden','important');
      root.style.setProperty('pointer-events','none','important');
    }
    opened=false;
    const current=scrollY(),before=originScroll;
    return {ok:true,mode:'x',xDocumentRetained:true,
      xScrollBefore:before,xScrollAfter:current,delta:(before===null?null:current-before)};
  }
  chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
    if(message?.type==='NX9_SHOW_OVERLAY'){try{reply(show());}catch(e){reply({ok:false,error:String(e)});}return false;}
    if(message?.type==='NX9_HIDE_OVERLAY'){try{reply(hide());}catch(e){reply({ok:false,error:String(e)});}return false;}
    if(message?.type==='NX9_REPLACE_X_WITH_NESTRILL'){
      const target=message.targetUrl;
      // Only the local Nestrill origin is authorized; do not permit arbitrary URLs.
      if(!opened||typeof target!=='string'||
          !/^http:\/\/(?:127\.0\.0\.1|localhost):8767(?:\/|$)/.test(target)){
        reply({ok:false,error:'終了対象またはNestrillの戻り先を確認できません。'});
        return false;
      }
      reply({ok:true,closing:true});
      // Replace the X history entry. Do not leave it as a BFCache candidate.
      setTimeout(()=>window.location.replace(target),0);
      return false;
    }
    if(message?.type==='NX9_OVERLAY_STATE'){reply({ok:true,mounted:!!root?.isConnected,opened,scrollY:scrollY()});return false;}
    return false;
  });
})();
