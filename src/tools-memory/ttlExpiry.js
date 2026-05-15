// src/workers/ttlExpiry.js
// Periodic background worker that deletes entries whose ttl is in the past.
// TDD Section 8.4 / Section 11.1: "setInterval worker: delete expired entries".

import { getDb } from "./db.js";
import { log } from "../utils/logger.js";

let _timer = null;

export function startTtlWorker({ intervalMs = 3_600_000 } = {}) {
  if (_timer) return _timer;

  function tick() {
    try {
      const db = getDb();
      const now = new Date().toISOString();
      const info = db
        .prepare("DELETE FROM memories WHERE ttl IS NOT NULL AND ttl < ?")
        .run(now);
      if (info.changes > 0) {
        log("info", `[ttl] expired ${info.changes} entries`);
      }
    } catch (err) {
      log("warn", `[ttl] worker tick failed: ${err.message}`);
    }
  }

  // Run once on boot to catch entries that expired while the service was down.
  tick();
  _timer = setInterval(tick, intervalMs);
  if (typeof _timer.unref === "function") _timer.unref();
  return _timer;
}

export function stopTtlWorker() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
