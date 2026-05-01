'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { verifyAccess } = require('../services/jwt');

// userId (number) → Set<WebSocket>
const registry = new Map();

function register(userId, ws) {
  if (!registry.has(userId)) registry.set(userId, new Set());
  registry.get(userId).add(ws);
}

function unregister(userId, ws) {
  const set = registry.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) registry.delete(userId);
}

/**
 * Send a message to all active connections for a user.
 */
function send(userId, data) {
  const set = registry.get(userId);
  if (!set || !set.size) return;
  const payload = JSON.stringify(data);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/**
 * Attach the WebSocket server to an existing http.Server.
 */
function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // Authenticate via ?token= query param
    const url    = new URL(req.url, 'http://localhost');
    const token  = url.searchParams.get('token');
    let userId   = null;

    try {
      const payload = verifyAccess(token);
      userId = payload.sub;
    } catch {
      ws.close(4001, 'Unauthorized');
      return;
    }

    register(userId, ws);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    });

    ws.on('close', () => unregister(userId, ws));
    ws.on('error', () => unregister(userId, ws));

    ws.send(JSON.stringify({ type: 'connected', userId }));
  });

  return wss;
}

module.exports = { attach, send, registry };
