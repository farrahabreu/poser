'use strict';

/**
 * Tracking routes
 *
 * GET    /tracking/search          — search external APIs for media
 * GET    /tracking/me              — my tracking lists (all pillars)
 * GET    /tracking/me/:pillar      — my items for one pillar
 * POST   /tracking                 — add item to tracking
 * PATCH  /tracking/:id             — update status / rating / notes / favorite
 * DELETE /tracking/:id             — remove item
 * GET    /tracking/users/:userId   — another user's public tracking lists
 *
 * GET    /tracking/privacy         — get my pillar privacy settings
 * PATCH  /tracking/privacy/:pillar — toggle pillar public/private
 */

const express  = require('express');
const db       = require('../db/db');
const { verifyJWT, optionalJWT } = require('../middleware/auth');
const { search } = require('../services/mediaSearch');

const router = express.Router();

const PILLARS    = ['cinema', 'music', 'fashion', 'lit'];
const STATUSES   = ['done', 'current', 'want'];
const MAX_FAVES  = 10;   // per pillar

// ── helpers ──────────────────────────────────────────────────────────────────

function rowToItem(row) {
  return {
    id:          row.id,
    pillar:      row.pillar,
    status:      row.status,
    external_id: row.external_id,
    media_type:  row.media_type,
    title:       row.title,
    creator:     row.creator,
    year:        row.year,
    cover_url:   row.cover_url,
    rating:      row.rating,
    notes:       row.notes,
    is_favorite: !!row.is_favorite,
    is_public:   !!row.is_public,
    finished_at: row.finished_at,
    review_id:   row.review_id,
    created_at:  row.created_at,
    updated_at:  row.updated_at,
  };
}

function groupByPillar(rows) {
  const out = { cinema: [], music: [], fashion: [], lit: [] };
  for (const row of rows) out[row.pillar].push(rowToItem(row));
  return out;
}

// ── Search ────────────────────────────────────────────────────────────────────
// GET /tracking/search?pillar=cinema&q=Interstellar&musicType=release
router.get('/search', verifyJWT, async (req, res) => {
  const { pillar, q, musicType } = req.query;
  if (!PILLARS.includes(pillar)) return res.status(400).json({ error: 'Invalid pillar' });
  if (!q || !q.trim())           return res.status(400).json({ error: 'Query required' });

  try {
    const results = await search(pillar, q.trim(), { musicType });
    res.json({ results });
  } catch (err) {
    console.error('[tracking/search]', err);
    res.status(502).json({ error: 'External API error' });
  }
});

// ── Privacy ────────────────────────────────────────────────────────────────────
// GET /tracking/privacy
router.get('/privacy', verifyJWT, (req, res) => {
  const rows = db.prepare(
    `SELECT pillar, is_public FROM tracking_privacy WHERE user_id = ?`
  ).all(req.user.sub);

  const out = { cinema: true, music: true, fashion: true, lit: true };
  for (const r of rows) out[r.pillar] = !!r.is_public;
  res.json(out);
});

// PATCH /tracking/privacy/:pillar
router.patch('/privacy/:pillar', verifyJWT, (req, res) => {
  const { pillar } = req.params;
  if (!PILLARS.includes(pillar)) return res.status(400).json({ error: 'Invalid pillar' });

  const { is_public } = req.body;
  if (typeof is_public !== 'boolean') return res.status(400).json({ error: 'is_public must be boolean' });

  db.prepare(`
    INSERT INTO tracking_privacy (user_id, pillar, is_public)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, pillar) DO UPDATE SET is_public = excluded.is_public
  `).run(req.user.sub, pillar, is_public ? 1 : 0);

  res.json({ ok: true, pillar, is_public });
});

