"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import LoginForm from "../components/LoginForm";
import WorkbookHeader from "../components/WorkbookHeader";
import type { RosterUser, EditorApi } from "../components/SpreadsheetEditor";

// Univer touches the DOM/window directly — must never run during SSR.
// `loading` shows immediately while the (large) Univer JS bundle itself is
// still downloading — SpreadsheetEditor's own "loading" state can't render
// until after that download finishes, since it's inside the lazy chunk.
const SpreadsheetEditor = dynamic(
  () => import("../components/SpreadsheetEditor"),
  {
    ssr: false,
    loading: () => <div style={{ padding: 8 }}>Đang tải ứng dụng...</div>,
  },
);

type User = { username: string; role: "admin" | "editor" | "viewer" };
type Workbook = { id: number; name: string; level?: "view" | "edit" | null };

export default function Home() {
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [mounted, setMounted] = useState(false);
  const [user, setUser] = useState<User | null | undefined>(undefined); // undefined = still checking
  const [workbooks, setWorkbooks] = useState<Workbook[]>([]);
  const [workbookId, setWorkbookId] = useState<number | null>(null);
  const [roster, setRoster] = useState<RosterUser[]>([]);
  const [saving, setSaving] = useState(false);
  const editorApiRef = useRef<EditorApi | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShareToken(new URLSearchParams(window.location.search).get("share"));
      setClientId(Math.random().toString(36).slice(2));
      setMounted(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!mounted || shareToken) return; // anonymous share view — skip login entirely
    fetch("/api/me")
      .then((res) => res.json())
      .then(setUser);
  }, [mounted, shareToken]);

  useEffect(() => {
    if (!user || shareToken) return;
    fetch("/api/workbooks")
      .then((res) => res.json())
      .then((list: Workbook[]) => {
        setWorkbooks(list);
        setWorkbookId((current) => current ?? list[0]?.id ?? null);
      });
  }, [user, shareToken]);

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    setUser(null);
  }

  function handleCreated(id: number) {
    fetch("/api/workbooks")
      .then((res) => res.json())
      .then((list: Workbook[]) => {
        setWorkbooks(list);
        setWorkbookId(id);
      });
  }

  function handleRenamed() {
    fetch("/api/workbooks")
      .then((res) => res.json())
      .then(setWorkbooks);
  }

  function handleDeleted(id: number) {
    fetch("/api/workbooks")
      .then((res) => res.json())
      .then((list: Workbook[]) => {
        setWorkbooks(list);
        setWorkbookId((current) =>
          current === id ? (list[0]?.id ?? null) : current,
        );
      });
  }

  if (shareToken) {
    return (
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
      >
        <div
          style={{
            padding: "8px 16px",
            background: "#fff8e1",
            color: "#8a6d00",
            fontSize: 13,
            borderBottom: "1px solid #eee",
          }}
        >
          Xem công khai (chỉ đọc) — không cần đăng nhập
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <SpreadsheetEditor
            shareToken={shareToken}
            role="viewer"
            clientId={clientId}
          />
        </div>
      </div>
    );
  }

  if (user === undefined) return null; // brief /api/me check, no need for a loading flash
  if (user === null) return <LoginForm onLogin={setUser} />;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {workbookId != null && (
        <WorkbookHeader
          workbooks={workbooks}
          workbookId={workbookId}
          role={user.role}
          saving={saving}
          roster={roster}
          clientId={clientId}
          user={user}
          onOpen={setWorkbookId}
          onCreated={handleCreated}
          onRenamed={handleRenamed}
          onDeleted={handleDeleted}
          onLogout={handleLogout}
          onUndo={() => editorApiRef.current?.undo()}
          onRedo={() => editorApiRef.current?.redo()}
        />
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        {/* key={workbookId} forces a full unmount/remount on switch — reuses
            SpreadsheetEditor's existing init/cleanup effect instead of needing
            manual Univer-instance teardown logic. */}
        {workbookId != null && (
          <SpreadsheetEditor
            key={workbookId}
            workbookId={workbookId}
            role={user.role}
            clientId={clientId}
            onRoster={setRoster}
            onSaving={setSaving}
            apiRef={editorApiRef}
          />
        )}
      </div>
    </div>
  );
}
