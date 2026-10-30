import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeClock } from '../clock.ts';
import {
  cellText,
  createDriveStore,
  CSV_MIME,
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  formatAt,
  lastFilledRow,
  makeTab,
  newFileId,
  readRows,
  SHEET_MIME,
  tabById,
  writeRows,
} from './store.ts';

const setup = () => {
  const clock = fakeClock();
  return { clock, store: createDriveStore({ clock }) };
};

test('a new file ID has the 44 characters of a Drive ID', () => {
  const first = newFileId();
  assert.match(first, /^[A-Za-z0-9_-]{44}$/);
  assert.notEqual(first, newFileId());
});

test('a file is visible to its owner alone until a control route grants it', () => {
  const { store } = setup();
  const file = store.create('C07k9krdo', {
    name: 'Devices.csv',
    mimeType: CSV_MIME,
    owner: 'ana@example.test',
    content: 'id,name\n1,one\n',
  });
  assert.equal(file.content, 'id,name\n1,one\n');
  assert.equal(file.spreadsheet, null);
  assert.deepEqual(
    store.visible('C07k9krdo', 'ana@example.test').map((entry) => entry.id),
    [file.id],
  );
  assert.deepEqual(store.visible('C07k9krdo', 'ben@example.test'), []);
  assert.equal(
    store.readable('C07k9krdo', 'ben@example.test', file.id),
    undefined,
  );
  assert.equal(store.readable('C07k9krdo', 'ana@example.test', file.id), file);
  assert.equal(store.file('C07k9krdo', file.id), file);
  assert.equal(store.file('other', file.id), undefined);
  assert.equal(store.file('C07k9krdo', 'missing'), undefined);
});

test('a grant lets one subject read the files of another', () => {
  const { store } = setup();
  const file = store.create('C1', {
    name: 'Devices.csv',
    mimeType: CSV_MIME,
    owner: 'ana@example.test',
    content: 'a\n',
  });
  assert.deepEqual(store.grant('C1', file.id, 'ben@example.test').granted, [
    'ben@example.test',
  ]);
  assert.deepEqual(store.grant('C1', file.id, 'ben@example.test').granted, [
    'ben@example.test',
  ]);
  assert.equal(store.readable('C1', 'ben@example.test', file.id), file);
  assert.match(String(store.visible('C1', 'ben@example.test').length), /^1$/);
  assert.throws(() => store.grant('C1', 'missing', 'ben@example.test'));
});

test('a Google Sheet file carries tabs, and a seed without tabs gets one', () => {
  const { store } = setup();
  const seeded = store.create('C1', {
    id: 'sheet-1',
    name: 'Edit template',
    mimeType: SHEET_MIME,
    owner: 'ana@example.test',
    tabs: [{ title: 'Devices', rows: [['id', 'name']], frozenRowCount: 1 }],
  });
  assert.equal(seeded.id, 'sheet-1');
  const spreadsheet = seeded.spreadsheet!;
  assert.equal(spreadsheet.title, 'Edit template');
  assert.equal(spreadsheet.locale, 'en_US');
  assert.equal(spreadsheet.timeZone, 'UTC');
  assert.deepEqual(
    spreadsheet.tabs.map((tab) => [tab.sheetId, tab.title, tab.index]),
    [[0, 'Devices', 0]],
  );
  assert.equal(spreadsheet.tabs[0].frozenRowCount, 1);
  assert.deepEqual(spreadsheet.tabs[0].rows, [['id', 'name']]);

  const plain = store.create('C1', {
    name: 'Blank',
    mimeType: SHEET_MIME,
    owner: 'ana@example.test',
  });
  assert.deepEqual(
    plain.spreadsheet!.tabs.map((tab) => tab.title),
    ['Sheet1'],
  );
});

test('an update renames a file, rewrites its text, and stamps the time', async () => {
  const { clock, store } = setup();
  const file = store.create('C1', {
    name: 'Devices.csv',
    mimeType: CSV_MIME,
    owner: 'ana@example.test',
    content: 'a\n',
  });
  await clock.advance(5_000);
  store.update('C1', file.id, { name: 'Renamed.csv', content: 'b\n' });
  assert.equal(file.name, 'Renamed.csv');
  assert.equal(file.content, 'b\n');
  assert.equal(file.modifiedTime, file.createdTime + 5_000);
});

test('an update of a tab replaces its rows by sheet ID or by title', () => {
  const { store } = setup();
  const file = store.create('C1', {
    name: 'Edit',
    mimeType: SHEET_MIME,
    owner: 'ana@example.test',
    tabs: [
      { title: 'Devices', rows: [['a']] },
      { title: 'Other', rows: [['b']] },
    ],
  });
  store.update('C1', file.id, { tabs: [{ sheetId: 0, rows: [['x'], ['y']] }] });
  assert.deepEqual(file.spreadsheet!.tabs[0].rows, [['x'], ['y']]);
  store.update('C1', file.id, { tabs: [{ title: 'Other', rows: [['z']] }] });
  assert.deepEqual(file.spreadsheet!.tabs[1].rows, [['z']]);
  store.update('C1', file.id, { tabs: [{ sheetId: 0, title: 'Renamed' }] });
  assert.equal(file.spreadsheet!.tabs[0].title, 'Renamed');
  assert.throws(() =>
    store.update('C1', file.id, { tabs: [{ sheetId: 9, rows: [] }] }),
  );
});

