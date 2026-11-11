import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {ApiKeysTable} from '@/components/standalone/api-keys-table';

export const dynamic = 'force-dynamic';

export default async function ApiKeysPage() {
  const user = await pageUser();
  if (!can(user as never, 'settings.manage')) {
    return <section className="card"><h3>Access denied</h3><p className="muted">ADMIN settings access is required.</p></section>;
  }
  return (
    <div className="vessel-workspace">
      <div className="page-head">
        <div>
          <h1>API Keys / এপিআই কী</h1>
          <p className="muted">Manage Gemini, OpenAI and other AI API keys. Keys are shown masked; the full value is never returned.</p>
        </div>
      </div>
      <ApiKeysTable />
    </div>
  );
}
