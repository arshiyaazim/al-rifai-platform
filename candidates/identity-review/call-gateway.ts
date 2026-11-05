import http from 'node:http';
import {readFileSync,statSync} from 'node:fs';
import {CandidateError} from './contracts.ts';
import type {CallGateway,CallSetting,CallGatewayStatus} from './call-policy.ts';
/** Same private bridge/account; this token cannot call /api/send. */
export class ScopedCallGateway implements CallGateway{
 #endpoints:Record<string,{socket:string;token:string}>;
 constructor(endpoints:Record<string,{socket:string;token:string}>){this.#endpoints=endpoints;}
 #request(account:string,path:string,body?:unknown):Promise<CallGatewayStatus>{
  const endpoint=this.#endpoints[account];if(!endpoint)throw new CandidateError('CALL_ACCOUNT_NOT_CONFIGURED',503);
  const st=statSync(endpoint.token);if(!st.isFile()||(st.mode&0o027))throw new CandidateError('CALL_CREDENTIAL_DENIED',503);
  const token=readFileSync(endpoint.token,'utf8').trim();if(token.length<16)throw new CandidateError('CALL_CREDENTIAL_DENIED',503);
  return new Promise((resolve,reject)=>{
   const payload=body?JSON.stringify(body):null;
   const request=http.request({socketPath:endpoint.socket,path,method:payload?'POST':'GET',headers:{Host:'localhost:8080',Authorization:'Bearer '+token,...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})},timeout:3000},response=>{
    const chunks:Buffer[]=[];let bytes=0;response.on('data',(c:Buffer)=>{bytes+=c.length;if(bytes>160000)request.destroy();else chunks.push(c);});
    response.on('end',()=>{try{if(response.statusCode!==200)throw Error('CALL_GATEWAY_REJECTED');const value=JSON.parse(Buffer.concat(chunks).toString());if(value.accountId!==account||typeof value.connected!=='boolean'||typeof value.effectiveEnabled!=='boolean'||!Array.isArray(value.recent))throw Error('CALL_GATEWAY_SCOPE_INVALID');resolve(value);}catch{reject(new CandidateError('CALL_GATEWAY_UNAVAILABLE',503));}});
   });request.on('timeout',()=>request.destroy());request.on('error',()=>reject(new CandidateError('CALL_GATEWAY_UNAVAILABLE',503)));if(payload)request.write(payload);request.end();
  });
 }
 sync(p:CallSetting,validUntil:number){const {authorizationEpoch,authorizationChat,...policy}=p;void authorizationEpoch;void authorizationChat;return this.#request(p.accountId,'/api/call-policy',{...policy,validUntil});}
 status(account:string){return this.#request(account,'/api/call-policy/status');}
}
