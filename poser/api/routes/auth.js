'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const db       = require('../db/db');
const jwtSvc   = require('../services/jwt');
const otpSvc   = require('../services/otp');
const { verifyJWT } = require('../middleware/auth');
const { avatarUpload, fileUrl } = require('../middleware/upload');

const router = express.Router();

// Username rules: 3-20 chars, letters/numbers/dots/underscores, no leading/trailing . or _
function isValidUsername(u) {
  if (!u || u.length < 3 || u.length > 20) return false;
  if (!/^[a-zA-Z0-9._]+$/.test(u)) return false;
  if (/^[._]|[._]$/.test(u)) return false;
  return true;
}

const REFRESH_COOKIE = 'poser_rt';
const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure:   process.env.NODE_ENV === 'production',
  maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days in ms
  path:     '/api/v1/auth',
};

function issueTokens(res, user) {
  const payload = { sub: user.id, username: user.username, role: user.role };
  const accessToken  = jwtSvc.signAccess(payload);
  // Add a random jti so tokens issued in the same second are always unique
  const refreshToken = jwtSvc.signRefresh({ sub: user.id, jti: crypto.randomBytes(16).toString('hex') });
  const expiresAt    = jwtSvc.decodeExpiry(refreshToken);

  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  db.prepare(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`
  ).run(user.id, tokenHash, expiresAt);

  res.cookie(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTS);
  return accessToken;
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, bio: u.bio,
    avatar_url: u.avatar_url, pillars: JSON.parse(u.pillars || '[]'),
    follower_count: u.follower_count, following_count: u.following_count,
    review_count: u.review_count, insight_score: u.insight_score,
    is_verified: !!u.is_verified, role: u.role, created_at: u.created_at,
  };
}

// POST /auth/register — simple username+password registration
router.post('/register', avatarUpload.single('avatar'), async (req, res) => {
  const { username, password, bio, pillars } = req.body;

  if (!username) return res.status(400).json({ error: 'username required' });
  if (!password || password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters and include a letter and a number' });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: 'Username: 3–20 chars, letters/numbers/dots/underscores' });
  }

  let parsedPillars = [];
  try {
    parsedPillars = typeof pillars === 'string' ? JSON.parse(pillars) : (pillars || []);
    if (!Array.isArray(parsedPillars) || parsedPillars.length === 0) throw new Error();
    const valid = new Set(['cinema','music','fashion','lit']);
    if (!parsedPillars.every(p => valid.has(p))) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Select at least one pillar' });
  }

  const taken = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username);
  if (taken) return res.status(409).json({ error: 'Username already taken' });

  const passwordHash = await bcrypt.hash(password, 12);
  const avatarUrl = req.file ? fileUrl('avatars', req.file.filename) : null;

  db.prepare(
    `INSERT INTO users (username, email, password_hash, bio, avatar_url, pillars)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(username, `${username.toLowerCase()}@users.local`, passwordHash, bio || '', avatarUrl, JSON.stringify(parsedPillars));

  const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
  const accessToken = issueTokens(res, user);
  res.status(201).json({ ok: true, access_token: accessToken, user: publicUser(user) });
});

// POST /auth/register/init — send OTP
router.post('/register/init', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  const exists = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'Email already registered' });

  await otpSvc.createOTP(email, 'signup');
  res.json({ ok: true, message: 'Verification code sent' });
});

// POST /auth/register/verify — verify OTP, return temp token
router.post('/register/verify', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'email and code required' });

  const result = await otpSvc.verifyOTP(email, code, 'signup');
  if (!result.ok) return res.status(400).json({ error: result.reason });

  // Issue a short-lived temp token scoped to completing registration
  const tempToken = jwtSvc.signAccess({ sub: null, email: email.toLowerCase(), scope: 'register' });
  res.json({ ok: true, temp_token: tempToken });
});

