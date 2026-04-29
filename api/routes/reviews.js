'use strict';

const express  = require('express');
const db       = require('../db/db');
const { verifyJWT, optionalJWT } = require('../middleware/auth');
const { audioUpload, fileUrl }   = require('../middleware/upload');
const { checkAndFlag }           = require('../services/moderation');
const { notify, notifySubscribers } = require('../services/notifications');

const router = express.Router();

const VALID_PILLARS = new Set(['cinema','music','fashion','lit']);

function enrichReview(row, viewerId) {
  const r = { ...row };
  r.waveform_data = row.waveform_data ? JSON.parse(row.waveform_data) : null;
  if (viewerId) {
    r.liked   = !!db.prepare(`SELECT 1 FROM likes   WHERE user_id = ? AND review_id = ?`).get(viewerId, row.id);
    r.reposted = !!db.prepare(`SELECT 1 FROM reposts WHERE user_id = ? AND review_id = ?`).get(viewerId, row.id);
    r.saved   = !!db.prepare(`SELECT 1 FROM saves   WHERE user_id = ? AND review_id = ?`).get(viewerId, row.id);
  }
  return r;
}

function isBlocked(a, b) {
  return !!db.prepare(
    `SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?) LIMIT 1`
  ).get(a, b, b, a);
}

// POST /reviews — create review (multipart/form-data)
router.post('/', verifyJWT, audioUpload.single('audio'), (req, res) => {
  const { pillar, subject_title, subject_year, subject_creator, body_text, waveform_data, is_draft } = req.body;

  if (!pillar || !VALID_PILLARS.has(pillar)) {
    return res.status(400).json({ error: 'Valid pillar required: cinema, music, fashion, lit' });
  }
  if (!subject_title?.trim()) return res.status(400).json({ error: 'subject_title required' });
  if (!body_text?.trim() && !req.file) {
    return res.status(400).json({ error: 'Either body_text or audio file required' });
  }

  const audioUrl  = req.file ? fileUrl('audio', req.file.filename) : null;
  const draft     = is_draft === '1' || is_draft === true ? 1 : 0;

  const insertAndFlag = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO reviews
         (user_id, pillar, subject_title, subject_year, subject_creator,
          body_text, audio_url, audio_duration_sec, waveform_data, is_draft)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.user.sub, pillar, subject_title.trim(),
      subject_year ? parseInt(subject_year, 10) : null,
      subject_creator || null,
      body_text || null, audioUrl,
      req.body.audio_duration_sec ? parseInt(req.body.audio_duration_sec, 10) : null,
      waveform_data || null,
      draft
    );
    const reviewId = result.lastInsertRowid;
    checkAndFlag('review', reviewId, body_text);
    if (!draft) {
      db.prepare(`UPDATE users SET review_count = review_count + 1 WHERE id = ?`).run(req.user.sub);
    }
    return reviewId;
  });

  const reviewId = insertAndFlag();
  const review   = db.prepare(`SELECT * FROM reviews WHERE id = ?`).get(reviewId);

  if (!draft) {
    notifySubscribers(req.user.sub, reviewId);
  }

  res.status(201).json(enrichReview(review, req.user.sub));
});

