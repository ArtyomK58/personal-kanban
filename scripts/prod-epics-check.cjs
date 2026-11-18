// Epics + priority check of an INSTALLED instance over its public URL, with self-cleaning test data (one tag, one epic, one task).
//   KANBAN_URL=https://… KANBAN_TOKEN_FILE=<0600 file with a TEST token> node scripts/prod-epics-check.cjs <out-dir>
// The token is never printed. Everything created here is deleted at the end and the removal is verified.
const PW = process.env.PLAYWRIGHT_CORE || "playwright-core";
const { chromium } = require(PW);
const fs = require("fs");
const path = require("path");
const os = require("os");

const base = process.env.KANBAN_URL;
const token = fs.readFileSync(process.env.KANBAN_TOKEN_FILE, "utf8").trim();
const out = process.argv[2] || "artifacts/prod-epics";
fs.mkdirSync(out, { recursive: true });
const results = [];
const ok = (n, c, x = "") => { results.push({ name: n, pass: !!c, extra: x }); console.log(`${c ? "PASS" : "FAIL"} ${n}${x ? " — " + x : ""}`); };
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const api = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
const shot = (p, n, o = {}) => p.screenshot({ path: path.join(out, n + ".png"), ...o });

(async () => {
  const { Client } = await import(path.resolve(__dirname, "../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"));
  const { StreamableHTTPClientTransport } = await import(path.resolve(__dirname, "../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"));
  const created = { tasks: [], tag: null };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pk-prod-epics-"));
  let ctx;
  try {
    // ── MCP over the public URL (real SDK) ──
    const c = new Client({ name: "prod-epics-check", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const await_tools = (await c.listTools()).tools;
    const tools = await_tools.map((t) => t.name);
    ok("MCP tools/list over HTTPS: 19 tools incl. list_epics, get_epic, set_task_epic", tools.length === 19 && ["list_epics", "get_epic", "set_task_epic"].every((t) => tools.includes(t)));
    ok("MCP schemas expose priority on create/update/list", ["create_task", "update_task", "list_tasks", "list_epics"].every((n) => JSON.stringify((await_tools.find((t) => t.name === n) || {}).inputSchema || {}).includes('"priority"')));
    const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };
    const tag = await api("POST", "/api/tags", { name: "Тест деплоя", color: "rose" });
    created.tag = tag.id;
    const epic = await call("create_task", { title: "[тест] Эпик деплоя", kind: "epic", tags: ["Тест деплоя"], human_description: "Проверка выкатки эпиков" });
    created.tasks.push(epic.id);
    const child = await call("create_task", { title: "[тест] Задача эпика", tags: ["Тест деплоя"], epic_id: epic.id, status: "done" });
    created.tasks.push(child.id);
    const loose = await call("create_task", { title: "[тест] Обычная задача", tags: ["Тест деплоя"], priority: "high" });
    ok("MCP priority: create high, default normal, filter", loose.priority === "high" && child.priority === "normal" && (await call("list_tasks", { tags: ["Тест деплоя"], priority: "high" })).count === 1);
    created.tasks.push(loose.id);
    const e = await call("get_epic", { id: epic.id });
    ok("MCP get_epic: progress and children", e.progress.done === 1 && e.progress.total === 1 && e.children[0].id === child.id);
    ok("MCP list_epics / list_tasks(epic_id)", (await call("list_epics", { tags: ["Тест деплоя"] })).count === 1 && (await call("list_tasks", { epic_id: epic.id })).count === 1);
    ok("old MCP call shape still works (list_tasks by tag)", (await call("list_tasks", { tags: ["Тест деплоя"] })).count === 3);
    let err = "";
    try { await call("set_task_epic", { id: epic.id, epic_id: epic.id }); } catch (x) { err = x.message; }
    ok("MCP rejects an epic inside an epic", /epic_nested|epic_self/.test(err), err.split(":")[0]);
    await c.close();

    // ── UI through HTTPS ──
    const exe = process.env.CHROME || "/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
    ctx = await chromium.launchPersistentContext(profile, { executablePath: exe, viewport: { width: 1440, height: 900 }, locale: "ru-RU" });
    const p = ctx.pages()[0] || (await ctx.newPage());
    const errors = [];
    p.on("pageerror", (x) => errors.push(x.message));
    p.on("console", (m) => { if (m.type() === "error" && !/status of 401/.test(m.text())) errors.push(m.text()); });
    await p.goto(`${base}/login`);
    await p.fill("#token", token);
    await p.click("button[type=submit]");
    await p.locator(".card").first().waitFor();
    const js = await p.evaluate(() => [...document.scripts].map((s) => s.src.split("/").pop()).join(","));
    ok("public page runs the new bundle", js === (process.env.EXPECT_JS || js), js);
    await p.getByRole("button", { name: "Тест деплоя" }).click();
    await p.locator(".active-filter").waitFor();
    await p.waitForTimeout(400);
    await shot(p, "p1-board-filtered");
    const epicCard = p.locator(".card.epic", { hasText: "[тест] Эпик деплоя" });
    ok("prod board renders the epic card with progress", (await epicCard.locator(".progress-text").innerText()) === "1 из 1 готово");
    ok("prod board marks the high-priority card", (await p.locator(".card", { hasText: "[тест] Обычная задача" }).locator(".prio-high").innerText()) === "Высокий");
    await p.locator(".card", { hasText: "[тест] Обычная задача" }).click();
    await p.locator(".panel .prio-field").waitFor();
    await p.locator(".panel .prio-opt.prio-low").click();
    await p.waitForTimeout(500);
    await shot(p, "p0-priority-panel");
    ok("panel priority selector saves over HTTPS", (await api("GET", `/api/tasks/${loose.id}`)).priority === "low" && (await p.locator(".card", { hasText: "[тест] Обычная задача" }).locator(".prio-low").count()) === 1);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    ok("prod board renders the child link row", (await p.locator(".card", { hasText: "[тест] Задача эпика" }).locator(".epic-link").innerText()).includes("[тест] Эпик деплоя"));
    await p.locator(".card", { hasText: "[тест] Задача эпика" }).locator(".epic-link").click();
    await p.locator(".panel .kids-list").waitFor();
    await p.waitForTimeout(300);
    await shot(p, "p2-epic-panel");
    ok("epic link opens the epic panel over HTTPS", (await p.locator(".panel .panel-kind").count()) === 1);
    await p.locator(".panel .kid").first().click();
    await p.locator(".panel .epic-chip").waitFor();
    await p.locator(".panel .epic-change").click();
    await p.locator(".epic-picker").waitFor();
    await p.waitForTimeout(150);
    await shot(p, "p3-task-picker");
    await p.keyboard.press("Escape");
    await p.keyboard.press("Escape");
    await p.waitForTimeout(250);
    await p.locator(".epic-filter").click();
    await p.locator(".epic-filter-pop .ep-item", { hasText: "[тест] Эпик деплоя" }).click();
    await p.waitForTimeout(400);
    ok("epic filter over HTTPS (with tag filter)", (await p.locator(".card").count()) === 2 && new URL(p.url()).searchParams.get("epic") === String(epic.id));
    await shot(p, "p4-epic-filter");
    await p.reload();
    await p.locator(".card").first().waitFor();
    ok("reload keeps the epic filter", (await p.locator(".card").count()) === 2);
    ok("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    // reset the remembered filter in this throwaway profile and log out (the test session is removed)
    await p.locator(".active-filter .link-btn").click();
    await p.getByRole("button", { name: "Меню" }).click();
    await p.getByRole("menuitem", { name: "Выйти" }).click();
    await p.waitForURL(/\/login$/);
  } catch (x) {
    ok("scenario finished", false, x.message.split("\n")[0]);
  } finally {
    await ctx?.close().catch(() => {});
    for (const id of created.tasks.reverse()) await api("DELETE", `/api/tasks/${id}`).catch(() => {});
    if (created.tag) await api("DELETE", `/api/tags/${created.tag}`).catch(() => {});
    const left = await api("GET", "/api/board");
    ok("test data removed", !left.tasks.some((t) => t.title.startsWith("[тест]")) && !left.tags.some((t) => t.name === "Тест деплоя") && !left.epics.length);
    fs.rmSync(profile, { recursive: true, force: true });
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ base, at: new Date().toISOString(), results }, null, 2));
    const failed = results.filter((r) => !r.pass).length;
    console.log(`${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
