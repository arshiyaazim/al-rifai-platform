import {assertDeploymentDatabase,deploymentProfile} from './deployment-profile.ts';
import {CandidateError,digest} from './contracts.ts';
import type {RegistryRecord,ReviewItemV1,Occurrence,AuditEvent,NativeMessageEnvelopeV1} from './contracts.ts';
export type StaffAccount={id:string;username:string;personId:string;passwordHash:string;active:boolean;version:number;approvalRef:string};
export type Session={id:string;accountId:string;accountVersion:number;personId:string;csrfHash:string;createdAt:number;lastSeen:number;expiresAt:number};
export type CandidateState={epoch:number;registry:Record<string,RegistryRecord>;registryHistory:Record<string,RegistryRecord>;staff:Record<string,StaffAccount>;sessions:Record<string,Session>;attempts:Record<string,{failures:number;until:number}>;occurrences:Record<string,Occurrence>;sourceRevisions:Record<string,NativeMessageEnvelopeV1>;reviews:Record<string,ReviewItemV1>;reviewHistory:Record<string,ReviewItemV1>;audit:Record<string,AuditEvent>;observations:Record<string,unknown>;progress:Record<string,string|null>;operations:Record<string,{payloadHash:string;result:unknown}>;nativeReceipts:Record<string,Record<string,unknown>>;nativeBindings:Record<string,Record<string,unknown>>;identityClaims:Record<string,Record<string,unknown>>;claimHistory:Record<string,Record<string,unknown>>;nativeSuppression:Record<string,boolean>};
export const emptyState=():CandidateState=>({epoch:1,registry:{},registryHistory:{},staff:{},sessions:{},attempts:{},occurrences:{},sourceRevisions:{},reviews:{},reviewHistory:{},audit:{},observations:{},progress:{},operations:{},nativeReceipts:{},nativeBindings:{},identityClaims:{},claimHistory:{},nativeSuppression:{}});
export interface CandidateRepository{transaction<T>(work:(state:CandidateState,client?:CandidateSqlClient)=>Promise<T>|T,options?:{deadlineMs:number}):Promise<T>;}

/** Isolated reference repository. No globals, files, network or production fallback. */
export class MemoryRepository implements CandidateRepository{
 #state=emptyState();#tail:Promise<unknown>=Promise.resolve();
 async transaction<T>(work:(state:CandidateState,client?:CandidateSqlClient)=>Promise<T>|T):Promise<T>{
  const run=this.#tail.then(async()=>{const next=structuredClone(this.#state);const result=await work(next);this.#state=next;return structuredClone(result);});
  this.#tail=run.catch(()=>undefined);return run;
 }
}

