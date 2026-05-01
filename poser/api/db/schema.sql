PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  email           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT,
  bio             TEXT    NOT NULL DEFAULT '',
  avatar_url      TEXT,
  pillars         TEXT    NOT NULL DEFAULT '[]',
  insight_score   INTEGER NOT NULL DEFAULT 0,
  follower_count  INTEGER NOT NULL DEFAULT 0,
  following_count INTEGER NOT NULL DEFAULT 0,
  review_count    INTEGER NOT NULL DEFAULT 0,
  role            TEXT    NOT NULL DEFAULT 'user' CHECK(role IN ('user','mod','admin')),
  is_verified     INTEGER NOT NULL DEFAULT 0,
  is_banned       INTEGER NOT NULL DEFAULT 0,
  ban_reason      TEXT,
  ban_until       TEXT,
  push_endpoint   TEXT,
  push_p256dh     TEXT,
  push_auth       TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT    NOT NULL UNIQUE,
  expires_at  TEXT    NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- OTP codes (email verification & password reset)
CREATE TABLE IF NOT EXISTS otp_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,
  purpose     TEXT    NOT NULL CHECK(purpose IN ('signup','login','reset')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT    NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Follows (one-way)
CREATE TABLE IF NOT EXISTS follows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(follower_id, following_id),
  CHECK(follower_id != following_id)
);

-- Subscriptions (stronger signal than follow; push on every new review)
CREATE TABLE IF NOT EXISTS subscriptions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(subscriber_id, creator_id)
);

-- Blocks (silent)
CREATE TABLE IF NOT EXISTS blocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(blocker_id, blocked_id),
  CHECK(blocker_id != blocked_id)
);

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar              TEXT    NOT NULL CHECK(pillar IN ('cinema','music','fashion','lit')),
  subject_title       TEXT    NOT NULL,
  subject_year        INTEGER,
  subject_creator     TEXT,
  body_text           TEXT,
  audio_url           TEXT,
  audio_duration_sec  INTEGER,
  waveform_data       TEXT,
  insight_score       INTEGER NOT NULL DEFAULT 0,
  like_count          INTEGER NOT NULL DEFAULT 0,
  comment_count       INTEGER NOT NULL DEFAULT 0,
  repost_count        INTEGER NOT NULL DEFAULT 0,
  save_count          INTEGER NOT NULL DEFAULT 0,
  is_draft            INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Likes on reviews
CREATE TABLE IF NOT EXISTS likes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_id   INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, review_id)
);

-- Reposts
CREATE TABLE IF NOT EXISTS reposts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_id   INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  quote_text  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, review_id)
);

-- Saves / bookmarks (always private)
CREATE TABLE IF NOT EXISTS saves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_id   INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, review_id)
);

-- Comments (threaded, max depth 2)
CREATE TABLE IF NOT EXISTS comments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id           INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id           INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  depth               INTEGER NOT NULL DEFAULT 0 CHECK(depth >= 0 AND depth <= 2),
  body_text           TEXT,
  audio_url           TEXT,
  audio_duration_sec  INTEGER,
  timestamp_sec       REAL,
  like_count          INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Comment likes
CREATE TABLE IF NOT EXISTS comment_likes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_id  INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, comment_id)
);

-- Conversations (DM or group)
CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT    NOT NULL CHECK(type IN ('dm','group')),
  name            TEXT,
  avatar_url      TEXT,
  creator_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_message_at TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Conversation members
CREATE TABLE IF NOT EXISTS conversation_members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT    NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),
  is_request      INTEGER NOT NULL DEFAULT 0,
  last_read_at    TEXT,
  muted           INTEGER NOT NULL DEFAULT 0,
  left_at         TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(conversation_id, user_id)
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body_text           TEXT,
  embedded_review_id  INTEGER REFERENCES reviews(id) ON DELETE SET NULL,
  audio_url           TEXT,
  reply_to_id         INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  deleted_at          TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL CHECK(type IN (
                'follow','like','comment','comment_like','repost','dm',
                'subscription_post','mention','message_request'
              )),
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  review_id   INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
  comment_id  INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  body        TEXT,
  read        INTEGER NOT NULL DEFAULT 0,
  push_sent   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Reports
CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  TEXT    NOT NULL CHECK(target_type IN ('review','comment','user','message')),
  target_id    INTEGER NOT NULL,
  reason       TEXT    NOT NULL CHECK(reason IN (
                 'spam','harassment','hate_speech','inappropriate_content',
                 'impersonation','misinformation','other'
               )),
  details      TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reviewed','actioned','dismissed')),
  reviewed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  TEXT,
  action_taken TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- AI / manual moderation flags
