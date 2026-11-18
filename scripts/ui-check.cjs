// UI scenario check with real pixels and intermediate frames (headless Chromium via playwright-core).
//   KANBAN_URL=http://127.0.0.1:8080 KANBAN_TOKEN=pk_... node scripts/ui-check.cjs <out-dir>
// The token is typed into the login form only; it is never printed.
const PW = process.env.PLAYWRIGHT_CORE || "playwright-core";
const { chromium } = require(PW);
const fs = require("fs");
const path = require("path");

const base = process.env.KANBAN_URL || "http://127.0.0.1:8080";
const token = process.env.KANBAN_TOKEN;
const out = process.argv[2] || "artifacts/ui";
fs.mkdirSync(out, { recursive: true });
const results = [];
const ok = (name, cond, extra = "") => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); };
const shot = async (p, name, opts = {}) => { const f = path.join(out, name + ".png"); await p.screenshot({ path: f, ...opts }); return f; };
const frames = async (p, name, n = 5, gap = 45) => { for (let i = 0; i < n; i++) { await shot(p, `${name}-f${i}`); await p.waitForTimeout(gap); } };
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || "/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ru-RU" });
  const p = await ctx.newPage();
  const consoleErrors = [];
  p.on("pageerror", (e) => consoleErrors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  // ── auth ──
  await p.goto(base + "/t/5");
  await p.waitForURL(/\/login$/);
  ok("protected route redirects to /login", p.url().endsWith("/login"));
  await shot(p, "01-login");
  await p.fill("#token", "pk_wrong_token");
  await p.click("button[type=submit]");
  await p.getByText("Неверный токен").waitFor();
  await shot(p, "02-login-error");
  ok("wrong token shows error", await p.getByText("Неверный токен").isVisible());
  await p.fill("#token", token);
  await p.click("button[type=submit]");
  await p.waitForURL(/\/t\/5$/);
  ok("login returns to the requested page (/t/5)", p.url().endsWith("/t/5"));
  ok("token not in URL", !p.url().includes(token));
  await p.getByText("Добавить команду /remind").first().waitFor();
  await shot(p, "03-task-page", { fullPage: true });
  const pageHtml = await p.content();
  ok("task page DOM has no agent notes", !pageHtml.includes("chat_id, fire_at") && !pageHtml.includes("agent_notes"));

  // ── board ──
  await p.click("a.crumbs, .crumbs a");
  await p.waitForURL((u) => new URL(u).pathname === "/");
  await p.locator(".card").first().waitFor();
  await shot(p, "04-board");
  const boardHtml = await p.content();
  ok("board DOM has no agent notes", !boardHtml.includes("chat_id, fire_at"));
  const card = p.locator(".card", { hasText: "Переписать раздел" });
  await card.hover();
  await p.waitForTimeout(150);
  await shot(p, "05-card-hover");
  const hovered = await card.evaluate((el) => getComputedStyle(el).boxShadow);
  ok("card hover shadow", hovered && hovered !== "none", hovered);

  // ── filters ──
  await p.getByRole("button", { name: "Портфолио" }).click();
  await p.getByRole("button", { name: "Пет-бот" }).click();
  await p.getByText(/Показаны задачи/).waitFor();
  await p.waitForTimeout(250);
  await shot(p, "06-filter-two-tags");
  const url = new URL(p.url());
  ok("filter in URL", url.searchParams.get("tags") === "Портфолио,Пет-бот", url.search);
  const visibleTitles = await p.locator(".card .card-title").allInnerTexts();
  const filtered = (await api("GET", "/api/board?tags=" + encodeURIComponent("Портфолио,Пет-бот"))).tasks.length;
  ok("board shows only tasks with any of the tags", visibleTitles.length === filtered, `${visibleTitles.length} cards`);
  const summary = await p.locator(".active-filter").innerText();
  ok("explicit active-filter line with count", /Портфолио\s+или\s+Пет-бот/.test(summary) && /\d+ из \d+/.test(summary), summary.replace(/\s+/g, " "));

  // search
  await p.fill("#q", "ретраи");
  await p.waitForTimeout(600);
  await shot(p, "07-search");
  const afterSearch = await p.locator(".card .card-title").allInnerTexts();
  ok("search over comments works with tag filter", afterSearch.length === 1 && afterSearch[0].includes("логи падений"), afterSearch.join(" | "));
  await p.getByRole("button", { name: "Очистить поиск" }).click();
  await p.waitForTimeout(400);

  // ── side panel ──
  const boardScrollBefore = await p.evaluate(() => document.querySelector(".board-wrap").scrollLeft);
  await p.locator(".card", { hasText: "Добавить команду /remind" }).click();
  await frames(p, "08-panel-open", 5, 40);
  await p.locator(".panel .task-title").waitFor();
  await p.waitForTimeout(250);
  await shot(p, "09-panel");
  ok("panel URL has ?task and keeps filter", new URL(p.url()).searchParams.get("task") === "5" && new URL(p.url()).searchParams.get("tags") === "Портфолио,Пет-бот", new URL(p.url()).search);
  ok("panel renders markdown checklist", (await p.locator(".panel .md input[type=checkbox]").count()) >= 2);
  ok("panel shows agent comment badge", await p.locator(".panel .agent-badge").first().isVisible());
  ok("panel DOM has no agent notes", !(await p.content()).includes("chat_id, fire_at"));
  ok("board still visible beside docked panel", await p.locator(".card", { hasText: "Сверстать страницу кейса" }).isVisible());

  // edit description → close → reopen: draft survives
  await p.locator(".panel").getByRole("button", { name: "Изменить" }).click();
  await p.locator(".panel textarea.editor").fill("## Черновик\n\nНесохранённый текст из UI-теста");
  await shot(p, "10-panel-edit");
  await p.locator(".panel").getByRole("button", { name: "Закрыть панель" }).click();
  await frames(p, "11-panel-close", 4, 40);
  await p.waitForTimeout(200);
  ok("closing panel removes ?task, keeps filter", !new URL(p.url()).searchParams.has("task") && new URL(p.url()).searchParams.get("tags") === "Портфолио,Пет-бот");
  ok("board scroll kept", (await p.evaluate(() => document.querySelector(".board-wrap").scrollLeft)) === boardScrollBefore);
  await p.locator(".card", { hasText: "Добавить команду /remind" }).click();
  await p.locator(".panel .draft-banner").waitFor();
  ok("description draft restored after close/reopen", (await p.locator(".panel textarea.editor").inputValue()).includes("Несохранённый текст"));
  // reload keeps panel + draft
  await p.reload();
  await p.locator(".panel .draft-banner").waitFor();
  await shot(p, "12-reload-panel-draft");
  ok("reload keeps panel, filter and draft", new URL(p.url()).searchParams.get("task") === "5" && (await p.locator(".panel textarea.editor").inputValue()).includes("Несохранённый"));
  await p.locator(".panel").getByRole("button", { name: "Сохранить" }).click();
  await p.locator(".panel .md h2", { hasText: "Черновик" }).waitFor();
  const saved = await api("GET", "/api/tasks/5");
  ok("description saved to server", saved.human_description.includes("Несохранённый текст из UI-теста"));
  // agent notes untouched (checked through MCP-equivalent repo endpoint is not exposed; use MCP smoke for that)

  // live update from an agent (REST with agent token stands in for MCP; MCP smoke covers MCP itself)
  await api("POST", "/api/tasks/5/comments", { body: "Живое обновление: комментарий пришёл, пока панель открыта" });
  await p.getByText("Живое обновление").waitFor({ timeout: 8000 });
  ok("panel updates live (SSE) on external change", true);
  await shot(p, "13-live-comment");

  // back button closes the panel opened from the board
  await p.keyboard.press("Escape");
  await p.waitForTimeout(250);
  await p.locator(".card", { hasText: "Разобрать логи" }).click();
  await p.locator(".panel .task-title").waitFor();
  await p.goBack();
  await p.waitForTimeout(300);
  ok("browser Back closes the panel", (await p.locator(".panel").count()) === 0 && !new URL(p.url()).searchParams.has("task"));

  // open as full page from panel
  await p.locator(".card", { hasText: "Разобрать логи" }).click();
  await p.locator(".panel").getByRole("link", { name: /Открыть страницей/ }).click();
  await p.waitForURL(/\/t\/\d+$/);
  await p.locator(".page .task-title").waitFor();
  await shot(p, "14-task-page-from-panel", { fullPage: true });
  ok("panel → full page link", /\/t\/\d+$/.test(p.url()));
  await p.goBack();
  await p.locator(".panel .task-title").waitFor();
  ok("Back from page returns to board with panel", new URL(p.url()).searchParams.has("task"));
  await p.keyboard.press("Escape");
  await p.waitForTimeout(250);

  // ── reset filter, drag & drop ──
  await p.getByRole("button", { name: "Сбросить" }).click();
  await p.waitForTimeout(400);
  const src = p.locator(".card", { hasText: "Выбрать беговые кроссовки" });
  const targetCol = p.locator("section.column[aria-label='На проверке'] .column-list");
  const sb = await src.boundingBox();
  const tb = await targetCol.boundingBox();
  await p.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await p.mouse.down();
  await p.mouse.move(sb.x + sb.width / 2 + 20, sb.y + sb.height / 2 + 10, { steps: 4 });
  await p.mouse.move(tb.x + tb.width / 2, tb.y + 40, { steps: 12 });
  await p.waitForTimeout(250);
  await shot(p, "15-drag-in-progress");
  ok("lifted card overlay during drag", (await p.locator(".card.lifted").count()) === 1);
  ok("placeholder slot in target column", (await p.locator("section.column[aria-label='На проверке'] .card.ghost").count()) === 1);
  await p.mouse.up();
  await p.waitForTimeout(700);
  await shot(p, "16-after-drop");
  const moved = (await api("GET", "/api/board")).tasks.find((t) => t.title === "Выбрать беговые кроссовки");
  const review = (await api("GET", "/api/board")).tasks.filter((t) => t.status === "review").map((t) => t.title);
  ok("drop persisted status + position", moved.status === "review" && review[0] === "Выбрать беговые кроссовки", review.slice(0, 3).join(" | "));
  // reorder inside a column
  const doneCards = p.locator("section.column[aria-label='Готово'] .card");
  const last = doneCards.last();
  const first = doneCards.first();
  const lb = await last.boundingBox();
  const fb = await first.boundingBox();
  const lastTitle = await last.locator(".card-title").innerText();
  await p.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await p.mouse.down();
  await p.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2 - 10, { steps: 3 });
  await p.mouse.move(fb.x + fb.width / 2, fb.y + 5, { steps: 12 });
  await p.waitForTimeout(200);
  await p.mouse.up();
  await p.waitForTimeout(700);
  await p.reload();
  await p.locator(".card").first().waitFor();
  const firstDone = await p.locator("section.column[aria-label='Готово'] .card .card-title").first().innerText();
  ok("reorder inside column persisted after reload", firstDone === lastTitle, firstDone);

  // ── quick add with active filter ──
  await p.getByRole("button", { name: "Дом" }).click();
  await p.waitForTimeout(300);
  await p.getByRole("button", { name: "Добавить задачу в колонку «Входящие»" }).click();
  await p.locator(".quick-add textarea").fill("Заменить фильтр в вытяжке");
  await shot(p, "17-quick-add");
  await p.keyboard.press("Enter");
  await p.locator(".card", { hasText: "Заменить фильтр в вытяжке" }).waitFor();
  const qa = (await api("GET", "/api/board")).tasks.find((t) => t.title === "Заменить фильтр в вытяжке");
  ok("quick add creates task with active filter tag", qa && qa.status === "inbox" && qa.tags.some((t) => t.name === "Дом"));
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "Сбросить" }).click();

  // ── filter remembered when coming back to "/" ──
  await p.getByRole("button", { name: "Чтение" }).click();
  await p.waitForTimeout(300);
  await p.goto(base + "/");
  await p.locator(".active-filter").waitFor();
  ok("filter remembered on plain / visit", new URL(p.url()).searchParams.get("tags") === "Чтение");
  await p.getByRole("button", { name: "Сбросить" }).click();
  await p.waitForTimeout(300);

  // ── narrow window ──
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(300);
  await shot(p, "18-mobile-board");
  const overflowY = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok("mobile: no page-level horizontal overflow", overflowY);
  await p.locator(".card").first().click();
  await p.locator(".panel .task-title").waitFor();
  await p.waitForTimeout(250);
  await shot(p, "19-mobile-panel");
  const pw = await p.locator(".panel").evaluate((el) => el.getBoundingClientRect().width);
  ok("mobile: task opens full-width", Math.round(pw) === 390, String(pw));
  await p.keyboard.press("Escape");
  await p.setViewportSize({ width: 1024, height: 768 });
  await p.waitForTimeout(200);
  await p.locator(".card").first().click();
  await p.locator(".panel .task-title").waitFor();
  await p.waitForTimeout(250);
  await shot(p, "20-medium-panel-overlay");
  await p.keyboard.press("Escape");
  await p.setViewportSize({ width: 1440, height: 900 });

  // ── logout ──
  await p.getByRole("button", { name: "Меню" }).click();
  await shot(p, "21-menu");
  await p.getByRole("menuitem", { name: "Выйти" }).click();
  await p.waitForURL(/\/login$/);
  const r401 = await p.evaluate(() => fetch("/api/board").then((r) => r.status));
  ok("logout ends the session", r401 === 401);

  ok("no console errors", consoleErrors.filter((e) => !/401|Unauthorized/.test(e)).length === 0, consoleErrors.slice(0, 3).join(" | "));
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ base, at: new Date().toISOString(), results }, null, 2));
  await browser.close();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR", e.message); process.exit(2); });