// POST /auth/register/complete — finish profile, create account
router.post('/register/complete', avatarUpload.single('avatar'), async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  let temp;
  try {
    temp = jwtSvc.verifyAccess(authHeader.slice(7));
  } catch {
    return res.status(401).json({ error: 'Invalid or expired temp token' });
  }
  if (!['register', 'register_google'].includes(temp.scope)) {
    return res.status(403).json({ error: 'Invalid token scope' });
  }

  const isGoogle = temp.scope === 'register_google';
  const { email, google_id, phone } = temp;
  const { username, password, bio, pillars } = req.body;

  if (!username) return res.status(400).json({ error: 'username required' });
  if (!isGoogle) {
    if (!password) return res.status(400).json({ error: 'password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: 'Username: 3-20 chars, letters/numbers/dots/underscores, cannot start or end with . or _' });
  }

  let parsedPillars = [];
  try {
    parsedPillars = typeof pillars === 'string' ? JSON.parse(pillars) : pillars;
    if (!Array.isArray(parsedPillars) || parsedPillars.length === 0) throw new Error();
    const valid = new Set(['cinema','music','fashion','lit']);
    if (!parsedPillars.every(p => valid.has(p))) throw new Error();
  } catch {
    return res.status(400).json({ error: 'pillars must be a non-empty JSON array of valid pillar ids' });
  }

  const taken = db.prepare(`SELECT id FROM users WHERE username = ? OR email = ?`).get(username, email);
  if (taken) return res.status(409).json({ error: 'Username or email already taken' });

  const passwordHash = (!isGoogle && password) ? await bcrypt.hash(password, 12) : null;

  // For Google users, use Google profile picture if no upload
  let avatarUrl = req.file ? fileUrl('avatars', req.file.filename) : null;
  if (!avatarUrl && isGoogle && temp.google_picture) avatarUrl = temp.google_picture;

  const result = db.prepare(
    `INSERT INTO users (username, email, password_hash, bio, avatar_url, pillars, google_id, phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(username, email, passwordHash, bio || '', avatarUrl,
        JSON.stringify(parsedPillars), google_id || null, phone || null);

  const user        = db.prepare(`SELECT * FROM users WHERE id = ?`).get(result.lastInsertRowid);
  const accessToken = issueTokens(res, user);

  res.status(201).json({ ok: true, access_token: accessToken, user: publicUser(user) });
});

// POST /auth/login — accepts username or email
router.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) return res.status(400).json({ error: 'username and password required' });

  // Look up by username first, then fall back to email
  const user = db.prepare(`SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1`)
    .get(identifier.trim(), identifier.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  if (user.is_banned) return res.status(403).json({ error: 'Account suspended', reason: user.ban_reason });
  if (user.is_guest) return res.status(403).json({ error: 'Guest accounts cannot log in with a password' });

  const valid = await bcrypt.compare(password, user.password_hash || '');
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

  const accessToken = issueTokens(res, user);
  res.json({ ok: true, access_token: accessToken, user: publicUser(user) });
});

// POST /auth/refresh — rotate refresh token
router.post('/refresh', (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) return res.status(401).json({ error: 'No refresh token' });

  let payload;
  try { payload = jwtSvc.verifyRefresh(token); } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const stored    = db.prepare(
    `SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0`
  ).get(tokenHash);

  if (!stored || new Date(stored.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Refresh token revoked or expired' });
  }

  // Rotate: revoke old, issue new
  db.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE id = ?`).run(stored.id);

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(payload.sub);
  if (!user || user.is_banned) return res.status(403).json({ error: 'Account unavailable' });

  const accessToken = issueTokens(res, user);
  res.json({ ok: true, access_token: accessToken, user: publicUser(user) });
});

// POST /auth/logout
router.post('/logout', verifyJWT, (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    db.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?`).run(tokenHash);
  }
  res.clearCookie(REFRESH_COOKIE, { ...REFRESH_COOKIE_OPTS, maxAge: 0 });
  res.json({ ok: true });
});

// POST /auth/password/reset-request
router.post('/password/reset-request', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.toLowerCase());
  // Always respond OK to prevent email enumeration
  if (user) await otpSvc.createOTP(email, 'reset');
  res.json({ ok: true, message: 'If that email exists, a reset code was sent' });
});

// POST /auth/password/reset
router.post('/password/reset', async (req, res) => {
  const { email, code, new_password } = req.body;
  if (!email || !code || !new_password) {
    return res.status(400).json({ error: 'email, code, and new_password required' });
  }
  if (new_password.length < 8) return res.status(400).json({ error: 'Password too short' });

  const result = await otpSvc.verifyOTP(email, code, 'reset');
  if (!result.ok) return res.status(400).json({ error: result.reason });

  const passwordHash = await bcrypt.hash(new_password, 12);
  db.prepare(
    `UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email = ?`
  ).run(passwordHash, email.toLowerCase());

  res.json({ ok: true });
});

// GET /auth/username/check?u=:username
router.get('/username/check', (req, res) => {
  const u = (req.query.u || '').trim();
  if (!u || !isValidUsername(u)) {
    return res.status(400).json({ available: false, error: 'Invalid username format' });
  }
  const exists = db.prepare(`SELECT id FROM users WHERE username = ?`).get(u);
  res.json({ available: !exists });
});

// POST /auth/guest — create a guest account (no email/password needed)
router.post('/guest', async (req, res) => {
  const guestId = crypto.randomBytes(4).toString('hex');
  const username = `guest_${guestId}`;
  const email = `guest_${guestId}@guest.local`;

  try {
    db.prepare(
      `INSERT INTO users (username, email, is_guest) VALUES (?, ?, 1)`
    ).run(username, email);

    const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
    const accessToken = issueTokens(res, user);
    res.status(201).json({ ok: true, access_token: accessToken, user: publicUser(user) });
  } catch (e) {
    console.error('[GUEST]', e.message);
    res.status(500).json({ error: 'Could not create guest account' });
  }
});

// POST /auth/google — verify Google ID token, sign in or begin registration
router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'credential required' });

  let payload;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!r.ok) throw new Error('Google rejected the token');
    payload = await r.json();
    if (payload.error_description) throw new Error(payload.error_description);
    const cid = process.env.GOOGLE_CLIENT_ID;
    if (cid && payload.aud !== cid) throw new Error('Client ID mismatch');
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Google credential: ' + err.message });
  }

  const googleId = payload.sub;
  const email    = payload.email?.toLowerCase();

  // Look up existing user by google_id or email
  let user = googleId ? db.prepare(`SELECT * FROM users WHERE google_id = ?`).get(googleId) : null;
  if (!user && email) user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);

  if (user) {
    // Link google_id if not already set
    if (!user.google_id) db.prepare(`UPDATE users SET google_id = ? WHERE id = ?`).run(googleId, user.id);
    if (user.is_banned) return res.status(403).json({ error: 'Account suspended', reason: user.ban_reason });
    const accessToken = issueTokens(res, user);
    return res.json({ ok: true, is_new: false, access_token: accessToken, user: publicUser(user) });
  }

  // New Google user — issue a temp registration token
  const syntheticEmail = email || `g${googleId}@google.poser`;
  const tempToken = jwtSvc.signAccess({
    sub: null, email: syntheticEmail, google_id: googleId,
    google_name: payload.name, google_picture: payload.picture,
    scope: 'register_google',
  });
  res.json({ ok: true, is_new: true, temp_token: tempToken,
             email: payload.email, name: payload.name, picture: payload.picture });
});

// POST /auth/phone/init — send phone OTP
router.post('/phone/init', async (req, res) => {
  let { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  phone = phone.replace(/[\s\-\(\)\.]/g, '');
  if (!/^\+?[1-9]\d{6,14}$/.test(phone)) return res.status(400).json({ error: 'Invalid phone number' });

  const exists = db.prepare(`SELECT id FROM users WHERE phone = ?`).get(phone);
  if (exists) return res.status(409).json({ error: 'Phone number already registered' });

  await otpSvc.createOTP(phone, 'signup');
  res.json({ ok: true });
});

// POST /auth/phone/verify — verify phone OTP, return temp token
router.post('/phone/verify', async (req, res) => {
  let { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });
  phone = phone.replace(/[\s\-\(\)\.]/g, '');

  const result = await otpSvc.verifyOTP(phone, code, 'signup');
  if (!result.ok) return res.status(400).json({ error: result.reason });

  const tempToken = jwtSvc.signAccess({
    sub: null,
    email: `${phone.replace(/^\+/, '')}@phone.poser`,
    phone,
    scope: 'register',
  });
  res.json({ ok: true, temp_token: tempToken });
});

module.exports = router;
