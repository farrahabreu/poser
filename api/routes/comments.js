'use strict';

const express  = require('express');
const db       = require('../db/db');
const { verifyJWT, optionalJWT } = require('../middleware/auth');
const { audioUpload, fileUrl }   = require('../middleware/upload');
const { checkAndFlag }           = require('../services/moderation');
const { notify }                 = require('../services/notifications');

const router = express.Router({ mergeParams: true });

function enrichComment(c, viewerId) {
  const out = { ...c };
  if (viewerId) {
    out.liked = !!db.prepare(
      `SELECT 1 FROM comment_likes WHERE user_id = ? AND comment_id = ?`
    ).get(viewerId, c.id);
  }
  out.is_deleted = !!c.deleted_at;
  if (out.is_deleted) {
    out.body_text = null;
    out.audio_url = null;
  }
  return out;
}

function buildThread(comments, viewerId) {
  const byId   = new Map(comments.map(c => [c.id, { ...enrichComment(c, viewerId), replies: [] }]));
  const roots  = [];
  for (const c of byId.values()) {
    if (c.parent_id && byId.has(c.parent_id)) {
      byId.get(c.parent_id).replies.push(c);
    } else {
      roots.push(c);
    }
  }
  return roots;
}

// GET /reviews/:reviewId/comments
router.get('/', optionalJWT, (req, res) => {
  const review = db.prepare(`SELECT id FROM reviews WHERE id = ? AND deleted_at IS NULL`).get(req.params.reviewId);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  const viewerId = req.user?.sub;
  const comments = db.prepare(
    `SELECT c.*, u.username, u.avatar_url, u.pillars as user_pillars
     FROM comments c JOIN users u ON c.user_id = u.id
     WHERE c.review_id = ?
     ORDER BY c.depth ASC, c.created_at ASC`
  ).all(review.id);

  res.json({ comments: buildThread(comments, viewerId) });
});

