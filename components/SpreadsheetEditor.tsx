'use client';

import { useEffect, useRef, useState } from 'react';
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import UniverPresetSheetsCoreViVN from '@univerjs/preset-sheets-core/locales/vi-VN';
import '@univerjs/preset-sheets-core/lib/index.css';
import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note';
import UniverPresetSheetsNoteViVN from '@univerjs/preset-sheets-note/locales/vi-VN';
import '@univerjs/preset-sheets-note/lib/index.css';
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing';
import UniverPresetSheetsDrawingViVN from '@univerjs/preset-sheets-drawing/locales/vi-VN';
import '@univerjs/preset-sheets-drawing/lib/index.css';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import UniverPresetSheetsFilterViVN from '@univerjs/preset-sheets-filter/locales/vi-VN';
import '@univerjs/preset-sheets-filter/lib/index.css';
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort';
import UniverPresetSheetsSortViVN from '@univerjs/preset-sheets-sort/locales/vi-VN';
import '@univerjs/preset-sheets-sort/lib/index.css';
import type { FUniver } from '@univerjs/presets';
import { CommandType } from '@univerjs/core';
import { COMMAND_LISTENER_SKELETON_CHANGE, COMMAND_LISTENER_VALUE_CHANGE, SetFrozenMutation } from '@univerjs/sheets';
import { UpdateNoteMutation, RemoveNoteMutation, UpdateNotePositionMutation } from '@univerjs/sheets-note';
import { SetDrawingApplyMutation } from '@univerjs/sheets-drawing';

export type EditorApi = { undo: () => void; redo: () => void };

type CellChangeMsg = {
  type: 'edit';
  clientId: string;
  sheetId: string;
  cellValue: Record<string, Record<string, unknown>>;
};

type SheetCreatedMsg = { type: 'sheet-created'; clientId: string; sheetId: string; name: string; index: number };
type SheetDeletedMsg = { type: 'sheet-deleted'; clientId: string; sheetId: string };
type SheetRenamedMsg = { type: 'sheet-renamed'; clientId: string; sheetId: string; name: string };
type MutationMsg = { type: 'mutation'; clientId: string; sheetId: string; id: string; params: unknown };

type IncomingMsg =
  | CellChangeMsg
  | { type: 'ack' }
  | { type: 'roster'; users: RosterUser[] }
  | { type: 'reload' }
  | SheetCreatedMsg
  | SheetDeletedMsg
  | SheetRenamedMsg
  | MutationMsg;

// Structural mutations (merge, freeze, row/col insert/delete/resize/hide/move,
// ...) relayed live via the generic CommandExecuted listener below. Plain cell
// edits (set-range-values) stay on the existing SheetValueChanged path.
const STRUCTURAL_MUTATION_IDS = new Set<string>([
  ...COMMAND_LISTENER_SKELETON_CHANGE,
  ...COMMAND_LISTENER_VALUE_CHANGE,
  SetFrozenMutation.id,
  UpdateNoteMutation.id,
  RemoveNoteMutation.id,
  UpdateNotePositionMutation.id,
  SetDrawingApplyMutation.id,
  'sheet.mutation.set-filter-range',
  'sheet.mutation.set-filter-criteria',
  'sheet.mutation.remove-filter',
  'sheet.mutation.re-calc-filter',
]);
STRUCTURAL_MUTATION_IDS.delete('sheet.mutation.set-range-values'); // handled by SheetValueChanged already
STRUCTURAL_MUTATION_IDS.delete('sheet.mutation.set-worksheet-row-auto-height'); // each client recomputes this locally from its own font/zoom

// Mutations that shift existing cells' (row, col) positions — these need a
// full cellData re-dump to persist correctly, not just a config patch.
const RESYNC_MUTATION_IDS = new Set([
  'sheet.mutation.insert-row',
  'sheet.mutation.insert-col',
  'sheet.mutation.remove-rows',
  'sheet.mutation.remove-col',
  'sheet.mutation.move-rows',
  'sheet.mutation.move-columns',
  'sheet.mutation.move-range',
  'sheet.mutation.reorder-range',
]);

export type RosterUser = {
  clientId: string;
  username: string;
  ip: string;
  sheetId?: string;
  row?: number;
  col?: number;
};

