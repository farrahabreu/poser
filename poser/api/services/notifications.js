'use strict';

const db      = require('../db/db');
const webpush = require('./webpush');

// Lazy-loaded to avoid circular dependency with ws/socket.js
let socketModule = null;
function getSocket() {
  if (!socketModule) socketModule = require('../ws/socket');
  return socketModule;
}

const NOTIFICATION_COPY = {
  follow:            (actor) => `@${actor} followed you`,
  like:              (actor) => `@${actor} liked your review`,
  comment:           (actor) => `@${actor} commented on your review`,
  comment_like:      (actor) => `@${actor} liked your comment`,
  repost:            (actor) => `@${actor} reposted your review`,
  dm:                (actor) => `@${actor} sent you a message`,
  subscription_post: (actor) => `@${actor} posted a new review`,
  mention:           (actor) => `@${actor} mentioned you`,
  message_request:   (actor) => `@${actor} wants to message you`,
};

/**
 * Create a notification and attempt real-time + push delivery.
 * Safe to call outside transactions — uses its own write.
 */
async function notify({ userId, type, actorId, reviewId, commentId, messageId }) {
  if (userId === actorId) return; // don't notify yourself

  // Check block in both directions
  const blocked = db.prepare(
    `SELECT 1 FROM blocks
     WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
     LIMIT 1`
  ).get(userId, actorId, actorId, userId);
  if (blocked) return;

  const actor = actorId
    ? db.prepare(`SELECT username FROM users WHERE id = ?`).get(actorId)
    : null;
  const body = actor ? (NOTIFICATION_COPY[type]?.(actor.username) || type) : type;

  const result = db.prepare(
    `INSERT INTO notifications (user_id, type, actor_id, review_id, comment_id, message_id, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, type, actorId || null, reviewId || null, commentId || null, messageId || null, body);

  const notifId = result.lastInsertRowid;

  const notifObj = {
    id: notifId, type, actorId, reviewId, commentId, messageId, body,
    read: 0, created_at: new Date().toISOString(),
  };

  // Real-time via WebSocket
  const socket = getSocket();
  socket.send(userId, { type: 'notification', data: notifObj });

  // Push notification (async, non-blocking)
  const recipient = db.prepare(
    `SELECT push_endpoint, push_p256dh, push_auth FROM users WHERE id = ? AND push_endpoint IS NOT NULL`
  ).get(userId);

  if (recipient?.push_endpoint) {
    webpush.sendPush(
      {
        endpoint: recipient.push_endpoint,
        keys: { p256dh: recipient.push_p256dh, auth: recipient.push_auth },
      },
      { title: 'POSER', body }
    ).then(() => {
      db.prepare(`UPDATE notifications SET push_sent = 1 WHERE id = ?`).run(notifId);
    }).catch(() => {});
  }
}

/**
 * Fan out a subscription_post notification to all subscribers of a creator.
 * Runs notification inserts in a transaction for performance, then sends
 * WebSocket + push outside the transaction.
 */
async function notifySubscribers(creatorId, reviewId) {
  const creator = db.prepare(`SELECT username FROM users WHERE id = ?`).get(creatorId);
  if (!creator) return;

  const subscribers = db.prepare(
    `SELECT subscriber_id FROM subscriptions WHERE creator_id = ?`
  ).all(creatorId);

  if (!subscribers.length) return;

  const body = `@${creator.username} posted a new review`;

  const insertNotif = db.prepare(
    `INSERT INTO notifications (user_id, type, actor_id, review_id, body)
     VALUES (?, 'subscription_post', ?, ?, ?)`
  );

  const insertMany = db.transaction((rows) => {
    for (const { subscriber_id } of rows) {
      if (subscriber_id === creatorId) continue;
      insertNotif.run(subscriber_id, creatorId, reviewId, body);
    }
  });

  insertMany(subscribers);

  // Async push delivery — run outside transaction
  const socket = getSocket();
  setImmediate(async () => {
    for (const { subscriber_id } of subscribers) {
      if (subscriber_id === creatorId) continue;

      socket.send(subscriber_id, {
        type: 'notification',
        data: { type: 'subscription_post', actorId: creatorId, reviewId, body },
      });

      const recipient = db.prepare(
        `SELECT push_endpoint, push_p256dh, push_auth FROM users WHERE id = ? AND push_endpoint IS NOT NULL`
      ).get(subscriber_id);

      if (recipient?.push_endpoint) {
        await webpush.sendPush(
          {
            endpoint: recipient.push_endpoint,
            keys: { p256dh: recipient.push_p256dh, auth: recipient.push_auth },
          },
          { title: 'POSER', body }
        ).catch(() => {});
      }
    }
  });
}

module.exports = { notify, notifySubscribers };
