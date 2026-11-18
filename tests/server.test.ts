import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../server/src/app.js";
import { Auth } from "../server/src/auth.js";
import { openDb } from "../server/src/db.js";
import { Repo } from "../server/src/repo.js";
import { AuthLimiter } from "../server/src/limiter.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-test-"));
const dbFile = path.join(tmp, "kanban.db");
let db = openDb(dbFile);
let repo = new Repo(db);
let auth = new Auth(db);
let limiter = new AuthLimiter(db);
let server: Server;
let base = "";
let ownerToken = "";
let agentToken = "";

async function startServer() {
  const app = createApp({ repo, auth, limiter });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  auth.bootstrap(tmp, () => {});
  ownerToken = fs.readFileSync(path.join(tmp, "bootstrap-token.txt"), "utf8").trim();
  agentToken = auth.createToken("claude", "agent").token;
  await startServer();
});
afterAll(() => {
  server?.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function login(token: string) {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  return r;
}
let cookie = "";
const web = (p: string, init: RequestInit = {}) =>
  fetch(`${base}${p}`, { ...init, headers: { "Content-Type": "application/json", "X-Kanban-Client": "web", Cookie: cookie, ...(init.headers ?? {}) } });

async function mcpClient(token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: "kanban-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
const callJson = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

describe("bootstrap & token auth", () => {
  it("writes the owner token to a 0600 file once", () => {
    const st = fs.statSync(path.join(tmp, "bootstrap-token.txt"));
    expect(st.mode & 0o777).toBe(0o600);
    expect(ownerToken).toMatch(/^pk_[A-Za-z0-9_-]{40,}$/);
    auth.bootstrap(tmp, () => {}); // second call: no new owner token
    expect(auth.listTokens().filter((t) => t.kind === "owner")).toHaveLength(1);
  });

  it("stores only hashes", () => {
    const raw = fs.readFileSync(dbFile);
    expect(raw.includes(Buffer.from(ownerToken))).toBe(false);
  });

  it("rejects the API without auth", async () => {
    expect((await fetch(`${base}/api/board`)).status).toBe(401);
    expect((await fetch(`${base}/api/tasks/1`)).status).toBe(401);
  });

  it("rejects a wrong token and accepts the right one with a strict HttpOnly cookie", async () => {
    const bad = await login("pk_wrong");
    expect(bad.status).toBe(401);
    expect((await bad.json()).message).toBe("Неверный токен");
    const ok = await login(ownerToken);
    expect(ok.status).toBe(200);
    const sc = ok.headers.get("set-cookie")!;
    expect(sc).toMatch(/pk_session=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).not.toContain(ownerToken);
    cookie = sc.split(";")[0];
    const me = await (await web("/api/auth/me")).json();
    expect(me).toMatchObject({ authenticated: true, name: "owner" });
  });

  it("requires the client header for cookie mutations (CSRF)", async () => {
    const r = await fetch(`${base}/api/tags`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: "X" }) });
    expect(r.status).toBe(403);
  });

  it("accepts Bearer for the REST API", async () => {
    const r = await fetch(`${base}/api/board`, { headers: { Authorization: `Bearer ${agentToken}` } });
    expect(r.status).toBe(200);
  });

  it("rate-limits repeated failed logins", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) last = await login("pk_nope" + i);
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = await last!.json();
    expect(body.message).toMatch(/Слишком много попыток/);
    // the lock is shared with Bearer: even a valid token is refused from this client while locked
    expect((await fetch(`${base}/api/board`, { headers: { Authorization: `Bearer ${agentToken}` } })).status).toBe(429);
    limiter.reset();
  });

  it("logout invalidates the session", async () => {
    const s = auth.createSession(auth.listTokens()[0].id);
    const c = `pk_session=${s.id}`;
    expect((await fetch(`${base}/api/board`, { headers: { Cookie: c } })).status).toBe(200);
    await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: c, "X-Kanban-Client": "web" } });
    expect((await fetch(`${base}/api/board`, { headers: { Cookie: c } })).status).toBe(401);
  });
});

