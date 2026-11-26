import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, saved} from './browser.mjs';

const published = 'https://ltstripes.github.io/My-day-/';
const live = process.env.MY_DAY_DAILY_PLANS_SMOKE === 'live';
const personalKey = 'AIza' + 'p'.repeat(35);
const draftText = 'Черновик для отдельной заметки';
const projectId = 'plan-project';
const tripId = 'plan-trip';
const projectName = 'Проект.md';
const tripName = 'Поездка.md';
const projectAction = 'Согласовать чертёж';
const tripAction = 'Проверить бронь';
const remoteTripAction = 'Уточнить путь от вокзала';
const tripText = [
  '# Поездка', '', '- [ ] ' + tripAction, '', 'Сапсан — запасной рейс.',
  'Сапсан — основной рейс.', ''
].join('\r\n');

let browser;
before(async () => { browser = await chromium.launch(live ? {channel: 'chrome'} : {}); });
after(async () => { await browser?.close(); });

function planFixture(state, id, name, fileText) {
  const file = {name, text: fileText, version: 1, canEdit: false};
  state.files.set(id, file);
  return file;
}

async function setup(t, info = {}) {
  const {ctx, state, open} = await fixture(browser, t, {serviceWorkers: 'block', ...info});
  if (!live) return {ctx, state, open};

  // Keep Google and Drive on the test fixture while loading the deployed app bytes.
  await ctx.route(published + '**', route => route.continue());
  return {ctx, state, async open() {
    const page = await ctx.newPage();
    assert.equal((await page.goto(published)).status(), 200);
    await page.waitForFunction(() => !document.getElementById('connect').disabled);
    return page;
  }};
}

const waitText = (page, selector, text) => page.locator(selector).filter({hasText: text}).waitFor();
const pickerOpens = page => page.evaluate(() => pickTest.opens);

async function pickPlan(page, id) {
  await page.evaluate(fileId => { pickTest.id = fileId; }, id);
  await page.locator('#plan-pick').click();
}

function driveLink(id) {
  return 'https://drive.google.com/open?id=' + id;
}

async function assertDraft(page) {
  assert.equal(await page.locator('#target').textContent(), 'Запись в My-Day-test.md');
  assert.equal(await page.locator('#thought').inputValue(), draftText);
  assert.deepEqual((await saved(page)).draft, {fileId: 'fixture-a', text: draftText, op: null});
}

function assertReadOnly(state) {
  assert.equal(state.patches, 0);
  assert.deepEqual([...new Set(state.calls)], ['GET']);
}

test('two plans, a search hit in the other plan, and a pinned action on Today leave the concurrent Inbox draft intact', async t => {
  const {ctx, open, state} = await setup(t, {viewport: {width: 360, height: 780}});
  planFixture(state, projectId, projectName, '- [ ] ' + projectAction);
  const trip = planFixture(state, tripId, tripName, tripText);
  planFixture(state, 'unselected-plan', 'Другой план.md', '- [ ] Сапсан вне выбранных файлов');
  const page = await open();
  await firstFile(page, true);
  await pickPlan(page, projectId);
  await waitText(page, '#plan-action', projectAction);
  await page.locator('#today-plan').waitFor({state: 'hidden'});

  const tripMedia = '**/drive/v3/files/' + tripId + '?alt=media';
  let releaseRead;
  const paused = new Promise(resolve => { releaseRead = resolve; });
  await ctx.route(tripMedia, async route => {
    await paused;
    await route.fallback();
  }, {times: 1});
  try {
    await Promise.all([
      page.waitForRequest(tripMedia, {timeout: 5000}),
      pickPlan(page, tripId)
    ]);
    await page.locator('#thought').fill(draftText);
    await assertDraft(page);
  } finally {
    releaseRead();
  }
  await waitText(page, '#plan-action', tripAction);

  const pickerCount = await pickerOpens(page);
  const planSelect = page.locator('#plan-select');
  await planSelect.selectOption(projectId);
  await waitText(page, '#plan-action', projectAction);
  assert.equal(await pickerOpens(page), pickerCount);
  await page.locator('#today-plan').waitFor({state: 'hidden'});

  const index = state.mediaReads.length;
  await page.locator('#search-query').fill('САПСАН');
  await page.locator('#search-submit').click();
  const otherPlan = page.locator('#search-results [data-file-id="' + tripId + '"]');
  const hit = otherPlan.getByRole('button', {name: /^Строка 6/});
  await hit.click();
  assert.equal(await otherPlan.locator('[data-hit]').count(), 2);
  assert.equal(await page.locator('#search-detail').getAttribute('data-file-id'), tripId);
  assert.match(await page.locator('#search-position').textContent(), /^Строка 6 · /);
  const marker = page.locator('#search-text mark');
  assert.equal(await marker.textContent(), 'Сапсан');
  assert.match(await marker.evaluate(element => element.nextSibling.textContent), /^ — основной рейс\./);
  assert.equal(await page.locator('#search-drive-link').getAttribute('href'), driveLink(tripId));
  assert(state.mediaReads.slice(index).includes(tripId));
  assert(!state.mediaReads.includes('unselected-plan'));
  assert.equal(await planSelect.inputValue(), projectId);
  await page.locator('#search-draft').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'thought');
  await assertDraft(page);

  await planSelect.selectOption(tripId);
  await waitText(page, '#plan-action', tripAction);
  const pin = page.locator('#plan-pin');
  assert.equal(await pin.getAttribute('aria-pressed'), 'false');
  await pin.click();
  assert.equal(await pin.getAttribute('aria-pressed'), 'true');
  await waitText(page, '#today-plan-action', tripAction);

  await planSelect.selectOption(projectId);
  await waitText(page, '#plan-action', projectAction);
  assert.equal(await pin.getAttribute('aria-pressed'), 'false');
  await waitText(page, '#today-plan-action', tripAction);
  assert.equal(await page.locator('#today-plan-link').getAttribute('href'), driveLink(tripId));
  await ctx.route(driveLink(tripId), route => route.fulfill({
    contentType: 'text/html', body: '<title>Test Drive plan</title>'
  }));
  const [drive] = await Promise.all([
    ctx.waitForEvent('page'),
    page.locator('#today-plan-link').click()
  ]);
  await drive.waitForURL(driveLink(tripId));
  assert.equal(await drive.title(), 'Test Drive plan');
  await drive.close();
  assert.equal(await planSelect.inputValue(), projectId);
  assert.equal(await pickerOpens(page), pickerCount);

  trip.text = '- [x] ' + tripAction + '\n- [ ] ' + remoteTripAction;
  trip.version++;
  await page.locator('#today-refresh').click();
  await waitText(page, '#today-plan-action', remoteTripAction);
  await waitText(page, '#plan-action', projectAction);
  assert.equal(await planSelect.inputValue(), projectId);

  await planSelect.selectOption(tripId);
  await waitText(page, '#plan-action', remoteTripAction);
  await pin.click();
  await page.locator('#today-plan').waitFor({state: 'hidden'});
  assert.equal(await pin.getAttribute('aria-pressed'), 'false');
  assert.equal(await pickerOpens(page), pickerCount);
  assert.equal((await saved(page)).pinnedPlanId, undefined);
  await assertDraft(page);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assertReadOnly(state);
});

