import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from '../random.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { computeDelayMs, type DelayInput } from './model.ts';

const settings = DEFAULT_SETTINGS.latency;
const samples = (input: DelayInput, count = 500) => {
  const random = createRandom('latency');
  return Array.from({ length: count }, () =>
    computeDelayMs(input, settings, random),
  ).sort((a, b) => a - b);
};
const median = (values: number[]) => values[Math.floor(values.length / 2)];
const base: DelayInput = {
  api: 'directory',
  bytes: 0,
  items: 0,
  scanned: 0,
  inFlight: 0,
  parts: 0,
};

test('a full 300-device page lands between 1 and 2 seconds', () => {
  const values = samples({ ...base, bytes: 1_100_000, items: 300 });
  assert.ok(values[0] >= 1000, `min ${values[0]}`);
  assert.ok(values.at(-1)! <= 2000, `max ${values.at(-1)}`);
});

test('a single get has a median from 150 to 300 ms', () => {
  const value = median(samples({ ...base, bytes: 4_000, items: 1 }));
  assert.ok(value >= 150 && value <= 300, `median ${value}`);
});

test('the cap holds without load', () => {
  const values = samples({ ...base, bytes: 50_000_000, items: 10_000 });
  assert.equal(values.at(-1), 2000);
});

test('load above the threshold multiplies the delay', () => {
  const quiet = computeDelayMs(
    { ...base, items: 1 },
    settings,
    createRandom('x'),
  );
  const busy = computeDelayMs(
    { ...base, items: 1, inFlight: 70 },
    settings,
    createRandom('x'),
  );
  assert.ok(Math.abs(busy / quiet - 2) < 1e-9, `ratio ${busy / quiet}`);
});

test('a batch pays once per wave of parts', () => {
  const ten = computeDelayMs(
    { ...base, api: 'batch', parts: 10 },
    settings,
    createRandom('y'),
  );
  const twenty = computeDelayMs(
    { ...base, api: 'batch', parts: 20 },
    settings,
    createRandom('y'),
  );
  assert.ok(Math.abs(twenty - ten - settings.batchPartMs) < 1e-9);
});

test('the same random stream gives the same delays', () => {
  assert.deepEqual(
    samples({ ...base, items: 5 }, 20),
    samples({ ...base, items: 5 }, 20),
  );
});

test('a write costs the write base, the per-device cost, and the cascade scan', () => {
  const flat = {
    ...settings,
    roundTripMedianMs: 1,
    roundTripP99Ms: 1,
  };
  const random = createRandom('write');
  const move = computeDelayMs(
    { ...base, write: true, items: 50 },
    flat,
    random,
  );
  assert.ok(Math.abs(move - (1 + 250 + 500)) < 0.001, String(move));
  const cascade = computeDelayMs(
    { ...base, write: true, scanned: 100_000 },
    flat,
    random,
  );
  assert.ok(Math.abs(cascade - (1 + 250 + 200)) < 0.001, String(cascade));
  const read = computeDelayMs({ ...base, items: 50 }, flat, random);
  assert.ok(Math.abs(read - (1 + 150 + 150)) < 0.001, String(read));
});
