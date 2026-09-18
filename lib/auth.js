// Username/password auth + cookie sessions, backed by the same SQLite DB as
// the workbook (see lib/db.js). No expiry on sessions — ponytail: sessions
// never expire; add `expires_at` + a cleanup pass if long-lived tokens become
// a concern.
const { scryptSync, randomBytes, timingSafeEqual } = require('node:crypto');
const { db } = require('./db');

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

const upsertUserStmt = db.prepare(`
  INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role
`);
function createUser(username, passwordHash, role) {
  upsertUserStmt.run(username, passwordHash, role);
}

function findUserByUsername(username) {
  return db.prepare(`SELECT id, username, password_hash, role FROM users WHERE username = ?`).get(username);
}

const insertSessionStmt = db.prepare(`INSERT INTO sessions (token, user_id) VALUES (?, ?)`);
function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  insertSessionStmt.run(token, userId);
  return token;
}

function getSessionUser(token) {
  return db
    .prepare(
      `SELECT users.id, users.username, users.role FROM sessions
       JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?`
    )
    .get(token);
}

function deleteSession(token) {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// No `Secure` flag: server runs plain http:// on the LAN, not https://.
function sessionCookie(token) {
  return `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`;
}
function clearCookie() {
  return 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

module.exports = {
  hashPassword,
  verifyPassword,
  createUser,
  findUserByUsername,
  createSession,
  getSessionUser,
  deleteSession,
  parseCookies,
  sessionCookie,
  clearCookie,
};
