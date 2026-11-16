// E2.4 assistant UX regressions — pure functions, no browser/DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_TEMPLATES, TEMPLATE_GROUPS, buildMonthLedgerUrl, buildTodayLedgerUrl,
  matchTemplateByLabel, resolveTemplateActions, templatesForDomain,
} from '../../lib/standalone/ai-assistant-templates.ts';
import {
  intentForCall, planAssistantCall, suggestionsForIntent, suppressesModelBubble,
} from '../../lib/standalone/ai-assistant-functions.ts';

const NOW = new Date('2026-11-16T10:00:00Z');

test('all 12 templates match their exact label (ellipsis variants tolerated)', () => {
  assert.equal(ASSISTANT_TEMPLATES.length, 12);
  for (const template of ASSISTANT_TEMPLATES) {
    assert.equal(matchTemplateByLabel(template.label)?.id, template.id, template.label);
    assert.equal(matchTemplateByLabel(template.label.replace(/…$/, '...'))?.id, template.id);
    assert.equal(matchTemplateByLabel(`  ${template.label.toLowerCase()} `)?.id, template.id);
  }
  assert.equal(matchTemplateByLabel('how many employees?'), null);
  assert.equal(matchTemplateByLabel(''), null);
});

test('template groups cover every template exactly once', () => {
  const grouped = TEMPLATE_GROUPS.flatMap((group) => templatesForDomain(group.domain).map((t) => t.id));
  assert.equal(grouped.length, 12);
  assert.deepEqual([...grouped].sort(), ASSISTANT_TEMPLATES.map((t) => t.id).sort());
  assert.match(TEMPLATE_GROUPS[0].title, /কর্মচারী/);
});

test('today/month ledger URLs use Dhaka dates and the real params', () => {
  assert.equal(buildTodayLedgerUrl(NOW), '/cash/transactions?from=2026-11-16&to=2026-11-16');
  assert.equal(buildMonthLedgerUrl(NOW), '/cash/transactions?from=2026-11-01&to=2026-11-16');
  const today = ASSISTANT_TEMPLATES.find((t) => t.id === 'cash-today');
  const actions = resolveTemplateActions(today, NOW);
  assert.deepEqual(actions.map((a) => a.label), ["Today's ledger", 'This month']);
  assert.match(actions[0].href, /from=2026-11-16&to=2026-11-16/);
  const other = ASSISTANT_TEMPLATES.find((t) => t.id === 'cash-hotel');
  assert.deepEqual(resolveTemplateActions(other, NOW), other.actions);
});

test('follow-up suggestions are 2–4 chips for every intent', () => {
  const intents = [
    'employee_search_results', 'employee_profile', 'cash_summary', 'attendance', 'vessel',
    'mobile_did_you_mean', 'blocked', 'unsupported_date_range', 'free_chat', 'unknown_intent',
  ];
  for (const intent of intents) {
    const chips = suggestionsForIntent(intent);
    assert.ok(chips.length >= 2 && chips.length <= 4, `${intent}: ${chips.length}`);
    assert.ok(chips.every((chip) => typeof chip === 'string' && chip.length > 0));
  }
  assert.deepEqual(suggestionsForIntent('blocked'), ['Search an employee…', "Today's cash"]);
  assert.deepEqual(suggestionsForIntent('unsupported_date_range'), ['This month', 'Open dated ledger']);
  assert.deepEqual(suggestionsForIntent('free_chat'), ['Search an employee…', "Today's cash", 'Add Attendance…']);
});

test('planner intents map to the right suggestion set', () => {
  assert.equal(intentForCall(planAssistantCall('Saiful', NOW)), 'employee_search_results');
  assert.equal(intentForCall(planAssistantCall('+8801778090724 এর ক্যাশ কত?', NOW)), 'cash_summary');
  assert.equal(intentForCall(planAssistantCall('আজ উপস্থিতি দেখতে চাই', NOW)), 'attendance');
  assert.equal(intentForCall(planAssistantCall('ভেসেল দেখাও', NOW)), 'vessel');
  assert.equal(intentForCall(planAssistantCall('server IP কী?', NOW)), 'blocked');
  assert.equal(intentForCall(null), 'free_chat');
});

test('model bubble is suppressed only for confirmed navigate/form calls', () => {
  assert.equal(suppressesModelBubble({name: 'navigateToPage', requires_confirmation: true}), true);
  assert.equal(suppressesModelBubble({name: 'openSidebar', requires_confirmation: true}), true);
  assert.equal(suppressesModelBubble({name: 'navigateToPage'}), false);
  assert.equal(suppressesModelBubble({name: 'searchEmployee'}), false);
  assert.equal(suppressesModelBubble(null), false);
});
