'use strict';

const express = require('express');
const db      = require('../db/db');
const { verifyJWT, requireRole } = require('../middleware/auth');

const router = express.Router();

const VALID_REPORT_REASONS = new Set([
  'spam','harassment','hate_speech','inappropriate_content','impersonation','misinformation','other'
]);
const VALID_TARGET_TYPES = new Set(['review','comment','user','message']);
const VALID_ACTIONS = new Set(['warn','content_removed','temp_ban','perm_ban','dismiss']);

// POST /reports — file a report (any logged-in user)
router.post('/reports', verifyJWT, (req, res) => {
  const { target_type, target_id, reason, details } = req.body;

  if (!VALID_TARGET_TYPES.has(target_type)) return res.status(400).json({ error: 'Invalid target_type' });
  if (!target_id) return res.status(400).json({ error: 'target_id required' });
  if (!VALID_REPORT_REASONS.has(reason)) return res.status(400).json({ error: 'Invalid reason' });

  // Prevent duplicate reports from same user on same target
  const existing = db.prepare(
    `SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'pending'`
  ).get(req.user.sub, target_type, target_id);
  if (existing) return res.status(409).json({ error: 'Already reported' });

  const result = db.prepare(
    `INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES (?, ?, ?, ?, ?)`
  ).run(req.user.sub, target_type, parseInt(target_id, 10), reason, details || null);

  // Also create a moderation flag
  if (target_type !== 'user') {
    db.prepare(
      `INSERT INTO moderation_flags (target_type, target_id, flag_source, severity)
       VALUES (?, ?, 'manual_report', 'medium')`
    ).run(target_type, parseInt(target_id, 10));
  }

  res.status(201).json({ ok: true, report_id: result.lastInsertRowid });
});

// GET /moderation/queue — pending reports + open flags (mod/admin only)
router.get('/moderation/queue', verifyJWT, requireRole('mod','admin'), (req, res) => {
  const status   = req.query.status || 'pending';
  const limit    = parseInt(req.query.limit || '50', 10);
  const offset   = parseInt(req.query.offset || '0', 10);

  const reports = db.prepare(
    `SELECT r.*, u.username as reporter_username
     FROM reports r JOIN users u ON r.reporter_id = u.id
     WHERE r.status = ?
     ORDER BY r.created_at ASC LIMIT ? OFFSET ?`
  ).all(status, limit, offset);

  const flags = db.prepare(
    `SELECT * FROM moderation_flags WHERE status = 'open'
     ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at ASC
     LIMIT ? OFFSET ?`
  ).all(limit, offset);

  res.json({ reports, flags });
});

// PATCH /moderation/reports/:id — action or dismiss a report
router.patch('/moderation/reports/:id', verifyJWT, requireRole('mod','admin'), (req, res) => {
  const report = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  const { status, action_taken } = req.body;
  if (!['reviewed','actioned','dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  db.prepare(
    `UPDATE reports SET status = ?, action_taken = ?, reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).run(status, action_taken || null, req.user.sub, report.id);

  res.json({ ok: true });
});

// POST /moderation/actions — warn/remove/ban a user or content
router.post('/moderation/actions', verifyJWT, requireRole('mod','admin'), (req, res) => {
  const { target_type, target_id, action, reason, ban_until } = req.body;

  if (!VALID_TARGET_TYPES.has(target_type)) return res.status(400).json({ error: 'Invalid target_type' });
  if (!target_id) return res.status(400).json({ error: 'target_id required' });
  if (!VALID_ACTIONS.has(action)) return res.status(400).json({ error: 'Invalid action' });

  db.transaction(() => {
    db.prepare(
      `INSERT INTO moderation_actions (moderator_id, target_type, target_id, action, reason, ban_until)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(req.user.sub, target_type, parseInt(target_id, 10), action, reason || null, ban_until || null);

    if (action === 'content_removed') {
      if (target_type === 'review') {
        db.prepare(`UPDATE reviews SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(target_id);
      } else if (target_type === 'comment') {
        db.prepare(`UPDATE comments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(target_id);
      } else if (target_type === 'message') {
        db.prepare(`UPDATE messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(target_id);
      }
    }

    if (target_type === 'user') {
      if (action === 'perm_ban') {
        db.prepare(
          `UPDATE users SET is_banned = 1, ban_reason = ?, ban_until = NULL WHERE id = ?`
        ).run(reason || null, target_id);
      } else if (action === 'temp_ban' && ban_until) {
        db.prepare(
          `UPDATE users SET is_banned = 1, ban_reason = ?, ban_until = ? WHERE id = ?`
        ).run(reason || null, ban_until, target_id);
      }
    }
  })();

  res.json({ ok: true });
});

// GET /moderation/actions/:userId — user moderation history
router.get('/moderation/actions/:userId', verifyJWT, requireRole('mod','admin'), (req, res) => {
  const actions = db.prepare(
    `SELECT ma.*, u.username as moderator_username
     FROM moderation_actions ma JOIN users u ON ma.moderator_id = u.id
     WHERE ma.target_type = 'user' AND ma.target_id = ?
     ORDER BY ma.created_at DESC`
  ).all(req.params.userId);

  res.json({ actions });
});

module.exports = router;
