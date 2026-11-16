import Link from 'next/link';
import {pageUser} from '@/lib/standalone/session';
import {
  listCashReviewCandidates, listPendingAttendanceReviews, listPendingEmployeeReviews,
} from '@/lib/standalone/review';
import {listUnifiedVesselReview} from '@/lib/standalone/vessel-review';
import {listEmployees} from '@/lib/standalone/employees';
import {listAccounts} from '@/lib/standalone/finance';
import {rows} from '@/lib/standalone/db';
import {can} from '@/lib/standalone/authz';
import {reviewCategoryLabel} from '@/lib/review-ui';
import {VesselReviewPanel} from '@/components/standalone/vessel-review-panel';
import {EmployeeReviewPanel} from '@/components/standalone/employee-review-panel';
import {AttendanceReviewPanel} from '@/components/standalone/attendance-review-panel';
import {CashReviewPanel} from '@/components/standalone/cash-review-panel';
import {ActionForm} from '@/components/standalone/action-form';
import {RealtimeRefresher} from '@/components/standalone/realtime-refresher';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{state?: string; category?: string}>;

export default async function ReviewQueuePage({searchParams}: {searchParams: SearchParams}) {
  const user = await pageUser();
  const search = await searchParams;
  const category = (search.category ?? '').trim();

  const [vesselRows, employeeRows, attendanceRows, cashCandidates, employees, accounts, motherRows, lighterRows, escortNameRows, escortMobileRows] = await Promise.all([
    listUnifiedVesselReview(300),
    listPendingEmployeeReviews(300),
    listPendingAttendanceReviews(300),
    listCashReviewCandidates({state: 'PENDING_REVIEW', limit: 300}),
    listEmployees({limit: 1000}),
    listAccounts(),
    rows<{vessel_name: string}>("SELECT vessel_name FROM vessels WHERE vessel_type = 'mother' ORDER BY vessel_name"),
    rows<{vessel_name: string}>("SELECT vessel_name FROM vessels WHERE vessel_type = 'lighter' ORDER BY vessel_name"),
    rows<{escort_name: string}>('SELECT DISTINCT escort_name FROM programs WHERE escort_name IS NOT NULL ORDER BY escort_name'),
    rows<{escort_mobile: string}>('SELECT DISTINCT escort_mobile FROM programs WHERE escort_mobile IS NOT NULL ORDER BY escort_mobile'),
  ]);
  const canDecide = can(user as never, 'review.decide');
  const filteredVesselRows = category
    ? vesselRows.filter((row) => row.reasonCode === category)
    : vesselRows;
  const showOtherDomains = !category;

  return (
    <div className="vessel-workspace">
      <div className="page-head">
        <div>
          <h1>Review Queue</h1>
        </div>
        <div className="row-actions">
          <span className="pill warn">{filteredVesselRows.length} vessel</span>
          {showOtherDomains ? <span className="pill warn">{employeeRows.length} employee</span> : null}
          {showOtherDomains ? <span className="pill warn">{attendanceRows.length} attendance</span> : null}
          {showOtherDomains ? <span className="pill warn">{cashCandidates.length} cash</span> : null}
          <RealtimeRefresher domain="REVIEW" label="Live queue" />
        </div>
      </div>

      {user.role === 'ADMIN' ? (
        <details className="card" style={{marginBottom: 16, padding: 12}}>
          <summary style={{cursor: 'pointer', fontWeight: 600}}>Router checkpoint</summary>
          <p className="muted" style={{marginTop: 6}}>
            Processes staged WhatsApp messages. It never approves or settles anything.
          </p>
          <ActionForm
            endpoint="/api/whatsapp"
            action="route"
            submitLabel="Process pending messages"
            fields={[{name: 'limit', label: 'Batch limit', type: 'number', defaultValue: '100'}]}
          />
        </details>
      ) : null}

      {category ? (
        <div className="card" style={{marginBottom: 12, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <span>Filtered: <strong>{reviewCategoryLabel(category)}</strong> · {filteredVesselRows.length} row(s)</span>
          <Link href="/review" className="muted">Clear category filter</Link>
        </div>
      ) : null}

      <VesselReviewPanel
        rows={filteredVesselRows}
        mothers={motherRows.map((row) => row.vessel_name)}
        lighters={lighterRows.map((row) => row.vessel_name)}
        escortNames={escortNameRows.map((row) => row.escort_name)}
        escortMobiles={escortMobileRows.map((row) => row.escort_mobile)}
        canDecide={canDecide}
      />

      {showOtherDomains ? (
        <>
          <EmployeeReviewPanel rows={employeeRows} canDecide={canDecide} />

          <AttendanceReviewPanel rows={attendanceRows} canDecide={canDecide} />

          <CashReviewPanel
            rows={cashCandidates}
            employees={employees.map((employee) => ({
              mobile: employee.employee_mobile,
              name: employee.preferred_name,
              designation: employee.designation ?? null,
              dateOfJoin: employee.date_of_join ?? null,
            }))}
            accounts={accounts.map((account) => ({id: account.id, code: account.code, name: account.name}))}
            canDecide={canDecide}
          />
        </>
      ) : null}

      <section className="card">
        <h3>How this queue works</h3>
        <ul style={{marginTop: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6}}>
          <li><strong>View</strong> opens the same domain sidebar/modal used by the domain page.</li>
          <li><strong>Save Edit</strong> updates the review payload only; the row stays pending.</li>
          <li><strong>Approve</strong> writes the domain record and removes the row from review.</li>
          <li><strong>Decline</strong> is final and audited; the row leaves review.</li>
          <li>Release/confirmation items without an automatic match stay in review for manual handling.</li>
        </ul>
      </section>
    </div>
  );
}
