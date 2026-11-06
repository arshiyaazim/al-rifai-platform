import Link from 'next/link';
import {row, rows} from '@/lib/standalone/db';
import {reviewQueueCounts} from '@/lib/standalone/review';
import {money, when} from '@/lib/standalone/session';
import {reviewCategoryLabel} from '@/lib/review-ui';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const [stats, audit, reviewCounts] = await Promise.all([
    row<{
      employees: string; programs: string; reviews: string; cash_pending: string;
      payable: string; unresolved: string; attendance_today: string; instructions: string;
    }>(`SELECT
        (SELECT count(*)::text FROM employees WHERE state = 'ACTIVE') AS employees,
        (SELECT count(*)::text FROM programs WHERE state NOT IN ('VOIDED','COMPLETED')) AS programs,
        (SELECT count(*)::text FROM review_items WHERE state = 'PENDING') AS reviews,
        (SELECT count(*)::text FROM cash_instructions WHERE state = 'REVIEW') AS cash_pending,
        (SELECT coalesce(sum(total_minor),0)::text FROM program_pay WHERE state = 'CALCULATED') AS payable,
        (SELECT count(*)::text FROM program_pay WHERE state = 'UNRESOLVED') AS unresolved,
        (SELECT count(*)::text FROM attendance WHERE duty_date = current_date AND state = 'PRESENT') AS attendance_today,
        (SELECT count(*)::text FROM cash_instructions) AS instructions`),
    rows<{at: string; actor: string; action: string; entity: string; entity_id: string | null}>(
      'SELECT at, actor, action, entity, entity_id FROM audit_events ORDER BY at DESC, id DESC LIMIT 12',
    ),
    reviewQueueCounts(),
  ]);
  const alerts: string[] = [];
  if (Number(stats?.unresolved)) alerts.push(`${stats?.unresolved} program(s) have unresolved pay — set a rate and an end date.`);
  if (Number(stats?.reviews)) alerts.push(`${stats?.reviews} submission(s) await a decision.`);
  if (!Number(stats?.employees)) alerts.push('No employees yet — add the first employee or create a program with an escort.');

  return (
    <>
      <div className="page-head">
        <div><h1>Dashboard</h1><p className="muted">Business overview and pending work.</p></div>
      </div>

      <div className="grid-cards">
        <div className="stat"><div className="label">Active employees</div><div className="value">{stats?.employees ?? 0}</div></div>
        <div className="stat"><div className="label">Programs</div><div className="value">{stats?.programs ?? 0}</div></div>
        <div className="stat"><div className="label">Payable (calculated)</div><div className="value">{money(stats?.payable)}</div></div>
        <div className="stat"><div className="label">Cash awaiting approval</div><div className="value">{stats?.cash_pending ?? 0}</div></div>
        <div className="stat"><div className="label">Pending reviews</div><div className="value">{stats?.reviews ?? 0}</div></div>
        <div className="stat"><div className="label">Present today</div><div className="value">{stats?.attendance_today ?? 0}</div></div>
      </div>

      {alerts.length ? (
        <div className="card">
          <h3>Attention</h3>
          <ul>{alerts.map((alert) => <li key={alert}>{alert}</li>)}</ul>
        </div>
      ) : null}

      <section className="card">
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Review Queue</h3></div>
          <Link href="/review">Open queue →</Link>
        </div>
        <div className="grid-cards" style={{marginBottom: 12}}>
          <div className="stat"><div className="label">Review items pending</div><div className="value">{reviewCounts.pending}</div></div>
          <div className="stat"><div className="label">Cash candidates pending</div><div className="value">{reviewCounts.cashPending}</div></div>
          <div className="stat"><div className="label">Total pending</div><div className="value">{reviewCounts.pending + reviewCounts.cashPending}</div></div>
        </div>
        {Object.keys(reviewCounts.byCategory).length ? (
          <div className="row-actions">
            {Object.entries(reviewCounts.byCategory).map(([category, count]) => (
              <Link key={category} href={`/review?category=${encodeURIComponent(category)}`} className="pill warn">
                {reviewCategoryLabel(category)} · {count}
              </Link>
            ))}
          </div>
        ) : <p className="muted">No pending review items by category.</p>}
      </section>

      <div className="split">
        <section className="card">
          <h3>Recent activity</h3>
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Entity</th><th>Actor</th></tr></thead>
            <tbody>
              {audit.map((entry, index) => (
                <tr key={`${entry.at}-${index}`}>
                  <td>{when(entry.at)}</td>
                  <td>{entry.action}</td>
                  <td>{entry.entity}{entry.entity_id ? ` · ${entry.entity_id.slice(0, 18)}` : ''}</td>
                  <td className="muted">{entry.actor.slice(0, 12)}</td>
                </tr>
              ))}
              {!audit.length ? <tr><td colSpan={4} className="muted">No activity yet.</td></tr> : null}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h3>Quick actions</h3>
          <div className="row-actions">
            <Link href="/employees">Add employee</Link>
            <Link href="/vessel">New vessel program</Link>
            <Link href="/cash">Record cash</Link>
            <Link href="/review">Open review queue</Link>
          </div>
          <p className="muted" style={{marginTop: 14}}>
            {stats?.instructions ?? 0} payment instruction(s) recorded in total.
          </p>
        </section>
      </div>
    </>
  );
}
