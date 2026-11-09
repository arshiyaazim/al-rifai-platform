import {BusinessPaidView, type BusinessPaidViewParams} from '@/components/standalone/business-paid-view';

export const dynamic = 'force-dynamic';

export default async function BusinessPaidPage({searchParams}: {searchParams: Promise<BusinessPaidViewParams>}) {
  const params = await searchParams;
  return (
    <BusinessPaidView
      title="Business Paid Events"
      description="Verified business payments. This is not the financial ledger; POSTED status is shown separately."
      params={params}
    />
  );
}