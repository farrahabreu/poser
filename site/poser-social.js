/* poser-social.js — POSER Social & Engagement Layer
 * Self-contained IIFE. Attaches to window.PoserSocial (alias window.PS).
 * Requires window.POSER_API_URL to be set before this script loads.
 */
(function (window) {
  'use strict';

  const API_BASE = window.POSER_API_URL || 'http://localhost:3001/api/v1';
  const WS_BASE  = API_BASE.replace(/^http/, 'ws').replace('/api/v1', '') + '/ws';

  // ─────────────────────────────────────────────────────────────────────────
  // Token management (access token in memory only; refresh token is httpOnly cookie)
  // ─────────────────────────────────────────────────────────────────────────
  const Auth = (() => {
    let _accessToken = null;
    let _refreshPromise = null;

    function getToken()          { return _accessToken; }
    function setToken(t)         { _accessToken = t; }
    function clearToken()        { _accessToken = null; }

    async function refreshToken() {
      if (_refreshPromise) return _refreshPromise;
      _refreshPromise = fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST', credentials: 'include',
      }).then(async r => {
        if (!r.ok) { clearToken(); return null; }
        const d = await r.json();
        setToken(d.access_token);
        return d;
      }).finally(() => { _refreshPromise = null; });
      return _refreshPromise;
    }

    async function authedFetch(url, opts = {}) {
      if (!_accessToken) {
        const d = await refreshToken();
        if (!d) throw Object.assign(new Error('Unauthenticated'), { status: 401 });
      }
      opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${_accessToken}` };
      opts.credentials = 'include';
      let res = await fetch(url, opts);
      if (res.status === 401) {
        const d = await refreshToken();
        if (!d) throw Object.assign(new Error('Session expired'), { status: 401 });
        opts.headers.Authorization = `Bearer ${_accessToken}`;
        res = await fetch(url, opts);
      }
      return res;
    }

    // Attempt to restore session from cookie on page load
    async function restoreSession() {
      try {
        const d = await refreshToken();
        if (!d) return null;
        const res = await authedFetch(`${API_BASE}/users/me`);
        if (!res.ok) return null;
        const user = await res.json();
        return user;
      } catch { return null; }
    }

    async function register(email) {
      const res = await fetch(`${API_BASE}/auth/register/init`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      return data;
    }

    async function verifyOTP(email, code) {
      const res = await fetch(`${API_BASE}/auth/register/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');
      return data; // { temp_token }
    }

    async function completeRegistration({ email, username, password, bio, pillars, photoDataUrl }) {
      const tempToken = window._poserTempToken;
      if (!tempToken) throw new Error('No temp token');

      const fd = new FormData();
      fd.append('username', username);
      fd.append('password', password);
      fd.append('bio', bio || '');
      fd.append('pillars', JSON.stringify(pillars || []));

      if (photoDataUrl && photoDataUrl.startsWith('data:')) {
        const blob = dataURLtoBlob(photoDataUrl);
        fd.append('avatar', blob, 'avatar.jpg');
      }

      const res = await fetch(`${API_BASE}/auth/register/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tempToken}` },
        credentials: 'include',
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');
      setToken(data.access_token);
      window._poserTempToken = null;
      return data.user;
    }

    async function login(identifier, password) {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ identifier, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      setToken(data.access_token);
      return data.user;
    }

    async function logout() {
      try {
        await authedFetch(`${API_BASE}/auth/logout`, { method: 'POST' });
      } catch {}
      clearToken();
    }

    async function checkUsername(u) {
      const res = await fetch(`${API_BASE}/auth/username/check?u=${encodeURIComponent(u)}`);
      const d   = await res.json();
      return d.available;
    }

    async function googleAuth(credential) {
      const res = await fetch(`${API_BASE}/auth/google`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ credential }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Google sign-in failed');
      if (!data.is_new) setToken(data.access_token);
      return data; // { is_new, temp_token?, email?, name?, picture?, access_token?, user? }
    }

    async function phoneInit(phone) {
      const res = await fetch(`${API_BASE}/auth/phone/init`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send code');
      return data;
    }

    async function phoneVerify(phone, code) {
      const res = await fetch(`${API_BASE}/auth/phone/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');
      return data; // { temp_token }
    }

    async function guestAuth() {
      const res = await fetch(`${API_BASE}/auth/guest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Guest signup failed');
      setToken(data.access_token);
      return data; // { ok, access_token, user }
    }

    async function simpleRegister({ username, password, bio, pillars, photoDataUrl }) {
      const fd = new FormData();
      fd.append('username', username);
      fd.append('password', password);
      fd.append('bio', bio || '');
      fd.append('pillars', JSON.stringify(pillars || []));
      if (photoDataUrl && photoDataUrl.startsWith('data:')) {
        const blob = dataURLtoBlob(photoDataUrl);
        fd.append('avatar', blob, 'avatar.jpg');
      }
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');
      setToken(data.access_token);
      return data.user;
    }

    return { getToken, setToken, clearToken, refreshToken, authedFetch, restoreSession,
             register, verifyOTP, completeRegistration, login, logout, checkUsername,
             googleAuth, phoneInit, phoneVerify, guestAuth, simpleRegister };
  })();

  // ─────────────────────────────────────────────────────────────────────────
  // API client helpers
  // ─────────────────────────────────────────────────────────────────────────
  const api = {
    async get(path, params) {
      const url = params
        ? `${API_BASE}${path}?${new URLSearchParams(params)}`
        : `${API_BASE}${path}`;
      const res = await Auth.authedFetch(url);
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Request failed'); }
      return res.json();
    },
    async getPublic(path, params) {
      const url = params
        ? `${API_BASE}${path}?${new URLSearchParams(params)}`
        : `${API_BASE}${path}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Request failed'); }
      return res.json();
    },
    async post(path, body) {
      const res = await Auth.authedFetch(`${API_BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Request failed'); }
      return res.json();
    },
    async patch(path, body) {
      const res = await Auth.authedFetch(`${API_BASE}${path}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Request failed'); }
      return res.json();
    },
    async del(path) {
      const res = await Auth.authedFetch(`${API_BASE}${path}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Request failed'); }
      return res.json();
    },
    async postForm(path, formData, extraHeaders) {
      const res = await Auth.authedFetch(`${API_BASE}${path}`, {
        method: 'POST', headers: extraHeaders || {},
        body: formData,
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Request failed'); }
      return res.json();
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Social Graph
  // ─────────────────────────────────────────────────────────────────────────
  const SocialGraph = {
    async follow(username)   { return api.post(`/users/${username}/follow`, {}); },
    async unfollow(username) { return api.del(`/users/${username}/follow`); },
    async subscribe(username)   { return api.post(`/users/${username}/subscribe`, {}); },
    async unsubscribe(username) { return api.del(`/users/${username}/subscribe`); },
    async block(username)   { return api.post(`/users/${username}/block`, {}); },
    async unblock(username) { return api.del(`/users/${username}/block`); },
    async getProfile(username) { return api.getPublic(`/users/${username}`); },
    async getFollowers(username, cursor) {
      return api.getPublic(`/users/${username}/followers`, cursor ? { cursor } : {});
    },
    async getFollowing(username, cursor) {
      return api.getPublic(`/users/${username}/following`, cursor ? { cursor } : {});
    },
    async search(q, cursor) {
      return api.getPublic(`/users/search`, { q, ...(cursor ? { cursor } : {}) });
    },
    async getBlocked() { return api.get('/users/me/blocks'); },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Feed
  // ─────────────────────────────────────────────────────────────────────────
  const Feed = {
    async load({ feed = 'discover', pillars = [], cursor } = {}) {
      const params = { feed };
      if (pillars.length) params.pillars = pillars.join(',');
      if (cursor) params.cursor = cursor;
      try {
        return api.getPublic('/reviews', params);
      } catch {
        return { reviews: [], next_cursor: null };
      }
    },
    async getDrafts() { return api.get('/reviews/me/drafts'); },
    async getSaves(cursor) {
      return api.get('/reviews/me/saves', cursor ? { cursor } : {});
    },
    async getReposts(cursor) {
      return api.get('/reviews/me/reposts', cursor ? { cursor } : {});
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Engagement
  // ─────────────────────────────────────────────────────────────────────────
  const Engagement = {
    async like(reviewId) {
      const d = await api.post(`/reviews/${reviewId}/like`, {});
      _patchReviewCount(reviewId, 'like_count', d.like_count);
      return d;
    },
    async unlike(reviewId) {
      const d = await api.del(`/reviews/${reviewId}/like`);
      _patchReviewCount(reviewId, 'like_count', d.like_count);
      return d;
    },
    async repost(reviewId, quoteText) {
      return api.post(`/reviews/${reviewId}/repost`, { quote_text: quoteText || undefined });
    },
    async unrepost(reviewId) { return api.del(`/reviews/${reviewId}/repost`); },
    async save(reviewId)     { return api.post(`/reviews/${reviewId}/save`, {}); },
    async unsave(reviewId)   { return api.del(`/reviews/${reviewId}/save`); },
    async share(reviewId) {
      const d = await api.getPublic(`/reviews/${reviewId}/share`);
      try { await navigator.clipboard.writeText(d.url); } catch {}
      UI.toast('Link copied to clipboard');
      return d.url;
    },
    async createReview(data) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(data)) {
        if (v != null) fd.append(k, v instanceof Blob ? v : String(v));
      }
      return api.postForm('/reviews', fd);
    },
    async deleteReview(reviewId) { return api.del(`/reviews/${reviewId}`); },
  };

  function _patchReviewCount(reviewId, key, value) {
    document.querySelectorAll(`[data-review-id="${reviewId}"] [data-count="${key}"]`).forEach(el => {
      el.textContent = value;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Comments
  // ─────────────────────────────────────────────────────────────────────────
  const Comments = {
    async load(reviewId) {
      return api.getPublic(`/reviews/${reviewId}/comments`);
    },
    async post(reviewId, { text, audioBlob, timestampSec, audioDurationSec } = {}) {
      const fd = new FormData();
      if (text) fd.append('body_text', text);
      if (audioBlob) fd.append('audio', audioBlob, 'comment.webm');
      if (timestampSec != null) fd.append('timestamp_sec', String(timestampSec));
      if (audioDurationSec) fd.append('audio_duration_sec', String(audioDurationSec));
      return api.postForm(`/reviews/${reviewId}/comments`, fd);
    },
    async reply(reviewId, commentId, { text, audioBlob, audioDurationSec } = {}) {
      const fd = new FormData();
      if (text) fd.append('body_text', text);
      if (audioBlob) fd.append('audio', audioBlob, 'reply.webm');
      if (audioDurationSec) fd.append('audio_duration_sec', String(audioDurationSec));
      return api.postForm(`/reviews/${reviewId}/comments/${commentId}/reply`, fd);
    },
    async delete(reviewId, commentId) {
      return api.del(`/reviews/${reviewId}/comments/${commentId}/delete`);
    },
    async like(reviewId, commentId) {
      return api.post(`/reviews/${reviewId}/comments/${commentId}/like`, {});
    },
    async unlike(reviewId, commentId) {
      return api.del(`/reviews/${reviewId}/comments/${commentId}/like`);
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Notifications
  // ─────────────────────────────────────────────────────────────────────────
  const Notifications = {
    _unread: 0,

    async getUnreadCount() {
      try {
        const d = await api.get('/notifications/unread-count');
        this._unread = d.count;
        _updateBadge(d.count);
        return d.count;
      } catch { return 0; }
    },
    async load(cursor) {
      return api.get('/notifications', cursor ? { cursor } : {});
    },
    async markRead(id) {
      return api.patch(`/notifications/${id}/read`, {});
    },
    async markAllRead() {
      const d = await api.patch('/notifications/read-all', {});
      this._unread = 0;
      _updateBadge(0);
      return d;
    },

    async registerPush() {
      const keyRes = await fetch(`${API_BASE}/notifications/push/vapid-key`);
      if (!keyRes.ok) return;
      const { vapid_public_key } = await keyRes.json();
      if (!vapid_public_key) return;

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid_public_key),
      });

      await api.post('/notifications/push/subscribe', {
        endpoint: sub.endpoint,
        keys: { p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')))),
                auth:   btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')))) },
      });
    },

    handleIncoming(notif) {
      this._unread++;
      _updateBadge(this._unread);
      // Prepend to open panel if visible
      const panel = document.getElementById('ps-notif-list');
      if (panel) panel.insertAdjacentHTML('afterbegin', renderNotifItem(notif));
    },
  };

  function _updateBadge(count) {
    const badge = document.getElementById('ps-notif-badge');
    if (!badge) return;
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = count > 0 ? '' : 'none';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Messaging
  // ─────────────────────────────────────────────────────────────────────────
  const Messaging = {
    _activeConvId: null,

    async loadConversations() { return api.get('/conversations'); },
    async loadRequests()      { return api.get('/conversations/requests'); },
    async getConversation(id) { return api.get(`/conversations/${id}`); },
    async loadMessages(id, cursor) {
      return api.get(`/conversations/${id}/messages`, cursor ? { cursor } : {});
    },
    async startDM(userId) {
      return api.post('/conversations', { type: 'dm', to_user_id: userId });
    },
    async createGroup(name, memberIds) {
      return api.post('/conversations', { type: 'group', name, member_ids: memberIds });
    },
    async sendMessage(convId, { text, reviewId, audioBlob } = {}) {
      const fd = new FormData();
      if (text)     fd.append('body_text', text);
      if (reviewId) fd.append('embedded_review_id', String(reviewId));
      if (audioBlob) fd.append('audio', audioBlob, 'voice.webm');
      return api.postForm(`/conversations/${convId}/messages`, fd);
    },
    async deleteMessage(convId, msgId) { return api.del(`/conversations/${convId}/messages/${msgId}`); },
    async addMember(convId, userId)    { return api.post(`/conversations/${convId}/members`, { user_id: userId }); },
    async removeMember(convId, userId) { return api.del(`/conversations/${convId}/members/${userId}`); },
    async promoteMember(convId, userId, role) {
      return api.patch(`/conversations/${convId}/members/${userId}/role`, { role });
    },
    async renameGroup(convId, name) { return api.patch(`/conversations/${convId}`, { name }); },
    async acceptRequest(convId)  { return api.post(`/conversations/requests/${convId}/accept`, {}); },
    async declineRequest(convId) { return api.del(`/conversations/requests/${convId}`); },

    handleIncomingMessage(convId, msg) {
      if (this._activeConvId === convId) {
        const list = document.getElementById('ps-msg-list');
        if (list) list.insertAdjacentHTML('beforeend', renderMessageBubble(msg, window.currentUser?.id));
        list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
      }
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // WebSocket
  // ─────────────────────────────────────────────────────────────────────────
  const Socket = (() => {
    let ws        = null;
    let attempts  = 0;
    const MAX_ATT = 6;
    const handlers = {};

    function on(type, fn) { handlers[type] = fn; }

    function dispatch(msg) {
      const h = handlers[msg.type];
      if (h) h(msg);
      // Built-in dispatch
      if (msg.type === 'notification')  Notifications.handleIncoming(msg.data);
      if (msg.type === 'new_message')   Messaging.handleIncomingMessage(msg.conversation_id, msg.data);
      if (msg.type === 'review_engagement') _patchEngagementCounts(msg);
    }

    function connect() {
      const token = Auth.getToken();
      if (!token || ws?.readyState === WebSocket.OPEN) return;

      ws = new WebSocket(`${WS_BASE}?token=${encodeURIComponent(token)}`);

      ws.onopen  = () => { attempts = 0; };
      ws.onmessage = (e) => { try { dispatch(JSON.parse(e.data)); } catch {} };
      ws.onerror = () => {};
      ws.onclose = (e) => {
        if (e.code === 4001) return; // auth failure — don't retry
        if (attempts < MAX_ATT) {
          attempts++;
          setTimeout(connect, Math.min(1000 * 2 ** attempts, 30000));
        }
      };
    }

    function close() { ws?.close(); ws = null; }

    return { connect, close, on };
  })();

  function _patchEngagementCounts(msg) {
    if (!msg.review_id || !msg.delta) return;
    for (const [key, val] of Object.entries(msg.delta)) {
      _patchReviewCount(msg.review_id, key, val);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reporting
  // ─────────────────────────────────────────────────────────────────────────
  const Report = {
    async submit({ targetType, targetId, reason, details }) {
      return api.post('/reports', { target_type: targetType, target_id: targetId, reason, details });
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // UI Rendering helpers
  // ─────────────────────────────────────────────────────────────────────────
  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function relTime(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60)   return 'just now';
    if (diff < 3600) return `${Math.floor(diff/60)}m`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h`;
    return `${Math.floor(diff/86400)}d`;
  }

  const PILLAR_COLORS = new Proxy({}, { get(_, k) { return getComputedStyle(document.documentElement).getPropertyValue('--' + k).trim() || '#888'; } });

  function avatarHtml(user, size = 32) {
    const pillars = Array.isArray(user.pillars) ? user.pillars
      : (typeof user.user_pillars === 'string' ? JSON.parse(user.user_pillars || '[]') : []);
    const initial = (user.username || '?')[0].toUpperCase();
    const inner   = user.avatar_url
      ? `<img src="${esc(user.avatar_url)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
      : `<span style="font-size:${Math.floor(size*0.35)}px">${esc(initial)}</span>`;

    let ringBg;
    if (pillars.length === 0) {
      ringBg = 'background:#444';
    } else if (pillars.length === 1) {
      ringBg = `background:${PILLAR_COLORS[pillars[0]] || '#888'}`;
    } else {
      const stops = pillars.map((p, i) => {
        const pct1 = Math.round(i * 100 / pillars.length);
        const pct2 = Math.round((i+1) * 100 / pillars.length);
        return `${PILLAR_COLORS[p] || '#888'} ${pct1}% ${pct2}%`;
      }).join(', ');
      ringBg = `background:conic-gradient(${stops})`;
    }

    return `<div style="${ringBg};display:inline-flex;padding:2px;border-radius:50%;width:${size+4}px;height:${size+4}px;align-items:center;justify-content:center;">
      <div style="width:${size}px;height:${size}px;border-radius:50%;background:#111;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#fff;font-family:monospace;">
        ${inner}
      </div>
    </div>`;
  }

  function renderReviewCard(r) {
    const pillarColor = PILLAR_COLORS[r.pillar] || '#888';
    const user = { username: r.username, avatar_url: r.avatar_url, pillars: r.user_pillars };
    return `<article data-review-id="${r.id}" style="background:#111;border:1px solid #222;border-left:3px solid ${pillarColor};padding:1rem;margin-bottom:.75rem;border-radius:4px;">
      <div style="display:flex;gap:.75rem;align-items:center;margin-bottom:.75rem;">
        ${avatarHtml(user, 36)}
        <div>
          <div style="font-family:monospace;font-size:.85rem;color:#f0f0f0;">@${esc(r.username)}</div>
          <div style="font-size:.7rem;color:#666;">${relTime(r.created_at)}</div>
        </div>
        <div style="margin-left:auto;display:flex;gap:.5rem;align-items:center;">
          <span style="font-size:.65rem;color:${pillarColor};border:1px solid ${pillarColor};padding:2px 6px;border-radius:2px;font-family:monospace;text-transform:uppercase;">${esc(r.pillar)}</span>
          <button onclick="PS.UI.openReportModal('review',${r.id})" style="background:none;border:none;color:#444;cursor:pointer;font-size:.9rem;" title="Report">···</button>
        </div>
      </div>
      <div style="margin-bottom:.5rem;">
        <div style="font-weight:600;font-size:.95rem;">${esc(r.subject_title)}${r.subject_year ? ` <span style="color:#666;font-weight:400">(${r.subject_year})</span>` : ''}</div>
        ${r.subject_creator ? `<div style="font-size:.8rem;color:#888;">${esc(r.subject_creator)}</div>` : ''}
      </div>
      ${r.body_text ? `<p style="font-size:.875rem;line-height:1.5;color:#ccc;margin:.5rem 0;">${esc(r.body_text)}</p>` : ''}
      ${r.audio_url ? `<div style="background:#0a0a0a;border:1px solid #1a1a1a;padding:.5rem;border-radius:3px;margin:.5rem 0;">
        <audio controls src="${esc(r.audio_url)}" style="width:100%;height:32px;"></audio>
      </div>` : ''}
      <div style="display:flex;gap:1.25rem;margin-top:.75rem;color:#666;font-size:.8rem;">
        <button onclick="PS.UI.toggleLike(this,${r.id},${!!r.liked})" data-liked="${r.liked}" style="background:none;border:none;cursor:pointer;color:${r.liked ? '#FF1493' : '#666'};display:flex;align-items:center;gap:.3rem;">
          <span>${r.liked ? '♥' : '♡'}</span><span data-count="like_count">${r.like_count}</span>
        </button>
        <button onclick="PS.UI.openComments(${r.id})" style="background:none;border:none;cursor:pointer;color:#666;display:flex;align-items:center;gap:.3rem;">
          <span>◎</span><span data-count="comment_count">${r.comment_count}</span>
        </button>
        <button onclick="PS.UI.promptRepost(${r.id})" style="background:none;border:none;cursor:pointer;color:${r.reposted ? '#39FF14' : '#666'};display:flex;align-items:center;gap:.3rem;" data-reposted="${r.reposted}">
          <span>↺</span><span data-count="repost_count">${r.repost_count}</span>
        </button>
        <button onclick="PS.Engagement.share(${r.id})" style="background:none;border:none;cursor:pointer;color:#666;">↗</button>
      </div>
    </article>`;
  }

  function renderNotifItem(n) {
    const icons = {
      follow:'👤', like:'♥', comment:'◎', comment_like:'♥', repost:'↺',
      dm:'✉', subscription_post:'🔔', mention:'@', message_request:'✉',
    };
    return `<div class="ps-notif-item${n.read ? '' : ' ps-notif-unread'}" data-notif-id="${n.id}"
      onclick="PS.Notifications.markRead(${n.id})" style="display:flex;gap:.75rem;padding:.75rem 1rem;border-bottom:1px solid #1a1a1a;cursor:pointer;background:${n.read?'#0a0a0a':'#111'};">
      <span style="font-size:1rem;min-width:20px;">${icons[n.type]||'•'}</span>
      <div style="flex:1;">
        <div style="font-size:.85rem;color:#f0f0f0;">${esc(n.body)}</div>
        <div style="font-size:.7rem;color:#666;">${relTime(n.created_at)}</div>
      </div>
    </div>`;
  }

  function renderMessageBubble(msg, currentUserId) {
    const isMine = msg.sender_id === currentUserId || msg.sender?.id === currentUserId;
    return `<div style="display:flex;flex-direction:${isMine?'row-reverse':'row'};gap:.5rem;margin:.5rem 0;align-items:flex-end;">
      ${!isMine ? avatarHtml(msg.sender || {username:'?'}, 28) : ''}
      <div style="max-width:70%;background:${isMine?'#1a1a1a':'#111'};border:1px solid #222;padding:.5rem .75rem;border-radius:8px;">
        ${msg.body_text ? `<div style="font-size:.875rem;color:#f0f0f0;">${esc(msg.body_text)}</div>` : ''}
        ${msg.embedded_review ? `<div style="margin-top:.5rem;border:1px solid #333;padding:.5rem;border-radius:4px;font-size:.8rem;color:#888;">
          Review: ${esc(msg.embedded_review.subject_title)}</div>` : ''}
        <div style="font-size:.65rem;color:#444;margin-top:.25rem;">${relTime(msg.created_at)}</div>
      </div>
    </div>`;
  }

  function renderCommentItem(c, reviewId, depth = 0) {
    const user = { username: c.username, avatar_url: c.avatar_url, pillars: c.user_pillars };
    const indent = depth * 24;
    return `<div style="margin-left:${indent}px;padding:.6rem 0;border-bottom:1px solid #1a1a1a;" data-comment-id="${c.id}">
      <div style="display:flex;gap:.5rem;align-items:center;margin-bottom:.35rem;">
        ${avatarHtml(user, 24)}
        <span style="font-family:monospace;font-size:.8rem;color:#aaa;">@${esc(c.username)}</span>
        ${c.timestamp_sec != null ? `<span style="font-size:.7rem;color:#666;">${formatTimestamp(c.timestamp_sec)}</span>` : ''}
        <span style="font-size:.7rem;color:#444;margin-left:auto;">${relTime(c.created_at)}</span>
      </div>
      ${c.is_deleted ? '<div style="font-size:.8rem;color:#444;font-style:italic;">[deleted]</div>' :
        `${c.body_text ? `<div style="font-size:.85rem;color:#ccc;margin-bottom:.35rem;">${esc(c.body_text)}</div>` : ''}
         ${c.audio_url ? `<audio controls src="${esc(c.audio_url)}" style="width:100%;height:28px;margin-bottom:.35rem;"></audio>` : ''}
         <div style="display:flex;gap:1rem;font-size:.75rem;color:#666;">
           <button onclick="PS.UI.toggleCommentLike(this,${reviewId},${c.id},${!!c.liked})" style="background:none;border:none;cursor:pointer;color:${c.liked?'#FF1493':'#666'};">♥ ${c.like_count}</button>
           ${depth < 2 ? `<button onclick="PS.UI.showReplyBox(${reviewId},${c.id})" style="background:none;border:none;cursor:pointer;color:#666;">reply</button>` : ''}
         </div>`}
      ${(c.replies||[]).map(r => renderCommentItem(r, reviewId, depth+1)).join('')}
    </div>`;
  }

  function formatTimestamp(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2,'0')}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UI — Panels, Modals, and Interactive Actions
  // ─────────────────────────────────────────────────────────────────────────
  const UI = {
    // Toast notification
    toast(msg, type = 'info') {
      const el = document.createElement('div');
      el.style.cssText = `
        position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;
        background:${type==='error'?'#330000':type==='success'?'#003300':'#111'};
        border:1px solid ${type==='error'?'#FF4444':type==='success'?'#39FF14':'#333'};
        color:#f0f0f0;font-family:monospace;font-size:.8rem;padding:.6rem 1rem;
        border-radius:3px;max-width:320px;box-shadow:0 4px 20px rgba(0,0,0,.5);
        animation:ps-fadein .2s ease;
      `;
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 3000);
    },

    // ── Notification panel ─────────────────────────────────────────────────
    async openNotificationPanel() {
      let panel = document.getElementById('ps-notif-panel');
      if (!panel) panel = _createNotifPanel();
      panel.style.display = '';
      await Notifications.markAllRead();
      const { notifications } = await Notifications.load().catch(() => ({ notifications: [] }));
      const list = document.getElementById('ps-notif-list');
      list.innerHTML = notifications.length
        ? notifications.map(renderNotifItem).join('')
        : '<div style="padding:2rem;text-align:center;color:#444;font-size:.85rem;">No notifications yet</div>';
    },
    closeNotificationPanel() {
      const p = document.getElementById('ps-notif-panel');
      if (p) p.style.display = 'none';
    },

    // ── Messages panel ─────────────────────────────────────────────────────
    async openMessagesPanel() {
      let panel = document.getElementById('ps-msg-panel');
      if (!panel) panel = _createMsgPanel();
      panel.style.display = '';
      await _loadConversationList();
    },
    closeMessagesPanel() {
      const p = document.getElementById('ps-msg-panel');
      if (p) p.style.display = 'none';
    },
    async openConversation(convId) {
      Messaging._activeConvId = convId;
      const panel = document.getElementById('ps-msg-panel');
      if (!panel) return;
      const { messages } = await Messaging.loadMessages(convId).catch(() => ({ messages: [] }));
      const cu = window.currentUser;
      panel.querySelector('#ps-msg-body').innerHTML = `
        <div id="ps-msg-list" style="flex:1;overflow-y:auto;padding:.75rem;display:flex;flex-direction:column;">
          ${messages.map(m => renderMessageBubble(m, cu?.id)).join('')}
        </div>
        <form id="ps-msg-form" style="display:flex;gap:.5rem;padding:.75rem;border-top:1px solid #222;" onsubmit="PS.UI._sendMsg(event,${convId})">
          <input id="ps-msg-input" type="text" placeholder="Message…" autocomplete="off"
            style="flex:1;background:#1a1a1a;border:1px solid #333;color:#f0f0f0;padding:.5rem .75rem;font-family:inherit;font-size:.85rem;border-radius:3px;outline:none;">
          <button type="submit" style="background:#fff;color:#000;border:none;padding:.5rem .75rem;font-family:monospace;font-size:.75rem;cursor:pointer;">send</button>
        </form>`;
      const list = document.getElementById('ps-msg-list');
      if (list) list.scrollTop = list.scrollHeight;
    },
    async _sendMsg(event, convId) {
      event.preventDefault();
      const input = document.getElementById('ps-msg-input');
      const text  = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        await Messaging.sendMessage(convId, { text });
      } catch (e) { UI.toast(e.message, 'error'); }
    },

    // ── Comments panel ─────────────────────────────────────────────────────
    async openComments(reviewId) {
      let panel = document.getElementById('ps-comments-panel');
      if (!panel) panel = _createCommentsPanel();
      panel.style.display = '';
      panel.dataset.reviewId = reviewId;
      const { comments } = await Comments.load(reviewId).catch(() => ({ comments: [] }));
      const list = document.getElementById('ps-comments-list');
      list.innerHTML = comments.length
        ? comments.map(c => renderCommentItem(c, reviewId, 0)).join('')
        : '<div style="padding:1.5rem;text-align:center;color:#444;font-size:.85rem;">No comments yet. Be the first.</div>';
    },
    async _submitComment(event, reviewId) {
      event.preventDefault();
      const input = document.getElementById('ps-comment-input');
      const text  = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        const c = await Comments.post(reviewId, { text });
        const list = document.getElementById('ps-comments-list');
        if (list) list.insertAdjacentHTML('afterbegin', renderCommentItem(c, reviewId, 0));
      } catch (e) { UI.toast(e.message, 'error'); }
    },
    async showReplyBox(reviewId, commentId) {
      const existing = document.getElementById(`ps-reply-box-${commentId}`);
      if (existing) { existing.remove(); return; }
      const commentEl = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (!commentEl) return;
      const box = document.createElement('div');
      box.id = `ps-reply-box-${commentId}`;
      box.innerHTML = `<form style="display:flex;gap:.5rem;padding:.35rem 0;" onsubmit="PS.UI._submitReply(event,${reviewId},${commentId})">
        <input type="text" placeholder="Reply…" autocomplete="off" id="ps-reply-input-${commentId}"
          style="flex:1;background:#1a1a1a;border:1px solid #333;color:#f0f0f0;padding:.4rem .6rem;font-family:inherit;font-size:.8rem;border-radius:3px;outline:none;">
        <button type="submit" style="background:#fff;color:#000;border:none;padding:.4rem .6rem;font-family:monospace;font-size:.7rem;cursor:pointer;">reply</button>
      </form>`;
      commentEl.appendChild(box);
    },
    async _submitReply(event, reviewId, commentId) {
      event.preventDefault();
      const input = document.getElementById(`ps-reply-input-${commentId}`);
      const text  = input?.value.trim();
      if (!text) return;
      input.value = '';
      try {
        const c = await Comments.reply(reviewId, commentId, { text });
        const box = document.getElementById(`ps-reply-box-${commentId}`);
        if (box) box.remove();
        UI.openComments(reviewId);
      } catch (e) { UI.toast(e.message, 'error'); }
    },
    closeComments() {
      const p = document.getElementById('ps-comments-panel');
      if (p) p.style.display = 'none';
    },

    // ── Like toggle ────────────────────────────────────────────────────────
    async toggleLike(btn, reviewId, wasLiked) {
      try {
        const d = wasLiked ? await Engagement.unlike(reviewId) : await Engagement.like(reviewId);
        btn.dataset.liked    = !wasLiked;
        btn.style.color      = !wasLiked ? '#FF1493' : '#666';
        btn.querySelector('span:first-child').textContent = !wasLiked ? '♥' : '♡';
        btn.setAttribute('onclick', `PS.UI.toggleLike(this,${reviewId},${!wasLiked})`);
      } catch (e) { UI.toast(e.message, 'error'); }
    },

    async toggleCommentLike(btn, reviewId, commentId, wasLiked) {
      try {
        if (wasLiked) {
          await Comments.unlike(reviewId, commentId);
        } else {
          await Comments.like(reviewId, commentId);
        }
        btn.style.color = !wasLiked ? '#FF1493' : '#666';
        btn.setAttribute('onclick', `PS.UI.toggleCommentLike(this,${reviewId},${commentId},${!wasLiked})`);
      } catch (e) { UI.toast(e.message, 'error'); }
    },

    // ── Repost prompt ──────────────────────────────────────────────────────
    async promptRepost(reviewId) {
      const btn = document.querySelector(`[data-review-id="${reviewId}"] [data-reposted]`);
      if (btn?.dataset.reposted === 'true') {
        await Engagement.unrepost(reviewId).catch(() => {});
        if (btn) { btn.style.color = '#666'; btn.dataset.reposted = 'false'; }
        return;
      }
      const quote = window.prompt('Add a quote (optional):') ?? null;
      if (quote === null && !window.confirm('Repost without a quote?')) return;
      try {
        await Engagement.repost(reviewId, quote || undefined);
        if (btn) { btn.style.color = '#39FF14'; btn.dataset.reposted = 'true'; }
        UI.toast('Reposted', 'success');
      } catch (e) { UI.toast(e.message, 'error'); }
    },

    // ── Report modal ───────────────────────────────────────────────────────
    openReportModal(targetType, targetId) {
      let modal = document.getElementById('ps-report-modal');
      if (!modal) modal = _createReportModal();
      modal.dataset.targetType = targetType;
      modal.dataset.targetId   = targetId;
      modal.style.display = '';
      modal.querySelector('#ps-report-reason').value = '';
      modal.querySelector('#ps-report-details').value = '';
    },
    closeReportModal() {
      const m = document.getElementById('ps-report-modal');
      if (m) m.style.display = 'none';
    },
    async _submitReport(event) {
      event.preventDefault();
      const modal  = document.getElementById('ps-report-modal');
      const reason = modal.querySelector('#ps-report-reason').value;
      const details = modal.querySelector('#ps-report-details').value.trim();
      if (!reason) { UI.toast('Please select a reason', 'error'); return; }
      try {
        await Report.submit({ targetType: modal.dataset.targetType, targetId: modal.dataset.targetId, reason, details });
        UI.closeReportModal();
        UI.toast('Report submitted', 'success');
      } catch (e) { UI.toast(e.message, 'error'); }
    },

    // ── Follow button (on other-user profiles) ─────────────────────────────
    async toggleFollow(btn, username, isFollowing) {
      try {
        if (isFollowing) {
          await SocialGraph.unfollow(username);
          btn.textContent = 'follow';
          btn.dataset.following = 'false';
          btn.setAttribute('onclick', `PS.UI.toggleFollow(this,'${username}',false)`);
        } else {
          await SocialGraph.follow(username);
          btn.textContent = 'following';
          btn.dataset.following = 'true';
          btn.setAttribute('onclick', `PS.UI.toggleFollow(this,'${username}',true)`);
        }
      } catch (e) { UI.toast(e.message, 'error'); }
    },

    // ── Feed rendering ─────────────────────────────────────────────────────
    async mountFeed(containerId, opts = {}) {
      const el = document.getElementById(containerId);
      if (!el) return;
      el.innerHTML = '<div style="padding:2rem;text-align:center;color:#444;font-size:.85rem;">Loading…</div>';

      const data = await Feed.load(opts).catch(() => ({ reviews: [] }));
      el.innerHTML = data.reviews.length
        ? data.reviews.map(renderReviewCard).join('')
        : '<div style="padding:2rem;text-align:center;color:#444;font-size:.85rem;">No reviews yet.</div>';

      // Infinite scroll
      if (data.next_cursor) {
        const sentinel = document.createElement('div');
        sentinel.style.height = '20px';
        el.appendChild(sentinel);
        const obs = new IntersectionObserver(async ([entry]) => {
          if (!entry.isIntersecting) return;
          obs.disconnect();
          const more = await Feed.load({ ...opts, cursor: data.next_cursor }).catch(() => ({ reviews: [] }));
          if (more.reviews.length) {
            sentinel.remove();
            more.reviews.forEach(r => el.insertAdjacentHTML('beforeend', renderReviewCard(r)));
          }
        }, { threshold: 0.1 });
        obs.observe(sentinel);
      }
    },

    renderReviewCard,
    renderNotifItem,
    renderMessageBubble,
    renderCommentItem,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // DOM builders for overlay panels
  // ─────────────────────────────────────────────────────────────────────────
  function _panelBase(id, title, onClose) {
    const div = document.createElement('div');
    div.id = id;
    div.style.cssText = `
      position:fixed;top:56px;right:0;bottom:0;width:400px;max-width:100vw;z-index:500;
      background:#0a0a0a;border-left:1px solid #222;display:flex;flex-direction:column;
      overflow:hidden;
    `;
    div.innerHTML = `
      <div style="display:flex;align-items:center;padding:.75rem 1rem;border-bottom:1px solid #222;">
        <span style="font-family:monospace;font-size:.85rem;font-weight:700;letter-spacing:.1em;">${title}</span>
        <button onclick="${onClose}" style="margin-left:auto;background:none;border:none;color:#666;cursor:pointer;font-size:1.1rem;">✕</button>
      </div>
      <div id="${id}-body" style="flex:1;overflow-y:auto;"></div>
    `;
    document.body.appendChild(div);
    return div;
  }

  function _createNotifPanel() {
    const panel = _panelBase('ps-notif-panel', 'NOTIFICATIONS', 'PS.UI.closeNotificationPanel()');
    const body  = panel.querySelector('#ps-notif-panel-body');
    body.innerHTML = `
      <div style="display:flex;justify-content:flex-end;padding:.5rem 1rem;border-bottom:1px solid #1a1a1a;">
        <button onclick="PS.Notifications.markAllRead()" style="font-family:monospace;font-size:.7rem;background:none;border:1px solid #333;color:#888;padding:.3rem .6rem;cursor:pointer;">mark all read</button>
      </div>
      <div id="ps-notif-list"></div>`;
    return panel;
  }

  function _createMsgPanel() {
    const panel = _panelBase('ps-msg-panel', 'MESSAGES', 'PS.UI.closeMessagesPanel()');
    const body  = panel.querySelector('#ps-msg-panel-body');
    body.id = 'ps-msg-body';
    return panel;
  }

  async function _loadConversationList() {
    const body = document.getElementById('ps-msg-body');
    if (!body) return;
    const { conversations } = await Messaging.loadConversations().catch(() => ({ conversations: [] }));
    const { requests } = await Messaging.loadRequests().catch(() => ({ requests: [] }));
    body.innerHTML = `
      ${requests.length ? `<div style="padding:.5rem 1rem;background:#111;border-bottom:1px solid #222;font-size:.75rem;color:#888;font-family:monospace;">
        MESSAGE REQUESTS (${requests.length})
        ${requests.map(r => `<div onclick="PS.UI.openConversation(${r.id})" style="padding:.5rem 0;cursor:pointer;color:#f0f0f0;">${r.name || 'DM'}</div>`).join('')}
      </div>` : ''}
      ${conversations.length ? conversations.map(c => {
        const others = (c.members||[]).filter(m => m.user_id !== window.currentUser?.id);
        const name   = c.type === 'group' ? c.name : (others[0]?.username || 'Unknown');
        const lastMsg = c.last_message?.body_text ? c.last_message.body_text.slice(0,60) : '';
        return `<div onclick="PS.UI.openConversation(${c.id})" style="padding:.75rem 1rem;border-bottom:1px solid #1a1a1a;cursor:pointer;display:flex;gap:.75rem;align-items:center;">
          <div style="flex:1;">
            <div style="font-size:.85rem;color:#f0f0f0;font-family:monospace;">
              ${esc(name)}${c.unread_count ? ` <span style="background:#FF1493;color:#fff;border-radius:10px;padding:0 5px;font-size:.7rem;">${c.unread_count}</span>` : ''}
            </div>
            ${lastMsg ? `<div style="font-size:.75rem;color:#666;margin-top:.2rem;">${esc(lastMsg)}</div>` : ''}
          </div>
        </div>`;
      }).join('') : '<div style="padding:2rem;text-align:center;color:#444;font-size:.85rem;">No conversations yet.</div>'}
    `;
  }

  function _createCommentsPanel() {
    const panel = _panelBase('ps-comments-panel', 'COMMENTS', 'PS.UI.closeComments()');
    const body  = panel.querySelector('#ps-comments-panel-body');
    body.innerHTML = `
      <form style="display:flex;gap:.5rem;padding:.75rem;border-bottom:1px solid #222;" onsubmit="PS.UI._submitComment(event, document.getElementById('ps-comments-panel').dataset.reviewId)">
        <input id="ps-comment-input" type="text" placeholder="Add a comment…" autocomplete="off"
          style="flex:1;background:#1a1a1a;border:1px solid #333;color:#f0f0f0;padding:.5rem .75rem;font-family:inherit;font-size:.85rem;border-radius:3px;outline:none;">
        <button type="submit" style="background:#fff;color:#000;border:none;padding:.5rem .75rem;font-family:monospace;font-size:.75rem;cursor:pointer;">post</button>
      </form>
      <div id="ps-comments-list" style="overflow-y:auto;padding:.5rem 1rem;"></div>`;
    return panel;
  }

  function _createReportModal() {
    const div = document.createElement('div');
    div.id = 'ps-report-modal';
    div.style.cssText = `
      position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.75);
      display:flex;align-items:center;justify-content:center;`;
    div.innerHTML = `
      <div style="background:#111;border:1px solid #333;padding:1.5rem;width:360px;max-width:90vw;border-radius:4px;">
        <div style="font-family:monospace;font-weight:700;margin-bottom:1rem;font-size:.9rem;">REPORT CONTENT</div>
        <form onsubmit="PS.UI._submitReport(event)">
          <select id="ps-report-reason" style="width:100%;background:#0a0a0a;border:1px solid #333;color:#f0f0f0;padding:.5rem;margin-bottom:.75rem;font-family:inherit;font-size:.85rem;">
            <option value="">Select reason…</option>
            <option value="spam">Spam</option>
            <option value="harassment">Harassment</option>
            <option value="hate_speech">Hate speech</option>
            <option value="inappropriate_content">Inappropriate content</option>
            <option value="impersonation">Impersonation</option>
            <option value="misinformation">Misinformation</option>
            <option value="other">Other</option>
          </select>
          <textarea id="ps-report-details" placeholder="Additional details (optional)"
            style="width:100%;background:#0a0a0a;border:1px solid #333;color:#f0f0f0;padding:.5rem;font-family:inherit;font-size:.8rem;resize:vertical;min-height:80px;box-sizing:border-box;"></textarea>
          <div style="display:flex;gap:.75rem;margin-top:1rem;justify-content:flex-end;">
            <button type="button" onclick="PS.UI.closeReportModal()" style="background:none;border:1px solid #333;color:#888;padding:.5rem .9rem;font-family:monospace;font-size:.75rem;cursor:pointer;">cancel</button>
            <button type="submit" style="background:#FF4444;color:#fff;border:none;padding:.5rem .9rem;font-family:monospace;font-size:.75rem;cursor:pointer;">submit report</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(div);
    return div;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────────────────────────────────────
  function dataURLtoBlob(dataURL) {
    const [header, data] = dataURL.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(data);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64  = (base64String + padding).replace(/-/g,'+').replace(/_/g,'/');
    const raw     = atob(base64);
    const arr     = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // Inject global CSS
  const style = document.createElement('style');
  style.textContent = `
    @keyframes ps-fadein { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
    .ps-notif-unread { background:#111 !important; }
    .ps-notif-item:hover { background:#1a1a1a !important; }
    #ps-notif-panel, #ps-msg-panel, #ps-comments-panel { animation: ps-fadein .15s ease; }
  `;
  document.head.appendChild(style);

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────
  const PoserSocial = {
    Auth, SocialGraph, Feed, Engagement, Comments,
    Notifications, Messaging, Socket, Report, UI,
  };

  window.PoserSocial = PoserSocial;
  window.PS          = PoserSocial;

})(window);
