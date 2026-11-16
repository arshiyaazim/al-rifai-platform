// E2.5 query-layer regressions: SELECT-only, parameterised, safe limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attendanceSummary, cashSummary, cashTransactions, employeeAttendance, vesselPrograms,
} from '../../lib/standalone/ai-assistant-queries.ts';

function recorder(responses) {
  const calls = [];
  let index = 0;
  const run = async (sql, params = []) => {
    calls.push({sql, params});
    return responses[index++] ?? [];
  };
  return {run, calls};
}

test('cashSummary is SELECT-only, excludes REVIEW from totals and reports it separately', async () => {
  const {run, calls} = recorder([
    [{posted: 12, minor: '4530000', review: 2}],
    [{method: 'bkash', count: 8, minor: '3000000'}, {method: 'nagad', count: 3, minor: '1500000'}],
    [{employee: 'Md Saiful Islam', amount_minor: '500000', purpose: 'হোটেল বিল'}],
  ]);
  const summary = await cashSummary('2026-11-15', '2026-11-15', run);
  assert.deepEqual(summary, {
    postedCount: 12, totalMinor: 4530000, reviewCount: 2,
    byMethod: [{method: 'bkash', count: 8, minor: 3000000}, {method: 'nagad', count: 3, minor: 1500000}],
    top: [{employee: 'Md Saiful Islam', amountMinor: 500000, purpose: 'হোটেল বিল'}],
  });
  for (const call of calls) {
    assert.match(call.sql, /^\s*SELECT/i);
    assert.doesNotMatch(call.sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
    assert.deepEqual(call.params, ['2026-11-15', '2026-11-15']);
  }
  assert.match(calls[0].sql, /state = 'REVIEW'/);
  assert.match(calls[0].sql, /AT TIME ZONE 'Asia\/Dhaka'/);
});

test('cashTransactions clamps the limit and passes it as a bound parameter', async () => {
  const {run, calls} = recorder([[]]);
  await cashTransactions('2026-11-01', '2026-11-16', 5000, run);
  assert.equal(calls[0].params[2], 100);
  assert.deepEqual(calls[0].params.slice(0, 2), ['2026-11-01', '2026-11-16']);
  const second = recorder([[]]);
  await cashTransactions('2026-11-01', '2026-11-16', 0, second.run);
  assert.equal(second.calls[0].params[2], 20);
});

test('attendanceSummary aggregates ACTIVE rows only', async () => {
  const {run, calls} = recorder([
    [{records: 40, days: 12, employees: 9}],
    [{shift: 'D', count: 30}, {shift: 'N', count: 10}],
    [{location: 'Chittagong Port', count: 25}],
  ]);
  const summary = await attendanceSummary('2026-11-01', '2026-11-16', run);
  assert.equal(summary.days, 12);
  assert.equal(summary.byShift[0].shift, 'D');
  assert.match(calls[0].sql, /state = 'ACTIVE'/);
  assert.match(calls[0].sql, /employee_mobile|attendance_date/);
});

test('employee queries bind the stored mobile as a parameter', async () => {
  const attendance = recorder([[{attendance_date: '2026-11-15', shift: 'D', location: 'Port'}]]);
  const result = await employeeAttendance('+8801778090724', '2026-11-01', '2026-11-16', attendance.run);
  assert.equal(result.days, 1);
  assert.deepEqual(attendance.calls[0].params, ['+8801778090724', '2026-11-01', '2026-11-16']);
});

test('vesselPrograms filters by overlap and binds q/limit, never concatenating input', async () => {
  const {run, calls} = recorder([[
    {mother_vessel: 'MV Test', lighter_vessel: 'L-1', escort_name: 'Biplob', escort_mobile: '+8801700000000',
      start_date: '2026-11-14', end_date: '2026-11-16', state: 'CONFIRMED'},
  ]]);
  const found = await vesselPrograms({q: "x' OR 1=1 --", from: '2026-11-15', to: '2026-11-15'}, run);
  assert.equal(found[0].escortName, 'Biplob');
  assert.deepEqual(calls[0].params.slice(0, 2), ['2026-11-15', '2026-11-15']);
  assert.equal(calls[0].params[2], "x' OR 1=1 --");
  assert.match(calls[0].sql, /\$3/);
  assert.doesNotMatch(calls[0].sql, /OR 1=1/);
});
