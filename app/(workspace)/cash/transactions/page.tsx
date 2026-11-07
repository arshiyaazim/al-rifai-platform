import {CashTransactionsView} from '@/components/standalone/cash-transactions-view';
export const dynamic = 'force-dynamic';
export default async function CashTransactionsPage({searchParams}: {searchParams: Promise<{q?: string; state?: string; page?: string; from?: string; to?: string}>}) {
  return <CashTransactionsView basePath="/cash/transactions" title="Cash Transactions" description="Filtered Cash instructions and posting detail by source, employee, method and state." params={await searchParams} />;
}
