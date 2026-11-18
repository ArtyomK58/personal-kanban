// Priority UI scenario on a SYNTHETIC board (scripts/seed-epics-demo.ts): cards of three priorities, the selector in the
// panel and on the page (hover/focus/keyboard/save), DnD, reload, mobile. Mutates the test board.
//   KANBAN_URL=http://127.0.0.1:18496 KANBAN_TOKEN_FILE=/tmp/x/bootstrap-token.txt node scripts/priority-ui-check.cjs <out-dir>
const PW = process.env.PLAYWRIGHT_CORE || "playwright-core";
const { chromium } = require(PW);
const fs = require("fs");
const path = require("path");

const base = process.env.KANBAN_URL || "http://127.0.0.1:18496";
const token = fs.readFileSync(process.env.KANBAN_TOKEN_FILE, "utf8").trim();
const out = process.argv[2] || "artifacts/priority-ui";
const scale = Number(process.env.SCALE || 1);
fs.mkdirSync(out, { recursive: true });
const results = [];
const ok = (n, c, x = "") => { results.push({ name: n, pass: !!c, extra: x }); console.log(`${c ? "PASS" : "FAIL"} ${n}${x ? " — " + x : ""}`); };
const shot = (p, n, o = {}) => p.screenshot({ path: path.join(out, n + ".png"), ...o });
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const api = async (m, u, b) => (await fetch(base + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json();
const find = async (title) => (await api("GET", "/api/board")).tasks.find((t) => t.title.startsWith(title));
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const card = (p, t) => p.locator(".card", { has: p.locator(".card-title", { hasText: new RegExp("^" + esc(t)) }) });
const wait = (p, ms = 300) => p.waitForTimeout(ms);

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || "/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome" });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: scale, locale: "ru-RU" });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/status of 401/.test(m.text())) errors.push(m.text()); });
  try {
    await p.goto(base + "/login");
    await p.fill("#token", token);
    await p.click("button[type=submit]");
    await p.locator(".card").first().waitFor();
    await wait(p, 500);
    await shot(p, "01-board");
    ok("high card shows «Высокий» with an up chevron and a tooltip", (await card(p, "Записаться к стоматологу").locator(".prio-high").innerText()) === "Высокий"
      && (await card(p, "Записаться к стоматологу").locator(".prio-high").getAttribute("title")) === "Приоритет: высокий");
    ok("low card shows «Низкий»", (await card(p, "Купить лампы").locator(".prio-low").innerText()) === "Низкий");
    ok("normal card has no priority mark", (await card(p, "Обновить токен бота").locator(".prio").count()) === 0);
    ok("epic card shows its own priority; child shows its own", (await card(p, "Резервные копии").locator(".prio-high").count()) === 1 && (await card(p, "Повторяющиеся").locator(".prio-low").count()) === 1
      && (await card(p, "Проверить восстановление").locator(".prio").count()) === 0);
    const h = async (t) => Math.round((await card(p, t).boundingBox()).height);
    ok("a priority mark does not change card height (same meta row)", (await h("Купить лампы")) === (await h("Обновить токен бота")), `${await h("Купить лампы")} vs ${await h("Обновить токен бота")}`);
    // side-by-side crop of three priorities in the same column
    const col = p.locator(".column", { has: p.locator("h2", { hasText: "Входящие" }) });
    await col.screenshot({ path: path.join(out, "02-inbox-column.png") });

    // ── panel selector: hover, focus, keyboard, click; saves without reload ──
    await card(p, "Обновить токен бота").click();
    await p.locator(".panel .prio-field").waitFor();
    await wait(p, 300);
    await shot(p, "03-panel-normal");
    ok("panel shows «Приоритет» with «Обычный» selected", (await p.locator(".panel .prio-opt[aria-checked=true]").innerText()) === "Обычный");
    await p.locator(".panel .prio-opt.prio-high").hover();
    await wait(p, 150);
    await shot(p, "04-panel-hover-high");
    await p.locator(".panel .prio-opt.prio-high").click();
    await p.locator(".panel .prio-opt.prio-high[aria-checked=true]").waitFor();
    await wait(p, 400);
    await shot(p, "05-panel-high-saved");
    ok("click saves; the card updates without reload", (await find("Обновить токен бота")).priority === "high" && (await card(p, "Обновить токен бота").locator(".prio-high").count()) === 1);
    await p.locator(".panel .prio-opt.prio-high").focus();
    await p.keyboard.press("ArrowLeft");
    await wait(p, 400);
    await shot(p, "06-panel-keyboard-normal");
    ok("keyboard: ← moves to «Обычный» and saves; focus stays in the group", (await find("Обновить токен бота")).priority === "normal"
      && (await p.evaluate(() => document.activeElement?.textContent)) === "Обычный");
    await p.keyboard.press("ArrowLeft");
    await wait(p, 400);
    ok("keyboard: ← again → «Низкий»", (await find("Обновить токен бота")).priority === "low");
    await p.keyboard.press("Escape");
    await wait(p);
    ok("Esc from the selector closes the panel and the card keeps «Низкий»", (await p.locator(".panel").count()) === 0 && (await card(p, "Обновить токен бота").locator(".prio-low").count()) === 1);

    // other edits keep priority (title, epic attach), DnD keeps priority and order is unchanged
    const tok = await find("Обновить токен бота");
    await api("PATCH", `/api/tasks/${tok.id}`, { title: "Обновить токен бота!" });
    await api("PATCH", `/api/tasks/${tok.id}`, { epic_id: (await find("Резервные копии")).id });
    await wait(p, 600);
    ok("title change and epic attach keep priority", (await find("Обновить токен бота")).priority === "low" && (await card(p, "Обновить токен бота").locator(".epic-link").count()) === 1);
    const inboxOrder = async () => (await api("GET", "/api/board")).tasks.filter((t) => t.status === "inbox").map((t) => t.id).join(",");
    const before = await inboxOrder();
    await api("PATCH", `/api/tasks/${(await find("Купить лампы")).id}`, { priority: "high" });
    ok("changing priority does not reorder the column", (await inboxOrder()) === before);
    await api("PATCH", `/api/tasks/${(await find("Купить лампы")).id}`, { priority: "low" });
    await wait(p, 500);
    const src = card(p, "Записаться к стоматологу");
    const target = p.locator(".column", { has: p.locator("h2", { hasText: "На проверке" }) }).locator(".column-list");
    const a = await src.boundingBox(); const t = await target.boundingBox();
    await p.mouse.move(a.x + a.width / 2, a.y + 20); await p.mouse.down();
    await p.mouse.move(a.x + a.width / 2 + 20, a.y + 30, { steps: 4 });
    await p.mouse.move(t.x + t.width / 2, t.y + t.height - 10, { steps: 12 });
    await shot(p, "07-dnd-high");
    await p.mouse.up();
    await wait(p, 700);
    const den = await find("Записаться к стоматологу");
    ok("DnD to another column keeps priority", den.status === "review" && den.priority === "high" && (await card(p, "Записаться к стоматологу").locator(".prio-high").count()) === 1);
    await p.reload();
    await p.locator(".card").first().waitFor();
    await wait(p, 400);
    ok("reload shows the same marks", (await card(p, "Записаться к стоматологу").locator(".prio-high").count()) === 1 && (await card(p, "Обновить токен бота").locator(".prio-low").count()) === 1);
    await shot(p, "08-board-after-reload");

    // epic panel: own selector, independent from children
    await card(p, "Резервные копии").click();
    await p.locator(".panel .kids").waitFor();
    await p.locator(".panel .prio-opt.prio-normal").click();
    await wait(p, 500);
    ok("epic priority is independent of its children", (await find("Резервные копии")).priority === "normal" && (await find("Обновить токен бота")).priority === "low");
    await p.locator(".panel .prio-opt.prio-high").click();
    await wait(p, 400);
    await p.keyboard.press("Escape");

    // ── task page ──
    await p.goto(`${base}/t/${tok.id}`);
    await p.locator(".page .prio-field").waitFor();
    await p.locator(".page .prio-opt.prio-high").hover();
    await wait(p, 200);
    await shot(p, "09-page-selector", { fullPage: true });
    const pf = await p.locator(".page .prio-field").boundingBox();
    const side = await p.locator(".page-side").boundingBox();
    ok("page: the selector fits the side column", pf.x + pf.width <= side.x + side.width + 0.5, `${Math.round(pf.width)} in ${Math.round(side.width)}`);
    await p.locator(".page .prio-opt.prio-high").click();
    await wait(p, 500);
    ok("page selector saves", (await find("Обновить токен бота")).priority === "high");
    await p.locator(".page .prio-opt.prio-low").click();
    await wait(p, 400);

    // ── mobile ──
    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(base + "/");
    await p.locator(".card").first().waitFor();
    await wait(p, 400);
    await shot(p, "10-mobile-board");
    await card(p, "Купить лампы").click();
    await p.locator(".panel .prio-field").waitFor();
    await wait(p, 300);
    await shot(p, "11-mobile-panel");
    const box = await p.locator(".panel .prio-field").boundingBox();
    ok("mobile: the selector fits", box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
    ok("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  } catch (e) {
    ok("scenario finished", false, e.message.split("\n")[0]);
    await shot(p, "zz-error").catch(() => {});
  } finally {
    await b.close();
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ base, at: new Date().toISOString(), results }, null, 2));
    const failed = results.filter((r) => !r.pass).length;
    console.log(`${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
