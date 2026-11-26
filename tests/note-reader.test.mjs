import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, releaseLabel, saved} from './browser.mjs';

const live = process.env.MY_DAY_READER_SMOKE === 'live';
const published = 'https://ltstripes.github.io/My-day-/';
const books = await readFile(new URL('./fixtures/My-Day-Books.md', import.meta.url), 'utf8');
const trip = await readFile(new URL('./fixtures/My-Day-Trip.md', import.meta.url), 'utf8');
let browser;
before(async () => { browser = await chromium.launch(live ? {channel: 'chrome'} : {}); });
after(async () => { await browser?.close(); });

async function prepare(t, personal = true) {
  const {ctx, open, state} = await fixture(browser, t, {serviceWorkers: 'block', viewport: {width:360, height:800}});
  const files = [['books', 'My-Day-Books.md', books], ['trip', 'My-Day-Trip.md', trip], ['tasks', 'To Do now.md', '- Первое дело\n']];
  for (const [id, name, text] of files) state.files.set(id, {name, text, version:1, canEdit:id !== 'books'});
  let page;
  if (live) {
    await ctx.route(published + '**', route => route.continue());
    page = await ctx.newPage();
    assert.equal((await page.goto(published)).status(), 200);
    await page.getByText(releaseLabel, {exact: true}).waitFor();
  } else page = await open();
  page.setDefaultTimeout(6000);
  await firstFile(page, personal);
  const pick = async (id, selector = '#reader-pick') => {
    await page.evaluate(value => { pickTest.id = value; }, id);
    await page.locator(selector).click();
  };
  const panel = page.locator('#reader-content');
  return {state, page, pick, panel};
}

test('selected notes apply their views, full text and search keep every paragraph and both drafts', async t => {
  const {page, pick, panel, state} = await prepare(t);
  await page.locator('#thought').fill('Мысль для Inbox');
  await pick('tasks','[data-day-pick="To Do now.md"]');
  await page.locator('#task-entry summary').click();
  await page.locator('#task-text').fill('Отдельный черновик дела');
  const initial = await saved(page);
  await pick('books');
  await panel.getByText('Ночной трамвай', {exact:false}).first().waitFor();
  assert.equal(await page.locator('#reader-view').inputValue(), 'list');
  assert.equal(await page.locator('#reader-link').getAttribute('href'), 'https://drive.google.com/open?id=books');
  await pick('trip');
  await panel.getByText('Скачать карту озера', {exact:false}).first().waitFor();
  assert.equal(await page.locator('#reader-view').inputValue(), 'plan');
  await page.locator('#reader-full').click();
  await panel.filter({hasText:'Запасной маршрут проходит через старую пристань.'}).waitFor();
  await page.locator('#reader-view').selectOption('list');
  await panel.filter({hasText:'Собрать рюкзак'}).waitFor();
  await page.locator('#search-query').fill('старую пристань');
  await page.locator('#search-submit').click();
  await page.locator('[data-file-id="trip"] [data-hit]').first().click();
  assert.equal(await page.locator('#search-text mark').textContent(), 'старую пристань');
  const final = await saved(page);
  assert.deepEqual(final.draft, initial.draft);
  assert.deepEqual(final.taskDraft, initial.taskDraft);
  assert.equal(final.activeId, initial.activeId);
  assert.deepEqual(final.preferredIds, initial.preferredIds);
  assert(!JSON.stringify(final).includes('старую пристань'));
  assert.equal(state.patches, 0);
  assert.equal(state.files.get('trip').text, trip);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('personal sources restore by ID and refresh external edits, including a malformed view and revoked access', async t => {
  const {page, pick, panel, state} = await prepare(t);
  await pick('books');
  await panel.filter({hasText:'Ночной трамвай'}).waitFor();
  await pick('trip');
  await panel.filter({hasText:'Скачать карту озера'}).waitFor();
  await page.reload();
  await page.locator('#connect').click();
  await panel.filter({hasText:'Скачать карту озера'}).waitFor();
  assert.equal(await page.evaluate(() => pickTest.opens), 0);
  assert.equal(await page.locator('#reader-view').inputValue(), 'plan');
  const selector = page.locator('#reader-select');
  assert.equal(await selector.locator('option[value="books"]').textContent(), 'My-Day-Books.md');
  assert.equal(await selector.locator('option[value="trip"]').textContent(), 'My-Day-Trip.md');
  const file = state.files.get('books');
  file.text = '---\nmyday_view: unexpected\n---\nВнешнее изменение\n- Последняя строка\n';
  file.version++;
  await selector.selectOption('books');
  await panel.filter({hasText:'Внешнее изменение'}).waitFor();
  assert.equal(await page.locator('#reader-view').inputValue(), 'text');
  assert(!((await panel.textContent()).includes('Ночной трамвай')));
  file.refusal = {status:403,reason:'insufficientFilePermissions'};
  await page.locator('#reader-refresh').click();
  await page.waitForFunction(() => !document.querySelector('#reader-content').textContent.includes('Внешнее изменение'));
  await selector.selectOption('trip');
  await panel.filter({hasText:'Скачать карту озера'}).waitFor();
  await selector.selectOption('books');
  await page.locator('#reader-state').filter({hasText:'Не удалось открыть «My-Day-Books.md»'}).waitFor();
  assert.equal(await selector.inputValue(), 'trip');
  assert((await page.locator('#reader-state').textContent()).includes('My-Day-Trip.md'));
  assert.equal(state.patches, 0);
});

test('shared mode drops general note selection on reload and source removal clears the open reader', async t => {
  const {page, pick, panel, state} = await prepare(t, false);
  await pick('books');
  await panel.filter({hasText:'Ночной трамвай'}).waitFor();
  await page.locator('#source-manager').evaluate(el => {el.open=true;});
  await page.locator('#source-select').selectOption('books');
  await page.locator('#source-remove').click();
  await page.waitForFunction(() => !document.querySelector('#reader-content').textContent.includes('Ночной трамвай'));
  await pick('trip');
  await panel.filter({hasText:'Скачать карту озера'}).waitFor();
  assert.equal(await saved(page), null);
  await page.reload();
  assert.equal(await page.locator('#reader-select option[value="trip"]').count(), 0);
  assert(!((await panel.textContent()).includes('Скачать карту озера')));
  assert.equal(await saved(page), null);
  assert.equal(state.patches, 0);
});
