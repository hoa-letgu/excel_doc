'use client';

import { useEffect, useRef, useState } from 'react';
import { buildWorkbookLink, type SyncDirection } from '../lib/workbook-link-config';

type Workbook = { id: number; name: string };
type AdminSheetInfo = { id: string; name: string; workbookId: number; workbookName: string; columnCount: number };
type WorkbookLink = {
  id: number;
  leftWorkbookId: number;
  leftWorkbookName: string;
  leftSheetId: string;
  leftSheetName: string;
  leftKeyCol: number;
  leftValueCol: number;
  rightWorkbookId: number;
  rightWorkbookName: string;
  rightSheetId: string;
  rightSheetName: string;
  rightKeyCol: number;
  rightValueCol: number;
  bidirectional: boolean;
};

const fieldStyle: React.CSSProperties = { padding: '7px 10px', fontSize: 13, border: '1px solid #ddd', borderRadius: 6, outline: 'none', background: '#fff' };
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 4px', borderBottom: '1px solid #f2f2f2' };
const cardStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 12, border: '1px solid #eee', borderRadius: 8, background: '#fafbfc' };
const sectionLabelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5, margin: '18px 0 8px' };

function indexToCol(index: number) {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function ColumnPicker({ side, count, keyCol, values, disabled, onKey, onValues }: {
  side: string; count: number; keyCol: number; values: number[]; disabled: boolean;
  onKey: (col: number) => void; onValues: (cols: number[]) => void;
}) {
  const [search, setSearch] = useState('');
  const columns = Array.from({ length: count }, (_, i) => i);
  const visible = columns.filter(col => indexToCol(col).includes(search.trim().toUpperCase())).slice(0, 100);
  return <fieldset disabled={disabled} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, minWidth: 0 }}>
    <legend style={{ padding: '0 4px', fontWeight: 600 }}>Chọn cột — {side}</legend>
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>Cột khóa liên kết (chọn một)
      <select aria-label={`Cột khóa ${side}`} value={keyCol} onChange={e => {
        const col = Number(e.target.value); onKey(col); onValues(values.filter(v => v !== col));
      }} style={fieldStyle}>
        {columns.map(col => <option key={col} value={col}>Cột {indexToCol(col)}</option>)}
      </select>
    </label>
    <div style={{ margin: '12px 0 6px', fontWeight: 500 }}>Cột dữ liệu đồng bộ (chọn nhiều)</div>
    <input aria-label={`Tìm cột ${side}`} placeholder="Tìm cột, ví dụ B, AA..." value={search} onChange={e => setSearch(e.target.value)} style={{ ...fieldStyle, width: '100%', marginBottom: 8 }} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(65px, 1fr))', gap: 8, maxHeight: 140, overflowY: 'auto' }}>
      {visible.map(col => <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 5, color: col === keyCol ? '#888' : '#222' }}>
        <input type="checkbox" aria-label={`Đồng bộ cột ${indexToCol(col)} ${side}`} disabled={col === keyCol} checked={values.includes(col)}
          onChange={e => onValues(e.target.checked ? [...values, col] : values.filter(v => v !== col))} />
        {indexToCol(col)}{col === keyCol ? ' (khóa)' : ''}
      </label>)}
    </div>
    {visible.length === 0 && <div>Không tìm thấy cột.</div>}
    {count > 100 && <div style={{ marginTop: 8, fontSize: 12 }}>Dùng ô tìm kiếm để chọn các cột ở xa.</div>}
    <div style={{ marginTop: 10, fontSize: 12 }}>Thứ tự ghép: {values.map(indexToCol).join(', ') || 'Chưa chọn cột'}</div>
    <button type="button" onClick={() => onValues([])} style={{ ...fieldStyle, marginTop: 6 }}>Bỏ chọn tất cả</button>
  </fieldset>;
}

