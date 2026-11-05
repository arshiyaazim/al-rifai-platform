import {validationIdentity} from '../../lib/validation-auth.mjs';
import {discardUnreadBody} from '../../lib/request-drain.mjs';
import {trustedWebPeer} from './web-peer.ts';
import {ScopedCallGateway} from './call-gateway.ts';
import {deploymentProfile} from './deployment-profile.ts';
import {BrokerReadTransport} from './broker-read.ts';
import {StoredHistoryMcp} from './stored-history-mcp.ts';
import {canonicalProgramCommandBoundary} from '../../lib/program-command-boundary.ts';
import {qualificationRosterReader} from './roster-context.ts';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {IdentityReviewService} from './service.ts';
import {PostgresCandidateRepository} from './repository.ts';
import {NativeMcpClient,NativeReadAdapter} from './native-intake.ts';
import {createCandidateApi} from './api.ts';
import {hash,CandidateError} from './contracts.ts';
import type {NativeBinding} from './native-intake.ts';
import {startLiveOwnerAccountantCashSync} from './live-cash.ts';
import {NativeLiveReader} from '../../lib/native-live-reader.ts';
// Qualification-only host. No DATABASE_URL, default account, bootstrap or production fallback.
export function readHostConfig(){
 const deployed=deploymentProfile();if(deployed)return deployed;
 if(process.env.ALRIFAI_REVIEW_QUALIFICATION!=='WF-FIX-02')throw new CandidateError('REVIEW_HOST_DISABLED',503);
 const config=JSON.parse(readFileSync('/qualification/disposable/host.json','utf8'));
 if(config.origin!=='https://localhost:3443'||config.socket!=='/tmp/alrifai-identity-review-wf-socket'||config.database!=='alrifai_identity_qualification_wf02'||!/^[a-f0-9]{64}$/.test(config.peerSecret))throw new CandidateError('QUALIFICATION_CONFIG_REQUIRED',503);
 if(process.env.ALRIFAI_INTEGRATION_QUALIFICATION==='IR-01'&&(config.user!=='ir_review_runtime'||config.transport!=='unix-broker'))throw new CandidateError('INTEGRATION_CONFIG_REQUIRED',503);
 return config as {origin:string;socket:string;database:string;peerSecret:string;dummyPasswordHash:string;user?:string;transport?:string};
}
function createHost(){
 const profile=deploymentProfile(),integrated=!!profile||process.env.ALRIFAI_INTEGRATION_QUALIFICATION==='IR-01';
 const config=readHostConfig(),fixture=JSON.parse(readFileSync(profile?.nativeManifest??'/qualification/disposable/native/manifest.json','utf8'));
 const bindings=Object.fromEntries(Object.entries(fixture.accounts as Record<string,{binding:NativeBinding}>).map(([account,value])=>[account,value.binding]));
 const workers=new Map<string,{child:ReturnType<typeof spawn>;pending:((v:unknown)=>void)|null;reject:((v:Error)=>void)|null;buffer:Buffer}>();
 const tool=(account:string,name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>=>{
  if(!['wa-01','wa-02'].includes(account)||!['get_native_account_identity','list_native_events'].includes(name))return Promise.reject(Error('TOOL_DENIED'));
  let worker=workers.get(account);
  if(!worker){
   const child=spawn('/app/whatsapp-mcp-server/.venv/bin/python',['/qualification/disposable_transport.py',account],{stdio:['pipe','pipe','ignore'],env:{NODE_ENV:'production',PYTHONDONTWRITEBYTECODE:'1',PATH:'/usr/bin:/bin'}});
   worker={child,pending:null,reject:null,buffer:Buffer.alloc(0)};workers.set(account,worker);const w=worker;
   const fail=()=>{w.reject?.(Error('MCP_UNAVAILABLE'));w.pending=null;w.reject=null;workers.delete(account);child.kill();};
   child.on('error',fail);child.on('exit',fail);
   child.stdout!.on('data',(chunk:Buffer)=>{w.buffer=Buffer.concat([w.buffer,chunk]);if(w.buffer.length>250000)return fail();const end=w.buffer.indexOf(10);if(end<0)return;const line=w.buffer.subarray(0,end);w.buffer=w.buffer.subarray(end+1);try{const data=JSON.parse(line.toString());if(data.error||w.buffer.length||!w.pending)return fail();const resolve=w.pending;w.pending=null;w.reject=null;resolve(data);}catch{fail();}});
  }
  if(worker.pending)return Promise.reject(Error('MCP_BUSY'));const w=worker;
  return new Promise((resolve,reject)=>{const abort=()=>w.child.kill();signal.addEventListener('abort',abort,{once:true});w.pending=v=>{signal.removeEventListener('abort',abort);resolve(v);};w.reject=e=>{signal.removeEventListener('abort',abort);reject(e);};w.child.stdin!.write(JSON.stringify({name,arguments:args})+'\n');});
 };
 const broker=integrated?new BrokerReadTransport():null;
 const history=broker?new StoredHistoryMcp((account,name,args,signal)=>broker.call(account,name,args,signal),bindings):null;
 // Live continuation uses the only message reader the bridge still exposes.
 // History is supplied by the approved backfill instead of the removed
 // list_messages / list_stored_messages tools.
 const nativeLive=broker?new NativeLiveReader({callTool:async(name,args)=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{return await broker.call('wa-01',name,args,controller.signal) as Record<string,unknown>;}
  finally{clearTimeout(timer);}
 }}):null;
 const client=new NativeMcpClient(broker?(account,name,args,signal)=>broker.call(account,name,args,signal):tool,bindings,profile?(profile.mode==='live'?'LIVE_NATIVE':'SIMULATED_NATIVE'):'DISPOSABLE_NATIVE');
 const pool=new pg.Pool({host:profile?.databaseHost??config.socket,database:config.database,user:integrated?config.user:'postgres',...(integrated?{password:readFileSync(profile?.passwordFile??'/qualification/disposable/auth/pg-password','utf8').trim()}:{}),max:4,options:'-c statement_timeout=3000 -c search_path=public',connectionTimeoutMillis:3000,idleTimeoutMillis:1000});
 const repository=new PostgresCandidateRepository(pool,{isolatedQualification:!profile});
 const service=new IdentityReviewService(repository,{dummyPasswordHash:config.dummyPasswordHash,callGateway:profile?.callBroker&&Object.keys(profile.callBroker).length?new ScopedCallGateway(profile.callBroker):undefined,programCommands:!!profile||process.env.ALRIFAI_ESCORT_COMMAND_QUALIFICATION==='WF-FIX-05'?canonicalProgramCommandBoundary:undefined,commandFresh:async(accountId,chatJid,sequence)=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{const page=await client.readNativePage({accountId,chatJid,cursor:'n1:'+client.binding(accountId).streamId+':'+hash(chatJid).slice(0,24)+':'+sequence+':0',limit:10,signal:controller.signal});return page.complete&&page.records.length===0;}finally{clearTimeout(timer);}},rosterReader:qualificationRosterReader(pool),nativeVisibility:refs=>client.visibility(refs),
  historyReader:history?(account,chat,after)=>history.readPage(account,chat,after):undefined,historySourceVerifier:history?.verify,
  verifyApproval:async(proof,pin,purpose)=>{if(profile){try{const r=await pool.query('SELECT EXISTS(SELECT 1 FROM identity_review_candidate.operator_decisions WHERE id=$1 AND pin=$2 AND purpose=$3 AND revoked=false) AS approved',[proof.decisionId,pin,purpose]);return proof.evidenceSha===pin&&r.rows[0]?.approved===true;}catch{return false;}}try{const approved=JSON.parse(readFileSync('/qualification/disposable/decisions.json','utf8'));return purpose==='CLAIM_VERIFY'&&approved[proof.decisionId]===pin&&proof.evidenceSha===pin;}catch{return false;}},
  nativeSource:async source=>{
   const accountId=String(source.accountId),chatJid=String(source.chatJid),seq=BigInt(String(source.sequence));
   const cursor='n1:'+client.binding(accountId).streamId+':'+hash(chatJid).slice(0,24)+':'+(seq-1n)+':'+seq;
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
   try{const page=await client.readNativePage({accountId,chatJid,cursor,limit:10,signal:controller.signal}),record=page.records[0];
    if(record?.sequence!==String(seq)||record.status!=='CONTENT'||record.envelope?.payload.sha256!==source.contentHash||record.envelopeHash!==source.envelopeHash)return null;
   return record.envelope?.payload.text??null;
   }finally{clearTimeout(timer);}
  }});
 const cashMode=process.env.ALRIFAI_LIVE_CASH_INTENT_CAPTURE;
 if(cashMode==='APPROVED_AUTO_POST')throw new CandidateError('LIVE_CASH_AUTO_POST_DISABLED',503);
 if(profile?.mode==='live'&&process.env.ALRIFAI_LIVE_CASH_SYNC==='1'&&cashMode==='APPROVED_REVIEW_ONLY'){
  if(!nativeLive)throw new CandidateError('LIVE_CASH_NATIVE_READER_REQUIRED',503);
  startLiveOwnerAccountantCashSync(pool,nativeLive);
 }
 if(profile?.callBroker&&Object.keys(profile.callBroker).length){const timer=setInterval(()=>void service.refreshCallPolicies().catch(()=>undefined),3000);timer.unref();}
 return {config,ready:async()=>{const r=await pool.query("SELECT current_database() AS database,current_user AS role,to_regclass('identity_review_candidate.records') IS NOT NULL AS installed");if(r.rows[0]?.database!==config.database||!r.rows[0]?.installed||integrated&&r.rows[0]?.role!=='ir_review_runtime')throw Error('HEALTH_UNAVAILABLE');},handler:createCandidateApi(service,{origin:config.origin,readAdapter:new NativeReadAdapter(service,client)})};
}
let host:ReturnType<typeof createHost>|undefined;
export async function handleHost(request:Request){
 try{
  if(!validationIdentity(request.headers.get('authorization')))return new Response('Private validation authentication required',{status:401,headers:{'WWW-Authenticate':'Basic realm="Al-Rifai private validation", charset="UTF-8"','Cache-Control':'no-store'}});
  host??=createHost();
  if(request.headers.get('host')!==new URL(host.config.origin).host||request.headers.get('x-wf02-peer')!==host.config.peerSecret)return Response.json({error:'HOST_PEER_DENIED'},{status:403,headers:{'Cache-Control':'no-store'}});
  const url=new URL(request.url);const trusted=new Request(host.config.origin+url.pathname+url.search,{method:request.method,headers:request.headers,signal:request.signal,...(!['GET','HEAD'].includes(request.method)?{body:request.body,duplex:'half' as never}:{})});
  try{return await host.handler(trusted,trustedWebPeer(request.headers,process.env.ALRIFAI_REVIEW_PROFILE==='B01-B03-LIVE'));}
  finally{await discardUnreadBody(trusted,url.pathname.endsWith('/reconciliation/imports')?23*1024*1024:32000);}
 }catch(error){return Response.json({error:error instanceof CandidateError?error.code:'REVIEW_HOST_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});}
}

// Starts the review-only live Cash continuation without waiting for a
// candidate-API request. The ingestion worker owns live Vessel/Cash message
// storage; this loop owns the Cash instruction projection, and both are
// idempotent on the bridge message identity.
export async function bootstrapLiveCashSync():Promise<{started:boolean;reason?:string}>{
 if(process.env.ALRIFAI_LIVE_CASH_SYNC!=='1')return {started:false,reason:'LIVE_CASH_SYNC_DISABLED'};
 if(process.env.ALRIFAI_LIVE_CASH_INTENT_CAPTURE!=='APPROVED_REVIEW_ONLY')return {started:false,reason:'LIVE_CASH_REVIEW_ONLY_MODE_REQUIRED'};
 host??=createHost();
 return {started:true};
}

export async function integrationQualificationHealth(){if(process.env.ALRIFAI_INTEGRATION_QUALIFICATION!=='IR-01'&&!deploymentProfile())throw Error('INTEGRATION_PROFILE_DISABLED');host??=createHost();await host.ready();return {status:'ok'};}
