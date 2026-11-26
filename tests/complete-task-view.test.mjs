import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, saved} from './browser.mjs';

const live = process.env.MY_DAY_TASK_SMOKE === 'live';
const published = 'https://ltstripes.github.io/My-day-/';
const taskSource = await readFile(new URL('./fixtures/To Do now.md', import.meta.url), 'utf8');
const checked = taskSource.replace('- [ ] Проверить фонарик', '- [x] Проверить фонарик');
assert.notEqual(checked, taskSource);
const taskId = 'day-tasks';
const cardSelector = '#today-tasks';
const draftText = 'Отдельная мысль для Inbox';
let browser;
before(async () => { browser = await chromium.launch(live ? {channel: 'chrome'} : {}); });
after(async () => { await browser?.close(); });

async function pick(page, id, selector) {
  await page.evaluate(fileId => { pickTest.id = fileId; }, id);
  await page.locator(selector).click();
}

async function setup(t, canEdit = true) {
  const {ctx, open, state} = await fixture(browser, t, {serviceWorkers: 'block'});
  const tasks = {name: 'To Do now.md', text: taskSource, version: 1, canEdit};
  state.files.set(taskId, tasks);
  let page;
  if (live) {
    // Only the app comes from Pages. The fixture handles every request to Google.
    await ctx.route(published + '**', route => route.continue());
    page = await ctx.newPage();
    assert.equal((await page.goto(published)).status(), 200);
  } else {
    page = await open();
  }
  page.setDefaultTimeout(6000);
  await firstFile(page, true);
  await page.locator('#thought').fill(draftText);
  await pick(page, taskId, '[data-day-pick="To Do now.md"]');
  const card = page.locator(cardSelector);
  await card.locator('li').filter({hasText: 'Проверить фонарик'}).waitFor();
  return {ctx, page, state, tasks, card, button: card.locator('[data-complete]')};
}

test('one click checks the selected source only after readback, leaving a pinned plan and Inbox draft in place', async t => {
  const {ctx, page, state, tasks, card, button} = await setup(t);
  const plan = {name: 'Прогулка.md', text: '- [ ] Пройти маршрут', version: 1};
  state.files.set('plan-a', plan);
  await pick(page, 'plan-a', '#plan-pick');
  await page.locator('#plan-action').filter({hasText: 'Пройти маршрут'}).waitFor();
  await page.locator('#plan-pin').click();
  await page.locator('#today-plan-action').filter({hasText: 'Пройти маршрут'}).waitFor();
  const draft = (await saved(page)).draft;
  const inbox = {...state.files.get('fixture-a')};
  assert.equal(await button.count(), 1);
  assert.equal(await card.locator('[data-kind=bullet] button').count(), 0);
  assert.equal(await page.locator('#today-plan [data-complete]').count(), 0);

  let readbackStarted, resumeRead;
  const started = new Promise(resolve => { readbackStarted = resolve; });
  const release = new Promise(resolve => { resumeRead = resolve; });
  await ctx.route('**/drive/v3/files/day-tasks?alt=media', async route => {
    if (state.patches) {
      readbackStarted();
      await release;
    }
    await route.fallback();
  });
  try {
    await button.click();
    await Promise.race([started, page.locator('#status').filter({hasText: 'Дело выполнено'}).waitFor()]);
    assert.equal(tasks.text, checked);
    assert.equal(await button.isDisabled(), true);
    assert.doesNotMatch(await page.locator('#status').textContent(), /отметка подтверждена/i);
  } finally { resumeRead(); }
  await notice(page, 'Отметка подтверждена чтением');
  assert.equal(await button.count(), 0);
  assert.equal(await card.locator('[data-open]').getAttribute('href'), 'https://drive.google.com/open?id=day-tasks');
  assert.match(await card.textContent(), /Выполнено задач: 2/);
  assert.equal(state.patches, 1);
  assert.deepEqual(state.files.get('fixture-a'), inbox);
  assert.equal(plan.version, 1);
  assert.equal((await saved(page)).pinnedPlanId, 'plan-a');
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(await page.locator('#thought').inputValue(), draftText);
});

test('a lost write reply without any plan can be reconciled by refresh without another write', async t => {
  const {page, state, tasks, card, button} = await setup(t);
  state.loseReply = true;
  await button.click();
  await notice(page, /не удалось связаться/i);
  assert.equal(tasks.text, checked);
  assert.doesNotMatch(await page.locator('#status').textContent(), /отметка подтверждена/i);
  const reads = state.mediaReads.length;
  await page.locator('#today-refresh').click();
  await card.filter({hasText: 'Выполнено задач: 2'}).waitFor();
  await notice(page, 'Обзор обновлён из Drive.');
  assert.equal(await page.locator('#status').evaluate(el => el.classList.contains('error')), false);
  assert(state.mediaReads.slice(reads).includes(taskId));
  assert.equal(await button.count(), 0);
  assert.equal(state.patches, 1);
  assert.equal(await page.locator('#thought').inputValue(), draftText);
});

test('refresh keeps a source failure visible while another Today source loads successfully', async t => {
  const {page, state, tasks, card} = await setup(t);
  state.files.set('focus', {name: 'Now.md', text: '# Now\nФокус', version: 1});
  await pick(page, 'focus', '[data-day-pick="Now.md"]');
  await page.locator('#today-context').filter({hasText: 'Фокус'}).waitFor();
  tasks.refusal = {status: 403, reason: 'appNotAuthorizedToFile'};
  await page.locator('#today-refresh').click();
  await notice(page, 'Не удалось обновить весь обзор');
  assert.match(await card.textContent(), /403/);
  assert.equal(await page.locator('#status').evaluate(el => el.classList.contains('error')), true);
});

test('a concurrent edit yields 412, refreshes the card, and a new click marks the chosen row', async t => {
  const {page, state, tasks, card, button} = await setup(t);
  const updated = '- [ ] Проверить батарейки\n' + taskSource;
  state.beforeTaskWrite = file => {
    file.text = updated;
    file.version++;
    delete state.beforeTaskWrite;
  };
  await button.click();
  await notice(page, /список изменился/i);
  assert.equal(state.patches, 0);
  assert.equal(tasks.text, updated);
  assert.equal(await button.count(), 2);
  await card.getByRole('button', {name: 'Выполнено — Проверить фонарик'}).click();
  await notice(page, 'Отметка подтверждена чтением');
  assert.equal(tasks.text, '- [ ] Проверить батарейки\n' + checked);
  assert.equal(await card.getByRole('button', {name: 'Выполнено — Проверить батарейки'}).count(), 1);
  assert.equal(state.patches, 1);
});

test('a read-only source stays readable without an action, including after write permission is revoked', async t => {
  const {page, state, tasks, card, button} = await setup(t, false);
  assert.match(await card.textContent(), /только чтение/i);
  assert.equal(await button.count(), 0);
  tasks.canEdit = true;
  await page.locator('#today-refresh').click();
  await button.waitFor();
  tasks.canEdit = false;
  await button.click();
  await notice(page, /право редактирования/i);
  assert.equal(await button.count(), 0);
  assert.equal(state.patches, 0);
  assert.equal(tasks.text, taskSource);
  assert.equal(await page.locator('#thought').inputValue(), draftText);
});
