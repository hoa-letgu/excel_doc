// Custom server: Next.js request handling + a WebSocket server on /ws for
// cell-edit sync. App Router API routes can't hold a long-lived WS connection,
// hence this plain http.Server wrapping Next instead of `next dev`/`next start`.
const { createServer } = require('http');
const { randomBytes } = require('node:crypto');
const next = require('next');
const { WebSocketServer } = require('ws');
const {
  upsertCell,
  getWorkbookSnapshot,
  createWorkbook,
  listWorkbooks,
  renameWorkbook,
  deleteWorkbook,
  upsertSheet,
  nextOrderIndex,
  renameSheet,
  deleteSheet,
  getSheets,
  setSheetConfig,
  replaceSheetCells,
  saveSnapshot,
  listSnapshots,
  getSnapshot,
  pruneSnapshots,
  clearSnapshots,
  getDatabaseStats,
  optimizeDatabase,
  restoreSnapshot,
  listUsers,
  setWorkbookPermission,
  setSheetPermission,
  effectiveWorkbookLevel,
  effectiveSheetLevel,
  listAccessibleWorkbooks,
  getPermissionsForWorkbook,
  getAllSheetsForAdmin,
  createWorkbookLink,
  deleteWorkbookLink,
  listWorkbookLinks,
  listAllWorkbookLinks,
  applyWorkbookLinksForEdit,
  syncWorkbookLink,
  setWorkbookShareToken,
  getShareToken,
  getWorkbookByShareToken,
} = require('./lib/db');
const { importWorkbook, exportWorkbook, exportSnapshotData } = require('./lib/xlsx-io');
const {
  findUserByUsername,
  verifyPassword,
  createSession,
  getSessionUser,
  deleteSession,
  parseCookies,
  sessionCookie,
  clearCookie,
  hashPassword,
  createUser,
  setUserPassword,
  deleteUser,
} = require('./lib/auth');

