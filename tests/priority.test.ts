import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../server/src/app.js";
import { Auth } from "../server/src/auth.js";
import { openDb, type DB } from "../server/src/db.js";
import { Repo } from "../server/src/repo.js";
import { AuthLimiter } from "../server/src/limiter.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-priority-"));
const dbFile = path.join(tmp, "kanban.db");
let db: DB;
let repo: Repo;
let auth: Auth;
let server: Server;
let base = "";
let agentToken = "";
let cookie = "";

async function start() {
  db = openDb(dbFile);
  repo = new Repo(db);
  auth = new Auth(db);
  const app = createApp({ repo, auth, limiter: new AuthLimiter(db) });
  server = await new Promise<Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function stop() {
  await new Promise((r) => server.close(r));
  db.close();
}
const web = async (p: string, init: RequestInit = {}) => {
  const r = await fetch(`${base}${p}`, { ...init, headers: { "Content-Type": "application/json", "X-Kanban-Client": "web", Cookie: cookie } });
  return { status: r.status, body: await r.json() };
};
async function mcp() {
  const c = new Client({ name: "priority-test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${agentToken}` } } }));
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

beforeAll(async () => {
  await start();
  auth.bootstrap(tmp, () => {});
  const owner = fs.readFileSync(path.join(tmp, "bootstrap-token.txt"), "utf8").trim();
  agentToken = auth.createToken("codex", "agent").token;
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: owner }) });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
});
afterAll(async () => {
  await stop().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("migration 4 (priority) on an existing v3 database with epics", () => {
  it("existing tasks and epics become normal; links, notes, tokens and sessions are kept", () => {
    const f = path.join(tmp, "v3.db");
    const v3 = new Database(f);
    const src = fs.readFileSync(new URL("../server/src/db.ts", import.meta.url), "utf8").split("`");
    v3.exec(src[1]); v3.exec(src[3]); v3.exec(src[5]); // migrations 1–3
    v3.pragma("user_version = 3");
    const now = new Date().toISOString();
    const ins = v3.prepare(`INSERT INTO tasks(title, status, position, agent_notes, created_at, updated_at, kind, epic_id) VALUES (?,?,?,?,?,?,?,?)`);
    ins.run("Эпик", "in_progress", 1, "заметка эпика", now, now, "epic", null);
    ins.run("Дочерняя", "review", 2, "заметка задачи", now, now, "task", 1);
    const a3 = new Auth(v3 as unknown as DB);
    const { token } = a3.createToken("owner", "owner");
    const sess = a3.createSession(1);
    v3.close();

    const m = openDb(f);
    expect(m.pragma("user_version", { simple: true })).toBe(6);
    expect(m.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(m.pragma("foreign_key_check")).toEqual([]);
    const r = new Repo(m);
    expect(r.getSummary(1)).toMatchObject({ kind: "epic", priority: "normal", status: "in_progress", progress: { done: 0, total: 1 } });
    expect(r.getSummary(2)).toMatchObject({ epic_id: 1, priority: "normal", status: "review", frozen: false });
    expect(r.getAgentNotes(2).agent_notes).toBe("заметка задачи");
    const a4 = new Auth(m);
    expect(a4.verifyToken(token)).not.toBeNull();
    expect(a4.verifySession(sess.id)).not.toBeNull();
    expect(() => m.prepare(`UPDATE tasks SET priority = 'urgent' WHERE id = 1`).run()).toThrow(/CHECK/);
    m.close();
  });
});

describe("priority in the repository", () => {
  it("defaults to normal, validates, partial updates keep it, independent of epic/children and order", () => {
    const t = repo.createTask({ title: "По умолчанию" });
    expect(t.priority).toBe("normal");
    const h = repo.createTask({ title: "Важная", priority: "high", status: "in_progress" });
    expect(h.priority).toBe("high");
    expect(() => repo.createTask({ title: "x", priority: "urgent" as never })).toThrow(/приоритет/);
    expect(() => repo.updateTask(h.id, { priority: "critical" as never })).toThrow(/приоритет/);
    expect(repo.updateTask(h.id, { title: "Важная 2" }).priority).toBe("high"); // partial update keeps it
    expect(repo.updateTask(h.id, { status: "review" }).priority).toBe("high");
    // priority does not reorder the column
    const a = repo.createTask({ title: "A", status: "done", place: "bottom", priority: "low" });
    const b = repo.createTask({ title: "B", status: "done", place: "bottom", priority: "high" });
    const order = () => repo.listTasks({ status: "done" }).map((x) => x.id);
    const before = order();
    repo.updateTask(a.id, { priority: "high" });
    repo.updateTask(b.id, { priority: "low" });
    expect(order()).toEqual(before);
    // moving keeps priority
    expect(repo.moveTask(b.id, { status: "inbox", index: 0 }).priority).toBe("low");
    // epics: independent, no inheritance either way
    const e = repo.createTask({ title: "Эпик П", kind: "epic", priority: "low" });
    const c = repo.createTask({ title: "Дочь П", epic_id: e.id, priority: "high" });
    expect(repo.getSummary(c.id)!.priority).toBe("high");
    repo.updateTask(e.id, { priority: "high" });
    const c2 = repo.createTask({ title: "Дочь 2", epic_id: e.id });
    expect(c2.priority).toBe("normal");
    expect(repo.setTaskEpic(c.id, null).priority).toBe("high");
    expect(repo.setTaskEpic(c.id, e.id).priority).toBe("high");
    expect(repo.getTask(e.id).children!.map((x) => x.priority).sort()).toEqual(["high", "normal"]);
    expect(repo.listEpics().find((x) => x.id === e.id)!.priority).toBe("high");
    // filter
    expect(repo.listTasks({ priority: "high" }).every((x) => x.priority === "high")).toBe(true);
    expect(repo.listTasks({ priority: ["low", "high"] }).some((x) => x.priority === "normal")).toBe(false);
    expect(() => repo.listTasks({ priority: "x" as never })).toThrow(/приоритет/);
  });
});

describe("REST and MCP", () => {
  it("freezes via REST and unfreezes via MCP while preserving status, priority and position", async () => {
    const card = repo.createTask({ title: "Отложить проверку", status: "review", priority: "high" });
    expect(card.frozen).toBe(false);
    const { body: frozen } = await web(`/api/tasks/${card.id}`, { method: "PATCH", body: JSON.stringify({ frozen: true }) });
    expect(frozen).toMatchObject({ frozen: true, status: "review", priority: "high", position: card.position });
    const { body: board } = await web("/api/board");
    expect(board.tasks.find((task: { id: number }) => task.id === card.id).frozen).toBe(true);
    const c = await mcp();
    try {
      const list = await call(c, "list_tasks", { frozen: true });
      expect(list.tasks.map((task: { id: number }) => task.id)).toEqual([card.id]);
      await call(c, "update_task", { id: card.id, frozen: false });
      expect((await web(`/api/tasks/${card.id}`)).body).toMatchObject({ frozen: false, status: "review", priority: "high", position: card.position });
    } finally { await c.close(); }
  });
  it("UI API: create without priority = normal, patch priority, other patches keep it; invalid rejected", async () => {
    const { body: t } = await web("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Из UI" }) });
    expect(t.priority).toBe("normal");
    expect((await web(`/api/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ priority: "low" }) })).body.priority).toBe("low");
    expect((await web(`/api/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ due_date: "2030-01-01" }) })).body.priority).toBe("low");
    expect((await web(`/api/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ priority: "urgent" }) })).status).toBe(400);
    const { body: board } = await web("/api/board");
    expect(board.priorities.map((p: { id: string }) => p.id)).toEqual(["low", "normal", "high"]);
    expect(board.tasks.find((x: { id: number }) => x.id === t.id).priority).toBe("low");
  });

  it("MCP: old calls compatible; create/update/filter priority; round-trip with the UI", async () => {
    const c = await mcp();
    const tools = (await c.listTools()).tools;
    expect(tools.length).toBe(19);
    const schema = (n: string) => JSON.stringify(tools.find((t) => t.name === n)!.inputSchema);
    for (const n of ["create_task", "update_task", "list_tasks", "list_epics"]) expect(schema(n)).toContain('"priority"');
    const old = await call(c, "create_task", { title: "Старый вызов" });
    expect(old.priority).toBe("normal");
    expect((await call(c, "update_task", { id: old.id, status: "review" })).priority).toBe("normal");
    const hi = await call(c, "create_task", { title: "MCP высокий", priority: "high" });
    expect((await call(c, "get_task", { id: hi.id })).priority).toBe("high");
    expect((await call(c, "update_task", { id: hi.id, title: "MCP высокий 2" })).priority).toBe("high");
    expect((await call(c, "update_task", { id: hi.id, priority: "low" })).priority).toBe("low");
    const lows = await call(c, "list_tasks", { priority: "low", limit: 500 });
    expect(lows.tasks.some((x: { id: number }) => x.id === hi.id) && lows.tasks.every((x: { priority: string }) => x.priority === "low")).toBe(true);
    expect((await call(c, "list_tasks", { priority: ["high", "low"], query: "MCP" })).count).toBe(1);
    await expect(call(c, "update_task", { id: hi.id, priority: "urgent" })).rejects.toThrow();
    // UI → MCP
    await web(`/api/tasks/${hi.id}`, { method: "PATCH", body: JSON.stringify({ priority: "high" }) });
    expect((await call(c, "get_task", { id: hi.id })).priority).toBe("high");
    // MCP → UI
    await call(c, "update_task", { id: hi.id, priority: "normal" });
    expect((await web(`/api/tasks/${hi.id}`)).body.priority).toBe("normal");
    // epics via MCP
    const e = await call(c, "create_task", { title: "MCP эпик", kind: "epic", priority: "high" });
    await call(c, "set_task_epic", { id: hi.id, epic_id: e.id });
    const ge = await call(c, "get_epic", { id: e.id });
    expect(ge.priority).toBe("high");
    expect(ge.children[0].priority).toBe("normal");
    expect((await call(c, "list_epics", { priority: "high" })).epics.some((x: { id: number }) => x.id === e.id)).toBe(true);
    expect((await call(c, "move_task", { id: hi.id, status: "done" })).priority).toBe("normal");
    await c.close();
  });

  it("priority survives a restart", async () => {
    const t = repo.createTask({ title: "Рестарт", priority: "low" });
    await stop();
    await start();
    expect(repo.getSummary(t.id)!.priority).toBe("low");
  });
});