CREATE TABLE IF NOT EXISTS moderation_flags (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type   TEXT    NOT NULL CHECK(target_type IN ('review','comment','message')),
  target_id     INTEGER NOT NULL,
  flag_source   TEXT    NOT NULL CHECK(flag_source IN ('ai_keyword','manual_report')),
  severity      TEXT    NOT NULL CHECK(severity IN ('low','medium','high')),
  matched_terms TEXT,
  status        TEXT    NOT NULL DEFAULT 'open' CHECK(status IN ('open','dismissed','actioned')),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Moderation actions log
CREATE TABLE IF NOT EXISTS moderation_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  moderator_id INTEGER NOT NULL REFERENCES users(id),
  target_type  TEXT    NOT NULL CHECK(target_type IN ('review','comment','user','message')),
  target_id    INTEGER NOT NULL,
  action       TEXT    NOT NULL CHECK(action IN ('warn','content_removed','temp_ban','perm_ban','dismiss')),
  reason       TEXT,
  ban_until    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── Tracking Items ──────────────────────────────────────────────────────────
-- One row per user × media item. pillar drives which external API the IDs
-- come from. external_id is the canonical ID from that API (TMDB movie/TV id,
-- MusicBrainz recording/release/artist MBID, OpenLibrary /works/OL… key, or a
-- slug for fashion entries which are manually entered).
CREATE TABLE IF NOT EXISTS tracking_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar        TEXT    NOT NULL CHECK(pillar IN ('cinema','music','fashion','lit')),
  -- status mirrors the spec's three states
  status        TEXT    NOT NULL DEFAULT 'want'
                  CHECK(status IN ('done','current','want')),
  -- external identity
  external_id   TEXT    NOT NULL,          -- API id / MBID / OL key / fashion slug
  media_type    TEXT,                      -- movie|tv|album|song|artist|show|book|graphic_novel etc.
  title         TEXT    NOT NULL,
  creator       TEXT,                      -- director / artist / designer / author
  year          INTEGER,
  cover_url     TEXT,                      -- poster / album art / book cover
  -- user annotations
  rating        INTEGER CHECK(rating IS NULL OR (rating >= 1 AND rating <= 5)),
  notes         TEXT,
  is_favorite   INTEGER NOT NULL DEFAULT 0,
  is_public     INTEGER NOT NULL DEFAULT 1, -- per-item privacy (pillar-level toggled by client)
  -- timestamps
  finished_at   TEXT,                      -- when status flipped to 'done'
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- link to a review
  review_id     INTEGER REFERENCES reviews(id) ON DELETE SET NULL,
  -- prevent duplicate entries per user × item
  UNIQUE(user_id, pillar, external_id)
);

-- Pillar-level privacy toggles (one row per user×pillar, created on demand)
CREATE TABLE IF NOT EXISTS tracking_privacy (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar     TEXT    NOT NULL CHECK(pillar IN ('cinema','music','fashion','lit')),
  is_public  INTEGER NOT NULL DEFAULT 1,
  UNIQUE(user_id, pillar)
);

-- ── POSER Wrapped ────────────────────────────────────────────────────────────
-- Pre-computed year-in-review snapshots. Generated server-side once a year.
-- Each row covers one user × year. The `data` JSON blob stores the full
-- computed payload so the client just reads one row.
CREATE TABLE IF NOT EXISTS wrapped_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year         INTEGER NOT NULL,
  data         TEXT    NOT NULL DEFAULT '{}',  -- JSON payload (see wrapped route)
  is_public    INTEGER NOT NULL DEFAULT 1,
  generated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, year)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_reviews_user        ON reviews(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_pillar      ON reviews(pillar, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_feed        ON reviews(is_draft, deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_likes_review        ON likes(review_id);
CREATE INDEX IF NOT EXISTS idx_likes_user          ON likes(user_id);
CREATE INDEX IF NOT EXISTS idx_reposts_review      ON reposts(review_id);
CREATE INDEX IF NOT EXISTS idx_reposts_user        ON reposts(user_id);
CREATE INDEX IF NOT EXISTS idx_saves_user          ON saves(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_review     ON comments(review_id, depth, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_parent     ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower    ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following   ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_subs_subscriber     ON subscriptions(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_subs_creator        ON subscriptions(creator_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocker      ON blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked      ON blocks(blocked_id);
CREATE INDEX IF NOT EXISTS idx_notifs_user         ON notifications(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conv       ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_members_user   ON conversation_members(user_id, left_at);
CREATE INDEX IF NOT EXISTS idx_reports_status      ON reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_mod_flags_status    ON moderation_flags(status, target_type);
CREATE INDEX IF NOT EXISTS idx_rt_user             ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_otp_email           ON otp_codes(email, purpose, used);
CREATE INDEX IF NOT EXISTS idx_tracking_user       ON tracking_items(user_id, pillar, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracking_favorite   ON tracking_items(user_id, is_favorite, pillar);
CREATE INDEX IF NOT EXISTS idx_tracking_finished   ON tracking_items(user_id, finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_wrapped_user_year   ON wrapped_snapshots(user_id, year DESC);