// GET /reviews — feed (following + discover with pillar filter)
router.get('/', optionalJWT, (req, res) => {
  const cursor   = parseInt(req.query.cursor || '0', 10);
  const limit    = 20;
  const pillars  = req.query.pillars ? req.query.pillars.split(',').filter(p => VALID_PILLARS.has(p)) : [];
  const feed     = req.query.feed || 'discover'; // 'following' or 'discover'
  const viewerId = req.user?.sub;

  let rows;
  const pillarClause = pillars.length
    ? `AND r.pillar IN (${pillars.map(() => '?').join(',')})`
    : '';
  const pillarParams = pillars.length ? pillars : [];

  if (feed === 'following' && viewerId) {
    rows = db.prepare(
      `SELECT r.*, u.username, u.avatar_url, u.pillars as user_pillars
       FROM reviews r JOIN users u ON r.user_id = u.id
       WHERE r.user_id IN (
         SELECT following_id FROM follows WHERE follower_id = ?
       )
       AND r.is_draft = 0 AND r.deleted_at IS NULL AND r.id > ?
       ${pillarClause}
       ORDER BY r.created_at DESC LIMIT ?`
    ).all(viewerId, cursor, ...pillarParams, limit + 1);
  } else {
    rows = db.prepare(
      `SELECT r.*, u.username, u.avatar_url, u.pillars as user_pillars
       FROM reviews r JOIN users u ON r.user_id = u.id
       WHERE r.is_draft = 0 AND r.deleted_at IS NULL AND r.id > ?
       ${pillarClause}
       ORDER BY r.created_at DESC LIMIT ?`
    ).all(cursor, ...pillarParams, limit + 1);
  }

  let next_cursor = null;
  if (rows.length > limit) { rows.pop(); next_cursor = rows[rows.length - 1].id; }

  // Filter out blocked users
  const filtered = viewerId ? rows.filter(r => !isBlocked(viewerId, r.user_id)) : rows;

  res.json({ reviews: filtered.map(r => enrichReview(r, viewerId)), next_cursor });
});

// GET /reviews/me/drafts
router.get('/me/drafts', verifyJWT, (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM reviews WHERE user_id = ? AND is_draft = 1 AND deleted_at IS NULL ORDER BY updated_at DESC`
  ).all(req.user.sub);
  res.json({ drafts: rows.map(r => enrichReview(r, req.user.sub)) });
});

// GET /reviews/:id
router.get('/:id', optionalJWT, (req, res) => {
  const review = db.prepare(
    `SELECT r.*, u.username, u.avatar_url, u.pillars as user_pillars
     FROM reviews r JOIN users u ON r.user_id = u.id
     WHERE r.id = ? AND r.deleted_at IS NULL`
  ).get(req.params.id);

  if (!review) return res.status(404).json({ error: 'Review not found' });

  const viewerId = req.user?.sub;
  if (viewerId && isBlocked(viewerId, review.user_id)) return res.status(404).json({ error: 'Review not found' });
  if (review.is_draft && review.user_id !== viewerId) return res.status(404).json({ error: 'Review not found' });

  res.json(enrichReview(review, viewerId));
});

// PATCH /reviews/:id
router.patch('/:id', verifyJWT, (req, res) => {
  const review = db.prepare(`SELECT * FROM reviews WHERE id = ? AND deleted_at IS NULL`).get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  if (review.user_id !== req.user.sub) return res.status(403).json({ error: 'Forbidden' });

  const { subject_title, subject_year, subject_creator, body_text } = req.body;
  const updates = [];
  const params  = [];

  if (subject_title !== undefined) { updates.push('subject_title = ?'); params.push(subject_title); }
  if (subject_year  !== undefined) { updates.push('subject_year = ?');  params.push(parseInt(subject_year, 10) || null); }
  if (subject_creator !== undefined) { updates.push('subject_creator = ?'); params.push(subject_creator); }
  if (body_text !== undefined) { updates.push('body_text = ?'); params.push(body_text); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  params.push(review.id);

  db.prepare(`UPDATE reviews SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare(`SELECT * FROM reviews WHERE id = ?`).get(review.id);
  res.json(enrichReview(updated, req.user.sub));
});

