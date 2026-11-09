// Pure ActionForm HTTP-wiring tests. The employee update form must use PATCH,
// not the default POST, or /api/employees treats it as a create/review.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildActionFormRequest} from '../../lib/action-form-request.ts';

const CSRF = 'a'.repeat(64);

test('default method is POST, preserving every existing form', () => {
  const request = buildActionFormRequest({values: {a: 1}, csrf: CSRF});
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['X-CSRF-Token'], CSRF);
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.body), {a: 1});
});

test('PATCH is preserved for the employee update form', () => {
  const request = buildActionFormRequest({
    method: 'PATCH',
    values: {employeeMobile: '+8801712345678', preferredName: 'New Name', state: 'ACTIVE'},
    csrf: CSRF,
  });
  assert.equal(request.method, 'PATCH');
  assert.deepEqual(JSON.parse(request.body), {
    employeeMobile: '+8801712345678', preferredName: 'New Name', state: 'ACTIVE',
  });
});

test('DELETE is supported without changing the body contract', () => {
  const request = buildActionFormRequest({method: 'DELETE', values: {id: 'x'}, csrf: CSRF});
  assert.equal(request.method, 'DELETE');
  assert.deepEqual(JSON.parse(request.body), {id: 'x'});
});

test('action is merged ahead of values', () => {
  const request = buildActionFormRequest({action: 'instruction.approve', values: {id: 'x', action: 'bad'}, csrf: CSRF});
  assert.deepEqual(JSON.parse(request.body), {action: 'instruction.approve', id: 'x'});
});

test('invalid method or CSRF is rejected', () => {
  assert.throws(() => buildActionFormRequest({method: 'PUT', values: {}, csrf: CSRF}), /ACTION_FORM_METHOD_INVALID/);
  assert.throws(() => buildActionFormRequest({values: {}, csrf: 'short'}), /ACTION_FORM_CSRF_INVALID/);
});
