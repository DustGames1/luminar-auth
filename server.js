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
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin-key';
const TOKEN_TTL = '7d';

// Email configuration
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@luminar.com';
const EMAIL_SERVICE = process.env.EMAIL_SERVICE || 'gmail'; // gmail, mail.ru, yandex, custom

// Create email transporter
let transporter = null;
if (EMAIL_USER && EMAIL_PASS) {
  const transportConfig = {
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS
    }
  };

  // Configure based on service
  if (EMAIL_SERVICE === 'mail.ru') {
    transportConfig.host = 'smtp.mail.ru';
    transportConfig.port = 465;
    transportConfig.secure = true;
  } else if (EMAIL_SERVICE === 'yandex') {
    transportConfig.host = 'smtp.yandex.ru';
    transportConfig.port = 465;
    transportConfig.secure = true;
  } else if (EMAIL_SERVICE === 'gmail') {
    transportConfig.service = 'gmail';
  } else {
    // Custom SMTP
    transportConfig.host = process.env.SMTP_HOST || 'smtp.gmail.com';
    transportConfig.port = parseInt(process.env.SMTP_PORT || '587');
    transportConfig.secure = process.env.SMTP_SECURE === 'true';
  }

  transporter = nodemailer.createTransport(transportConfig);
}

// Helper function to send verification email
async function sendVerificationEmail(email, code) {
  if (!transporter) {
    console.log('Email not configured, verification code:', code);
    return false;
  }
  
  try {
    await transporter.sendMail({
      from: EMAIL_FROM,
      to: email,
      subject: 'Luminar - Подтверждение email',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4c9aff;">Подтверждение email</h2>
          <p>Ваш код подтверждения:</p>
          <div style="background: #f0f0f0; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
            ${code}
          </div>
          <p>Код действителен в течение 10 минут.</p>
          <p style="color: #666; font-size: 12px;">Если вы не регистрировались на Luminar, проигнорируйте это письмо.</p>
        </div>
      `
    });
    return true;
  } catch (e) {
    console.error('Email send error:', e);
    return false;
  }
}

// Robokassa configuration
const ROBOKASSA_LOGIN = process.env.ROBOKASSA_LOGIN || '';
const ROBOKASSA_PASSWORD1 = process.env.ROBOKASSA_PASSWORD1 || '';
const ROBOKASSA_PASSWORD2 = process.env.ROBOKASSA_PASSWORD2 || '';
const ROBOKASSA_TEST_MODE = process.env.ROBOKASSA_TEST_MODE === 'true';

// Robokassa helper functions
function generateRobokassaSignature(login, outSum, invId, password, receipt = '') {
  const signatureString = `${login}:${outSum}:${invId}:${receipt}:${password}`;
  return crypto.createHash('md5').update(signatureString).digest('hex');
}

function verifyRobokassaSignature(outSum, invId, signatureValue, password) {
  const expectedSignature = crypto.createHash('md5').update(`${outSum}:${invId}:${password}`).digest('hex');
  return expectedSignature.toLowerCase() === signatureValue.toLowerCase();
}

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
  try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS prefix TEXT DEFAULT NULL'); } catch(e) {}
  try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER DEFAULT 0'); } catch(e) {}
  try { await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL'); } catch(e) {}
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      used INTEGER DEFAULT 0
    );
  `);
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price INTEGER NOT NULL,
      days INTEGER NOT NULL,
      category TEXT DEFAULT 'Подписка',
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promocodes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      discount INTEGER NOT NULL,
      uses_left INTEGER,
      expires_at BIGINT,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL,
      user_id INTEGER,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      original_amount DECIMAL(10,2) NOT NULL,
      discount INTEGER DEFAULT 0,
      promocode TEXT,
      payment_id TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'pending',
      days INTEGER NOT NULL,
      created_at BIGINT NOT NULL,
      paid_at BIGINT
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

    // Generate 6-digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000; // 10 minutes

    // Save verification code
    await pool.query('INSERT INTO email_verifications (email, code, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [email.toLowerCase().trim(), code, now, expiresAt]);

    // Send verification email
    const emailSent = await sendVerificationEmail(email, code);
    
    if (!emailSent && !transporter) {
      // If email is not configured, return code in response (for development)
      console.log('Verification code for', email, ':', code);
    }

    // Create user but mark as unverified
    const hash = await bcrypt.hash(password, 12);
    await pool.query('INSERT INTO users (username, email, password_hash, hwid, created_at, sub_until, email_verified) VALUES ($1, $2, $3, NULL, $4, 0, 0)',
      [username, email.toLowerCase().trim(), hash, Date.now()]);

    return res.json({ 
      ok: true, 
      message: 'Verification code sent to your email',
      email: email.toLowerCase().trim(),
      // Include code in response if email not configured (development only)
      ...((!transporter) && { code })
    });
  } catch (e) {
    console.error('register', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Verify email endpoint
app.post('/api/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

    // Find verification code
    const result = await pool.query(
      'SELECT * FROM email_verifications WHERE email = $1 AND code = $2 AND used = 0 ORDER BY created_at DESC LIMIT 1',
      [email.toLowerCase().trim(), code]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    const verification = result.rows[0];
    
    // Check if expired
    if (verification.expires_at < Date.now()) {
      return res.status(400).json({ error: 'Code expired' });
    }

    // Mark code as used
    await pool.query('UPDATE email_verifications SET used = 1 WHERE id = $1', [verification.id]);

    // Mark user as verified
    await pool.query('UPDATE users SET email_verified = 1 WHERE email = $1', [email.toLowerCase().trim()]);

    // Get user and create token
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    const user = userResult.rows[0];

    const token = jwt.sign({ username: user.username, hwid: null }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    const sub = getSubscription(user);

    return res.json({ ok: true, token, subscription: sub });
  } catch (e) {
    console.error('verify-email', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Resend verification code
app.post('/api/resend-code', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email required' });

    // Check if user exists
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    if (user.email_verified) {
      return res.status(400).json({ error: 'Email already verified' });
    }

    // Generate new code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;

    // Save new code
    await pool.query('INSERT INTO email_verifications (email, code, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [email.toLowerCase().trim(), code, now, expiresAt]);

    // Send email
    const emailSent = await sendVerificationEmail(email, code);
    
    if (!emailSent && !transporter) {
      console.log('Verification code for', email, ':', code);
    }

    return res.json({ 
      ok: true, 
      message: 'New code sent',
      ...((!transporter) && { code })
    });
  } catch (e) {
    console.error('resend-code', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, email, password, hwid, source } = req.body || {};
    const isLoader = source === 'loader';

    let user;
    if (isLoader) {
      // Loader login uses username+password (case-insensitive username)
      if (!validUsername(username) || !validPassword(password))
        return res.status(400).json({ error: 'Bad request' });
      const result = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
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
        // Otherwise search by username (legacy accounts without email) - case-insensitive
        const result = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [loginField]);
        user = result.rows[0];
      }
    }

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.banned) return res.status(403).json({ error: 'Account banned' });
    
    // Check email verification (only for web login, not loader)
    if (!isLoader && user.email_verified === 0) {
      return res.status(403).json({ error: 'Email not verified', needsVerification: true, email: user.email });
    }

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

    const result = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [payload.username]);
    const user = result.rows[0];
    if (!user || user.banned)
      return res.status(403).json({ error: 'Token invalid' });

    // Only check HWID if token was issued for a loader session AND user has HWID locked
    const stored = (user.hwid || '').trim();
    if (payload.hwid && stored) {
      // If HWID is set in DB, check if it matches
      if (!validHwid(hwid) || stored !== hwid) return res.status(403).json({ error: 'HWID mismatch' });
    }
    // If stored HWID is empty (reset), allow login - it will be set on next login

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
  const result = await pool.query('SELECT id, username, email, hwid, created_at, last_login, banned, sub_until, role, prefix FROM users ORDER BY id DESC');
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

app.post('/api/admin/prefix/:id', adminOnly, async (req, res) => {
  const { prefix } = req.body || {};
  await pool.query('UPDATE users SET prefix = $1 WHERE id = $2', [prefix || null, req.params.id]);
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
      result = await pool.query('SELECT id, username, email, role, prefix, sub_until, avatar_url, created_at, hwid FROM users WHERE username = $1', [payload.username]);
    } catch (dbErr) {
      // Fallback if email/prefix column doesn't exist yet
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
app.get('/verify-email', (req, res) => res.sendFile(path.join(__dirname, 'public', 'verify-email.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/buy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'buy.html')));
app.get('/admin-new', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-new.html')));

// ---- Products API ----
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.json({ products: result.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/products', adminOnly, async (req, res) => {
  const { name, description, price, days, category } = req.body || {};
  if (!name || !price || !days) return res.status(400).json({ error: 'name, price, days required' });
  await pool.query('INSERT INTO products (name, description, price, days, category, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [name, description || '', price, days, category || 'Подписка', Date.now()]);
  res.json({ ok: true });
});

app.get('/api/admin/products', adminOnly, async (req, res) => {
  const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
  res.json({ products: result.rows });
});

app.put('/api/admin/products/:id', adminOnly, async (req, res) => {
  const { name, description, price, days, category } = req.body || {};
  await pool.query('UPDATE products SET name = $1, description = $2, price = $3, days = $4, category = $5 WHERE id = $6',
    [name, description, price, days, category, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', adminOnly, async (req, res) => {
  await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Promocodes API ----
app.post('/api/admin/promocodes', adminOnly, async (req, res) => {
  const { code, discount, uses_left, expires_at } = req.body || {};
  if (!code || !discount) return res.status(400).json({ error: 'code and discount required' });
  const exists = await pool.query('SELECT 1 FROM promocodes WHERE code = $1', [code.toUpperCase()]);
  if (exists.rows.length > 0) return res.status(409).json({ error: 'Promocode already exists' });
  await pool.query('INSERT INTO promocodes (code, discount, uses_left, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)',
    [code.toUpperCase(), discount, uses_left || null, expires_at || null, Date.now()]);
  res.json({ ok: true });
});

app.get('/api/admin/promocodes', adminOnly, async (req, res) => {
  const result = await pool.query('SELECT * FROM promocodes ORDER BY id DESC');
  res.json({ promocodes: result.rows });
});

app.delete('/api/admin/promocodes/:id', adminOnly, async (req, res) => {
  await pool.query('DELETE FROM promocodes WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/promocode/check', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Code required' });
    
    const result = await pool.query('SELECT * FROM promocodes WHERE code = $1', [code.toUpperCase()]);
    const promo = result.rows[0];
    
    if (!promo) return res.status(404).json({ error: 'Промокод не найден' });
    
    // Check if expired
    if (promo.expires_at && promo.expires_at < Date.now()) {
      return res.status(400).json({ error: 'Промокод истёк' });
    }
    
    // Check uses
    if (promo.uses_left !== null && promo.uses_left <= 0) {
      return res.status(400).json({ error: 'Промокод исчерпан' });
    }
    
    res.json({ ok: true, discount: promo.discount });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/promocode/use', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Code required' });
    
    const result = await pool.query('SELECT * FROM promocodes WHERE code = $1', [code.toUpperCase()]);
    const promo = result.rows[0];
    
    if (!promo) return res.status(404).json({ error: 'Промокод не найден' });
    
    if (promo.uses_left !== null && promo.uses_left > 0) {
      await pool.query('UPDATE promocodes SET uses_left = uses_left - 1 WHERE id = $1', [promo.id]);
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Tickets API ----
// Create ticket
app.post('/api/tickets/create', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = auth.substring(7);
    const payload = jwt.verify(token, JWT_SECRET);
    
    const { title, message } = req.body || {};
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });
    
    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [payload.username]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const now = Date.now();
    const ticketResult = await pool.query(
      'INSERT INTO tickets (user_id, username, title, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [user.id, user.username, title, 'open', now, now]
    );
    const ticketId = ticketResult.rows[0].id;
    
    await pool.query(
      'INSERT INTO ticket_messages (ticket_id, user_id, username, message, is_admin, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [ticketId, user.id, user.username, message, 0, now]
    );
    
    res.json({ ok: true, ticketId });
  } catch (e) {
    console.error('Create ticket error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get my tickets
app.get('/api/tickets/my', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = auth.substring(7);
    const payload = jwt.verify(token, JWT_SECRET);
    
    const result = await pool.query('SELECT * FROM tickets WHERE username = $1 ORDER BY updated_at DESC', [payload.username]);
    res.json({ tickets: result.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Legacy endpoint (keep for compatibility)
app.post('/api/tickets', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = auth.substring(7);
    const payload = jwt.verify(token, JWT_SECRET);
    
    const { title, message } = req.body || {};
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });
    
    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [payload.username]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const now = Date.now();
    const ticketResult = await pool.query(
      'INSERT INTO tickets (user_id, username, title, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [user.id, user.username, title, 'open', now, now]
    );
    const ticketId = ticketResult.rows[0].id;
    
    await pool.query(
      'INSERT INTO ticket_messages (ticket_id, user_id, username, message, is_admin, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [ticketId, user.id, user.username, message, 0, now]
    );
    
    res.json({ ok: true, ticketId });
  } catch (e) {
    console.error('Create ticket error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/tickets', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = auth.substring(7);
    const payload = jwt.verify(token, JWT_SECRET);
    
    const result = await pool.query('SELECT * FROM tickets WHERE username = $1 ORDER BY updated_at DESC', [payload.username]);
    res.json({ tickets: result.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/tickets/:id', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = auth.substring(7);
    const payload = jwt.verify(token, JWT_SECRET);
    
    const ticketResult = await pool.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
    const ticket = ticketResult.rows[0];
    
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.username !== payload.username) return res.status(403).json({ error: 'Access denied' });
    
    const messagesResult = await pool.query('SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC', [req.params.id]);
    
    res.json({ ticket, messages: messagesResult.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/tickets/:id/reply', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = auth.substring(7);
    const payload = jwt.verify(token, JWT_SECRET);
    
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    
    const ticketResult = await pool.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
    const ticket = ticketResult.rows[0];
    
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.username !== payload.username) return res.status(403).json({ error: 'Access denied' });
    
    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [payload.username]);
    const user = userResult.rows[0];
    
    const now = Date.now();
    await pool.query(
      'INSERT INTO ticket_messages (ticket_id, user_id, username, message, is_admin, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.params.id, user.id, user.username, message, 0, now]
    );
    
    await pool.query('UPDATE tickets SET updated_at = $1 WHERE id = $2', [now, req.params.id]);
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/tickets', adminOnly, async (req, res) => {
  const result = await pool.query('SELECT * FROM tickets ORDER BY updated_at DESC');
  res.json({ tickets: result.rows });
});

app.get('/api/admin/tickets/:id', adminOnly, async (req, res) => {
  const ticketResult = await pool.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
  const ticket = ticketResult.rows[0];
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  
  const messagesResult = await pool.query('SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC', [req.params.id]);
  res.json({ ticket, messages: messagesResult.rows });
});

app.post('/api/admin/tickets/:id/reply', adminOnly, async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  
  const now = Date.now();
  await pool.query(
    'INSERT INTO ticket_messages (ticket_id, user_id, username, message, is_admin, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [req.params.id, null, 'Admin', message, 1, now]
  );
  
  await pool.query('UPDATE tickets SET updated_at = $1 WHERE id = $2', [now, req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/tickets/:id/close', adminOnly, async (req, res) => {
  await pool.query('UPDATE tickets SET status = $1 WHERE id = $2', ['closed', req.params.id]);
  res.json({ ok: true });
});

// ---- Robokassa Payment Integration ----

// Create payment
app.post('/api/payment/create', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = auth.substring(7);
    const payload = jwt.verify(token, JWT_SECRET);
    
    const { productId, promocode } = req.body || {};
    if (!productId) return res.status(400).json({ error: 'Product ID required' });
    
    // Get user
    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [payload.username]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Get product
    const productResult = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
    const product = productResult.rows[0];
    if (!product) return res.status(404).json({ error: 'Product not found' });
    
    let finalAmount = product.price;
    let discount = 0;
    let promoCode = null;
    
    // Apply promocode if provided
    if (promocode) {
      const promoResult = await pool.query('SELECT * FROM promocodes WHERE code = $1', [promocode.toUpperCase()]);
      const promo = promoResult.rows[0];
      
      if (promo) {
        // Check validity
        if (promo.expires_at && promo.expires_at < Date.now()) {
          return res.status(400).json({ error: 'Промокод истёк' });
        }
        if (promo.uses_left !== null && promo.uses_left <= 0) {
          return res.status(400).json({ error: 'Промокод исчерпан' });
        }
        
        discount = promo.discount;
        finalAmount = Math.round(product.price * (1 - discount / 100));
        promoCode = promo.code;
      }
    }
    
    // Create payment record
    const paymentResult = await pool.query(
      'INSERT INTO payments (user_id, username, product_id, product_name, amount, original_amount, discount, promocode, payment_id, status, days, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id',
      [user.id, user.username, product.id, product.name, finalAmount, product.price, discount, promoCode, '', 'pending', product.days, Date.now()]
    );
    
    const paymentId = paymentResult.rows[0].id;
    
    // Update payment_id
    await pool.query('UPDATE payments SET payment_id = $1 WHERE id = $2', [paymentId.toString(), paymentId]);
    
    // Generate Robokassa payment URL
    const description = `${product.name} - ${user.username}`;
    const signature = generateRobokassaSignature(
      ROBOKASSA_LOGIN,
      finalAmount.toFixed(2),
      paymentId.toString(),
      ROBOKASSA_PASSWORD1
    );
    
    const baseUrl = ROBOKASSA_TEST_MODE ? 'https://auth.robokassa.ru/Merchant/Index/' : 'https://auth.robokassa.ru/Merchant/Index.aspx';
    const paymentUrl = `${baseUrl}?MerchantLogin=${ROBOKASSA_LOGIN}&OutSum=${finalAmount.toFixed(2)}&InvId=${paymentId}&Description=${encodeURIComponent(description)}&SignatureValue=${signature}&IsTest=${ROBOKASSA_TEST_MODE ? 1 : 0}`;
    
    res.json({ 
      ok: true, 
      paymentId: paymentId.toString(),
      confirmationUrl: paymentUrl,
      amount: finalAmount
    });
  } catch (e) {
    console.error('Payment create error:', e);
    res.status(500).json({ error: 'Payment creation failed: ' + e.message });
  }
});

// Robokassa Result URL (payment success notification)
app.post('/api/payment/result', async (req, res) => {
  try {
    const { OutSum, InvId, SignatureValue } = req.body;
    
    // Verify signature
    if (!verifyRobokassaSignature(OutSum, InvId, SignatureValue, ROBOKASSA_PASSWORD2)) {
      console.error('Invalid Robokassa signature');
      return res.status(400).send('bad sign');
    }
    
    // Get payment from database
    const paymentResult = await pool.query('SELECT * FROM payments WHERE payment_id = $1', [InvId]);
    const payment = paymentResult.rows[0];
    
    if (!payment) {
      console.error('Payment not found:', InvId);
      return res.status(404).send('payment not found');
    }
    
    if (payment.status === 'succeeded') {
      // Already processed
      return res.send(`OK${InvId}`);
    }
    
    // Update payment status
    await pool.query('UPDATE payments SET status = $1, paid_at = $2 WHERE payment_id = $3', 
      ['succeeded', Date.now(), InvId]);
    
    // Add subscription to user
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [payment.user_id]);
    const user = userResult.rows[0];
    
    if (user) {
      const now = Date.now();
      const base = (user.sub_until && user.sub_until > now) ? Number(user.sub_until) : now;
      const newUntil = base + payment.days * 86400000;
      
      await pool.query('UPDATE users SET sub_until = $1 WHERE id = $2', [newUntil, user.id]);
      
      // Use promocode if applied
      if (payment.promocode) {
        await pool.query(
          'UPDATE promocodes SET uses_left = CASE WHEN uses_left IS NULL THEN NULL ELSE uses_left - 1 END WHERE code = $1',
          [payment.promocode]
        );
      }
    }
    
    res.send(`OK${InvId}`);
  } catch (e) {
    console.error('Robokassa result error:', e);
    res.status(500).send('error');
  }
});

// Robokassa Success URL (user redirect after payment)
app.get('/api/payment/success', async (req, res) => {
  const { OutSum, InvId, SignatureValue } = req.query;
  
  // Verify signature
  if (verifyRobokassaSignature(OutSum, InvId, SignatureValue, ROBOKASSA_PASSWORD1)) {
    res.redirect('/profile?payment=success');
  } else {
    res.redirect('/profile?payment=error');
  }
});

// Robokassa Fail URL (payment failed)
app.get('/api/payment/fail', (req, res) => {
  res.redirect('/profile?payment=failed');
});

// Check payment status
app.get('/api/payment/status/:paymentId', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = auth.substring(7);
    const payload = jwt.verify(token, JWT_SECRET);
    
    const paymentResult = await pool.query('SELECT * FROM payments WHERE payment_id = $1 AND username = $2', 
      [req.params.paymentId, payload.username]);
    const payment = paymentResult.rows[0];
    
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    
    res.json({ 
      ok: true, 
      status: payment.status,
      amount: payment.amount,
      product: payment.product_name
    });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Admin: view all payments
app.get('/api/admin/payments', adminOnly, async (req, res) => {
  const result = await pool.query('SELECT * FROM payments ORDER BY created_at DESC LIMIT 100');
  res.json({ payments: result.rows });
});

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
