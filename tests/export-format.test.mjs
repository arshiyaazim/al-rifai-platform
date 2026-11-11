import assert from 'node:assert/strict';
import test from 'node:test';
import {bdtNumber, csvCell, dateDdMmYyyy, toCsv} from '../lib/export-format.ts';

test('CSV cells escape quotes, commas and newlines', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell(null), '');
});

test('CSV export starts with a UTF-8 BOM and uses CRLF', () => {
  const csv = toCsv(
    [{name: 'Rahim', amount: '1250.00'}, {name: 'Bangla: রহিম', amount: '10.00'}],
    [
      {header: 'Name', value: (row) => row.name},
      {header: 'Amount', value: (row) => row.amount},
    ],
  );
  assert.ok(csv.startsWith('\uFEFFName,Amount\r\n'));
  assert.ok(csv.includes('Rahim,1250.00\r\n'));
  assert.ok(csv.endsWith('\r\n'));
});

test('money and date helpers use BDT decimals and DD-MM-YYYY', () => {
  assert.equal(bdtNumber('123456'), '1234.56');
  assert.equal(bdtNumber(0), '0.00');
  assert.equal(bdtNumber(null), '');
  assert.equal(dateDdMmYyyy('2026-11-09'), '09-11-2026');
  assert.equal(dateDdMmYyyy('2026-11-09T12:00:00.000Z'), '09-11-2026');
});
