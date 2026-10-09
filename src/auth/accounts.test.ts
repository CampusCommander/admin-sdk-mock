import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { openRegistry } from '../store/registry.ts';
import { AccountError, issueServiceAccount } from './accounts.ts';

function registry() {
  const value = openRegistry(':memory:');
  value.addDomain(
    {
      customerId: 'C0abc1234',
      primaryDomain: 'district.test',
      spec: { tier: 'small', seed: 'x' },
      settings: DEFAULT_SETTINGS,
      seededAt: 0,
      createdAt: 0,
    },
    ['district.test'],
  );
  return value;
}

test('an issued file passes the Campus Commander credential rules', () => {
  const file = issueServiceAccount(registry(), 'C0abc1234');
  assert.equal(file.type, 'service_account');
  assert.match(file.client_id, /^\d{1,32}$/);
  assert.match(
    file.client_email,
    /^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/,
  );
  assert.equal(file.token_uri, 'https://oauth2.googleapis.com/token');
  assert.equal(file.universe_domain, 'googleapis.com');
  assert.ok(file.private_key_id.length > 0);
  const key = createPrivateKey(file.private_key);
  assert.equal(key.asymmetricKeyType, 'rsa');
  assert.equal(key.asymmetricKeyDetails?.modulusLength, 2048);
});

test('the registry keeps the public key and never the private key', () => {
  const store = registry();
  const file = issueServiceAccount(store, 'C0abc1234', 'district-project');
  const stored = store.serviceAccountByEmail(file.client_email);
  assert.equal(stored?.projectId, 'district-project');
  assert.match(stored!.publicKey, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(JSON.stringify(stored), /PRIVATE KEY/);
});

test('a malformed project ID fails', () => {
  assert.throws(
    () => issueServiceAccount(registry(), 'C0abc1234', 'Bad_Project'),
    AccountError,
  );
});
