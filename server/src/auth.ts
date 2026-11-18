import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type DB, nowIso } from "./db.js";

export const TOKEN_PREFIX = "pk_";
export const SESSION_COOKIE = "pk_session";
/**
 * Sessions never expire on the server: they live until logout, token revocation or the browser drops the cookie.
 * Browsers cap persistent cookies (Chrome: 400 days), so the cookie is issued for the maximum and re-issued
 * on activity (see COOKIE_REFRESH_MS) — an active browser stays signed in indefinitely.
 */
export const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
export const COOKIE_REFRESH_MS = 24 * 60 * 60 * 1000;
const NEVER = "9999-12-31T23:59:59.999Z";

export interface TokenRow { id: number; name: string; kind: "owner" | "agent"; created_at: string; last_used_at: string | null; revoked_at: string | null }

/** Tokens are 32 random bytes; SHA-256 of a high-entropy secret is a sufficient at-rest hash. */
export const hashSecret = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

export function generateToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
}

export class Auth {
  constructor(private db: DB, private now: () => number = Date.now) {}

  hasTokens(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM api_tokens WHERE revoked_at IS NULL LIMIT 1`).get();
  }

  createToken(name: string, kind: "owner" | "agent"): { token: string; row: TokenRow } {
    const token = generateToken();
    const r = this.db.prepare(`INSERT INTO api_tokens(name, kind, token_hash, created_at) VALUES (?,?,?,?)`).run(name, kind, hashSecret(token), nowIso());
    return { token, row: this.db.prepare(`SELECT id, name, kind, created_at, last_used_at, revoked_at FROM api_tokens WHERE id = ?`).get(r.lastInsertRowid) as TokenRow };
  }

  listTokens(): TokenRow[] {
    return this.db.prepare(`SELECT id, name, kind, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY id`).all() as TokenRow[];
  }

  revokeToken(id: number): boolean {
    const r = this.db.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(nowIso(), id);
    this.db.prepare(`DELETE FROM sessions WHERE token_id = ?`).run(id);
    return r.changes > 0;
  }

  /** Constant-time lookup by hash (the hash is the index key, so timing does not reveal the secret). */
  verifyToken(token: string | undefined | null): TokenRow | null {
    if (!token || typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const row = this.db
      .prepare(`SELECT id, name, kind, created_at, last_used_at, revoked_at FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
      .get(hashSecret(token)) as TokenRow | undefined;
    if (!row) return null;
    this.db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`).run(nowIso(), row.id);
    return row;
  }

  /** New remembered session: random 256-bit id, only its SHA-256 is stored. */
  createSession(tokenId: number): { id: string } {
    const id = crypto.randomBytes(32).toString("base64url");
    const t = new Date(this.now()).toISOString();
    this.db.prepare(`INSERT INTO sessions(id_hash, token_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)`).run(hashSecret(id), tokenId, t, NEVER, t);
    return { id };
  }

  /**
   * Valid while the session row exists and its token is not revoked — no time-based expiry.
   * `refreshCookie` is true when the browser cookie should be re-issued (last refresh older than a day).
   */
  verifySession(id: string | undefined): (TokenRow & { refreshCookie: boolean }) | null {
    if (!id || id.length > 100) return null;
    const h = hashSecret(id);
    const row = this.db
      .prepare(
        `SELECT t.id, t.name, t.kind, t.created_at, t.last_used_at, t.revoked_at, s.last_seen_at FROM sessions s
         JOIN api_tokens t ON t.id = s.token_id
         WHERE s.id_hash = ? AND t.revoked_at IS NULL`,
      )
      .get(h) as (TokenRow & { last_seen_at: string | null }) | undefined;
    if (!row) return null;
    const t = this.now();
    const seen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    const refreshCookie = t - seen > COOKIE_REFRESH_MS;
    if (refreshCookie) this.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?`).run(new Date(t).toISOString(), h);
    const { last_seen_at: _ls, ...tok } = row;
    return { ...tok, refreshCookie };
  }

  listSessions(): { token_id: number; created_at: string; last_seen_at: string | null }[] {
    return this.db.prepare(`SELECT token_id, created_at, last_seen_at FROM sessions ORDER BY created_at`).all() as never;
  }

  deleteSession(id: string | undefined) {
    if (id) this.db.prepare(`DELETE FROM sessions WHERE id_hash = ?`).run(hashSecret(id));
  }

  /**
   * First start: create the owner token and write it to a 0600 file in the data directory.
   * The token itself is never logged.
   */
  bootstrap(dataDir: string, log: (m: string) => void) {
    if (this.hasTokens()) return;
    const { token } = this.createToken("owner", "owner");
    const file = path.join(dataDir, "bootstrap-token.txt");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, token + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    log(`Создан токен владельца. Он записан в ${file} (права 0600). Прочитайте его, войдите и удалите файл.`);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}
