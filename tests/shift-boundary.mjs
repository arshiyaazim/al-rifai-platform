// Regression tests for the Owner-approved shift boundary (decision D5, 2026-11-04)
// and the duty-shift enumeration that monthly payroll depends on.
//
// Boundary: Day 06:00:00–17:59:59 Asia/Dhaka, Night 18:00:00–05:59:59.
// Exactly 06:00 is Day; exactly 18:00 is Night.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHIFT_DAY_START_SECOND,
  SHIFT_DAY_END_SECOND,
  dhakaLocalTime,
  dutyCount,
  enumerateDutyShifts,
  monthOf,
  orderDraftDateAndShift,
  shiftForHour,
  shiftForSecondOfDay,
} from '../lib/shift-boundary.ts';

test('boundary constants are the Owner-approved 06:00 and 18:00', () => {
  assert.equal(SHIFT_DAY_START_SECOND, 6 * 3600);
  assert.equal(SHIFT_DAY_END_SECOND, 18 * 3600);
});

test('exact second boundaries: 05:59:59 Night, 06:00:00 Day, 17:59:59 Day, 18:00:00 Night', () => {
  const cases = [
    ['2026-11-04T05:59:59+06:00', 'N'],
    ['2026-11-04T06:00:00+06:00', 'D'],
    ['2026-11-04T17:59:59+06:00', 'D'],
    ['2026-11-04T18:00:00+06:00', 'N'],
    ['2026-11-04T00:00:00+06:00', 'N'],
    ['2026-11-04T23:59:59+06:00', 'N'],
  ];
  for (const [timestamp, shift] of cases) {
    assert.equal(dhakaLocalTime(timestamp)?.shift, shift, timestamp);
  }
});

test('the rule is applied in Asia/Dhaka, not in UTC', () => {
  // 23:59:59Z is 05:59:59 next day in Dhaka → Night, and the local date is the 4th.
  const lateUtc = dhakaLocalTime('2026-11-03T23:59:59Z');
  assert.equal(lateUtc?.shift, 'N');
  assert.equal(lateUtc?.date, '2026-11-04');
  assert.equal(lateUtc?.localTime, '05:59:59');

  // 00:00:00Z is 06:00:00 in Dhaka → Day (exactly 06:00 is Day).
  const sixUtc = dhakaLocalTime('2026-11-04T00:00:00Z');
  assert.equal(sixUtc?.shift, 'D');
  assert.equal(sixUtc?.date, '2026-11-04');

  // 11:59:59Z → 17:59:59 Day; 12:00:00Z → 18:00:00 Night.
  assert.equal(dhakaLocalTime('2026-11-04T11:59:59Z')?.shift, 'D');
  assert.equal(dhakaLocalTime('2026-11-04T12:00:00Z')?.shift, 'N');

  // 18:30Z is 00:30 on the NEXT Dhaka date.
  const rollover = dhakaLocalTime('2026-11-04T18:30:00Z');
  assert.equal(rollover?.date, '2026-11-05');
  assert.equal(rollover?.shift, 'N');
});

test('hour form and second form never disagree', () => {
  assert.equal(shiftForHour(0), 'N');
  assert.equal(shiftForHour(5), 'N');
  assert.equal(shiftForHour(6), 'D');
  assert.equal(shiftForHour(12), 'D');
  assert.equal(shiftForHour(17), 'D');
  assert.equal(shiftForHour(18), 'N');
  assert.equal(shiftForHour(23), 'N');
  for (let hour = 0; hour < 24; hour += 1) {
    assert.equal(shiftForHour(hour), shiftForSecondOfDay(hour * 3600));
  }
  assert.throws(() => shiftForSecondOfDay(-1));
  assert.throws(() => shiftForSecondOfDay(86_400));
});

test('Order Draft date and shift come from the arrival timestamp', () => {
  assert.deepEqual(orderDraftDateAndShift('2026-11-03T06:36:01Z'), {date: '2026-11-03', shift: 'D'});
  assert.deepEqual(orderDraftDateAndShift('2026-11-03T13:00:00Z'), {date: '2026-11-03', shift: 'N'});
  assert.equal(orderDraftDateAndShift('not-a-timestamp'), null);
});

