import {pbkdf2,randomBytes,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {CandidateError,hash} from './contracts.ts';
import type {CandidateState,StaffAccount,Session} from './repository.ts';
const derive=promisify(pbkdf2);
export const SESSION_IDLE_MS=30*60*1000,SESSION_ABSOLUTE_MS=8*60*60*1000;
export async function hashPassword(password:string){
 if(typeof password!=='string'||password.length<15||Buffer.byteLength(password)>256)throw new CandidateError('PASSWORD_LENGTH_INVALID');
 const salt=randomBytes(16).toString('hex');const key=await derive(password,salt,600000,32,'sha256');return `pbkdf2-sha256:600000:${salt}:${key.toString('hex')}`;
}
export function validPasswordHash(value:string){return /^pbkdf2-sha256:600000:[a-f0-9]{32}:[a-f0-9]{64}$/.test(value);}
export async function verifyPassword(password:string,encoded:string){
 if(typeof password!=='string'||Buffer.byteLength(password)>256||!validPasswordHash(encoded))return false;
 const [,iterations,salt,expected]=encoded.split(':');const key=await derive(password,salt,Number(iterations),32,'sha256');return timingSafeEqual(key,Buffer.from(expected,'hex'));
}
export function issueSession(state:CandidateState,account:StaffAccount,now:number){
 const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex'),id=hash(token);
 const session:Session={id,accountId:account.id,accountVersion:account.version,personId:account.personId,csrfHash:hash(csrf),createdAt:now,lastSeen:now,expiresAt:now+SESSION_ABSOLUTE_MS};
 state.sessions[id]=session;return {token,csrf,expiresAt:session.expiresAt,personId:account.personId,username:account.username};
}
export type Credentials={token:string;csrf?:string};
export function authenticate(state:CandidateState,credentials:Credentials,now:number,mutation=false){
 if(!/^[a-f0-9]{64}$/.test(credentials.token??''))throw new CandidateError('AUTHENTICATION_REQUIRED',401);
 const s=state.sessions[hash(credentials.token)];const account=s?state.staff[s.accountId]:undefined;
 const person=s?state.registry[s.personId]:undefined;
 if(!s||!account?.active||account.version!==s.accountVersion||!person||person.kind!=='person'||person.status!=='VERIFIED'||now>=s.expiresAt||now-s.lastSeen>=SESSION_IDLE_MS||now<s.lastSeen)throw new CandidateError('SESSION_EXPIRED_OR_REVOKED',401);
 if(mutation&&(!/^[a-f0-9]{64}$/.test(credentials.csrf??'')||!timingSafeEqual(Buffer.from(hash(credentials.csrf!),'hex'),Buffer.from(s.csrfHash,'hex'))))throw new CandidateError('CSRF_DENIED',403);
 s.lastSeen=now;return {personId:s.personId,accountId:s.accountId,username:account.username,session:s};
}
