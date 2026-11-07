import {CashTransactionsView} from '@/components/standalone/cash-transactions-view';
export const dynamic = 'force-dynamic';
export default async function CashArchivePage({searchParams}: {searchParams: Promise<{q?: string; page?: string; ledgerPage?: string; from?: string; to?: string}>}) {
  return <CashTransactionsView basePath="/cash/archive" title="Cash Archive History" description="Posted Cash instructions and their immutable ledger entries." params={await searchParams} fixedState="POSTED" showLedger />;
}
