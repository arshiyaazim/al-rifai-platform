import {z} from 'zod';
import {CandidateError} from './contracts.ts';
import {authenticate} from './auth.ts';
import {authorize} from './routing.ts';
import type {Credentials} from './auth.ts';
import type {CandidateState,CandidateSqlClient} from './repository.ts';

// Fixed owner read projections, in the existing repository transaction/pool.
// No SQL identifiers or statements come from the browser. No archive import.
export const workspaceQuery=z.object({accountId:z.literal('wa-01'),view:z.enum(['programs','cash','payments','settlements','sources']),after:z.string().max(500).default('')}).strict();
const views={
 programs:{domain:'ESCORT',table:'public.programs',columns:['id','motherVessel','lighterVessel','escortName','escortMobile','masterMobile','destination','startDate','endDate','shift','status','source','revision'],label:'Program records',searchKey:'id'},
 cash:{domain:'ACCOUNTS',table:'public.site_cash_archive',columns:['id','date','source','employeePhone','name','method','amountCents'],label:'Stored cash references',searchKey:'id'},
 payments:{domain:'ACCOUNTS',table:'public.site_payment_drafts',columns:['id','actor','createdAt'],label:'Payment drafts',searchKey:'id'},
 settlements:{domain:'SETTLEMENT',table:'public.site_settlement_drafts',columns:['id','actor','createdAt'],label:'Settlement drafts',searchKey:'id'},
 sources:{domain:'IDENTITY',table:'public.site_source_snapshots',columns:['id','datasetId','kind','contentHash'],label:'Source index',searchKey:'id'},
} as const;
export async function readWorkspace(s:CandidateState,credentials:Credentials,raw:unknown,clock:()=>number,client?:CandidateSqlClient){
 const now=clock(),query=workspaceQuery.parse(raw),view=views[query.view];
 authorizeWorkspace(s,credentials,query,now);
 if(!client)throw new CandidateError('WORKSPACE_DATABASE_NOT_CONFIGURED',503);
 const columns=view.columns.map(c=>'left('+JSON.stringify(c)+'::text,512) AS '+JSON.stringify(c)).join(',');
 let result:{rows:Array<Record<string,unknown>>};
 try{result=await client.query('SELECT '+columns+' FROM '+view.table+' WHERE "id" > $1 ORDER BY "id" ASC LIMIT 26',[query.after]);}
 catch(e){const code=(e as {code?:string}).code;if(code==='42501'||code==='42P01')throw new CandidateError('WORKSPACE_DATABASE_SCOPE_NOT_READY',503);throw e;}
 authenticate(s,credentials,clock());
 if(Buffer.byteLength(JSON.stringify(result.rows))>120000)throw new CandidateError('WORKSPACE_RESPONSE_BUDGET',503);
 if(result.rows.some(r=>typeof r.id!=='string'||r.id.length>500))throw new CandidateError('WORKSPACE_ROW_CONTRACT',503);
 const rows=result.rows.slice(0,25),hasMore=result.rows.length>25;
 return {view:query.view,label:view.label,columns:view.columns,rows,nextAfter:hasMore?rows.at(-1)?.id:null,checkedAt:new Date(now).toISOString(),source:'CANONICAL_DATABASE_READ',readOnly:true,notice:query.view==='cash'?'Payment recipients are not automatically Employees. Stored references do not prove a current payment.':query.view==='sources'?'Source index only; original content stays in its authorized evidence path.':query.view==='payments'||query.view==='settlements'?'Drafts are not completed payments or settlements.':'Stored database records; a database read does not prove new live WhatsApp intake.'};
}

export function authorizeWorkspace(s:CandidateState,credentials:Credentials,query:{accountId:'wa-01';view:keyof typeof views},now:number){
 const actor=authenticate(s,credentials,now),view=views[query.view];
 const owner=Object.values(s.registry).some(r=>r.kind==='relationship'&&r.status==='VERIFIED'&&'personId' in r.data&&r.data.personId===actor.personId&&'kind' in r.data&&r.data.kind==='SUPER_ADMIN');
 const scope={accountId:query.accountId,domain:view.domain,chatJid:null,resourceId:'workspace-'+query.view};
 if(!owner||!authorize(s,actor.personId,'STAFF','workspace.read',scope).allowed)throw new CandidateError('WORKSPACE_SCOPE_DENIED',403);
 return actor;
}
