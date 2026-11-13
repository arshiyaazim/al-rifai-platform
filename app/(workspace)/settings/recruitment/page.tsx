import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {RecruitmentDashboard} from '@/components/standalone/recruitment-dashboard';

export const dynamic = 'force-dynamic';

export default async function RecruitmentSettingsPage() {
  const user = await pageUser();
  if (!can(user as never, 'settings.manage')) {
    return <section className="card"><h3>Access denied</h3><p className="muted">ADMIN settings access is required.</p></section>;
  }
  return (
    <div className="vessel-workspace">
      <div className="page-head">
        <div>
          <h1>Recruitment AI</h1>
          <p className="muted">Bridge-2 inbound recruitment assistant. Live sending stays blocked until the Owner explicitly approves.</p>
        </div>
      </div>
      <RecruitmentDashboard />
    </div>
  );
}
