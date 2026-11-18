/**
 * Token management:
 *   node dist/server/cli.js token create <name> [--owner]   → prints a NEW token once (store it in your MCP client config)
 *   node dist/server/cli.js token list
 *   node dist/server/cli.js token revoke <id>
 *   node dist/server/cli.js seed-demo                         → synthetic demo projects and tasks (empty board only)
 *   node dist/server/cli.js sessions list                     → remembered browser sessions (no secrets)
 *   node dist/server/cli.js limits status|reset               → brute-force limiter state / clear all locks
 */
import { Auth } from "./auth.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { Repo } from "./repo.js";
import { seedDemo } from "./seed.js";
import { AuthLimiter } from "./limiter.js";

const cfg = loadConfig();
const db = openDb(cfg.dbFile);
const auth = new Auth(db);
const [cmd, sub, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error("usage: token create <name> [--owner] | token list | token revoke <id> | sessions list | limits status|reset | seed-demo");
  process.exit(2);
}

if (cmd === "token" && sub === "create") {
  const name = rest.find((a) => !a.startsWith("--"));
  if (!name) usage();
  const { token, row } = auth.createToken(name, rest.includes("--owner") ? "owner" : "agent");
  // Printed to the operator's terminal only (not to server logs).
  console.log(`token id=${row.id} name=${row.name} kind=${row.kind}`);
  console.log(token);
} else if (cmd === "token" && sub === "list") {
  for (const t of auth.listTokens())
    console.log(`${t.id}\t${t.kind}\t${t.name}\tcreated ${t.created_at}\tlast used ${t.last_used_at ?? "-"}${t.revoked_at ? `\tREVOKED ${t.revoked_at}` : ""}`);
} else if (cmd === "token" && sub === "revoke") {
  const id = Number(rest[0]);
  if (!id) usage();
  console.log(auth.revokeToken(id) ? `revoked ${id}` : `token ${id} not found or already revoked`);
} else if (cmd === "sessions" && sub === "list") {
  for (const s of auth.listSessions()) console.log(`token ${s.token_id}\tcreated ${s.created_at}\tlast seen ${s.last_seen_at ?? "-"}`);
} else if (cmd === "limits" && sub === "status") {
  for (const r of db.prepare(`SELECT * FROM auth_limits ORDER BY key`).all() as { key: string; failures: number; strikes: number; locked_until: number }[])
    console.log(`${r.key}\tfailures ${r.failures}\tstrikes ${r.strikes}\tlocked until ${r.locked_until > Date.now() ? new Date(r.locked_until).toISOString() : "-"}`);
} else if (cmd === "limits" && sub === "reset") {
  new AuthLimiter(db).reset();
  console.log("all limiter counters and locks cleared");
} else if (cmd === "seed-demo") {
  const repo = new Repo(db);
  console.log(seedDemo(repo) ? "demo data created" : "board is not empty — nothing done");
} else usage();
db.close();
