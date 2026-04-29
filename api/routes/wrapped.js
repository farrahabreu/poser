'use strict';

/**
 * Wrapped routes
 *
 * POST /wrapped/generate          — (re-)generate wrapped for caller (or admin for any user)
 * GET  /wrapped/me                — my latest wrapped (current or previous year)
 * GET  /wrapped/me/:year          — my wrapped for a specific year
 * GET  /wrapped/users/:userId/:year — another user's public wrapped
 * PATCH /wrapped/:year/privacy    — toggle public/private
 *
 * Wrapped payload shape stored in wrapped_snapshots.data:
 * {
 *   year, generated_at,
 *   totals:  { reviews, tracking_done, tracking_current, tracking_want, comments }
 *   pillar_breakdown: { cinema: N, music: N, fashion: N, lit: N }  (% of total reviews)
 *   top: {
 *     cinema:  [{ title, creator, year, cover_url, rating, review_count }]  top 5
 *     music:   [...]
 *     fashion: [...]
 *     lit:     [...]
 *     creators:[{ name, pillar, count }]  top 5 creators engaged with
 *   }
 *   non_reader: boolean
 *   recommendations: [...] (only present when non_reader=true)
 * }
 */

const express  = require('express');
const db       = require('../db/db');
const { verifyJWT, optionalJWT, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Aggregation logic ─────────────────────────────────────────────────────────

function computeWrapped(userId, year) {
  const startISO = `${year}-01-01T00:00:00.000Z`;
  const endISO   = `${year}-12-31T23:59:59.999Z`;

  // Total reviews published this year
  const reviews = db.prepare(`
    SELECT COUNT(*) as c FROM reviews
    WHERE user_id = ? AND is_draft = 0 AND deleted_at IS NULL
      AND created_at >= ? AND created_at <= ?
  `).get(userId, startISO, endISO).c;

  // Total comments this year
  const comments = db.prepare(`
    SELECT COUNT(*) as c FROM comments
    WHERE user_id = ? AND deleted_at IS NULL
      AND created_at >= ? AND created_at <= ?
  `).get(userId, startISO, endISO).c;

  // Tracking stats (logged/finished this year)
  const trackingDone = db.prepare(`
    SELECT COUNT(*) as c FROM tracking_items
    WHERE user_id = ? AND status = 'done' AND finished_at >= ? AND finished_at <= ?
  `).get(userId, startISO, endISO).c;

  const trackingCurrent = db.prepare(`
    SELECT COUNT(*) as c FROM tracking_items
    WHERE user_id = ? AND status = 'current'
      AND updated_at >= ? AND updated_at <= ?
  `).get(userId, startISO, endISO).c;

  const trackingWant = db.prepare(`
    SELECT COUNT(*) as c FROM tracking_items
    WHERE user_id = ? AND status = 'want'
      AND created_at >= ? AND created_at <= ?
  `).get(userId, startISO, endISO).c;

  // Pillar breakdown (review counts per pillar)
  const pillarRows = db.prepare(`
    SELECT pillar, COUNT(*) as c FROM reviews
    WHERE user_id = ? AND is_draft = 0 AND deleted_at IS NULL
      AND created_at >= ? AND created_at <= ?
    GROUP BY pillar
  `).all(userId, startISO, endISO);

  const pillar_breakdown = { cinema: 0, music: 0, fashion: 0, lit: 0 };
  for (const r of pillarRows) pillar_breakdown[r.pillar] = r.c;

  // Top 5 per pillar — items tracked as "done" this year, sorted by rating desc
  function topItems(pillar) {
    return db.prepare(`
      SELECT title, creator, year, cover_url, rating,
             (SELECT COUNT(*) FROM reviews r
              WHERE r.user_id = ? AND r.pillar = ?
                AND r.subject_title = ti.title
                AND r.deleted_at IS NULL) AS review_count
      FROM tracking_items ti
      WHERE ti.user_id = ? AND ti.pillar = ? AND ti.status = 'done'
        AND ti.finished_at >= ? AND ti.finished_at <= ?
      ORDER BY COALESCE(rating, 0) DESC, finished_at DESC
      LIMIT 5
    `).all(userId, pillar, userId, pillar, startISO, endISO);
  }

  // Top 5 creators — most reviewed/tracked creators across all pillars
  const topCreators = db.prepare(`
    SELECT subject_creator as name, pillar, COUNT(*) as count
    FROM reviews
    WHERE user_id = ? AND is_draft = 0 AND deleted_at IS NULL
      AND subject_creator IS NOT NULL AND subject_creator != ''
      AND created_at >= ? AND created_at <= ?
    GROUP BY subject_creator, pillar
    ORDER BY count DESC
    LIMIT 5
  `).all(userId, startISO, endISO);

  // Non-reader variant
  const litCount = pillar_breakdown.lit + (topItems('lit').length);
  const non_reader = litCount === 0;

  // Simple cross-pillar recommendations when non-reader (pull from OpenLibrary isn't
  // practical server-side in aggregate; we surface the user's highest-rated cinema/music
  // creators and recommend titles by them as placeholders; the client may fetch OL search)
  let recommendations = [];
  if (non_reader) {
    const topCreator = db.prepare(`
      SELECT subject_creator as name FROM reviews
      WHERE user_id = ? AND is_draft = 0 AND deleted_at IS NULL
        AND subject_creator IS NOT NULL
        AND created_at >= ? AND created_at <= ?
      GROUP BY subject_creator
      ORDER BY COUNT(*) DESC
      LIMIT 3
    `).all(userId, startISO, endISO);
    recommendations = topCreator.map(r => ({ search_hint: r.name, pillar: 'lit' }));
  }

  return {
    year,
    generated_at: new Date().toISOString(),
    totals: { reviews, comments, tracking_done: trackingDone, tracking_current: trackingCurrent, tracking_want: trackingWant },
    pillar_breakdown,
    top: {
      cinema:   topItems('cinema'),
      music:    topItems('music'),
      fashion:  topItems('fashion'),
      lit:      topItems('lit'),
      creators: topCreators,
    },
    non_reader,
    recommendations,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /wrapped/generate  — generate or regenerate for the current calendar year
router.post('/generate', verifyJWT, (req, res) => {
  // Admins may pass ?userId=X to generate for another user
  const targetId = (req.user.role === 'admin' && req.query.userId)
    ? parseInt(req.query.userId, 10)
    : req.user.sub;

  const year = parseInt(req.query.year || new Date().getFullYear(), 10);

  const data = computeWrapped(targetId, year);

  db.prepare(`
    INSERT INTO wrapped_snapshots (user_id, year, data, generated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, year) DO UPDATE SET
      data         = excluded.data,
      generated_at = excluded.generated_at
  `).run(targetId, year, JSON.stringify(data), data.generated_at);

  res.json({ ok: true, year, data });
});

// GET /wrapped/me  — latest snapshot (most recent year)
router.get('/me', verifyJWT, (req, res) => {
  const row = db.prepare(`
    SELECT * FROM wrapped_snapshots WHERE user_id = ? ORDER BY year DESC LIMIT 1
  `).get(req.user.sub);

  if (!row) return res.status(404).json({ error: 'No Wrapped generated yet' });
  res.json({ year: row.year, is_public: !!row.is_public, data: JSON.parse(row.data), generated_at: row.generated_at });
});

// GET /wrapped/me/:year
router.get('/me/:year', verifyJWT, (req, res) => {
  const year = parseInt(req.params.year, 10);
  const row  = db.prepare(`SELECT * FROM wrapped_snapshots WHERE user_id = ? AND year = ?`).get(req.user.sub, year);
  if (!row) return res.status(404).json({ error: 'No Wrapped for that year' });
  res.json({ year: row.year, is_public: !!row.is_public, data: JSON.parse(row.data), generated_at: row.generated_at });
});

// GET /wrapped/users/:userId/:year  — another user's public wrapped
router.get('/users/:userId/:year', optionalJWT, (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  const year     = parseInt(req.params.year, 10);
  const isOwner  = req.user && req.user.sub === targetId;

  const row = db.prepare(`SELECT * FROM wrapped_snapshots WHERE user_id = ? AND year = ?`).get(targetId, year);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!row.is_public && !isOwner) return res.status(403).json({ error: 'Private' });

  res.json({ year: row.year, is_public: !!row.is_public, data: JSON.parse(row.data), generated_at: row.generated_at });
});

// PATCH /wrapped/:year/privacy
router.patch('/:year/privacy', verifyJWT, (req, res) => {
  const year = parseInt(req.params.year, 10);
  const { is_public } = req.body;
  if (typeof is_public !== 'boolean') return res.status(400).json({ error: 'is_public must be boolean' });

  const info = db.prepare(`
    UPDATE wrapped_snapshots SET is_public = ? WHERE user_id = ? AND year = ?
  `).run(is_public ? 1 : 0, req.user.sub, year);

  if (!info.changes) return res.status(404).json({ error: 'No Wrapped for that year' });
  res.json({ ok: true, year, is_public });
});

module.exports = router;
