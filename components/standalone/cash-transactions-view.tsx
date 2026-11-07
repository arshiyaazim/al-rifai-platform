import Link from 'next/link';
import {pageUser, money, when} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {
  countInstructions, countLedger, listAccounts, listInstructions, listLedger,
} from '@/lib/standalone/finance';
import {ActionForm} from '@/components/standalone/action-form';

export type CashViewParams = {
  q?: string;
  state?: string;
  page?: string;
  ledgerPage?: string;
  from?: string;
  to?: string;
};

export async function CashTransactionsView({
  basePath, title, description, params, fixedState, showLedger = false,
}: {
  basePath: string;
  title: string;
  description: string;
  params: CashViewParams;
  fixedState?: string;
  showLedger?: boolean;
}) {
  const user = await pageUser();
  const canReview = can(user as never, 'cash.review');
  const canPost = can(user as never, 'cash.post');
  const canReverse = can(user as never, 'cash.reverse');
  const q = (params.q ?? '').trim();
  const state = fixedState ?? (params.state ?? '');
  const from = params.from ?? '';
  const to = params.to ?? '';
  const page = Math.max(1, Number(params.page) || 1);
  const ledgerPage = Math.max(1, Number(params.ledgerPage) || 1);
  const pageSize = 100;
  const ledgerSize = 50;
  const [accounts, instructions, total, ledger, ledgerTotal] = await Promise.all([
    listAccounts(),
    listInstructions({q, state: state || undefined, limit: pageSize, offset: (page - 1) * pageSize}),
    countInstructions({q, state: state || undefined}),
    showLedger
      ? listLedger({from: from || undefined, to: to || undefined, limit: ledgerSize, offset: (ledgerPage - 1) * ledgerSize})
      : Promise.resolve([]),
    showLedger ? countLedger({from: from || undefined, to: to || undefined}) : Promise.resolve(0),
  ]);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const ledgerPages = Math.max(1, Math.ceil(ledgerTotal / ledgerSize));
  const href = (overrides: Record<string, string | number>) => {
    const values: Record<string, string> = {};
    if (q) values.q = q;
    if (!fixedState && state) values.state = state;
    if (from) values.from = from;
    if (to) values.to = to;
    if (page > 1) values.page = String(page);
    if (ledgerPage > 1) values.ledgerPage = String(ledgerPage);
    for (const [key, value] of Object.entries(overrides)) {
      if (String(value) === '' || value === 1) delete values[key];
      else values[key] = String(value);
    }
    const search = new URLSearchParams(values).toString();
    return search ? `${basePath}?${search}` : basePath;
  };

  return (
    <>
      <div className="page-head">
        <div><h1>{title}</h1><p className="muted">{description}</p></div>
        <div className="row-actions">
          <Link href="/api/reports?type=cash">Export Cash CSV</Link>
          <Link href="/cash">Cash control →</Link>
        </div>
      </div>

      <form method="get" className="card form compact" style={{marginBottom: 18}}>
        <div className="grid">
          <label><span>Search payee</span><input name="q" defaultValue={q} placeholder="Name or mobile" /></label>
          {!fixedState ? (
            <label><span>State</span>
              <select name="state" defaultValue={state}>
                <option value="">All states</option>
                {['REVIEW','APPROVED','POSTED','REJECTED','VOID'].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          ) : null}
          {showLedger ? <label><span>Ledger from</span><input name="from" type="date" defaultValue={from} /></label> : null}
          {showLedger ? <label><span>Ledger to</span><input name="to" type="date" defaultValue={to} /></label> : null}
        </div>
        <button type="submit">Filter</button>
      </form>

      {canReview ? (
        <ActionForm
          title="Assign paying account (REVIEW only)"
          endpoint="/api/finance"
          action="instruction.account"
          submitLabel="Assign account"
          fields={[
            {name: 'id', label: 'Instruction ID', required: true},
            {name: 'accountId', label: 'Account', type: 'select', required: true,
              options: accounts.map((account) => ({value: account.id, label: `${account.code} — ${account.name}`}))},
          ]}
        />
      ) : null}

      <section className="card">
        <h3>{fixedState ?? 'Instructions'} ({total})</h3>
        <table>
          <thead><tr><th>Instruction</th><th>Date</th><th>Payee</th><th>Mobile</th><th>Account</th><th>Method</th><th>Amount</th><th>State</th><th>Source</th><th>Actions</th></tr></thead>
          <tbody>
            {instructions.map((instruction) => {
              const item = instruction as unknown as {
                id: string; employee_name: string; employee_mobile: string | null; method: string; amount_minor: string;
                state: string; created_at: string; account_code?: string | null; source_channel?: string | null;
                source_message_id?: string | null; source_block_key?: string | null;
              };
              return (
                <tr key={item.id}>
                  <td><Link href={`/cash/${item.id}`} style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.id}</Link></td>
                  <td style={{whiteSpace: 'nowrap'}}>{when(item.created_at)}</td>
                  <td>{item.employee_name}</td>
                  <td>{item.employee_mobile ?? '—'}</td>
                  <td>{item.account_code ?? <span className="muted">unassigned</span>}</td>
                  <td>{item.method}</td>
                  <td>{money(item.amount_minor)}</td>
                  <td><span className={`pill ${item.state === 'POSTED' ? 'ok' : item.state === 'REJECTED' || item.state === 'VOID' ? 'bad' : 'warn'}`}>{item.state}</span></td>
                  <td style={{fontSize: 11}}>
                    <div>{item.source_channel ?? 'WEB'}</div>
                    {item.source_message_id ? <div style={{fontFamily: 'ui-monospace, monospace'}}>{item.source_message_id}</div> : null}
                  </td>
                  <td>
                    {item.state === 'REVIEW' && canReview ? (
                      <div className="row-actions">
                        <ActionForm compact endpoint="/api/finance" action="instruction.approve" submitLabel="Approve" hidden={{id: item.id}} fields={[]} />
                        <ActionForm compact endpoint="/api/finance" action="instruction.reject" submitLabel="Reject" hidden={{id: item.id}} fields={[{name: 'reason', label: 'Reason', required: true}]} />
                      </div>
                    ) : item.state === 'APPROVED' && canPost ? (
                      <ActionForm compact endpoint="/api/finance" action="instruction.post" submitLabel="Post" hidden={{id: item.id}} fields={[]} />
                    ) : item.state === 'POSTED' && canReverse ? (
                      <ActionForm compact endpoint="/api/finance" action="instruction.reverse" submitLabel="Reverse" hidden={{id: item.id}} fields={[{name: 'reason', label: 'Reversal reason', required: true}]} />
                    ) : <span className="muted">—</span>}
                  </td>
                </tr>
              );
            })}
            {!instructions.length ? <tr><td colSpan={10} className="muted">No matching instructions.</td></tr> : null}
          </tbody>
        </table>
        {pages > 1 ? (
          <div className="row-actions">
            {page > 1 ? <Link href={href({page: page - 1})}>← Previous</Link> : null}
            <span className="muted">Page {page} / {pages}</span>
            {page < pages ? <Link href={href({page: page + 1})}>Next →</Link> : null}
          </div>
        ) : null}
      </section>

      {showLedger ? (
        <section className="card">
          <h3>Ledger ({ledgerTotal})</h3>
          <table>
            <thead><tr><th>Date</th><th>Account</th><th>Category</th><th>Direction</th><th>Amount</th></tr></thead>
            <tbody>
              {ledger.map((entry) => {
                const item = entry as unknown as {id: string; entry_date: string; account_code: string; category: string; direction: string; amount_minor: string};
                return (
                  <tr key={item.id}>
                    <td>{item.entry_date}</td><td>{item.account_code}</td><td>{item.category}</td><td>{item.direction}</td>
                    <td>{item.direction === 'CREDIT' ? '+' : '−'}{money(item.amount_minor)}</td>
                  </tr>
                );
              })}
              {!ledger.length ? <tr><td colSpan={5} className="muted">No ledger entries in this range.</td></tr> : null}
            </tbody>
          </table>
          {ledgerPages > 1 ? (
            <div className="row-actions">
              {ledgerPage > 1 ? <Link href={href({ledgerPage: ledgerPage - 1})}>← Previous ledger</Link> : null}
              <span className="muted">Page {ledgerPage} / {ledgerPages}</span>
              {ledgerPage < ledgerPages ? <Link href={href({ledgerPage: ledgerPage + 1})}>Next ledger →</Link> : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