// ── My Lists ──────────────────────────────────────────────────────────────────
// GET /tracking/me  — all pillars grouped
router.get('/me', verifyJWT, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM tracking_items WHERE user_id = ?
    ORDER BY updated_at DESC
  `).all(req.user.sub);

  res.json(groupByPillar(rows));
});

// GET /tracking/me/:pillar  — single pillar, optionally filtered by status
router.get('/me/:pillar', verifyJWT, (req, res) => {
  const { pillar } = req.params;
  if (!PILLARS.includes(pillar)) return res.status(400).json({ error: 'Invalid pillar' });

  const { status } = req.query;
  let rows;
  if (status && STATUSES.includes(status)) {
    rows = db.prepare(`
      SELECT * FROM tracking_items WHERE user_id = ? AND pillar = ? AND status = ?
      ORDER BY updated_at DESC
    `).all(req.user.sub, pillar, status);
  } else {
    rows = db.prepare(`
      SELECT * FROM tracking_items WHERE user_id = ? AND pillar = ?
      ORDER BY updated_at DESC
    `).all(req.user.sub, pillar);
  }

  res.json({ pillar, items: rows.map(rowToItem) });
});

// ── Public profile tracking ───────────────────────────────────────────────────
// GET /tracking/users/:userId  — public lists for another user
router.get('/users/:userId', optionalJWT, (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (!targetId) return res.status(400).json({ error: 'Invalid userId' });

  const isOwner = req.user && req.user.sub === targetId;

  // Collect which pillars are public
  const privacyRows = db.prepare(
    `SELECT pillar, is_public FROM tracking_privacy WHERE user_id = ?`
  ).all(targetId);
  const privacy = { cinema: true, music: true, fashion: true, lit: true };
  for (const r of privacyRows) privacy[r.pillar] = !!r.is_public;

  const allowedPillars = isOwner
    ? PILLARS
    : PILLARS.filter(p => privacy[p]);

  if (!allowedPillars.length) return res.json({ cinema: [], music: [], fashion: [], lit: [] });

  const placeholders = allowedPillars.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT * FROM tracking_items
    WHERE user_id = ? AND pillar IN (${placeholders}) AND (is_public = 1 OR ? = 1)
    ORDER BY is_favorite DESC, updated_at DESC
  `).all(targetId, ...allowedPillars, isOwner ? 1 : 0);

  res.json(groupByPillar(rows));
});

// ── Add Item ──────────────────────────────────────────────────────────────────
// POST /tracking
router.post('/', verifyJWT, (req, res) => {
  const { pillar, status, external_id, media_type, title, creator, year, cover_url, rating, notes, is_public } = req.body;

  if (!PILLARS.includes(pillar))   return res.status(400).json({ error: 'Invalid pillar' });
  if (!external_id || !title)      return res.status(400).json({ error: 'external_id and title required' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (rating != null && (rating < 1 || rating > 5)) return res.status(400).json({ error: 'Rating must be 1–5' });

  const effectiveStatus = status || 'want';
  const finished_at = effectiveStatus === 'done' ? new Date().toISOString() : null;

  try {
    const info = db.prepare(`
      INSERT INTO tracking_items
        (user_id, pillar, status, external_id, media_type, title, creator, year, cover_url, rating, notes, is_public, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.sub, pillar, effectiveStatus,
      String(external_id), media_type || null, title,
      creator || null, year ? parseInt(year, 10) : null,
      cover_url || null, rating ? parseInt(rating, 10) : null,
      notes || null, is_public !== false ? 1 : 0,
      finished_at
    );

    const item = db.prepare(`SELECT * FROM tracking_items WHERE id = ?`).get(info.lastInsertRowid);
    res.status(201).json(rowToItem(item));
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Already in your list' });
    }
    throw err;
  }
});

// ── Update Item ───────────────────────────────────────────────────────────────
// PATCH /tracking/:id
router.patch('/:id', verifyJWT, (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const item = db.prepare(`SELECT * FROM tracking_items WHERE id = ? AND user_id = ?`).get(id, req.user.sub);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const allowed = ['status', 'rating', 'notes', 'is_favorite', 'is_public', 'cover_url', 'review_id'];
  const updates = {};
  for (const key of allowed) {
    if (key in req.body) updates[key] = req.body[key];
  }

  if (updates.status && !STATUSES.includes(updates.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (updates.rating != null && (updates.rating < 1 || updates.rating > 5)) {
    return res.status(400).json({ error: 'Rating must be 1–5' });
  }

  // Enforce favourite cap per pillar
  if (updates.is_favorite) {
    const faveCount = db.prepare(`
      SELECT COUNT(*) as c FROM tracking_items
      WHERE user_id = ? AND pillar = ? AND is_favorite = 1 AND id != ?
    `).get(req.user.sub, item.pillar, id).c;
    if (faveCount >= MAX_FAVES) {
      return res.status(400).json({ error: `Max ${MAX_FAVES} favourites per pillar` });
    }
  }

  // Set finished_at if transitioning to done
  if (updates.status === 'done' && item.status !== 'done') {
    updates.finished_at = new Date().toISOString();
  } else if (updates.status && updates.status !== 'done') {
    updates.finished_at = null;
  }

  if (!Object.keys(updates).length) return res.json(rowToItem(item));

  updates.updated_at = new Date().toISOString();
  const cols = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(updates), id, req.user.sub];

  db.prepare(`UPDATE tracking_items SET ${cols} WHERE id = ? AND user_id = ?`).run(...vals);

  const updated = db.prepare(`SELECT * FROM tracking_items WHERE id = ?`).get(id);
  res.json(rowToItem(updated));
});

// ── Remove Item ───────────────────────────────────────────────────────────────
// DELETE /tracking/:id
router.delete('/:id', verifyJWT, (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const info = db.prepare(`DELETE FROM tracking_items WHERE id = ? AND user_id = ?`).run(id, req.user.sub);
  if (!info.changes) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

module.exports = router;
