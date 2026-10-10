import assert from 'node:assert/strict';
import test from 'node:test';
import {
  READ_SCOPES,
  READ_WRITE_SCOPES,
  SCOPES,
  WRITE_SCOPES,
} from './scopes.ts';

const P = 'https://www.googleapis.com/auth/';

test('group and member scopes follow the discovery document', () => {
  assert.deepEqual(SCOPES.group, [
    `${P}admin.directory.group`,
    `${P}admin.directory.group.readonly`,
  ]);
  assert.deepEqual(SCOPES.member, [
    `${P}admin.directory.group`,
    `${P}admin.directory.group.readonly`,
    `${P}admin.directory.group.member`,
    `${P}admin.directory.group.member.readonly`,
  ]);
  assert.deepEqual(WRITE_SCOPES.group, [`${P}admin.directory.group`]);
  assert.deepEqual(WRITE_SCOPES.member, [
    `${P}admin.directory.group`,
    `${P}admin.directory.group.member`,
  ]);
});

test('the test scope sets include group reads and group writes', () => {
  assert.ok(READ_SCOPES.includes(`${P}admin.directory.group.readonly`));
  assert.ok(!READ_SCOPES.includes(`${P}admin.directory.group`));
  assert.ok(READ_WRITE_SCOPES.includes(`${P}admin.directory.group`));
  assert.ok(READ_WRITE_SCOPES.includes(`${P}admin.directory.group.readonly`));
});
