'use strict';

const express  = require('express');
const db       = require('../db/db');
const { verifyJWT, optionalJWT } = require('../middleware/auth');
const { avatarUpload, fileUrl }  = require('../middleware/upload');
const { notify } = require('../services/notifications');

const router = express.Router();

function publicUser(u, viewerId) {
  const pillars = JSON.parse(u.pillars || '[]');
  const base = {
    id: u.id, username: u.username, bio: u.bio,
    avatar_url: u.avatar_url, pillars,
    follower_count: u.follower_count, following_count: u.following_count,
    review_count: u.review_count, insight_score: u.insight_score,
    is_verified: !!u.is_verified, role: u.role, created_at: u.created_at,
  };
  if (viewerId && viewerId !== u.id) {
    base.is_following = !!db.prepare(
      `SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?`
    ).get(viewerId, u.id);
    base.is_subscribed = !!db.prepare(
      `SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND creator_id = ?`
    ).get(viewerId, u.id);
    base.is_blocked = !!db.prepare(
      `SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?`
    ).get(viewerId, u.id);
    base.follows_you = !!db.prepare(
      `SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?`
    ).get(u.id, viewerId);
  }
  return base;
}

function isBlocked(viewerId, targetId) {
  return !!db.prepare(
    `SELECT 1 FROM blocks
     WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
     LIMIT 1`
  ).get(viewerId, targetId, targetId, viewerId);
}

// GET /users/me
router.get('/me', verifyJWT, (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(user, req.user.sub));
});

// PATCH /users/me
router.patch('/me', verifyJWT, avatarUpload.single('avatar'), async (req, res) => {
  const { username, bio, pillars } = req.body;
  const userId = req.user.sub;

  const updates = [];
  const params  = [];

  if (username !== undefined) {
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    const taken = db.prepare(
      `SELECT id FROM users WHERE username = ? AND id != ?`
    ).get(username, userId);
    if (taken) return res.status(409).json({ error: 'Username already taken' });
    updates.push('username = ?'); params.push(username);
  }

  if (bio !== undefined) {
    if (bio.length > 160) return res.status(400).json({ error: 'Bio max 160 characters' });
    updates.push('bio = ?'); params.push(bio);
  }

  if (pillars !== undefined) {
    let parsed;
    try {
      parsed = typeof pillars === 'string' ? JSON.parse(pillars) : pillars;
      const valid = new Set(['cinema','music','fashion','lit']);
      if (!Array.isArray(parsed) || !parsed.length || !parsed.every(p => valid.has(p))) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Invalid pillars' });
    }
    updates.push('pillars = ?'); params.push(JSON.stringify(parsed));
  }

  if (req.file) {
    updates.push('avatar_url = ?'); params.push(fileUrl('avatars', req.file.filename));
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  params.push(userId);

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  res.json(publicUser(user, userId));
});

// GET /users/search?q=
router.get('/search', optionalJWT, (req, res) => {
  const q      = (req.query.q || '').trim();
  const cursor = parseInt(req.query.cursor || '0', 10);
  const limit  = 20;
  if (!q) return res.status(400).json({ error: 'q is required' });

  const viewerId = req.user?.sub;
  const rows = db.prepare(
    `SELECT * FROM users
     WHERE (username LIKE ? OR bio LIKE ?) AND is_banned = 0 AND id > ?
     ORDER BY follower_count DESC, id ASC LIMIT ?`
  ).all(`%${q}%`, `%${q}%`, cursor, limit + 1);

  let next_cursor = null;
  if (rows.length > limit) { rows.pop(); next_cursor = rows[rows.length - 1].id; }

  const filtered = viewerId
    ? rows.filter(u => !isBlocked(viewerId, u.id))
    : rows;

  res.json({ users: filtered.map(u => publicUser(u, viewerId)), next_cursor });
});

// GET /users/:username
router.get('/:username', optionalJWT, (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE username = ? AND is_banned = 0`).get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const viewerId = req.user?.sub;
  if (viewerId && isBlocked(viewerId, user.id)) return res.status(404).json({ error: 'User not found' });

  res.json(publicUser(user, viewerId));
});

// GET /users/:username/reviews
router.get('/:username/reviews', optionalJWT, (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const viewerId = req.user?.sub;
  if (viewerId && isBlocked(viewerId, user.id)) return res.status(404).json({ error: 'User not found' });

  const cursor = parseInt(req.query.cursor || '0', 10);
  const limit  = 20;
  const rows   = db.prepare(
    `SELECT r.*, u.username, u.avatar_url, u.pillars as user_pillars
     FROM reviews r JOIN users u ON r.user_id = u.id
     WHERE r.user_id = ? AND r.is_draft = 0 AND r.deleted_at IS NULL AND r.id > ?
     ORDER BY r.created_at DESC LIMIT ?`
  ).all(user.id, cursor, limit + 1);

  let next_cursor = null;
  if (rows.length > limit) { rows.pop(); next_cursor = rows[rows.length - 1].id; }

  res.json({ reviews: rows, next_cursor });
});

// GET /users/:username/followers
router.get('/:username/followers', optionalJWT, (req, res) => {
  const user = db.prepare(`SELECT id FROM users WHERE username = ?`).get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const cursor   = parseInt(req.query.cursor || '0', 10);
  const limit    = 20;
  const viewerId = req.user?.sub;

  const rows = db.prepare(
    `SELECT u.* FROM follows f JOIN users u ON f.follower_id = u.id
     WHERE f.following_id = ? AND f.id > ?
     ORDER BY f.created_at DESC LIMIT ?`
  ).all(user.id, cursor, limit + 1);

  let next_cursor = null;
  if (rows.length > limit) { rows.pop(); next_cursor = rows[rows.length - 1].id; }

  res.json({ followers: rows.map(u => publicUser(u, viewerId)), next_cursor });
});

// GET /users/:username/following
router.get('/:username/following', optionalJWT, (req, res) => {
  const user = db.prepare(`SELECT id FROM users WHERE username = ?`).get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const cursor   = parseInt(req.query.cursor || '0', 10);
  const limit    = 20;
  const viewerId = req.user?.sub;

  const rows = db.prepare(
    `SELECT u.* FROM follows f JOIN users u ON f.following_id = u.id
     WHERE f.follower_id = ? AND f.id > ?
     ORDER BY f.created_at DESC LIMIT ?`
  ).all(user.id, cursor, limit + 1);

  let next_cursor = null;
  if (rows.length > limit) { rows.pop(); next_cursor = rows[rows.length - 1].id; }

  res.json({ following: rows.map(u => publicUser(u, viewerId)), next_cursor });
});

// POST /users/:username/follow
router.post('/:username/follow', verifyJWT, (req, res) => {
  const target = db.prepare(`SELECT * FROM users WHERE username = ? AND is_banned = 0`).get(req.params.username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.sub) return res.status(400).json({ error: 'Cannot follow yourself' });

  if (isBlocked(req.user.sub, target.id)) return res.status(403).json({ error: 'Blocked' });

  const alreadyFollowing = db.prepare(
    `SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?`
  ).get(req.user.sub, target.id);

  if (!alreadyFollowing) {
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)`).run(req.user.sub, target.id);
      db.prepare(`UPDATE users SET follower_count  = follower_count  + 1 WHERE id = ?`).run(target.id);
      db.prepare(`UPDATE users SET following_count = following_count + 1 WHERE id = ?`).run(req.user.sub);
    })();
    notify({ userId: target.id, type: 'follow', actorId: req.user.sub });
  }

  res.json({ ok: true, following: true });
});

