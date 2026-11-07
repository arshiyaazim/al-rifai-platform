import {CashPaymentsView} from '@/components/standalone/cash-payments-view';
export const dynamic = 'force-dynamic';
export default async function CashTransactionsPage({searchParams}: {searchParams: Promise<{
  q?: string; date?: string; from?: string; to?: string; employee?: string; employeeMobile?: string; source?: string; page?: string;
}>}) {
  return (
    <CashPaymentsView
      title="Cash Transactions"
      description="Posted payments filtered by payment date, employee and source. Amounts reconcile with the Cash summary cards."
      params={await searchParams}
    />
  );
}
