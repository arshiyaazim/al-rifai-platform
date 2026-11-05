import {listReview} from '@/lib/standalone/review';
import {pageUser} from '@/lib/standalone/session';
import {ActionForm} from '@/components/standalone/action-form';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const user = await pageUser();
  const pending = await listReview({state: 'PENDING'});
  return (
    <>
      <div className="page-head">
        <div><h1>Review &amp; Approval</h1><p className="muted">Staff submit; an administrator decides. A reviewer can never approve their own submission.</p></div>
      </div>

      <div className="split">
        <section className="card">
          <h3>Pending ({pending.length})</h3>
          <table>
            <thead><tr><th>Domain</th><th>Action</th><th>Target</th><th>Submitted by</th><th>Decision</th></tr></thead>
            <tbody>
              {pending.map((item) => {
                const row = item as unknown as {id: string; domain: string; action: string; target_ref: string | null; submitter_name: string | null; submitted_by: string};
                const mine = row.submitted_by === user.id;
                return (
                  <tr key={row.id}>
                    <td>{row.domain}</td><td>{row.action}</td>
                    <td>{row.target_ref ?? '—'}</td>
                    <td>{row.submitter_name ?? row.submitted_by.slice(0, 10)}</td>
                    <td>
                      {mine ? <span className="muted">awaiting another admin</span> : (
                        <div className="row-actions">
                          <ActionForm compact endpoint="/api/review" action="decide" submitLabel="Approve"
                            hidden={{id: row.id, decision: 'APPROVED'}} fields={[]} />
                          <ActionForm compact endpoint="/api/review" action="decide" submitLabel="Reject"
                            hidden={{id: row.id, decision: 'REJECTED'}} fields={[{name: 'reason', label: 'Reason', required: true}]} />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!pending.length ? <tr><td colSpan={5} className="muted">Nothing pending.</td></tr> : null}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h3>Submit for review</h3>
          <ActionForm
            endpoint="/api/review"
            action="submit"
            submitLabel="Submit"
            fields={[
              {name: 'domain', label: 'Domain', type: 'select', options: [
                {value: 'EMPLOYEE', label: 'Employee'}, {value: 'PROGRAM', label: 'Program'},
                {value: 'ATTENDANCE', label: 'Attendance'}]},
              {name: 'reviewAction', label: 'Action', type: 'select', options: [
                {value: 'CREATE', label: 'Create'}, {value: 'UPDATE', label: 'Update'}]},
              {name: 'targetRef', label: 'Target (employee mobile / program id)'},
              {name: 'payload', label: 'Payload (JSON)', type: 'textarea', required: true,
                placeholder: '{"employeeMobile":"01712345678","preferredName":"Name"}'},
            ]}
          />
          <p className="muted">Cash uses its own submission flow on the Cash page.</p>
        </section>
      </div>
    </>
  );
}
