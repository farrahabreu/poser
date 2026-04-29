'use strict';

const nodemailer = require('nodemailer');
const path       = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

let _transport = null;

function getTransport() {
  if (_transport) return _transport;
  if (!process.env.SMTP_HOST && !process.env.SMTP_USER) return null;
  _transport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _transport;
}

const SUBJECTS = {
  signup: 'Your POSER verification code',
  reset:  'Reset your POSER password',
  login:  'Your POSER sign-in code',
};

async function sendOTP(to, code, purpose = 'signup') {
  const transport = getTransport();

  if (!transport) {
    console.log(`[EMAIL] No SMTP configured — ${purpose} code for ${to}: ${code}`);
    return;
  }

  const subject = SUBJECTS[purpose] || 'Your POSER code';
  const label   = purpose === 'reset' ? 'Password reset code' : 'Verification code';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#0a0a0a;padding:48px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" role="presentation"
             style="background:#111;border:1px solid #222;border-radius:4px;padding:40px 40px 32px;">
        <tr><td style="font-family:'Courier New',Courier,monospace;color:#fff;">
          <p style="font-size:18px;font-weight:700;letter-spacing:0.15em;margin:0 0 28px;text-transform:uppercase;">POSER</p>
          <p style="color:#888;font-size:13px;letter-spacing:0.05em;text-transform:uppercase;margin:0 0 12px;">${label}</p>
          <p style="font-size:40px;font-weight:700;letter-spacing:0.5em;color:#39FF14;margin:0 0 28px;line-height:1;">${code}</p>
          <p style="color:#555;font-size:12px;line-height:1.6;margin:0;">
            This code expires in <strong style="color:#888;">10 minutes</strong>.<br>
            If you didn't request this, you can safely ignore this email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await transport.sendMail({
    from:    process.env.SMTP_FROM || '"POSER" <noreply@poser.app>',
    to,
    subject,
    html,
    text: `Your POSER ${purpose} code: ${code}\n\nThis code expires in 10 minutes.`,
  });

  console.log(`[EMAIL] Sent ${purpose} code to ${to}`);
}

module.exports = { sendOTP };
