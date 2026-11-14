'use strict';
// AuditCapture01: opt-in, one-run capture for immutable local scoring audits.
// No scoring, ranking, allocation or timing decisions depend on this module.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const MARKER=path.join(__dirname,'run','scoring-audit-capture-once.json');
const PRIVATE=path.join(__dirname,'run','scoring-audit-private');
const MAX_ATTEMPTS=96;
const MAX_BYTES=3*1024*1024;
const ONE_DAY=24*60*60*1000;
const hash=s=>crypto.createHash('sha256').update(s,'utf8').digest('hex');

function begin(profileScope){
 // One specific normal profile only. Never consume marker on secret or other profiles.
 if(profileScope!==1)return null;
 try{
  const stat=fs.lstatSync(MARKER);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512)return null;
  const flag=JSON.parse(fs.readFileSync(MARKER,'utf8'));
  const age=Date.now()-Number(flag.createdAt);
  if(flag.mode!=='scoring-audit-one-run-v1'||flag.profileId!==1||!Number.isFinite(age)||age<0||age>ONE_DAY){
   if(Number.isFinite(age)&&age>ONE_DAY)try{fs.unlinkSync(MARKER)}catch{}
   return null;
  }
  fs.unlinkSync(MARKER); // at most one run, even if a crash occurs later
  return {start:new Date().toISOString(),runId:crypto.randomUUID(),events:[],bytes:0,overflow:false};
 }catch{return null}
}
function record(session,event){
 if(!session||session.overflow)return;
 try{
  if(session.events.length>=MAX_ATTEMPTS){session.overflow=true;return}
  const data={kind:event.kind,requestFingerprint:String(event.requestFingerprint||''),
   ...(event.kind==='request'?{strict:!!event.strict,batchIds:event.batchIds,body:event.body}:
     event.kind==='response'?{responseFingerprint:String(event.responseFingerprint||''),raw:event.raw}: 
     {errorCode:String(event.errorCode||'unknown')})};
  const length=Buffer.byteLength(JSON.stringify(data),'utf8');
  if(session.bytes+length>MAX_BYTES){session.overflow=true;return}
  session.events.push(data);session.bytes+=length;
 }catch{session.overflow=true}
}
async function finish(session,{model,items,modelDigest=null}={}){
 if(!session)return false;
 // Saving failures NEVER affect actual scoring. Capture is only supplementary evidence.
 try{
  if(session.overflow)return false; // Do not silently emit an incomplete replay dataset
  const directoryStat=fs.existsSync(PRIVATE)?fs.lstatSync(PRIVATE):null;
  if(directoryStat&&(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()))return false;
  fs.mkdirSync(PRIVATE,{recursive:true,mode:0o700});
  if(fs.lstatSync(PRIVATE).isSymbolicLink())return false;
  const src=fs.readFileSync(__filename);
  const stamp=session.start.replace(/[-:]/g,'').replace(/\..*$/,'').replace('T','-');
  const filename=`scoring-audit-${stamp}-${session.runId}.json`;
  const target=path.join(PRIVATE,filename);
  const temporary=target+'.writing';
  const doc={schema:'nestrill-scoring-audit-capture-v1',capturedAt:session.start,
   completedAt:new Date().toISOString(),runId:session.runId,scope:'normal-profile-1-only',
   semanticPhase:'completed',modelTag:String(model||''),modelDigest:typeof modelDigest==='string'?modelDigest:null,
   runtimeNode:process.version,auditModuleSha256:hash(src.toString('utf8')),
   semanticCodeSha256:hash(fs.readFileSync(path.join(__dirname,'ai-semantic.js'),'utf8')),
   transport:'POST http://127.0.0.1:11434/api/chat',
   warning:'PRIVATE: includes exact model prompts, interests, prior feedback and comments; no automatic upload; not encrypted.',
   events:session.events,normalizedScores:(items||[]).map(x=>({id:String(x.id),explicit:x.explicit,inferred:x.inferred,
     discovery:x.discovery,excluded:!!x.excluded,inferredBasis:x.inferredBasis,
     inferredHypothesisStatus:x.inferredHypothesisStatus}))};
  const output=JSON.stringify(doc,null,2);
  if(Buffer.byteLength(output)>MAX_BYTES+120000)return false;
  let created=false;
  try{
   fs.writeFileSync(temporary,output,{flag:'wx',mode:0o600});created=true;
   fs.renameSync(temporary,target);
  }finally{if(created&&fs.existsSync(temporary))try{fs.unlinkSync(temporary)}catch{}}
  return true;
 }catch{return false}
}
module.exports={begin,record,finish};