test('a tab added through the store takes the next ID and index', () => {
  const { store } = setup();
  const file = store.create('C1', {
    name: 'Edit',
    mimeType: SHEET_MIME,
    owner: 'ana@example.test',
  });
  const tab = store.addTab('C1', file.id, { title: 'Second', rows: [['a']] });
  assert.deepEqual([tab.sheetId, tab.index, tab.title], [1, 1, 'Second']);
  const third = store.addTab('C1', file.id, {});
  assert.deepEqual([third.sheetId, third.index, third.title], [2, 2, 'Sheet3']);
  assert.equal(file.spreadsheet!.tabs.length, 3);
});

test('a file without tabs refuses a tab patch, and a missing file refuses every write', () => {
  const { store } = setup();
  const csv = store.create('C1', {
    name: 'Devices.csv',
    mimeType: CSV_MIME,
    owner: 'ana@example.test',
    content: 'a\n',
  });
  assert.throws(() => store.addTab('C1', csv.id, { title: 'x' }));
  assert.throws(() => store.update('C1', 'missing', {}));
  assert.throws(() => store.addTab('C1', 'missing', {}));
  assert.throws(() => store.touch('C1', 'missing'));
});

test('remove deletes one file and clear deletes the domain store', () => {
  const { store } = setup();
  const first = store.create('C1', {
    name: 'a.csv',
    mimeType: CSV_MIME,
    owner: 'ana@example.test',
    content: 'a\n',
  });
  store.create('C1', {
    name: 'b.csv',
    mimeType: CSV_MIME,
    owner: 'ana@example.test',
    content: 'b\n',
  });
  assert.equal(store.remove('C1', first.id), true);
  assert.equal(store.remove('C1', first.id), false);
  assert.equal(store.visible('C1', 'ana@example.test').length, 1);
  store.clear('C1');
  assert.deepEqual(store.visible('C1', 'ana@example.test'), []);
});

test('a tab starts at the default grid and grows to hold the rows it takes', () => {
  const tab = makeTab({ index: 0, rows: [['a', 'b', 'c']] });
  assert.equal(tab.sheetId, 0);
  assert.equal(tab.title, 'Sheet1');
  assert.equal(tab.rowCount, DEFAULT_ROWS);
  assert.equal(tab.columnCount, DEFAULT_COLUMNS);
  assert.equal(tab.frozenRowCount, 0);
  assert.equal(cellText(tab, 0, 1), 'b');
  assert.equal(cellText(tab, 5, 0), '');

  writeRows(tab, 1_000, 2, [['x', 'y'], ['z']]);
  assert.equal(tab.rowCount, 1_002);
  assert.equal(tab.columnCount, DEFAULT_COLUMNS);
  assert.equal(cellText(tab, 1_000, 3), 'y');
  assert.equal(cellText(tab, 1_001, 2), 'z');

  const wide = makeTab({ index: 1, columnCount: 2 });
  writeRows(wide, 0, 0, [['a', 'b', 'c']]);
  assert.equal(wide.columnCount, 3);
  assert.equal(wide.rows[0].length, 3);
});

test('readRows pads a rectangle to its width', () => {
  const tab = makeTab({ index: 0, rows: [['a'], ['b', 'c']] });
  assert.deepEqual(readRows(tab, 0, 2, 0, 3), [
    ['a', '', ''],
    ['b', 'c', ''],
  ]);
  assert.deepEqual(readRows(tab, 0, 0, 0, 3), []);
});

test('lastFilledRow reads the last row with a value', () => {
  const tab = makeTab({ index: 0 });
  assert.equal(lastFilledRow(tab), -1);
  writeRows(tab, 0, 0, [['a'], [''], ['c'], ['']]);
  assert.equal(lastFilledRow(tab), 2);
});

test('a number format covers the rectangle that it was set on, last one wins', () => {
  const tab = makeTab({ index: 0 });
  assert.equal(formatAt(tab, 0, 0), undefined);
  tab.formats.push({
    startRowIndex: 0,
    endRowIndex: 10,
    startColumnIndex: 0,
    endColumnIndex: 3,
    numberFormat: { type: 'TEXT' },
  });
  assert.deepEqual(formatAt(tab, 9, 2), { type: 'TEXT' });
  assert.equal(formatAt(tab, 10, 0), undefined);
  assert.equal(formatAt(tab, 0, 3), undefined);
  tab.formats.push({
    startRowIndex: 0,
    endRowIndex: 1,
    startColumnIndex: 0,
    endColumnIndex: 1,
    numberFormat: { type: 'NUMBER', pattern: '#,##0' },
  });
  assert.deepEqual(formatAt(tab, 0, 0), { type: 'NUMBER', pattern: '#,##0' });
  assert.deepEqual(formatAt(tab, 1, 0), { type: 'TEXT' });
});

test('tabById finds a tab and answers undefined for an unknown ID', () => {
  const tab = makeTab({ index: 0, sheetId: 7 });
  const spreadsheet = {
    title: 'x',
    locale: 'en_US',
    timeZone: 'UTC',
    tabs: [tab],
  };
  assert.equal(tabById(spreadsheet, 7), tab);
  assert.equal(tabById(spreadsheet, 8), undefined);
});
