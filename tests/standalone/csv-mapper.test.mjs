import assert from 'node:assert/strict';
import test from 'node:test';
import {autoMapColumns} from '../../lib/csv-auto-mapper.ts';
import {parseCsv, toCsv, splitDateShift, parseImportDate} from '../../lib/csv.ts';

test('vessel headers: exact and variant names map to the same fields', () => {
  const exact = autoMapColumns(['Mother Vessel', 'Lighter Vessel', 'Start Date', 'Escort Name'], 'vessel');
  assert.equal(exact.mapping.motherVessel, 0);
  assert.equal(exact.mapping.lighterVessel, 1);
  assert.equal(exact.mapping.startDate, 2);
  assert.equal(exact.mapping.escortName, 3);

  const variant = autoMapColumns(['mothervessel', 'Lighter_Name', 'start_date', 'escort mobile'], 'vessel');
  assert.equal(variant.mapping.motherVessel, 0);
  assert.equal(variant.mapping.lighterVessel, 1);
  assert.equal(variant.mapping.startDate, 2);
  assert.equal(variant.mapping.escortMobile, 3);
});

test('missing required header returns a suggestion list', () => {
  const mapped = autoMapColumns(['Foo', 'Bar'], 'vessel');
  assert.ok(mapped.missingRequired.some((item) => item.field === 'motherVessel'));
  assert.ok(mapped.missingRequired.some((item) => item.field === 'startDate'));
});

test('cash headers: mobile and amount are required', () => {
  const mapped = autoMapColumns(['employee_mobile', 'Amount', 'Name', 'Date'], 'cash');
  assert.equal(mapped.mapping.employeeMobile, 0);
  assert.equal(mapped.mapping.amount, 1);
  assert.equal(mapped.mapping.employeeName, 2);
  assert.equal(mapped.mapping.date, 3);
});

test('CSV parser handles quotes, commas and BOM', () => {
  const parsed = parseCsv('\uFEFFa,b\n"x,y","he said ""hi"""\n');
  assert.deepEqual(parsed.headers, ['a', 'b']);
  assert.deepEqual(parsed.rows[0], ['x,y', 'he said "hi"']);
});

test('CSV writer adds BOM and escapes quotes', () => {
  const csv = toCsv(['A', 'B'], [['x,y', 'he said "hi"']]);
  assert.ok(csv.startsWith('\uFEFFA,B'));
  assert.ok(csv.includes('"x,y"'));
  assert.ok(csv.includes('"he said ""hi"""'));
});

test('date/shift parsing accepts table format', () => {
  assert.deepEqual(splitDateShift('10.11.26 (D)'), {date: '2026-11-10', shift: 'D'});
  assert.equal(parseImportDate('2026-11-10'), '2026-11-10');
  assert.equal(parseImportDate('31/02/26'), null);
});