function currentUser(req) {
  const token = parseCookies(req.headers.cookie).session;
  return token ? getSessionUser(token) : undefined;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const dev = process.env.NODE_ENV !== 'production';
const port = process.env.PORT || 9011;

// Create the server first and hand it to Next via `httpServer` so Next attaches
// its own HMR-websocket upgrade listener to it (lazily, on the first request).
const server = createServer();
const app = next({ dev, httpServer: server });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  server.on('request', async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      // Without this, a throw anywhere below (e.g. a malformed upload) just
      // hangs the request forever instead of failing visibly.
      console.error('[request error]', req.method, req.url, err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err?.stack || err));
    }
  });

  async function handleRequest(req, res) {
    // Served here, not as Next API routes: Turbopack can't bundle `node:sqlite`
    // (require() of a built-in "node:" URL) inside an app/api route handler.
    if (req.url === '/api/login' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const user = findUserByUsername(body.username || '');
      if (!user || !verifyPassword(body.password || '', user.password_hash)) {
        res.writeHead(401).end();
        return;
      }
      const token = createSession(user.id);
      res.setHeader('Set-Cookie', sessionCookie(token));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ username: user.username, role: user.role }));
      return;
    }

    if (req.url === '/api/logout' && req.method === 'POST') {
      const token = parseCookies(req.headers.cookie).session;
      if (token) deleteSession(token);
      res.setHeader('Set-Cookie', clearCookie());
      res.end();
      return;
    }

    if (req.url === '/api/me' && req.method === 'GET') {
      const user = currentUser(req);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(user ? { username: user.username, role: user.role } : null));
      return;
    }

    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/workbook' && req.method === 'GET') {
      // Public read-only share link — no login at all, whole workbook, no
      // sheet filtering (admin opted the whole workbook into this).
      const shareToken = url.searchParams.get('shareToken');
      if (shareToken) {
        const workbook = getWorkbookByShareToken(shareToken);
        if (!workbook) return res.writeHead(404).end();
        const snapshot = getWorkbookSnapshot(workbook.id);
        const sheetLevels = Object.fromEntries(snapshot.sheetOrder.map((id) => [id, 'view']));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ workbook: snapshot, level: 'view', sheetLevels }));
        return;
      }

      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      const id = Number(url.searchParams.get('id')) || listWorkbooks()[0]?.id;
      const level = effectiveWorkbookLevel(user, id);
      if (!level) return res.writeHead(403).end();
      const snapshot = getWorkbookSnapshot(id);
      // Hide sheets the user has no view access to — not just gate edits — so
      // hidden data is never sent to the client at all.
      const sheetLevels = {};
      const visibleSheetIds = snapshot.sheetOrder.filter((sheetId) => {
        const sheetLevel = effectiveSheetLevel(user, id, sheetId);
        if (sheetLevel !== 'view' && sheetLevel !== 'edit') return false;
        sheetLevels[sheetId] = sheetLevel;
        return true;
      });
      const sheets = {};
      for (const sheetId of visibleSheetIds) sheets[sheetId] = snapshot.sheets[sheetId];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ workbook: { ...snapshot, sheetOrder: visibleSheetIds, sheets }, level, sheetLevels }));
      return;
    }

    if (url.pathname === '/api/workbooks' && req.method === 'GET') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(listAccessibleWorkbooks(user)));
      return;
    }

    if (url.pathname === '/api/workbooks' && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role === 'viewer') return res.writeHead(403).end();
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return res.writeHead(400).end();
      }
      const name = body.name || 'Untitled';
      const id = createWorkbook(name);
      upsertSheet(`w${id}-sheet0`, id, 'Sheet1', 0);
      if (user.role !== 'admin') setWorkbookPermission(user.id, id, 'edit'); // don't lock the creator out of their own workbook
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id, name }));
      return;
    }

    if (url.pathname === '/api/workbooks/upload' && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role === 'viewer') return res.writeHead(403).end();
      const name = url.searchParams.get('name') || 'Untitled';
      const buffer = await readRawBody(req);
      const id = createWorkbook(name);
      importWorkbook(buffer, id);
      if (user.role !== 'admin') setWorkbookPermission(user.id, id, 'edit');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id, name }));
      return;
    }

    const renameMatch = url.pathname.match(/^\/api\/workbooks\/(\d+)\/rename$/);
    if (renameMatch && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      const workbookId = Number(renameMatch[1]);
      if (effectiveWorkbookLevel(user, workbookId) !== 'edit') return res.writeHead(403).end();
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return res.writeHead(400).end();
      }
      const name = (body.name || '').trim();
      if (!name) return res.writeHead(400).end();
      renameWorkbook(workbookId, name);
      res.end();
      return;
    }

    const deleteMatch = url.pathname.match(/^\/api\/workbooks\/(\d+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end(); // destructive + affects every user's access — admin only
      const workbookId = Number(deleteMatch[1]);
      if (listWorkbooks().length <= 1) return res.writeHead(400).end('Không thể xóa workbook cuối cùng.');
      deleteWorkbook(workbookId);
      for (const client of wss.clients) {
        if (client.workbookId === workbookId) client.close();
      }
      res.end();
      return;
    }

    const downloadMatch = url.pathname.match(/^\/api\/workbooks\/(\d+)\/download$/);
    if (downloadMatch && req.method === 'GET') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      const id = Number(downloadMatch[1]);
      if (!effectiveWorkbookLevel(user, id)) return res.writeHead(403).end();
      const workbook = listWorkbooks().find((w) => w.id === id);
      if (!workbook) return res.writeHead(404).end();
      const buffer = exportWorkbook(id);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(workbook.name)}.xlsx"`);
      res.end(buffer);
      return;
    }

    const historyMatch = url.pathname.match(/^\/api\/workbooks\/(\d+)\/history$/);
    if (historyMatch && req.method === 'GET') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      const workbookId = Number(historyMatch[1]);
      if (!effectiveWorkbookLevel(user, workbookId)) return res.writeHead(403).end();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(listSnapshots(workbookId)));
      return;
    }

    const historyDownloadMatch = url.pathname.match(/^\/api\/workbooks\/(\d+)\/history\/(\d+)\/download$/);
    if (historyDownloadMatch && req.method === 'GET') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      const workbookId = Number(historyDownloadMatch[1]);
      if (!effectiveWorkbookLevel(user, workbookId)) return res.writeHead(403).end();
      const snap = getSnapshot(Number(historyDownloadMatch[2]));
      if (!snap || snap.workbookId !== workbookId) return res.writeHead(404).end();
      const buffer = exportSnapshotData(JSON.parse(snap.data));
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="snapshot-${snap.id}.xlsx"`);
      res.end(buffer);
      return;
    }

    const saveMatch = url.pathname.match(/^\/api\/workbooks\/(\d+)\/save$/);
    if (saveMatch && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      const workbookId = Number(saveMatch[1]);
      if (!effectiveWorkbookLevel(user, workbookId)) return res.writeHead(403).end();
      saveSnapshot(workbookId, JSON.stringify(getWorkbookSnapshot(workbookId)));
      res.end();
      return;
    }

    const historyRestoreMatch = url.pathname.match(/^\/api\/workbooks\/(\d+)\/history\/(\d+)\/restore$/);
    if (historyRestoreMatch && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      const workbookId = Number(historyRestoreMatch[1]);
      if (effectiveWorkbookLevel(user, workbookId) !== 'edit') return res.writeHead(403).end();
      const snap = getSnapshot(Number(historyRestoreMatch[2]));
      if (!snap || snap.workbookId !== workbookId) return res.writeHead(404).end();
      restoreSnapshot(workbookId, JSON.parse(snap.data));
      // Simplest correct way to resync every open tab's Univer instance post-restore.
      for (const client of wss.clients) {
        if (client.workbookId === workbookId) client.send(JSON.stringify({ type: 'reload' }));
      }
      res.end();
      return;
    }

    if (url.pathname === '/api/admin/users' && req.method === 'GET') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(listUsers()));
      return;
    }

    if (url.pathname === '/api/admin/users' && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return res.writeHead(400).end();
      }
      const username = (body.username || '').trim();
      const password = body.password || '';
      const role = body.role;
      if (!username || !password || !['admin', 'editor', 'viewer'].includes(role)) return res.writeHead(400).end();
      if (findUserByUsername(username)) return res.writeHead(409).end();
      createUser(username, hashPassword(password), role);
      res.end();
      return;
    }

    const userPasswordMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/password$/);
    if (userPasswordMatch && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return res.writeHead(400).end();
      }
      const password = body.password || '';
      if (!password) return res.writeHead(400).end();
      setUserPassword(Number(userPasswordMatch[1]), hashPassword(password));
      res.end();
      return;
    }

    const userDeleteMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if (userDeleteMatch && req.method === 'DELETE') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      const targetId = Number(userDeleteMatch[1]);
      if (targetId === user.id) return res.writeHead(400).end(); // can't delete your own logged-in account
      deleteUser(targetId);
      res.end();
      return;
    }

    if (url.pathname === '/api/admin/database' && req.method === 'GET') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(getDatabaseStats()));
      return;
    }

    if (url.pathname === '/api/admin/database/clear-snapshots' && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      clearSnapshots();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(getDatabaseStats()));
      return;
    }

    if (url.pathname === '/api/admin/database/optimize' && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(optimizeDatabase()));
      return;
    }

    const adminPermsMatch = url.pathname.match(/^\/api\/admin\/workbooks\/(\d+)\/permissions$/);
    if (adminPermsMatch && req.method === 'GET') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      const workbookId = Number(adminPermsMatch[1]);
      const sheets = getSheets(workbookId).map((s) => ({ id: s.id, name: s.name }));
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          users: listUsers(),
          sheets,
          allWorkbooks: listWorkbooks(),
          allSheets: getAllSheetsForAdmin(),
          workbookLinks: listWorkbookLinks(workbookId),
          shareToken: getShareToken(workbookId),
          ...getPermissionsForWorkbook(workbookId),
        })
      );
      return;
    }

    // Standalone link-management popup — all links across every workbook,
    // independent of any "selected workbook" (unlike the scoped list inside
    // GET /api/admin/workbooks/:id/permissions above).
    if (url.pathname === '/api/admin/workbook-links' && req.method === 'GET') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          allWorkbooks: listWorkbooks(),
          allSheets: getAllSheetsForAdmin(),
          links: listAllWorkbookLinks(),
        })
      );
      return;
    }

    if (url.pathname === '/api/admin/workbook-links' && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return res.writeHead(400).end();
      }
      const link = {
        leftWorkbookId: Number(body.leftWorkbookId),
        leftSheetId: body.leftSheetId,
        leftKeyCol: Number(body.leftKeyCol),
        leftValueCol: Number(body.leftValueCol),
        rightWorkbookId: Number(body.rightWorkbookId),
        rightSheetId: body.rightSheetId,
        rightKeyCol: Number(body.rightKeyCol),
        rightValueCol: Number(body.rightValueCol),
        bidirectional: !!body.bidirectional,
      };
      if (
        !link.leftWorkbookId ||
        !link.leftSheetId ||
        !Number.isInteger(link.leftKeyCol) ||
        !Number.isInteger(link.leftValueCol) ||
        !link.rightWorkbookId ||
        !link.rightSheetId ||
        !Number.isInteger(link.rightKeyCol) ||
        !Number.isInteger(link.rightValueCol)
      ) {
        return res.writeHead(400).end();
      }
      const id = createWorkbookLink(link);
      broadcastLinkedUpdates(syncWorkbookLink(id), `link:${id}`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id }));
      return;
    }

    const deleteLinkMatch = url.pathname.match(/^\/api\/admin\/workbook-links\/(\d+)$/);
    if (deleteLinkMatch && req.method === 'DELETE') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      deleteWorkbookLink(Number(deleteLinkMatch[1]));
      res.end();
      return;
    }

    const adminShareMatch = url.pathname.match(/^\/api\/admin\/workbooks\/(\d+)\/share$/);
    if (adminShareMatch && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return res.writeHead(400).end();
      }
      const workbookId = Number(adminShareMatch[1]);
      const token = body.enabled ? randomBytes(16).toString('hex') : null;
      setWorkbookShareToken(workbookId, token);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ shareToken: token }));
      return;
    }

    if (url.pathname === '/api/admin/permissions/workbook' && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return res.writeHead(400).end();
      }
      setWorkbookPermission(Number(body.userId), Number(body.workbookId), body.level || null);
      res.end();
      return;
    }

    if (url.pathname === '/api/admin/permissions/sheet' && req.method === 'POST') {
      const user = currentUser(req);
      if (!user) return res.writeHead(401).end();
      if (user.role !== 'admin') return res.writeHead(403).end();
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return res.writeHead(400).end();
      }
      setSheetPermission(Number(body.userId), body.sheetId, body.level || null);
      res.end();
      return;
    }

    handle(req, res);
  }

  // `noServer: true` + manual routing: a `ws` server built with `{ server, path }`
  // attaches its own 'upgrade' listener that ABORTS (400) any non-matching path,
  // which would kill Next's HMR websocket (`/_next/hmr`) if ours got attached
  // first. Filtering ourselves lets non-'/ws' upgrades fall through untouched.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') return;
    const user = currentUser(req);
    const workbookId = Number(url.searchParams.get('workbookId'));
    if (!user || !effectiveWorkbookLevel(user, workbookId)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      ws.workbookId = workbookId;
      ws.clientId = url.searchParams.get('clientId');
      ws.ip = req.socket.remoteAddress;
      ws.cursor = null;
      wss.emit('connection', ws, req);
    });
  });

  function roomOf(ws) {
    return [...wss.clients].filter((c) => c.workbookId === ws.workbookId && c.readyState === c.OPEN);
  }

  function roomOfWorkbook(workbookId) {
    return [...wss.clients].filter((c) => c.workbookId === workbookId && c.readyState === c.OPEN);
  }

  // Recipients in the room who can at least view this sheet — used to filter
  // every sheet-scoped broadcast so hidden data never reaches a client, not
  // just gets blocked from being edited.
  function roomWithSheetAccess(ws, sheetId) {
    return roomOf(ws).filter((c) => {
      const level = effectiveSheetLevel(c.user, c.workbookId, sheetId);
      return level === 'view' || level === 'edit';
    });
  }

  function roomWithSheetAccessByWorkbook(workbookId, sheetId) {
    return roomOfWorkbook(workbookId).filter((c) => {
      const level = effectiveSheetLevel(c.user, workbookId, sheetId);
      return level === 'view' || level === 'edit';
    });
  }

  function broadcastLinkedUpdates(updates, clientId) {
    const grouped = new Map();
    for (const update of updates) {
      const key = `${update.workbookId}:${update.sheetId}`;
      if (!grouped.has(key)) grouped.set(key, { workbookId: update.workbookId, sheetId: update.sheetId, cellValue: {} });
      const group = grouped.get(key);
      (group.cellValue[update.row] ??= {})[update.col] = update.cellData;
    }
    for (const group of grouped.values()) {
      const payload = JSON.stringify({ type: 'edit', clientId, sheetId: group.sheetId, cellValue: group.cellValue });
      for (const client of roomWithSheetAccessByWorkbook(group.workbookId, group.sheetId)) {
        client.send(payload);
      }
    }
  }

  function broadcastRoster(ws) {
    const room = roomOf(ws);
    for (const recipient of room) {
      const users = room.map((c) => {
        const sheetId = c.cursor?.sheetId;
        // Scrub another client's cursor position if the recipient can't even
        // see the sheet it's sitting on.
        const visible = sheetId != null && (() => {
          const level = effectiveSheetLevel(recipient.user, recipient.workbookId, sheetId);
          return level === 'view' || level === 'edit';
        })();
        return {
          clientId: c.clientId,
          username: c.user.username,
          ip: c.ip,
          sheetId: visible ? sheetId : undefined,
          row: visible ? c.cursor?.row : undefined,
          col: visible ? c.cursor?.col : undefined,
        };
      });
      recipient.send(JSON.stringify({ type: 'roster', users }));
    }
  }

  wss.on('connection', (ws) => {
    broadcastRoster(ws);
    ws.on('close', () => broadcastRoster(ws));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return; // ignore malformed messages
      }

      if (msg.type === 'cursor') {
        ws.cursor = { sheetId: msg.sheetId, row: msg.row, col: msg.col };
        broadcastRoster(ws);
        return;
      }

      // Sheet tab structure changes (create/delete/rename) — same room-broadcast
      // pattern as a cell edit, just persisting to `sheets` instead of `cells`.
      if (msg.type === 'sheet-created' || msg.type === 'sheet-deleted' || msg.type === 'sheet-renamed') {
        // sheet-created has no existing sheetId to check yet — gate on the workbook instead.
        if (msg.type === 'sheet-created') {
          if (effectiveWorkbookLevel(ws.user, ws.workbookId) !== 'edit') return;
        } else if (effectiveSheetLevel(ws.user, ws.workbookId, msg.sheetId) !== 'edit') {
          return; // real block — client-side gating is UX only
        }
        let payload = msg;
        if (msg.type === 'sheet-created') {
          const index = nextOrderIndex(ws.workbookId);
          upsertSheet(msg.sheetId, ws.workbookId, msg.name, index);
          payload = { ...msg, index };
        } else if (msg.type === 'sheet-deleted') {
          deleteSheet(msg.sheetId);
        } else {
          renameSheet(msg.sheetId, msg.name);
        }
        const raw = JSON.stringify(payload);
        for (const client of roomOf(ws)) {
          if (client !== ws) client.send(raw);
        }
        return;
      }

      // Generic structural-mutation relay (merge, freeze, row/col insert/
      // delete/resize/hide/move, ...) — raw Univer {id, params} forwarded
      // as-is, replayed on other clients via univerAPI.executeCommand. No
      // persistence here; that comes separately via 'sheet-config'/'sheet-resync'
      // (debounced client-side) so a burst of e.g. column-drag-resize
      // mutations doesn't hit the DB on every pixel.
      if (msg.type === 'mutation') {
        if (effectiveSheetLevel(ws.user, ws.workbookId, msg.sheetId) !== 'edit') return;
        const payload = JSON.stringify(msg);
        for (const client of roomWithSheetAccess(ws, msg.sheetId)) {
          if (client !== ws) client.send(payload);
        }
        return;
      }

      // Persisted structural snapshot for one sheet, sent debounced after any
      // relayed mutation above settles. 'sheet-resync' additionally rewrites
      // `cells` wholesale (used when the mutation shifts cell positions, e.g.
      // insert/remove/move row or column).
      if (msg.type === 'sheet-config' || msg.type === 'sheet-resync') {
        if (effectiveSheetLevel(ws.user, ws.workbookId, msg.sheetId) !== 'edit') return;
        if (msg.type === 'sheet-resync') replaceSheetCells(msg.sheetId, msg.cellData);
        setSheetConfig(msg.sheetId, JSON.stringify(msg.config || {}));
        ws.send(JSON.stringify({ type: 'ack' }));
        return;
      }

      const { sheetId, cellValue } = msg;
      if (!sheetId || !cellValue) return;
      if (effectiveSheetLevel(ws.user, ws.workbookId, sheetId) !== 'edit') return; // real block — client-side gating is UX only

      // Persist every changed cell, then broadcast the message as-is to everyone
      // else in the same workbook (last-write-wins; no conflict resolution
      // beyond insertion order).
      for (const [row, cols] of Object.entries(cellValue)) {
        for (const [col, cellData] of Object.entries(cols)) {
          upsertCell(sheetId, Number(row), Number(col), JSON.stringify(cellData ?? {}), cellData?.f ?? null);
        }
      }

      broadcastLinkedUpdates(applyWorkbookLinksForEdit(sheetId, cellValue), `link:${ws.workbookId}:${ws.clientId}`);

      const payload = JSON.stringify(msg);
      for (const client of roomWithSheetAccess(ws, sheetId)) {
        if (client !== ws) client.send(payload);
      }
      ws.send(JSON.stringify({ type: 'ack' }));
    });
  });

  // Edit history: snapshot every workbook once an hour, keep at most 1 week
  // (pruneSnapshots deletes anything older on each run — no separate cron).
  function snapshotAllWorkbooks() {
    pruneSnapshots();
    for (const wb of listWorkbooks()) {
      saveSnapshot(wb.id, JSON.stringify(getWorkbookSnapshot(wb.id)));
    }
  }
  snapshotAllWorkbooks();
  setInterval(snapshotAllWorkbooks, 60 * 60 * 1000);

  server.listen(port, () => console.log(`> Ready on http://10.30.21.75:${port}`));
});
