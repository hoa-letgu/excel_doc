// xlsx <-> DB conversion, shared by scripts/import-xlsm.js and the
// upload/download routes in server.js.
const XLSX = require('xlsx');
const { db, upsertSheet, upsertCell, getSheets, getCells } = require('./db');

function toCellData(cell) {
  if (cell.t === 'n') {
    if (cell.z && XLSX.SSF.is_date(cell.z)) {
      return { v: cell.v, t: 2, s: { n: { pattern: cell.z } } };
    }
    return { v: cell.v, t: 2 };
  }
  if (cell.t === 'b') return { v: cell.v, t: 3 };
  return { v: String(cell.v), t: 1 };
}

function cellDataToXlsxCell(cellData) {
  if (cellData.t === 2) return { t: 'n', v: cellData.v };
  if (cellData.t === 3) return { t: 'b', v: cellData.v };
  return { t: 's', v: cellData.v != null ? String(cellData.v) : '' };
}

// buffer: Buffer/ArrayBuffer of a .xlsx or .xlsm file. Sheet ids are prefixed
// with the workbook id so they never collide with another workbook's sheets
// (see lib/db.js — this is why `cells` doesn't need its own workbook_id).
function importWorkbook(buffer, workbookId) {
  const wb = XLSX.read(buffer, { cellNF: true, cellDates: false });
  // Real files easily mean tens of thousands of individual cell writes —
  // without a transaction each is its own fsync'd commit (minutes on Windows,
  // freezing the whole single-threaded server meanwhile). Wrap the lot in one.
  db.exec('BEGIN');
  try {
    wb.SheetNames.forEach((sheetName, sheetOrder) => {
      const ws = wb.Sheets[sheetName];
      const ref = ws['!ref'];
      if (!ref) return;
      const range = XLSX.utils.decode_range(ref);
      const sheetId = `w${workbookId}-sheet${sheetOrder}`;
      upsertSheet(sheetId, workbookId, sheetName, sheetOrder);
      for (let r = range.s.r; r <= range.e.r; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          if (!cell) continue;
          upsertCell(sheetId, r, c, JSON.stringify(toCellData(cell)), cell.f ?? null);
        }
      }
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// IRange ({startRow,startColumn,endRow,endColumn}) -> xlsx's {s,e} cell-ref form.
function toXlsxMerges(mergeData) {
  return (mergeData || []).map((r) => ({
    s: { r: r.startRow, c: r.startColumn },
    e: { r: r.endRow, c: r.endColumn },
  }));
}

function exportWorkbook(workbookId) {
  const wb = XLSX.utils.book_new();
  for (const sheet of getSheets(workbookId)) {
    const ws = {};
    let maxRow = 0;
    let maxCol = 0;
    for (const { row, col, value, formula } of getCells(sheet.id)) {
      const cellData = value ? JSON.parse(value) : {};
      const xlsxCell = cellDataToXlsxCell(cellData);
      if (formula) xlsxCell.f = formula;
      ws[XLSX.utils.encode_cell({ r: row, c: col })] = xlsxCell;
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
    // ponytail: only merges round-trip to xlsx; column width/row height/freeze
    // pane are kept for in-app collab (lib/db.js `config`) but not written to
    // the exported file — add via ws['!cols']/'!rows'/'!freeze' if ever needed.
    const config = sheet.config ? JSON.parse(sheet.config) : {};
    if (config.mergeData?.length) ws['!merges'] = toXlsxMerges(config.mergeData);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Same as exportWorkbook but reads from an already-loaded snapshot object
// (getWorkbookSnapshot's shape) instead of the live DB — used to download a
// past history entry without touching current data.
function exportSnapshotData(snapshot) {
  const wb = XLSX.utils.book_new();
  for (const sheetId of snapshot.sheetOrder || []) {
    const sheet = snapshot.sheets[sheetId];
    const ws = {};
    let maxRow = 0;
    let maxCol = 0;
    for (const [row, cols] of Object.entries(sheet.cellData || {})) {
      for (const [col, cellData] of Object.entries(cols)) {
        const xlsxCell = cellDataToXlsxCell(cellData);
        if (cellData.f) xlsxCell.f = cellData.f;
        ws[XLSX.utils.encode_cell({ r: Number(row), c: Number(col) })] = xlsxCell;
        if (Number(row) > maxRow) maxRow = Number(row);
        if (Number(col) > maxCol) maxCol = Number(col);
      }
    }
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
    if (sheet.mergeData?.length) ws['!merges'] = toXlsxMerges(sheet.mergeData);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { importWorkbook, exportWorkbook, exportSnapshotData };