test('a legacy personal plan restores without Picker and a new pin survives reconnection independently of the active plan', async t => {
  const {open, state} = await setup(t);
  planFixture(state, projectId, projectName, '- [ ] ' + projectAction);
  const trip = planFixture(state, tripId, tripName, tripText);
  const page = await open();
  await page.evaluate(value => {
    localStorage.setItem('my-day-device-v1', JSON.stringify(value));
  }, {version: 1, pickerKey: personalKey, fileIds: [], draft: null, plan: {id: projectId, name: projectName}});

  await page.reload();
  await page.locator('#connect').click();
  await waitText(page, '#plan-action', projectAction);
  await page.locator('#today-plan').waitFor({state: 'hidden'});
  assert.equal(await pickerOpens(page), 0);
  await pickPlan(page, tripId);
  await waitText(page, '#plan-action', tripAction);
  await page.locator('#plan-pin').click();
  await waitText(page, '#today-plan-action', tripAction);
  await page.locator('#plan-select').selectOption(projectId);
  await waitText(page, '#plan-action', projectAction);
  const personal = await saved(page);
  assert.deepEqual(personal.plans, [{id: projectId, name: projectName}, {id: tripId, name: tripName}]);
  assert.equal(personal.pinnedPlanId, tripId);
  assert(!JSON.stringify(personal).includes(tripAction));
  await page.close();

  trip.text = '- [ ] ' + remoteTripAction;
  trip.version++;
  const next = await open();
  assert(!(await next.locator('#today-plan').textContent()).includes(tripAction));
  await next.locator('#connect').click();
  await waitText(next, '#plan-action', projectAction);
  await waitText(next, '#today-plan-action', remoteTripAction);
  assert.equal(await next.locator('#plan-select').inputValue(), projectId);
  assert.equal(await pickerOpens(next), 0);

  trip.refusal = {status: 403, reason: 'appNotAuthorizedToFile'};
  await next.locator('#today-refresh').click();
  await waitText(next, '#today-plan-state', /доступ|403/i);
  await next.locator('#today-plan-action').waitFor({state: 'hidden'});
  await next.locator('#today-plan-link').waitFor({state: 'hidden'});
  assert.equal(await next.locator('#today-plan-link').getAttribute('href'), null);
  assert(!(await next.locator('#today-plan').textContent()).includes(remoteTripAction));
  await waitText(next, '#plan-action', projectAction);
  assert.equal(await next.locator('#plan-link').getAttribute('href'), driveLink(projectId));
  assert.equal(await next.locator('#plan-select').inputValue(), projectId);
  assertReadOnly(state);
});

test('plans and the pinned Today action are available in the shared tab but are cleared on reload', async t => {
  const {open, state} = await setup(t);
  planFixture(state, projectId, projectName, '- [ ] ' + projectAction);
  planFixture(state, tripId, tripName, tripText);
  const page = await open();
  assert.equal(await page.locator('#remember').isChecked(), false);
  await page.locator('#key').fill(personalKey);
  await page.locator('#connect').click();

  await pickPlan(page, tripId);
  await waitText(page, '#plan-action', tripAction);
  await page.locator('#plan-pin').click();
  await waitText(page, '#today-plan-action', tripAction);
  await pickPlan(page, projectId);
  await waitText(page, '#plan-action', projectAction);
  await waitText(page, '#today-plan-action', tripAction);
  assert.equal(await saved(page), null);
  const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
  for (const value of [tripId, tripAction, projectId, projectAction]) assert(!storage.includes(value));

  const reads = state.mediaReads.length;
  await page.reload();
  await page.locator('#today-plan').waitFor({state: 'hidden'});
  await page.locator('#plan-action').waitFor({state: 'hidden'});
  await page.locator('#plan-link').waitFor({state: 'hidden'});
  assert.equal(await saved(page), null);
  assert.equal(state.mediaReads.length, reads);
  assertReadOnly(state);
});
