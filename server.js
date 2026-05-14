/**
 * Luminar Auth Backend v3 — PostgreSQL
 * ------------------------------------
 * Uses PostgreSQL instead of SQLite for persistent storage on Render.
 *
 * Environment variables:
 * - DATABASE_URL: PostgreSQL connection string (from Render)
 * - JWT_SECRET: Secret for JWT tokens
 * - ADMIN_KEY: Admin API key
 * - PORT: Server port (default 3000)
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin-key';
const TOKEN_TTL = '7d';

// ---- DB ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      hwid TEXT,
      created_at BIGINT NOT NULL,
      last_login BIGINT,
      banned INTEGER DEFAULT 0,
      sub_until BIGINT DEFAULT 0,
      role TEXT DEFAULT NULL,
      avatar_url TEXT DEFAULT NULL
    );
  `);
  // Migration for existing tables
  try { await pool.query('ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT NULL'); } catch(e) {}
  await pool.query(`
    CREATE TABLE IF NOT EXISTS changelog (
      id SERIAL PRIMARY KEY,
      version TEXT NOT NULL,
      date TEXT NOT NULL,
      tag TEXT DEFAULT 'ОБНОВЛЕНО',
      text TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  console.log('Database initialized');
}

// ---- App ----
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '64kb' }));

// Serve static admin panel
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

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

    const exists = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (exists.rows.length > 0) return res.status(409).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 12);
    await pool.query('INSERT INTO users (username, password_hash, hwid, created_at, sub_until) VALUES ($1, $2, $3, $4, 0)',
      [username, hash, hwid, Date.now()]);

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

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.banned) return res.status(403).json({ error: 'Account banned' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // HWID lock
    if (!user.hwid) {
      await pool.query('UPDATE users SET hwid = $1 WHERE id = $2', [hwid, user.id]);
    } else if (user.hwid !== hwid) {
      return res.status(403).json({ error: 'HWID mismatch. Contact owner to reset.' });
    }

    await pool.query('UPDATE users SET last_login = $1 WHERE id = $2', [Date.now(), user.id]);

    const sub = getSubscription(user);
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

app.post('/api/verify', async (req, res) => {
  try {
    const { token, hwid } = req.body || {};
    if (!token || !validHwid(hwid)) return res.status(400).json({ error: 'Bad request' });

    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.hwid !== hwid) return res.status(403).json({ error: 'HWID mismatch' });

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [payload.username]);
    const user = result.rows[0];
    if (!user || user.banned || user.hwid !== hwid)
      return res.status(403).json({ error: 'Token invalid' });

    const sub = getSubscription(user);
    if (!sub.active) return res.status(403).json({ error: 'Subscription expired' });

    return res.json({ ok: true, username: user.username, uid: user.id, role: user.role || null, subscription: sub });
  } catch (e) {
    return res.status(401).json({ error: 'Token expired or invalid' });
  }
});

// ---- Admin ----
app.post('/api/admin/users', adminOnly, async (req, res) => {
  const { username, password, hwid, days } = req.body || {};
  if (!validUsername(username) || !validPassword(password))
    return res.status(400).json({ error: 'Bad request' });
  const exists = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
  if (exists.rows.length > 0) return res.status(409).json({ error: 'Already exists' });
  const hash = await bcrypt.hash(password, 12);
  const subUntil = days ? Date.now() + days * 86400000 : 0;
  await pool.query('INSERT INTO users (username, password_hash, hwid, created_at, sub_until) VALUES ($1, $2, $3, $4, $5)',
    [username, hash, hwid || null, Date.now(), subUntil]);
  res.json({ ok: true });
});

app.get('/api/admin/users', adminOnly, async (req, res) => {
  const result = await pool.query('SELECT id, username, hwid, created_at, last_login, banned, sub_until, role FROM users ORDER BY id DESC');
  const users = result.rows.map(u => ({ ...u, subscription: getSubscription(u) }));
  res.json({ users });
});

app.delete('/api/admin/users/:id', adminOnly, async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/reset-hwid/:id', adminOnly, async (req, res) => {
  await pool.query('UPDATE users SET hwid = NULL WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/ban/:id', adminOnly, async (req, res) => {
  await pool.query('UPDATE users SET banned = 1 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/unban/:id', adminOnly, async (req, res) => {
  await pool.query('UPDATE users SET banned = 0 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/subscribe/:id', adminOnly, async (req, res) => {
  const { days } = req.body || {};
  if (!days || days < 1 || days > 3650) return res.status(400).json({ error: 'days must be 1-3650' });

  const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const now = Date.now();
  const base = (user.sub_until && user.sub_until > now) ? Number(user.sub_until) : now;
  const newUntil = base + days * 86400000;

  await pool.query('UPDATE users SET sub_until = $1 WHERE id = $2', [newUntil, user.id]);
  res.json({ ok: true, sub_until: newUntil, days_total: Math.ceil((newUntil - now) / 86400000) });
});

app.post('/api/admin/unsubscribe/:id', adminOnly, async (req, res) => {
  await pool.query('UPDATE users SET sub_until = 0 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/role/:id', adminOnly, async (req, res) => {
  const { role } = req.body || {};
  await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role || null, req.params.id]);
  res.json({ ok: true });
});

// ---- Changelog ----
app.get('/api/changelog', async (req, res) => {
  const result = await pool.query('SELECT * FROM changelog ORDER BY id DESC LIMIT 20');
  res.json({ entries: result.rows });
});

app.post('/api/admin/changelog', adminOnly, async (req, res) => {
  const { version, date, tag, text } = req.body || {};
  if (!version || !text) return res.status(400).json({ error: 'version and text required' });
  await pool.query('INSERT INTO changelog (version, date, tag, text) VALUES ($1, $2, $3, $4)',
    [version, date || new Date().toISOString().slice(0, 10), tag || 'ОБНОВЛЕНО', text]);
  res.json({ ok: true });
});

app.delete('/api/admin/changelog/:id', adminOnly, async (req, res) => {
  await pool.query('DELETE FROM changelog WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Version ----
app.get('/api/version', async (req, res) => {
  const result = await pool.query("SELECT value FROM settings WHERE key = 'client_version'");
  if (result.rows.length > 0) {
    res.send(result.rows[0].value);
  } else {
    res.send('1.0.0');
  }
});

app.post('/api/admin/version', adminOnly, async (req, res) => {
  const { version } = req.body || {};
  if (!version) return res.status(400).json({ error: 'version required' });
  await pool.query("INSERT INTO settings (key, value) VALUES ('client_version', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [version]);
  res.json({ ok: true, version });
});

// ---- Profile ----
app.get('/api/me', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = auth.substring(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT id, username, role, sub_until, avatar_url, created_at FROM users WHERE username = $1', [payload.username]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: { ...user, subscription: getSubscription(user) } });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/me/avatar', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = auth.substring(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const { avatar_url } = req.body || {};
    if (!avatar_url || typeof avatar_url !== 'string' || avatar_url.length > 500)
      return res.status(400).json({ error: 'Invalid avatar URL' });
    await pool.query('UPDATE users SET avatar_url = $1 WHERE username = $2', [avatar_url, payload.username]);
    res.json({ ok: true });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Public avatar lookup (for loader)
app.get('/api/avatar/:username', async (req, res) => {
  const result = await pool.query('SELECT avatar_url FROM users WHERE username = $1', [req.params.username]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ avatar_url: result.rows[0].avatar_url });
});

// ---- Site routes ----
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/buy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'buy.html')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ---- Start ----
initDB().then(() => {
  app.listen(PORT, () => console.log(`Luminar auth v3 (PostgreSQL) listening on :${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
