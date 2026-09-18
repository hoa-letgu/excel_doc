// Shared SQLite storage for the workbook. Plain CommonJS so both the Next.js
// route handlers and the plain-node server.js / import script can require it.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'workbook.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS workbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS sheets (
    id TEXT PRIMARY KEY,
    workbook_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    config TEXT
  );
  CREATE TABLE IF NOT EXISTS cells (
    sheet_id TEXT NOT NULL,
    row INTEGER NOT NULL,
    col INTEGER NOT NULL,
    value TEXT,
    formula TEXT,
    PRIMARY KEY (sheet_id, row, col)
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workbook_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workbook_permissions (
    user_id INTEGER NOT NULL REFERENCES users(id),
    workbook_id INTEGER NOT NULL REFERENCES workbooks(id),
    level TEXT NOT NULL CHECK (level IN ('view', 'edit')),
    PRIMARY KEY (user_id, workbook_id)
  );
  CREATE TABLE IF NOT EXISTS sheet_permissions (
    user_id INTEGER NOT NULL REFERENCES users(id),
    sheet_id TEXT NOT NULL REFERENCES sheets(id),
    level TEXT NOT NULL CHECK (level IN ('view', 'edit', 'none')),
    PRIMARY KEY (user_id, sheet_id)
  );
`);

// Migration for DBs created before workbook_id existed. On a fresh DB the
// column is already in the CREATE TABLE above, so this throws "duplicate
// column name" and is ignored.
try {
  db.exec('ALTER TABLE sheets ADD COLUMN workbook_id INTEGER NOT NULL DEFAULT 1');
} catch {}
try {
  db.exec('ALTER TABLE sheets ADD COLUMN config TEXT');
} catch {}
try {
  db.exec('ALTER TABLE workbooks ADD COLUMN share_token TEXT');
} catch {}
db.exec(`INSERT OR IGNORE INTO workbooks (id, name) VALUES (1, 'Sample Sheet')`);

// One-time seed: preserves current behavior (every non-admin could see/edit
// every workbook) for data that existed before per-user permissions did. Only
// runs while the table is empty — new workbooks after this need explicit grants.
if (db.prepare(`SELECT COUNT(*) AS c FROM workbook_permissions`).get().c === 0) {
  const users = db.prepare(`SELECT id, role FROM users WHERE role != 'admin'`).all();
  const workbookIds = db.prepare(`SELECT id FROM workbooks`).all().map((w) => w.id);
  const seedStmt = db.prepare(`INSERT OR IGNORE INTO workbook_permissions (user_id, workbook_id, level) VALUES (?, ?, ?)`);
  for (const u of users) {
    const level = u.role === 'viewer' ? 'view' : 'edit';
    for (const wid of workbookIds) seedStmt.run(u.id, wid, level);
  }
}

const insertWorkbookStmt = db.prepare(`INSERT INTO workbooks (name) VALUES (?)`);
function createWorkbook(name) {
  return Number(insertWorkbookStmt.run(name).lastInsertRowid);
}

const renameWorkbookStmt = db.prepare(`UPDATE workbooks SET name = ? WHERE id = ?`);
function renameWorkbook(id, name) {
  renameWorkbookStmt.run(name, id);
}

function listWorkbooks() {
  return db.prepare(`SELECT id, name, created_at AS createdAt FROM workbooks ORDER BY id`).all();
}

// Public read-only share link (admin-enabled per workbook) — bypasses login
// entirely, no user/sheet-level filtering (an explicit admin opt-in to make
// the whole workbook publicly viewable, same trust level as admin bypass).
const setShareTokenStmt = db.prepare(`UPDATE workbooks SET share_token = ? WHERE id = ?`);
function setWorkbookShareToken(id, token) {
  setShareTokenStmt.run(token, id);
}
function getShareToken(workbookId) {
  return db.prepare(`SELECT share_token AS token FROM workbooks WHERE id = ?`).get(workbookId)?.token ?? null;
}
function getWorkbookByShareToken(token) {
  return db.prepare(`SELECT id, name FROM workbooks WHERE share_token = ?`).get(token);
}

const deleteWorkbookPermsByWorkbookStmt = db.prepare(`DELETE FROM workbook_permissions WHERE workbook_id = ?`);
const deleteSheetPermsByWorkbookStmt = db.prepare(`DELETE FROM sheet_permissions WHERE sheet_id IN (SELECT id FROM sheets WHERE workbook_id = ?)`);
const deleteCellsByWorkbookStmt = db.prepare(`DELETE FROM cells WHERE sheet_id IN (SELECT id FROM sheets WHERE workbook_id = ?)`);
const deleteSheetsByWorkbookStmt = db.prepare(`DELETE FROM sheets WHERE workbook_id = ?`);
const deleteSnapshotsByWorkbookStmt = db.prepare(`DELETE FROM snapshots WHERE workbook_id = ?`);
const deleteWorkbookStmt = db.prepare(`DELETE FROM workbooks WHERE id = ?`);
function deleteWorkbook(id) {
  db.exec('BEGIN');
  try {
    deleteCellsByWorkbookStmt.run(id);
    deleteSheetPermsByWorkbookStmt.run(id);
    deleteSheetsByWorkbookStmt.run(id);
    deleteWorkbookPermsByWorkbookStmt.run(id);
    deleteSnapshotsByWorkbookStmt.run(id);
    deleteWorkbookStmt.run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const upsertSheetStmt = db.prepare(`
  INSERT INTO sheets (id, workbook_id, name, order_index) VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, order_index = excluded.order_index
`);
function upsertSheet(id, workbookId, name, orderIndex) {
  upsertSheetStmt.run(id, workbookId, name, orderIndex);
}

// New sheets always append at the end (matches the common "+" tab workflow) —
// ponytail: a sheet inserted at a specific mid-list index client-side still
// lands at the end after a reload; upgrade to renumbering all order_index
// values if exact insert position ever needs to survive reload.
function nextOrderIndex(workbookId) {
  const row = db.prepare(`SELECT COALESCE(MAX(order_index), -1) AS maxIdx FROM sheets WHERE workbook_id = ?`).get(workbookId);
  return row.maxIdx + 1;
}

const renameSheetStmt = db.prepare(`UPDATE sheets SET name = ? WHERE id = ?`);
function renameSheet(id, name) {
  renameSheetStmt.run(name, id);
}

const deleteSheetCellsStmt = db.prepare(`DELETE FROM cells WHERE sheet_id = ?`);
const deleteSheetPermsStmt = db.prepare(`DELETE FROM sheet_permissions WHERE sheet_id = ?`);
const deleteSheetStmt = db.prepare(`DELETE FROM sheets WHERE id = ?`);
function deleteSheet(id) {
  deleteSheetCellsStmt.run(id);
  deleteSheetPermsStmt.run(id);
  deleteSheetStmt.run(id);
}

const upsertCellStmt = db.prepare(`
  INSERT INTO cells (sheet_id, row, col, value, formula) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(sheet_id, row, col) DO UPDATE SET value = excluded.value, formula = excluded.formula
`);
// cellDataJson: JSON string of { v, t, s } (Univer ICellData minus f) or null to clear.
function upsertCell(sheetId, row, col, cellDataJson, formula) {
  upsertCellStmt.run(sheetId, row, col, cellDataJson, formula ?? null);
}

function getSheets(workbookId) {
  return db
    .prepare(`SELECT id, name, order_index AS orderIndex, config FROM sheets WHERE workbook_id = ? ORDER BY order_index`)
    .all(workbookId);
}

function getCells(sheetId) {
  return db.prepare(`SELECT row, col, value, formula FROM cells WHERE sheet_id = ?`).all(sheetId);
}

// Structural sheet state beyond cellData — merges, freeze, row/col sizing &
// hidden flags, row/col counts. Stored as one JSON blob rather than separate
// columns since it's always read/written as a whole (matches how the client
// sends it: a full re-dump from `workbook.save()` after any structural edit).
const setSheetConfigStmt = db.prepare(`UPDATE sheets SET config = ? WHERE id = ?`);
function setSheetConfig(id, configJson) {
  setSheetConfigStmt.run(configJson, id);
}

// Wholesale replace of a sheet's cells — used after row/col insert/delete/move,
// where positions shift enough that patching individual (row,col) keys in SQL
// would mean reimplementing Univer's own shift logic. The client already has
// the correct post-mutation cellData in memory; just mirror it.
function replaceSheetCells(sheetId, cellData) {
  db.exec('BEGIN');
  try {
    deleteSheetCellsStmt.run(sheetId);
    for (const [row, cols] of Object.entries(cellData || {})) {
      for (const [col, cd] of Object.entries(cols)) {
        const { f, ...rest } = cd || {};
        upsertCell(sheetId, Number(row), Number(col), JSON.stringify(rest), f ?? null);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Builds a Univer IWorkbookData snapshot (Partial<IWorkbookData> is fine — Univer fills in defaults).
function getWorkbookSnapshot(workbookId) {
  const workbook = db.prepare(`SELECT id, name FROM workbooks WHERE id = ?`).get(workbookId);
  const sheets = getSheets(workbookId);
  const sheetsObj = {};
  const notesBySheet = {};
  const drawingsBySheet = {};
  for (const sheet of sheets) {
    const cellRows = getCells(sheet.id);
    const cellData = {};
    let maxRow = 0;
    let maxCol = 0;
    for (const { row, col, value, formula } of cellRows) {
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
      const cd = value ? JSON.parse(value) : {};
      if (formula) cd.f = formula;
      (cellData[row] ??= {})[col] = cd;
    }
    const config = sheet.config ? JSON.parse(sheet.config) : {};
    if (config.notes && Object.keys(config.notes).length > 0) notesBySheet[sheet.id] = config.notes;
    if (config.drawings && Object.keys(config.drawings.data ?? {}).length > 0) drawingsBySheet[sheet.id] = config.drawings;
    sheetsObj[sheet.id] = {
      id: sheet.id,
      name: sheet.name,
      cellData,
      rowCount: config.rowCount ?? Math.max(maxRow + 50, 200),
      columnCount: config.columnCount ?? Math.max(maxCol + 10, 26),
      mergeData: config.mergeData ?? [],
      freeze: config.freeze,
      rowData: config.rowData ?? {},
      columnData: config.columnData ?? {},
    };
  }
  // Cell comments (hover notes) and inserted images (drawings) live inside
  // each sheet's own `config` column (see persistSheetStructure in
  // SpreadsheetEditor.tsx) — reassembled here into the workbook-level
  // `resources` shape Univer's note/drawing plugins expect on load.
  const resources = [];
  if (Object.keys(notesBySheet).length > 0) resources.push({ name: 'SHEET_NOTE_PLUGIN', data: JSON.stringify(notesBySheet) });
  if (Object.keys(drawingsBySheet).length > 0) resources.push({ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify(drawingsBySheet) });
  return {
    id: `workbook-${workbookId}`,
    name: workbook?.name ?? 'Untitled',
    appVersion: '0.25.1',
    sheetOrder: sheets.map((s) => s.id),
    sheets: sheetsObj,
    resources,
  };
}

// --- Edit history: hourly full-workbook snapshots, pruned after 1 week. ---
const insertSnapshotStmt = db.prepare(`INSERT INTO snapshots (workbook_id, data) VALUES (?, ?)`);
function saveSnapshot(workbookId, dataJson) {
  insertSnapshotStmt.run(workbookId, dataJson);
}

function listSnapshots(workbookId) {
  return db
    .prepare(`SELECT id, created_at AS createdAt FROM snapshots WHERE workbook_id = ? ORDER BY created_at DESC`)
    .all(workbookId);
}

function getSnapshot(id) {
  return db.prepare(`SELECT id, workbook_id AS workbookId, created_at AS createdAt, data FROM snapshots WHERE id = ?`).get(id);
}

const pruneSnapshotsStmt = db.prepare(`DELETE FROM snapshots WHERE created_at < unixepoch() - 7 * 24 * 3600`);
function pruneSnapshots() {
  pruneSnapshotsStmt.run();
}

// Replaces a workbook's sheets/cells with a previously saved snapshot
// (shape matches getWorkbookSnapshot's output: {sheetOrder, sheets: {id: {name, cellData}}}).
function restoreSnapshot(workbookId, snapshot) {
  const currentSheetIds = getSheets(workbookId).map((s) => s.id);
  const newSheetIds = snapshot.sheetOrder || Object.keys(snapshot.sheets || {});
  const noteResource = (snapshot.resources || []).find((r) => r.name === 'SHEET_NOTE_PLUGIN');
  const notesBySheet = noteResource ? JSON.parse(noteResource.data || '{}') : {};
  const drawingResource = (snapshot.resources || []).find((r) => r.name === 'SHEET_DRAWING_PLUGIN');
  const drawingsBySheet = drawingResource ? JSON.parse(drawingResource.data || '{}') : {};
  db.exec('BEGIN');
  try {
    for (const id of currentSheetIds) {
      if (!newSheetIds.includes(id)) deleteSheet(id);
      else deleteSheetCellsStmt.run(id); // clear stale cells before rewriting from the snapshot
    }
    newSheetIds.forEach((id, index) => {
      const sheet = snapshot.sheets[id];
      upsertSheet(id, workbookId, sheet.name, index);
      setSheetConfig(id, JSON.stringify({
        mergeData: sheet.mergeData ?? [],
        freeze: sheet.freeze,
        rowData: sheet.rowData ?? {},
        columnData: sheet.columnData ?? {},
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        notes: notesBySheet[id] ?? {},
        drawings: drawingsBySheet[id] ?? { data: {}, order: [] },
      }));
      for (const [row, cols] of Object.entries(sheet.cellData || {})) {
        for (const [col, cellData] of Object.entries(cols)) {
          const { f, ...rest } = cellData || {};
          upsertCell(id, Number(row), Number(col), JSON.stringify(rest), f ?? null);
        }
      }
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// --- Per-user permissions: workbook-level base + optional per-sheet override.
// Sheet override is independent of the workbook level (can upgrade to 'edit'
// or downgrade/hide with 'none'); no override means "inherit the workbook's
// level". `admin` bypasses all of this entirely (checked by the callers below).
function listUsers() {
  return db.prepare(`SELECT id, username, role FROM users ORDER BY id`).all();
}

const setWorkbookPermStmt = db.prepare(`
  INSERT INTO workbook_permissions (user_id, workbook_id, level) VALUES (?, ?, ?)
  ON CONFLICT(user_id, workbook_id) DO UPDATE SET level = excluded.level
`);
const deleteWorkbookPermStmt = db.prepare(`DELETE FROM workbook_permissions WHERE user_id = ? AND workbook_id = ?`);
function setWorkbookPermission(userId, workbookId, level) {
  if (!level) deleteWorkbookPermStmt.run(userId, workbookId);
  else setWorkbookPermStmt.run(userId, workbookId, level);
}

const setSheetPermStmt = db.prepare(`
  INSERT INTO sheet_permissions (user_id, sheet_id, level) VALUES (?, ?, ?)
  ON CONFLICT(user_id, sheet_id) DO UPDATE SET level = excluded.level
`);
const deleteSheetPermStmt = db.prepare(`DELETE FROM sheet_permissions WHERE user_id = ? AND sheet_id = ?`);
function setSheetPermission(userId, sheetId, level) {
  if (!level) deleteSheetPermStmt.run(userId, sheetId);
  else setSheetPermStmt.run(userId, sheetId, level);
}

function effectiveWorkbookLevel(user, workbookId) {
  if (user.role === 'admin') return 'edit';
  const row = db.prepare(`SELECT level FROM workbook_permissions WHERE user_id = ? AND workbook_id = ?`).get(user.id, workbookId);
  return row?.level ?? null;
}

function effectiveSheetLevel(user, workbookId, sheetId) {
  if (user.role === 'admin') return 'edit';
  const row = db.prepare(`SELECT level FROM sheet_permissions WHERE user_id = ? AND sheet_id = ?`).get(user.id, sheetId);
  if (row) return row.level;
  return effectiveWorkbookLevel(user, workbookId);
}

// Workbooks a non-admin user should even see in their list: an explicit
// workbook-level grant, OR at least one sheet-level 'view'/'edit' override
// inside it even without a workbook-level row.
function listAccessibleWorkbooks(user) {
  if (user.role === 'admin') return listWorkbooks();
  return db
    .prepare(
      `SELECT DISTINCT w.id, w.name, w.created_at AS createdAt, wp.level AS level
       FROM workbooks w
       LEFT JOIN workbook_permissions wp ON wp.workbook_id = w.id AND wp.user_id = ?
       LEFT JOIN sheets s ON s.workbook_id = w.id
       LEFT JOIN sheet_permissions sp ON sp.sheet_id = s.id AND sp.user_id = ? AND sp.level IN ('view', 'edit')
       WHERE wp.level IS NOT NULL OR sp.level IS NOT NULL
       ORDER BY w.id`
    )
    .all(user.id, user.id);
}

// For the admin permission-management screen: every user's grant on this
// workbook, plus every sheet-level override within it.
function getPermissionsForWorkbook(workbookId) {
  const workbookPermissions = db
    .prepare(
      `SELECT wp.user_id AS userId, u.username, wp.level FROM workbook_permissions wp
       JOIN users u ON u.id = wp.user_id WHERE wp.workbook_id = ?`
    )
    .all(workbookId);
  const sheetPermissions = db
    .prepare(
      `SELECT sp.user_id AS userId, u.username, sp.sheet_id AS sheetId, s.name AS sheetName, sp.level
       FROM sheet_permissions sp
       JOIN users u ON u.id = sp.user_id
       JOIN sheets s ON s.id = sp.sheet_id
       WHERE s.workbook_id = ?`
    )
    .all(workbookId);
  return { workbookPermissions, sheetPermissions };
}

module.exports = {
  db,
  createWorkbook,
  listWorkbooks,
  renameWorkbook,
  deleteWorkbook,
  setWorkbookShareToken,
  getShareToken,
  getWorkbookByShareToken,
  upsertSheet,
  nextOrderIndex,
  renameSheet,
  deleteSheet,
  upsertCell,
  getSheets,
  getCells,
  setSheetConfig,
  replaceSheetCells,
  getWorkbookSnapshot,
  saveSnapshot,
  listSnapshots,
  getSnapshot,
  pruneSnapshots,
  restoreSnapshot,
  listUsers,
  setWorkbookPermission,
  setSheetPermission,
  effectiveWorkbookLevel,
  effectiveSheetLevel,
  listAccessibleWorkbooks,
  getPermissionsForWorkbook,
};
