import {lazyEvidence,lazyEvidenceSummary} from "@/lib/evidence";
import type {AccountsSnapshot,ConversationSnapshot} from "@/lib/evidence-types";
const snapshot=lazyEvidence<AccountsSnapshot>("accounts-snapshot.json");
const original=lazyEvidence<ConversationSnapshot>("conversation-snapshot.json");
import {database} from '@/db/raw';
import type {CashRow,ReviewRow} from '@/lib/operations';
import type {ImportedMessage} from '@/lib/conversation-snapshot';
export const accountsImportSummary=lazyEvidenceSummary(() => snapshot.summary);

let sourceMessages:ImportedMessage[]|undefined;
export function accountsMessages(){
 if(!sourceMessages){
  const source=original.summary.files.find(f=>f.key==='mamun');
  if(source?.sha256!==snapshot.summary.sourceSha256)throw new Error('Accounts source hash mismatch');
  sourceMessages=original.chunks.filter(c=>c.kind==='accountMessages').flatMap(c=>JSON.parse(c.payload) as ImportedMessage[]).map(m=>({...m,source:source.file}));
  if(sourceMessages.length!==snapshot.summary.sourceMessages)throw new Error('Incomplete Accounts source envelopes');
 }
 return sourceMessages;
}
async function ensureAccountsSnapshot(db=database()){
 accountsMessages();
 const marker=await db.first<{contentHash:string}>('SELECT "contentHash" FROM site_source_snapshots WHERE id=$1',[snapshot.datasetId+':complete']);
 if(marker?.contentHash!==String(snapshot.chunks.length))throw new Error("Accounts evidence must be explicitly imported");
}
async function rows<T>(kind:string){const db=database();await ensureAccountsSnapshot(db);const result=await db.all<{payload:string}>('SELECT payload FROM site_source_snapshots WHERE "datasetId"=$1 AND kind=$2 ORDER BY id',[snapshot.datasetId,kind]);return result.results.flatMap(r=>JSON.parse(r.payload) as T[]);}
export async function accountsCash(){const messages=new Map(accountsMessages().map(m=>[m.id,m]));return (await rows<CashRow>('accountsCash')).map(r=>{const source=messages.get(r.sourceId);if(!source||source.sender!=='Muradul Azim')throw new Error('Qualified transaction source missing');return {...r,sourceText:source.body};});}
export async function accountsReviews():Promise<ReviewRow[]>{const messages=new Map(accountsMessages().map(m=>[m.id,m]));return (await rows<{id:string;sourceMessageId:string;reason:string;sourceLine?:number}>('accountsReviews')).map(r=>{const m=messages.get(r.sourceMessageId);if(!m)throw new Error('Accounts review source missing');return {...r,date:m.messageDate,time:m.time,body:m.body,sender:m.sender,line:r.sourceLine??m.line};});}
