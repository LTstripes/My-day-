import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, saved} from './browser.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const resultFor = (page, id) => page.locator('#search-results [data-file-id="' + id + '"]');
const waitText = (locator, text) => locator.filter({hasText: text}).waitFor();

function addPlan(state, id, name, text) {
  const file = {name, text, version: 1, canEdit: false};
  state.files.set(id, file);
  return file;
}

async function pickPlan(page, id, action) {
  await page.evaluate(fileId => { pickTest.id = fileId; }, id);
  await page.locator('#plan-pick').click();
  await waitText(page.locator('#plan-action'), action);
}

async function search(page, query) {
  await page.locator('#search-query').fill(query);
  await page.locator('#search-submit').click();
}

test('search reads all selected plan and note IDs once, opens the exact excerpt, and preserves the draft', async t => {
  const {open, state} = await fixture(browser, t);
  state.files.get('fixture-a').text += '\n- [ ] Маршрут в заметке для записи.\n';
  const north = addPlan(state, 'plan-north', 'Поездка.md', '# Север\n- [ ] Маршрут через перевал.\n');
  addPlan(state, 'plan-south', 'Поездка.md', '# Юг\n- [x] Маршрут по берегу.\n- [ ] Подтвердить билеты.\n');
  addPlan(state, 'unselected', 'Поездка.md', '- [ ] Маршрут вне выбранных файлов.\n');
  const page = await open();
  await firstFile(page, true);
  await pickPlan(page, 'fixture-a', 'в заметке для записи');
  await pickPlan(page, 'plan-north', 'через перевал');
  await pickPlan(page, 'plan-south', 'Подтвердить билеты');
  await page.locator('#thought').fill('Черновик без переадресации');
  const profile = await saved(page);
  const pickerOpens = await page.evaluate(() => pickTest.opens);
  const reads = state.mediaReads.length;
  north.text = '# Север\n- [ ] Маршрут через долину.\n';
  north.version++;

  await search(page, 'маршрут');
  await waitText(page.locator('#search-status'), 'Файлов с совпадениями — 3.');
  assert.deepEqual(state.mediaReads.slice(reads).sort(), ['fixture-a', 'plan-north', 'plan-south']);
  for (const id of ['plan-north', 'plan-south']) await waitText(resultFor(page, id), 'ID ' + id);
  assert.equal(await resultFor(page, 'fixture-a').count(), 1);
  assert.equal(await resultFor(page, 'unselected').count(), 0);
  assert.doesNotMatch(await page.locator('#search').textContent(), /через перевал/);

  await resultFor(page, 'plan-north').locator('[data-hit]').click();
  const detail = page.locator('#search-detail');
  await waitText(detail, 'через долину');
  assert.equal(await detail.locator('mark').textContent(), 'Маршрут');
  const link = new URL(await page.locator('#search-drive-link').getAttribute('href'));
  assert.equal(link.searchParams.get('id'), 'plan-north');
  await page.locator('#search-draft').click();
  assert.equal(await page.locator('#thought').inputValue(), profile.draft.text);
  assert.deepEqual(await saved(page), profile);
  assert.equal(await page.evaluate(() => pickTest.opens), pickerOpens);

  const note = state.files.get('fixture-a');
  note.text = '- [ ] Маршрут в заметке с неверным заголовком.\n';
  note.version++;
  await page.locator('#search-submit').click();
  await waitText(page.locator('#search-status'), 'Прочитано 2 из 3.');
  await waitText(resultFor(page, 'fixture-a'), 'с заголовком из тестового шаблона');
  assert.equal(await resultFor(page, 'fixture-a').locator('[data-hit]').count(), 0);
  assert.equal(state.patches, 0);
});

test('refreshing a plan invalidates its stale excerpt or access denial without hiding other search results', async t => {
  const {open, state} = await fixture(browser, t);
  state.files.get('fixture-a').text += '\nМаршрут рядом с домом.\n';
  const trip = addPlan(state, 'trip-plan', 'Поездка.md', '- [ ] Маршрут к маяку.\n');
  const page = await open();
  await firstFile(page);
  await pickPlan(page, 'trip-plan', 'к маяку');
  await search(page, 'маршрут');
  const group = resultFor(page, 'trip-plan');
  const detail = page.locator('#search-detail');
  await group.locator('[data-hit]').click();
  await waitText(detail, 'к маяку');

  trip.text = '- [ ] Маршрут к переправе.\n';
  trip.version++;
  await page.locator('#plan-refresh').click();
  await waitText(group, 'Файл обновился');
  assert.equal(await detail.isVisible(), false);
  assert.doesNotMatch(await page.locator('#search').textContent(), /к маяку/);
  await waitText(resultFor(page, 'fixture-a'), 'рядом с домом');

  await page.locator('#search-submit').click();
  await group.locator('[data-hit]').click();
  await waitText(detail, 'к переправе');
  trip.refusal = {status: 403, reason: 'appNotAuthorizedToFile'};
  await page.locator('#plan-refresh').click();
  await waitText(group, /доступ|403/i);
  assert.equal(await detail.isVisible(), false);
  assert.equal(await page.locator('#search-drive-link').getAttribute('href'), null);
  assert.doesNotMatch(await page.locator('#search').textContent(), /к маяку|к переправе/);
  await waitText(resultFor(page, 'fixture-a'), 'рядом с домом');
  await waitText(page.locator('#search-status'), 'Прочитано 1 из 2.');
  assert.equal(state.patches, 0);
});

test('plan-only search drops a delayed result when personal settings are forgotten in another tab', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  addPlan(state, 'plan-only', 'Только план.md', '- [ ] Маршрут по тихой бухте.\n');
  const page = await open();
  await page.locator('#remember').check();
  await page.locator('#key').fill('AIza' + 'p'.repeat(35));
  await page.locator('#connect').click();
  await pickPlan(page, 'plan-only', 'по тихой бухте');
  assert.deepEqual((await saved(page)).fileIds, []);
  await search(page, 'маршрут');
  await waitText(resultFor(page, 'plan-only'), 'по тихой бухте');

  const other = await open();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const media = '**/drive/v3/files/plan-only?alt=media';
  await ctx.route(media, async route => { await hold; await route.fallback(); }, {times: 1});
  try {
    await Promise.all([page.waitForRequest(media, {timeout: 5000}), page.locator('#search-submit').click()]);
    await other.locator('#forget').click();
    await notice(page, 'удалены в другой вкладке');
  } finally { release(); }
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#search-query').inputValue(), '');
  assert.equal(await resultFor(page, 'plan-only').count(), 0);
  assert.doesNotMatch(await page.locator('#search').textContent(), /по тихой бухте/);
  assert.equal(await saved(page), null);
  assert.equal(state.patches, 0);
});
