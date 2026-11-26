'use strict';

/** Per-user server-sent events. One user can never receive another's state. */
class SseHub {
  constructor({ maxPerUser = 3, heartbeatMs = 15_000 } = {}) {
    this.maxPerUser = maxPerUser;
    this.clients = new Map();
    this.heartbeat = setInterval(() => this.ping(), heartbeatMs);
    this.heartbeat.unref?.();
  }

  add(userId, res) {
    let set = this.clients.get(userId);
    if (!set) {
      set = new Set();
      this.clients.set(userId, set);
    }
    if (set.size >= this.maxPerUser) {
      const oldest = set.values().next().value;
      try {
        oldest.end();
      } catch {}
      set.delete(oldest);
    }
    set.add(res);
    res.on('close', () => {
      set.delete(res);
      if (!set.size) this.clients.delete(userId);
    });
  }

  publish(userId, payload) {
    const set = this.clients.get(userId);
    if (!set?.size) return 0;
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    let sent = 0;
    for (const res of set) {
      try {
        res.write(line);
        sent++;
      } catch {
        set.delete(res);
      }
    }
    return sent;
  }

  ping() {
    for (const [userId, set] of this.clients) {
      for (const res of set) {
        try {
          res.write(': ping\n\n');
        } catch {
          set.delete(res);
        }
      }
      if (!set.size) this.clients.delete(userId);
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const set of this.clients.values()) {
      for (const res of set) {
        try {
          res.end();
        } catch {}
      }
    }
    this.clients.clear();
  }
}

module.exports = { SseHub };
