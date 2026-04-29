'use strict';

const bcrypt   = require('bcryptjs');
const db       = require('../db/db');
const emailSvc = require('./email');
const smsSvc   = require('./sms');

const OTP_EXPIRE_MINUTES = 10;
const MAX_ATTEMPTS       = 5;

// Dev-mode plaintext store (memory-only, cleared on server restart)
const _devStore = process.env.NODE_ENV !== 'production' ? {} : null;

function getDevCode(email, purpose) {
  if (!_devStore) return null;
  return _devStore[email.toLowerCase() + ':' + purpose] || null;
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Is this identifier an email address (vs phone number)?
function isEmailAddress(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

async function createOTP(email, purpose) {
  const code      = generateCode();
  const codeHash  = await bcrypt.hash(code, 8);
  const expiresAt = new Date(Date.now() + OTP_EXPIRE_MINUTES * 60 * 1000).toISOString();

  // Invalidate any prior unused OTPs for this email+purpose
  db.prepare(`UPDATE otp_codes SET used = 1 WHERE email = ? AND purpose = ? AND used = 0`)
    .run(email.toLowerCase(), purpose);

  db.prepare(
    `INSERT INTO otp_codes (email, code_hash, purpose, expires_at) VALUES (?, ?, ?, ?)`
  ).run(email.toLowerCase(), codeHash, purpose, expiresAt);

  if (_devStore) {
    _devStore[email.toLowerCase() + ':' + purpose] = code;
  }

  // Deliver the code
  if (isEmailAddress(email)) {
    await emailSvc.sendOTP(email, code, purpose);
  } else {
    await smsSvc.sendOTP(email, code, purpose);
  }

  return code;
}

async function verifyOTP(email, code, purpose) {
  const row = db.prepare(
    `SELECT * FROM otp_codes
     WHERE email = ? AND purpose = ? AND used = 0
     ORDER BY created_at DESC LIMIT 1`
  ).get(email.toLowerCase(), purpose);

  if (!row) return { ok: false, reason: 'not_found' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  db.prepare(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`).run(row.id);

  const match = await bcrypt.compare(code, row.code_hash);
  if (!match) return { ok: false, reason: 'invalid_code' };

  db.prepare(`UPDATE otp_codes SET used = 1 WHERE id = ?`).run(row.id);
  return { ok: true };
}

module.exports = { createOTP, verifyOTP, getDevCode };
