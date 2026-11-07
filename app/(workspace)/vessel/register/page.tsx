import {VesselRegisterView} from '@/components/standalone/vessel-register-view';
export const dynamic = 'force-dynamic';
export default async function Page({searchParams}: {searchParams: Promise<{q?: string; state?: string}>}) {
  return <VesselRegisterView title="Vessel Register" description="Vessel orders, assignments and lifecycle at the nested register URL." params={await searchParams} />;
}
