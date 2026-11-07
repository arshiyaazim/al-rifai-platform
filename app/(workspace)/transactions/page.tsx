import {CashTransactionsView} from '@/components/standalone/cash-transactions-view';
export const dynamic = 'force-dynamic';
export default async function TransactionsPage({searchParams}: {searchParams: Promise<{q?: string; state?: string; page?: string; from?: string; to?: string}>}) {
  return <CashTransactionsView basePath="/transactions" title="Transactions" description="Source-linked Cash instructions and ledger. A posted row is an explicit posting, not a queued message." params={await searchParams} />;
}
