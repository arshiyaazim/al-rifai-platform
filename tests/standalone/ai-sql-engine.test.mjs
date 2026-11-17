// E2.7 read-only NL→SQL engine: guard, generation, execution, formatting.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeSQL, formatEngineAnswer, generateSQL, hardenSQL, validateSQL,
  buildSqlPlan, writeIntentAnswer,
} from '../../lib/standalone/ai-sql-engine.ts';
import {encodeContext} from '../../lib/standalone/ai-assistant-context.ts';

const NOW = new Date('2026-11-16T10:00:00Z');

const MALICIOUS = [
  'DROP TABLE employees',
  'delete from cash_instructions',
  'UPDATE employees SET preferred_name = $$x$$',
  'INSERT INTO employees (employee_mobile) VALUES ($$1$$)',
  'ALTER TABLE employees ADD COLUMN x int',
  'TRUNCATE cash_instructions',
  'GRANT ALL ON employees TO public',
  'REVOKE ALL ON employees FROM public',
  'CREATE TABLE evil (id int)',
  'EXECUTE some_proc()',
  'CALL do_something()',
  'COPY employees TO $$/tmp/x$$',
  'LOCK TABLE employees',
  'VACUUM employees',
  'ANALYZE employees',
  'SELECT 1; DROP TABLE employees',
  'WITH x AS (DELETE FROM employees RETURNING *) SELECT * FROM x',
  'SELECT * FROM pg_catalog.pg_user',
  'SELECT * FROM information_schema.tables',
  'SELECT 1 -- DROP TABLE employees',
];

function recorder(rows = []) {
  const calls = [];
  const run = async (sql, params) => { calls.push({sql, params}); return rows; };
  return {run, calls};
}

test('guard rejects 20+ malicious statements and allows only SELECT/WITH', () => {
  assert.equal(MALICIOUS.length, 20);
  for (const sql of MALICIOUS) assert.equal(validateSQL(sql), false, sql);
  assert.equal(validateSQL('SELECT 1'), true);
  assert.equal(validateSQL('WITH x AS (SELECT 1) SELECT * FROM x'), true);
  assert.equal(validateSQL('SELECT 1;'), true);
  assert.equal(validateSQL(''), false);
});

test('hardenSQL appends LIMIT 50 and preserves an existing limit', () => {
  assert.match(hardenSQL('SELECT 1'), /LIMIT 50$/);
  assert.match(hardenSQL('SELECT 1 LIMIT 5'), /LIMIT 5$/);
  assert.throws(() => hardenSQL('DELETE FROM x'), /SQL_REJECTED/);
});

test('generation: "গতকালের মোট খরচ কত?" → SELECT with a date filter', () => {
  const plan = buildSqlPlan('গতকালের মোট খরচ কত?', NOW);
  assert.equal(plan?.kind, 'cash_total');
  const query = generateSQL(plan);
  assert.equal(validateSQL(query.sql), true);
  assert.match(query.sql, /sum\(i\.amount_minor\)/i);
  assert.match(query.sql, /BETWEEN \$1::date AND \$2::date/);
  assert.deepEqual(query.params, ['2026-11-15', '2026-11-15']);
  assert.match(query.sql, /state = 'POSTED'/);
});

test('generation: "কোন এমপ্লোয়ি সবচেয়ে বেশি টাকা পেয়েছে এই মাসে?" → GROUP BY', () => {
  const plan = buildSqlPlan('কোন এমপ্লোয়ি সবচেয়ে বেশি টাকা পেয়েছে এই মাসে?', NOW);
  assert.equal(plan?.kind, 'cash_top');
  const query = generateSQL(plan);
  assert.match(query.sql, /GROUP BY 1, 2/i);
  assert.match(query.sql, /ORDER BY total_minor DESC/i);
  assert.deepEqual(query.params, ['2026-11-01', '2026-11-16']);
});

test('generation: "বেলটোকিও মাদারের সব এসকর্ট" → mother_vessel WHERE', () => {
  const plan = buildSqlPlan('বেলটোকিও মাদারের সব এসকর্ট', NOW);
  assert.equal(plan?.kind, 'vessel_escorts');
  const query = generateSQL(plan);
  assert.match(query.sql, /mother_vessel ILIKE/i);
  assert.match(query.sql, /escort_name/i);
  assert.equal(query.params.length, 1);
  assert.match(String(query.params[0]), /^[a-z]+$/i);
});

