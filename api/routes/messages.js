'use strict';

const express = require('express');
const db      = require('../db/db');
const { verifyJWT }  = require('../middleware/auth');
const { audioUpload, fileUrl } = require('../middleware/upload');
const { notify }     = require('../services/notifications');
const socket         = require('../ws/socket');
const { checkAndFlag } = require('../services/moderation');

const router = express.Router();
const MAX_GROUP_MEMBERS = 30;

function isMember(convId, userId) {
  return !!db.prepare(
    `SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`
  ).get(convId, userId);
}

function isAdmin(convId, userId) {
  return !!db.prepare(
    `SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND role = 'admin' AND left_at IS NULL`
  ).get(convId, userId);
}

function isBlocked(a, b) {
  return !!db.prepare(
    `SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?) LIMIT 1`
  ).get(a, b, b, a);
}

function formatConv(conv, userId) {
  const members = db.prepare(
    `SELECT cm.*, u.username, u.avatar_url, u.pillars
     FROM conversation_members cm JOIN users u ON cm.user_id = u.id
     WHERE cm.conversation_id = ? AND cm.left_at IS NULL`
  ).all(conv.id);

  const lastMsg = db.prepare(
    `SELECT m.*, u.username as sender_username FROM messages m JOIN users u ON m.sender_id = u.id
     WHERE m.conversation_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1`
  ).get(conv.id);

  const unread = db.prepare(
    `SELECT COUNT(*) as count FROM messages m
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
     WHERE m.conversation_id = ? AND cm.user_id = ?
       AND m.sender_id != ?
       AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
       AND m.deleted_at IS NULL`
  ).get(conv.id, userId, userId);

  return { ...conv, members, last_message: lastMsg || null, unread_count: unread.count };
}

function formatMessage(msg) {
  const sender = db.prepare(`SELECT id, username, avatar_url FROM users WHERE id = ?`).get(msg.sender_id);
  let embedded = null;
  if (msg.embedded_review_id) {
    embedded = db.prepare(
      `SELECT r.*, u.username FROM reviews r JOIN users u ON r.user_id = u.id WHERE r.id = ?`
    ).get(msg.embedded_review_id);
  }
  return { ...msg, sender, embedded_review: embedded };
}

// GET /conversations — list all conversations for current user
router.get('/', verifyJWT, (req, res) => {
  const convs = db.prepare(
    `SELECT c.* FROM conversations c
     JOIN conversation_members cm ON c.id = cm.conversation_id
     WHERE cm.user_id = ? AND cm.left_at IS NULL AND cm.is_request = 0
     ORDER BY c.last_message_at DESC, c.created_at DESC`
  ).all(req.user.sub);

  res.json({ conversations: convs.map(c => formatConv(c, req.user.sub)) });
});

// GET /conversations/requests — incoming message requests
router.get('/requests', verifyJWT, (req, res) => {
  const convs = db.prepare(
    `SELECT c.* FROM conversations c
     JOIN conversation_members cm ON c.id = cm.conversation_id
     WHERE cm.user_id = ? AND cm.is_request = 1 AND cm.left_at IS NULL
     ORDER BY c.created_at DESC`
  ).all(req.user.sub);

  res.json({ requests: convs.map(c => formatConv(c, req.user.sub)) });
});

