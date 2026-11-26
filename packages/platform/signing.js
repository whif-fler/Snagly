'use strict';

const crypto = require('crypto');

const base64url = (value) => Buffer.from(value).toString('base64url');

/**
 * HMAC-signed, expiring bearer tokens for file delivery. Tokens are bound to
 * a user, job and track so a leaked URL cannot be replayed against another
 * record and stops working when the job expires.
 */
function createSigner(secret) {
  if (!secret || secret.length < 16) throw new Error('A download token secret is required');
  const key = Buffer.from(secret, 'utf8');

  function sign(payload, ttlMs) {
    const body = base64url(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
    const mac = crypto.createHmac('sha256', key).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  function verify(token) {
    if (typeof token !== 'string' || token.length > 4096) return null;
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = crypto.createHmac('sha256', key).update(body).digest();
    let provided;
    try {
      provided = Buffer.from(mac, 'base64url');
    } catch {
      return null;
    }
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  }

  return { sign, verify };
}

module.exports = { createSigner };
