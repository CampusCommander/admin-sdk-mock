import assert from 'node:assert/strict';
import test from 'node:test';
import { dateRange, parseDeviceQuery, QueryError } from './device-query.ts';

const day = (text: string) => Date.parse(`${text}T00:00:00Z`);

test('date ranges support every documented form', () => {
  assert.deepEqual(dateRange('2026-10-01'), {
    from: day('2026-10-01'),
    to: day('2026-10-02'),
  });
  assert.deepEqual(dateRange('..2026-10-01'), { to: day('2026-10-02') });
  assert.deepEqual(dateRange('2026-10-01..'), { from: day('2026-10-01') });
  assert.deepEqual(dateRange('2023-1-1..2023-12-31'), {
    from: day('2023-01-01'),
    to: day('2024-01-01'),
  });
  const instant = Date.parse('2026-10-01T10:00:00Z');
  assert.deepEqual(dateRange('2026-10-01T10:00:00'), {
    from: instant,
    to: instant + 1000,
  });
});

test('operators become SQL clauses with parameters', () => {
  const filter = parseDeviceQuery(
    'status:disabled asset_id:CB12 user:"tom sawyer" sync:2026-10-01..',
  );
  assert.deepEqual(filter.where, [
    "status = 'DISABLED'",
    "annotated_asset_id LIKE ? ESCAPE '\\'",
    "annotated_user LIKE ? ESCAPE '\\'",
    'last_sync >= ?',
  ]);
  assert.deepEqual(filter.params, [
    '%CB12%',
    '%tom sawyer%',
    day('2026-10-01'),
  ]);
});

test('free text searches several fields at once', () => {
  const filter = parseDeviceQuery('Library');
  assert.equal(filter.where.length, 1);
  assert.equal(filter.params.length, 6);
  assert.ok(filter.params.every((value) => value === '%Library%'));
});

test('LIKE wildcards in values are escaped', () => {
  assert.deepEqual(parseDeviceQuery('note:100%_done').params, [
    '%100\\%\\_done%',
  ]);
});

test('invalid queries fail', () => {
  for (const text of [
    'id:ab',
    'status:broken',
    'boot_mode:fast',
    'sync:yesterday',
    'robots:1',
    'sync:..',
  ])
    assert.throws(() => parseDeviceQuery(text), QueryError, text);
});
