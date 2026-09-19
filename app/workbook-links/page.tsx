'use client';

import { useEffect, useState } from 'react';
import LoginForm from '../../components/LoginForm';
import WorkbookLinksPanel from '../../components/WorkbookLinksPanel';

type User = { username: string; role: 'admin' | 'editor' | 'viewer' };

export default function WorkbookLinksPage() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    fetch('/api/me').then((res) => res.json()).then(setUser);
  }, []);

  if (user === undefined) return null;
  if (user === null) return <LoginForm onLogin={setUser} />;
  if (user.role !== 'admin') {
    return (
      <div style={{ padding: 40, fontSize: 14 }}>
        Không có quyền truy cập trang này. <a href="/">Về trang chính</a>
      </div>
    );
  }

  // WorkbookLinksPanel already renders a full-screen overlay with its own
  // close button — reuse it as-is instead of duplicating its JSX into a
  // page layout (it was built as a popup but a full-screen popup and a
  // dedicated page are visually identical here).
  return <WorkbookLinksPanel onClose={() => { window.location.href = '/'; }} />;
}