// POST /conversations — start DM or create group
router.post('/', verifyJWT, (req, res) => {
  const { type, to_user_id, name, member_ids } = req.body;

  if (type === 'dm') {
    if (!to_user_id) return res.status(400).json({ error: 'to_user_id required for DM' });
    const target = db.prepare(`SELECT * FROM users WHERE id = ? AND is_banned = 0`).get(to_user_id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.id === req.user.sub) return res.status(400).json({ error: 'Cannot DM yourself' });
    if (isBlocked(req.user.sub, target.id)) return res.status(403).json({ error: 'Blocked' });

    // Check for existing DM
    const existing = db.prepare(
      `SELECT c.id FROM conversations c
       JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = ?
       JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id = ?
       WHERE c.type = 'dm'
       LIMIT 1`
    ).get(req.user.sub, target.id);

    if (existing) return res.json(formatConv(db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(existing.id), req.user.sub));

    // Determine if this is a request (sender doesn't follow target OR target doesn't follow sender)
    const isFollowing = !!db.prepare(
      `SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?`
    ).get(req.user.sub, target.id);
    const isRequest = !isFollowing ? 1 : 0;

    const conv = db.transaction(() => {
      const res2 = db.prepare(`INSERT INTO conversations (type, creator_id) VALUES ('dm', ?)`).run(req.user.sub);
      const convId = res2.lastInsertRowid;
      db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'admin')`).run(convId, req.user.sub);
      db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, is_request) VALUES (?, ?, ?)`).run(convId, target.id, isRequest);
      return convId;
    })();

    if (isRequest) {
      notify({ userId: target.id, type: 'message_request', actorId: req.user.sub });
    }

    return res.status(201).json(formatConv(db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conv), req.user.sub));
  }

  if (type === 'group') {
    if (!name?.trim()) return res.status(400).json({ error: 'name required for group' });
    let members = Array.isArray(member_ids) ? member_ids.map(Number).filter(Boolean) : [];
    members = [...new Set([req.user.sub, ...members])];

    if (members.length > MAX_GROUP_MEMBERS) {
      return res.status(400).json({ error: `Group max ${MAX_GROUP_MEMBERS} members` });
    }

    const convId = db.transaction(() => {
      const r = db.prepare(`INSERT INTO conversations (type, name, creator_id) VALUES ('group', ?, ?)`).run(name.trim(), req.user.sub);
      const id = r.lastInsertRowid;
      for (const uid of members) {
        const role = uid === req.user.sub ? 'admin' : 'member';
        db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)`).run(id, uid, role);
      }
      return id;
    })();

    return res.status(201).json(formatConv(db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(convId), req.user.sub));
  }

  return res.status(400).json({ error: 'type must be dm or group' });
});

// GET /conversations/:id
router.get('/:id', verifyJWT, (req, res) => {
  const conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!isMember(conv.id, req.user.sub)) return res.status(403).json({ error: 'Not a member' });
  res.json(formatConv(conv, req.user.sub));
});

// GET /conversations/:id/messages
router.get('/:id/messages', verifyJWT, (req, res) => {
  const conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!isMember(conv.id, req.user.sub)) return res.status(403).json({ error: 'Not a member' });

  const cursor = parseInt(req.query.cursor || '999999999', 10);
  const limit  = 50;

  const msgs = db.prepare(
    `SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY created_at DESC LIMIT ?`
  ).all(conv.id, cursor, limit + 1);

  let next_cursor = null;
  if (msgs.length > limit) { msgs.pop(); next_cursor = msgs[msgs.length - 1].id; }

  // Mark as read
  db.prepare(
    `UPDATE conversation_members SET last_read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ? AND user_id = ?`
  ).run(conv.id, req.user.sub);

  res.json({ messages: msgs.map(formatMessage).reverse(), next_cursor });
});

// POST /conversations/:id/messages
router.post('/:id/messages', verifyJWT, audioUpload.single('audio'), (req, res) => {
  const conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!isMember(conv.id, req.user.sub)) return res.status(403).json({ error: 'Not a member' });

  const { body_text, embedded_review_id, reply_to_id } = req.body;
  const audioUrl = req.file ? fileUrl('audio', req.file.filename) : null;

  if (!body_text?.trim() && !embedded_review_id && !audioUrl) {
    return res.status(400).json({ error: 'Message must have text, audio, or an embedded review' });
  }

  // For DMs, check block in both directions
  if (conv.type === 'dm') {
    const otherMember = db.prepare(
      `SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?`
    ).get(conv.id, req.user.sub);
    if (otherMember && isBlocked(req.user.sub, otherMember.user_id)) {
      return res.status(403).json({ error: 'Blocked' });
    }
  }

  const insertMsg = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO messages (conversation_id, sender_id, body_text, embedded_review_id, audio_url, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      conv.id, req.user.sub,
      body_text || null,
      embedded_review_id ? parseInt(embedded_review_id, 10) : null,
      audioUrl,
      reply_to_id ? parseInt(reply_to_id, 10) : null
    );
    const msgId = r.lastInsertRowid;
    db.prepare(
      `UPDATE conversations SET last_message_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(conv.id);
    db.prepare(
      `UPDATE conversation_members SET last_read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ? AND user_id = ?`
    ).run(conv.id, req.user.sub);
    checkAndFlag('message', msgId, body_text);
    return msgId;
  });

  const msgId = insertMsg();
  const msg   = formatMessage(db.prepare(`SELECT * FROM messages WHERE id = ?`).get(msgId));

  // Deliver via WebSocket to all members, send notifications to non-senders
  const members = db.prepare(
    `SELECT user_id FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL AND is_request = 0`
  ).all(conv.id);

  for (const { user_id } of members) {
    socket.send(user_id, { type: 'new_message', conversation_id: conv.id, data: msg });
    if (user_id !== req.user.sub) {
      notify({ userId: user_id, type: 'dm', actorId: req.user.sub, messageId: msgId });
    }
  }

  res.status(201).json(msg);
});

