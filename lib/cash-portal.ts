import pg from "pg";
import {createHash,randomBytes,timingSafeEqual} from "node:crypto";
import {createPool} from "../db/postgres.mjs";

// Hashing lives in one module (lib/password-hash.ts) and is re-exported here so
// existing call sites and the reset CLI share a single implementation.
export {hashPassword,hashBootstrapPassword,verifyPassword} from "./password-hash.ts";

const SESSION_MS=8*60*60*1000;
const IDLE_MS=30*60*1000;
const COOKIE="__Host-alrifai_cash";
let db:pg.Pool|undefined;

export type CashUser={id:string;username:string;role:"ADMIN"|"USER";displayName:string;email:string|null;mobile:string|null;whatsappNumber:string|null;mustChangePassword:boolean;active:boolean;lastSeenAt:string|null};
type UserRow={id:string;username:string;password_hash:string;role:"ADMIN"|"USER";display_name:string;email:string|null;mobile:string|null;whatsapp_number:string|null;must_change_password:boolean;active:boolean;last_seen_at:Date|null;version:number};
type SessionRow=UserRow&{session_id:string;csrf_hash:string;session_last_seen_at:Date;expires_at:Date};

function pool(){
 if(db)return db;
 // The Cash portal uses the least-privilege review role, like the other
 // read/write runtime paths. Connection details come from the environment.
 db=createPool({readOnly:false,role:'review',max:5,applicationName:'al-rifai-cash-portal'});
 return db;
}
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
export const sessionCookie=COOKIE;
export function hashToken(value:string){return digest(value);}
export function publicUser(row:UserRow):CashUser{return {id:row.id,username:row.username,role:row.role,displayName:row.display_name,email:row.email,mobile:row.mobile,whatsappNumber:row.whatsapp_number,mustChangePassword:row.must_change_password,active:row.active,lastSeenAt:row.last_seen_at?.toISOString()??null};}
export function json(data:unknown,status=200,headers?:HeadersInit){return Response.json(data,{status,headers});}
export function noStoreHeaders(){return {"Cache-Control":"no-store"};}
export function cookieHeader(token:string){return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS/1000}`;}
export function clearCookie(){return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`}
function originAllowed(request:Request){
 const origin=request.headers.get("origin");
 const configured=process.env.ALRIFAI_CASH_ORIGIN||"https://alrifai.iamazim.com";
 return origin===configured;
}
export function requireOrigin(request:Request){if(!originAllowed(request))throw new CashPortalError("ORIGIN_DENIED",403);}
export function bodyString(value:unknown,max=320){return typeof value==="string"&&value.length<=max?value.trim():undefined;}
export function bodyOptional(value:unknown,max=320){if(value===undefined)return undefined;return typeof value==="string"&&value.length<=max?value.trim():null;}
function cookieToken(request:Request){const raw=request.headers.get("cookie")||"";const hit=raw.split(";").map(v=>v.trim()).find(v=>v.startsWith(`${COOKIE}=`));const token=hit?.slice(COOKIE.length+1);return token&&/^[a-f0-9]{64}$/.test(token)?token:null;}
export class CashPortalError extends Error{
 readonly code:string;
 readonly status:number;
 constructor(code:string,status=400){super(code);this.name='CashPortalError';this.code=code;this.status=status;}
}
export function isCashSuperAdmin(user:Pick<CashUser,"id"|"role">){
 if(user.role!=="ADMIN"||!/^[a-f0-9]{64}$/.test(user.id))return false;
 const configured=process.env.ALRIFAI_CASH_SUPER_ADMIN_IDS;
 return typeof configured==="string"&&configured.split(",").some(id=>id.trim()===user.id);
}
export function requireCashSuperAdmin(user:Pick<CashUser,"id"|"role">){
 if(!isCashSuperAdmin(user))throw new CashPortalError("SUPER_ADMIN_REQUIRED",403);
}
// Session metadata only (client_ip column). Not a rate-limit key.
function clientAddress(request:Request){return (request.headers.get("x-forwarded-for")||"unknown").split(",")[0].trim().slice(0,80);}
async function getSession(request:Request){
 const token=cookieToken(request);if(!token)throw new CashPortalError("AUTHENTICATION_REQUIRED",401);
 const result=await pool().query<SessionRow>(`SELECT s.id AS session_id,s.csrf_hash,s.last_seen_at AS session_last_seen_at,s.expires_at,u.* FROM cash_portal_sessions s JOIN cash_portal_users u ON u.id=s.user_id WHERE s.id=$1`,[hashToken(token)]);
 const row=result.rows[0],now=Date.now();
 if(!row||!row.active||now>=row.expires_at.getTime()||now-row.session_last_seen_at.getTime()>=IDLE_MS)throw new CashPortalError("SESSION_EXPIRED",401);
 await pool().query("UPDATE cash_portal_sessions SET last_seen_at=now() WHERE id=$1",[row.session_id]);
 await pool().query("UPDATE cash_portal_users SET last_seen_at=now() WHERE id=$1",[row.id]);
 return {row,token};
}
export async function auth(request:Request,mutation=false){
 if(mutation)requireOrigin(request);
 const {row,token}=await getSession(request);
 if(mutation){const csrf=request.headers.get("x-csrf-token")||"";if(!/^[a-f0-9]{64}$/.test(csrf)||!timingSafeEqual(Buffer.from(hashToken(csrf),"hex"),Buffer.from(row.csrf_hash,"hex")))throw new CashPortalError("CSRF_DENIED",403);}
 return {user:publicUser(row),row,token};
}
export async function refreshCsrf(token:string){
 const csrf=randomBytes(32).toString("hex");
 await pool().query("UPDATE cash_portal_sessions SET csrf_hash=$2,last_seen_at=now() WHERE id=$1",[hashToken(token),hashToken(csrf)]);
 return csrf;
}
export async function createSession(request:Request,row:UserRow){
 const token=randomBytes(32).toString("hex"),csrf=randomBytes(32).toString("hex");
 await pool().query("INSERT INTO cash_portal_sessions(id,user_id,csrf_hash,expires_at,user_agent,client_ip) VALUES($1,$2,$3,$4,$5,$6)",[hashToken(token),row.id,hashToken(csrf),new Date(Date.now()+SESSION_MS),request.headers.get("user-agent")?.slice(0,500)??null,clientAddress(request)]);
 return {token,csrf,user:publicUser(row)};
}
export async function findUser(username:string){const result=await pool().query<UserRow>("SELECT * FROM cash_portal_users WHERE lower(username)=lower($1) AND active=true",[username]);return result.rows[0]??null;}
export async function userById(id:string){const result=await pool().query<UserRow>("SELECT * FROM cash_portal_users WHERE id=$1",[id]);return result.rows[0]??null;}
export async function audit(actor:string|null,target:string|null,action:string,details:unknown){await pool().query("INSERT INTO cash_portal_audit(id,actor_id,target_id,action,details) VALUES($1,$2,$3,$4,$5)",[digest(`${actor??"system"}:${target??"none"}:${action}:${Date.now()}:${randomBytes(8).toString("hex")}`),actor,target,action,JSON.stringify(details??{})]);}
/**
 * Revokes every session for an account except the caller's own token and returns
 * how many were removed. One implementation shared by the Cash Portal and the
 * unified/Admin password-change paths; when no token is known (defensive path)
 * every session is revoked.
 */
export async function revokeOtherSessions(userId:string,keepToken:string|null|undefined){
 const revoked=await pool().query<{n:number}>(
  `WITH gone AS (
     DELETE FROM cash_portal_sessions
     WHERE user_id=$1 AND ($2='' OR id<>$2)
     RETURNING 1
   ) SELECT count(*)::int AS n FROM gone`,
  [userId,keepToken?hashToken(keepToken):''],
 );
 return Number(revoked.rows[0]?.n??0);
}

export function database(){return pool();}
