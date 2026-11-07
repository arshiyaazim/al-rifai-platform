import {pageUser} from '@/lib/standalone/session';
import {AssistantConsole} from '@/components/standalone/assistant-console';

export const dynamic = 'force-dynamic';

export default async function AssistantPage() {
  const user = await pageUser();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Admin AI Assistant</h1>
          <p className="muted">Employee, Cash, Vessel and Attendance queries through scoped tools.</p>
        </div>
      </div>
      {user.role !== 'ADMIN' ? (
        <p className="error">Admin role required.</p>
      ) : (
        <AssistantConsole />
      )}
    </>
  );
}
