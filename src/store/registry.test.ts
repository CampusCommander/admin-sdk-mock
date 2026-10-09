import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { openRegistry, type StoredDomain } from './registry.ts';

const domain = (customerId = 'C0abc1234'): StoredDomain => ({
  customerId,
  primaryDomain: `${customerId.toLowerCase()}.test`,
  spec: { tier: 'small', seed: customerId },
  settings: DEFAULT_SETTINGS,
  seededAt: 1_000,
  createdAt: 900,
});

test('domains round-trip with their names, settings, and spec', () => {
  const registry = openRegistry(':memory:');
  registry.addDomain(domain(), ['c0abc1234.test', 'Students.C0abc1234.test']);
  assert.deepEqual(registry.getDomain('C0abc1234'), domain());
  assert.equal(registry.domainForName('students.c0abc1234.test'), 'C0abc1234');
  assert.equal(registry.domainForName('STUDENTS.C0ABC1234.TEST'), 'C0abc1234');
  assert.equal(registry.domainForName('other.test'), undefined);
  assert.equal(registry.listDomains().length, 1);
  registry.setSeededAt('C0abc1234', 2_000);
  registry.setSettings('C0abc1234', {
    ...DEFAULT_SETTINGS,
    telemetry: { recentReports: 5 },
  });
  const updated = registry.getDomain('C0abc1234');
  assert.equal(updated?.seededAt, 2_000);
  assert.equal(updated?.settings.telemetry.recentReports, 5);
});

test('deleting a domain removes its names, accounts, grants, and tokens', () => {
  const registry = openRegistry(':memory:');
  registry.addDomain(domain(), ['c0abc1234.test']);
  registry.addServiceAccount({
    clientId: '100000000000000000001',
    clientEmail: 'mock@project.iam.gserviceaccount.com',
    projectId: 'project',
    privateKeyId: 'abc',
    publicKey: 'PEM',
    customerId: 'C0abc1234',
  });
  registry.setGrant('C0abc1234', '100000000000000000001', ['scope-a']);
  registry.saveToken({
    token: 'ya29.x',
    clientId: '100000000000000000001',
    projectId: 'project',
    subject: 'admin@c0abc1234.test',
    customerId: 'C0abc1234',
    scopes: ['scope-a'],
    expiresAt: 5_000,
  });
  registry.deleteDomain('C0abc1234');
  assert.equal(registry.getDomain('C0abc1234'), undefined);
  assert.equal(registry.domainForName('c0abc1234.test'), undefined);
  assert.equal(
    registry.serviceAccountByEmail('mock@project.iam.gserviceaccount.com'),
    undefined,
  );
  assert.equal(registry.grant('C0abc1234', '100000000000000000001'), undefined);
  assert.equal(registry.token('ya29.x'), undefined);
});

test('grants replace earlier grants for the same client', () => {
  const registry = openRegistry(':memory:');
  registry.addDomain(domain(), ['c0abc1234.test']);
  registry.setGrant('C0abc1234', '1', ['a', 'b']);
  registry.setGrant('C0abc1234', '1', ['c']);
  assert.deepEqual(registry.grant('C0abc1234', '1'), ['c']);
});

test('service accounts and tokens round-trip', () => {
  const registry = openRegistry(':memory:');
  registry.addDomain(domain(), ['c0abc1234.test']);
  const account = {
    clientId: '100000000000000000001',
    clientEmail: 'Mock@Project.iam.gserviceaccount.com',
    projectId: 'project',
    privateKeyId: 'abc',
    publicKey: 'PEM',
    customerId: 'C0abc1234',
  };
  registry.addServiceAccount(account);
  assert.deepEqual(
    registry.serviceAccountByEmail('mock@project.iam.gserviceaccount.com'),
    { ...account, clientEmail: 'mock@project.iam.gserviceaccount.com' },
  );
  const token = {
    token: 'ya29.y',
    clientId: account.clientId,
    projectId: 'project',
    subject: 'admin@c0abc1234.test',
    customerId: 'C0abc1234',
    scopes: ['a', 'b'],
    expiresAt: 9_000,
  };
  registry.saveToken(token);
  assert.deepEqual(registry.token('ya29.y'), token);
});

test('stored settings that lack a newer key read back with its default', () => {
  const registry = openRegistry(':memory:');
  registry.addDomain(domain(), ['c0abc1234.test']);
  const { telemetry: _telemetry, ...older } = DEFAULT_SETTINGS;
  registry.setSettings('C0abc1234', {
    ...older,
    concurrency: { perMethod: 7 },
  } as unknown as typeof DEFAULT_SETTINGS);
  const settings = registry.getDomain('C0abc1234')?.settings;
  assert.deepEqual(settings?.telemetry, DEFAULT_SETTINGS.telemetry);
  assert.deepEqual(settings?.concurrency, {
    perMethod: 7,
    perCustomer: DEFAULT_SETTINGS.concurrency.perCustomer,
  });
  assert.deepEqual(settings?.quota, DEFAULT_SETTINGS.quota);
});
