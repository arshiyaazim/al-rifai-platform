import {ActionForm, type Field} from '@/components/standalone/action-form';
import type {ReviewActions} from '@/lib/review-ui';

type Props = {
  id: string;
  kind: 'review_item' | 'cash_submission';
  domain: string;
  state: string;
  actions: ReviewActions;
  values: Record<string, string>;
};

function field(name: string, label: string, values: Record<string, string>, extra: Partial<Field> = {}): Field {
  return {name, label, defaultValue: values[name], ...extra};
}

function correctionFields(domain: string, values: Record<string, string>): Field[] {
  switch (domain) {
    case 'PROGRAM':
      return [
        field('motherVessel', 'Mother vessel', values),
        field('lighterVessel', 'Lighter vessel', values),
        field('masterMobile', 'Master mobile', values),
        field('destination', 'Destination', values),
        field('escortName', 'Escort name', values),
        field('escortMobile', 'Escort mobile', values),
        field('startDate', 'Start date', values, {type: 'date'}),
        field('startShift', 'Start shift', values, {type: 'select', options: [{value: 'D', label: 'Day (D)'}, {value: 'N', label: 'Night (N)'}]}),
        field('endDate', 'End date', values, {type: 'date'}),
        field('endShift', 'End shift', values, {type: 'select', options: [{value: '', label: '—'}, {value: 'D', label: 'Day (D)'}, {value: 'N', label: 'Night (N)'}]}),
        field('notes', 'Notes', values, {type: 'textarea'}),
      ];
    case 'CASH':
      return [
        field('employeeName', 'Employee / payee', values),
        field('employeeMobile', 'Employee mobile', values),
        field('payoutMobile', 'Payout mobile', values),
        field('method', 'Method', values, {type: 'select', options: [
          {value: 'bkash', label: 'bKash'}, {value: 'nagad', label: 'Nagad'}, {value: 'rocket', label: 'Rocket'},
          {value: 'bank', label: 'Bank'}, {value: 'cash', label: 'Cash'}]}),
        field('amountMinor', 'Amount (paisa)', values, {type: 'number'}),
        field('purpose', 'Purpose', values),
        field('accountId', 'Pay from account', values),
      ];
    case 'EMPLOYEE':
      return [
        field('preferredName', 'Preferred name', values),
        field('employeeMobile', 'Employee mobile', values),
        field('dutyType', 'Duty type', values),
      ];
    case 'ATTENDANCE':
      return [
        field('employeeMobile', 'Employee mobile', values),
        field('dutyDate', 'Duty date', values, {type: 'date'}),
        field('state', 'State', values, {type: 'select', options: [
          {value: 'PRESENT', label: 'Present'}, {value: 'ABSENT', label: 'Absent'}, {value: 'LEAVE', label: 'Leave'}]}),
        field('hours', 'Hours', values, {type: 'number'}),
      ];
    default:
      return [];
  }
}

/**
 * Reviewer controls. The server re-checks ADMIN + not-submitter + PENDING in
 * the service layer; these controls are only a projection of that decision.
 * Corrections never approve, post or settle.
 */
export function ReviewActionsPanel({id, kind, domain, state, actions, values}: Props) {
  const hasDecision = actions.canApprove || actions.canReject;
  const hasAny = hasDecision || actions.canCorrect || actions.canWithdraw;
  const hidden = {id, kind};

  return (
    <section className="card">
      <h3>Reviewer actions</h3>
      {!hasAny ? (
        <p className="muted">
          {state === 'PENDING'
            ? 'No reviewer actions are available to your role for this item.'
            : 'This item is not pending; decisions are final and audited.'}
        </p>
      ) : null}

      {hasDecision ? (
        <div className="row-actions" style={{marginBottom: 12}}>
          {actions.canApprove ? (
            <ActionForm
              compact
              endpoint="/api/review"
              action="decide"
              submitLabel="Approve"
              hidden={{...hidden, decision: 'APPROVED'}}
              fields={[]}
            />
          ) : null}
          {actions.canReject ? (
            <ActionForm
              compact
              endpoint="/api/review"
              action="decide"
              submitLabel="Reject"
              hidden={{...hidden, decision: 'REJECTED'}}
              fields={[{name: 'reason', label: 'Reason', required: true}]}
            />
          ) : null}
          {actions.canMarkDuplicate ? (
            <details className="card form compact" style={{marginBottom: 0}}>
              <summary style={{cursor: 'pointer', fontSize: 13, fontWeight: 600}}>Mark duplicate / reject</summary>
              <div style={{paddingTop: 10}}>
                <ActionForm
                  compact
                  endpoint="/api/review"
                  action="decide"
                  submitLabel="Mark duplicate"
                  hidden={{...hidden, decision: 'REJECTED'}}
                  fields={[{name: 'reason', label: 'Duplicate of (id / program)', required: true, placeholder: 'DUPLICATE_OF:…'}]}
                />
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      {actions.canCorrect ? (
        <details className="card form" style={{marginBottom: 12}}>
          <summary style={{cursor: 'pointer', fontSize: 13, fontWeight: 600}}>Correct supported fields (stays pending)</summary>
          <div style={{paddingTop: 10}}>
            <ActionForm
              endpoint="/api/review"
              action="correct"
              submitLabel="Save corrections"
              hidden={{...hidden, domain}}
              fields={correctionFields(domain, values)}
            />
            <p className="muted">
              Corrections update the review payload only. They do not approve, post or settle funds, and the item stays pending for a separate decision.
            </p>
          </div>
        </details>
      ) : null}

      {actions.canWithdraw ? (
        <div className="row-actions">
          <ActionForm
            compact
            endpoint="/api/review"
            action="withdraw"
            submitLabel="Withdraw"
            hidden={hidden}
            fields={[]}
          />
        </div>
      ) : null}
    </section>
  );
}
