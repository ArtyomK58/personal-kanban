// Epics UI scenario on a SYNTHETIC board (scripts/seed-epics-demo.ts) with real pixels and intermediate frames.
//   KANBAN_URL=http://127.0.0.1:18493 KANBAN_TOKEN_FILE=/tmp/x/bootstrap-token.txt node scripts/epics-ui-check.cjs <out-dir>
// The token is read from the file and typed into the login form; it is never printed. Mutates the test board.
const PW = process.env.PLAYWRIGHT_CORE || "playwright-core";
const { chromium } = require(PW);
const fs = require("fs");
const path = require("path");

const base = process.env.KANBAN_URL || "http://127.0.0.1:18493";
const token = fs.readFileSync(process.env.KANBAN_TOKEN_FILE, "utf8").trim();
const out = process.argv[2] || "artifacts/epics-ui";
fs.mkdirSync(out, { recursive: true });
const results = [];
const ok = (name, cond, extra = "") => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); };
const shot = (p, name, o = {}) => p.screenshot({ path: path.join(out, name + ".png"), ...o });
const frames = async (p, name, n = 4, gap = 40) => { for (let i = 0; i < n; i++) { await shot(p, `${name}-f${i}`); await p.waitForTimeout(gap); } };
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const api = async (m, u, b) => (await fetch(base + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json();
const find = async (title) => (await api("GET", "/api/board")).tasks.find((t) => t.title === title);
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const card = (p, title) => p.locator(".card", { has: p.locator(".card-title", { hasText: new RegExp("^" + esc(title)) }) });
const settle = (p, ms = 350) => p.waitForTimeout(ms);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || "/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "ru-RU", deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  // the login page asks /api/auth/me before signing in → an expected 401
  p.on("console", (m) => { if (m.type() === "error" && !/status of 401/.test(m.text())) errors.push(m.text()); });
  try {
    // ── login and the board with three card kinds ──
    await p.goto(base + "/login");
    await p.fill("#token", token);
    await p.click("button[type=submit]");
    await p.locator(".card").first().waitFor();
    await settle(p, 500);
    const bundle = await p.evaluate(() => [...document.scripts].map((s) => s.src).join(" "));
    ok("browser loaded the fresh build", /assets\/index-.*\.js/.test(bundle), bundle.split("/").pop());
    await shot(p, "01-board");
    ok("epic cards show «ЭПИК», progress and the second edge", (await card(p, "Резервные копии").locator(".epic-label").innerText()).includes("ЭПИК")
      && (await card(p, "Резервные копии").locator(".progress-text").innerText()) === "1 из 3 готово"
      && (await card(p, "Напоминания").locator(".progress-text").innerText()) === "2 из 4 готово"
      && (await card(p, "Резервные копии").evaluate((e) => getComputedStyle(e).boxShadow)).includes("10px"));
    ok("empty epic shows «Нет задач» (no NaN)", (await card(p, "Пустой эпик").locator(".progress-text").innerText()) === "Нет задач");
    ok("child card has the epic name row, standalone card has none",
      (await card(p, "Отправка по таймеру").locator(".epic-link").innerText()).includes("Напоминания") && (await card(p, "Обновить токен бота").locator(".epic-link").count()) === 0);
    const geo = async (t) => card(p, t).evaluate((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), pad: getComputedStyle(e).padding, br: getComputedStyle(e).borderRadius }; });
    const g1 = await geo("Отправка по таймеру"), g2 = await geo("Обновить токен бота");
    ok("child and standalone cards share geometry", g1.w === g2.w && g1.pad === g2.pad && g1.br === g2.br, JSON.stringify(g1));

    // hover states
    await card(p, "Резервные копии").hover();
    await frames(p, "02-hover-epic", 3, 50);
    await card(p, "Отправка по таймеру").locator(".epic-link").hover();
    await frames(p, "03-hover-epic-link", 3, 50);
    ok("epic link underlines on hover", (await card(p, "Отправка по таймеру").locator(".epic-link").evaluate((e) => getComputedStyle(e).textDecorationLine)) === "underline");

    // ── child card → parent via the link row (no drag, no child panel) ──
    await card(p, "Отправка по таймеру").locator(".epic-link").click();
    await frames(p, "04-open-parent", 4, 40);
    await p.locator(".panel .panel-kind").waitFor();
    const remind = await find("Напоминания");
    ok("epic link opens the parent epic panel", new URL(p.url()).searchParams.get("task") === String(remind.id) && (await p.locator(".panel .task-title").innerText()) === "Напоминания");
    await p.keyboard.press("Escape");
    await settle(p);
    ok("Esc closes the panel", (await p.locator(".panel").count()) === 0);

    // ── epic panel ──
    await p.setViewportSize({ width: 1440, height: 1160 });
    await card(p, "Резервные копии").click();
    await p.locator(".panel .kids-list").waitFor();
    await settle(p, 400);
    await shot(p, "05-epic-panel");
    const kids = await p.locator(".panel .kid").allInnerTexts();
    ok("epic panel: progress, description, children with statuses, add/attach", kids.length === 3 && kids.some((k) => k.includes("На проверке"))
      && (await p.locator(".panel .epic-progress").innerText()).includes("1 из 3")
      && (await p.getByRole("button", { name: "Новая задача в эпике" }).count()) === 1 && (await p.getByRole("button", { name: "Привязать существующую…" }).count()) === 1);
    ok("epic panel head says «Эпик #N»", (await p.locator(".panel .panel-head").innerText()).includes("Эпик"));

    // child row → task panel; parent link back
    await p.locator(".panel .kid", { hasText: "Загрузка в S3" }).click();
    await frames(p, "06-parent-to-child", 4, 40);
    await p.locator(".panel .epic-chip").waitFor();
    await settle(p, 300);
    await p.setViewportSize({ width: 1440, height: 1040 });
    await settle(p, 200);
    await shot(p, "07-task-panel");
    ok("task panel shows the epic link row and the «Эпик» property", (await p.locator(".panel .epic-link-panel").innerText()).includes("Резервные копии") && (await p.locator(".panel .epic-chip").innerText()).includes("1 из 3"));

    // picker: open, search, Esc, unlink, relink (tags untouched)
    const s3 = await find("Загрузка в S3-совместимое хранилище");
    const tagsBefore = s3.tags.map((t) => t.name).join(",");
    await p.getByRole("button", { name: "Изменить эпик" }).click();
    await p.locator(".epic-picker").waitFor();
    await settle(p, 150);
    await shot(p, "08-epic-picker");
    const groups = await p.locator(".epic-picker .ep-group").allInnerTexts();
    ok("picker: own project group first, current ticked, «Без эпика», «Создать эпик…»", groups[0].includes("Пет-бот") && (await p.locator(".epic-picker .ep-item[aria-pressed=true]").innerText()).includes("Резервные копии")
      && (await p.locator(".epic-picker", { hasText: "Без эпика" }).count()) === 1 && (await p.locator(".epic-picker", { hasText: "Создать эпик" }).count()) === 1);
    await p.keyboard.type("Напом");
    await settle(p, 100);
    await shot(p, "09-picker-search");
    ok("picker search filters epics", (await p.locator(".epic-picker .ep-list .ep-item").count()) === 1);
    await p.keyboard.press("Escape");
    await settle(p, 150);
    ok("Esc closes the picker but not the panel", (await p.locator(".epic-picker").count()) === 0 && (await p.locator(".panel").count()) === 1);
    await p.getByRole("button", { name: "Изменить эпик" }).click();
    await p.locator(".epic-picker .ep-item", { hasText: "Без эпика" }).click();
    await p.locator(".panel .add-tag", { hasText: "эпик" }).waitFor();
    await settle(p);
    ok("«Без эпика» detaches (card loses the link row)", (await card(p, "Загрузка в S3").locator(".epic-link").count()) === 0 && (await find("Загрузка в S3-совместимое хранилище")).epic_id === null);
    await p.locator(".panel .add-tag", { hasText: "эпик" }).click();
    await p.locator(".epic-picker .ep-item", { hasText: "Резервные копии" }).click();
    await p.locator(".panel .epic-chip").waitFor();
    await settle(p);
    const s3b = await find("Загрузка в S3-совместимое хранилище");
    ok("re-attach keeps the task's own tags", s3b.epic_id !== null && s3b.tags.map((t) => t.name).join(",") === tagsBefore, tagsBefore);

    // picker «Создать эпик…» from a standalone task
    await card(p, "Обновить токен бота").click();
    await p.locator(".panel .task-title", { hasText: "Обновить токен бота" }).waitFor();
    await p.locator(".panel .add-tag", { hasText: "эпик" }).click();
    await p.locator(".epic-picker .ep-create").click();
    await p.keyboard.type("Токены и доступы");
    await shot(p, "10-picker-create");
    await p.keyboard.press("Enter");
    await p.locator(".panel .epic-chip", { hasText: "Токены и доступы" }).waitFor();
    await settle(p);
    const newEpic = await find("Токены и доступы");
    ok("«Создать эпик…» creates an epic with the task's tags and attaches the task", newEpic?.kind === "epic" && newEpic.tags.some((t) => t.name === "Пет-бот") && (await find("Обновить токен бота")).epic_id === newEpic.id);
    await shot(p, "11-after-create");

    // epic panel: new task in epic + attach existing
    await p.locator(".panel .epic-chip").click();
    await p.locator(".panel .kids").waitFor();
    await p.getByRole("button", { name: "Новая задача в эпике" }).click();
    await p.keyboard.type("Перевыпустить токен у BotFather");
    await p.keyboard.press("Enter");
    await p.locator(".panel .kid", { hasText: "Перевыпустить токен" }).waitFor();
    await p.keyboard.press("Escape");
    await p.getByRole("button", { name: "Привязать существующую…" }).click();
    await p.locator(".attach-pop").waitFor();
    await p.keyboard.type("лампы");
    await p.locator(".attach-pop .ep-item", { hasText: "Купить лампы" }).waitFor();
    await shot(p, "12-attach-existing");
    await p.locator(".attach-pop .ep-item", { hasText: "Купить лампы" }).click();
    await p.locator(".panel .kid", { hasText: "Купить лампы" }).waitFor();
    await p.keyboard.press("Escape");
    await settle(p);
    const lamps = await find("Купить лампы в коридор");
    ok("«Новая задача в эпике» and «Привязать существующую…» work; attach keeps tags", (await p.locator(".panel .kid").count()) === 3 && lamps.epic_id === newEpic.id && lamps.tags[0].name === "Дом");
    ok("epic progress on the card follows children", (await card(p, "Токены и доступы").locator(".progress-text").innerText()) === "0 из 3 готово");
    await shot(p, "13-epic-after-edits");
    await p.locator(".panel").getByRole("button", { name: "Закрыть панель" }).click();
    await settle(p);

    // ── epic filter + Back/reload + search + reset ──
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.locator(".epic-filter").click();
    await p.locator(".epic-filter-pop").waitFor();
    await shot(p, "14-filter-popover");
    await p.locator(".epic-filter-pop .ep-item", { hasText: "Резервные копии" }).click();
    await p.locator(".active-filter").waitFor();
    await settle(p);
    await shot(p, "15-filter-active");
    const backup = await find("Резервные копии");
    const visible = await p.locator(".card .card-title").allInnerTexts();
    ok("epic filter shows the epic and its tasks; URL has epic", visible.length === 4 && new URL(p.url()).searchParams.get("epic") === String(backup.id)
      && (await p.locator(".active-filter").innerText()).includes("Показаны задачи эпика «Резервные копии»"), visible.join(" | "));
    await card(p, "Скрипт бэкапа").click();
    await p.locator(".panel .task-title").waitFor();
    await p.goBack();
    await settle(p);
    ok("Back closes the panel and keeps the epic filter", (await p.locator(".panel").count()) === 0 && new URL(p.url()).searchParams.get("epic") === String(backup.id));
    await card(p, "Скрипт бэкапа").click();
    await p.locator(".panel .task-title").waitFor();
    await p.reload();
    await p.locator(".panel .task-title").waitFor();
    ok("reload keeps the panel and the epic filter", (await p.locator(".card").count()) === 4 && new URL(p.url()).searchParams.get("epic") === String(backup.id));
    await p.keyboard.press("Escape");
    await settle(p);
    await p.getByRole("button", { name: "Пет-бот" }).click();
    await p.fill("#q", "Загрузка");
    await settle(p, 600);
    ok("epic filter combines with tag and search", (await p.locator(".card").count()) === 1);
    await shot(p, "16-filter-tag-search");
    await p.fill("#q", "");
    await p.getByRole("button", { name: "Пет-бот" }).click();
    await settle(p, 600);
    await p.getByRole("button", { name: "Сбросить фильтр по эпику" }).click();
    await settle(p);
    ok("× resets the epic filter", !new URL(p.url()).searchParams.get("epic") && (await p.locator(".card").count()) > 10);
    // empty epic
    await p.locator(".epic-filter").click();
    await p.locator(".epic-filter-pop .ep-item", { hasText: "Пустой эпик" }).click();
    await settle(p);
    await shot(p, "17-filter-empty-epic");
    ok("empty epic: only the epic, empty columns say «Нет задач по фильтру»", (await p.locator(".card").count()) === 1 && (await p.locator(".column-empty", { hasText: "Нет задач по фильтру" }).count()) === 3);
    await p.locator(".active-filter .link-btn").click();
    await settle(p);

    // ── drag & drop an epic card between columns ──
    const epicCard = card(p, "Резервные копии");
    const target = p.locator(".column", { has: p.locator("h2", { hasText: "На проверке" }) }).locator(".column-list");
    const a = await epicCard.boundingBox();
    const b = await target.boundingBox();
    await p.mouse.move(a.x + a.width / 2, a.y + 20);
    await p.mouse.down();
    await p.mouse.move(a.x + a.width / 2 + 20, a.y + 30, { steps: 4 });
    await p.mouse.move(b.x + b.width / 2, b.y + b.height - 10, { steps: 12 });
    await frames(p, "18-dnd-epic", 4, 40);
    await p.mouse.up();
    await settle(p, 600);
    ok("epic card drags between columns (status changes, progress kept)", (await find("Резервные копии")).status === "review" && (await find("Резервные копии")).progress.total === 3);
    await api("POST", `/api/tasks/${backup.id}/move`, { status: "inbox", index: 0 });
    await settle(p, 600);

    // keyboard: Tab to an epic link, Enter opens the parent
    await card(p, "Отправка по таймеру").locator(".epic-link").focus();
    await p.keyboard.press("Enter");
    await p.locator(".panel .panel-kind").waitFor();
    ok("keyboard: Enter on the epic link opens the parent", (await p.locator(".panel .task-title").innerText()) === "Напоминания");
    await p.keyboard.press("Escape");
    await settle(p);

    // quick add as epic + kind switch
    await p.locator(".column", { has: p.locator("h2", { hasText: "Входящие" }) }).getByRole("button", { name: /Добавить задачу/ }).click();
    await p.keyboard.type("Новый эпик из доски");
    await p.locator(".qa-kind").click();
    await shot(p, "19-quick-add-epic");
    await p.keyboard.press("Enter");
    await card(p, "Новый эпик из доски").waitFor();
    ok("quick add creates an epic", (await find("Новый эпик из доски")).kind === "epic");
    await p.keyboard.press("Escape");
    await card(p, "Продлить домен").click();
    await p.getByRole("button", { name: "Сделать эпиком" }).click();
    await p.locator(".panel .panel-kind").waitFor();
    ok("«Сделать эпиком» converts a standalone task", (await find("Продлить домен")).kind === "epic");
    await p.getByRole("button", { name: "Сделать обычной задачей" }).click();
    await p.locator(".panel .panel-kind").waitFor({ state: "detached" });
    ok("…and back", (await find("Продлить домен")).kind === "task");
    await p.keyboard.press("Escape");
    await settle(p);

    // ── task page (direct URL) ──
    await p.goto(`${base}/t/${backup.id}`);
    await p.locator(".page .kids-list").waitFor();
    await settle(p, 300);
    await shot(p, "20-epic-page", { fullPage: true });
    await p.locator(".page .kid", { hasText: "Загрузка в S3" }).click();
    await p.waitForURL(new RegExp(`/t/${s3.id}$`));
    await p.locator(".crumb-epic").waitFor();
    await shot(p, "21-child-page", { fullPage: true });
    ok("page: epic → child navigation and the crumb to the epic", (await p.locator(".crumb-epic").innerText()) === "Резервные копии");

    // ── mobile ──
    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(base + "/");
    await p.locator(".card").first().waitFor();
    await p.locator(".board-wrap").evaluate((e) => e.scrollTo({ left: e.querySelector(".column:nth-child(2)").offsetLeft - 16 }));
    await settle(p, 400);
    await shot(p, "22-mobile-board");
    const filterFirst = await p.locator(".filters").evaluate((f) => { const vis = [...f.children].filter((c) => getComputedStyle(c).display !== "none"); vis.sort((x, y) => x.getBoundingClientRect().left - y.getBoundingClientRect().left); return vis[0].className; });
    ok("mobile: the epic filter is first in the filter strip", filterFirst.includes("epic-filter-wrap"), filterFirst);
    await p.locator(".epic-filter").click();
    await p.locator(".epic-filter-pop").waitFor();
    const pop = await p.locator(".epic-filter-pop").boundingBox();
    await shot(p, "23-mobile-filter-popover");
    ok("mobile: filter popover fits the screen", pop.x >= 0 && pop.x + pop.width <= 390, JSON.stringify(pop));
    await p.keyboard.press("Escape");
    await card(p, "Напоминания").click();
    await p.locator(".panel .kids").waitFor();
    await settle(p, 300);
    await shot(p, "24-mobile-epic-panel");
    const pw = await p.locator(".panel").boundingBox();
    ok("mobile: epic panel is full width", Math.round(pw.width) === 390);
    await p.locator(".panel .kid", { hasText: "Отправка по таймеру" }).click();
    await p.locator(".panel .epic-chip").waitFor();
    await p.locator(".panel .epic-change").click();
    await p.locator(".epic-picker").waitFor();
    const pk = await p.locator(".epic-picker").boundingBox();
    await shot(p, "25-mobile-picker");
    ok("mobile: picker fits the screen", pk.x >= 0 && pk.x + pk.width <= 390, JSON.stringify(pk));
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok("mobile: no horizontal page overflow", overflow <= 0, String(overflow));

    ok("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok("scenario finished", false, e.message.split("\n")[0]);
    await shot(p, "zz-error").catch(() => {});
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ base, at: new Date().toISOString(), results }, null, 2));
    const failed = results.filter((r) => !r.pass).length;
    console.log(`${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
