import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, saved} from './browser.mjs';

const live = process.env.MY_DAY_ADD_TASK_SMOKE === 'live';
const published = 'https://ltstripes.github.io/My-day-/';
const fileId = 'selected-day-list';
const inboxText = 'Оставить мысль в Inbox';
const taskText = 'Забрать тестовый заказ';
let browser;
before(async () => { browser = await chromium.launch(live ? {channel: 'chrome'} : {}); });
after(async () => { await browser?.close(); });

async function setup(t, text, personal = true) {
  const {ctx, open, state} = await fixture(browser, t, {serviceWorkers: 'block', viewport: {width: 360, height: 800}});
  const file = {name: 'To Do now.md', version: 1, text};
  state.files.set(fileId, file);
  let page;
  if (live) {
    await ctx.route(published + '**', route => route.continue());
    page = await ctx.newPage();
    assert.equal((await page.goto(published)).status(), 200);
    await page.getByText('My Day · 0.14.0', {exact: true}).waitFor();
  } else page = await open();
  page.setDefaultTimeout(7000);
  await firstFile(page, personal);
  await page.locator('#thought').fill(inboxText);
  await page.evaluate(id => { pickTest.id = id; }, fileId);
  await page.locator('[data-day-pick="To Do now.md"]').click();
  const field = page.locator('#task-text');
  await field.fill(taskText);
  return {ctx, state, file, page, field, add: page.locator('#task-add'),
    row: page.locator('#today-tasks li').filter({hasText: taskText})};
}

test('two immediate submits create one completable task and preserve unrelated Inbox data', async t => {
  const source = '\uFEFF- Мой список\r\n- [x] Уже готово\r\n';
  const {page, state, file, add, row, field} = await setup(t, source);
  const draft = (await saved(page)).draft;
  await add.evaluate(button => { button.click(); button.click(); });
  await row.waitFor();
  await page.waitForFunction(() => document.querySelector('#task-text').value === '');
  assert.equal(state.patches, 1);
  assert(file.text.startsWith(source));
  assert.equal(file.text.split(taskText).length, 2);
  assert.equal((await saved(page)).taskDraft ?? null, null);
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(await page.locator('#thought').inputValue(), inboxText);
  assert(!((await row.textContent()).includes('my-day:')));
  await row.locator('[data-complete]').click();
  await row.waitFor({state:'detached'});
  assert(file.text.includes('- [x] ' + taskText));
  assert.equal(state.patches, 2);
  assert.equal(await field.inputValue(), '');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('lost acknowledgement keeps the operation in the personal profile, retry can confirm after an external edit', async t => {
  const {page, state, file, add, field, row} = await setup(t, '- Строка\n');
  state.loseReply = true;
  await add.click();
  await page.waitForFunction(() => !document.querySelector('#task-add').disabled);
  assert.equal(state.patches, 1);
  const pending = (await saved(page)).taskDraft;
  assert(pending.op);
  assert.equal(pending.fileId, fileId);
  assert.equal(await field.inputValue(), taskText);
  file.text += '\nВнешнее уточнение после записи.\n';
  file.version++;
  await add.click();
  await row.waitFor();
  await page.waitForFunction(() => !document.querySelector('#task-text').value);
  assert.equal(state.patches, 1);
  assert.equal(file.text.split(taskText).length, 2);
  assert(file.text.endsWith('Внешнее уточнение после записи.\n'));
  assert.equal((await saved(page)).draft.text, inboxText);
});

test('ambiguous Today headings require a choice and preserve the neighbouring section', async t => {
  const first = '## Сегодня\n- Первый\n';
  const second = '## Сегодня\n- Второй\n';
  const later = '## Завтра\n- Другой день\n';
  const {page, add, state, file, row} = await setup(t, first + second + later, false);
  const place = page.locator('#task-place');
  await place.waitFor();
  assert.equal(await place.inputValue(), '');
  assert.equal(state.patches, 0);
  const sections = place.locator('option[value]:not([value=""])');
  assert(await sections.count() >= 2);
  await place.selectOption(await sections.nth(1).getAttribute('value'));
  await add.click();
  await row.waitFor();
  assert(file.text.startsWith(first + second));
  assert(file.text.endsWith(later));
  assert.equal(state.patches, 1);
  assert.equal(await saved(page), null);
});

test('a competing Drive edit wins the first submit and the draft stays available for an explicit retry', async t => {
  const {page, add, state, file, field, row} = await setup(t, '- До правки\n');
  state.beforeTaskWrite = current => {
    current.text += '- Добавлено в Obsidian\n';
    current.version++;
    delete state.beforeTaskWrite;
  };
  await add.click();
  await page.locator('#today-tasks li').filter({hasText: 'Добавлено в Obsidian'}).waitFor();
  assert.equal(await field.inputValue(), taskText);
  assert.equal(state.patches, 0);
  await add.click();
  await row.waitFor();
  assert.equal(state.patches, 1);
  assert(file.text.startsWith('- До правки\n- Добавлено в Obsidian\n'));
  assert.equal(file.text.split(taskText).length, 2);
});

test('reload and reconnect confirm a pending delivery with its original id and keep the Inbox draft', async t => {
  const {page, add, state, file} = await setup(t, '- Список\n');
  state.loseReply = true;
  await add.click();
  await page.locator('#task-status').filter({hasText: 'неясен'}).waitFor();
  const pending = (await saved(page)).taskDraft;
  file.canEdit = false;
  await page.reload();
  assert.deepEqual((await saved(page)).taskDraft, pending);
  await page.locator('#connect').click();
  await page.locator('#task-add:enabled').click();
  await page.locator('#status').filter({hasText: 'без дубля'}).waitFor();
  assert.equal(state.patches, 1);
  assert.equal(file.text.split(taskText).length, 2);
  assert.equal((await saved(page)).draft.text, inboxText);
});

test('a task draft stays bound to its original file even when a namesake is picked', async t => {
  const {page, state, add, file, field, row} = await setup(t, '- Первый список\n');
  const other = {name: 'To Do now.md', text: '- Второй список\n', version: 1};
  state.files.set('another-list', other);
  await page.evaluate(() => { pickTest.id = 'another-list'; });
  await page.locator('[data-day-pick="To Do now.md"]').click();
  await page.locator('#status').filter({hasText: 'привязан к прежнему списку'}).waitFor();
  await page.locator('#source-manager').evaluate(details => { details.open = true; });
  await page.locator('#source-select').selectOption(fileId);
  assert.equal(await page.locator('#source-remove').isDisabled(), true);
  assert.equal(await field.inputValue(), taskText);
  await add.click();
  await row.waitFor();
  assert.equal(state.patches, 1);
  assert.equal(other.text, '- Второй список\n');
  assert(file.text.includes(taskText));
});
