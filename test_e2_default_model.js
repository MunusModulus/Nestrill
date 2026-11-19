'use strict';
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {create}=require('./app/ai-external');
const sleep=t=>new Promise(r=>setTimeout(r,t));
async function test(variant, expected){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE profiles(id INTEGER PRIMARY KEY);
 CREATE TABLE ai_interest_lists(profile_id INTEGER PRIMARY KEY,terms_json TEXT,updated_at INTEGER);
 CREATE TABLE ai_exclusion_lists(profile_id INTEGER PRIMARY KEY,terms_json TEXT,updated_at INTEGER);
 CREATE TABLE ai_model_config(profile_id INTEGER PRIMARY KEY,model TEXT NOT NULL,updated_at INTEGER);
 CREATE TABLE ai_item_feedback(profile_id INTEGER,kind TEXT,item_id TEXT,rating INTEGER,comment TEXT,updated_at INTEGER);
 CREATE TABLE ai_external_feedback_meta(profile_id INTEGER,item_id TEXT,title TEXT,url TEXT,excerpt TEXT);
 CREATE TABLE articles(id INTEGER PRIMARY KEY,feed_id INTEGER,title TEXT,url TEXT,published INTEGER);
 CREATE TABLE profile_feeds(feed_id INTEGER,profile_id INTEGER);
 CREATE TABLE feeds(id INTEGER,url TEXT,site_url TEXT);
 INSERT INTO profiles(id) VALUES(1);
 INSERT INTO ai_interest_lists(profile_id,terms_json,updated_at) VALUES(1,'["パソコン"]',1000);
 `);
 if(variant!==null)db.prepare('INSERT INTO ai_model_config(profile_id,model,updated_at) VALUES(1,?,1000)').run(variant);
 const planning=[];
 const semantic={planDiscovery:async ({model})=>{planning.push(model);return []},summarizeE2Perf:()=>({calls:0,reportedCalls:0,byPhase:{}})};
 const api=create({db,semantic,fetchXml:async()=>'<rss><channel><title>empty</title></channel></rss>'});
 const started=api.start(1);assert.equal(started.started,true);
 for(let i=0;i<40;i++){
  const st=api.status(1);
  if(!st.running){assert(!st.error,st.error);break}
  await sleep(30);
 }
 const st=api.status(1);
 assert.equal(st.running,false,'job did not finish');
 assert.deepEqual(planning,expected ? [expected]: [],'unexpected LLM calls');
 console.log('PASS',variant===null?'unset':variant===''?'explicitly disabled':variant,'model planning calls:',JSON.stringify(planning));
 db.close();
}
(async()=>{await test(null,'gemma4:e4b-it-qat'); await test('','');await test('gemma4:e2b-it-qat','gemma4:e2b-it-qat')})().catch(e=>{console.error(e);process.exitCode=1});
