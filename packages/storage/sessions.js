'use strict';

const crypto = require('crypto');
const { transaction } = require('./db');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function createSession(db, { ttlMs, userId = '' }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const id = userId || `usr_${crypto.randomUUID()}`;

  transaction(db, () => {
    db.prepare('INSERT OR IGNORE INTO users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      id,
      createdAt,
      createdAt
    );
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(createdAt, id);
    db.prepare(
      'INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(hashToken(token), id, csrfToken, createdAt, expiresAt);
  });

  return { userId: id, token, csrfToken, expiresAt };
}

function getSession(db, token) {
  if (!token || typeof token !== 'string' || token.length > 256) return null;
  const row = db
    .prepare(
      `
    SELECT s.user_id, s.csrf_token, s.expires_at, u.created_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `
    )
    .get(hashToken(token));
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return { userId: row.user_id, csrfToken: row.csrf_token, expiresAt: row.expires_at };
}

function deleteSession(db, token) {
  if (!token) return false;
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)).changes > 0;
}

function pruneSessions(db, now = new Date()) {
  const iso = now.toISOString();
  const stale = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at <= ?').get(iso).n;
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(iso);
  return stale;
}

function getSetting(db, userId, key, fallback = null) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function setSetting(db, userId, key, value) {
  db.prepare(
    `
    INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `
  ).run(userId, key, JSON.stringify(value));
}

module.exports = {
  hashToken,
  createSession,
  getSession,
  deleteSession,
  pruneSessions,
  getSetting,
  setSetting
};
