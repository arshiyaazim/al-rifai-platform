import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {listReleaseSlips} from '@/lib/standalone/release-slips';
import {ReleaseReview} from '@/components/standalone/release-review';

export const dynamic = 'force-dynamic';

export default async function ReleasePage() {
  const user = await pageUser();
  const canRelease = can(user as never, 'vessel.release');
  const slips = await listReleaseSlips();
  return (
    <div className="vessel-workspace">
      <div className="page-head">
        <div>
          <h1>Escort Release</h1>
        </div>
      </div>
      <ReleaseReview initial={slips} canRelease={canRelease} />
    </div>
  );
}
