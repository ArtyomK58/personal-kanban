import path from "node:path";

export function loadConfig() {
  const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
  return {
    dataDir,
    dbFile: process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, "kanban.db"),
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? "127.0.0.1",
    cookieSecure: process.env.COOKIE_SECURE === "1" || process.env.COOKIE_SECURE === "true",
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    webDir: path.resolve(process.env.WEB_DIR ?? new URL("../web", import.meta.url).pathname),
  };
}

export const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

/**
 * TRUST_PROXY: empty/0/false → do not trust X-Forwarded-For at all (direct exposure).
 * Otherwise a comma-separated list of proxy addresses/subnets (or Express keywords loopback/uniquelocal)
 * whose X-Forwarded-For is believed, e.g. "loopback,172.16.0.0/12" for Caddy on the host → Docker bridge.
 * "1"/"true" is treated as "loopback" (never "trust everyone").
 */
export function parseTrustProxy(v: string | undefined): false | string[] {
  const s = (v ?? "").trim();
  if (!s || s === "0" || s.toLowerCase() === "false") return false;
  if (s === "1" || s.toLowerCase() === "true") return ["loopback"];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
