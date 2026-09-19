'use client';

import { useRef, useState, type ReactNode } from 'react';
import type { RosterUser } from './SpreadsheetEditor';
import AdminPanel from './AdminPanel';

// `level` is absent for admin (whose /api/workbooks list is unfiltered, unleveled) — admin bypasses regardless.
type Workbook = { id: number; name: string; level?: 'view' | 'edit' | null };
type User = { username: string; role: 'admin' | 'editor' | 'viewer' };

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const paths = {
  doc: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>,
  undo: <><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></>,
  redo: <><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" /></>,
  newFile: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="18" x2="12" y2="12" /><line x1="9" y1="15" x2="15" y2="15" /></>,
  open: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>,
  save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><polyline points="3 4 3 9 8 9" /><polyline points="12 7 12 12 16 14" /></>,
  lock: <><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  trash: <><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  database: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
};

type Snapshot = { id: number; createdAt: number };

const snapshotDateFormatter = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function formatSnapshotTime(createdAt: number) {
  return snapshotDateFormatter.format(new Date(createdAt * 1000));
}

function ToolbarButton({ icon, label, onClick, href, disabled }: { icon: ReactNode; label?: string; onClick?: () => void; href?: string; disabled?: boolean }) {
  const content = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 8px',
        borderRadius: 4,
        color: disabled ? '#bbb' : '#444',
        cursor: disabled ? 'default' : 'pointer',
        userSelect: 'none',
      }}
      onMouseEnter={(e) => !disabled && (e.currentTarget.style.background = '#eee')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <Icon>{icon}</Icon>
      {label && <span style={{ fontSize: 13 }}>{label}</span>}
    </span>
  );
  if (href) return <a href={href} style={{ textDecoration: 'none' }}>{content}</a>;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ background: 'none', border: 'none', padding: 0, font: 'inherit' }}
    >
      {content}
    </button>
  );
}

