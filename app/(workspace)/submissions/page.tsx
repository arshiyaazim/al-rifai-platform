import {CashSubmissionsView} from '@/components/standalone/cash-submissions-view';
export const dynamic = 'force-dynamic';
export default async function SubmissionsPage() {
  return <CashSubmissionsView title="My Submissions" />;
}