// PATCH /reviews/:id/publish — publish a draft
router.patch('/:id/publish', verifyJWT, (req, res) => {
  const review = db.prepare(`SELECT * FROM reviews WHERE id = ? AND deleted_at IS NULL`).get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  if (review.user_id !== req.user.sub) return res.status(403).json({ error: 'Forbidden' });
  if (!review.is_draft) return res.status(400).json({ error: 'Already published' });

  db.transaction(() => {
    db.prepare(`UPDATE reviews SET is_draft = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(review.id);
    db.prepare(`UPDATE users SET review_count = review_count + 1 WHERE id = ?`).run(req.user.sub);
  })();

  notifySubscribers(req.user.sub, review.id);
  const updated = db.prepare(`SELECT * FROM reviews WHERE id = ?`).get(review.id);
  res.json(enrichReview(updated, req.user.sub));
});

// DELETE /reviews/:id
router.delete('/:id', verifyJWT, (req, res) => {
  const review = db.prepare(`SELECT * FROM reviews WHERE id = ? AND deleted_at IS NULL`).get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  if (review.user_id !== req.user.sub && !['mod','admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.transaction(() => {
    db.prepare(`UPDATE reviews SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(review.id);
    if (!review.is_draft) {
      db.prepare(`UPDATE users SET review_count = MAX(0, review_count - 1) WHERE id = ?`).run(review.user_id);
    }
  })();

  res.json({ ok: true });
});

// ── Engagement ──────────────────────────────────────────────────────────────

// POST /reviews/:id/like
router.post('/:id/like', verifyJWT, (req, res) => {
  const review = db.prepare(`SELECT * FROM reviews WHERE id = ? AND deleted_at IS NULL AND is_draft = 0`).get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  const already = db.prepare(`SELECT 1 FROM likes WHERE user_id = ? AND review_id = ?`).get(req.user.sub, review.id);
  if (!already) {
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO likes (user_id, review_id) VALUES (?, ?)`).run(req.user.sub, review.id);
      db.prepare(`UPDATE reviews SET like_count = like_count + 1 WHERE id = ?`).run(review.id);
    })();
    notify({ userId: review.user_id, type: 'like', actorId: req.user.sub, reviewId: review.id });
  }

  const updated = db.prepare(`SELECT like_count FROM reviews WHERE id = ?`).get(review.id);
  res.json({ ok: true, liked: true, like_count: updated.like_count });
});

// DELETE /reviews/:id/like
router.delete('/:id/like', verifyJWT, (req, res) => {
  const review = db.prepare(`SELECT id, user_id FROM reviews WHERE id = ? AND deleted_at IS NULL`).get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  db.transaction(() => {
    const existed = db.prepare(`SELECT 1 FROM likes WHERE user_id = ? AND review_id = ?`).get(req.user.sub, review.id);
    if (existed) {
      db.prepare(`DELETE FROM likes WHERE user_id = ? AND review_id = ?`).run(req.user.sub, review.id);
      db.prepare(`UPDATE reviews SET like_count = MAX(0, like_count - 1) WHERE id = ?`).run(review.id);
    }
  })();

  const updated = db.prepare(`SELECT like_count FROM reviews WHERE id = ?`).get(review.id);
  res.json({ ok: true, liked: false, like_count: updated.like_count });
});

// POST /reviews/:id/repost
router.post('/:id/repost', verifyJWT, (req, res) => {
  const review = db.prepare(`SELECT * FROM reviews WHERE id = ? AND deleted_at IS NULL AND is_draft = 0`).get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  if (review.user_id === req.user.sub) return res.status(400).json({ error: 'Cannot repost your own review' });

  const already = db.prepare(`SELECT 1 FROM reposts WHERE user_id = ? AND review_id = ?`).get(req.user.sub, review.id);
  if (!already) {
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO reposts (user_id, review_id, quote_text) VALUES (?, ?, ?)`).run(
        req.user.sub, review.id, req.body.quote_text || null
      );
      db.prepare(`UPDATE reviews SET repost_count = repost_count + 1 WHERE id = ?`).run(review.id);
    })();
    notify({ userId: review.user_id, type: 'repost', actorId: req.user.sub, reviewId: review.id });
  }

  const updated = db.prepare(`SELECT repost_count FROM reviews WHERE id = ?`).get(review.id);
  res.json({ ok: true, reposted: true, repost_count: updated.repost_count });
});

// DELETE /reviews/:id/repost
router.delete('/:id/repost', verifyJWT, (req, res) => {
  const review = db.prepare(`SELECT id FROM reviews WHERE id = ? AND deleted_at IS NULL`).get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  db.transaction(() => {
    const existed = db.prepare(`SELECT 1 FROM reposts WHERE user_id = ? AND review_id = ?`).get(req.user.sub, review.id);
    if (existed) {
      db.prepare(`DELETE FROM reposts WHERE user_id = ? AND review_id = ?`).run(req.user.sub, review.id);
      db.prepare(`UPDATE reviews SET repost_count = MAX(0, repost_count - 1) WHERE id = ?`).run(review.id);
    }
  })();

  const updated = db.prepare(`SELECT repost_count FROM reviews WHERE id = ?`).get(review.id);
  res.json({ ok: true, reposted: false, repost_count: updated.repost_count });
});

