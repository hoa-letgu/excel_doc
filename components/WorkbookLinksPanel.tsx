'use client';

import { useEffect, useState } from 'react';

type Workbook = { id: number; name: string };
type AdminSheetInfo = { id: string; name: string; workbookId: number; workbookName: string };
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

function colToIndex(label: string) {
  const text = label.trim().toUpperCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) - 1;
  if (!/^[A-Z]+$/.test(text)) return null;
  let index = 0;
  for (const char of text) index = index * 26 + char.charCodeAt(0) - 64;
  return index - 1;
}

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

// Splits "B, C D" -> ["B","C","D"] — lets one submit create several column
// links at once (same key column, several data columns), the common case
// when two sheets share more than one related field.
function parseColList(text: string): number[] | null {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const indices = parts.map(colToIndex);
  if (indices.some((i) => i == null || i < 0)) return null;
  return indices as number[];
}

export default function WorkbookLinksPanel({ onClose }: { onClose: () => void }) {
  const [allWorkbooks, setAllWorkbooks] = useState<Workbook[]>([]);
  const [allSheets, setAllSheets] = useState<AdminSheetInfo[]>([]);
  const [links, setLinks] = useState<WorkbookLink[]>([]);
  const [leftWorkbookId, setLeftWorkbookId] = useState<number>(0);
  const [leftSheetId, setLeftSheetId] = useState('');
  const [leftKeyCol, setLeftKeyCol] = useState('A');
  const [leftValueCols, setLeftValueCols] = useState('B');
  const [rightWorkbookId, setRightWorkbookId] = useState<number>(0);
  const [rightSheetId, setRightSheetId] = useState('');
  const [rightKeyCol, setRightKeyCol] = useState('A');
  const [rightValueCols, setRightValueCols] = useState('B');
  const [bidirectional, setBidirectional] = useState(true);
  const [busy, setBusy] = useState(false);

  const leftSheets = allSheets.filter((s) => s.workbookId === leftWorkbookId);
  const rightSheets = allSheets.filter((s) => s.workbookId === rightWorkbookId);

  function load() {
    fetch('/api/admin/workbook-links')
      .then((res) => res.json())
      .then((data) => {
        setAllWorkbooks(data.allWorkbooks);
        setAllSheets(data.allSheets);
        setLinks(data.links);
        setLeftWorkbookId((current) => current || data.allWorkbooks[0]?.id || 0);
        setRightWorkbookId((current) => current || data.allWorkbooks[1]?.id || data.allWorkbooks[0]?.id || 0);
      });
  }

  useEffect(load, []);

  useEffect(() => {
    if (!leftSheetId) setLeftSheetId(allSheets.find((s) => s.workbookId === leftWorkbookId)?.id ?? '');
  }, [leftWorkbookId, allSheets, leftSheetId]);
  useEffect(() => {
    if (!rightSheetId) setRightSheetId(allSheets.find((s) => s.workbookId === rightWorkbookId)?.id ?? '');
  }, [rightWorkbookId, allSheets, rightSheetId]);

  async function addLinks() {
    const keyCols = { left: colToIndex(leftKeyCol), right: colToIndex(rightKeyCol) };
    const leftCols = parseColList(leftValueCols);
    const rightCols = parseColList(rightValueCols);
    if (
      !leftWorkbookId || !leftSheetId || !rightWorkbookId || !rightSheetId ||
      keyCols.left == null || keyCols.left < 0 || keyCols.right == null || keyCols.right < 0 ||
      !leftCols || !rightCols || leftCols.length !== rightCols.length
    ) {
      alert('Vui lòng chọn workbook/sheet, nhập cột khóa hợp lệ, và số cột dữ liệu hai bên phải bằng nhau (vd B,C,D ↔ B,C,D).');
      return;
    }
    setBusy(true);
    try {
      // One link row per data-column pair, all sharing the same key column —
      // e.g. "B,C,D" left <-> "B,C,D" right creates 3 links in one click.
      for (let i = 0; i < leftCols.length; i++) {
        const res = await fetch('/api/admin/workbook-links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            leftWorkbookId,
            leftSheetId,
            leftKeyCol: keyCols.left,
            leftValueCol: leftCols[i],
            rightWorkbookId,
            rightSheetId,
            rightKeyCol: keyCols.right,
            rightValueCol: rightCols[i],
            bidirectional,
          }),
        });
        if (!res.ok) {
          alert(`Tạo liên kết thất bại (${res.status}) ở cột ${indexToCol(leftCols[i])}.`);
          break;
        }
      }
      load();
    } finally {
      setBusy(false);
    }
  }

  async function removeLink(id: number) {
    await fetch(`/api/admin/workbook-links/${id}`, { method: 'DELETE' });
    load();
  }

  // Group by workbook pair so links stay scannable once several workbooks
  // (each with several sheets) are all linked to each other.
  const groups = new Map<string, { leftWorkbookName: string; rightWorkbookName: string; links: WorkbookLink[] }>();
  for (const link of links) {
    const key = `${link.leftWorkbookId}-${link.rightWorkbookId}`;
    if (!groups.has(key)) groups.set(key, { leftWorkbookName: link.leftWorkbookName, rightWorkbookName: link.rightWorkbookName, links: [] });
    groups.get(key)!.links.push(link);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', width: 760, maxHeight: '82vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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
          <div style={sectionLabelStyle}>Tạo liên kết mới</div>
          <div style={{ ...cardStyle, alignItems: 'stretch' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, flex: '1 1 100%' }}>
              <select value={leftWorkbookId} onChange={(e) => { setLeftWorkbookId(Number(e.target.value)); setLeftSheetId(''); }} style={fieldStyle}>
                {allWorkbooks.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
              <select value={rightWorkbookId} onChange={(e) => { setRightWorkbookId(Number(e.target.value)); setRightSheetId(''); }} style={fieldStyle}>
                {allWorkbooks.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
              <select value={leftSheetId} onChange={(e) => setLeftSheetId(e.target.value)} style={fieldStyle}>
                <option value="">Sheet trái...</option>
                {leftSheets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select value={rightSheetId} onChange={(e) => setRightSheetId(e.target.value)} style={fieldStyle}>
                <option value="">Sheet phải...</option>
                {rightSheets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 6 }}>
                <input aria-label="Cột khóa trái" placeholder="Khóa: A" value={leftKeyCol} onChange={(e) => setLeftKeyCol(e.target.value)} style={{ ...fieldStyle, width: '40%' }} />
                <input aria-label="Cột dữ liệu trái" placeholder="Dữ liệu: B, C, D" value={leftValueCols} onChange={(e) => setLeftValueCols(e.target.value)} style={{ ...fieldStyle, width: '60%' }} />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input aria-label="Cột khóa phải" placeholder="Khóa: A" value={rightKeyCol} onChange={(e) => setRightKeyCol(e.target.value)} style={{ ...fieldStyle, width: '40%' }} />
                <input aria-label="Cột dữ liệu phải" placeholder="Dữ liệu: B, C, D" value={rightValueCols} onChange={(e) => setRightValueCols(e.target.value)} style={{ ...fieldStyle, width: '60%' }} />
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#999' }}>
              Nhiều cột dữ liệu cách nhau bởi dấu phẩy (vd B,C,D) — mỗi cặp cột tạo 1 liên kết riêng, dùng chung cột khóa.
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={bidirectional} onChange={(e) => setBidirectional(e.target.checked)} />
              Đồng bộ 2 chiều
            </label>
            <button onClick={addLinks} disabled={busy} style={{ ...fieldStyle, marginLeft: 'auto', background: '#4a7dfc', color: '#fff', border: 'none', cursor: busy ? 'default' : 'pointer', fontWeight: 500 }}>
              {busy ? 'Đang tạo...' : 'Tạo liên kết'}
            </button>
          </div>

          <div style={sectionLabelStyle}>Đã tạo</div>
          {groups.size === 0 && <div style={{ padding: '10px 4px', color: '#bbb' }}>Chưa có liên kết nào.</div>}
          {[...groups.values()].map((group, gi) => (
            <div key={gi} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: '#666', margin: '0 0 4px 2px' }}>
                <strong>{group.leftWorkbookName}</strong> ⇄ <strong>{group.rightWorkbookName}</strong>
              </div>
              <div style={{ border: '1px solid #eee', borderRadius: 8, overflow: 'hidden' }}>
                {group.links.map((link, i) => (
                  <div key={link.id} style={{ ...rowStyle, borderBottom: i === group.links.length - 1 ? 'none' : rowStyle.borderBottom, padding: '9px 12px' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {link.leftSheetName} [{indexToCol(link.leftKeyCol)} → {indexToCol(link.leftValueCol)}]
                      <span style={{ color: '#999' }}> {link.bidirectional ? '⇄' : '→'} </span>
                      {link.rightSheetName} [{indexToCol(link.rightKeyCol)} → {indexToCol(link.rightValueCol)}]
                    </span>
                    <button onClick={() => removeLink(link.id)} style={{ background: 'none', border: 'none', color: '#c00', cursor: 'pointer', fontSize: 13 }}>
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