export default function WorkbookLinksPanel({ onClose }: { onClose: () => void }) {
  const [allWorkbooks, setAllWorkbooks] = useState<Workbook[]>([]);
  const [allSheets, setAllSheets] = useState<AdminSheetInfo[]>([]);
  const [links, setLinks] = useState<WorkbookLink[]>([]);
  const [leftWorkbookId, setLeftWorkbookId] = useState<number>(0);
  const [leftSheetId, setLeftSheetId] = useState('');
  const [leftKeyCol, setLeftKeyCol] = useState(0);
  const [leftValueCols, setLeftValueCols] = useState<number[]>([]);
  const [rightWorkbookId, setRightWorkbookId] = useState<number>(0);
  const [rightSheetId, setRightSheetId] = useState('');
  const [rightKeyCol, setRightKeyCol] = useState(0);
  const [rightValueCols, setRightValueCols] = useState<number[]>([]);
  const [syncDirection, setSyncDirection] = useState<SyncDirection>('both');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const formRef = useRef<HTMLDivElement>(null);

  const leftSheets = allSheets.filter((s) => s.workbookId === leftWorkbookId);
  const rightSheets = allSheets.filter((s) => s.workbookId === rightWorkbookId);

  function load() {
    return fetch('/api/admin/workbook-links')
      .then((res) => {
        if (!res.ok) throw new Error('Không tải được danh sách liên kết.');
        return res.json();
      })
      .then((data) => {
        setAllWorkbooks(data.allWorkbooks);
        setAllSheets(data.allSheets);
        setLinks(data.links);
        setLeftWorkbookId((current) => current || data.allWorkbooks[0]?.id || 0);
        setRightWorkbookId((current) => current || data.allWorkbooks[1]?.id || data.allWorkbooks[0]?.id || 0);
      });
  }

  useEffect(() => { load().catch(error => setNotice(error.message)); }, []);

  function editLink(link: WorkbookLink) {
    setEditingId(link.id);
    setLeftWorkbookId(link.leftWorkbookId);
    setLeftSheetId(link.leftSheetId);
    setLeftKeyCol(link.leftKeyCol);
    setLeftValueCols([link.leftValueCol]);
    setRightWorkbookId(link.rightWorkbookId);
    setRightSheetId(link.rightSheetId);
    setRightKeyCol(link.rightKeyCol);
    setRightValueCols([link.rightValueCol]);
    setSyncDirection(link.bidirectional ? 'both' : 'left-to-right');
    setNotice('');
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function cancelEdit() {
    setEditingId(null);
    setLeftValueCols([]);
    setRightValueCols([]);
    setNotice('');
  }

  useEffect(() => {
    if (!leftSheetId) setLeftSheetId(allSheets.find((s) => s.workbookId === leftWorkbookId)?.id ?? '');
  }, [leftWorkbookId, allSheets, leftSheetId]);
  useEffect(() => {
    if (!rightSheetId) setRightSheetId(allSheets.find((s) => s.workbookId === rightWorkbookId)?.id ?? '');
  }, [rightWorkbookId, allSheets, rightSheetId]);

  async function addLinks() {
    const keyCols = { left: leftKeyCol, right: rightKeyCol };
    const leftCols = leftValueCols;
    const rightCols = rightValueCols;
    if (
      !leftWorkbookId || !leftSheetId || !rightWorkbookId || !rightSheetId ||
      keyCols.left == null || keyCols.left < 0 || keyCols.right == null || keyCols.right < 0 ||
      !leftCols.length || !rightCols.length || leftCols.length !== rightCols.length
    ) {
      alert('Vui lòng chọn workbook/sheet, chọn cột khóa và chọn cùng số cột dữ liệu ở hai bên.');
      return;
    }
    if (leftCols.includes(keyCols.left) || rightCols.includes(keyCols.right)) {
      alert('Cột khóa chỉ dùng để ghép dòng, không được chọn làm cột dữ liệu đồng bộ.');
      return;
    }
    if (leftSheetId === rightSheetId) {
      alert('Vui lòng chọn hai sheet khác nhau để tạo liên kết.');
      return;
    }
    if (editingId !== null && leftCols.length !== 1) {
      setNotice('Mỗi liên kết trong danh sách là một cặp cột. Chọn một cột dữ liệu ở mỗi bên khi sửa.');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      // One link row per data-column pair, all sharing the same key column —
      // e.g. "B,C,D" left <-> "B,C,D" right creates 3 links in one click.
      for (let i = 0; i < leftCols.length; i++) {
        const res = await fetch(editingId === null ? '/api/admin/workbook-links' : `/api/admin/workbook-links/${editingId}`, {
          method: editingId === null ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildWorkbookLink(syncDirection, {
            workbookId: leftWorkbookId, sheetId: leftSheetId,
            keyCol: keyCols.left, valueCol: leftCols[i],
          }, {
            workbookId: rightWorkbookId, sheetId: rightSheetId,
            keyCol: keyCols.right, valueCol: rightCols[i],
          })),
        });
        if (!res.ok) {
          throw new Error(`Không lưu được liên kết (${res.status}) ở cột ${indexToCol(leftCols[i])}.`);
        }
      }
      await load();
      setNotice(editingId === null ? 'Đã tạo liên kết. Danh sách bên dưới đã được cập nhật.' : 'Đã lưu thay đổi và đồng bộ dữ liệu theo cấu hình mới.');
      setEditingId(null);
      setLeftValueCols([]);
      setRightValueCols([]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Không lưu được liên kết.');
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function removeLink(id: number) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/workbook-links/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Không xóa được liên kết.');
      await load();
      if (editingId === id) cancelEdit();
      setNotice('Đã xóa liên kết.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Không xóa được liên kết.');
    } finally { setBusy(false); }
  }

  // Group by workbook pair so links stay scannable once several workbooks
  // (each with several sheets) are all linked to each other.
  const groups = new Map<string, { leftWorkbookName: string; rightWorkbookName: string; links: WorkbookLink[] }>();
  for (const link of links) {
    const key = `${link.leftWorkbookId}-${link.rightWorkbookId}-${link.bidirectional}`;
    if (!groups.has(key)) groups.set(key, { leftWorkbookName: link.leftWorkbookName, rightWorkbookName: link.rightWorkbookName, links: [] });
    groups.get(key)!.links.push(link);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div role="dialog" aria-modal="true" aria-label="Liên kết workbook" style={{ background: '#fff', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', width: 760, maxWidth: 'calc(100vw - 32px)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid #eee' }}>
          <strong style={{ fontSize: 15, color: '#222' }}>Liên kết workbook</strong>
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', width: 28, height: 28, background: 'none', border: 'none', borderRadius: 6, fontSize: 18, lineHeight: '28px', cursor: 'pointer', color: '#888' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f0f0')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            ×
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 20px', fontSize: 13 }}>
          <div ref={formRef} style={sectionLabelStyle}>{editingId === null ? 'Tạo liên kết mới' : 'Sửa liên kết'}</div>
          {editingId !== null && <div style={{ marginBottom: 8 }}>Đang sửa một cặp cột. Chọn một cột dữ liệu ở mỗi bên rồi lưu thay đổi.</div>}
          <div style={{ ...cardStyle, alignItems: 'stretch' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, flex: '1 1 100%' }}>
              <strong>Workbook 1 (bên trái)</strong>
              <strong>Workbook 2 (bên phải)</strong>
              <select aria-label="Workbook 1" value={leftWorkbookId} onChange={(e) => { setLeftWorkbookId(Number(e.target.value)); setLeftSheetId(''); setLeftKeyCol(0); setLeftValueCols([]); }} style={fieldStyle}>
                {allWorkbooks.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
              <select aria-label="Workbook 2" value={rightWorkbookId} onChange={(e) => { setRightWorkbookId(Number(e.target.value)); setRightSheetId(''); setRightKeyCol(0); setRightValueCols([]); }} style={fieldStyle}>
                {allWorkbooks.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
              <select value={leftSheetId} onChange={(e) => { setLeftSheetId(e.target.value); setLeftKeyCol(0); setLeftValueCols([]); }} style={fieldStyle}>
                <option value="">Sheet trái...</option>
                {leftSheets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select value={rightSheetId} onChange={(e) => { setRightSheetId(e.target.value); setRightKeyCol(0); setRightValueCols([]); }} style={fieldStyle}>
                <option value="">Sheet phải...</option>
                {rightSheets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <ColumnPicker key={'left-' + leftSheetId} side="Workbook 1" count={leftSheets.find(s => s.id === leftSheetId)?.columnCount ?? 26} keyCol={leftKeyCol} values={leftValueCols} disabled={busy || !leftSheetId} onKey={setLeftKeyCol} onValues={setLeftValueCols} />
              <ColumnPicker key={'right-' + rightSheetId} side="Workbook 2" count={rightSheets.find(s => s.id === rightSheetId)?.columnCount ?? 26} keyCol={rightKeyCol} values={rightValueCols} disabled={busy || !rightSheetId} onKey={setRightKeyCol} onValues={setRightValueCols} />
            </div>
            <div style={{ flex: '1 1 100%', padding: 10, background: '#eef2ff', borderRadius: 6 }}>
              <strong>Các cặp cột sẽ đồng bộ</strong>
              <div>Khóa: Workbook 1 · {indexToCol(leftKeyCol)} = Workbook 2 · {indexToCol(rightKeyCol)}</div>
              {Array.from({ length: Math.max(leftValueCols.length, rightValueCols.length) }, (_, i) => (
                <div key={i} style={{ marginTop: 4 }}>
                  Workbook 1 · {leftValueCols[i] == null ? '(chưa chọn)' : indexToCol(leftValueCols[i])}
                  {' '}{syncDirection === 'both' ? '↔' : syncDirection === 'left-to-right' ? '→' : '←'}{' '}
                  Workbook 2 · {rightValueCols[i] == null ? '(chưa chọn)' : indexToCol(rightValueCols[i])}
                </div>
              ))}
              <div style={{ marginTop: 6, fontSize: 12 }}>Các cột được ghép theo thứ tự bạn chọn ở mỗi bên. Chọn cùng số cột ở hai bên.</div>
            </div>
            <div style={{ flex: '1 1 100%', fontSize: 12, color: '#666' }}>
              Các dòng được ghép theo giá trị cột khóa, không theo số dòng. Nhập khóa trùng sẽ lấy dữ liệu từ bên đã có theo hướng cho phép. Với liên kết một chiều, xóa khóa hoặc dòng nguồn sẽ xóa nội dung các cột đồng bộ ở đích, nhưng giữ nguyên khóa, dòng và các cột khác ở đích.
            </div>
            <label style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              Hướng đồng bộ
              <select value={syncDirection} onChange={(e) => setSyncDirection(e.target.value as SyncDirection)} disabled={busy} style={fieldStyle}>
                <option value="both">Hai chiều: Workbook 1 ↔ Workbook 2</option>
                <option value="left-to-right">Một chiều: Workbook 1 → Workbook 2</option>
                <option value="right-to-left">Một chiều: Workbook 2 → Workbook 1</option>
              </select>
            </label>
            <div style={{ flex: '1 1 100%', fontSize: 12, color: '#666' }}>
              {syncDirection === 'both'
                ? 'Khi tạo, ghép dòng theo khóa và ưu tiên dữ liệu Workbook 1; nếu ô bên 1 trống thì lấy dữ liệu bên 2. Sau đó, sửa cột dữ liệu ở bên nào cũng đồng bộ sang bên kia.'
                : `Lấy dữ liệu Workbook ${syncDirection === 'left-to-right' ? '1' : '2'} cập nhật Workbook ${syncDirection === 'left-to-right' ? '2' : '1'} theo cột khóa ngay khi tạo và khi có thay đổi. Liên kết này không đồng bộ ngược lại.`}
            </div>
            <button onClick={addLinks} disabled={busy || !leftSheetId || !rightSheetId || !leftValueCols.length || leftValueCols.length !== rightValueCols.length} style={{ ...fieldStyle, marginLeft: 'auto', background: '#4a7dfc', color: '#fff', border: 'none', cursor: busy ? 'default' : 'pointer', fontWeight: 500 }}>
              {busy ? 'Đang lưu...' : editingId === null ? 'Tạo liên kết' : 'Lưu thay đổi'}
            </button>
            {editingId !== null && <button disabled={busy} onClick={cancelEdit} style={fieldStyle}>Hủy sửa</button>}
          </div>
          {notice && <div role="status" style={{ marginTop: 12, padding: 10, background: '#eef2ff', borderRadius: 6 }}>{notice}</div>}

          <div style={sectionLabelStyle}>Đã tạo</div>
          {groups.size === 0 && <div style={{ padding: '10px 4px', color: '#bbb' }}>Chưa có liên kết nào.</div>}
          {[...groups.values()].map((group, gi) => (
            <div key={gi} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: '#666', margin: '0 0 4px 2px' }}>
                <strong>{group.leftWorkbookName}</strong> {group.links[0].bidirectional ? '⇄' : '→'} <strong>{group.rightWorkbookName}</strong>
              </div>
              <div style={{ border: '1px solid #eee', borderRadius: 8, overflow: 'hidden' }}>
                {group.links.map((link, i) => (
                  <div key={link.id} style={{ ...rowStyle, borderBottom: i === group.links.length - 1 ? 'none' : rowStyle.borderBottom, padding: '9px 12px' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {link.leftSheetName} [Khóa: {indexToCol(link.leftKeyCol)}; Dữ liệu: {indexToCol(link.leftValueCol)}]
                      <span style={{ color: '#999' }}> {link.bidirectional ? '⇄' : '→'} </span>
                      {link.rightSheetName} [Khóa: {indexToCol(link.rightKeyCol)}; Dữ liệu: {indexToCol(link.rightValueCol)}]
                    </span>
                    <button disabled={busy} onClick={() => editLink(link)} style={{ ...fieldStyle, color: '#3355dd', cursor: 'pointer' }}>Sửa</button>
                    <button disabled={busy} onClick={() => removeLink(link.id)} style={{ background: 'none', border: 'none', color: '#c00', cursor: 'pointer', fontSize: 13 }}>
                      Xóa
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
