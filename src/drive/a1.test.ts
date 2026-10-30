import assert from 'node:assert/strict';
import test from 'node:test';
import {
  A1Error,
  columnIndex,
  columnName,
  parseA1,
  quotedTitle,
  rangeText,
} from './a1.ts';
import { makeTab, writeRows } from './store.ts';

const tab = () => {
  const value = makeTab({
    index: 0,
    title: 'Devices',
    rowCount: 100,
    columnCount: 10,
  });
  writeRows(value, 0, 0, [
    ['id', 'name'],
    ['1', 'one'],
  ]);
  return value;
};

test('column letters and indices convert both ways', () => {
  assert.equal(columnIndex('A'), 0);
  assert.equal(columnIndex('Z'), 25);
  assert.equal(columnIndex('AA'), 26);
  assert.equal(columnIndex('ab'), 27);
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(27), 'AB');
  assert.equal(columnName(701), 'ZZ');
  assert.equal(columnIndex(columnName(1_234)), 1_234);
});

test('a range names a tab, a cell, a rectangle, or the whole tab', () => {
  const sheet = tab();
  const whole = parseA1([sheet], 'Devices');
  assert.deepEqual(
    [
      whole.tab,
      whole.startRow,
      whole.endRow,
      whole.startColumn,
      whole.endColumn,
      whole.open,
    ],
    [sheet, 0, 100, 0, 10, true],
  );
  const noTitle = parseA1([sheet], '');
  assert.deepEqual([noTitle.startRow, noTitle.endRow], [0, 100]);
  const cell = parseA1([sheet], 'Devices!B2');
  assert.deepEqual(
    [cell.startRow, cell.endRow, cell.startColumn, cell.endColumn, cell.open],
    [1, 2, 1, 2, false],
  );
  const block = parseA1([sheet], "'Devices'!A1:B2");
  assert.deepEqual(
    [
      block.startRow,
      block.endRow,
      block.startColumn,
      block.endColumn,
      block.open,
    ],
    [0, 2, 0, 2, false],
  );
  const openRows = parseA1([sheet], 'Devices!A2:B');
  assert.deepEqual(
    [openRows.endRow, openRows.endColumn, openRows.open],
    [100, 2, true],
  );
  const columns = parseA1([sheet], 'Devices!B:D');
  assert.deepEqual(
    [
      columns.startRow,
      columns.endRow,
      columns.startColumn,
      columns.endColumn,
      columns.open,
    ],
    [0, 100, 1, 4, true],
  );
  const rowOnly = parseA1([sheet], 'Devices!2:3');
  assert.deepEqual(
    [rowOnly.startRow, rowOnly.endRow, rowOnly.endColumn, rowOnly.open],
    [1, 3, 10, true],
  );
});

test('a quoted title with an apostrophe reads back the same', () => {
  const sheet = makeTab({ index: 0, title: "Ana's tab" });
  assert.equal(quotedTitle("Ana's tab"), "'Ana''s tab'");
  assert.equal(parseA1([sheet], "'Ana''s tab'!A1").tab, sheet);
  assert.equal(quotedTitle('Plain_1'), 'Plain_1');
});

test('rangeText writes an A1 range from a rectangle', () => {
  const sheet = tab();
  assert.equal(rangeText(sheet, 0, 0, 2, 10), 'Devices!A1:J2');
  assert.equal(rangeText(sheet, 0, 0, 0, 0), 'Devices!A1:A1');
  assert.equal(rangeText(sheet, 3, 1, 9, 3), 'Devices!B4:C9');
});

test('a range that the mock cannot read throws an A1Error', () => {
  const sheet = tab();
  for (const text of [
    'Missing!A1',
    'Devices!A1:B2:C3',
    'Devices!A1:',
    'Devices!A0',
  ])
    assert.throws(() => parseA1([sheet], text), A1Error, text);
  assert.throws(() => parseA1([sheet], 'Devices!B2:A1'), A1Error);
  assert.throws(() => parseA1([], 'A1'), A1Error);
});