test('duty-shift enumeration matches count_shifts for the same window', () => {
  // count_shifts: (end-start)*2 + (end==N) - (start==N) + 1
  const formula = (start, startShift, end, endShift) => {
    const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
    return days * 2 + (endShift === 'N' ? 1 : 0) - (startShift === 'N' ? 1 : 0) + 1;
  };
  const dates = ['2026-01-31', '2026-02-01', '2026-02-28', '2026-03-01', '2026-10-24', '2026-11-03'];
  for (const start of dates) {
    for (const end of dates) {
      if (end < start) continue;
      for (const startShift of ['D', 'N']) {
        for (const endShift of ['D', 'N']) {
          const shifts = enumerateDutyShifts(start, startShift, end, endShift);
          assert.equal(
            shifts.length,
            formula(start, startShift, end, endShift),
            `${start}${startShift}→${end}${endShift}`,
          );
          // No duplicates: each (date, shift) appears once.
          assert.equal(new Set(shifts.map((s) => `${s.date}|${s.shift}`)).size, shifts.length);
        }
      }
    }
  }
});

test('same-day, reversed and invalid windows fail closed', () => {
  assert.equal(enumerateDutyShifts('2026-11-02', 'D', '2026-11-02', 'D').length, 1);
  assert.equal(enumerateDutyShifts('2026-11-02', 'N', '2026-11-02', 'N').length, 1);
  assert.equal(enumerateDutyShifts('2026-11-02', 'D', '2026-11-02', 'N').length, 2);
  assert.equal(enumerateDutyShifts('2026-11-02', 'N', '2026-11-02', 'D').length, 0);
  assert.equal(enumerateDutyShifts('2026-11-03', 'D', '2026-11-02', 'D').length, 0);
  assert.equal(enumerateDutyShifts('2026-02-30', 'D', '2026-03-02', 'D').length, 0);
  assert.equal(enumerateDutyShifts('', 'D', '2026-03-02', 'D').length, 0);
  assert.equal(enumerateDutyShifts('2026-03-01', 'X', '2026-03-02', 'D').length, 0);
});

test('cross-month and month-end windows keep every shift on its own date', () => {
  const shifts = enumerateDutyShifts('2026-10-24', 'N', '2026-11-03', 'D');
  assert.equal(shifts.length, 20);
  assert.equal(shifts.filter((s) => monthOf(s.date) === '2026-10').length, 15);
  assert.equal(shifts.filter((s) => monthOf(s.date) === '2026-11').length, 5);
  assert.deepEqual(shifts[0], {date: '2026-10-24', shift: 'N'});
  assert.deepEqual(shifts.at(-1), {date: '2026-11-03', shift: 'D'});

  const monthEnd = enumerateDutyShifts('2026-01-31', 'N', '2026-02-01', 'D');
  assert.deepEqual(monthEnd, [
    {date: '2026-01-31', shift: 'N'},
    {date: '2026-02-01', shift: 'D'},
  ]);
});

test('two shifts equal one duty day', () => {
  assert.deepEqual(dutyCount([]), {shifts: 0, dutyDays: 0});
  assert.deepEqual(dutyCount([{date: '2026-11-02', shift: 'D'}]), {shifts: 1, dutyDays: 0.5});
  // N on the 2nd then D on the 3rd is two separate half-days, not one full day.
  assert.deepEqual(dutyCount(enumerateDutyShifts('2026-11-02', 'N', '2026-11-03', 'D')), {shifts: 2, dutyDays: 1});
  // N → N over two dates covers 1 + 2 shifts.
  assert.deepEqual(dutyCount(enumerateDutyShifts('2026-11-02', 'N', '2026-11-03', 'N')), {shifts: 3, dutyDays: 1.5});
  // A full 24 hours (D → N on the same date, or D on day 1 through N on day 2) is two shifts per day.
  assert.deepEqual(dutyCount(enumerateDutyShifts('2026-11-02', 'D', '2026-11-02', 'N')), {shifts: 2, dutyDays: 1});
});
