import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAliasEntries, isMinorNameVariant, normalizeName} from '../lib/name-alias.ts';

test('punctuation, dash, dot and spacing are minor variants', () => {
  assert.equal(isMinorNameVariant('Md. Abdul Karim', 'MD Abdul-Karim'), true);
  assert.equal(isMinorNameVariant('Abdul Karim', 'AbdulKarim'), true);
  assert.equal(normalizeName('  Md.  Karim  '), 'md karim');
});

test('a different person name on the same ID is kept as an alias', () => {
  const rows = buildAliasEntries([
    {employee_mobile: '+8801711111111', preferred_name: 'Md Karim', name_aliases: ['Mohammad Karim']},
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'SAME_ID_DIFFERENT_NAME');
  assert.equal(rows[0].aliasName, 'Mohammad Karim');
});

test('same name under different IDs appears in the alias table, not merged', () => {
  const rows = buildAliasEntries([
    {employee_mobile: '+8801711111111', preferred_name: 'Md Karim', name_aliases: []},
    {employee_mobile: '+8801811111111', preferred_name: 'MD. KARIM', name_aliases: []},
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'SAME_NAME_DIFFERENT_ID');
  assert.equal(rows[0].employeeId, '+8801711111111');
  assert.equal(rows[0].otherEmployeeId, '+8801811111111');
});

test('completely different names are not treated as variants', () => {
  assert.equal(isMinorNameVariant('Md Karim', 'Rahim Uddin'), false);
});
