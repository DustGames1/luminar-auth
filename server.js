/**
 * Luminar Auth Backend v2
 * -----------------------
 * Now with SUBSCRIPTION system.
 *
 * Public:
 * - POST /api/register   { username, password, hwid }
 * - POST /api/login      { username, password, hwid } -> { token, subscription }
 * - POST /api/verify     { token, hwid }              -> { ok, username, subscription }
 * - GET  /api/health
 *
 * Admin (header `x-admin-key`):
 * - POST /api/admin/users              { username, password, hwid?, days? }
 * - GET  /api/admin/users
 * - DELETE /api/admin/users/:id
 * - POST /api/admin/reset-hwid/:id
 * - POST /api/admin/ban/:id
 * - POST /api/admin/unban/:id
 * - POST /api/admin/subscribe/:id      { days }  <- GIVE SUBSCRIPTION
 * - POST /api/admin/unsubscribe/:id             <- REMOVE SUBSCRIPTION
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin-key';
const TOKEN_TTL = '7d';

// ---- DB ----
const db = new Database(path.join(__dirname, 'auth.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    hwid TEXT,
    created_at INTEGER NOT NULL,
    last_login INTEGER,
    banned INTEGER DEFAULT 0,
    sub_until INTEGER DEFAULT 0
  );
`);

// Migration: add sub_until if missing (for existing DBs)
try { db.exec('ALTER TABLE users ADD COLUMN sub_until INTEGER DEFAULT 0'); } catch(e) {}

// ---- App ----
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const limiter = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

// ---- Helpers ----
const validUsername = (u) => typeof u === 'string' && /^[a-zA-Z0-9_]{3,16}$/.test(u);
const validPassword = (p) => typeof p === 'string' && p.length >= 6 && p.length <= 64;
const validHwid = (h) => typeof h === 'string' && h.length >= 8 && h.length <= 128;

function adminOnly(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

function getSubscription(user) {
  if (!user.sub_until || user.sub_until === 0) return { active: false, until: null, daysLeft: 0 };
  const now = Date.now();
  if (user.sub_until <= now) return { active: false, until: user.sub_until, daysLeft: 0 };
  const daysLeft = Math.ceil((user.sub_until - now) / 86400000);
  return { active: true, until: user.sub_until, daysLeft };
}

// ---- Public ----
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/api/register', async (req, res) => {
  try {
    const { username, password, hwid } = req.body || {};
    if (!validUsername(username)) return res.status(400).json({ error: 'Invalid username (3-16, a-z 0-9 _)' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Invalid password (6-64 chars)' });
    if (!validHwid(hwid)) return res.status(400).json({ error: 'Invalid HWID' });

    const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (exists) return res.status(409).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users (username, password_hash, hwid, created_at, sub_until) VALUES (?, ?, ?, ?, 0)')
      .run(username, hash, hwid, Date.now());

    const token = jwt.sign({ username, hwid }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    return res.json({ ok: true, token, subscription: { active: false, until: null, daysLeft: 0 } });
  } catch (e) {
    console.error('register', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password, hwid } = req.body || {};
    if (!validUsername(username) || !validPassword(password) || !validHwid(hwid))
      return res.status(400).json({ error: 'Bad request' });

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.banned) return res.status(403).json({ error: 'Account banned' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // HWID lock
    if (!user.hwid) {
      db.prepare('UPDATE users SET hwid = ? WHERE id = ?').run(hwid, user.id);
    } else if (user.hwid !== hwid) {
      return res.status(403).json({ error: 'HWID mismatch. Contact owner to reset.' });
    }

    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);

    const sub = getSubscription(user);

    // Check subscription — if not active, deny login
    if (!sub.active) {
      return res.status(403).json({ error: 'No active subscription. Contact owner.' });
    }

    const token = jwt.sign({ username: user.username, hwid }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    return res.json({ ok: true, token, username: user.username, subscription: sub });
  } catch (e) {
    console.error('login', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/verify', (req, res) => {
  try {
    const { token, hwid } = req.body || {};
    if (!token || !validHwid(hwid)) return res.status(400).json({ error: 'Bad request' });

    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.hwid !== hwid) return res.status(403).json({ error: 'HWID mismatch' });

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(payload.username);
    if (!user || user.banned || user.hwid !== hwid)
      return res.status(403).json({ error: 'Token invalid' });

    const sub = getSubscription(user);
    if (!sub.active) return res.status(403).json({ error: 'Subscription expired' });

    return res.json({ ok: true, username: user.username, expiresAt: payload.exp * 1000, subscription: sub });
  } catch (e) {
    return res.status(401).json({ error: 'Token expired or invalid' });
  }
});

// ---- Admin ----
app.post('/api/admin/users', adminOnly, async (req, res) => {
  const { username, password, hwid, days } = req.body || {};
  if (!validUsername(username) || !validPassword(password))
    return res.status(400).json({ error: 'Bad request' });
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Already exists' });
  const hash = await bcrypt.hash(password, 12);
  const subUntil = days ? Date.now() + days * 86400000 : 0;
  db.prepare('INSERT INTO users (username, password_hash, hwid, created_at, sub_until) VALUES (?, ?, ?, ?, ?)')
    .run(username, hash, hwid || null, Date.now(), subUntil);
  res.json({ ok: true });
});

app.get('/api/admin/users', adminOnly, (req, res) => {
  const rows = db.prepare('SELECT id, username, hwid, created_at, last_login, banned, sub_until FROM users ORDER BY id DESC').all();
  const users = rows.map(u => ({ ...u, subscription: getSubscription(u) }));
  res.json({ users });
});

app.delete('/api/admin/users/:id', adminOnly, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/reset-hwid/:id', adminOnly, (req, res) => {
  db.prepare('UPDATE users SET hwid = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/ban/:id', adminOnly, (req, res) => {
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/unban/:id', adminOnly, (req, res) => {
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GIVE SUBSCRIPTION: POST /api/admin/subscribe/:id { days: 30 }
app.post('/api/admin/subscribe/:id', adminOnly, (req, res) => {
  const { days } = req.body || {};
  if (!days || days < 1 || days > 3650) return res.status(400).json({ error: 'days must be 1-3650' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // If already has active sub, extend from current end. Otherwise from now.
  const now = Date.now();
  const base = (user.sub_until && user.sub_until > now) ? user.sub_until : now;
  const newUntil = base + days * 86400000;

  db.prepare('UPDATE users SET sub_until = ? WHERE id = ?').run(newUntil, user.id);
  res.json({ ok: true, sub_until: newUntil, days_total: Math.ceil((newUntil - now) / 86400000) });
});

// REMOVE SUBSCRIPTION
app.post('/api/admin/unsubscribe/:id', adminOnly, (req, res) => {
  db.prepare('UPDATE users SET sub_until = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Changelog ----
db.exec(`
  CREATE TABLE IF NOT EXISTS changelog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    date TEXT NOT NULL,
    tag TEXT DEFAULT 'ОБНОВЛЕНО',
    text TEXT NOT NULL
  );
`);

// Public: get changelog
app.get('/api/changelog', (req, res) => {
  const rows = db.prepare('SELECT * FROM changelog ORDER BY id DESC LIMIT 20').all();
  res.json({ entries: rows });
});

// Admin: add changelog entry
app.post('/api/admin/changelog', adminOnly, (req, res) => {
  const { version, date, tag, text } = req.body || {};
  if (!version || !text) return res.status(400).json({ error: 'version and text required' });
  db.prepare('INSERT INTO changelog (version, date, tag, text) VALUES (?, ?, ?, ?)')
    .run(version, date || new Date().toISOString().slice(0, 10), tag || 'ОБНОВЛЕНО', text);
  res.json({ ok: true });
});

// Admin: delete changelog entry
app.delete('/api/admin/changelog/:id', adminOnly, (req, res) => {
  db.prepare('DELETE FROM changelog WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => console.log(`Luminar auth v2 listening on :${PORT}`));
