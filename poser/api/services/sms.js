'use strict';

/**
 * SMS service — Twilio
 *
 * Required .env vars:
 *   TWILIO_ACCOUNT_SID  — from console.twilio.com → Account Info
 *   TWILIO_AUTH_TOKEN   — from console.twilio.com → Account Info
 *   TWILIO_FROM         — your Twilio phone number in E.164, e.g. +15551234567
 *
 * Falls back to console.log if credentials are not configured (dev mode).
 */

let _client = null;

function getClient() {
  if (_client) return _client;
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || sid.startsWith('AC_YOUR')) return null;
  const twilio = require('twilio');
  _client = twilio(sid, token);
  return _client;
}

/**
 * Send a 6-digit OTP via SMS.
 * @param {string} to      E.164 phone number, e.g. +15550001234
 * @param {string} code    6-digit OTP
 * @param {string} purpose 'signup' | 'login'
 */
async function sendOTP(to, code, purpose = 'signup') {
  const client = getClient();
  const from   = process.env.TWILIO_FROM;

  if (!client || !from) {
    // Not configured — log to console so dev can still test
    console.log(`[SMS:${purpose}] ${to} → code: ${code}`);
    return;
  }

  const body = purpose === 'login'
    ? `Your POSER sign-in code is ${code}. Expires in 10 minutes.`
    : `Your POSER verification code is ${code}. Expires in 10 minutes.`;

  await client.messages.create({ to, from, body });
}

module.exports = { sendOTP };
