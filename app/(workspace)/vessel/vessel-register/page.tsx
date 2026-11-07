import {VesselRegisterView} from '@/components/standalone/vessel-register-view';
export const dynamic = 'force-dynamic';
export default async function Page({searchParams}: {searchParams: Promise<{q?: string; state?: string}>}) {
  return <VesselRegisterView title="Vessel Register" description="Legacy nested Vessel Register URL." params={await searchParams} />;
}
