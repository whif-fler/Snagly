'use strict';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

function hostnameOf(value) {
  try {
    const host = new URL(`http://${String(value || '')}`).hostname.toLowerCase();
    return host || '';
  } catch {
    return '';
  }
}

function createSecurity({ config }) {
  const buckets = new Map();

  function headers(res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (config.secureCookies)
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  function hostAllowed(req) {
    const host = hostnameOf(req.headers.host);
    if (!host) return false;
    if (config.allowedHosts.has(host)) return true;
    // URL.hostname keeps IPv6 brackets; accept both forms.
    if (config.allowedHosts.has(host.replace(/^\[|\]$/g, ''))) return true;
    return false;
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // Non-browser clients still need the CSRF token.
    if (origin === 'null') return false;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (config.publicOrigin && origin === config.publicOrigin) return true;
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const requestHost = String(req.headers.host || '').toLowerCase();
    if (!requestHost) return false;
    // Compare the full authority (host and port), not just the hostname, so a
    // sibling service on another port of the same host cannot forge an Origin.
    return parsed.host.toLowerCase() === requestHost;
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function take(key, limit, windowMs) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (buckets.size > 20_000) {
      for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
    }
    return bucket.count <= limit
      ? { ok: true }
      : { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.reset - now) / 1000)) };
  }

  function rateLimit(req, res, name, limit, windowMs, extraKey = '') {
    const key = `${name}:${clientIp(req)}:${extraKey}`;
    const result = take(key, limit, windowMs);
    if (result.ok) return true;
    res.setHeader('Retry-After', String(result.retryAfter));
    const body = JSON.stringify({ error: 'Too many requests. Try again shortly.', code: 'rate_limited' });
    headers(res);
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    });
    res.end(body);
    return false;
  }

  return { headers, hostAllowed, originAllowed, clientIp, rateLimit };
}

module.exports = { createSecurity, CSP, hostnameOf };
