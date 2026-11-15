'use strict';
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {create}=require('./app/youtube-source');
const id='UC'+'x'.repeat(22);
const item={url:'https://www.youtube.com/watch?v=abcdefghijk',title:'Test video',guid:'yt:video:abcdefghijk',excerpt:'Hello',published:Date.now()};
async function scenario(name,conditions,expected){
 let n=0;
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE source_accounts(id INTEGER PRIMARY KEY,profile_id INTEGER NOT NULL,service TEXT NOT NULL,label TEXT NOT NULL);
 INSERT INTO source_accounts VALUES(1,1,'youtube','Gadgets');`);
 const svc=create({db,fetchFeed:async()=>{const x=conditions[Math.min(n++,conditions.length-1)];if(x instanceof Error)throw x;return {feed:{items:[item]}};}});
 db.prepare('INSERT INTO youtube_subscriptions_local(account_id,channel_id,title,origin) VALUES(1,?,?,\'manual\')').run(id,'Channel Test');
 const payload={};
 const status=await svc.handle({method:'POST'},payload,'/api/youtube/sync/1',new URL('http://127.0.0.1/'),1,async()=>Buffer.from('{}'),(res,s,v)=>{res.http=s;res.data=v},(res,msg,code)=>{res.http=code;res.error=msg});
 const error=db.prepare('SELECT sync_error FROM youtube_refresh_local WHERE account_id=1').get()?.sync_error||'';
 if(expected.calls!=null)assert.equal(n,expected.calls,name+' calls');
 if(expected.ok){assert.equal(payload.http,200,name+' http');assert.equal(payload.data.good,1,name+' good');assert.equal(error,'',name+' status error');}
 else{assert.equal(payload.http,400,name+' http');assert.match(error,expected.match,name+' error');assert.match(payload.error,expected.match,name+' ui error');}
 db.close();
 console.log('PASS',name,n,error.slice(0,175));
}
(async()=>{
 await scenario('transient 404 recovers',[new Error('HTTP 404'),true],{calls:2,ok:true});
 await scenario('persistent 404 shown',[new Error('HTTP 404'),new Error('HTTP 404')],{calls:2,ok:false,match:/Channel Test.*初回 HTTP 404、再試行 HTTP 404/});
 await scenario('persistent 500 shown',[new Error('HTTP 500'),new Error('HTTP 503')],{calls:2,ok:false,match:/初回 HTTP 500、再試行 HTTP 503/});
 await scenario('403 does not retry',[new Error('HTTP 403')],{calls:1,ok:false,match:/Channel Test.*HTTP 403/});
 await scenario('normal success once',[true],{calls:1,ok:true});
})().catch(e=>{console.error(e);process.exitCode=1});
