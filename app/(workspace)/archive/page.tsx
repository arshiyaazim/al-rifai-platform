import Link from 'next/link';
import {listAudit} from '@/lib/standalone/audit';
import {listLedger} from '@/lib/standalone/finance';
import {pageUser, money, when} from '@/lib/standalone/session';

export const dynamic = 'force-dynamic';

export default async function ArchivePage() {
  await pageUser();
  const [audit, ledger] = await Promise.all([listAudit({limit: 200}), listLedger({limit: 100})]);
  return (
    <>
      <div className="page-head"><div><h1>Archive</h1><p className="muted">Immutable audit history, ledger entries and CSV exports.</p></div><div className="row-actions"><Link href="/reports">Reports &amp; exports →</Link><Link href="/cash/archive">Cash archive →</Link></div></div>
      <section className="card"><h3>Audit trail ({audit.length})</h3><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Source</th></tr></thead><tbody>
        {audit.map((entry) => <tr key={entry.id}><td>{when(entry.at)}</td><td>{entry.actor.slice(0, 12)}</td><td>{entry.action}</td><td>{entry.entity}{entry.entity_id ? ` · ${entry.entity_id.slice(0, 20)}` : ''}</td><td>{entry.source}</td></tr>)}
        {!audit.length ? <tr><td colSpan={5} className="muted">No audit records.</td></tr> : null}
      </tbody></table></section>
      <section className="card"><h3>Ledger entries ({ledger.length})</h3><table><thead><tr><th>Date</th><th>Account</th><th>Category</th><th>Direction</th><th>Amount</th></tr></thead><tbody>
        {ledger.map((entry) => { const item = entry as unknown as {id: string; entry_date: string; account_code: string; category: string; direction: string; amount_minor: string}; return <tr key={item.id}><td>{item.entry_date}</td><td>{item.account_code}</td><td>{item.category}</td><td>{item.direction}</td><td>{money(item.amount_minor)}</td></tr>; })}
        {!ledger.length ? <tr><td colSpan={5} className="muted">No ledger entries.</td></tr> : null}
      </tbody></table></section>
    </>
  );
}
