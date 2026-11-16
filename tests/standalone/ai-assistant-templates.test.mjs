// E2.5: exactly 7 flat templates and their deterministic matching.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_TEMPLATES, buildMonthLedgerUrl, buildTodayLedgerUrl,
  matchTemplateByLabel, resolveTemplateActions,
} from '../../lib/standalone/ai-assistant-templates.ts';

const NOW = new Date('2026-11-16T10:00:00Z');

const EXPECTED = [
  'Search an employee..',
  'Add New Employee..',
  'Add Hotel Bill..',
  'Add lighter program..',
  'Add Attendance..',
  'Add Release Info..',
  "Today's cash..",
];

test('there are exactly seven flat templates with the required labels', () => {
  assert.deepEqual(ASSISTANT_TEMPLATES.map((t) => t.label), EXPECTED);
  assert.equal(new Set(ASSISTANT_TEMPLATES.map((t) => t.id)).size, 7);
});

test('every label matches (dots/ellipsis/case tolerant) and unknown labels do not', () => {
  for (const template of ASSISTANT_TEMPLATES) {
    assert.equal(matchTemplateByLabel(template.label)?.id, template.id);
    assert.equal(matchTemplateByLabel(template.label.replace(/\.\.$/, '…'))?.id, template.id);
    assert.equal(matchTemplateByLabel(`  ${template.label.toLowerCase()} `)?.id, template.id);
  }
  assert.equal(matchTemplateByLabel('how many employees?'), null);
  assert.equal(matchTemplateByLabel('Search an employee now'), null);
});

test('template flows expose 2–4 follow-ups and a context token', () => {
  for (const template of ASSISTANT_TEMPLATES) {
    assert.ok(template.followUps.length >= 2 && template.followUps.length <= 4, template.label);
    assert.ok(template.context === null || typeof template.context === 'string');
    assert.ok(template.response.length > 20);
  }
  assert.equal(ASSISTANT_TEMPLATES.find((t) => t.id === 'cash-hotel')?.context, 'cash-payment');
  assert.match(ASSISTANT_TEMPLATES.find((t) => t.id === 'cash-hotel')?.response ?? '', /Purpose/);
});

test("today's cash resolves dynamic ledger actions", () => {
  const today = ASSISTANT_TEMPLATES.find((t) => t.id === 'cash-today');
  const actions = resolveTemplateActions(today, NOW);
  assert.deepEqual(actions.map((a) => a.label), ["Today's ledger", 'This month']);
  assert.equal(actions[0].href, buildTodayLedgerUrl(NOW));
  assert.equal(actions[1].href, buildMonthLedgerUrl(NOW));
  assert.equal(buildTodayLedgerUrl(NOW), '/cash/transactions?from=2026-11-16&to=2026-11-16');
});
