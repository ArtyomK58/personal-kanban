// UI check of an INSTALLED instance (public URL) with self-cleaning test data and a persistent browser profile.
//   KANBAN_URL=https://… KANBAN_TOKEN=<test token> node scripts/prod-ui-check.cjs <out-dir> [--lock-test]
// --lock-test locks this client for 5 minutes on purpose and waits for the UI to recover.
const PW = process.env.PLAYWRIGHT_CORE || "playwright-core";
const { chromium } = require(PW);
const fs = require("fs");
const path = require("path");
const os = require("os");

const base = process.env.KANBAN_URL;
const token = process.env.KANBAN_TOKEN;
const out = process.argv[2] || "artifacts/prod-ui";
const lockTest = process.argv.includes("--lock-test");
const exe = process.env.CHROME || "/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
fs.mkdirSync(out, { recursive: true });
const results = [];
const ok = (n, c, x = "") => { results.push({ name: n, pass: !!c, extra: x }); console.log(`${c ? "PASS" : "FAIL"} ${n}${x ? " — " + x : ""}`); };
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const api = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return r.status === 204 ? null : r.json(); };
const shot = (p, n, o = {}) => p.screenshot({ path: path.join(out, n + ".png"), ...o });
const frames = async (p, n, k = 5, gap = 45) => { for (let i = 0; i < k; i++) { await shot(p, `${n}-f${i}`); await p.waitForTimeout(gap); } };

