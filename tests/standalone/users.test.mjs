// User administration integration tests. Super Admin only; no password or hash
// is ever returned. Uses the isolated test database.
import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import {row} from '../../lib/standalone/db.ts';
import {createUser, listUsers, resetUserPassword, updateUser} from '../../lib/standalone/users.ts';
import {resetBusinessState} from './reset.mjs';

const superAdmin = {id: 'f'.repeat(64), role: 'ADMIN', superAdmin: true};
const ordinaryAdmin = {id: 'e'.repeat(64), role: 'ADMIN', superAdmin: false};

before(async () => { await resetBusinessState('alrifai-users-test-reset'); });

test('users: super admin creates, updates and resets a user without exposing hashes', async () => {
  const username = `test-user-${Date.now().toString(36)}`;
  const created = await createUser(superAdmin, {
    username,
    password: 'InitialPass123',
    displayName: 'Test User',
    role: 'USER',
  });
  assert.equal(created.username, username);
  assert.equal(created.role, 'USER');

  const listed = (await listUsers()).find((entry) => entry.id === created.id);
  assert.ok(listed);
  assert.equal(Object.hasOwn(listed, 'password_hash'), false);

  const updated = await updateUser(superAdmin, {
    user: username,
    displayName: 'Updated User',
    role: 'ADMIN',
    active: true,
  });
  assert.equal(updated.displayName, 'Updated User');
  assert.equal(updated.role, 'ADMIN');

  const reset = await resetUserPassword(superAdmin, {user: username, password: 'ChangedPass123'});
  assert.equal(reset.sessionsRevoked, true);
  const stored = await row('SELECT must_change_password, password_hash FROM cash_portal_users WHERE id = $1', [created.id]);
  assert.equal(stored.must_change_password, true);
  assert.match(stored.password_hash, /^pbkdf2-sha256:600000:/);

  const deactivated = await updateUser(superAdmin, {user: username, active: false});
  assert.equal(deactivated.active, false);
});

test('users: an ADMIN who is not the configured Super Admin cannot manage users', async () => {
  await assert.rejects(
    () => createUser(ordinaryAdmin, {username: 'nope-user', password: 'InitialPass123'}),
    /SUPER_ADMIN_REQUIRED/,
  );
  await assert.rejects(
    () => updateUser(ordinaryAdmin, {user: 'nobody', active: false}),
    /SUPER_ADMIN_REQUIRED/,
  );
});
