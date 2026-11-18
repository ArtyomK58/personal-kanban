import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../server/src/app.js";
import { Auth, COOKIE_MAX_AGE_MS } from "../server/src/auth.js";
import { migrate, openDb, type DB } from "../server/src/db.js";
import { AuthLimiter, DEFAULT_LIMITS, clientKey } from "../server/src/limiter.js";
import { Repo } from "../server/src/repo.js";
import { parseTrustProxy } from "../server/src/config.js";

const DAY = 864e5;
let tmp: string;
let dbFile: string;
let db: DB;
let clock: number;
const now = () => clock;
let server: Server | undefined;
let base = "";
let token = "";

function boot(trustProxy: false | string[] = false) {
  db = openDb(dbFile);
  const auth = new Auth(db, now);
  const limiter = new AuthLimiter(db, DEFAULT_LIMITS, now);
  const repo = new Repo(db);
  return { auth, limiter, repo, app: createApp({ repo, auth, limiter, trustProxy }) };
}
async function listen(app: ReturnType<typeof createApp>) {
  server = await new Promise<Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function stop() {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  db.close();
}
const login = (t: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ token: t }) });

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-auth-"));
  dbFile = path.join(tmp, "kanban.db");
  clock = Date.parse("2026-11-15T12:00:00Z");
  const b = boot();
  token = b.auth.createToken("owner", "owner").token;
  await listen(b.app);
});
afterEach(async () => {
  await stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("remembered login", () => {
  it("issues a max-age persistent cookie and stays valid long after the old 30-day TTL", async () => {
    const r = await login(token);
    const sc = r.headers.get("set-cookie")!;
    const maxAge = Number(/Max-Age=(\d+)/i.exec(sc)![1]);
    expect(maxAge * 1000).toBe(COOKIE_MAX_AGE_MS); // 400 days, the browser cap
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    const cookie = sc.split(";")[0];
    for (const days of [31, 200, 399, 800, 3650]) {
      clock += (days - (clock - Date.parse("2026-11-15T12:00:00Z")) / DAY) * DAY;
      const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
      expect(me.status, `after ${days} days`).toBe(200);
      // activity re-issues the cookie (sliding browser-side cap)
      expect(me.headers.get("set-cookie") ?? "").toMatch(/pk_session=.*Max-Age=34560000/);
    }
  });

  it("survives a server restart / container recreate (same DB) and old pre-migration sessions stay valid", async () => {
    const cookie = (await login(token)).headers.get("set-cookie")!.split(";")[0];
    await stop();
    clock += 45 * DAY;
    const b = boot();
    await listen(b.app);
    expect((await fetch(`${base}/api/board`, { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("migration 2 keeps sessions created under the old 30-day schema", async () => {
    await stop();
    // build an old (v1) database with a session whose expires_at is already in the past
    const f = path.join(tmp, "old.db");
    const v1 = new Database(f);
    v1.exec(fs.readFileSync(new URL("../server/src/db.ts", import.meta.url), "utf8").split("`")[1]); // migration 1 SQL
    v1.pragma("user_version = 1");
    const a1 = new Auth(v1 as unknown as DB, now);
    const { token: t1, row } = a1.createToken("owner", "owner");
    const crypto = await import("node:crypto");
    const sid = "legacy-session-id";
    v1.prepare(`INSERT INTO sessions(id_hash, token_id, created_at, expires_at) VALUES (?,?,?,?)`).run(
      crypto.createHash("sha256").update(sid).digest("hex"), row.id, "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z",
    );
    v1.close();
    dbFile = f;
    const b = boot();
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    await listen(b.app);
    expect((await fetch(`${base}/api/auth/me`, { headers: { Cookie: `pk_session=${sid}` } })).status).toBe(200);
    expect(b.auth.verifyToken(t1)).not.toBeNull();
    migrate(db); // idempotent
    expect(db.pragma("user_version", { simple: true })).toBe(6);
  });

  it("logout and token revocation end the session; stale cookies are cleared", async () => {
    const { auth } = { auth: new Auth(db, now) };
    const c1 = (await login(token)).headers.get("set-cookie")!.split(";")[0];
    const c2 = (await login(token)).headers.get("set-cookie")!.split(";")[0];
    await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: c1, "X-Kanban-Client": "web" } });
    const r = await fetch(`${base}/api/board`, { headers: { Cookie: c1 } });
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toMatch(/pk_session=;/);
    expect((await fetch(`${base}/api/board`, { headers: { Cookie: c2 } })).status).toBe(200);
    auth.revokeToken(auth.listTokens()[0].id);
    expect((await fetch(`${base}/api/board`, { headers: { Cookie: c2 } })).status).toBe(401);
    expect((await login(token)).status).toBe(401);
  });
});

describe("brute-force limiter", () => {
  it("locks a client after 5 failures with Retry-After, progressive 5 → 15 → 60 min, then recovers", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await login("pk_bad" + i)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    let r = await login(token); // even the right token is refused while locked
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBe(300);
    clock += 301_000;
    for (let i = 0; i < 5; i++) await login("pk_bad");
    r = await login("pk_bad");
    expect(Number(r.headers.get("retry-after"))).toBe(900);
    clock += 901_000;
    for (let i = 0; i < 5; i++) await login("pk_bad");
    r = await login("pk_bad");
    expect(Number(r.headers.get("retry-after"))).toBe(3600);
    clock += 3601_000;
    for (let i = 0; i < 5; i++) await login("pk_bad");
    expect(Number((await login("pk_bad")).headers.get("retry-after"))).toBe(3600); // capped
    clock += 3601_000 + DEFAULT_LIMITS.strikeResetMs; // a quiet day forgets the history
    expect((await login(token)).status).toBe(200);
    for (let i = 0; i < 5; i++) await login("pk_bad");
    expect(Number((await login("pk_bad")).headers.get("retry-after"))).toBe(300);
  });

  it("the lock survives a restart", async () => {
    for (let i = 0; i < 5; i++) await login("pk_bad");
    await stop();
    const b = boot();
    await listen(b.app);
    const r = await login(token);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("parallel guesses cannot exceed the limit", async () => {
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => login("pk_parallel_" + i)));
    const codes = rs.map((r) => r.status);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(35);
  });

  it("Bearer on /api and /mcp share the same budget as the login form", async () => {
    for (let i = 0; i < 2; i++) await login("pk_bad");
    for (let i = 0; i < 2; i++) await fetch(`${base}/api/board`, { headers: { Authorization: "Bearer pk_bad" } });
    const m = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer pk_bad", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    expect(m.status).toBe(401);
    const locked = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBe(300);
    expect((await login(token)).status).toBe(429);
  });

  it("successful requests do not consume the failure budget", async () => {
    for (let i = 0; i < 4; i++) await login("pk_bad");
    for (let i = 0; i < 30; i++) expect((await fetch(`${base}/api/board`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    // success cleared only this client's counter, so 4 more failures still do not lock
    for (let i = 0; i < 4; i++) expect((await login("pk_bad")).status).toBe(401);
  });

  it("a success from one client never unlocks another; a global storm spares known clients", async () => {
    await stop();
    const b = boot(["loopback"]); // trust the local test client as a proxy hop to simulate many client IPs
    await listen(b.app);
    const as = (ip: string) => ({ "X-Forwarded-For": ip });
    expect((await login(token, as("198.51.100.7"))).status).toBe(200); // owner's usual address
    for (let i = 0; i < 5; i++) await login("pk_bad", as("203.0.113.1"));
    expect((await login(token, as("198.51.100.7"))).status).toBe(200);
    expect((await login(token, as("203.0.113.1"))).status).toBe(429); // still locked
    // distributed attack: 50 failures from many addresses → global lock
    for (let i = 0; i < 50; i++) await login("pk_bad", as(`192.0.2.${i + 1}`));
    const fresh = await login(token, as("192.0.2.200"));
    expect(fresh.status).toBe(429);
    expect((await fresh.json()).scope).toBe("global");
    expect((await login(token, as("198.51.100.7"))).status).toBe(200); // known owner address still gets in
    clock += DEFAULT_LIMITS.globalLockMs + 1000;
    expect((await login(token, as("192.0.2.200"))).status).toBe(200);
  });

  it("a forged X-Forwarded-For is ignored unless the hop is a trusted proxy", async () => {
    for (let i = 0; i < 5; i++) await login("pk_bad", { "X-Forwarded-For": `10.9.9.${i}`, "X-Real-IP": `10.8.8.${i}` });
    expect((await login(token, { "X-Forwarded-For": "10.1.2.3" })).status).toBe(429);
  });

  it("normalises client keys", () => {
    expect(clientKey("::ffff:1.2.3.4")).toBe("ip:1.2.3.4");
    expect(clientKey("2001:db8:1:2:aaaa::1")).toBe(clientKey("2001:db8:1:2:ffff:1:2:3"));
    expect(clientKey("2001:db8:1:2::1")).not.toBe(clientKey("2001:db8:1:3::1"));
    expect(parseTrustProxy("1")).toEqual(["loopback"]);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("loopback, 172.16.0.0/12")).toEqual(["loopback", "172.16.0.0/12"]);
  });
});

describe("MCP with the limiter", () => {
  it("valid token works, invalid is rejected, both counted correctly", async () => {
    const mk = (t: string) => {
      const c = new Client({ name: "t", version: "1" });
      return c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${t}` } } })).then(() => c);
    };
    await expect(mk("pk_wrong")).rejects.toThrow(/401|Unauthorized/);
    const c = await mk(token);
    expect((await c.listTools()).tools.length).toBe(19);
    await c.close();
  });
});
