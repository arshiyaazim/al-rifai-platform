import {programCommandSchema} from '../../lib/program-command-boundary.ts';
import {z} from 'zod';
import {CandidateError,domains,ownerProof} from './contracts.ts';
import type {Credentials} from './auth.ts';
import type {IdentityReviewService} from './service.ts';
type ReadAdapter={pull:(credentials:Credentials,input:{accountId:string;chatJid:string;cursor:string|null})=>Promise<unknown>};
const scope=z.object({accountId:z.string().regex(/^wa-0[12]$/),offset:z.coerce.number().int().min(0).max(5000).default(0)}).strict();
const version=z.number().int().nonnegative();
async function body(request:Request){
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new CandidateError('JSON_REQUIRED',415);
 const reader=request.body?.getReader();if(!reader)throw new CandidateError('BODY_REQUIRED');let bytes=0;const chunks:Uint8Array[]=[];
 try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>(new URL(request.url).pathname.endsWith('/reconciliation/imports')?23*1024*1024:32000))throw new CandidateError('BODY_TOO_LARGE',413);chunks.push(next.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(e){if(e instanceof CandidateError)throw e;throw new CandidateError('JSON_INVALID');}finally{await reader.cancel().catch(()=>undefined);}
}
export function createCandidateApi(service:IdentityReviewService,{origin,readAdapter}:{origin:string;readAdapter?:ReadAdapter}){
 const expected=new URL(origin);if(expected.pathname!=='/'||expected.search||expected.hash||expected.username||expected.password)throw new CandidateError('API_ORIGIN_INVALID');
 return async(request:Request,peerAddress:string):Promise<Response>=>{
  const json=(value:unknown,status=200,headers:Record<string,string>={})=>{if(Buffer.byteLength(JSON.stringify(value))>(new URL(request.url).pathname.startsWith('/candidate-api/reconciliation')?16*1024*1024:250000))throw new CandidateError('RESPONSE_BUDGET',503);return Response.json(value,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...headers}});};
  try{
   const url=new URL(request.url);if(url.origin!==expected.origin)throw new CandidateError('ORIGIN_DENIED',403);
   if(!url.pathname.startsWith('/candidate-api/'))throw new CandidateError('ENDPOINT_NOT_AVAILABLE',404);
   if([...new Set(url.searchParams.keys())].some(k=>url.searchParams.getAll(k).length!==1))throw new CandidateError('AMBIGUOUS_QUERY',400);
   const mutation=!['GET','HEAD'].includes(request.method);if(mutation&&request.headers.get('origin')!==expected.origin)throw new CandidateError('ORIGIN_DENIED',403);
   const path=url.pathname.replace(/^\/candidate-api/,'');
   const cookie=request.headers.get('cookie')??'',matches=[...cookie.matchAll(/(?:^|;\s*)__Host-alrifai_candidate=([^;]+)/g)];
   const credentials:Credentials={token:matches.length===1?matches[0][1]:'',csrf:request.headers.get('x-csrf-token')??undefined};
   if(mutation&&!['/session/login','/session/logout'].includes(path)&&process.env.ALRIFAI_RECONCILIATION_READ_ONLY==='1')throw new CandidateError('READ_ONLY_RECOVERY',503);
   if(path==='/session/login'&&request.method==='POST'){
    const input=z.object({username:z.string().min(3).max(40),password:z.string().min(1).max(256)}).strict().parse(await body(request));
    const result=await service.login(input.username,input.password,peerAddress);if(!result.ok)return json({error:result.code},result.status);
    const {token,...safe}=result;return json(safe,200,{'Set-Cookie':`__Host-alrifai_candidate=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`});
   }
   if(path==='/session/me'&&request.method==='GET')return json(await service.me(credentials));
   if(path==='/reconciliation'&&request.method==='GET')return json(await service.reconciliationRead(credentials,Object.fromEntries(url.searchParams)));
   if(path==='/reconciliation/records/export'&&request.method==='GET'){const d=await service.reconciliationRead(credentials,{...Object.fromEntries(url.searchParams),op:'record_export'});return new Response(JSON.stringify(d),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename=alrifai-canonical-records.json','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
   if(path==='/reconciliation/export'&&request.method==='GET'){const result=await service.reconciliationRead(credentials,{...Object.fromEntries(url.searchParams),op:'export'});return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="alrifai-private-reconciliation.json"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
   if(path.startsWith('/reconciliation/')&&request.method==='POST'&&process.env.ALRIFAI_RECONCILIATION_READ_ONLY==='1')throw new CandidateError('READ_ONLY_RECOVERY',503);
   if(path==='/reconciliation/decisions'&&request.method==='POST')return json(await service.reconciliationDecision(credentials,await body(request)));
   if(path==='/reconciliation/management'&&request.method==='POST')return json(await service.manageOwnerEntity(credentials,await body(request)));
   if(path==='/reconciliation/manual'&&request.method==='POST')return json(await service.manualRequest(credentials,await body(request)));
   if(path==='/reconciliation/imports'&&request.method==='POST')return json(await service.prepareImport(credentials,await body(request)));
   if(path==='/reconciliation/imports/confirm'&&request.method==='POST')return json(await service.confirmImport(credentials,await body(request)));
   if(/^\/reconciliation\/files\/[a-f0-9]{64}$/.test(path)&&request.method==='GET'){const f=await service.downloadOriginalFile(credentials,path.split('/').at(-1)!);return new Response(Buffer.from(f.bytes,'base64'),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(f.name),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}

   if(path==='/reconciliation/events'&&request.method==='GET'){
    await service.reconciliationRead(credentials,{op:'summary'});
    const encoder=new TextEncoder();let timer:ReturnType<typeof setInterval>|undefined;let busy=false,stopped=false;
    const stream=new ReadableStream({start(controller){controller.enqueue(encoder.encode('event: ready\ndata: {}\n\n'));timer=setInterval(()=>{if(busy||stopped)return;busy=true;void service.reconciliationRead(credentials,{op:'summary'}).then(result=>{if(!stopped)controller.enqueue(encoder.encode('event: refresh\ndata: '+JSON.stringify({at:Date.now(),counts:(result as {counts:unknown}).counts})+'\n\n'));}).catch(()=>{clearInterval(timer);if(!stopped){stopped=true;try{controller.close();}catch{}}}).finally(()=>{busy=false;});},20000);request.signal.addEventListener('abort',()=>{stopped=true;clearInterval(timer);try{controller.close();}catch{}},{once:true});},cancel(){stopped=true;clearInterval(timer);}});
    return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'private, no-store','X-Accel-Buffering':'no','Connection':'keep-alive'}});
   }

   if(path==='/business/extractions'&&request.method==='GET')return json(await service.historyExtractions(credentials,Object.fromEntries(url.searchParams)));
   if(path==='/business/history/status'&&request.method==='GET'){const v=z.object({accountId:z.enum(['wa-01','wa-02'])}).strict().parse(Object.fromEntries(url.searchParams));return json(await service.historyStatus(credentials,v.accountId));}
   if(path==='/business/history/pull'&&request.method==='POST'){const v=z.object({accountId:z.enum(['wa-01','wa-02']),chatJid:z.string().min(1).max(256),rescan:z.boolean().default(false)}).strict().parse(await body(request));return json(await service.historyPull(credentials,v));}
   if(path==='/session/logout'&&request.method==='POST')return json(await service.logout(credentials),200,{'Set-Cookie':'__Host-alrifai_candidate=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'});
   if(path==='/business/cash/access'&&request.method==='GET')return json(await service.cashAccess(credentials));
   if(path==='/business/cash/entries'&&request.method==='POST')return json(await service.createCashEntry(credentials,await body(request)),201);
   if(path==='/business/cash/post'&&request.method==='POST')return json(await service.postCashEntry(credentials,await body(request)));
   if(path==='/business/register'&&request.method==='GET')return json(await service.businessRegister(credentials,Object.fromEntries(url.searchParams)));
   if(path==='/workspace/data'&&request.method==='GET')return json(await service.workspaceData(credentials,Object.fromEntries(url.searchParams)));
   if(path==='/conversations/subjects'&&request.method==='GET'){const v=z.object({accountId:z.enum(['wa-01','wa-02'])}).strict().parse(Object.fromEntries(url.searchParams));return json(await service.conversationSubjects(credentials,v.accountId));}
   if(path==='/calls/settings'&&request.method==='GET'){const v=z.object({accountId:z.enum(['wa-01','wa-02'])}).strict().parse(Object.fromEntries(url.searchParams));return json(await service.callSettingStatus(credentials,v.accountId));}
   if(path==='/calls/settings'&&request.method==='POST')return json(await service.changeCallSetting(credentials,await body(request)));
   if(path==='/conversations/submit'&&request.method==='POST'){const v=z.object({accountId:z.string(),chatJid:z.string(),personId:z.string(),eventId:z.string().min(1).max(200),text:z.string().max(64000),kind:z.enum(['MESSAGE','EDIT']).optional(),targetEventId:z.string().max(200).optional()}).strict().parse(await body(request));return json(await service.submitConversation(credentials,v),201);}
   if(path==='/conversations/outcome'&&request.method==='GET'){const v=z.object({accountId:z.string(),chatJid:z.string(),eventId:z.string(),channel:z.enum(['FRONTEND','WHATSAPP'])}).strict().parse(Object.fromEntries(url.searchParams));return json(await service.conversationOutcome(credentials,v.accountId,v.chatJid,v.eventId,v.channel));}
   if(path==='/registry'&&request.method==='GET'){const q=scope.parse(Object.fromEntries(url.searchParams));return json(await service.registry(credentials,q.accountId,q.offset));}
   if(path==='/registry/history'&&request.method==='GET'){const q=scope.extend({id:z.string().max(128)}).parse(Object.fromEntries(url.searchParams));return json(await service.registryHistory(credentials,q.accountId,q.id));}
   if(path==='/registry/propose'&&request.method==='POST'){const v=z.object({accountId:z.string(),kind:z.enum(['person','relationship','binding','group','grant','vesselAlias']),data:z.unknown(),expectedVersion:version,expectedEpoch:version}).strict().parse(await body(request));return json(await service.propose(credentials,v.accountId,v.kind,v.data,v.expectedVersion,v.expectedEpoch),201);}
   if(path==='/registry/verify'&&request.method==='POST'){const v=z.object({accountId:z.string(),id:z.string(),expectedVersion:version,expectedEpoch:version,proof:ownerProof}).strict().parse(await body(request));return json(await service.verify(credentials,v.accountId,v.id,v.expectedVersion,v.expectedEpoch,v.proof));}
   if(path==='/registry/revoke'&&request.method==='POST'){const v=z.object({accountId:z.string(),id:z.string(),expectedVersion:version,expectedEpoch:version}).strict().parse(await body(request));return json(await service.revoke(credentials,v.accountId,v.id,v.expectedVersion,v.expectedEpoch));}
   if(path==='/reviews'&&request.method==='GET'){const v=scope.extend({domain:z.enum(domains)}).parse(Object.fromEntries(url.searchParams));return json(await service.reviews(credentials,v.accountId,v.domain,v.offset));}
   if(/^\/reviews\/[a-f0-9]{64}$/.test(path)){
    const id=path.split('/').at(-1)!;if(request.method==='GET')return json(await service.review(credentials,id));
    if(request.method==='PATCH'){const v=z.object({expectedVersion:version,expectedEpoch:version,operationId:z.string(),note:z.string().max(2000)}).strict().parse(await body(request));return json(await service.updateReview(credentials,id,v));}
   }
   if(/^\/reviews\/[a-f0-9]{64}\/program-history$/.test(path)&&request.method==='GET'){const q=z.object({offset:z.coerce.number().int().min(0).max(5000).default(0)}).strict().parse(Object.fromEntries(url.searchParams));return json(await service.programHistory(credentials,path.split('/')[2],q.offset));}
   if(/^\/reviews\/[a-f0-9]{64}\/program-preview$/.test(path)&&request.method==='POST'){
    const v=z.object({expectedVersion:version,expectedEpoch:version,expectedProgramVersion:version,command:programCommandSchema}).strict().parse(await body(request));return json(await service.programPreview(credentials,path.split('/')[2],v));
   }
   if(/^\/reviews\/[a-f0-9]{64}\/program-approve$/.test(path)&&request.method==='POST'){
    const v=z.object({expectedVersion:version,expectedEpoch:version,expectedProgramVersion:version,command:programCommandSchema,operationId:z.string().max(128),approvalDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await body(request));return json(await service.approveProgram(credentials,path.split('/')[2],v));
   }
   if(/^\/reviews\/[a-f0-9]{64}\/program-execute$/.test(path)&&request.method==='POST'){
    const v=z.object({approvalId:z.string().regex(/^[a-f0-9]{64}$/),operationId:z.string().max(128)}).strict().parse(await body(request));return json(await service.executeProgram(credentials,path.split('/')[2],v));
   }
   if(/^\/reviews\/[a-f0-9]{64}\/roster$/.test(path)&&request.method==='GET'){const q=z.object({programId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional()}).strict().parse(Object.fromEntries(url.searchParams));return json(await service.reviewRoster(credentials,path.split('/')[2],q.programId));}
   if(/^\/reviews\/[a-f0-9]{64}\/source$/.test(path)&&request.method==='GET'){
    const query=z.object({content:z.enum(['0','1']).default('0')}).strict().parse(Object.fromEntries(url.searchParams));return json(await service.reviewSource(credentials,path.split('/')[2],query.content==='1'));
   }
   if(/^\/reviews\/[a-f0-9]{64}\/actions$/.test(path)&&request.method==='POST'){
    const v=z.object({expectedVersion:version,expectedEpoch:version,operationId:z.string().max(128),action:z.enum(['CORRECT_FIELDS','MARK_REVIEW','NEEDS_CLARIFICATION']),fields:z.record(z.union([z.string().max(500),z.number().finite(),z.null()])).optional(),reason:z.string().min(1).max(2000),rosterContextHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),rosterProgramId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional()}).strict().parse(await body(request));return json(await service.actOnReview(credentials,path.split('/')[2],v));
   }
   if(/^\/reviews\/[a-f0-9]{64}\/history$/.test(path)&&request.method==='GET')return json(await service.reviewHistory(credentials,path.split('/')[2]));
   if(/^\/evidence\/[a-f0-9]{64}$/.test(path)&&request.method==='GET')return json(await service.evidence(credentials,path.split('/').at(-1)!));
   if(/^\/claims\/[a-f0-9]{64}$/.test(path)&&request.method==='GET')return json(await service.claim(credentials,path.split('/').at(-1)!));
   if(/^\/claims\/[a-f0-9]{64}\/verify$/.test(path)&&request.method==='POST'){
    const v=z.object({personId:z.string(),expectedVersion:version,expectedEpoch:version,proof:ownerProof}).strict().parse(await body(request));
    return json(await service.verifyClaim(credentials,path.split('/')[2],v));
   }
   if(path==='/intake/pull'&&request.method==='POST'){
    if(!readAdapter)throw new CandidateError('LIVE_MCP_INTEGRATION_NOT_CONFIGURED',503);
    const v=z.object({accountId:z.string(),chatJid:z.string(),cursor:z.string().max(500).nullable()}).strict().parse(await body(request));return json(await readAdapter.pull(credentials,v));
   }
   return json({error:'ENDPOINT_NOT_AVAILABLE'},405);
  }catch(error){if(error instanceof CandidateError)return json({error:error.code},error.status);if(error instanceof z.ZodError)return json({error:'INVALID_CONTRACT_INPUT'},400);return json({error:'CANDIDATE_REQUEST_FAILED'},500);}
 };
}
