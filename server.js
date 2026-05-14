/**
 * Luminar Auth Backend
 * --------------------
 * - POST /api/register   { username, password, hwid }
 * - POST /api/login      { username, password, hwid } -> { token }
 * - POST /api/verify     { token, hwid }              -> { ok, username, expiresAt }
 * - GET  /api/health
 *
 * Admin (uses ADMIN_KEY in header `x-admin-key`):
 * - POST /api/admin/users        -> create user manually { username, password, hwid? }
 * - GET  /api/admin/users        -> list users
 * - DELETE /api/admin/users/:id  -> remove user
 * - POST /api/admin/reset-hwid/:id -> clear HWID lock for that user
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
    banned INTEGER DEFAULT 0
  );
`);

// ---- App ----
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ---- Helpers ----
const validUsername = (u) => typeof u === 'string' && /^[a-zA-Z0-9_]{3,16}$/.test(u);
const validPassword = (p) => typeof p === 'string' && p.length >= 6 && p.length <= 64;
const validHwid = (h) => typeof h === 'string' && h.length >= 8 && h.length <= 128;

function adminOnly(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ---- Public routes ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.post('/api/register', async (req, res) => {
  try {
    const { username, password, hwid } = req.body || {};
    if (!validUsername(username)) return res.status(400).json({ error: 'Invalid username' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Invalid password (6-64 chars)' });
    if (!validHwid(hwid)) return res.status(400).json({ error: 'Invalid HWID' });

    const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (exists) return res.status(409).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 12);
    const now = Date.now();
    db.prepare(
      'INSERT INTO users (username, password_hash, hwid, created_at) VALUES (?, ?, ?, ?)'
    ).run(username, hash, hwid, now);

    const token = jwt.sign({ username, hwid }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    return res.json({ ok: true, token });
  } catch (e) {
    console.error('register', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password, hwid } = req.body || {};
    if (!validUsername(username) || !validPassword(password) || !validHwid(hwid)) {
      return res.status(400).json({ error: 'Bad request' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.banned) return res.status(403).json({ error: 'Account banned' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // HWID lock: if not yet bound, bind now. Otherwise must match.
    if (!user.hwid) {
      db.prepare('UPDATE users SET hwid = ? WHERE id = ?').run(hwid, user.id);
    } else if (user.hwid !== hwid) {
      return res.status(403).json({ error: 'HWID mismatch. Contact owner to reset.' });
    }

    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);

    const token = jwt.sign({ username: user.username, hwid }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    return res.json({ ok: true, token, username: user.username });
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
    if (!user || user.banned || user.hwid !== hwid) {
      return res.status(403).json({ error: 'Token invalid' });
    }

    return res.json({
      ok: true,
      username: user.username,
      expiresAt: payload.exp * 1000,
    });
  } catch (e) {
    return res.status(401).json({ error: 'Token expired or invalid' });
  }
});

// ---- Admin routes ----
app.post('/api/admin/users', adminOnly, async (req, res) => {
  const { username, password, hwid } = req.body || {};
  if (!validUsername(username) || !validPassword(password)) {
    return res.status(400).json({ error: 'Bad request' });
  }
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Already exists' });
  const hash = await bcrypt.hash(password, 12);
  db.prepare(
    'INSERT INTO users (username, password_hash, hwid, created_at) VALUES (?, ?, ?, ?)'
  ).run(username, hash, hwid || null, Date.now());
  res.json({ ok: true });
});

app.get('/api/admin/users', adminOnly, (req, res) => {
  const rows = db
    .prepare('SELECT id, username, hwid, created_at, last_login, banned FROM users ORDER BY id DESC')
    .all();
  res.json({ users: rows });
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

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Luminar auth backend listening on :${PORT}`);
});