// DELETE /users/:username/follow
router.delete('/:username/follow', verifyJWT, (req, res) => {
  const target = db.prepare(`SELECT id FROM users WHERE username = ?`).get(req.params.username);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const existed = db.prepare(
    `SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?`
  ).get(req.user.sub, target.id);

  if (existed) {
    db.transaction(() => {
      db.prepare(`DELETE FROM follows WHERE follower_id = ? AND following_id = ?`).run(req.user.sub, target.id);
      db.prepare(`UPDATE users SET follower_count  = MAX(0, follower_count  - 1) WHERE id = ?`).run(target.id);
      db.prepare(`UPDATE users SET following_count = MAX(0, following_count - 1) WHERE id = ?`).run(req.user.sub);
      // Also remove subscription if it exists
      db.prepare(`DELETE FROM subscriptions WHERE subscriber_id = ? AND creator_id = ?`).run(req.user.sub, target.id);
    })();
  }

  res.json({ ok: true, following: false });
});

// POST /users/:username/subscribe
router.post('/:username/subscribe', verifyJWT, (req, res) => {
  const target = db.prepare(`SELECT id FROM users WHERE username = ? AND is_banned = 0`).get(req.params.username);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Must be following to subscribe
  const following = db.prepare(
    `SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?`
  ).get(req.user.sub, target.id);
  if (!following) return res.status(400).json({ error: 'You must follow this user before subscribing' });

  db.prepare(`INSERT OR IGNORE INTO subscriptions (subscriber_id, creator_id) VALUES (?, ?)`).run(req.user.sub, target.id);
  res.json({ ok: true, subscribed: true });
});

// DELETE /users/:username/subscribe
router.delete('/:username/subscribe', verifyJWT, (req, res) => {
  const target = db.prepare(`SELECT id FROM users WHERE username = ?`).get(req.params.username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare(`DELETE FROM subscriptions WHERE subscriber_id = ? AND creator_id = ?`).run(req.user.sub, target.id);
  res.json({ ok: true, subscribed: false });
});

// POST /users/:username/block
router.post('/:username/block', verifyJWT, (req, res) => {
  const target = db.prepare(`SELECT id FROM users WHERE username = ?`).get(req.params.username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.sub) return res.status(400).json({ error: 'Cannot block yourself' });

  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)`).run(req.user.sub, target.id);
    // Remove follows in both directions
    db.prepare(`DELETE FROM follows WHERE (follower_id = ? AND following_id = ?) OR (follower_id = ? AND following_id = ?)`).run(req.user.sub, target.id, target.id, req.user.sub);
    db.prepare(`DELETE FROM subscriptions WHERE (subscriber_id = ? AND creator_id = ?) OR (subscriber_id = ? AND creator_id = ?)`).run(req.user.sub, target.id, target.id, req.user.sub);
  })();

  res.json({ ok: true, blocked: true });
});

// DELETE /users/:username/block
router.delete('/:username/block', verifyJWT, (req, res) => {
  const target = db.prepare(`SELECT id FROM users WHERE username = ?`).get(req.params.username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare(`DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?`).run(req.user.sub, target.id);
  res.json({ ok: true, blocked: false });
});

// GET /users/me/blocks
router.get('/me/blocks', verifyJWT, (req, res) => {
  const rows = db.prepare(
    `SELECT u.* FROM blocks b JOIN users u ON b.blocked_id = u.id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`
  ).all(req.user.sub);
  res.json({ blocked: rows.map(u => publicUser(u, req.user.sub)) });
});

module.exports = router;
