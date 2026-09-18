'use client';

import { useState } from 'react';

type User = { username: string; role: 'admin' | 'editor' | 'viewer' };

export default function LoginForm({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        setError('Sai tên đăng nhập hoặc mật khẩu.');
        return;
      }
      onLogin(await res.json());
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    padding: '9px 12px',
    fontSize: 14,
    border: '1px solid #ddd',
    borderRadius: 6,
    outline: 'none',
  };

  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f6f8' }}>
      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          width: 320,
          padding: 32,
          background: '#fff',
          borderRadius: 10,
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 28, color: '#222', textAlign: 'center' }}>Sample Sheet</h1>
        <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 400, color: '#888', textAlign: 'center' }}>Đăng nhập</h2>
        <input
          placeholder="Tên đăng nhập"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          style={inputStyle}
          onFocus={(e) => (e.currentTarget.style.borderColor = '#4a7dfc')}
          onBlur={(e) => (e.currentTarget.style.borderColor = '#ddd')}
        />
        <input
          type="password"
          placeholder="Mật khẩu"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={inputStyle}
          onFocus={(e) => (e.currentTarget.style.borderColor = '#4a7dfc')}
          onBlur={(e) => (e.currentTarget.style.borderColor = '#ddd')}
        />
        {error && <div style={{ color: '#c00', fontSize: 13 }}>{error}</div>}
        <button
          type="submit"
          disabled={busy}
          style={{
            padding: '10px 12px',
            fontSize: 14,
            fontWeight: 500,
            color: '#fff',
            background: busy ? '#9db4fb' : '#4a7dfc',
            border: 'none',
            borderRadius: 6,
            cursor: busy ? 'default' : 'pointer',
            marginTop: 4,
          }}
        >
          {busy ? 'Đang đăng nhập...' : 'Đăng nhập'}
        </button>
      </form>
    </div>
  );
}
