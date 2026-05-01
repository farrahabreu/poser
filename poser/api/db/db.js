'use strict';

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '../', process.env.DB_PATH || './db/poser.db');

// Ensure directory exists
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA temp_store = memory');

// Run schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Runtime migrations — safe to run on every boot
['ALTER TABLE users ADD COLUMN google_id TEXT',
 'ALTER TABLE users ADD COLUMN phone TEXT',
 'ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0',
].forEach(sql => { try { db.exec(sql); } catch {} });
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL`); } catch {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL`); } catch {}

// node:sqlite returns null-prototype objects; add a thin wrapper so
// .get() returns plain undefined (not null-prototype object undefined).
const _prepare = db.prepare.bind(db);

db.prepare = function (sql) {
  const stmt = _prepare(sql);
  return {
    run:  (...args) => stmt.run(...args),
    get:  (...args) => {
      const row = stmt.get(...args);
      return row === undefined ? undefined : Object.assign({}, row);
    },
    all:  (...args) => (stmt.all(...args) || []).map(r => Object.assign({}, r)),
    // node:sqlite doesn't expose .iterate — not needed here
  };
};

// Wrap db.transaction for node:sqlite (it uses db.transaction too)
const _origTransaction = db.transaction ? db.transaction.bind(db) : null;
if (_origTransaction) {
  db.transaction = function (fn) {
    return _origTransaction(fn);
  };
} else {
  // Fallback: manual BEGIN/COMMIT wrapper
  db.transaction = function (fn) {
    return function (...args) {
      db.exec('BEGIN');
      try {
        const result = fn(...args);
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    };
  };
}

module.exports = db;
