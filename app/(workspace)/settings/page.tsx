import {listAccounts} from '@/lib/standalone/finance';
import {integrationStatus, listChats} from '@/lib/standalone/whatsapp';
import {money, pageUser, when} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {listUsers} from '@/lib/standalone/users';
import {ActionForm} from '@/components/standalone/action-form';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await pageUser();
  const canManageAccounts = can(user as never, 'cash.account.manage');
  const canManageWhatsapp = can(user as never, 'whatsapp.manage');
  const canRouteWhatsapp = can(user as never, 'whatsapp.route');
  const [accounts, status] = await Promise.all([listAccounts(), integrationStatus()]);
  const users = user.superAdmin ? await listUsers() : [];
  const chats = await Promise.all((status.accounts as Array<{id: string}>).map((account) => listChats(account.id)));

  return (
    <>
      <div className="page-head">
        <div><h1>Settings / Integrations</h1><p className="muted">Accounts, WhatsApp relay, and your own credentials.</p></div>
      </div>

      <div className="split">
        <section className="card">
          <h3>Accounts</h3>
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Balance</th></tr></thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}><td>{account.code}</td><td>{account.name}</td><td>{account.type}</td><td>{money(account.balance_minor)}</td></tr>
              ))}
              {!accounts.length ? <tr><td colSpan={4} className="muted">No accounts.</td></tr> : null}
            </tbody>
          </table>
          {canManageAccounts ? (
            <ActionForm
              title="Add account"
              endpoint="/api/finance"
              action="account.create"
              submitLabel="Create account"
              fields={[
                {name: 'code', label: 'Code', required: true, placeholder: 'BANK1'},
                {name: 'name', label: 'Name', required: true},
                {name: 'type', label: 'Type', type: 'select', options: [
                  {value: 'CASH', label: 'Cash'}, {value: 'BANK', label: 'Bank'},
                  {value: 'MOBILE', label: 'Mobile wallet'}, {value: 'OTHER', label: 'Other'}]},
                {name: 'currency', label: 'Currency', defaultValue: 'BDT'},
                {name: 'openingBalanceMinor', label: 'Opening balance (paisa)', type: 'number'},
              ]}
            />
          ) : null}
        </section>

        <section className="card">
          <h3>WhatsApp relay</h3>
          <p className="muted">
            The application connects to an existing MCP relay over a unix socket. Pairing, sessions and the bridge
            itself stay with your infrastructure; nothing is bundled here.
          </p>
          <table>
            <thead><tr><th>Account</th><th>Enabled</th><th>Chats</th><th>Pending</th></tr></thead>
            <tbody>
              {(status.accounts as Array<{id: string; label: string; enabled: boolean; chats: string; pending: string}>).map((account) => (
                <tr key={account.id}>
                  <td>{account.label}<div className="muted">{account.id}</div></td>
                  <td>{account.enabled ? 'yes' : 'no'}</td>
                  <td>{account.chats}</td>
                  <td>{account.pending}</td>
                </tr>
              ))}
              {!(status.accounts as unknown[]).length ? <tr><td colSpan={4} className="muted">No relay configured.</td></tr> : null}
            </tbody>
          </table>
          {(status.cursors as Array<{account_id: string; chat_jid: string; last_error: string}>).length ? (
            <div className="error">
              {(status.cursors as Array<{account_id: string; chat_jid: string; last_error: string}>).map((cursor) => (
                <div key={`${cursor.account_id}-${cursor.chat_jid}`}>{cursor.account_id}/{cursor.chat_jid}: {cursor.last_error}</div>
              ))}
            </div>
          ) : null}

          {canManageWhatsapp ? (
            <ActionForm
              title="Configure relay account"
              endpoint="/api/whatsapp"
              action="configure"
              submitLabel="Save relay"
              fields={[
                {name: 'id', label: 'Account id', required: true, placeholder: 'primary'},
                {name: 'label', label: 'Label', required: true},
                {name: 'socketPath', label: 'Socket path', placeholder: '/run/whatsapp/mcp.sock'},
                {name: 'tokenFile', label: 'Reader token file', placeholder: '/run/secrets/wa-reader'},
                {name: 'accountJid', label: 'Account JID'},
                {name: 'adminJids', label: 'Admin JIDs (comma separated)'},
                {name: 'chatJid', label: 'Authorized chat JID'},
                {name: 'purpose', label: 'Chat purpose', type: 'select', options: [
                  {value: 'BOTH', label: 'Orders + cash'}, {value: 'ORDERS', label: 'Orders only'},
                  {value: 'CASH', label: 'Cash only'}]},
              ]}
            />
          ) : null}
          {canManageWhatsapp || canRouteWhatsapp ? (
            <div className="split">
              {canManageWhatsapp ? (
                <>
                  <ActionForm compact endpoint="/api/whatsapp" action="health" submitLabel="Test connection"
                    fields={[{name: 'accountId', label: 'Account id', required: true}]} />
                  <ActionForm compact endpoint="/api/whatsapp" action="sync" submitLabel="Sync messages"
                    fields={[{name: 'accountId', label: 'Account id', required: true}]} />
                </>
              ) : null}
              {canRouteWhatsapp ? (
                <ActionForm compact endpoint="/api/whatsapp" action="process" submitLabel="Process staged" fields={[]} />
              ) : null}
            </div>
          ) : null}
        </section>
      </div>

      <div className="split">
        <section className="card">
          <h3>Your session</h3>
          <p className="muted">{user.displayName} · {user.username} · {user.role}</p>
          <ActionForm
            title="Change password"
            endpoint="/api/auth/password"
            submitLabel="Update password"
            fields={[
              {name: 'newPassword', label: 'New password (min 8)', required: true},
              {name: 'confirmPassword', label: 'Confirm password', required: true},
            ]}
          />
        </section>
        <section className="card">
          <h3>Authorized chats (first 100 per account)</h3>
          <table>
            <thead><tr><th>Account</th><th>Chat</th><th>Purpose</th></tr></thead>
            <tbody>
              {chats.flat().map((chat) => {
                const item = chat as unknown as {account_id: string; chat_jid: string; purpose: string};
                return <tr key={`${item.account_id}-${item.chat_jid}`}><td>{item.account_id}</td><td>{item.chat_jid}</td><td>{item.purpose}</td></tr>;
              })}
              {!chats.flat().length ? <tr><td colSpan={3} className="muted">No authorized chats.</td></tr> : null}
            </tbody>
          </table>
        </section>
      </div>

      {user.superAdmin ? (
        <section className="card" style={{marginTop: 18}}>
          <h3>User administration</h3>
          <p className="muted">
            Super Admin only. Passwords are hashed before storage; a reset revokes every session of the target account.
            The last active administrator cannot be deactivated or demoted.
          </p>
          <table>
            <thead><tr><th>User</th><th>Role</th><th>Active</th><th>Must change password</th><th>Last seen</th></tr></thead>
            <tbody>
              {users.map((row) => (
                <tr key={row.id}>
                  <td>{row.display_name}<div className="muted">{row.username}</div></td>
                  <td>{row.role}</td>
                  <td>{row.active ? 'yes' : 'no'}</td>
                  <td>{row.must_change_password ? 'yes' : 'no'}</td>
                  <td>{when(row.last_seen_at)}</td>
                </tr>
              ))}
              {!users.length ? <tr><td colSpan={5} className="muted">No users.</td></tr> : null}
            </tbody>
          </table>
          <div className="split">
            <ActionForm
              title="Create user"
              endpoint="/api/users"
              submitLabel="Create user"
              fields={[
                {name: 'username', label: 'Username', required: true},
                {name: 'displayName', label: 'Display name'},
                {name: 'role', label: 'Role', type: 'select', options: [
                  {value: 'USER', label: 'User'}, {value: 'ADMIN', label: 'Admin'}]},
                {name: 'password', label: 'Initial password (min 8)', required: true},
              ]}
            />
            <ActionForm
              title="Update user"
              endpoint="/api/users"
              submitLabel="Save user"
              hidden={{action: 'update'}}
              fields={[
                {name: 'user', label: 'Username or id', required: true},
                {name: 'displayName', label: 'Display name'},
                {name: 'role', label: 'Role', type: 'select', options: [
                  {value: '', label: 'Unchanged'}, {value: 'USER', label: 'User'}, {value: 'ADMIN', label: 'Admin'}]},
                {name: 'active', label: 'Active', type: 'select', options: [
                  {value: '', label: 'Unchanged'}, {value: 'true', label: 'Active'}, {value: 'false', label: 'Inactive'}]},
              ]}
            />
            <ActionForm
              title="Reset password"
              endpoint="/api/users"
              submitLabel="Reset password"
              hidden={{action: 'reset-password'}}
              fields={[
                {name: 'user', label: 'Username or id', required: true},
                {name: 'password', label: 'New password (min 8)', required: true},
              ]}
            />
          </div>
        </section>
      ) : null}
    </>
  );
}