// POST /reviews/:id/save
router.post('/:id/save', verifyJWT, (req, res) => {
  const review = db.prepare(`SELECT id FROM reviews WHERE id = ? AND deleted_at IS NULL AND is_draft = 0`).get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  db.transaction(() => {
    const already = db.prepare(`SELECT 1 FROM saves WHERE user_id = ? AND review_id = ?`).get(req.user.sub, review.id);
    if (!already) {
      db.prepare(`INSERT OR IGNORE INTO saves (user_id, review_id) VALUES (?, ?)`).run(req.user.sub, review.id);
      db.prepare(`UPDATE reviews SET save_count = save_count + 1 WHERE id = ?`).run(review.id);
    }
  })();

  res.json({ ok: true, saved: true });
});

// DELETE /reviews/:id/save
router.delete('/:id/save', verifyJWT, (req, res) => {
  const review = db.prepare(`SELECT id FROM reviews WHERE id = ? AND deleted_at IS NULL`).get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  db.transaction(() => {
    const existed = db.prepare(`SELECT 1 FROM saves WHERE user_id = ? AND review_id = ?`).get(req.user.sub, review.id);
    if (existed) {
      db.prepare(`DELETE FROM saves WHERE user_id = ? AND review_id = ?`).run(req.user.sub, review.id);
      db.prepare(`UPDATE reviews SET save_count = MAX(0, save_count - 1) WHERE id = ?`).run(review.id);
    }
  })();

  res.json({ ok: true, saved: false });
});

// GET /reviews/:id/share — return shareable URL
router.get('/:id/share', optionalJWT, (req, res) => {
  const review = db.prepare(`SELECT id FROM reviews WHERE id = ? AND deleted_at IS NULL AND is_draft = 0`).get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  const origin = process.env.ALLOWED_ORIGIN || 'http://localhost:8080';
  res.json({ url: `${origin}/review/${review.id}` });
});

// GET /users/me/saves — list saved reviews
router.get('/me/saves', verifyJWT, (req, res) => {
  const cursor = parseInt(req.query.cursor || '0', 10);
  const limit  = 20;

  const rows = db.prepare(
    `SELECT r.*, u.username, u.avatar_url, s.created_at as saved_at
     FROM saves s
     JOIN reviews r ON s.review_id = r.id
     JOIN users u ON r.user_id = u.id
     WHERE s.user_id = ? AND r.deleted_at IS NULL AND s.id > ?
     ORDER BY s.created_at DESC LIMIT ?`
  ).all(req.user.sub, cursor, limit + 1);

  let next_cursor = null;
  if (rows.length > limit) { rows.pop(); next_cursor = rows[rows.length - 1].id; }

  res.json({ saves: rows.map(r => enrichReview(r, req.user.sub)), next_cursor });
});

// GET /users/me/reposts — list reposts
router.get('/me/reposts', verifyJWT, (req, res) => {
  const cursor = parseInt(req.query.cursor || '0', 10);
  const limit  = 20;

  const rows = db.prepare(
    `SELECT r.*, u.username, u.avatar_url, rp.created_at as reposted_at, rp.quote_text
     FROM reposts rp
     JOIN reviews r ON rp.review_id = r.id
     JOIN users u ON r.user_id = u.id
     WHERE rp.user_id = ? AND r.deleted_at IS NULL AND rp.id > ?
     ORDER BY rp.created_at DESC LIMIT ?`
  ).all(req.user.sub, cursor, limit + 1);

  let next_cursor = null;
  if (rows.length > limit) { rows.pop(); next_cursor = rows[rows.length - 1].id; }

  res.json({ reposts: rows.map(r => enrichReview(r, req.user.sub)), next_cursor });
});

module.exports = router;
