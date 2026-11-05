import {createHash} from "node:crypto";
import {database} from "@/lib/cash-portal";

const FREE_FAILURES=5;
const WINDOW_MS=15*60_000;
const MAX_DELAY_MS=30_000;
const RETENTION_MS=24*60*60_000;

const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const normalizedName=(value:unknown)=>typeof value==="string"?value.trim().toLowerCase():"";

type ThrottleRow={failures:number;window_started_at:string;delay_until:string};

export function loginThrottleDelayMs(failures:number):number{
  if(failures<=FREE_FAILURES)return 0;
  return Math.min(1_000*2**(failures-FREE_FAILURES-1),MAX_DELAY_MS);
}

export async function checkLoginThrottle(username:unknown):Promise<{waitMs:number}>{
  const name=normalizedName(username);
  if(!name)return{waitMs:0};
  try{
    const rows=await database().query<ThrottleRow>(
      "SELECT failures,window_started_at,delay_until FROM login_throttle_state WHERE key=$1",
      ["u|"+hash(name)]);
    const row=rows.rows[0];
    if(!row)return{waitMs:0};
    const now=Date.now();
    if(now-Date.parse(row.window_started_at)>WINDOW_MS)return{waitMs:0};
    return{waitMs:Math.min(Math.max(0,Date.parse(row.delay_until)-now),MAX_DELAY_MS)};
  }catch{
    return{waitMs:0};
  }
}

export async function recordLoginFailure(username:unknown):Promise<void>{
  const name=normalizedName(username);
  if(!name)return;
  const key="u|"+hash(name);
  try{
    const rows=await database().query<ThrottleRow>(
      "SELECT failures,window_started_at FROM login_throttle_state WHERE key=$1",[key]);
    const row=rows.rows[0];
    const now=Date.now();
    const fresh=!!row&&now-Date.parse(row.window_started_at)<=WINDOW_MS;
    const failures=fresh?Math.min(row!.failures+1,10_000):1;
    const windowStart=fresh?Date.parse(row!.window_started_at):now;
    await database().query(
      `INSERT INTO login_throttle_state(key,failures,window_started_at,delay_until,updated_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT (key) DO UPDATE SET failures=EXCLUDED.failures,
         window_started_at=EXCLUDED.window_started_at,
         delay_until=EXCLUDED.delay_until, updated_at=now()`,
      [key,failures,new Date(windowStart).toISOString(),new Date(now+loginThrottleDelayMs(failures)).toISOString()]);
    if(Math.random()<0.1)await pruneLoginThrottle();
  }catch{
    // Missing throttle schema or grants must never block authentication.
  }
}

export async function recordLoginSuccess(username:unknown):Promise<void>{
  const name=normalizedName(username);
  if(!name)return;
  try{
    await database().query("DELETE FROM login_throttle_state WHERE key=$1",["u|"+hash(name)]);
  }catch{
    // Missing throttle schema or grants must never block authentication.
  }
}

async function pruneLoginThrottle():Promise<void>{
  await database().query(
    "DELETE FROM login_throttle_state WHERE updated_at < now() - make_interval(secs => $1)",
    [RETENTION_MS/1000]);
}
