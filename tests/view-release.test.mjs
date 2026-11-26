import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, releaseLabel, saved} from './browser.mjs';

const live = process.env.MY_DAY_VIEW_SAVE_SMOKE === 'live';
const site = 'https://ltstripes.github.io/My-day-/';
const source = await readFile(new URL('./fixtures/My-Day-Reading-Log.md', import.meta.url), 'utf8');
const id = 'selected-reading-log';
let browser;
before(async () => { browser = await chromium.launch(live ? {channel:'chrome'} : {}); });
after(async () => { await browser?.close(); });

async function profile(t, file) {
  const {ctx, state, open} = await fixture(browser, t, {serviceWorkers:'block', viewport:{width:360,height:800}});
  state.files.set(id, file);
  let page;
  if (live) {
    await ctx.route(site+'**', route => route.continue());
    page = await ctx.newPage();
    assert.equal((await page.goto(site)).status(), 200);
    await page.getByText(releaseLabel, {exact:true}).waitFor();
  } else page = await open();
  page.setDefaultTimeout(7000);
  await firstFile(page, true);
  await page.locator('#thought').fill('Мысль в другом файле');
  await page.evaluate(fileId => { pickTest.id = fileId; }, id);
  await page.locator('#reader-pick').click();
  await page.locator('#reader-link').waitFor();
  return {page,state};
}

async function chart(page) {
  await page.locator('#reader-view').selectOption('chart');
  await page.locator('#chart-table').selectOption('0');
  await page.locator('#chart-x').selectOption({label:'Дата'});
  await page.locator('#chart-y').selectOption({label:'Страницы'});
  await page.locator('#chart-unit').fill('стр.');
  await page.locator('#chart-plot').waitFor();
}

test('explicit chart save travels to a fresh profile, keeps the original Markdown and both date and Inbox addresses', async t => {
  const file = {name:'My-Day-Reading-Log.md',text:source,version:1};
  const {page,state} = await profile(t, file);
  const draft = (await saved(page)).draft;
  assert.equal(await page.locator('#reader-view').inputValue(), 'text');
  await chart(page);
  assert.equal(state.patches, 0);
  assert.equal(await page.locator('#chart-source').textContent(), source.slice(source.indexOf('| Дата')).trimEnd());
  await page.locator('#reader-save').click();
  await page.locator('#reader-save-status').filter({hasText:'подтверждён'}).waitFor();
  assert.equal(state.patches, 1);
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(file.text.split('myday_view: chart').length, 2);
  assert(file.text.includes('myday_attention: 2026-11-26'));
  assert.equal(file.text.slice(file.text.indexOf('# Дневник')), source.slice(source.indexOf('# Дневник')));
  const second = await profile(t, file);
  await second.page.locator('#chart-plot').waitFor();
  assert.equal(await second.page.locator('#reader-view').inputValue(), 'chart');
  assert.equal(await second.page.locator('#chart-unit').inputValue(), 'стр.');
  assert.equal(await second.page.locator('#chart-y').inputValue(), 'Страницы');
  await second.page.locator('#reader-full').click();
  assert((await second.page.locator('#reader-content').textContent()).includes('Сверить записи'));
  assert.equal(second.state.patches, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('a competing write wins, and retry after a lost reply verifies without a duplicate write', async t => {
  const file = {name:'My-Day-Reading-Log.md',text:source,version:1};
  const {page,state} = await profile(t,file);
  await chart(page);
  state.beforeTaskWrite = current => {
    current.text += '\nВнешний абзац.\n';
    current.version++;
    delete state.beforeTaskWrite;
  };
  await page.locator('#reader-save').click();
  await page.locator('#reader-save-status.error').waitFor();
  assert.equal(state.patches, 0);
  assert(file.text.includes('myday_view: text'));
  assert.equal(await page.locator('#reader-view').inputValue(), 'text');
  await chart(page);
  state.loseReply = true;
  await page.locator('#reader-save').click();
  await page.locator('#reader-save-status').filter({hasText:'Проверь файл'}).waitFor();
  assert.equal(state.patches, 1);
  await page.locator('#reader-save').click();
  await page.locator('#reader-save-status').filter({hasText:'уже сохранён'}).waitFor();
  assert.equal(state.patches, 1);
  assert(file.text.endsWith('Внешний абзац.\n'));
});

test('a read-only file supports temporary chart settings and the protected template stays read-only for view changes', async t => {
  const file={name:'My-Day-Reading-Log.md',text:source,version:1,canEdit:false};
  const {page,state}=await profile(t,file);
  await chart(page);
  assert.equal(await page.locator('#reader-save').isDisabled(), true);
  await page.locator('#reader-select').selectOption('fixture-a');
  await page.locator('#reader-content').filter({hasText:'Исходная строка'}).waitFor();
  assert.equal(await page.locator('#reader-save').isDisabled(), true);
  assert.equal(state.patches, 0);
});
