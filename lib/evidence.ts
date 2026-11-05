import {readFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import manifest from "@/docs/evidence-checksums.json";
const cache=new Map<string,unknown>();
export function loadEvidence<T>(name:string):T {
 if(cache.has(name))return cache.get(name) as T;
 const entry=manifest[name as keyof typeof manifest];
 if(!entry)throw new Error("Unknown evidence file");
 const bytes=readFileSync(join(process.env.ALRIFAI_EVIDENCE_DIR || "/var/lib/vps/al-rifai/evidence",name));
 if(createHash("sha256").update(bytes).digest("hex")!==entry.sha256)throw new Error("Evidence checksum mismatch: "+name);
 const value=JSON.parse(bytes.toString("utf8")) as T;cache.set(name,value);return value;
}
// Lazy access prevents private evidence becoming a build input or client bundle.
export function lazyEvidence<T extends object>(name:string):T{return lazyEvidenceSummary(()=>loadEvidence<T>(name));}
export function lazyEvidenceSummary<T extends object>(load:()=>T):T {
 return new Proxy({} as T,{get:(_target,key)=>Reflect.get(load(),key),ownKeys:()=>Reflect.ownKeys(load()),getOwnPropertyDescriptor:(_target,key)=>({...Object.getOwnPropertyDescriptor(load(),key),configurable:true})});
}
