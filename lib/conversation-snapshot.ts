import {lazyEvidence,lazyEvidenceSummary} from "@/lib/evidence";
import type {ConversationSnapshot} from "@/lib/evidence-types";
const snapshot=lazyEvidence<ConversationSnapshot>("conversation-snapshot.json");
import {database} from '@/db/raw';
import type {Program} from '@/lib/programs';
import type {CashRow,ReviewRow} from '@/lib/operations';
export type ImportedMessage={id:string;source:string;messageDate:string;time:string;sender:string;body:string;line:number;category:string;mediaNames:string[];sensitiveExcluded:boolean;chatKey:string};
export type ImportedProgram=Program&{evidence:{id:string;source:string;sourceRef:string;sourceLine:string;reason:string}[];aliases:string[];conflicts:{field:string;existing:string;incoming:string;sourceRow:string}[]};
export const importSummary=lazyEvidenceSummary(() => snapshot.summary);
export async function ensureConversationSnapshot(db=database()){
 const marker=await db.first<{contentHash:string}>('SELECT "contentHash" FROM site_source_snapshots WHERE id=$1',[snapshot.datasetId+':complete']);
 if(marker?.contentHash!==String(snapshot.chunks.length))throw new Error("Evidence must be explicitly imported before validation");
}
export type DatasetScopeKind='CURRENT'|'ARCHIVE';
// Datasets are classified by provenance in public.dataset_scope. An
// unclassified dataset remains CURRENT so adding a dataset never silently
// hides records; a classified ARCHIVE dataset is excluded from Current reads.
export async function importedRows<T>(kind:string,scope:DatasetScopeKind='CURRENT'):Promise<T[]>{const db=database();await ensureConversationSnapshot(db);const result=await db.all<{payload:string}>('SELECT s.payload FROM site_source_snapshots s LEFT JOIN public.dataset_scope d ON d.dataset_key=s."datasetId" WHERE s."datasetId"=$1 AND s.kind=$2 AND (($3=\'CURRENT\' AND (d.scope IS NULL OR d.scope=\'CURRENT\')) OR ($3=\'ARCHIVE\' AND d.scope=\'ARCHIVE\')) ORDER BY s.id',[snapshot.datasetId,kind,scope]);return result.results.flatMap(r=>JSON.parse(r.payload) as T[]);}
export const importedPrograms=(scope:DatasetScopeKind='CURRENT')=>importedRows<ImportedProgram>('programs',scope);
export const importedCash=(scope:DatasetScopeKind='CURRENT')=>importedRows<CashRow>('cash',scope);
export async function importedMessages(accounts=false){const rows=await importedRows<ImportedMessage>(accounts?'accountMessages':'messages');return rows.map(m=>({...m,source:importSummary.files.find(f=>f.key===m.chatKey)?.file??'Source unavailable'}));}
export async function importedAccountReviews():Promise<ReviewRow[]>{
 const [reviews,messages]=await Promise.all([importedRows<{id:string;sourceMessageId:string;reason?:string;reasonCode?:string}>('accountReviews'),importedMessages(true)]);const byId=new Map(messages.map(m=>[m.id,m]));
 return reviews.map(r=>{const m=byId.get(r.sourceMessageId);if(!m)throw new Error('Review source missing');return {...r,reason:r.reason??'Conversation identity is unverified; no Accounts parser or employee creation was run.',date:m.messageDate,time:m.time,body:m.body,sender:m.sender,line:m.line};});
}
