import {readFileSync,lstatSync} from 'node:fs';
import {CandidateError} from './contracts.ts';
export type DeploymentProfile={mode:'simulated-live'|'live';origin:string;socket:string;database:string;user:'ir_review_runtime';transport:'unix-broker';peerSecret:string;dummyPasswordHash:string;root:string;nativeManifest:string;rosterScope:string;passwordFile:string;databaseHost?:'vps-infra-postgres-1';callBroker?:Record<string,{socket:string;token:string}>;broker:Record<string,{socket:string;token:string}>};
export function deploymentProfile():DeploymentProfile|null{
 const selected=process.env.ALRIFAI_REVIEW_PROFILE;if(!selected)return null;
 if(!['B01-B03-SIMULATED','B01-B03-LIVE'].includes(selected)||process.env.DATABASE_URL)throw new CandidateError('DEPLOYMENT_PROFILE_DENIED',503);
 const simulated=selected==='B01-B03-SIMULATED',root=simulated?'/qualification/disposable':'/etc/vps/apps/al-rifai',path=root+'/review-host.json',s=lstatSync(path);
 if(!s.isFile()||s.isSymbolicLink()||s.size>32000||(!simulated&&(s.uid!==0||(s.mode&0o022)!==0)))throw new CandidateError('DEPLOYMENT_PROFILE_DENIED',503);
 const c=JSON.parse(readFileSync(path,'utf8')),origin=new URL(c.origin),testDatabase=process.env.ALRIFAI_RELEASE_QUALIFICATION_DATABASE;
 if(testDatabase&&(!simulated||!/^alrifai_identity_qualification_[a-z0-9_]+$/.test(testDatabase)))throw new CandidateError('QUALIFICATION_DATABASE_DENIED',503);
 if(c.mode!==(simulated?'simulated-live':'live')||c.database!==(testDatabase||'alrifai')||c.user!=='ir_review_runtime'||c.transport!=='unix-broker'||origin.protocol!=='https:'||origin.origin!==c.origin||origin.username||origin.password||(!simulated&&['localhost','127.0.0.1'].includes(origin.hostname))||!/^\/[A-Za-z0-9_./-]+$/.test(c.socket)||c.socket.includes('..')||!/^[a-f0-9]{64}$/.test(c.peerSecret)||typeof c.dummyPasswordHash!=='string'||c.dummyPasswordHash.length>1024)throw new CandidateError('DEPLOYMENT_PROFILE_DENIED',503);
 // Reuse the existing private PostgreSQL TCP endpoint; no engine/socket provisioning.
 if(c.databaseHost!==undefined&&(simulated&&!testDatabase||c.databaseHost!=='vps-infra-postgres-1'))throw new CandidateError('DEPLOYMENT_DATABASE_HOST_DENIED',503);
 if(simulated&&(c.origin!=='https://localhost:3443'||c.socket!=='/tmp/alrifai-identity-review-wf-socket'))throw new CandidateError('DEPLOYMENT_PROFILE_DENIED',503);
 const broker:DeploymentProfile['broker']={};
 for(const a of ['wa-01','wa-02']){
  const p=c.broker?.[a];if(!p)continue;
  const expectedSocket=simulated?root+'/broker/'+a+'.sock':'/var/lib/vps/whatsapp/'+a+'/control/mcp.sock',expectedToken=root+'/auth/'+a+'.token';
  if(p.socket!==expectedSocket||p.token!==expectedToken)throw new CandidateError('DEPLOYMENT_PROFILE_DENIED',503);broker[a]=p;
 }
 if(!Object.keys(broker).length)throw new CandidateError('DEPLOYMENT_PROFILE_DENIED',503);
 const callBroker:Record<string,{socket:string;token:string}>={};
 for(const [a,p] of Object.entries(c.callBroker??{}) as Array<[string,{socket:string;token:string}]>){if(!['wa-01','wa-02'].includes(a)||p.socket!==(simulated?root+'/call/'+a+'.sock':'/var/lib/vps/whatsapp/'+a+'/control/call-policy.sock')||p.token!==root+'/auth/call-'+a+'.token')throw new CandidateError('CALL_PROFILE_DENIED',503);callBroker[a]=p;}
 return {...c,root,broker,callBroker,nativeManifest:root+'/native/manifest.json',rosterScope:root+'/roster-scope.json',passwordFile:root+'/auth/pg-password'};
}
export async function assertDeploymentDatabase(client:{query:(sql:string)=>Promise<{rows:Array<Record<string,unknown>>}>}){
 const p=deploymentProfile();if(!p)return false;
 const r=(await client.query("SELECT current_database() AS database,current_user AS role,current_setting('search_path') AS search_path,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,EXISTS(SELECT 1 FROM pg_class WHERE oid='public.programs'::regclass AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owns_programs,EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='identity_review_candidate' AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owns_schema FROM pg_roles WHERE rolname=current_user")).rows[0];
 if(r?.database!==p.database||r.role!==p.user||r.rolsuper!==false||r.rolcreatedb!==false||r.rolcreaterole!==false||r.rolbypassrls!==false||r.owns_programs!==false||r.owns_schema!==false||r.search_path!=='public')throw new CandidateError('DEPLOYMENT_DATABASE_DENIED',503);
 return true;
}

export function programLedgerAuthority():'ALRIFAI_OPERATIONAL'|'ALRIFAI_OPERATIONAL_QUALIFICATION_ONLY'{return deploymentProfile()?.mode==='live'?'ALRIFAI_OPERATIONAL':'ALRIFAI_OPERATIONAL_QUALIFICATION_ONLY';}