export default function WorkbookHeader({
  workbooks,
  workbookId,
  role,
  saving,
  roster,
  clientId,
  user,
  onOpen,
  onCreated,
  onRenamed,
  onDeleted,
  onLogout,
  onUndo,
  onRedo,
}: {
  workbooks: Workbook[];
  workbookId: number;
  role: 'admin' | 'editor' | 'viewer';
  saving: boolean;
  roster: RosterUser[];
  clientId: string;
  user: User;
  onOpen: (id: number) => void;
  onCreated: (id: number) => void;
  onRenamed: () => void;
  onDeleted: (id: number) => void;
  onLogout: () => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showRoster, setShowRoster] = useState(false);
  const [showOpen, setShowOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [showAdmin, setShowAdmin] = useState(false);
  const current = workbooks.find((w) => w.id === workbookId);
  const canCreate = role !== 'viewer'; // New/Upload — global action, not tied to one workbook
  const canEditThisWorkbook = role === 'admin' || current?.level === 'edit';

  async function saveRename() {
    setEditingName(false);
    const name = nameDraft.trim();
    if (!name || name === current?.name) return;
    const res = await fetch(`/api/workbooks/${workbookId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) onRenamed();
    else alert(`Đổi tên thất bại (${res.status}): ${await res.text()}`);
  }

  async function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next) {
      const res = await fetch(`/api/workbooks/${workbookId}/history`);
      if (res.ok) setSnapshots(await res.json());
    }
  }

  async function handleRestore(snapshotId: number) {
    if (!confirm('Khôi phục về thời điểm này? Dữ liệu hiện tại sẽ bị ghi đè.')) return;
    await fetch(`/api/workbooks/${workbookId}/history/${snapshotId}/restore`, { method: 'POST' });
    // server broadcasts a WS 'reload' to every open tab (including this one),
    // which does location.reload() — no local state to update here.
  }

  async function handleDelete(id: number, name: string) {
    if (!confirm(`Xóa vĩnh viễn workbook "${name}"? Không thể hoàn tác.`)) return;
    const res = await fetch(`/api/workbooks/${id}`, { method: 'DELETE' });
    if (res.ok) onDeleted(id);
    else alert(`Xóa thất bại (${res.status}): ${await res.text()}`);
  }

  async function handleSaveNow() {
    const res = await fetch(`/api/workbooks/${workbookId}/save`, { method: 'POST' });
    if (!res.ok) alert(`Lưu thất bại (${res.status}): ${await res.text()}`);
  }

  async function handleNew() {
    const name = prompt('Tên workbook mới:');
    if (!name) return;
    const res = await fetch('/api/workbooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) onCreated((await res.json()).id);
    else alert(`Tạo workbook thất bại (${res.status}): ${await res.text()}`);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const res = await fetch(`/api/workbooks/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: buffer,
    });
    if (res.ok) onCreated((await res.json()).id);
    else alert(`Upload thất bại (${res.status}): ${await res.text()}`);
  }

  return (
    <div style={{ borderBottom: '1px solid #e2e2e2', fontFamily: 'inherit' }}>
      {/* Title row — dark strip with a Windows-titlebar-style concentric-ring
          texture (pure CSS repeating-radial-gradient, no image asset). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 12px',
          gap: 8,
          color: '#e5e5e5',
          background: '#217346', // Excel green
          backgroundImage:
            'repeating-radial-gradient(circle at 0% 140%, transparent 0, transparent 11px, rgba(255,255,255,0.09) 11px, rgba(255,255,255,0.09) 12px)',
        }}
      >
        <span style={{ color: '#ccc' }}>
          <Icon>{paths.doc}</Icon>
        </span>
        <strong style={{ fontSize: 14 }}>PCC Spreadsheet</strong>
        <span style={{ color: '#999', fontSize: 14 }}>—</span>
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={saveRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveRename();
              if (e.key === 'Escape') setEditingName(false);
            }}
            style={{ fontSize: 14, color: '#333', border: '1px solid #ddd', borderRadius: 3, padding: '1px 4px' }}
          />
        ) : (
          <span
            title={canEditThisWorkbook ? 'Bấm để đổi tên' : undefined}
            onClick={() => {
              if (!canEditThisWorkbook || !current) return;
              setNameDraft(current.name);
              setEditingName(true);
            }}
            style={{ color: '#ccc', fontSize: 14, cursor: canEditThisWorkbook ? 'pointer' : 'default' }}
          >
            {current?.name ?? '...'}
          </span>
        )}

        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
          <span style={{ color: '#bbb' }}>
            {user.username} ({user.role}) ·{' '}
            <button onClick={onLogout} style={{ background: 'none', border: 'none', padding: 0, color: '#bbb', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>
              Đăng xuất
            </button>
          </span>

          <span style={{ color: saving ? '#ffd76b' : '#e5ffe9', fontWeight: 500 }}>{saving ? 'Đang lưu...' : 'Saved'}</span>

          <span style={{ position: 'relative' }}>
            <button
              onClick={() => setShowRoster((v) => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                border: '1px solid #ddd',
                borderRadius: 999,
                padding: '3px 10px',
                background: '#fff',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
              <span style={{ fontWeight: 500 }}>Connected</span>
              <span style={{ color: '#999' }}>· {roster.length} user{roster.length === 1 ? '' : 's'} editing</span>
            </button>
            {showRoster && (
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '100%',
                  marginTop: 4,
                  background: '#fff',
                  border: '1px solid #ddd',
                  borderRadius: 6,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                  padding: 8,
                  minWidth: 240,
                  zIndex: 20,
                  fontSize: 12,
                }}
              >
                {roster.map((u) => (
                  <div key={u.clientId} style={{ padding: '4px 6px' }}>
                    {u.ip} — {u.username}
                    {u.clientId === clientId && <span style={{ color: '#999' }}> (Bạn)</span>}
                    {u.sheetId != null && (
                      <span style={{ color: '#999' }}>
                        {' '}
                        — {u.sheetId}!R{(u.row ?? 0) + 1}C{(u.col ?? 0) + 1}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </span>
        </span>
      </div>

      {/* Toolbar row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '2px 8px 6px', background: '#fff' }}>
        <ToolbarButton icon={paths.undo} onClick={onUndo} />
        <ToolbarButton icon={paths.redo} onClick={onRedo} />
        <span style={{ width: 1, height: 18, background: '#e2e2e2', margin: '0 6px' }} />
        <ToolbarButton icon={paths.newFile} label="New" onClick={handleNew} disabled={!canCreate} />
        <span style={{ position: 'relative' }}>
          <ToolbarButton icon={paths.open} label="Open" onClick={() => setShowOpen((v) => !v)} />
          {showOpen && (
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: '100%',
                marginTop: 4,
                background: '#fff',
                border: '1px solid #ddd',
                borderRadius: 6,
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                minWidth: 180,
                zIndex: 20,
                fontSize: 13,
              }}
            >
              {workbooks.map((w) => (
                <div
                  key={w.id}
                  onClick={() => {
                    onOpen(w.id);
                    setShowOpen(false);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    cursor: 'pointer',
                    background: w.id === workbookId ? '#f0f4ff' : 'transparent',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#f5f5f5')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = w.id === workbookId ? '#f0f4ff' : 'transparent')}
                >
                  <span style={{ flex: 1 }}>{w.name}</span>
                  {role === 'admin' && workbooks.length > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(w.id, w.name);
                      }}
                      title="Xóa workbook"
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#c00' }}
                    >
                      <Icon>{paths.trash}</Icon>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </span>
        <ToolbarButton icon={paths.upload} label="Upload" onClick={() => fileInputRef.current?.click()} disabled={!canCreate} />
        <input ref={fileInputRef} type="file" accept=".xlsx,.xlsm" style={{ display: 'none' }} onChange={handleUpload} />
        {/* Autosave already persists every edit instantly (server.js WS handler) —
            this button instead takes an immediate named point-in-time snapshot,
            independent of the hourly automatic one (both land in the same
            Lịch sử/history list, just triggered differently). */}
        <ToolbarButton icon={paths.save} label="Save" onClick={handleSaveNow} />
        <ToolbarButton icon={paths.download} label="Download" href={`/api/workbooks/${workbookId}/download`} />
        {role === 'admin' && <ToolbarButton icon={paths.lock} label="Phân quyền" onClick={() => setShowAdmin(true)} />}
        {role === 'admin' && <ToolbarButton icon={paths.database} label="Database" href="/database" />}
        {role === 'admin' && <ToolbarButton icon={paths.link} label="Liên kết" href="/workbook-links" />}
        <span style={{ position: 'relative' }}>
          <ToolbarButton icon={paths.history} label="Lịch sử" onClick={toggleHistory} />
          {showHistory && (
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: '100%',
                marginTop: 4,
                background: '#fff',
                border: '1px solid #ddd',
                borderRadius: 6,
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                minWidth: 260,
                maxHeight: 320,
                overflowY: 'auto',
                zIndex: 20,
                fontSize: 13,
              }}
            >
              {snapshots.length === 0 && <div style={{ padding: 10, color: '#999' }}>Chưa có bản lưu nào (lưu mỗi giờ).</div>}
              {snapshots.map((s) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ flex: 1 }}>{formatSnapshotTime(s.createdAt)}</span>
                  <a href={`/api/workbooks/${workbookId}/history/${s.id}/download`} title="Tải xuống" style={{ color: '#555' }}>
                    <Icon>{paths.download}</Icon>
                  </a>
                  {canEditThisWorkbook && (
                    <button
                      onClick={() => handleRestore(s.id)}
                      title="Khôi phục"
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#555' }}
                    >
                      <Icon>{paths.history}</Icon>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </span>
      </div>
      {showAdmin && <AdminPanel workbooks={workbooks} onClose={() => setShowAdmin(false)} />}
    </div>
  );
}
