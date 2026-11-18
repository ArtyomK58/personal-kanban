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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-epics-"));
const dbFile = path.join(tmp, "kanban.db");
let db: DB;
let repo: Repo;
let auth: Auth;
let server: Server;
let base = "";
let ownerToken = "";
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

const web = (p: string, init: RequestInit = {}) =>
  fetch(`${base}${p}`, { ...init, headers: { "Content-Type": "application/json", "X-Kanban-Client": "web", Cookie: cookie, ...(init.headers ?? {}) } });
const webJson = async (p: string, init: RequestInit = {}) => {
  const r = await web(p, init);
  return { status: r.status, body: await r.json() };
};
async function mcp(token = agentToken) {
  const c = new Client({ name: "epics-test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
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
  ownerToken = fs.readFileSync(path.join(tmp, "bootstrap-token.txt"), "utf8").trim();
  agentToken = auth.createToken("codex", "agent").token;
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: ownerToken }) });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
});
afterAll(async () => {
  await stop().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("migration 3 on an existing (v2) database", () => {
  it("keeps every task, comment, tag, agent note, token and session; existing tasks become ordinary tasks", () => {
    const f = path.join(tmp, "v2.db");
    const v2 = new Database(f);
    const src = fs.readFileSync(new URL("../server/src/db.ts", import.meta.url), "utf8").split("`");
    v2.exec(src[1]); // migration 1
    v2.exec(src[3]); // migration 2
    v2.pragma("user_version = 2");
    const now = new Date().toISOString();
    v2.prepare(`INSERT INTO tasks(title, status, position, human_description, agent_notes, created_at, updated_at) VALUES ('Старая', 'review', 1, 'для человека', 'секрет агента', ?, ?)`).run(now, now);
    v2.prepare(`INSERT INTO tags(name, name_key, color, created_at) VALUES ('Дом', 'дом', 'amber', ?)`).run(now);
    v2.prepare(`INSERT INTO task_tags VALUES (1, 1)`).run();
    v2.prepare(`INSERT INTO comments(task_id, author, author_kind, body, created_at) VALUES (1, 'Вы', 'owner', 'коммент', ?)`).run(now);
    const a2 = new Auth(v2 as unknown as DB);
    const { token } = a2.createToken("owner", "owner");
    const sess = a2.createSession(1);
    v2.close();

    const m = openDb(f);
    expect(m.pragma("user_version", { simple: true })).toBe(6);
    expect(m.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(m.pragma("foreign_key_check")).toEqual([]);
    const r = new Repo(m);
    const t = r.getTask(1);
    expect(t).toMatchObject({ title: "Старая", status: "review", human_description: "для человека", kind: "task", epic_id: null, epic: null, progress: null });
    expect(t.tags.map((x) => x.name)).toEqual(["Дом"]);
    expect(t.comments.map((c) => c.body)).toEqual(["коммент"]);
    expect(r.getAgentNotes(1).agent_notes).toBe("секрет агента");
    const a3 = new Auth(m);
    expect(a3.verifyToken(token)).not.toBeNull();
    expect(a3.verifySession(sess.id)).not.toBeNull();
    m.close();
  });
});

describe("epics in the repository", () => {
  it("creates epics, attaches tasks, computes progress (no NaN for an empty epic) and keeps tags", () => {
    const pet = repo.createTag("Пет-бот", "teal");
    const infra = repo.createTag("Инфра", "slate");
    const epic = repo.createTask({ title: "Резервные копии", kind: "epic", tags: ["Пет-бот"] });
    expect(epic).toMatchObject({ kind: "epic", epic: null, progress: { done: 0, total: 0 } });
    const a = repo.createTask({ title: "Скрипт бэкапа", status: "done", epic_id: epic.id, tags: ["Пет-бот"] });
    const b = repo.createTask({ title: "Загрузка в S3", status: "review", tags: ["Пет-бот", "Инфра"] });
    expect(a.epic).toEqual({ id: epic.id, title: "Резервные копии" });
    const attached = repo.setTaskEpic(b.id, epic.id);
    expect(attached.tags.map((t) => t.id).sort()).toEqual([pet.id, infra.id].sort()); // own tags untouched
    expect(repo.getSummary(epic.id)!.progress).toEqual({ done: 1, total: 2 });
    repo.moveTask(b.id, { status: "done" });
    expect(repo.getSummary(epic.id)!.progress).toEqual({ done: 2, total: 2 });
    expect(repo.getSummary(epic.id)!.status).toBe("inbox"); // the epic's status is manual
    const d = repo.getTask(epic.id);
    expect(d.children!.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(repo.getTask(a.id).children).toBeUndefined();
  });

  it("rejects self-parent, nesting, unknown parent, non-epic parent and impossible kind changes", () => {
    const e1 = repo.createTask({ title: "Эпик 1", kind: "epic" });
    const e2 = repo.createTask({ title: "Эпик 2", kind: "epic" });
    const t = repo.createTask({ title: "Задача", epic_id: e1.id });
    const plain = repo.createTask({ title: "Обычная" });
    expect(() => repo.setTaskEpic(e1.id, e1.id)).toThrow(/самой себе/);
    expect(() => repo.setTaskEpic(e2.id, e1.id)).toThrow(/другой эпик/);
    expect(() => repo.createTask({ title: "x", kind: "epic", epic_id: e1.id })).toThrow(/другой эпик/);
    expect(() => repo.setTaskEpic(t.id, 999999)).toThrow(/не найден/);
    expect(() => repo.setTaskEpic(t.id, plain.id)).toThrow(/только эпик/);
    expect(() => repo.createTask({ title: "x", epic_id: plain.id })).toThrow(/только эпик/);
    expect(() => repo.updateTask(e1.id, { kind: "task" })).toThrow(/отвяжите/);
    expect(() => repo.updateTask(t.id, { kind: "epic" })).toThrow(/уберите эпик/);
    // detach + convert in one patch is fine
    expect(repo.updateTask(t.id, { epic_id: null, kind: "epic" })).toMatchObject({ kind: "epic", epic_id: null });
    expect(repo.updateTask(t.id, { kind: "task" }).kind).toBe("task");
    // an epic without children can become a task again
    expect(repo.updateTask(e2.id, { kind: "task" })).toMatchObject({ kind: "task", progress: null });
    expect(repo.getSummary(t.id)!.epic_id).toBeNull();
  });

  it("database triggers enforce the same rules for raw writes (second process safety)", () => {
    const e = repo.createTask({ title: "Эпик Т", kind: "epic" });
    const c = repo.createTask({ title: "Дочерняя", epic_id: e.id });
    const p = repo.createTask({ title: "Не эпик" });
    expect(() => db.prepare(`UPDATE tasks SET epic_id = id WHERE id = ?`).run(c.id)).toThrow(/epic_self/);
    expect(() => db.prepare(`UPDATE tasks SET epic_id = ? WHERE id = ?`).run(p.id, c.id)).toThrow(/epic_parent_not_epic/);
    expect(() => db.prepare(`UPDATE tasks SET kind = 'task' WHERE id = ?`).run(e.id)).toThrow(/epic_has_children/);
    expect(() => db.prepare(`UPDATE tasks SET kind = 'epic' WHERE id = ?`).run(c.id)).toThrow(/epic_nested/);
    expect(() => db.prepare(`UPDATE tasks SET kind = 'story' WHERE id = ?`).run(p.id)).toThrow(/CHECK/);
  });

  it("two connections racing (attach vs. convert-to-task) never leave a child under a non-epic", () => {
    const db2 = openDb(dbFile);
    const repo2 = new Repo(db2);
    try {
      const e = repo.createTask({ title: "Гонка", kind: "epic" });
      const t = repo.createTask({ title: "Кандидат" });
      repo2.updateTask(e.id, { kind: "task" }); // other process wins first
      expect(() => repo.setTaskEpic(t.id, e.id)).toThrow(/только эпик/);
      repo2.updateTask(e.id, { kind: "epic" });
      repo.setTaskEpic(t.id, e.id); // now attached
      expect(() => repo2.updateTask(e.id, { kind: "task" })).toThrow(/отвяжите/);
      // concurrent status changes from both connections: progress reflects the final state
      repo.moveTask(t.id, { status: "done" });
      repo2.moveTask(t.id, { status: "review" });
      expect(repo.getSummary(e.id)!.progress).toEqual({ done: 0, total: 1 });
      const orphans = db.prepare(`SELECT COUNT(*) AS n FROM tasks c JOIN tasks p ON p.id = c.epic_id WHERE p.kind != 'epic'`).get() as { n: number };
      expect(orphans.n).toBe(0);
    } finally {
      db2.close();
    }
  });

  it("deleting an epic keeps its tasks (they lose the epic)", () => {
    const e = repo.createTask({ title: "Удаляемый эпик", kind: "epic" });
    const c = repo.createTask({ title: "Остаётся", epic_id: e.id });
    repo.deleteTask(e.id);
    expect(repo.getSummary(c.id)).toMatchObject({ epic_id: null, epic: null });
  });

  it("filters: by epic (with/without the epic itself), tasks without an epic, by kind; AND with tags and search", () => {
    const e = repo.createTask({ title: "Напоминания", kind: "epic", tags: ["Пет-бот"] });
    const c1 = repo.createTask({ title: "Команда remind", epic_id: e.id, tags: ["Пет-бот"] });
    const c2 = repo.createTask({ title: "Отправка по таймеру", epic_id: e.id, tags: ["Инфра"] });
    const ids = (xs: { id: number }[]) => xs.map((x) => x.id).sort((a, b) => a - b);
    expect(ids(repo.listTasks({ epicId: e.id }))).toEqual([c1.id, c2.id]);
    expect(ids(repo.listTasks({ epicId: e.id, includeEpic: true }))).toEqual([e.id, c1.id, c2.id]);
    expect(ids(repo.listTasks({ epicId: e.id, includeEpic: true, tags: ["Инфра"] }))).toEqual([c2.id]);
    expect(ids(repo.listTasks({ epicId: e.id, includeEpic: true, query: "таймеру" }))).toEqual([c2.id]);
    expect(repo.listTasks({ epicId: "none" }).every((t) => t.kind === "task" && t.epic_id === null)).toBe(true);
    expect(repo.listTasks({ kind: "epic" }).every((t) => t.kind === "epic")).toBe(true);
    expect(repo.listEpics().find((x) => x.id === e.id)).toMatchObject({ title: "Напоминания", progress: { done: 0, total: 2 } });
  });
});

describe("REST API for the UI", () => {
  it("board: ?epic filter, epics list, progress on cards; create/patch with kind and epic_id", async () => {
    const { body: epic } = await webJson("/api/tasks", { method: "POST", body: JSON.stringify({ title: "UI-эпик", kind: "epic" }) });
    expect(epic.kind).toBe("epic");
    const { body: child } = await webJson("/api/tasks", { method: "POST", body: JSON.stringify({ title: "UI-дочерняя", epic_id: epic.id }) });
    expect(child.epic).toEqual({ id: epic.id, title: "UI-эпик" });
    const { body: board } = await webJson(`/api/board?epic=${epic.id}`);
    expect(board.tasks.map((t: { id: number }) => t.id).sort()).toEqual([epic.id, child.id].sort());
    expect(board.total).toBeGreaterThan(board.tasks.length);
    expect(board.epics.find((e: { id: number }) => e.id === epic.id).progress).toEqual({ done: 0, total: 1 });
    const { body: epicDetail } = await webJson(`/api/tasks/${epic.id}`);
    expect(epicDetail.children.map((c: { id: number }) => c.id)).toEqual([child.id]);
    expect(JSON.stringify(epicDetail)).not.toContain("agent_notes");
    const { body: detached } = await webJson(`/api/tasks/${child.id}`, { method: "PATCH", body: JSON.stringify({ epic_id: null }) });
    expect(detached.epic).toBeNull();
    const bad = await webJson(`/api/tasks/${epic.id}`, { method: "PATCH", body: JSON.stringify({ epic_id: epic.id }) });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe("epic_self");
    expect((await webJson(`/api/board?epic=abc`)).status).toBe(400);
    const missing = await webJson(`/api/board?epic=999999`);
    expect(missing.body.tasks).toEqual([]);
  });
});

describe("MCP (real SDK client)", () => {
  it("old calls keep working and new fields are present", async () => {
    const c = await mcp();
    const t = await call(c, "create_task", { title: "Старый вызов", status: "inbox" });
    expect(t).toMatchObject({ kind: "task", epic_id: null, epic: null, progress: null });
    const upd = await call(c, "update_task", { id: t.id, title: "Старый вызов 2", status: "review" });
    expect(upd.status).toBe("review");
    const list = await call(c, "list_tasks", { query: "Старый" });
    expect(list.tasks[0]).toHaveProperty("kind", "task");
    const g = await call(c, "get_task", { id: t.id });
    expect(g.agent_view).toBeDefined();
    await c.close();
  });

  it("create/get/list epics, attach/move/detach, filters, errors; round-trip with the UI API", async () => {
    const c = await mcp();
    const epic = await call(c, "create_task", { title: "MCP-эпик", kind: "epic", tags: ["Пет-бот"], human_description: "видно человеку", agent_notes: "EPICHIDDEN" });
    const other = await call(c, "create_task", { title: "MCP-эпик 2", kind: "epic" });
    const child = await call(c, "create_task", { title: "MCP-дочерняя", epic_id: epic.id, agent_notes: "CHILDHIDDEN" });
    const loose = await call(c, "create_task", { title: "MCP-свободная", tags: ["Инфра"] });

    let e = await call(c, "get_epic", { id: epic.id, include_agent_notes: true });
    expect(e.progress).toEqual({ done: 0, total: 1 });
    expect(e.children.map((x: { id: number }) => x.id)).toEqual([child.id]);
    expect(e.agent_view.agent_notes).toBe("EPICHIDDEN");
    expect((await call(c, "get_task", { id: child.id })).agent_view.agent_notes).toBe("CHILDHIDDEN"); // independent notes

    const attached = await call(c, "set_task_epic", { id: loose.id, epic_id: epic.id });
    expect(attached.tags.map((x: { name: string }) => x.name)).toEqual(["Инфра"]);
    await call(c, "move_task", { id: child.id, status: "done" });
    e = await call(c, "get_epic", { id: epic.id });
    expect(e.progress).toEqual({ done: 1, total: 2 });

    // UI sees MCP changes
    const ui = (await webJson(`/api/tasks/${epic.id}`)).body;
    expect(ui.progress).toEqual({ done: 1, total: 2 });
    expect(JSON.stringify(ui)).not.toContain("EPICHIDDEN");
    // MCP sees UI changes (move to another epic from the UI)
    await webJson(`/api/tasks/${loose.id}`, { method: "PATCH", body: JSON.stringify({ epic_id: other.id }) });
    expect((await call(c, "get_task", { id: loose.id })).epic).toEqual({ id: other.id, title: "MCP-эпик 2" });

    const byEpic = await call(c, "list_tasks", { epic_id: epic.id });
    expect(byEpic.tasks.map((x: { id: number }) => x.id)).toEqual([child.id]);
    const withEpic = await call(c, "list_tasks", { epic_id: epic.id, include_epic: true });
    expect(withEpic.count).toBe(2);
    const noEpic = await call(c, "list_tasks", { epic_id: "none", limit: 500 });
    expect(noEpic.tasks.some((x: { id: number }) => x.id === loose.id || x.id === child.id)).toBe(false);
    const epicsOnly = await call(c, "list_tasks", { kind: "epic", limit: 500 });
    expect(epicsOnly.tasks.every((x: { kind: string }) => x.kind === "epic")).toBe(true);
    const le = await call(c, "list_epics", { tags: ["Пет-бот"] });
    expect(le.epics.find((x: { id: number }) => x.id === epic.id)).toMatchObject({ progress: { done: 1, total: 1 } });

    const detached = await call(c, "set_task_epic", { id: loose.id, epic_id: null });
    expect(detached.epic).toBeNull();
    const viaUpdate = await call(c, "update_task", { id: loose.id, epic_id: epic.id });
    expect(viaUpdate.epic_id).toBe(epic.id);

    await expect(call(c, "get_epic", { id: loose.id })).rejects.toThrow(/not_epic/);
    await expect(call(c, "set_task_epic", { id: other.id, epic_id: epic.id })).rejects.toThrow(/epic_nested/);
    await expect(call(c, "set_task_epic", { id: loose.id, epic_id: loose.id })).rejects.toThrow(/epic_self/);
    await expect(call(c, "set_task_epic", { id: loose.id, epic_id: 999999 })).rejects.toThrow(/epic_parent_missing/);
    await expect(call(c, "update_task", { id: epic.id, kind: "task" })).rejects.toThrow(/epic_has_children/);
    await c.close();
  });
});

describe("persistence", () => {
  it("epics, links and progress survive a restart", async () => {
    const e = repo.createTask({ title: "Переживёт рестарт", kind: "epic" });
    const ch = repo.createTask({ title: "Ребёнок", epic_id: e.id, status: "done" });
    await stop();
    await start();
    expect(repo.getSummary(e.id)).toMatchObject({ kind: "epic", progress: { done: 1, total: 1 } });
    expect(repo.getSummary(ch.id)!.epic).toEqual({ id: e.id, title: "Переживёт рестарт" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
