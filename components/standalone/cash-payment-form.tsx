'use client';

import {useRouter} from 'next/navigation';
import {useState} from 'react';
import {EmployeeLookup, type EmployeeSuggestion} from '@/components/standalone/employee-lookup';

type AccountOption = {
  id: string;
  code: string;
  name: string;
};

type Props = {
  accounts: AccountOption[];
  defaults?: {
    employeeName?: string;
    employeeMobile?: string;
    payoutMobile?: string;
  };
};

/**
 * New payment instruction form with a backend employee lookup.
 *
 * The endpoint and action are unchanged from the pre-existing Cash form:
 * POST /api/finance with `instruction.create`. Posting, approval, reversal and
 * reconciliation are deliberately not exposed here.
 */
export function CashPaymentForm({accounts, defaults = {}}: Props) {
  const router = useRouter();
  const [employeeName, setEmployeeName] = useState(defaults.employeeName ?? '');
  const [employeeMobile, setEmployeeMobile] = useState(defaults.employeeMobile ?? '');
  const [payoutMobile, setPayoutMobile] = useState(defaults.payoutMobile ?? '');
  const [method, setMethod] = useState('bkash');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [purpose, setPurpose] = useState('');
  const [state, setState] = useState<{busy: boolean; error?: string; ok?: string}>({busy: false});

  function chooseEmployee(employee: EmployeeSuggestion) {
    setEmployeeName(employee.preferred_name);
    setEmployeeMobile(employee.employee_mobile);
    setPayoutMobile((current) => current || employee.employee_mobile);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values: Record<string, unknown> = {
      action: 'instruction.create',
      employeeName,
      method,
      amount,
    };
    if (employeeMobile) values.employeeMobile = employeeMobile;
    if (payoutMobile) values.payoutMobile = payoutMobile;
    if (accountId) values.accountId = accountId;
    if (purpose) values.purpose = purpose;

    setState({busy: true});
    try {
      const session = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
      if (!session.ok) throw new Error('SESSION_EXPIRED');
      const {csrf} = (await session.json()) as {csrf: string};
      const response = await fetch('/api/finance', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrf},
        body: JSON.stringify(values),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setAmount('');
      setPurpose('');
      setState({busy: false, ok: 'Payment instruction created for review.'});
      router.refresh();
    } catch (error) {
      setState({busy: false, error: error instanceof Error ? error.message : 'FAILED'});
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <div className="grid">
        <EmployeeLookup
          id="employeeName"
          label="Employee / payee name"
          placeholder="Name, alias or mobile"
          value={employeeName}
          onChange={setEmployeeName}
          onSelect={chooseEmployee}
          required
        />
        <label>
          <span>Employee ID / mobile</span>
          <input
            name="employeeMobile"
            value={employeeMobile}
            onChange={(event) => setEmployeeMobile(event.target.value)}
            placeholder="01712345678"
            autoComplete="off"
          />
        </label>
        <label>
          <span>Payout number</span>
          <input
            name="payoutMobile"
            value={payoutMobile}
            onChange={(event) => setPayoutMobile(event.target.value)}
            placeholder="017XXXXXXXX"
            autoComplete="off"
          />
        </label>
        <label>
          <span>Method</span>
          <select name="method" value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="bkash">bKash</option>
            <option value="nagad">Nagad</option>
            <option value="rocket">Rocket</option>
            <option value="bank">Bank</option>
            <option value="cash">Cash</option>
          </select>
        </label>
        <label>
          <span>Amount (BDT)</span>
          <input
            name="amount"
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="1250.00"
            required
          />
        </label>
        <label>
          <span>Pay from</span>
          <select name="accountId" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.code} — {account.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Purpose</span>
          <input name="purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} />
        </label>
      </div>
      <button type="submit" disabled={state.busy}>{state.busy ? 'Working…' : 'Create (review)'}</button>
      {state.error ? <p className="error">{state.error}</p> : null}
      {state.ok ? <p className="ok">{state.ok}</p> : null}
    </form>
  );
}
