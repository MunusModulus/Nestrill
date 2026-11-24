'use strict';
// Proof09: Keep the X document and its scroll/history; only change tab metadata while RSS is visible.
// Mount exactly one extension-origin overlay in the SAME top-level X document.
(() => {
  if (window.top!==window || !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(location.hostname))return;
  const ROOT_ID='nx9-keepalive-layer';
  let root=null,frame=null,opened=false,originScroll=null;
  const scrollY=()=>Math.round(window.scrollY||document.scrollingElement?.scrollTop||0);

  // Tab metadata follows the visible view; never change the top-level URL.
  // Use the actual Nestrill 0.2.3 favicon (32px PNG converted from favicon.svg).
  const RSS_TITLE='Nestrill';
  const RSS_ICON='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABmJLR0QA/wD/AP+gvaeTAAAEB0lEQVRYhcWXW0xcVRSGv31mKAy9AC1tlZRSB419AFMgTksFoSQOBYuRUlIwA5oxqdTGanxu5aFPmnhJmtYGYgIUEJtCJSSOEou0pQUZpmDBcGcIaqWhIBjDMDDD9gFBKsNwGSr/09l7rfX//1lZ++wcwTyEHkzdgYPTUigvg3xGwEbWBmNAO1KUiG3j+T0mk302IGYfntalpkshvgA2r5GoSwjocCgitb++vGPOwD/iX8039JgxLBHRfT+Wd4vQg6k7cIoeHvObu8C9YM1IlIKD0+sgDvDcgC0gSxFCHFkHcQAEZKslhHpKFHngAPGJiezWakFKBqxWakwmWhobl7KwT4TuPyo9EU/LziJen+gy9oPJREVJidt6tSfiz8fEEK9PZGpykoriYhpv30Yg0MW8QKrBwKGkJHq7OvnJ3LQoh7Ja8a2BgaRnvw7AlYJC6mpqmLTbsdsnuHX9Ol9/WQrAocTDbnlWZUBRK7x75gwaXw0tTWYabt4A4L2zZ3k/NxcAc10dANq9z/LGqVOERUSsnYEjaelsDQwEoPNeq8sc27gNAIEgKjqa7JNvu8xb8QzsCgkhISlpbv3qa5m03r3L2Ogon50757LGUl9P0507LmMr6oCXlxdZOTmo1GpuVFfTarHg7aMhTq93W1dw4QJtzc2eG3glM4Og4GAe3P+NyrIyakzfAhAWEbkgV632AsDpcLjlXLaBveHhxL2kx+l0Unjxc6YmJxmw9gEQ+MTOBfnbn5zZ+2Nk2HMDGzdtwnDiBEIIvqmo4Jf+/iVrZrvS29HluYEMoxG/gAB6Ozv5vqpqbn/3U1oAhgYHH8n39tHMfR0tDa6Hb9kGdLGx7NPpmLCNc/nSJaanp+diCckzp+HneQMmhCDzTSNb/P2wdnfT0drmlt/tMdwWuJ307CwAyouKGR4amovpU1IIj4xkwjZObfV3APhoNGQYjURFRzNhG6c0Lx8p3V81ixpQFAXDyRx8NL60mM003LrJBm9vQrRaEpKTCYuIQE5LrhQUsjMoiPjEw+yPfZEt/n5M2MbJ++RTBn+/71YcYNHbUJ+SQsrx40sS/BfW7m5K8/KXJQ6LdCB4zx6S09KWReB0OlGpVABc/OhDOlrblmz7kgay3vr3a3e1qGhB/HxxMQDvGAyPrNsXuRfcweUpsE/ZGeizUllWtmLClULNzE+D3/zNjz/IdVvU29npdr18yD9FqO5oLYK4VTJ4BkmzIuDyuogDQsgqZZfvSCGIlU+P5xhTHI7zSm1trUPK6WOA+2trbSGlkMYuS9VDBaCv8VqXUxExQPv/ID4mhTzW13CtAkA1uzv6a/vDIP+wfOeG6QdI4Y9gM+CzRqJ/AW0Cma9yOAw95krLbOBvWBVkBZn6EE0AAAAASUVORK5CYII=';
  let metadataObserver=null, nativeTitle=null, ownIcon=null;
  const nativeIcons=new Map();
  const isIcon=node=>node instanceof HTMLLinkElement &&
    (node.getAttribute('rel')||'').split(/\s+/).some(token=>token.toLowerCase()==='icon');
  function restoreHref(link,href){
    if(link.getAttribute('href')!==RSS_ICON)return;
    if(href===null)link.removeAttribute('href');else link.setAttribute('href',href);
  }
  function syncTabMetadata(){
    if(!opened||!document.head)return;
    if(document.title!==RSS_TITLE){nativeTitle=document.title;document.title=RSS_TITLE;}
    // X may update its favicon for notifications or replace its head links.
    // Keep the latest native href, not just the value from the first switch.
    for(const [link,href] of nativeIcons){
      if(!document.head.contains(link)||!isIcon(link)){
        restoreHref(link,href);nativeIcons.delete(link);
      }
    }
    for(const link of document.head.querySelectorAll('link[rel]')){
      if(link===ownIcon||!isIcon(link))continue;
      const href=link.getAttribute('href');
      if(href!==RSS_ICON){nativeIcons.set(link,href);link.setAttribute('href',RSS_ICON);}
    }
    if(!ownIcon?.isConnected){
      ownIcon=document.createElement('link');
      ownIcon.rel='icon';ownIcon.type='image/png';ownIcon.sizes='32x32';
      ownIcon.href=RSS_ICON;document.head.appendChild(ownIcon);
    }else if(ownIcon.getAttribute('href')!==RSS_ICON){
      // If the site reused our fallback link, preserve that new native icon.
      const link=ownIcon;ownIcon=null;
      nativeIcons.set(link,link.getAttribute('href'));link.setAttribute('href',RSS_ICON);
      syncTabMetadata();
    }
  }
  function beginTabMetadata(){
    if(metadataObserver||!document.head)return;
    nativeTitle=document.title;
    syncTabMetadata();
    metadataObserver=new MutationObserver(syncTabMetadata);
    metadataObserver.observe(document.head,{subtree:true,childList:true,characterData:true,
      attributes:true,attributeFilter:['href','rel']});
  }
  function endTabMetadata(){
    metadataObserver?.disconnect();metadataObserver=null;
    if(nativeTitle!==null&&document.title===RSS_TITLE)document.title=nativeTitle;
    nativeTitle=null;
    if(ownIcon){
      // Do not remove a link if X itself has just repurposed it.
      if(ownIcon.getAttribute('href')===RSS_ICON)ownIcon.remove();
      ownIcon=null;
    }
    for(const [link,href] of nativeIcons)restoreHref(link,href);
    nativeIcons.clear();
  }
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
    try{beginTabMetadata();}catch(e){console.warn('Nestrill tab metadata:',e);}
    return {ok:true,mode:'overlay',xDocumentRetained:true,xScrollAtHide:originScroll};
  }
  function hide(){
    if(root?.isConnected){
      root.style.setProperty('visibility','hidden','important');
      root.style.setProperty('pointer-events','none','important');
    }
    opened=false;
    try{endTabMetadata();}catch(e){console.warn('Nestrill tab metadata restore:',e);}
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
      setTimeout(()=>{try{endTabMetadata();}catch(_){}window.location.replace(target);},0);
      return false;
    }
    if(message?.type==='NX9_OVERLAY_STATE'){reply({ok:true,mounted:!!root?.isConnected,opened,scrollY:scrollY()});return false;}
    return false;
  });
})();