(async () => {
  // ── test data (removed at the end) ──
  const tag = await api("POST", "/api/tags", { name: "Тест деплоя", color: "rose" });
  const a = await api("POST", "/api/tasks", { title: "[тест] Проверить вход и панель", status: "in_progress", tag_ids: [tag.id], human_description: "## Проверка\n\n- [x] Вход по токену\n- [ ] Панель и «Назад»\n\n`kanban.example.com`" });
  const b2 = await api("POST", "/api/tasks", { title: "[тест] Вторая карточка", status: "inbox", tag_ids: [tag.id] });
  await api("POST", `/api/tasks/${a.id}/comments`, { body: "Комментарий из проверки деплоя" });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pk-profile-"));
  const consoleErrors = [];
  const open = async () => {
    const ctx = await chromium.launchPersistentContext(profile, { executablePath: exe, viewport: { width: 1440, height: 900 }, locale: "ru-RU" });
    const p = ctx.pages()[0] || (await ctx.newPage());
    p.on("pageerror", (e) => consoleErrors.push(e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/401|429/.test(m.text())) consoleErrors.push(m.text()); });
    return { ctx, p };
  };
  try {
    let { ctx, p } = await open();
    await p.goto(`${base}/t/${a.id}`);
    await p.waitForURL(/\/login$/);
    ok("deep link without session → /login", true);
    await shot(p, "01-login");
    await p.fill("#token", "pk_wrong_once");
    await p.click("button[type=submit]");
    await p.getByText("Неверный токен").waitFor();
    await shot(p, "02-login-wrong");
    await p.fill("#token", token);
    await p.click("button[type=submit]");
    await p.waitForURL(new RegExp(`/t/${a.id}$`));
    await p.locator(".page .task-title").waitFor();
    ok("login returns to the requested task", true);
    await shot(p, "03-task-after-login", { fullPage: true });
    const cookies = await ctx.cookies(base);
    const c = cookies.find((x) => x.name === "pk_session");
    const days = c ? Math.round((c.expires * 1000 - Date.now()) / 864e5) : 0;
    ok("session cookie: HttpOnly, Secure, SameSite=Strict, ~400 days", c && c.httpOnly && c.secure && c.sameSite === "Strict" && days >= 399, `expires in ${days} d`);
    ok("token is not stored in localStorage/URL", !(await p.evaluate((t) => JSON.stringify(localStorage).includes(t), token)) && !p.url().includes(token));
    await p.reload();
    await p.locator(".page .task-title").waitFor();
    ok("reload keeps the session", !p.url().endsWith("/login"));
    // close the browser completely and start it again with the same profile
    await ctx.close();
    ({ ctx, p } = await open());
    await p.goto(`${base}/`);
    await p.locator(".card").first().waitFor();
    ok("browser restart keeps the session (no login screen)", !p.url().endsWith("/login"));
    await shot(p, "04-board-after-browser-restart");
    // board → panel → back
    await p.getByRole("button", { name: "Тест деплоя" }).click();
    await p.locator(".active-filter").waitFor();
    await shot(p, "05-filter");
    await p.locator(".card", { hasText: "Проверить вход и панель" }).click();
    await frames(p, "06-panel-open", 5, 40);
    await p.locator(".panel .task-title").waitFor();
    await p.waitForTimeout(200);
    await shot(p, "07-panel");
    ok("panel shows markdown, comment; URL has task + filter", (await p.locator(".panel .md input[type=checkbox]").count()) === 2 && new URL(p.url()).searchParams.get("task") === String(a.id) && !!new URL(p.url()).searchParams.get("tags"));
    // live update through SSE behind Caddy
    await api("POST", `/api/tasks/${a.id}/comments`, { body: "SSE через Caddy: живое обновление" });
    await p.getByText("SSE через Caddy").waitFor({ timeout: 8000 });
    ok("SSE live update works through the HTTPS proxy", true);
    await p.goBack();
    await p.waitForTimeout(300);
    await frames(p, "08-after-back", 3, 40);
    ok("Back closes the panel and keeps the filter", (await p.locator(".panel").count()) === 0 && !!new URL(p.url()).searchParams.get("tags"));
    await p.setViewportSize({ width: 390, height: 844 });
    await p.waitForTimeout(250);
    await shot(p, "09-mobile");
    await p.setViewportSize({ width: 1440, height: 900 });
    await ctx.close();

    if (lockTest) {
      // fresh profile: no session; lock this client and wait for recovery
      const prof2 = fs.mkdtempSync(path.join(os.tmpdir(), "pk-lock-"));
      const ctx2 = await chromium.launchPersistentContext(prof2, { executablePath: exe, viewport: { width: 1440, height: 900 }, locale: "ru-RU" });
      const q = ctx2.pages()[0] || (await ctx2.newPage());
      await q.goto(`${base}/login`);
      for (let i = 0; i < 5; i++) { await q.fill("#token", "pk_wrong_" + i); await q.click("button[type=submit]"); await q.waitForTimeout(300); }
      await q.getByText(/Слишком много неудачных попыток/).waitFor();
      await shot(q, "10-locked");
      const btn = q.locator("button[type=submit]");
      ok("UI shows the lock with countdown, button disabled", (await btn.isDisabled()) && /через \d+ мин/.test(await btn.innerText()), await q.locator(".field-error").innerText());
      await q.waitForTimeout(2000);
      await shot(q, "11-locked-countdown");
      const t0 = Date.now();
      await q.getByText("Можно попробовать снова.").waitFor({ timeout: 320_000 });
      await shot(q, "12-recovered");
      ok("UI recovers after the cooldown", true, `${Math.round((Date.now() - t0) / 1000)} s`);
      await q.fill("#token", token);
      await q.click("button[type=submit]");
      await q.locator(".card").first().waitFor();
      ok("login works after the cooldown", true);
      await q.getByRole("button", { name: "Меню" }).click();
      await q.getByRole("menuitem", { name: "Выйти" }).click();
      await q.waitForURL(/\/login$/);
      ok("logout returns to login", (await q.evaluate(() => fetch("/api/board").then((r) => r.status))) === 401);
      await ctx2.close();
      fs.rmSync(prof2, { recursive: true, force: true });
    }
    ok("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  } finally {
    await api("DELETE", `/api/tasks/${a.id}`);
    await api("DELETE", `/api/tasks/${b2.id}`);
    await api("DELETE", `/api/tags/${tag.id}`);
    const left = await api("GET", "/api/board");
    ok("test data removed", !left.tasks.some((t) => t.title.startsWith("[тест]")) && !left.tags.some((t) => t.name === "Тест деплоя"));
    fs.rmSync(profile, { recursive: true, force: true });
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ base, at: new Date().toISOString(), results }, null, 2));
    const failed = results.filter((r) => !r.pass).length;
    console.log(`${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => { console.error("SCRIPT ERROR", e.message); process.exit(2); });
