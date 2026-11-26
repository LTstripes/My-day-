import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, saved} from './browser.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const firstAction = 'Забронировать поезд';
const secondAction = 'Проверить бронь';
const source = [
  '---', '- [ ] Пример в метаданных', '---', '# Поездка', '',
  '```markdown', '- [ ] Пример в блоке кода', '```', '',
  '<!--', '- [ ] Скрытый пример', '-->', '',
  '    - [ ] Пример с отступом', '',
  '- [x] Завершённый шаг', '- [X] Ещё один завершённый шаг',
  '1. [ ] ' + firstAction, '- [ ] ' + secondAction, ''
].join('\r\n');

function addPlan(state, id, name, text) {
  const file = {name, text, version: 1, canEdit: false};
  state.files.set(id, file);
  return file;
}

async function pick(page, id, selector = '#plan-pick') {
  await page.evaluate(fileId => { pickTest.id = fileId; pickTest.query = null; }, id);
  await page.locator(selector).click();
}

async function action(page, text) {
  await page.locator('#plan-action').getByText(text, {exact: true}).waitFor();
}

async function assertNoPlanText(page, ...texts) {
  const panel = await page.locator('#plans').textContent();
  for (const text of texts) assert(!panel.includes(text), 'Unexpected plan text: ' + text);
}

function assertReadOnly(state) {
  assert.equal(state.patches, 0);
  assert.deepEqual([...new Set(state.calls)].sort(), ['GET']);
}

test('a chosen read-only Markdown plan shows its first real open action and refreshes independently of the Inbox draft', async t => {
  const {open, state} = await fixture(browser, t, {viewport: {width: 360, height: 780}});
  const trip = addPlan(state, 'trip-plan', 'Поездка в Казань.md', source);
  state.files.set('inbox', {name: 'Мысли.md', text: '# Мысли\n', version: 1});
  const page = await open();
  await firstFile(page, true);

  // Arbitrary filenames must remain unavailable in the standard note picker.
  await pick(page, 'trip-plan', '#pick');
  await notice(page, /Мысли\.md.*Now\.md.*My-Day-test\.md/);
  assert(!state.mediaReads.includes('trip-plan'));
  assert.equal((await saved(page)).activeId, 'fixture-a');

  await pick(page, 'inbox', '#today-capture');
  await page.locator('#target').filter({hasText: 'Запись в Мысли.md'}).waitFor();
  assert.equal(await page.evaluate(() => pickTest.query), 'Мысли.md');
  await page.locator('#thought').fill('Черновик для Inbox');
  const draft = (await saved(page)).draft;

  // Today also keeps its exact-name picker constraints.
  for (const name of ['Now.md', 'To Do now.md']) {
    await pick(page, 'trip-plan', `[data-day-pick="${name}"]`);
    assert.equal(await page.evaluate(() => pickTest.query), name);
    await page.locator('#status').getByText(name, {exact: false}).waitFor();
  }
  assert(!state.mediaReads.includes('trip-plan'));

  await pick(page, 'trip-plan');
  await action(page, firstAction);
  await assertNoPlanText(page, 'Пример в метаданных', 'Пример в блоке кода', 'Скрытый пример', 'Пример с отступом', 'Завершённый шаг', secondAction);
  assert.equal(await page.evaluate(() => pickTest.query), null);
  assert.equal(await page.locator('#plan-link').getAttribute('href'), 'https://drive.google.com/open?id=trip-plan');
  assert.equal((await saved(page)).activeId, 'inbox');
  assert.deepEqual((await saved(page)).draft, draft);
  assert(!(await saved(page)).fileIds.includes('trip-plan'));
  assert.equal(await page.locator('#thought').inputValue(), draft.text);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  trip.text = trip.text.replace('1. [ ] ', '1. [x] ');
  trip.version++;
  const reads = state.mediaReads.length;
  await page.locator('#plan-refresh').click();
  await action(page, secondAction);
  await assertNoPlanText(page, firstAction);
  assert.deepEqual(state.mediaReads.slice(reads), ['trip-plan']);
  assert.deepEqual((await saved(page)).draft, draft);

  trip.text = '# Поездка\n- [x] Всё собрано\n';
  trip.version++;
  await page.locator('#plan-refresh').click();
  await page.locator('#plan-state').getByText('В плане нет незавершённых действий.', {exact: false}).waitFor();
  await page.locator('#plan-action').waitFor({state: 'hidden'});
  await assertNoPlanText(page, firstAction, secondAction);
  assert.equal(await page.locator('#plan-link').isVisible(), true);
  await page.locator('#today-capture').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'thought');
  assert.equal(await page.locator('#thought').inputValue(), draft.text);
  assertReadOnly(state);
});

test('a plan loses its text and source link on a permission refusal, and can switch sources before logout', async t => {
  const {open, state} = await fixture(browser, t);
  const trip = addPlan(state, 'trip-plan', 'Поездка.md', '- [ ] Сверить маршрут');
  addPlan(state, 'other-plan', 'Проект.md', '- [ ] Согласовать чертёж');
  const page = await open();
  await firstFile(page, true);
  await pick(page, 'trip-plan');
  await action(page, 'Сверить маршрут');

  trip.refusal = {status: 403, reason: 'appNotAuthorizedToFile'};
  await page.locator('#plan-refresh').click();
  await page.locator('#plan-state').getByText(/доступ|403/i).waitFor();
  await assertNoPlanText(page, 'Сверить маршрут');
  assert.equal(await page.locator('#plan-link').isVisible(), false);

  await pick(page, 'other-plan');
  await action(page, 'Согласовать чертёж');
  await assertNoPlanText(page, 'Сверить маршрут');
  assert.equal(await page.locator('#plan-link').getAttribute('href'), 'https://drive.google.com/open?id=other-plan');
  assert.deepEqual((await saved(page)).plan, {id: 'other-plan', name: 'Проект.md'});
  await page.locator('#disconnect').click();
  await assertNoPlanText(page, 'Сверить маршрут', 'Согласовать чертёж');
  assert.equal(await page.locator('#plan-link').isVisible(), false);
  assertReadOnly(state);
});