export type CandidateSqlClient={query:(sql:string,args?:unknown[])=>Promise<{rows:Array<Record<string,unknown>>}>;release:()=>void};
export type InjectedPool={connect:()=>Promise<CandidateSqlClient>};
const collections=['registry','registryHistory','staff','sessions','attempts','occurrences','sourceRevisions','reviews','reviewHistory','audit','observations','progress','operations','nativeReceipts','nativeBindings','identityClaims','claimHistory','nativeSuppression'] as const;
/** Caller must provide a separately authorized pool. This module never creates one. */
export class PostgresCandidateRepository implements CandidateRepository{
 #pool:InjectedPool;#operatorQualification:boolean;
 constructor(pool:InjectedPool,{isolatedQualification,operatorQualification=false}:{isolatedQualification:boolean;operatorQualification?:boolean}){if(isolatedQualification!==true&&!deploymentProfile())throw new CandidateError('PRODUCTION_ACTIVATION_BLOCKED',503);this.#pool=pool;this.#operatorQualification=operatorQualification;if(operatorQualification&&process.env.B01_B03_OPERATOR_TEST!=='disposable')throw new CandidateError('OPERATOR_FIXTURE_DENIED',503);}
 async transaction<T>(work:(state:CandidateState,client?:CandidateSqlClient)=>Promise<T>|T,options?:{deadlineMs:number}):Promise<T>{
  const client=await this.#pool.connect(),deadline=options?Date.now()+options.deadlineMs:Infinity;
  const check=()=>{if(Date.now()>=deadline)throw new CandidateError('COMMAND_TRANSACTION_DEADLINE',503);};
  const guarded:CandidateSqlClient={release:()=>undefined,query:async(sql,args)=>{check();const value=await client.query(sql,args);check();return value;}};
  try{
   if(this.#operatorQualification){const identity=await guarded.query('SELECT current_database() AS database,current_user AS role');if(identity.rows[0]?.database!=='alrifai'||identity.rows[0]?.role!=='postgres')throw new CandidateError('OPERATOR_FIXTURE_DENIED',503);}
   else if(!await assertDeploymentDatabase(guarded)){const identity=await guarded.query('SELECT current_database() AS database');
   if(!/^alrifai_identity_qualification_[a-z0-9_]+$/.test(String(identity.rows[0]?.database)))throw new CandidateError('QUALIFICATION_DATABASE_REQUIRED',503);}
   await guarded.query("SET search_path TO public");
   await guarded.query('BEGIN');
   await guarded.query("SET LOCAL statement_timeout = '5000ms'");
   await guarded.query("SET LOCAL lock_timeout = '3000ms'");
   // Bounded pilot: serialize command transactions across every candidate process.
   await guarded.query('SELECT pg_advisory_xact_lock(1847461, 1)');
   const count=await guarded.query('SELECT count(*)::integer AS n FROM identity_review_candidate.records');
   if(Number(count.rows[0]?.n)>5000)throw new CandidateError('CANDIDATE_CAPACITY_REVIEW_REQUIRED',503);
   const result=await guarded.query('SELECT collection, id, payload FROM identity_review_candidate.records');
   const before=emptyState();
   for(const r of result.rows){const collection=String(r.collection),id=String(r.id);if(collection==='meta')before.epoch=Number((r.payload as {epoch:number}).epoch);else if(collections.includes(collection as typeof collections[number]))Object.assign(before[collection as typeof collections[number]],{[id]:r.payload});else throw new CandidateError('UNKNOWN_STORAGE_COLLECTION',503);}
   const next=structuredClone(before);const value=await work(next,guarded);
   let total=1,bytes=0;for(const c of collections)for(const record of Object.values(next[c])){total++;bytes+=Buffer.byteLength(JSON.stringify(record));}
   if(total>5000||bytes>32*1024*1024)throw new CandidateError('CANDIDATE_CAPACITY_REVIEW_REQUIRED',503);
   for(const c of collections){
    const previous=before[c] as Record<string,unknown>,current=next[c] as Record<string,unknown>;
    for(const id of Object.keys(previous))if(!(id in current)){
     if(!['sessions','attempts'].includes(c))throw new CandidateError('APPEND_ONLY_HISTORY_REQUIRED',409);
     await guarded.query('DELETE FROM identity_review_candidate.records WHERE collection=$1 AND id=$2',[c,id]);
    }
    for(const [id,payload] of Object.entries(current))if(!Object.hasOwn(previous,id)||digest(previous[id])!==digest(payload)){
     if(['audit','registryHistory','reviewHistory','sourceRevisions','nativeReceipts','claimHistory','operations'].includes(c)&&Object.hasOwn(previous,id))throw new CandidateError('APPEND_ONLY_HISTORY_REQUIRED',409);
     await guarded.query('INSERT INTO identity_review_candidate.records(collection,id,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(collection,id) DO UPDATE SET payload=EXCLUDED.payload',[c,id,JSON.stringify(payload)]);
    }
   }
   await guarded.query("INSERT INTO identity_review_candidate.records(collection,id,payload) VALUES('meta','epoch',$1::jsonb) ON CONFLICT(collection,id) DO UPDATE SET payload=EXCLUDED.payload",[JSON.stringify({epoch:next.epoch})]);
   check();await client.query('COMMIT');return structuredClone(value);
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
 }
}