// DELETE /conversations/:id/messages/:msgId
router.delete('/:id/messages/:msgId', verifyJWT, (req, res) => {
  const msg = db.prepare(
    `SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL`
  ).get(req.params.msgId, req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.sender_id !== req.user.sub && !isAdmin(req.params.id, req.user.sub)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare(`UPDATE messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(msg.id);
  res.json({ ok: true });
});

// POST /conversations/requests/:id/accept
router.post('/requests/:id/accept', verifyJWT, (req, res) => {
  const row = db.prepare(
    `SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND is_request = 1`
  ).get(req.params.id, req.user.sub);
  if (!row) return res.status(404).json({ error: 'Request not found' });

  db.prepare(
    `UPDATE conversation_members SET is_request = 0 WHERE conversation_id = ? AND user_id = ?`
  ).run(req.params.id, req.user.sub);

  res.json({ ok: true });
});

// DELETE /conversations/requests/:id (decline)
router.delete('/requests/:id', verifyJWT, (req, res) => {
  db.prepare(
    `UPDATE conversation_members SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ? AND user_id = ? AND is_request = 1`
  ).run(req.params.id, req.user.sub);
  res.json({ ok: true });
});

// POST /conversations/:id/members — add member to group
router.post('/:id/members', verifyJWT, (req, res) => {
  const conv = db.prepare(`SELECT * FROM conversations WHERE id = ? AND type = 'group'`).get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Group not found' });
  if (!isAdmin(conv.id, req.user.sub)) return res.status(403).json({ error: 'Admin only' });

  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const count = db.prepare(
    `SELECT COUNT(*) as c FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL`
  ).get(conv.id);
  if (count.c >= MAX_GROUP_MEMBERS) {
    return res.status(400).json({ error: `Group is full (max ${MAX_GROUP_MEMBERS})` });
  }

  const user = db.prepare(`SELECT id FROM users WHERE id = ? AND is_banned = 0`).get(user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare(
    `INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`
  ).run(conv.id, user_id);

  // If they had left, clear the left_at
  db.prepare(
    `UPDATE conversation_members SET left_at = NULL WHERE conversation_id = ? AND user_id = ?`
  ).run(conv.id, user_id);

  res.json({ ok: true });
});

// DELETE /conversations/:id/members/:uid — remove member or leave
router.delete('/:id/members/:uid', verifyJWT, (req, res) => {
  const conv = db.prepare(`SELECT * FROM conversations WHERE id = ? AND type = 'group'`).get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Group not found' });

  const targetId = parseInt(req.params.uid, 10);
  if (targetId !== req.user.sub && !isAdmin(conv.id, req.user.sub)) {
    return res.status(403).json({ error: 'Admin only' });
  }

  db.prepare(
    `UPDATE conversation_members SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ? AND user_id = ?`
  ).run(conv.id, targetId);

  res.json({ ok: true });
});

// PATCH /conversations/:id/members/:uid/role — promote/demote
router.patch('/:id/members/:uid/role', verifyJWT, (req, res) => {
  const conv = db.prepare(`SELECT * FROM conversations WHERE id = ? AND type = 'group'`).get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Group not found' });
  if (!isAdmin(conv.id, req.user.sub)) return res.status(403).json({ error: 'Admin only' });

  const { role } = req.body;
  if (!['member','admin'].includes(role)) return res.status(400).json({ error: 'role must be member or admin' });

  db.prepare(
    `UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?`
  ).run(role, conv.id, req.params.uid);

  res.json({ ok: true });
});

// PATCH /conversations/:id — update group name/avatar
router.patch('/:id', verifyJWT, (req, res) => {
  const conv = db.prepare(`SELECT * FROM conversations WHERE id = ? AND type = 'group'`).get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Group not found' });
  if (!isAdmin(conv.id, req.user.sub)) return res.status(403).json({ error: 'Admin only' });

  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });

  db.prepare(
    `UPDATE conversations SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).run(name.trim(), conv.id);

  res.json(formatConv(db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conv.id), req.user.sub));
});

module.exports = router;