test('attendance + payment questions use a join on the attendance day', () => {
  const plan = buildSqlPlan('গতকাল কে উপস্থিত ছিল और টাকা পেয়েছে?', NOW);
  assert.equal(plan?.kind, 'cash_attendance_join');
  const query = generateSQL(plan);
  assert.match(query.sql, /LEFT JOIN cash_instructions/i);
  assert.match(query.sql, /attendance_date BETWEEN/i);
});

test('execution: mocks receive hardened SQL; errors never leak internals', async () => {
  const plan = buildSqlPlan('গতকালের মোট খরচ কত?', NOW);
  const {run, calls} = recorder([{entries: 15, total_minor: '1250000'}]);
  const result = await executeSQL(generateSQL(plan), run);
  assert.equal(result.rowCount, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /LIMIT 50$/);
  assert.deepEqual(calls[0].params, ['2026-11-15', '2026-11-15']);

  const failing = await executeSQL(generateSQL(plan), async () => { throw {code: '42501'}; });
  assert.equal(failing.error, '42501');
  assert.equal(failing.rowCount, 0);
});

test('every generated statement is SELECT-only and never carries a write keyword', () => {
  const questions = [
    'গতকালের মোট খরচ কত?', 'কোন এমপ্লোয়ি সবচেয়ে বেশি টাকা পেয়েছে এই মাসে?',
    'গত তিন দিনের সব ভেসেল প্রোগ্রামের এসকর্টদের নাম ও মোবাইল দেখাও',
    'গতকাল কে উপস্থিত ছিল?', 'সব কর্মচারীর তালিকা',
  ];
  for (const question of questions) {
    const plan = buildSqlPlan(question, NOW);
    assert.ok(plan, question);
    const {sql} = generateSQL(plan);
    assert.equal(validateSQL(sql), true, question);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  }
});

test('Bengali formatting: 0 / 1 / many / aggregation, never raw SQL', () => {
  const totalPlan = buildSqlPlan('গতকালের মোট খরচ কত?', NOW);
  const total = formatEngineAnswer(totalPlan, {
    rows: [{entries: 15, total_minor: '1250000'}], rowCount: 1, executionTime: 4,
  }, NOW);
  assert.match(total.text, /৳/);
  assert.match(total.text, /১৫ টি লেনদেন/);
  assert.doesNotMatch(total.text, /cash_instructions|amount_minor|SELECT/i);

  const empty = formatEngineAnswer(totalPlan, {rows: [], rowCount: 0, executionTime: 1}, NOW);
  assert.match(empty.text, /কোনো তথ্য পাওয়া যায়নি/);

  const vesselPlan = buildSqlPlan('বেলটোকিও মাদারের সব এসকর্ট', NOW);
  const one = formatEngineAnswer(vesselPlan, {
    rows: [{escort: 'Biplob', escort_mobile: '+8801700000000', mother: 'BELTOKYO', lighter: 'L-1'}],
    rowCount: 1, executionTime: 2,
  }, NOW);
  assert.match(one.text, /Biplob/);
  assert.doesNotMatch(one.text, /programs|mother_vessel/i);

  const many = formatEngineAnswer(vesselPlan, {
    rows: Array.from({length: 12}, (_, index) => ({escort: `E${index}`, escort_mobile: '017', mother: 'M', lighter: 'L'})),
    rowCount: 12, executionTime: 2,
  }, NOW);
  assert.match(many.text, /আরও ২ টি আছে/);
  assert.ok(many.actions[0].href.startsWith('/vessel'));
});

test('context follow-up: "তার আগের দিনেরটা দেখাও" shifts the remembered day', () => {
  const prior = encodeContext({domain: 'cash', from: '2026-11-16', to: '2026-11-16', at: NOW.getTime()});
  const decoded = {domain: 'cash', from: '2026-11-16', to: '2026-11-16', at: NOW.getTime()};
  assert.ok(prior);
  const plan = buildSqlPlan('তার আগের দিনেরটা দেখাও', NOW, decoded);
  assert.equal(plan?.kind, 'cash_total');
  assert.equal(plan?.from, '2026-11-15');
  assert.equal(plan?.to, '2026-11-15');
});

test('edit/delete requests never reach SQL and explain the UI path', () => {
  const cash = writeIntentAnswer('ক্যাশ এন্ট্রিটা ডিলিট করতে চাই');
  assert.ok(cash);
  assert.match(cash.text, /REVIEW|Decline/);
  assert.doesNotMatch(cash.text, /SELECT|UPDATE|DELETE FROM/i);

  const employee = writeIntentAnswer('কর্মচারীর তথ্য এডিট করব');
  assert.match(employee.text, /Employees পেইজ/);

  assert.equal(writeIntentAnswer('গতকালের মোট খরচ কত?'), null);
});
