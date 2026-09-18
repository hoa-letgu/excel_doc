'use client';

import { useEffect, useState } from 'react';

type Workbook = { id: number; name: string };
type AdminUser = { id: number; username: string; role: 'admin' | 'editor' | 'viewer' };
type SheetInfo = { id: string; name: string };
type WorkbookPerm = { userId: number; username: string; level: 'view' | 'edit' };
type SheetPerm = { userId: number; username: string; sheetId: string; sheetName: string; level: 'view' | 'edit' | 'none' };

const fieldStyle: React.CSSProperties = { padding: '7px 10px', fontSize: 13, border: '1px solid #ddd', borderRadius: 6, outline: 'none', background: '#fff' };
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 4px', borderBottom: '1px solid #f2f2f2' };
const cardStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 12, border: '1px solid #eee', borderRadius: 8, background: '#fafbfc' };
const sectionLabelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5, margin: '20px 0 8px' };

export default function AdminPanel({ workbooks, onClose }: { workbooks: Workbook[]; onClose: () => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(workbooks[0]?.id ?? null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [sheets, setSheets] = useState<SheetInfo[]>([]);
  const [workbookPerms, setWorkbookPerms] = useState<WorkbookPerm[]>([]);
  const [sheetPerms, setSheetPerms] = useState<SheetPerm[]>([]);
  const [newUserId, setNewUserId] = useState<number | ''>('');
  const [newSheetId, setNewSheetId] = useState('');
  const [newLevel, setNewLevel] = useState<'none' | 'view' | 'edit'>('view');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'editor' | 'viewer'>('editor');
  const [workbookFilter, setWorkbookFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const filteredWorkbooks = workbooks.filter((w) => w.name.toLowerCase().includes(workbookFilter.trim().toLowerCase()));
  const filteredUsers = users.filter((u) => u.username.toLowerCase().includes(userFilter.trim().toLowerCase()));

  function loadPermissions(id: number) {
    fetch(`/api/admin/workbooks/${id}/permissions`)
      .then((res) => res.json())
      .then((data) => {
        setUsers(data.users.filter((u: AdminUser) => u.role !== 'admin')); // admin bypasses everything — nothing to configure for them
        setSheets(data.sheets);
        setWorkbookPerms(data.workbookPermissions);
        setSheetPerms(data.sheetPermissions);
        setShareToken(data.shareToken ?? null);
      });
  }

  useEffect(() => {
    if (selectedId != null) loadPermissions(selectedId);
  }, [selectedId]);

  async function setWorkbookLevel(userId: number, level: string) {
    if (selectedId == null) return;
    await fetch('/api/admin/permissions/workbook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, workbookId: selectedId, level: level || null }),
    });
    loadPermissions(selectedId);
  }

  async function addSheetOverride() {
    if (!newUserId || !newSheetId) return;
    await fetch('/api/admin/permissions/sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: newUserId, sheetId: newSheetId, level: newLevel }),
    });
    if (selectedId != null) loadPermissions(selectedId);
  }

  async function addAccount() {
    const username = newUsername.trim();
    if (!username || !newPassword) return;
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: newPassword, role: newRole }),
    });
    if (!res.ok) {
      alert(res.status === 409 ? 'Tên đăng nhập đã tồn tại.' : `Tạo tài khoản thất bại (${res.status})`);
      return;
    }
    setNewUsername('');
    setNewPassword('');
    if (selectedId != null) loadPermissions(selectedId);
  }

  async function toggleShare(enabled: boolean) {
    if (selectedId == null) return;
    const res = await fetch(`/api/admin/workbooks/${selectedId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const data = await res.json();
    setShareToken(data.shareToken ?? null);
    setCopied(false);
  }

  async function removeSheetOverride(userId: number, sheetId: string) {
    await fetch('/api/admin/permissions/sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sheetId, level: null }),
    });
    if (selectedId != null) loadPermissions(selectedId);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', width: 820, maxHeight: '82vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid #eee' }}>
          <strong style={{ fontSize: 15, color: '#222' }}>Phân quyền workbook</strong>
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', width: 28, height: 28, background: 'none', border: 'none', borderRadius: 6, fontSize: 18, lineHeight: '28px', cursor: 'pointer', color: '#888' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f0f0')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            ×
          </button>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left: workbook list */}
          <div style={{ width: 220, borderRight: '1px solid #eee', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <div style={{ padding: 8, borderBottom: '1px solid #f2f2f2' }}>
              <input
                placeholder="Tìm workbook..."
                value={workbookFilter}
                onChange={(e) => setWorkbookFilter(e.target.value)}
                style={{ ...fieldStyle, width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ overflowY: 'auto', overflowX: 'hidden', padding: '8px 0' }}>
            {filteredWorkbooks.map((w) => (
              <div
                key={w.id}
                onClick={() => setSelectedId(w.id)}
                title={w.name}
                style={{
                  padding: '9px 16px',
                  cursor: 'pointer',
                  fontSize: 13,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  background: w.id === selectedId ? '#eef2ff' : 'transparent',
                  color: w.id === selectedId ? '#3355dd' : '#333',
                  fontWeight: w.id === selectedId ? 500 : 400,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = w.id === selectedId ? '#eef2ff' : '#f5f5f5')}
                onMouseLeave={(e) => (e.currentTarget.style.background = w.id === selectedId ? '#eef2ff' : 'transparent')}
              >
                {w.name}
              </div>
            ))}
            {filteredWorkbooks.length === 0 && <div style={{ padding: '9px 16px', color: '#bbb', fontSize: 13 }}>Không tìm thấy.</div>}
            </div>
          </div>

          {/* Right: permissions for selected workbook */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 20px', fontSize: 13, minWidth: 0 }}>
            <div style={sectionLabelStyle}>Chia sẻ xem công khai</div>
            <div style={cardStyle}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!shareToken} onChange={(e) => toggleShare(e.target.checked)} />
                Cho phép xem không cần đăng nhập (chỉ xem)
              </label>
              {shareToken && (
                <>
                  <input
                    readOnly
                    value={typeof window !== 'undefined' ? `${window.location.origin}/?share=${shareToken}` : ''}
                    style={{ ...fieldStyle, flex: 1, minWidth: 200, color: '#666' }}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(`${window.location.origin}/?share=${shareToken}`);
                      setCopied(true);
                    }}
                    style={{ ...fieldStyle, background: '#4a7dfc', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 500 }}
                  >
                    {copied ? 'Đã chép!' : 'Sao chép'}
                  </button>
                </>
              )}
            </div>

            <div style={sectionLabelStyle}>Thêm tài khoản</div>
            <div style={cardStyle}>
              <input placeholder="Tên đăng nhập" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} style={{ ...fieldStyle, width: 150 }} />
              <input placeholder="Mật khẩu" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={{ ...fieldStyle, width: 130 }} />
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as 'admin' | 'editor' | 'viewer')} style={fieldStyle}>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
              <button onClick={addAccount} style={{ ...fieldStyle, marginLeft: 'auto', background: '#4a7dfc', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 500 }}>
                Tạo
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <div style={sectionLabelStyle}>Quyền theo workbook</div>
              {users.length > 5 && (
                <input
                  placeholder="Tìm user..."
                  value={userFilter}
                  onChange={(e) => setUserFilter(e.target.value)}
                  style={{ ...fieldStyle, padding: '4px 8px', fontSize: 12, width: 140 }}
                />
              )}
            </div>
            <div style={{ border: '1px solid #eee', borderRadius: 8, overflow: 'hidden', maxHeight: 260, overflowY: 'auto' }}>
              {filteredUsers.length === 0 && <div style={{ padding: '10px 12px', color: '#bbb' }}>{users.length === 0 ? 'Chưa có tài khoản nào.' : 'Không tìm thấy.'}</div>}
              {filteredUsers.map((u, i) => {
                const perm = workbookPerms.find((p) => p.userId === u.id);
                return (
                  <div key={u.id} style={{ ...rowStyle, borderBottom: i === filteredUsers.length - 1 ? 'none' : rowStyle.borderBottom, padding: '9px 12px' }}>
                    <span style={{ flex: 1 }}>{u.username}</span>
                    <select value={perm?.level ?? ''} onChange={(e) => setWorkbookLevel(u.id, e.target.value)} style={{ ...fieldStyle, width: 140 }}>
                      <option value="">Không truy cập</option>
                      <option value="view">Xem</option>
                      <option value="edit">Sửa</option>
                    </select>
                  </div>
                );
              })}
            </div>

            <div style={sectionLabelStyle}>Ngoại lệ theo sheet</div>
            <div style={cardStyle}>
              <select value={newUserId} onChange={(e) => setNewUserId(Number(e.target.value) || '')} style={{ ...fieldStyle, width: 140 }}>
                <option value="">Chọn user...</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.username}</option>
                ))}
              </select>
              <select value={newSheetId} onChange={(e) => setNewSheetId(e.target.value)} style={{ ...fieldStyle, width: 160 }}>
                <option value="">Chọn sheet...</option>
                {sheets.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <select value={newLevel} onChange={(e) => setNewLevel(e.target.value as 'none' | 'view' | 'edit')} style={fieldStyle}>
                <option value="none">Ẩn</option>
                <option value="view">Chỉ xem</option>
                <option value="edit">Sửa</option>
              </select>
              <button onClick={addSheetOverride} style={{ ...fieldStyle, marginLeft: 'auto', background: '#4a7dfc', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 500 }}>
                Thêm
              </button>
            </div>

            <div style={{ border: '1px solid #eee', borderRadius: 8, overflow: 'hidden', marginTop: 12 }}>
              {sheetPerms.length === 0 && <div style={{ padding: '10px 12px', color: '#bbb' }}>Chưa có ngoại lệ nào.</div>}
              {sheetPerms.map((p, i) => (
                <div key={`${p.userId}-${p.sheetId}`} style={{ ...rowStyle, borderBottom: i === sheetPerms.length - 1 ? 'none' : rowStyle.borderBottom, padding: '9px 12px' }}>
                  <span style={{ flex: 1 }}>
                    <strong>{p.username}</strong> <span style={{ color: '#999' }}>— {p.sheetName}:</span>{' '}
                    {p.level === 'none' ? 'Ẩn' : p.level === 'view' ? 'Chỉ xem' : 'Sửa'}
                  </span>
                  <button onClick={() => removeSheetOverride(p.userId, p.sheetId)} style={{ background: 'none', border: 'none', color: '#c00', cursor: 'pointer', fontSize: 13 }}>
                    Xóa
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