describe("human_description vs agent_notes", () => {
  it("are independent and agent_notes never reach UI payloads or search", async () => {
    const t = repo.createTask({ title: "Секретная проверка", human_description: "Видимое описание", agent_notes: "ZZAGENTONLY план" });
    repo.updateTask(t.id, { human_description: "Новое видимое описание" });
    expect(repo.getAgentNotes(t.id).agent_notes).toBe("ZZAGENTONLY план");
    repo.setAgentNotes(t.id, "ZZAGENTONLY v2");
    expect(repo.getTask(t.id).human_description).toBe("Новое видимое описание");

    const board = await (await web("/api/board")).text();
    const detail = await (await web(`/api/tasks/${t.id}`)).text();
    for (const payload of [board, detail]) {
      expect(payload).not.toContain("ZZAGENTONLY");
      expect(payload).not.toContain("agent_notes");
    }
    const search = await (await web(`/api/board?q=ZZAGENTONLY`)).json();
    expect(search.tasks).toHaveLength(0);
    const visible = await (await web(`/api/board?q=видимое`)).json();
    expect(visible.tasks.map((x: { id: number }) => x.id)).toContain(t.id);
  });

  it("the UI API refuses to write agent_notes", async () => {
    const t = repo.createTask({ title: "T" });
    const r = await web(`/api/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ agent_notes: "hack" }) });
    expect(r.status).toBe(400);
    expect(repo.getAgentNotes(t.id).agent_notes).toBe("");
  });
});

describe("tags, filters, ordering", () => {
  it("filters by several tags with 'any' semantics in the UI and supports 'all'", async () => {
    repo.createTag("Альфа", "blue");
    repo.createTag("Бета", "teal");
    const a = repo.createTask({ title: "только альфа", tags: ["альфа"] });
    const b = repo.createTask({ title: "только бета", tags: ["Бета"] });
    const ab = repo.createTask({ title: "обе", tags: ["Альфа", "Бета"] });
    const ids = (r: { tasks: { id: number }[] }) => r.tasks.map((x) => x.id).sort();
    const any = await (await web(`/api/board?tags=${encodeURIComponent("Альфа,Бета")}`)).json();
    expect(ids(any)).toEqual([a.id, b.id, ab.id].sort());
    expect(repo.listTasks({ tags: ["Альфа", "Бета"], tagMatch: "all" }).map((x) => x.id)).toEqual([ab.id]);
    const one = await (await web(`/api/board?tags=${encodeURIComponent("Бета")}&q=обе`)).json();
    expect(ids(one)).toEqual([ab.id]);
  });

  it("keeps order when moving between and inside columns", async () => {
    const col = () => repo.listTasks({ status: "review" }).map((t) => t.id);
    const x = repo.createTask({ title: "x", status: "review", place: "bottom" });
    const y = repo.createTask({ title: "y", status: "review", place: "bottom" });
    const z = repo.createTask({ title: "z", status: "inbox" });
    await web(`/api/tasks/${z.id}/move`, { method: "POST", body: JSON.stringify({ status: "review", before_id: y.id }) });
    expect(col().slice(-3)).toEqual([x.id, z.id, y.id]);
    repo.moveTask(x.id, { after_id: y.id });
    expect(col().slice(-3)).toEqual([z.id, y.id, x.id]);
    for (let i = 0; i < 60; i++) repo.moveTask(i % 2 ? x.id : y.id, { before_id: z.id }); // stress midpoint renormalisation
    expect(new Set(col()).size).toBe(col().length);
  });
});

describe("MCP server (real MCP client over Streamable HTTP)", () => {
  it("rejects connections without a valid Bearer token", async () => {
    await expect(mcpClient()).rejects.toThrow();
    await expect(mcpClient("pk_invalid_token_value")).rejects.toThrow();
    const raw = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" });
    expect(raw.status).toBe(401); // browser session cookie is not accepted for MCP
  });

  it("initializes, lists tools and round-trips with the UI API", async () => {
    const c = await mcpClient(agentToken);
    expect(c.getServerVersion()?.name).toBe("personal-kanban");
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      ["add_comment", "append_agent_notes", "assign_tags", "create_tag", "create_task", "get_agent_notes", "get_epic", "get_task", "list_comments", "list_epics", "list_statuses", "list_tags", "list_tasks", "move_task", "set_agent_notes", "set_task_epic", "unassign_tags", "update_human_description", "update_task"].sort(),
    );

    // MCP → UI
    const created = await callJson(c, "create_task", { title: "Из MCP", tags: ["Агентский"], create_missing_tags: true, human_description: "для человека", agent_notes: "MCPHIDDEN" });
    const uiTask = await (await web(`/api/tasks/${created.id}`)).json();
    expect(uiTask).toMatchObject({ title: "Из MCP", human_description: "для человека" });
    expect(uiTask.tags.map((t: { name: string }) => t.name)).toEqual(["Агентский"]);
    expect(JSON.stringify(uiTask)).not.toContain("MCPHIDDEN");

    await callJson(c, "append_agent_notes", { id: created.id, text: "шаг 2" });
    await callJson(c, "add_comment", { id: created.id, body: "Готово наполовину" });
    await callJson(c, "move_task", { id: created.id, status: "in_progress", index: 0 });
    const ui2 = await (await web(`/api/tasks/${created.id}`)).json();
    expect(ui2.status).toBe("in_progress");
    expect(ui2.comments.at(-1)).toMatchObject({ author: "claude", author_kind: "agent", body: "Готово наполовину" });

    // UI → MCP
    await web(`/api/tasks/${created.id}`, { method: "PATCH", body: JSON.stringify({ human_description: "правка человека", title: "Из MCP (ред.)" }) });
    await web(`/api/tasks/${created.id}/comments`, { method: "POST", body: JSON.stringify({ body: "Спасибо" }) });
    const full = await callJson(c, "get_task", { id: created.id });
    expect(full.title).toBe("Из MCP (ред.)");
    expect(full.human_description).toBe("правка человека");
    expect(full.agent_view.agent_notes).toMatch(/^MCPHIDDEN\n\n### .* UTC · claude\nшаг 2$/);
    expect(full.comments.at(-1)).toMatchObject({ author: "Вы", author_kind: "owner" });

    const desc = await callJson(c, "update_human_description", { id: created.id, text: "дописал агент", mode: "append" });
    expect(desc.human_description).toBe("правка человека\n\nдописал агент");
    expect((await callJson(c, "get_agent_notes", { id: created.id })).agent_notes).toContain("MCPHIDDEN");

    const listed = await callJson(c, "list_tasks", { tags: ["агентский"], status: "in_progress" });
    expect(listed.tasks.map((t: { id: number }) => t.id)).toEqual([created.id]);

    await callJson(c, "unassign_tags", { id: created.id, tags: ["Агентский"] });
    expect((await callJson(c, "get_task", { id: created.id, include_agent_notes: false })).agent_view).toBeUndefined();

    const err = (await c.callTool({ name: "get_task", arguments: { id: 999999 } })) as { isError?: boolean; content: { text: string }[] };
    expect(err.isError).toBe(true);
    expect(err.content[0].text).toMatch(/not_found/);
    const bad = (await c.callTool({ name: "create_tag", arguments: { name: "Альфа" } })) as { isError?: boolean; content: { text: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/conflict/);
    await c.close();
  });

  it("revoked tokens stop working", async () => {
    const { token, row } = auth.createToken("temp", "agent");
    const c = await mcpClient(token);
    await c.close();
    auth.revokeToken(row.id);
    await expect(mcpClient(token)).rejects.toThrow();
  });
});

describe("persistence", () => {
  it("keeps data after a restart", async () => {
    const t = repo.createTask({ title: "Переживёт рестарт", human_description: "h", agent_notes: "a", tags: ["Альфа"] });
    server.close();
    db.close();
    db = openDb(dbFile);
    repo = new Repo(db);
    auth = new Auth(db);
    limiter = new AuthLimiter(db);
    await startServer();
    const again = repo.getTask(t.id);
    expect(again).toMatchObject({ title: "Переживёт рестарт", human_description: "h" });
    expect(repo.getAgentNotes(t.id).agent_notes).toBe("a");
    expect(auth.verifyToken(ownerToken)).not.toBeNull();
    expect(db.pragma("user_version", { simple: true })).toBe(6);
  });
});

describe("automatic task archive", () => {
  it("counts a continuous calendar month across edits, reordering and a short month", () => {
    const memoryDb = openDb(":memory:");
    const local = new Repo(memoryDb);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // January 31 in Moscow even though it is still January 30 UTC.
      vi.setSystemTime(new Date("2026-01-30T22:15:00.123Z"));
      const epic = local.createTask({ title: "Эпик", kind: "epic", status: "done" });
      const task = local.createTask({ title: "Результат", status: "review", epic_id: epic.id, agent_notes: "Контекст" });
      local.updateTask(task.id, { status: "done" });
      const reset = local.createTask({ title: "Вернулась в работу", status: "done" });

      vi.setSystemTime(new Date("2026-02-10T20:00:00.000Z"));
      local.updateTask(reset.id, { status: "in_progress" });
      local.moveTask(reset.id, { status: "done" });
      local.updateTask(task.id, { title: "Готовый результат", status: "done" });
      local.moveTask(task.id, { status: "done", after_id: reset.id });
      local.addComment(task.id, { body: "Проверено", author: "Вы", author_kind: "owner" });

      expect(local.archiveDoneTasks("2026-02-27T22:15:00.122Z")).toBe(0);
      const changes = vi.fn();
      local.events.on("change", changes);
      expect(local.archiveDoneTasks("2026-02-27T22:15:00.123Z")).toBe(1);
      expect(local.archiveDoneTasks("2026-02-27T22:15:00.123Z")).toBe(0);
      expect(changes).toHaveBeenCalledTimes(1);
      expect(local.getTask(task.id)).toMatchObject({ status: "done_final", epic_id: epic.id, comments: [{ body: "Проверено" }] });
      expect(local.getAgentNotes(task.id).agent_notes).toBe("Контекст");
      expect(local.getTask(epic.id)).toMatchObject({ status: "done", progress: { done: 1, total: 1 } });
      expect(local.getTask(reset.id).status).toBe("done");
      expect(local.archiveDoneTasks("2026-03-10T20:00:00.000Z")).toBe(1);
    } finally {
      vi.useRealTimers();
      memoryDb.close();
    }
  });

  it("hides the task from the board but keeps the detail and MCP filter available", async () => {
    const task = repo.createTask({ title: "Архивный тестовый отчёт", status: "done" });
    const reopened = repo.createTask({ title: "Соседняя карточка" });
    db.prepare("UPDATE tasks SET done_at = ? WHERE id = ?").run("2000-01-01T10:00:00.000Z", task.id);
    repo.archiveDoneTasks();
    const headers = { Authorization: `Bearer ${agentToken}` };
    const board = await (await web("/api/board?q=Архивный", { headers })).json();
    expect(board.statuses.map((s: { id: string }) => s.id)).toEqual(["inbox", "in_progress", "review", "done"]);
    expect(board.tasks).toEqual([]);
    expect(await (await web(`/api/tasks/${task.id}`, { headers })).json()).toMatchObject({ status: "done_final", id: task.id });
    const client = await mcpClient(agentToken);
    try {
      expect(await callJson(client, "list_statuses", {})).toContainEqual({ id: "done_final", label: "Готово окончательно", hidden: true, automatic: true });
      expect(await callJson(client, "list_tasks", { status: "done_final" })).toMatchObject({ count: 1, tasks: [{ id: task.id }] });
      await expect(callJson(client, "move_task", { id: reopened.id, before_id: task.id })).rejects.toThrow("Недоступный статус");
      expect(await callJson(client, "update_task", { id: task.id, status: "done" })).toMatchObject({ status: "done" });
      expect(repo.archiveDoneTasks()).toBe(0);
    } finally {
      await client.close();
    }
  });
});
