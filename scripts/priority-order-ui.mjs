import fs from 'node:fs';
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:18497';
export const config = {
  label: 'Priority ordering — isolated synthetic board',
  url: base,
  executablePath: '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
  viewport: { width: 1440, height: 1000 },
  watch: ['.topbar', '.board', '.column-head'],
  maxDurationMs: 60000,
};
export default async function({ page, context, step, checkpoint }) {
  const token = fs.readFileSync(process.env.KANBAN_TOKEN_FILE, 'utf8').trim();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Kanban-Client': 'web' };
  const api = async (method, path, body) => {
    const r = await context.request.fetch(base + path, { method, headers, ...(body ? { data: body } : {}) });
    assert(r.ok(), `${method} ${path}: ${r.status()}`);
    return r.json();
  };
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const board = () => api('GET', '/api/board');
  const find = async (title) => (await board()).tasks.find((t) => t.title.startsWith(title));
  const card = (id) => page.locator('.card').filter({ has: page.locator('.card-title a', { hasText: new RegExp('^' + titles.get(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
  const titles = new Map((await board()).tasks.map((t) => [t.id, t.title]));
  const column = (name) => page.locator('.column', { has: page.getByRole('heading', { name, exact: true }) });
  const visibleIds = (name) => column(name).locator('.card .card-title a').evaluateAll((els) => els.map((e) => Number(e.getAttribute('href').split('/').pop())));
  const assertSorted = async () => {
    for (const c of await page.locator('.column').all()) {
      const ranks = await c.locator('.column-list > .card').evaluateAll((cards) => cards.map((c) => c.querySelector('.prio-high') ? 0 : c.querySelector('.prio-low') ? 2 : 1));
      assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    }
  };
  const sortedReady = () => page.waitForFunction(() => [...document.querySelectorAll('.column')].every((c) => {
    const r = [...c.querySelectorAll('.column-list > .card')].map((c) => c.querySelector('.prio-high') ? 0 : c.querySelector('.prio-low') ? 2 : 1);
    return r.every((v, i) => !i || r[i - 1] <= v);
  }));
  const drag = async (source, target, label) => {
    const a = await source.boundingBox(), b = await target.boundingBox(); assert(a && b);
    await page.mouse.move(a.x + a.width / 2, a.y + 28); await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 10, a.y + 30, { steps: 3 });
    await page.mouse.move(b.x + b.width / 2, b.y + 12, { steps: 18 });
    await checkpoint(label + ' — dragging'); await page.mouse.up();
  };
  await step('First visit: high → normal → low', async () => {
    const r = await context.request.post(base + '/api/auth/login', { data: { token }, headers: { 'X-Kanban-Client': 'web' } }); assert(r.ok());
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('.card').first().waitFor(); await sortedReady(); await assertSorted();
    const raw = (await board()).tasks.filter((t) => t.status === 'inbox');
    const expected = [...raw].sort((a, b) => ({ high: 0, normal: 1, low: 2 }[a.priority] - { high: 0, normal: 1, low: 2 }[b.priority])).map((t) => t.id);
    assert.deepEqual(await visibleIds('Входящие'), expected);
  }, { expected: 'Every column groups priorities, existing peer order preserved' });
  const high = await find('Записаться к стоматологу'), epic = await find('Резервные копии');
  await step('Drag within high priority and save', async () => {
    await drag(card(high.id), card(epic.id), 'High peer reorder');
    await page.waitForFunction((id) => document.querySelector('.column .card-title a')?.getAttribute('href') === '/t/' + id, high.id);
    assert.deepEqual((await visibleIds('Входящие')).slice(0, 2), [high.id, epic.id]); await assertSorted();
  }, { expected: 'High peers reorder while high still precedes normal and low' });
  await step('Reload preserves manual peer order', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.card').first().waitFor(); await sortedReady();
    assert.deepEqual((await visibleIds('Входящие')).slice(0, 2), [high.id, epic.id]); await assertSorted();
  }, { expected: 'No reset to the previous order after reload' });
  const low = await find('Купить лампы');
  await step('A low task dropped above high stays in its priority group', async () => {
    await drag(card(low.id), card(high.id), 'Cross-priority drop'); await sortedReady();
    assert((await visibleIds('Входящие')).indexOf(low.id) > (await visibleIds('Входящие')).indexOf(high.id)); await assertSorted();
  }, { expected: 'Low priority cannot be saved above high priority' });
  await step('Panel priority change immediately repositions the card', async () => {
    await card(high.id).click(); await page.locator('.panel .prio-field').waitFor();
    const response = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/tasks/' + high.id));
    await page.locator('.panel .prio-low').click(); await response;
    await page.locator('.panel .prio-low[aria-checked=true]').waitFor();
    await page.waitForFunction((id) => document.querySelector(`.column .card-title a[href='/t/${id}']`)?.closest('.card')?.querySelector('.prio-low'), high.id);
    await sortedReady(); await assertSorted(); await page.keyboard.press('Escape');
  }, { expected: 'Updated priority appears in the correct group without a page reload' });
  await step('Cross-column drop keeps priority and sorts destination', async () => {
    await drag(card(epic.id), column('На проверке').locator('.column-list'), 'Cross-column drop');
    await page.waitForFunction((id) => [...document.querySelectorAll('.column')].find((c) => c.getAttribute('aria-label') === 'На проверке')?.querySelector(`.card-title a[href='/t/${id}']`), epic.id);
    await sortedReady(); assert.equal((await find('Резервные копии')).status, 'review'); await assertSorted();
  }, { expected: 'Moved high-priority epic is above normal tasks in its destination' });
  await step('Project filter and return preserve sorting', async () => {
    await page.getByRole('button', { name: 'Пет-бот', exact: true }).click();
    await page.locator('.active-filter').waitFor(); await sortedReady(); await assertSorted();
    await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
    await page.locator('.active-filter').waitFor({ state: 'hidden' }); await sortedReady(); await assertSorted();
  }, { expected: 'Filtering and returning do not revert to unsorted data' });
  await step('Mobile columns preserve priority order', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await assertSorted();
    assert((await visibleIds('Входящие')).length > 0);
  }, { expected: 'Same ordering at phone width; horizontal board remains usable' });
  assert.deepEqual(errors, []);
}
