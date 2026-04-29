'use strict';

const express = require('express');
const db      = require('../db/db');
const { verifyJWT }     = require('../middleware/auth');
const { getVapidPublicKey } = require('../services/webpush');

const router = express.Router();

// GET /notifications/push/vapid-key — public, no auth needed
router.get('/push/vapid-key', (req, res) => {
  const key = getVapidPublicKey();
  if (!key) return res.status(503).json({ error: 'Push notifications not configured' });
  res.json({ vapid_public_key: key });
});

// GET /notifications/unread-count
router.get('/unread-count', verifyJWT, (req, res) => {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0`
  ).get(req.user.sub);
  res.json({ count: row.count });
});

// GET /notifications
router.get('/', verifyJWT, (req, res) => {
  const cursor = parseInt(req.query.cursor || '0', 10);
  const limit  = 30;

  const rows = db.prepare(
    `SELECT n.*,
            u.username as actor_username, u.avatar_url as actor_avatar
     FROM notifications n
     LEFT JOIN users u ON n.actor_id = u.id
     WHERE n.user_id = ? AND n.id > ?
     ORDER BY n.created_at DESC LIMIT ?`
  ).all(req.user.sub, cursor, limit + 1);

  let next_cursor = null;
  if (rows.length > limit) { rows.pop(); next_cursor = rows[rows.length - 1].id; }

  res.json({ notifications: rows, next_cursor });
});

// PATCH /notifications/:id/read
router.patch('/:id/read', verifyJWT, (req, res) => {
  db.prepare(
    `UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`
  ).run(req.params.id, req.user.sub);
  res.json({ ok: true });
});

// PATCH /notifications/read-all
router.patch('/read-all', verifyJWT, (req, res) => {
  db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0`).run(req.user.sub);
  res.json({ ok: true });
});

// POST /notifications/push/subscribe
router.post('/push/subscribe', verifyJWT, (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'endpoint and keys.p256dh and keys.auth required' });
  }
  db.prepare(
    `UPDATE users SET push_endpoint = ?, push_p256dh = ?, push_auth = ? WHERE id = ?`
  ).run(endpoint, keys.p256dh, keys.auth, req.user.sub);
  res.json({ ok: true });
});

// DELETE /notifications/push/subscribe
router.delete('/push/subscribe', verifyJWT, (req, res) => {
  db.prepare(
    `UPDATE users SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL WHERE id = ?`
  ).run(req.user.sub);
  res.json({ ok: true });
});

module.exports = router;