// POST /reviews/:reviewId/comments
router.post('/', verifyJWT, audioUpload.single('audio'), (req, res) => {
  const review = db.prepare(`SELECT * FROM reviews WHERE id = ? AND deleted_at IS NULL AND is_draft = 0`).get(req.params.reviewId);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  const { body_text, timestamp_sec } = req.body;
  if (!body_text?.trim() && !req.file) {
    return res.status(400).json({ error: 'Either body_text or audio file required' });
  }

  const audioUrl = req.file ? fileUrl('audio', req.file.filename) : null;
  const ts       = timestamp_sec != null ? parseFloat(timestamp_sec) : null;

  const insertAndFlag = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO comments (review_id, user_id, depth, body_text, audio_url, audio_duration_sec, timestamp_sec)
       VALUES (?, ?, 0, ?, ?, ?, ?)`
    ).run(
      review.id, req.user.sub,
      body_text || null, audioUrl,
      req.body.audio_duration_sec ? parseInt(req.body.audio_duration_sec, 10) : null,
      ts
    );
    const commentId = result.lastInsertRowid;
    db.prepare(`UPDATE reviews SET comment_count = comment_count + 1 WHERE id = ?`).run(review.id);
    checkAndFlag('comment', commentId, body_text);
    return commentId;
  });

  const commentId = insertAndFlag();

  notify({ userId: review.user_id, type: 'comment', actorId: req.user.sub, reviewId: review.id, commentId });

  const comment = db.prepare(
    `SELECT c.*, u.username, u.avatar_url FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?`
  ).get(commentId);

  res.status(201).json(enrichComment(comment, req.user.sub));
});

// POST /reviews/:reviewId/comments/:commentId/reply
router.post('/:commentId/reply', verifyJWT, audioUpload.single('audio'), (req, res) => {
  const review = db.prepare(`SELECT * FROM reviews WHERE id = ? AND deleted_at IS NULL AND is_draft = 0`).get(req.params.reviewId);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  const parent = db.prepare(
    `SELECT * FROM comments WHERE id = ? AND review_id = ? AND deleted_at IS NULL`
  ).get(req.params.commentId, review.id);
  if (!parent) return res.status(404).json({ error: 'Comment not found' });
  if (parent.depth >= 2) return res.status(400).json({ error: 'Maximum reply depth reached' });

  const { body_text } = req.body;
  if (!body_text?.trim() && !req.file) {
    return res.status(400).json({ error: 'Either body_text or audio file required' });
  }

  const audioUrl = req.file ? fileUrl('audio', req.file.filename) : null;

  const insertAndFlag = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO comments (review_id, user_id, parent_id, depth, body_text, audio_url, audio_duration_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      review.id, req.user.sub, parent.id, parent.depth + 1,
      body_text || null, audioUrl,
      req.body.audio_duration_sec ? parseInt(req.body.audio_duration_sec, 10) : null
    );
    const commentId = result.lastInsertRowid;
    db.prepare(`UPDATE reviews SET comment_count = comment_count + 1 WHERE id = ?`).run(review.id);
    checkAndFlag('comment', commentId, body_text);
    return commentId;
  });

  const commentId = insertAndFlag();

  // Notify: review owner (if different) + parent comment owner (if different)
  const uniqueOwners = new Set([review.user_id, parent.user_id].filter(id => id !== req.user.sub));
  for (const ownerId of uniqueOwners) {
    notify({ userId: ownerId, type: 'comment', actorId: req.user.sub, reviewId: review.id, commentId });
  }

  const comment = db.prepare(
    `SELECT c.*, u.username, u.avatar_url FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?`
  ).get(commentId);

  res.status(201).json(enrichComment(comment, req.user.sub));
});

// DELETE /comments/:commentId  (note: no reviewId prefix — mounted separately)
router.delete('/:commentId/delete', verifyJWT, (req, res) => {
  const comment = db.prepare(`SELECT * FROM comments WHERE id = ? AND deleted_at IS NULL`).get(req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  if (comment.user_id !== req.user.sub && !['mod','admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.prepare(`UPDATE comments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(comment.id);
  db.prepare(`UPDATE reviews SET comment_count = MAX(0, comment_count - 1) WHERE id = ?`).run(comment.review_id);

  res.json({ ok: true });
});

// POST /reviews/:reviewId/comments/:commentId/like
router.post('/:commentId/like', verifyJWT, (req, res) => {
  const comment = db.prepare(`SELECT * FROM comments WHERE id = ? AND deleted_at IS NULL`).get(req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });

  const already = db.prepare(
    `SELECT 1 FROM comment_likes WHERE user_id = ? AND comment_id = ?`
  ).get(req.user.sub, comment.id);

  if (!already) {
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO comment_likes (user_id, comment_id) VALUES (?, ?)`).run(req.user.sub, comment.id);
      db.prepare(`UPDATE comments SET like_count = like_count + 1 WHERE id = ?`).run(comment.id);
    })();
    notify({ userId: comment.user_id, type: 'comment_like', actorId: req.user.sub, commentId: comment.id });
  }

  const updated = db.prepare(`SELECT like_count FROM comments WHERE id = ?`).get(comment.id);
  res.json({ ok: true, liked: true, like_count: updated.like_count });
});

// DELETE /reviews/:reviewId/comments/:commentId/like
router.delete('/:commentId/like', verifyJWT, (req, res) => {
  const comment = db.prepare(`SELECT id FROM comments WHERE id = ? AND deleted_at IS NULL`).get(req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });

  db.transaction(() => {
    const existed = db.prepare(`SELECT 1 FROM comment_likes WHERE user_id = ? AND comment_id = ?`).get(req.user.sub, comment.id);
    if (existed) {
      db.prepare(`DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?`).run(req.user.sub, comment.id);
      db.prepare(`UPDATE comments SET like_count = MAX(0, like_count - 1) WHERE id = ?`).run(comment.id);
    }
  })();

  const updated = db.prepare(`SELECT like_count FROM comments WHERE id = ?`).get(comment.id);
  res.json({ ok: true, liked: false, like_count: updated.like_count });
});

module.exports = router;