// Stable color per clientId (simple string hash into a fixed palette) so a given
// remote user's cursor keeps the same color across roster updates.
const CURSOR_COLORS = ['#8b5cf6', '#f97316', '#06b6d4', '#ec4899', '#22c55e', '#eab308', '#ef4444', '#3b82f6'];
function colorForClient(clientId: string): string {
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) hash = (hash * 31 + clientId.charCodeAt(i)) | 0;
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

// Label popup shown above a remote user's selected cell — componentKey can be a
// React component directly (no registerComponent needed), props come from `extraProps`.
function RemoteCursorLabel(props: { color: string; label: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        background: props.color,
        color: '#fff',
        fontSize: 11,
        lineHeight: '16px',
        padding: '0 4px',
        borderRadius: 2,
        whiteSpace: 'nowrap',
      }}
    >
      {props.label}
    </span>
  );
}

export default function SpreadsheetEditor({
  role,
  workbookId,
  shareToken,
  clientId,
  onRoster,
  onSaving,
  apiRef,
}: {
  role: 'admin' | 'editor' | 'viewer';
  workbookId?: number;
  shareToken?: string;
  clientId: string;
  onRoster?: (users: RosterUser[]) => void;
  onSaving?: (saving: boolean) => void;
  apiRef?: React.MutableRefObject<EditorApi | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const univerAPIRef = useRef<FUniver | null>(null);
  const applyingRemote = useRef(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let disposeValueEvent: { dispose: () => void } | null = null;
    let disposeSelectionEvent: { dispose: () => void } | null = null;
    let disposeActiveSheetEvent: { dispose: () => void } | null = null;
    let disposeSheetCreatedEvent: { dispose: () => void } | null = null;
    let disposeSheetDeletedEvent: { dispose: () => void } | null = null;
    let disposeSheetRenamedEvent: { dispose: () => void } | null = null;
    let disposeMutationEvent: { dispose: () => void } | null = null;
    let cursorThrottle: ReturnType<typeof setTimeout> | null = null;
    let cursorOverlays: { dispose: () => void }[] = [];
    let lastRoster: RosterUser[] = [];
    const resyncTimers: Record<string, ReturnType<typeof setTimeout>> = {};

    async function init() {
      try {
        const res = await fetch(shareToken ? `/api/workbook?shareToken=${encodeURIComponent(shareToken)}` : `/api/workbook?id=${workbookId}`);
        if (!res.ok) throw new Error(`GET /api/workbook -> ${res.status}`);
        const { workbook: snapshot, sheetLevels } = await res.json();
        if (disposed) return;

        const { univerAPI } = createUniver({
          locale: LocaleType.VI_VN,
          locales: {
            [LocaleType.VI_VN]: mergeLocales(
              UniverPresetSheetsCoreViVN,
              UniverPresetSheetsNoteViVN,
              UniverPresetSheetsDrawingViVN,
              UniverPresetSheetsFilterViVN,
              UniverPresetSheetsSortViVN
            ),
          },
          presets: [
            UniverSheetsCorePreset({ container: containerRef.current! }),
            UniverSheetsNotePreset(),
            UniverSheetsDrawingPreset(),
            UniverSheetsFilterPreset(),
            UniverSheetsSortPreset(),
          ],
        });
        univerAPIRef.current = univerAPI;
        univerAPI.createWorkbook(snapshot);
        // UX only — the server rejects edits on a non-'edit' sheet regardless of this.
        function updateEditableForActiveSheet() {
          const workbook = univerAPIRef.current?.getActiveWorkbook();
          const sheetId = workbook?.getActiveSheet()?.getSheetId();
          workbook?.setEditable(sheetId != null && sheetLevels[sheetId] === 'edit');
        }
        updateEditableForActiveSheet();
        if (apiRef) {
          apiRef.current = {
            undo: () => univerAPI.getActiveWorkbook()?.undo(),
            redo: () => univerAPI.getActiveWorkbook()?.redo(),
          };
        }
        setStatus('ready');

        // --- remote-cursor overlay: colored cell border + IP label + colored
        // row/column header strip, redrawn from scratch on every roster update
        // (cheap enough — one per cursor move, already throttled at 300ms). ---
        function updateCursorOverlays(users: RosterUser[]) {
          lastRoster = users;
          for (const d of cursorOverlays) d.dispose();
          cursorOverlays = [];
          const workbook = univerAPIRef.current?.getActiveWorkbook();
          const activeSheetId = workbook?.getActiveSheet()?.getSheetId();
          if (!workbook || !activeSheetId) return;
          for (const user of users) {
            if (user.clientId === clientId) continue; // don't highlight our own cell
            if (user.sheetId !== activeSheetId || user.row == null || user.col == null) continue;
            const sheet = workbook.getSheetBySheetId(user.sheetId);
            if (!sheet) continue;
            const range = sheet.getRange(user.row, user.col);
            const color = colorForClient(user.clientId);
            try {
              cursorOverlays.push(
                range.highlight({
                  stroke: color,
                  fill: 'transparent',
                  strokeWidth: 2,
                  rowHeaderFill: `${color}33`,
                  rowHeaderStroke: color,
                  columnHeaderFill: `${color}33`,
                  columnHeaderStroke: color,
                })
              );
              const popup = range.attachRangePopup({
                componentKey: RemoteCursorLabel,
                extraProps: { color, label: `${user.username} · ${user.ip}` },
                direction: 'top-center',
                // Label defaults to hidden if Univer judges it "off-canvas" —
                // true near the top/edge of the visible viewport, which is
                // exactly where a remote cursor often sits. Never auto-hide it.
                hideOnInvisible: false,
              });
              if (popup) cursorOverlays.push(popup);
              // ponytail: temp debug — remove once the missing-label cause is confirmed.
              console.log('[cursor-popup]', { row: user.row, col: user.col, sheetId: user.sheetId, gotPopup: !!popup });
            } catch (err) {
              // Engine's render container for this sheet isn't ready yet (e.g.
              // roster arrives right after init/sheet-switch, before the canvas
              // attaches) — skip this one overlay instead of crashing the app;
              // the next roster/selection update redraws it correctly.
              console.error('[cursor-popup] threw', err);
            }
          }
        }

        // Re-run when the local viewer switches sheet tabs — visibility of a
        // remote cursor depends on whether it's on the sheet we're looking at.
        disposeActiveSheetEvent = univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, () => {
          updateCursorOverlays(lastRoster);
          updateEditableForActiveSheet();
        });

        // Anonymous share-link view: static one-time snapshot only, no live
        // collaboration — skip the entire WebSocket setup below.
        // ponytail: no viewer roster/cursors for share viewers either; add if requested.
        if (shareToken) return;

        // --- outgoing: local edits -> WebSocket ---
        disposeValueEvent = univerAPI.addEvent(univerAPI.Event.SheetValueChanged, (params) => {
          if (applyingRemote.current) return; // don't re-broadcast a remote-applied change
          const payload = params.payload as { id: string; params?: { subUnitId?: string; cellValue?: unknown } };
          if (payload.id !== 'sheet.mutation.set-range-values') return; // only plain cell edits are synced
          const cellValue = payload.params?.cellValue;
          const sheetId = payload.params?.subUnitId;
          if (!cellValue || !sheetId || !ws || ws.readyState !== WebSocket.OPEN) return;
          const msg: CellChangeMsg = { type: 'edit', clientId, sheetId, cellValue: cellValue as CellChangeMsg['cellValue'] };
          onSaving?.(true);
          ws.send(JSON.stringify(msg));
        });

        // --- outgoing: cursor moves -> WebSocket (throttled — fires on every arrow key) ---
        disposeSelectionEvent = univerAPI.addEvent(univerAPI.Event.SelectionChanged, (params) => {
          if (cursorThrottle || !ws || ws.readyState !== WebSocket.OPEN) return;
          cursorThrottle = setTimeout(() => (cursorThrottle = null), 300);
          const sel = params.selections?.[0];
          if (!sel) return;
          ws.send(
            JSON.stringify({
              type: 'cursor',
              clientId,
              sheetId: params.worksheet.getSheetId(),
              row: sel.startRow,
              col: sel.startColumn,
            })
          );
        });

        // --- outgoing: sheet tab create/delete/rename -> WebSocket ---
        // (applyingRemote also guards these — set while replaying an incoming
        // structural message below, so the replay itself isn't re-broadcast)
        disposeSheetCreatedEvent = univerAPI.addEvent(univerAPI.Event.SheetCreated, ({ worksheet }) => {
          if (applyingRemote.current || !ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              type: 'sheet-created',
              clientId,
              sheetId: worksheet.getSheetId(),
              name: worksheet.getSheetName(),
              index: worksheet.getIndex(),
            })
          );
        });
        disposeSheetDeletedEvent = univerAPI.addEvent(univerAPI.Event.SheetDeleted, ({ sheetId }) => {
          if (applyingRemote.current || !ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: 'sheet-deleted', clientId, sheetId }));
        });
        disposeSheetRenamedEvent = univerAPI.addEvent(univerAPI.Event.SheetNameChanged, ({ worksheet, newName }) => {
          if (applyingRemote.current || !ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: 'sheet-renamed', clientId, sheetId: worksheet.getSheetId(), name: newName }));
        });

        // Persists one sheet's structural state (merges, freeze, row/col sizing
        // & hidden flags, counts) so it survives reload/history-restore — not
        // just live sync between currently-open tabs. Debounced per sheet since
        // e.g. dragging a column wider fires many mutations in a row.
        function persistSheetStructure(sheetId: string, needsCellResync: boolean) {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          const saved = univerAPIRef.current?.getActiveWorkbook()?.save();
          const sheetData = saved?.sheets?.[sheetId];
          if (!sheetData) return;
          // Cell comments (Univer "notes") live in the workbook-level `resources`
          // array, not per-sheet — pull just this sheet's slice out to store
          // alongside its other structural config (see getWorkbookSnapshot in lib/db.js).
          const noteResource = saved?.resources?.find((r) => r.name === 'SHEET_NOTE_PLUGIN');
          const notesBySheet = noteResource ? JSON.parse(noteResource.data || '{}') : {};
          // Inserted images (Univer "drawings") — same workbook-level resources
          // array, keyed one level deeper: { [sheetId]: { data, order } }.
          const drawingResource = saved?.resources?.find((r) => r.name === 'SHEET_DRAWING_PLUGIN');
          const drawingsBySheet = drawingResource ? JSON.parse(drawingResource.data || '{}') : {};
          // AutoFilter (per-column filter state) — same workbook-level resources
          // array, keyed one level deeper: { [sheetId]: IAutoFilter }.
          const filterResource = saved?.resources?.find((r) => r.name === 'SHEET_FILTER_PLUGIN');
          const filtersBySheet = filterResource ? JSON.parse(filterResource.data || '{}') : {};
          const config = {
            mergeData: sheetData.mergeData ?? [],
            freeze: sheetData.freeze,
            rowData: sheetData.rowData ?? {},
            columnData: sheetData.columnData ?? {},
            rowCount: sheetData.rowCount,
            columnCount: sheetData.columnCount,
            notes: notesBySheet[sheetId] ?? {},
            drawings: drawingsBySheet[sheetId] ?? { data: {}, order: [] },
            filter: filtersBySheet[sheetId],
          };
          onSaving?.(true);
          if (needsCellResync) {
            ws.send(JSON.stringify({ type: 'sheet-resync', clientId, sheetId, cellData: sheetData.cellData ?? {}, config }));
          } else {
            ws.send(JSON.stringify({ type: 'sheet-config', clientId, sheetId, config }));
          }
        }

        // --- outgoing: structural edits (merge, freeze, row/col insert/
        // delete/resize/hide/move, ...) -> WebSocket, live relay + debounced
        // persistence. Tag our own replayed mutations with __ourSync so this
        // same listener doesn't re-broadcast them on the receiving client —
        // options survive through executeCommand onto the fired event, so this
        // check is race-free even though executeCommand is async (a shared
        // boolean flag would not be, since replay can span awaits).
        disposeMutationEvent = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
          if (event.type !== CommandType.MUTATION) return;
          if ((event.options as { __ourSync?: boolean } | undefined)?.__ourSync) return;
          if (!STRUCTURAL_MUTATION_IDS.has(event.id)) return;
          const params = event.params as { subUnitId?: string; sheetId?: string } | undefined;
          const sheetId = params?.subUnitId ?? params?.sheetId; // note mutations key off `sheetId`, not `subUnitId`
          if (!sheetId || !ws || ws.readyState !== WebSocket.OPEN) return;

          const msg: MutationMsg = { type: 'mutation', clientId, sheetId, id: event.id, params: event.params };
          ws.send(JSON.stringify(msg));

          clearTimeout(resyncTimers[sheetId]);
          resyncTimers[sheetId] = setTimeout(() => persistSheetStructure(sheetId, RESYNC_MUTATION_IDS.has(event.id)), 500);
        });

        // --- incoming: WebSocket -> apply to this sheet ---
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${proto}//${location.host}/ws?workbookId=${workbookId}&clientId=${clientId}`);
        ws.onmessage = (event) => {
          const msg: IncomingMsg = JSON.parse(event.data);
          if (msg.type === 'ack') {
            onSaving?.(false);
            return;
          }
          if (msg.type === 'roster') {
            onRoster?.(msg.users);
            updateCursorOverlays(msg.users);
            return;
          }
          if (msg.type === 'reload') {
            // Simplest correct resync after a history restore — a fresh Univer
            // instance from the new DB state beats hand-patching the live one.
            location.reload();
            return;
          }
          if (msg.type === 'sheet-created') {
            const workbook = univerAPIRef.current?.getActiveWorkbook();
            if (!workbook || workbook.getSheetBySheetId(msg.sheetId)) return; // already have it
            applyingRemote.current = true;
            try {
              workbook.insertSheet(msg.name, { index: msg.index, sheet: { id: msg.sheetId } });
            } finally {
              applyingRemote.current = false;
            }
            return;
          }
          if (msg.type === 'sheet-deleted') {
            const workbook = univerAPIRef.current?.getActiveWorkbook();
            if (!workbook) return;
            applyingRemote.current = true;
            try {
              workbook.deleteSheet(msg.sheetId);
            } finally {
              applyingRemote.current = false;
            }
            return;
          }
          if (msg.type === 'sheet-renamed') {
            const sheet = univerAPIRef.current?.getActiveWorkbook()?.getSheetBySheetId(msg.sheetId);
            if (!sheet) return;
            applyingRemote.current = true;
            try {
              sheet.setName(msg.name);
            } finally {
              applyingRemote.current = false;
            }
            return;
          }
          if (msg.type === 'mutation') {
            // __ourSync marks the replay so our own CommandExecuted listener
            // (above) skips it instead of re-broadcasting — see its comment.
            univerAPIRef.current?.executeCommand(msg.id, msg.params as object, { fromCollab: true, __ourSync: true }).catch(() => {});
            return;
          }
          if (msg.clientId === clientId) return; // echo of our own edit
          const workbook = univerAPIRef.current?.getActiveWorkbook();
          const sheet = workbook?.getSheetBySheetId(msg.sheetId);
          if (!sheet) return;
          applyingRemote.current = true;
          try {
            // Replay server-authorized data directly, including on read-only
            // and inactive sheets, without local edit commands or undo entries.
            univerAPIRef.current?.syncExecuteCommand('sheet.mutation.set-range-values', {
              unitId: workbook!.getId(),
              subUnitId: msg.sheetId,
              cellValue: msg.cellValue,
            }, { fromCollab: true, __ourSync: true });
          } finally {
            applyingRemote.current = false;
          }
        };
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
        }
      }
    }

    init();

    return () => {
      disposed = true;
      if (apiRef) apiRef.current = null;
      disposeValueEvent?.dispose();
      disposeSelectionEvent?.dispose();
      disposeActiveSheetEvent?.dispose();
      disposeSheetCreatedEvent?.dispose();
      disposeSheetDeletedEvent?.dispose();
      disposeSheetRenamedEvent?.dispose();
      disposeMutationEvent?.dispose();
      for (const d of cursorOverlays) d.dispose();
      for (const id in resyncTimers) clearTimeout(resyncTimers[id]);
      if (cursorThrottle) clearTimeout(cursorThrottle);
      ws?.close();
    };
  }, [workbookId, shareToken]);

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      {status === 'loading' && <div style={{ padding: 8 }}>Đang tải bảng tính...</div>}
      {status === 'error' && (
        <div style={{ padding: 8, background: '#fee', color: '#900' }}>Lỗi tải bảng tính: {error}</div>
      )}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
