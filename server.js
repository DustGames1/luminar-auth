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
  try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT NULL'); } catch(e) {}
  try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT DEFAULT NULL'); } catch(e) {}
  try { await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL'); } catch(e) {}
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_keys (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      days INTEGER NOT NULL,
      created_at BIGINT NOT NULL,
      used_at BIGINT,
      used_by TEXT,
      note TEXT
    );
  `);
  console.log('Database initialized');
}

// ---- App ----
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Serve static admin panel
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const limiter = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false });

// Ensure DB is initialized before any API request (critical for Vercel)
let dbInitialized = false;
async function ensureDB() {
  if (!dbInitialized) {
    await initDB();
    dbInitialized = true;
  }
}
app.use(async (req, res, next) => {
  try { await ensureDB(); } catch (e) { console.error('DB init error', e); }
  next();
});

app.use('/api/', limiter);

// ---- Helpers ----
const validUsername = (u) => typeof u === 'string' && /^[a-zA-Z0-9_]{3,16}$/.test(u);
const validPassword = (p) => typeof p === 'string' && p.length >= 6 && p.length <= 64;
const validHwid = (h) => typeof h === 'string' && h.length >= 8 && h.length <= 128;
const validEmail = (e) => typeof e === 'string' && e.includes('@') && e.split('@')[1].includes('.');

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
    const { username, email, password } = req.body || {};
    if (!validUsername(username)) return res.status(400).json({ error: 'Invalid username (3-16, a-z 0-9 _)' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Invalid email address' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Invalid password (6-64 chars)' });

    const existsUser = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (existsUser.rows.length > 0) return res.status(409).json({ error: 'Username already taken' });

    const existsEmail = await pool.query('SELECT 1 FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existsEmail.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    // HWID is NOT saved on registration — will be set on first loader launch
    await pool.query('INSERT INTO users (username, email, password_hash, hwid, created_at, sub_until) VALUES ($1, $2, $3, NULL, $4, 0)',
      [username, email.toLowerCase().trim(), hash, Date.now()]);

    const token = jwt.sign({ username, hwid: null }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    return res.json({ ok: true, token, subscription: { active: false, until: null, daysLeft: 0 } });
  } catch (e) {
    console.error('register', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, email, password, hwid, source } = req.body || {};
    const isLoader = source === 'loader';

    let user;
    if (isLoader) {
      // Loader login uses username+password
      if (!validUsername(username) || !validPassword(password))
        return res.status(400).json({ error: 'Bad request' });
      const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      user = result.rows[0];
    } else {
      // Web login: try email first, then fallback to username (for old accounts without email)
      if (!validPassword(password)) return res.status(400).json({ error: 'Bad request' });
      
      const loginField = (email || username || '').trim();
      if (!loginField) return res.status(400).json({ error: 'Bad request' });

      // If it looks like an email (has @), search by email
      if (loginField.includes('@')) {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [loginField.toLowerCase()]);
        user = result.rows[0];
      } else {
        // Otherwise search by username (legacy accounts without email)
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [loginField]);
        user = result.rows[0];
      }
    }

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.banned) return res.status(403).json({ error: 'Account banned' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // HWID lock — only enforced when source is 'loader' (real hardware HWID)
    if (isLoader && validHwid(hwid)) {
      const stored = (user.hwid || '').trim();
      if (!stored) {
        await pool.query('UPDATE users SET hwid = $1 WHERE id = $2', [hwid, user.id]);
      } else if (stored !== hwid) {
        return res.status(403).json({ error: 'HWID mismatch. Contact owner to reset.' });
      }
    }

    await pool.query('UPDATE users SET last_login = $1 WHERE id = $2', [Date.now(), user.id]);

    const sub = getSubscription(user);
    const token = jwt.sign({ username: user.username, hwid: isLoader ? hwid : null }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    return res.json({ ok: true, token, username: user.username, uid: user.id, role: user.role || null, subscription: sub });
  } catch (e) {
    console.error('login', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Loader compatibility: bind HWID by user id (called after login)
app.post('/api/bind-hwid', async (req, res) => {
  try {
    const { hwid, userId } = req.body || {};
    if (!validHwid(hwid) || !userId) return res.status(400).json({ success: false, message: 'Bad request' });

    const result = await pool.query('SELECT id, hwid, banned FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    if (user.banned) return res.status(403).json({ success: false, message: 'Доступ запрещён' });

    const stored = (user.hwid || '').trim();
    if (!stored) {
      await pool.query('UPDATE users SET hwid = $1 WHERE id = $2', [hwid, user.id]);
      return res.json({ success: true, message: 'HWID успешно привязан' });
    }
    if (stored === hwid) {
      return res.json({ success: true, message: 'HWID уже привязан к этому устройству' });
    }
    return res.status(403).json({ success: false, message: 'HWID уже привязан' });
  } catch (e) {
    console.error('bind-hwid', e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/verify', async (req, res) => {
  try {
    const { token, hwid } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Bad request' });

    const payload = jwt.verify(token, JWT_SECRET);

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [payload.username]);
    const user = result.rows[0];
    if (!user || user.banned)
      return res.status(403).json({ error: 'Token invalid' });

    // Only check HWID if token was issued for a loader session AND user has HWID locked
    const stored = (user.hwid || '').trim();
    if (payload.hwid && stored) {
      if (!validHwid(hwid) || stored !== hwid) return res.status(403).json({ error: 'HWID mismatch' });
    }

    const sub = getSubscription(user);
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
  const result = await pool.query('SELECT id, username, email, hwid, created_at, last_login, banned, sub_until, role FROM users ORDER BY id DESC');
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
    let result;
    try {
      result = await pool.query('SELECT id, username, email, role, sub_until, avatar_url, created_at, hwid FROM users WHERE username = $1', [payload.username]);
    } catch (dbErr) {
      // Fallback if email column doesn't exist yet
      result = await pool.query('SELECT id, username, role, sub_until, avatar_url, created_at, hwid FROM users WHERE username = $1', [payload.username]);
    }
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: { ...user, email: user.email || null, subscription: getSubscription(user) } });
  } catch (e) {
    console.error('/api/me error:', e.message);
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
    if (!avatar_url || typeof avatar_url !== 'string' || avatar_url.length > 500000)
      return res.status(400).json({ error: 'Invalid avatar' });
    await pool.query('UPDATE users SET avatar_url = $1 WHERE username = $2', [avatar_url, payload.username]);
    res.json({ ok: true });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Set email for accounts that don't have one
app.post('/api/me/email', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const tkn = auth.substring(7);
    let payload;
    try { payload = jwt.verify(tkn, JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Token expired, please re-login' }); }
    
    const { email } = req.body || {};
    if (!email || !validEmail(email)) return res.status(400).json({ error: 'Invalid email' });

    // Check if email already taken by another user
    try {
      const exists = await pool.query('SELECT username FROM users WHERE email = $1', [email.toLowerCase().trim()]);
      if (exists.rows.length > 0 && exists.rows[0].username !== payload.username) return res.status(409).json({ error: 'Email already in use' });
      await pool.query('UPDATE users SET email = $1 WHERE username = $2', [email.toLowerCase().trim(), payload.username]);
    } catch(dbErr) {
      console.error('/api/me/email DB error:', dbErr.message);
      return res.status(500).json({ error: 'DB error: ' + dbErr.message });
    }
    
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/me/email error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// Public avatar lookup (for loader)
app.get('/api/avatar/:username', async (req, res) => {
  const result = await pool.query('SELECT avatar_url FROM users WHERE username = $1', [req.params.username]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ avatar_url: result.rows[0].avatar_url });
});

// Download loader — only for active subscribers
const LOADER_DOWNLOAD_URL = process.env.LOADER_URL || 'https://github.com/DustGames1/luminar-auth/releases/download/luminar/LuminarLoader.exe';

app.get('/api/download/loader', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'No token' });
    const payload = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [payload.username]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.banned) return res.status(403).json({ error: 'Banned' });
    const sub = getSubscription(user);
    if (!sub.active) return res.status(403).json({ error: 'No active subscription' });

    // Redirect to actual loader file
    res.redirect(LOADER_DOWNLOAD_URL);
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ---- License Keys ----
function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = 'LMR-';
  for (let block = 0; block < 4; block++) {
    for (let i = 0; i < 4; i++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (block < 3) key += '-';
  }
  return key;
}

// Admin: create license keys
app.post('/api/admin/keys', adminOnly, async (req, res) => {
  const { days, count, note } = req.body || {};
  if (!days || days < 1 || days > 9999) return res.status(400).json({ error: 'days must be 1-9999' });
  const keyCount = Math.min(parseInt(count) || 1, 100);
  const keys = [];
  for (let i = 0; i < keyCount; i++) {
    const key = generateKey();
    await pool.query('INSERT INTO license_keys (key, days, created_at, note) VALUES ($1, $2, $3, $4)',
      [key, days, Date.now(), note || null]);
    keys.push(key);
  }
  res.json({ ok: true, keys });
});

// Admin: list keys
app.get('/api/admin/keys', adminOnly, async (req, res) => {
  const result = await pool.query('SELECT * FROM license_keys ORDER BY id DESC LIMIT 200');
  res.json({ keys: result.rows });
});

// Admin: delete key
app.delete('/api/admin/keys/:id', adminOnly, async (req, res) => {
  await pool.query('DELETE FROM license_keys WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// User: activate key
app.post('/api/me/activate', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = auth.substring(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Invalid key' });

    const keyResult = await pool.query('SELECT * FROM license_keys WHERE key = $1', [key.trim().toUpperCase()]);
    const licenseKey = keyResult.rows[0];
    if (!licenseKey) return res.status(404).json({ error: 'Ключ не найден' });
    if (licenseKey.used_at) return res.status(409).json({ error: 'Ключ уже использован' });

    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [payload.username]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Add days to subscription (extend if active, else from now)
    const now = Date.now();
    const base = (user.sub_until && user.sub_until > now) ? Number(user.sub_until) : now;
    const newUntil = base + licenseKey.days * 86400000;

    await pool.query('UPDATE users SET sub_until = $1 WHERE id = $2', [newUntil, user.id]);
    await pool.query('UPDATE license_keys SET used_at = $1, used_by = $2 WHERE id = $3', [now, user.username, licenseKey.id]);

    res.json({ ok: true, days: licenseKey.days, sub_until: newUntil });
  } catch (e) {
    console.error('activate', e);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ---- Site routes ----
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/buy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'buy.html')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ---- Start ----

if (!process.env.VERCEL) {
  initDB().then(() => {
    app.listen(PORT, () => console.log(`Luminar auth listening on :${PORT}`));
  }).catch(err => {
    console.error('Failed to init DB:', err);
    process.exit(1);
  });
}

module.exports = app;
