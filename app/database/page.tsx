'use client';

import { useEffect, useState } from 'react';
import LoginForm from '../../components/LoginForm';

type User = { username: string; role: 'admin' | 'editor' | 'viewer' };
type DatabaseStats = {
  fileSize: number;
  usedBytes: number;
  reclaimableBytes: number;
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  tableRows: Record<string, number>;
  workbookCells: { workbookId: number; name: string; cells: number }[];
  workbookSnapshots: { workbookId: number; name: string; snapshots: number; bytes: number }[];
};

const fieldStyle: React.CSSProperties = { padding: '7px 10px', fontSize: 13, border: '1px solid #ddd', borderRadius: 6, outline: 'none', background: '#fff' };
const cardStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 12, border: '1px solid #eee', borderRadius: 8, background: '#fafbfc' };
const sectionLabelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5, margin: '20px 0 8px' };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export default function DatabasePage() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/me').then((res) => res.json()).then(setUser);
  }, []);

  function loadStats() {
    fetch('/api/admin/database')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setStats(data);
      });
  }

  useEffect(() => {
    if (user?.role === 'admin') loadStats();
  }, [user]);

  async function clearHistorySnapshots() {
    if (!confirm('Xóa toàn bộ lịch sử lưu/snapshot? Dữ liệu workbook hiện tại vẫn giữ nguyên.')) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/database/clear-snapshots', { method: 'POST' });
      if (res.ok) setStats(await res.json());
      else alert(`Xóa snapshot thất bại (${res.status})`);
    } finally {
      setBusy(false);
    }
  }

  async function optimizeDatabase() {
    if (!confirm('Tối ưu database sẽ chạy VACUUM để thu nhỏ file, tạm khoá server vài giây. Tránh chạy lúc nhiều người đang sửa. Tiếp tục?')) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/database/optimize', { method: 'POST' });
      if (res.ok) setStats(await res.json());
      else alert(`Tối ưu database thất bại (${res.status})`);
    } finally {
      setBusy(false);
    }
  }

  if (user === undefined) return null;
  if (user === null) return <LoginForm onLogin={setUser} />;
  if (user.role !== 'admin') {
    return (
      <div style={{ padding: 40, fontSize: 14 }}>
        Không có quyền truy cập trang này. <a href="/">Về trang chính</a>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px', fontSize: 13 }}>
      <a href="/" style={{ color: '#4a7dfc', fontSize: 13, textDecoration: 'none' }}>← Về trang chính</a>
      <h1 style={{ fontSize: 20, margin: '10px 0 4px' }}>Quản lý database</h1>
      <p style={{ color: '#888', margin: '0 0 8px' }}>workbook.db — SQLite không tự trả dung lượng khi xóa dữ liệu, cần Optimize để thu nhỏ file thật.</p>

      <div style={sectionLabelStyle}>Thống kê</div>
      <div style={cardStyle}>
        {stats ? (
          <>
            <span style={{ minWidth: 120 }}>File: <strong>{formatBytes(stats.fileSize)}</strong></span>
            <span style={{ minWidth: 130 }}>Đang dùng: <strong>{formatBytes(stats.usedBytes)}</strong></span>
            <span style={{ minWidth: 160 }}>Có thể thu hồi: <strong>{formatBytes(stats.reclaimableBytes)}</strong></span>
            <button onClick={loadStats} disabled={busy} style={{ ...fieldStyle, marginLeft: 'auto', cursor: busy ? 'default' : 'pointer' }}>
              Làm mới
            </button>
            <button onClick={clearHistorySnapshots} disabled={busy} style={{ ...fieldStyle, background: '#fff7ed', color: '#9a3412', cursor: busy ? 'default' : 'pointer' }}>
              Xóa lịch sử
            </button>
            <button onClick={optimizeDatabase} disabled={busy} style={{ ...fieldStyle, background: '#16a34a', color: '#fff', border: 'none', cursor: busy ? 'default' : 'pointer', fontWeight: 500 }}>
              {busy ? 'Đang xử lý...' : 'Optimize'}
            </button>
          </>
        ) : (
          <span style={{ color: '#999' }}>Đang tải...</span>
        )}
      </div>

      {stats && (
        <div style={{ border: '1px solid #eee', borderRadius: 8, overflow: 'hidden', marginTop: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 120px', gap: 8, padding: '8px 12px', background: '#fafafa', color: '#777', fontSize: 12, fontWeight: 600 }}>
            <span>Workbook</span>
            <span>Cells</span>
            <span>History</span>
          </div>
          {stats.workbookCells.length === 0 && <div style={{ padding: '10px 12px', color: '#bbb' }}>Chưa có workbook nào.</div>}
          {stats.workbookCells.map((row) => {
            const snap = stats.workbookSnapshots.find((item) => item.workbookId === row.workbookId);
            return (
              <div key={row.workbookId} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 120px', gap: 8, padding: '8px 12px', borderTop: '1px solid #f0f0f0' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
                <span>{row.cells.toLocaleString('vi-VN')}</span>
                <span>{snap?.snapshots ?? 0} / {formatBytes(snap?.bytes ?? 0)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
