import {lazyEvidence} from "@/lib/evidence";
import type {OperationsArchive} from "@/lib/evidence-types";
const sources=lazyEvidence<OperationsArchive>("operations.json");
import {database} from '@/db/raw';
import type {CashRow} from '@/lib/operations';
import {accountsCash,accountsImportSummary} from '@/lib/accounts-snapshot';
import {cashNotice} from '@/lib/cash-data';
import {liveCashCoverage,liveCashRows} from '@/lib/live-cash-read';

// Archive separation is by provenance, not by message date.
//  - Current  : canonical records published from the approved backfill only.
//  - Archive  : every pre-transition record (legacy live rows, stored archive
//               rows and the owner-confirmed Excel/snapshot projection).
// No row is deleted, rewritten or truncated by this split.

const EMPTY_SUMMARY={...accountsImportSummary};

export async function loadCashSnapshot(){
 const live=await liveCashRows('CURRENT');
 const coverage=await liveCashCoverage('CURRENT');
 const notice=coverage.last_date
  ? `Current view: canonical records from the approved WA-01 backfill through ${coverage.last_date} (Asia/Dhaka). Pre-transition records are held in Archive Records for Cash and are excluded from these totals.`
  : 'Current view is empty: no canonical Cash record has been published yet. All pre-transition records are preserved in Archive Records for Cash.';
 return {
  rows:live,
  checkedAt:new Date().toISOString(),
  notice,
  sourceLabel:'Canonical WA-01 backfill · Owner → Accountant',
  importSummary:{...EMPTY_SUMMARY,updatedAt:coverage.last_date??EMPTY_SUMMARY.updatedAt,sourceMessages:Number(coverage.messages),accountsQualifiedRows:live.length},
 };
}

export async function loadCashArchiveSnapshot(){
 const result=await database().all('SELECT details FROM site_cash_archive');
 const rows=new Map<string,CashRow>();
 for(const r of [...sources.cash,...sources.excel])rows.set(r.id,r as CashRow);
 for(const r of result.results){const item=JSON.parse(String(r.details)) as CashRow;if(!item.id||!Number.isSafeInteger(item.amountCents)||!Array.isArray(item.issues))throw new Error('Invalid cash archive record');rows.set(item.id,item);}
 const legacyLive=await liveCashRows('ARCHIVE');
 const coverage=await liveCashCoverage('ARCHIVE');
 const qualified=await accountsCash();
 const archived=[...rows.values()].map((r):CashRow=>({...r,identityVerified:false,issues:[...r.issues,'Legacy source identity/number-role verification is pending']}));
 return {
  rows:archived.concat(legacyLive.length?legacyLive:qualified),
  checkedAt:new Date().toISOString(),
  notice:coverage.last_date
   ? `Archive view: pre-transition records preserved by provenance, through ${coverage.last_date} (Asia/Dhaka). Archive is read-only and is never counted in Current totals.`
   : cashNotice,
  sourceLabel:'Archive · pre-transition records (read-only)',
  importSummary:{...accountsImportSummary,updatedAt:coverage.last_date??accountsImportSummary.updatedAt,sourceMessages:Number(coverage.messages),accountsQualifiedRows:legacyLive.length},
 };
}