test('a delayed plan response cannot restore private text after forgetting the device in another tab', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  const trip = addPlan(state, 'trip-plan', 'Поездка.md', '- [ ] Старое действие');
  const page = await open();
  await firstFile(page, true);
  await pick(page, 'trip-plan');
  await action(page, 'Старое действие');

  const other = await open();
  trip.text = '- [ ] Ответ из прежнего сеанса';
  trip.version++;
  let releaseRead;
  const paused = new Promise(resolve => { releaseRead = resolve; });
  const mediaUrl = '**/drive/v3/files/trip-plan?alt=media';
  await ctx.route(mediaUrl, async route => {
    await paused;
    await route.fallback();
  }, {times: 1});
  try {
    await Promise.all([
      page.waitForRequest(mediaUrl, {timeout: 5000}),
      page.locator('#plan-refresh').click()
    ]);
    await other.locator('#forget').click();
    await notice(page, 'удалены в другой вкладке');
    await assertNoPlanText(page, 'Старое действие');
  } finally {
    releaseRead();
  }
  await page.waitForLoadState('networkidle');
  await assertNoPlanText(page, 'Старое действие', 'Ответ из прежнего сеанса');
  assert.equal(await page.locator('#plan-link').isVisible(), false);
  assert.equal(await saved(page), null);
  assertReadOnly(state);
});

test('an older plan response cannot replace a plan chosen in another personal tab', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  const trip = addPlan(state, 'trip-plan', 'Поездка.md', '- [ ] Сверить маршрут');
  addPlan(state, 'other-plan', 'Проект.md', '- [ ] Согласовать чертёж');
  const page = await open();
  await firstFile(page, true);
  await pick(page, 'trip-plan');
  await action(page, 'Сверить маршрут');
  const other = await open();
  await other.locator('#connect').click();
  await action(other, 'Сверить маршрут');

  trip.text = '- [ ] Запоздавшее действие старого плана';
  trip.version++;
  let releaseRead;
  const paused = new Promise(resolve => { releaseRead = resolve; });
  const mediaUrl = '**/drive/v3/files/trip-plan?alt=media';
  await ctx.route(mediaUrl, async route => {
    await paused;
    await route.fallback();
  }, {times: 1});
  await page.evaluate(() => {
    const action = document.getElementById('plan-action');
    window.observedPlanActions = [];
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) observedPlanActions.push(node.textContent);
      }
    }).observe(action, {childList: true});
  });
  try {
    await Promise.all([
      page.waitForRequest(mediaUrl, {timeout: 5000}),
      page.locator('#plan-refresh').click()
    ]);
    await pick(other, 'other-plan');
    await action(other, 'Согласовать чертёж');
    await page.locator('#plan-source').getByText('Проект.md', {exact: true}).waitFor();
  } finally {
    releaseRead();
  }
  await action(page, 'Согласовать чертёж');
  for (const tab of [page, other]) {
    await assertNoPlanText(tab, 'Сверить маршрут', 'Запоздавшее действие старого плана');
    assert.equal(await tab.locator('#plan-link').getAttribute('href'), 'https://drive.google.com/open?id=other-plan');
  }
  const rendered = await page.evaluate(() => observedPlanActions);
  assert(!rendered.includes('Запоздавшее действие старого плана'));
  assertReadOnly(state);
});

test('a plan-only selection restores its ID after opt-in and does not persist in shared mode', async t => {
  const {open, state} = await fixture(browser, t);
  const trip = addPlan(state, 'trip-plan', 'Поездка.md', '- [ ] Проверить гостиницу');
  let page = await open();
  assert.equal(await page.locator('#remember').isChecked(), false);
  await page.locator('#key').fill('AIza' + 'p'.repeat(35));
  await page.locator('#connect').click();
  await pick(page, 'trip-plan');
  await action(page, 'Проверить гостиницу');
  assert.equal(await saved(page), null);
  await page.reload();
  await assertNoPlanText(page, 'Проверить гостиницу', 'Поездка.md');
  assert.equal(await page.locator('#plan-link').isVisible(), false);

  await page.locator('#remember').check();
  await page.locator('#key').fill('AIza' + 'p'.repeat(35));
  await page.locator('#connect').click();
  await pick(page, 'trip-plan');
  await action(page, 'Проверить гостиницу');
  const device = await saved(page);
  assert.deepEqual(device.plan, {id: 'trip-plan', name: 'Поездка.md'});
  assert(!JSON.stringify(device).includes('Проверить гостиницу'));
  await page.close();

  trip.text = '- [ ] Уточнить адрес';
  trip.version++;
  const reads = state.mediaReads.length;
  page = await open();
  await assertNoPlanText(page, 'Проверить гостиницу', 'Уточнить адрес');
  assert.equal(state.mediaReads.length, reads);
  await page.locator('#connect').click();
  await action(page, 'Уточнить адрес');
  await assertNoPlanText(page, 'Проверить гостиницу');
  assert.equal(await page.evaluate(() => pickTest.opens), 0);
  assert.deepEqual(state.mediaReads.slice(reads), ['trip-plan']);
  assertReadOnly(state);
});
