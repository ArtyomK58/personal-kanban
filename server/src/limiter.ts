import net from "node:net";
import type { DB } from "./db.js";

/**
 * Persistent brute-force limiter for every place a secret is checked (UI login, Bearer on /api and /mcp).
 * State lives in SQLite, so restarts do not reset it. All methods are synchronous; the server checks,
 * verifies and records a failure inside one synchronous section, so concurrent requests cannot race
 * past the limit (better-sqlite3 + IMMEDIATE transactions also keep separate processes consistent).
 */
export interface LimiterConfig {
  ipMaxFailures: number;    // failures per client within ipWindowMs before a lock
  ipWindowMs: number;
  lockStepsMs: number[];    // progressive lock durations: 1st, 2nd, 3rd+ lock
  strikeResetMs: number;    // lock history is forgotten after this long without failures
  globalMaxFailures: number; // failures from all clients together within globalWindowMs
  globalWindowMs: number;
  globalLockMs: number;     // during a global lock only previously successful clients may try
  trustedTtlMs: number;     // how long a successful client stays "known"
}

export const DEFAULT_LIMITS: LimiterConfig = {
  ipMaxFailures: 5,
  ipWindowMs: 15 * 60_000,
  lockStepsMs: [5 * 60_000, 15 * 60_000, 60 * 60_000],
  strikeResetMs: 24 * 60 * 60_000,
  globalMaxFailures: 50,
  globalWindowMs: 15 * 60_000,
  globalLockMs: 15 * 60_000,
  trustedTtlMs: 90 * 24 * 60 * 60_000,
};

export type LimitDecision = { allowed: true } | { allowed: false; retryAfter: number; scope: "client" | "global" };

interface Row { key: string; window_start: number; failures: number; locked_until: number; strikes: number; last_failure: number }

/** Normalise a client address to a bucket key. IPv6 is grouped by /64 so rotating inside one prefix does not help. */
export function clientKey(ip: string | undefined | null): string {
  let a = (ip ?? "").trim();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (net.isIPv4(a)) return `ip:${a}`;
  if (net.isIPv6(a)) {
    const full = expandV6(a);
    return `ip6:${full.slice(0, 4).join(":")}::/64`;
  }
  return "ip:unknown";
}

function expandV6(a: string): string[] {
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((x) => x.toLowerCase().padStart(4, "0"));
}

export class AuthLimiter {
  constructor(private db: DB, readonly cfg: LimiterConfig = DEFAULT_LIMITS, private now: () => number = Date.now) {}

  private get(key: string): Row | undefined {
    return this.db.prepare(`SELECT * FROM auth_limits WHERE key = ?`).get(key) as Row | undefined;
  }

  private isTrusted(key: string, t: number) {
    const r = this.db.prepare(`SELECT last_success FROM trusted_clients WHERE key = ?`).get(key) as { last_success: number } | undefined;
    return !!r && t - r.last_success < this.cfg.trustedTtlMs;
  }

  /** May this client try a secret right now? Never reads or writes any board data. */
  check(ip: string | undefined): LimitDecision {
    const t = this.now();
    const key = clientKey(ip);
    const own = this.get(key);
    if (own && own.locked_until > t) return { allowed: false, retryAfter: Math.ceil((own.locked_until - t) / 1000), scope: "client" };
    const g = this.get("global");
    if (g && g.locked_until > t && !this.isTrusted(key, t)) return { allowed: false, retryAfter: Math.ceil((g.locked_until - t) / 1000), scope: "global" };
    return { allowed: true };
  }

  /** Record a failed attempt. Returns the decision for the NEXT attempt (locked or not). */
  fail(ip: string | undefined): LimitDecision {
    const t = this.now();
    const key = clientKey(ip);
    this.db.transaction(() => {
      this.bump(key, t, this.cfg.ipMaxFailures, this.cfg.ipWindowMs, (strikes) => this.cfg.lockStepsMs[Math.min(strikes, this.cfg.lockStepsMs.length) - 1]);
      this.bump("global", t, this.cfg.globalMaxFailures, this.cfg.globalWindowMs, () => this.cfg.globalLockMs);
    }).immediate();
    return this.check(ip);
  }

  private bump(key: string, t: number, max: number, windowMs: number, lockFor: (strikes: number) => number) {
    const r = this.get(key) ?? { key, window_start: t, failures: 0, locked_until: 0, strikes: 0, last_failure: 0 };
    if (t - r.window_start > windowMs) { r.window_start = t; r.failures = 0; }
    if (r.last_failure && t - r.last_failure > this.cfg.strikeResetMs) r.strikes = 0;
    r.failures += 1;
    r.last_failure = t;
    if (r.failures >= max) {
      r.strikes += 1;
      r.locked_until = Math.max(r.locked_until, t + lockFor(r.strikes));
      r.failures = 0;
      r.window_start = t;
    }
    this.db
      .prepare(
        `INSERT INTO auth_limits(key, window_start, failures, locked_until, strikes, last_failure) VALUES (@key,@window_start,@failures,@locked_until,@strikes,@last_failure)
         ON CONFLICT(key) DO UPDATE SET window_start=@window_start, failures=@failures, locked_until=@locked_until, strikes=@strikes, last_failure=@last_failure`,
      )
      .run(r);
  }

  /** A secret was correct: remember the client and clear only ITS failure counter (never other clients' locks). */
  success(ip: string | undefined) {
    const t = this.now();
    const key = clientKey(ip);
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO trusted_clients(key, last_success) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_success = excluded.last_success`)
        .run(key, t);
      this.db.prepare(`UPDATE auth_limits SET failures = 0 WHERE key = ?`).run(key);
      if (Math.random() < 0.01) this.db.prepare(`DELETE FROM trusted_clients WHERE last_success < ?`).run(t - this.cfg.trustedTtlMs);
    }).immediate();
  }

  /** Operator escape hatch (CLI): clear all locks and counters. */
  reset() {
    this.db.prepare(`DELETE FROM auth_limits`).run();
  }
}
