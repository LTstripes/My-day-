import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, releaseLabel, saved} from './browser.mjs';

const live = process.env.MY_DAY_TASK_DRAFT_SHORTCUT_SMOKE === 'live';
const published = 'https://ltstripes.github.io/My-day-/';
const fileId = 'selected-day-list';
const thoughtText = 'Оставить мысль в отдельной заметке';
const taskText = 'Сверить адрес встречи';
let browser;
before(async () => { browser = await chromium.launch(live ? {channel: 'chrome'} : {}); });
after(async () => { await browser?.close(); });

async function setup(t) {
  const {ctx, open, state} = await fixture(browser, t, {serviceWorkers: 'block', viewport: {width: 360, height: 800}});
  state.files.set(fileId, {name: 'To Do now.md', version: 1, text: '- [ ] Посмотреть расписание\n'});
  let page;
  if (live) {
    await ctx.route(published + '**', route => route.continue());
    page = await ctx.newPage();
    assert.equal((await page.goto(published)).status(), 200);
    await page.getByText(releaseLabel, {exact: true}).waitFor({timeout: 7000});
  } else page = await open();
  page.setDefaultTimeout(7000);
  await firstFile(page, true);
  await page.locator('#thought').fill(thoughtText);
  await page.evaluate(id => { pickTest.id = id; }, fileId);
  await page.locator('[data-day-pick="To Do now.md"]').click();
  await page.locator('#today-tasks li').filter({hasText: 'Посмотреть расписание'}).waitFor();
  await page.locator('#today-refresh:enabled').waitFor();
  return {page, state};
}

async function assertFocused(locator) {
  assert(await locator.evaluate(element => document.activeElement === element));
}

async function assertDrafts(page, expected) {
  const profile = await saved(page);
  assert.deepEqual(profile.draft, expected.draft);
  assert.deepEqual(profile.taskDraft, expected.taskDraft);
  assert.equal(await page.locator('#thought').inputValue(), thoughtText);
  assert.equal(await page.locator('#task-text').inputValue(), taskText);
}

test('Today and search reopen the task draft without changing either draft or calling Drive', async t => {
  const {page, state} = await setup(t);
  const today = page.locator('#today-task-draft'), fromSearch = page.locator('#search-task-draft');
  const summary = page.locator('#task-entry summary'), field = page.locator('#task-text');
  assert(await today.isHidden());
  await page.locator('#search-file').selectOption('fixture-a');
  await page.locator('#search-query').fill('Исходная строка');
  await page.locator('#search-submit').click();
  await page.locator('#search-results [data-file-id="fixture-a"] [data-hit]').click();
  await page.locator('#search-detail').waitFor();
  assert(await page.locator('#search-draft').isVisible());
  assert(await fromSearch.isHidden());

  await summary.click();
  await field.fill(taskText);
  const profile = await saved(page);
  assert.equal(profile.draft.fileId, 'fixture-a');
  assert.equal(profile.taskDraft.fileId, fileId);
  const calls = state.calls.length;
  for (const shortcut of [today, fromSearch]) {
    await summary.click();
    assert.equal(await summary.textContent(), 'Черновик дела');
    assert(await field.isHidden());
    assert(await shortcut.isVisible());
    assert.equal(await shortcut.textContent(), 'К черновику дела');
    await shortcut.press('Enter');
    assert(await field.isVisible());
    await assertFocused(field);
    await assertDrafts(page, profile);
  }
  assert(await page.locator('#search-detail').isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await field.fill('');
  assert(await today.isHidden());
  assert(await fromSearch.isHidden());
  assert.deepEqual((await saved(page)).draft, profile.draft);
  assert.equal(state.calls.length, calls);
  assert.equal(state.patches, 0);
});

test('a pending task shortcut focuses safe retry or the summary when Drive is disconnected', async t => {
  const {page, state} = await setup(t);
  const profile = await saved(page);
  // Restore the state of an attempt without issuing an upload in this test.
  profile.taskDraft = {fileId, text: taskText, op: 'a0123456-78ab-4cde-8fab-123456789abc',
    version: '1', date: '2026-11-27', place: 'end'};
  await page.evaluate(value => localStorage.setItem('my-day-device-v1', JSON.stringify(value)), profile);
  await page.reload();
  await page.locator('#connect').click();
  const retry = page.locator('#task-add'), field = page.locator('#task-text');
  const today = page.locator('#today-task-draft'), summary = page.locator('#task-entry summary');
  await page.locator('#task-add:enabled').waitFor();
  assert.equal(await retry.textContent(), 'Проверить и повторить');
  assert(await field.evaluate(element => element.readOnly));

  const calls = state.calls.length;
  await summary.click();
  assert(await field.isHidden());
  await today.click();
  await assertFocused(retry);
  await assertDrafts(page, profile);

  await page.locator('#disconnect').click();
  await notice(page, 'Отключено');
  assert(await retry.isDisabled());
  await summary.click();
  assert(await field.isHidden());
  await today.click();
  assert(await field.isVisible());
  await assertFocused(summary);
  await assertDrafts(page, profile);
  assert.equal(state.calls.length, calls);
  assert.equal(state.patches, 0);
});
