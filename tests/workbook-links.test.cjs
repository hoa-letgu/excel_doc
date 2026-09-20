const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { EventEmitter } = require('node:events');
const ts = require('typescript');

const configModule = { exports: {} };
const configSource = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../lib/workbook-link-config.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
vm.runInThisContext(`(function(exports){${configSource}\n})`)(configModule.exports);
const { buildWorkbookLink } = configModule.exports;

// Exercise the real schema and functions without opening the user's database.
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const filename = path.resolve(__dirname, '../lib/db.js');
  const module = { exports: {} };
  const run = vm.runInThisContext(`(function(require,module,exports,__dirname){${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  run((id) => {
    if (id === 'node:sqlite') return { DatabaseSync: function () { return db; } };
    if (id === 'fs') return { ...fs, mkdirSync() {} };
    return require(id);
  }, module, module.exports, path.dirname(filename));
  const api = module.exports;
  const workbooks = {};
  for (const [sheet, row] of [['a', 1], ['b', 4], ['c', 8]]) {
    workbooks[sheet] = api.createWorkbook(sheet);
    api.upsertSheet(sheet, workbooks[sheet], sheet, 0);
    api.upsertCell(sheet, row, 0, JSON.stringify({ v: 'key-1' }), null);
  }
  const value = (sheet, row, col = 1) => JSON.parse(api.getCells(sheet).find(c => c.row === row && c.col === col)?.value || '{}').v;
  const edit = (sheet, row, data, col = 1) => {
    const previousCells = api.getCells(sheet);
    api.upsertCell(sheet, row, col, JSON.stringify(data), data?.f ?? null);
    return api.applyWorkbookLinksForEdit(sheet, { [row]: { [col]: data } }, previousCells);
  };
  const link = (left, right, bidirectional = true) => api.createWorkbookLink({
    leftWorkbookId: workbooks[left], leftSheetId: left, leftKeyCol: 0, leftValueCol: 1,
    rightWorkbookId: workbooks[right], rightSheetId: right, rightKeyCol: 0, rightValueCol: 1, bidirectional,
  });
  return { api, value, edit, link, workbooks };
}

test('edits reach all linked workbooks by key in both directions without cycling', (t) => {
  const { value, edit, link } = fixture(t);
  link('a', 'b'); link('b', 'c'); link('c', 'a');
  const updates = edit('a', 1, { v: 'first' });
  assert.equal(updates.length, 2);
  assert.equal(value('b', 4), 'first');
  assert.equal(value('c', 8), 'first');
  assert.equal(edit('c', 8, { v: 'reverse' }).length, 2);
  assert.equal(value('a', 1), 'reverse');
  assert.equal(value('b', 4), 'reverse');
});

test('creating a link returns live updates for existing downstream links', (t) => {
  const { api, value, edit, link } = fixture(t);
  link('b', 'c');
  edit('a', 1, { v: 'initial' });
  const updates = api.syncWorkbookLink(link('a', 'b'));
  assert.ok(updates.some(u => u.sheetId === 'b' && u.cellData.v === 'initial'));
  assert.ok(updates.some(u => u.sheetId === 'c' && u.cellData.v === 'initial'));
  assert.equal(value('c', 8), 'initial');
});

test('clears propagate with explicit nulls and one-way links stay one-way', (t) => {
  const { value, edit, link } = fixture(t);
  link('a', 'b', false); link('b', 'c', false);
  edit('a', 1, { v: 42, f: '=21*2' });
  const updates = edit('a', 1, {});
  assert.equal(updates.length, 2);
  for (const update of updates) {
    assert.equal(update.cellData.v, null);
    assert.equal(update.cellData.f, null);
  }
  assert.equal(value('c', 8), null);
  assert.equal(edit('c', 8, { v: 'local' }).length, 0);
  assert.equal(value('b', 4), null);
});

test('key changes match target rows, including duplicate keys, and ignore unmatched keys', (t) => {
  const { api, value, edit, link } = fixture(t);
  link('a', 'b');
  api.upsertCell('b', 6, 0, JSON.stringify({ v: 'key-1' }), null);
  assert.equal(edit('a', 1, { v: 'shared' }).length, 2);
  assert.equal(value('b', 6), 'shared');
  assert.equal(edit('a', 1, { v: 'unmatched' }, 0).length, 0);
  assert.equal(value('b', 4), 'shared');
  edit('a', 1, { v: 'updated' });
  edit('a', 1, { v: 'key-1' }, 0);
  assert.equal(value('a', 1), 'shared');
  assert.equal(value('b', 4), 'shared');
  assert.equal(value('b', 6), 'shared');
});

test('server broadcasts chained edits to connected viewers, respecting sheet permissions', async (t) => {
  const { api, link, workbooks } = fixture(t);
  link('a', 'b'); link('b', 'c');
  api.db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (100, 'viewer', 'unused', 'viewer')").run();
  api.setWorkbookPermission(100, workbooks.b, 'view');
  api.setWorkbookPermission(100, workbooks.c, 'view');
  const server = new EventEmitter();
  server.listen = () => {};
  let wss;
  class FakeWebSocketServer extends EventEmitter {
    constructor() { super(); this.clients = new Set(); wss = this; }
  }
  const filename = path.resolve(__dirname, '../server.js');
  const context = {
    require(id) {
      if (id === 'http') return { createServer: () => server };
      if (id === 'next') return () => ({ getRequestHandler: () => () => {}, prepare: async () => {} });
      if (id === 'ws') return { WebSocketServer: FakeWebSocketServer };
      if (id === './lib/db') return api;
      if (id === './lib/auth' || id === './lib/xlsx-io') return {};
      return require(id);
    },
    process, console, URL, setInterval() {},
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  await Promise.resolve();
  function connect(sheet, user) {
    const ws = new EventEmitter();
    Object.assign(ws, { workbookId: workbooks[sheet], user, clientId: `${sheet}-${user.id}`, OPEN: 1, readyState: 1, messages: [] });
    ws.send = (raw) => ws.messages.push(JSON.parse(raw));
    wss.clients.add(ws);
    wss.emit('connection', ws);
    return ws;
  }
  const source = connect('a', { id: 1, username: 'admin', role: 'admin' });
  const viewer = { id: 100, username: 'viewer', role: 'viewer' };
  const b = connect('b', viewer);
  const c = connect('c', viewer);
  source.emit('message', JSON.stringify({ type: 'edit', clientId: source.clientId, sheetId: 'a', cellValue: { 1: { 1: { v: 'live' } } } }));
  assert.equal(b.messages.find(m => m.type === 'edit').cellValue[4][1].v, 'live');
  assert.equal(c.messages.find(m => m.type === 'edit').cellValue[8][1].v, 'live');
  assert.ok(source.messages.some(m => m.type === 'ack'));
  api.setSheetPermission(100, 'c', 'none');
  c.messages.length = 0;
  source.emit('message', JSON.stringify({ type: 'edit', clientId: source.clientId, sheetId: 'a', cellValue: { 1: { 1: { v: 'hidden' } } } }));
  assert.equal(c.messages.filter(m => m.type === 'edit').length, 0);
  const editorB = connect('b', { id: 1, username: 'admin', role: 'admin' });
  b.messages.length = 0;
  editorB.messages.length = 0;
  editorB.emit('message', JSON.stringify({ type: 'edit', clientId: editorB.clientId, sheetId: 'b', cellValue: { 20: { 0: { v: 'key-1' }, 1: {} } } }));
  const bEdits = b.messages.filter(m => m.type === 'edit');
  assert.equal(bEdits[0].cellValue[20][0].v, 'key-1');
  assert.equal(bEdits.at(-1).cellValue[20][1].v, 'hidden');
  assert.equal(editorB.messages.find(m => m.type === 'edit').cellValue[20][1].v, 'hidden');
  const firstLink = api.listAllWorkbookLinks().find(link => link.leftSheetId === 'a');
  api.updateWorkbookLink(firstLink.id, { ...firstLink, bidirectional: false });
  b.messages.length = 0;
  source.emit('message', JSON.stringify({ type: 'edit', clientId: source.clientId, sheetId: 'a', cellValue: { 1: { 0: null } } }));
  const cleared = b.messages.find(m => m.type === 'edit');
  assert.equal(cleared.cellValue[4][1].v, null);
  assert.equal(cleared.cellValue[20][1].v, null);
  assert.equal(JSON.parse(api.getCell('b', 4, 0).value).v, 'key-1');
});

for (const direction of ['both', 'left-to-right', 'right-to-left']) {
  test(`${direction}: configured source, initial sync and later edits use the correct columns`, (t) => {
    const { api, value, edit, workbooks } = fixture(t);
    // Use different key/value columns and row positions on each side.
    api.upsertCell('b', 4, 2, JSON.stringify({ v: 'key-1' }), null);
    edit('a', 1, { v: 'from-1' }, 1);
    edit('b', 4, { v: 'from-2' }, 3);
    const config = buildWorkbookLink(direction,
      { workbookId: workbooks.a, sheetId: 'a', keyCol: 0, valueCol: 1 },
      { workbookId: workbooks.b, sheetId: 'b', keyCol: 2, valueCol: 3 });
    const reverse = direction === 'right-to-left';
    assert.equal(config.leftSheetId, reverse ? 'b' : 'a');
    assert.equal(config.leftKeyCol, reverse ? 2 : 0);
    assert.equal(config.leftValueCol, reverse ? 3 : 1);
    assert.equal(config.bidirectional, direction === 'both');
    api.syncWorkbookLink(api.createWorkbookLink(config));
    assert.equal(value('a', 1, 1), reverse ? 'from-2' : 'from-1');
    assert.equal(value('b', 4, 3), reverse ? 'from-2' : 'from-1');
    const fromLeft = edit('a', 1, { v: 'edit-1' }, 1);
    assert.equal(value('b', 4, 3), reverse ? 'from-2' : 'edit-1');
    assert.equal(fromLeft.length, reverse ? 0 : 1);
    const fromRight = edit('b', 4, { v: 'edit-2' }, 3);
    assert.equal(value('a', 1, 1), direction === 'left-to-right' ? 'edit-1' : 'edit-2');
    assert.equal(fromRight.length, direction === 'left-to-right' ? 0 : 1);
  });
}

for (const direction of ['both', 'left-to-right', 'right-to-left']) {
  test(`${direction}: entering a matching key fills the new receiving row without overwriting its source`, (t) => {
    const { api, edit, value, link } = fixture(t);
    const reverse = direction === 'right-to-left';
    const source = reverse ? 'b' : 'a';
    const target = reverse ? 'a' : 'b';
    const sourceRow = reverse ? 4 : 1;
    edit(source, sourceRow, { v: 100 });
    link(source, target, direction === 'both');
    const updates = edit(target, 20, { v: 'key-1' }, 0);
    assert.equal(value(target, 20), 100);
    assert.equal(value(source, sourceRow), 100);
    assert.ok(updates.some(u => u.sheetId === target && u.row === 20 && u.col === 1));
    assert.equal(value(target, 20, 0), 'key-1');
  });
}

test('two-way: adding a key on either side and pasting a key with blank data pull established values', (t) => {
  const { api, value, edit, link } = fixture(t);
  edit('b', 4, { v: 123 });
  link('a', 'b');
  edit('a', 15, { v: 'key-1' }, 0);
  assert.equal(value('a', 15), 123);
  api.upsertCell('a', 16, 0, JSON.stringify({ v: 'key-1' }), null);
  api.upsertCell('a', 16, 1, '{}', null);
  api.applyWorkbookLinksForEdit('a', { 16: { 0: { v: 'key-1' }, 1: {} } });
  assert.equal(value('a', 16), 123);
  assert.equal(value('b', 4), 123);
});

test('changing or clearing a key never pushes stale data into the other record', (t) => {
  const { api, value, edit, link } = fixture(t);
  edit('b', 4, { v: 'record-1' });
  edit('b', 7, { v: 'key-2' }, 0);
  edit('b', 7, { v: 'record-2' });
  link('a', 'b');
  edit('a', 1, { v: 'key-2' }, 0);
  assert.equal(value('a', 1), 'record-2');
  assert.equal(value('b', 4), 'record-1');
  assert.equal(value('b', 7), 'record-2');
  assert.equal(edit('a', 1, {}, 0).length, 0);
  assert.equal(value('b', 7), 'record-2');
  assert.equal(api.getCells('b').filter(c => c.col === 0).length, 2);
});

test('only configured data columns are copied; key and unrelated columns stay local', (t) => {
  const { api, value, edit, workbooks, link } = fixture(t);
  edit('a', 1, { v: 'B-source' });
  edit('a', 1, { v: 'C-source' }, 2);
  edit('b', 20, { v: 'D-local' }, 3);
  link('a', 'b', false);
  api.createWorkbookLink({ leftWorkbookId: workbooks.a, leftSheetId: 'a', leftKeyCol: 0, leftValueCol: 2,
    rightWorkbookId: workbooks.b, rightSheetId: 'b', rightKeyCol: 0, rightValueCol: 2, bidirectional: false });
  edit('b', 20, { v: 'key-1' }, 0);
  assert.equal(value('b', 20), 'B-source');
  assert.equal(value('b', 20, 2), 'C-source');
  assert.equal(value('b', 20, 3), 'D-local');
  assert.equal(edit('a', 1, { v: 'unlinked' }, 3).length, 0);
});

test('editing a saved link preserves its id and switches synchronization to the new configuration', (t) => {
  const { api, value, edit, link, workbooks } = fixture(t);
  const id = link('a', 'b');
  edit('a', 1, { v: 'old' });
  edit('c', 8, { v: 'new-source' });
  const config = { leftWorkbookId: workbooks.c, leftSheetId: 'c', leftKeyCol: 0, leftValueCol: 1,
    rightWorkbookId: workbooks.a, rightSheetId: 'a', rightKeyCol: 0, rightValueCol: 1, bidirectional: false };
  assert.equal(api.updateWorkbookLink(id, config), true);
  assert.equal(api.listAllWorkbookLinks().length, 1);
  assert.equal(api.listAllWorkbookLinks()[0].id, id);
  api.syncWorkbookLink(id);
  assert.equal(value('a', 1), 'new-source');
  assert.equal(value('b', 4), 'old');
  edit('c', 8, { v: 'live-new' });
  assert.equal(value('a', 1), 'live-new');
  assert.equal(edit('a', 1, { v: 'local-only' }).length, 0);
  assert.equal(value('c', 8), 'live-new');
  assert.equal(api.updateWorkbookLink(99999, config), false);
});

test('initial two-way linking does not clear populated right-side cells with empty left cells', (t) => {
  const { api, value, edit, link } = fixture(t);
  edit('b', 4, { v: 0 });
  api.syncWorkbookLink(link('a', 'b'));
  assert.equal(value('a', 1), 0);
  assert.equal(value('b', 4), 0);
});

test('structural snapshots match by key, hydrate new rows and do not delete remote rows', (t) => {
  const { api, value, edit, link } = fixture(t);
  edit('a', 1, { v: 'existing' });
  link('a', 'b', false);
  let before = api.getCells('b');
  api.replaceSheetCells('b', { 20: { 0: { v: 'key-1' } }, 30: { 0: { v: 'key-1' } } });
  // Existing keys moving are not new records; a newly introduced key is hydrated.
  api.applyWorkbookLinksForResync('b', before);
  assert.equal(value('b', 30), 'existing');
  edit('a', 2, { v: 'key-2' }, 0);
  edit('a', 2, { v: 'new' });
  before = api.getCells('b');
  api.replaceSheetCells('b', { 40: { 0: { v: 'key-2' } } });
  api.applyWorkbookLinksForResync('b', before);
  assert.equal(value('b', 40), 'new');
  assert.equal(value('a', 1), 'existing');
  assert.equal(value('a', 2), 'new');
  before = api.getCells('b');
  api.replaceSheetCells('b', {});
  assert.equal(api.applyWorkbookLinksForResync('b', before).length, 0);
  assert.equal(value('a', 2, 0), 'key-2');
});

for (const reverse of [false, true]) {
  for (const deleteRow of [false, true]) {
    test('one-way ' + (reverse ? '2→1' : '1→2') + ': deleting ' + (deleteRow ? 'source row' : 'source key') + ' clears only mapped target contents', (t) => {
      const { api, value, edit, workbooks } = fixture(t);
      const source = reverse ? 'b' : 'a';
      const target = reverse ? 'a' : 'b';
      const sourceRow = reverse ? 4 : 1;
      const targetRow = reverse ? 1 : 4;
      edit(source, sourceRow, { v: 25 });
      edit(source, sourceRow, { v: 50, f: '=25*2' }, 2);
      edit(target, targetRow, { v: 'keep unrelated' }, 3);
      for (const col of [1, 2]) {
        const id = api.createWorkbookLink({ leftWorkbookId: workbooks[source], leftSheetId: source, leftKeyCol: 0, leftValueCol: col,
          rightWorkbookId: workbooks[target], rightSheetId: target, rightKeyCol: 0, rightValueCol: col, bidirectional: false });
        api.syncWorkbookLink(id);
      }
      api.upsertCell(target, targetRow, 1, JSON.stringify({ v: 25, s: { bg: { rgb: '#ff0000' } } }), null);
      let updates;
      if (deleteRow) {
        const previous = api.getCells(source);
        api.replaceSheetCells(source, {});
        updates = api.applyWorkbookLinksForResync(source, previous);
      } else updates = edit(source, sourceRow, {}, 0);
      assert.equal(value(target, targetRow, 0), 'key-1');
      assert.equal(value(target, targetRow, 1), null);
      assert.equal(value(target, targetRow, 2), null);
      assert.equal(value(target, targetRow, 3), 'keep unrelated');
      assert.equal(api.getCell(target, targetRow, 2).formula, null);
      assert.equal(JSON.parse(api.getCell(target, targetRow, 1).value).s.bg.rgb, '#ff0000');
      assert.equal(updates.length, 2);
      assert.ok(updates.every(u => u.sheetId === target && [1, 2].includes(u.col) && u.cellData.v === null));
    });
  }
}

test('deleting a destination key or one duplicate source key does not clear other records', (t) => {
  const { value, edit, link } = fixture(t);
  link('a', 'b', false);
  edit('a', 1, { v: 'keep' });
  edit('a', 9, { v: 'key-1' }, 0);
  assert.equal(edit('a', 1, {}, 0).length, 0);
  assert.equal(value('b', 4), 'keep');
  edit('a', 9, { v: 'keep source' });
  assert.equal(edit('b', 4, {}, 0).length, 0);
  assert.equal(value('a', 9), 'keep source');
});
