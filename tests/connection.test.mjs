import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, original, saved, site} from './browser.mjs';
import {recordBlock} from '../web/core.js';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

test('personal device restores a not-yet-sent draft and reads the external change after one click', async t => {
  const {open, state} = await fixture(browser, t);
  let page = await open();
  await firstFile(page, true);
  await page.locator('#thought').fill('Черновик до нажатия кнопки');
  const stored = await saved(page);
  assert.equal(stored.draft.op, null);
  assert.deepEqual(stored.fileIds, ['fixture-a']);
  assert.deepEqual(Object.keys(stored).sort(), ['activeId', 'draft', 'fileIds', 'pickerKey', 'project', 'version']);
  assert(!JSON.stringify(stored).includes('synthetic-browser-token'));
  assert(!JSON.stringify(stored).includes('Исходная строка'));
  await page.close();
  const remote = state.files.get('fixture-a');
  remote.text += 'Внешняя правка помощника\n';
  remote.version++;
  const reads = state.calls.length;
  state.pickerDown = true;
  page = await open();
  assert.deepEqual(await page.evaluate(() => gis.prompts), []);
  assert.equal(state.calls.length, reads);
  assert.equal(await page.locator('#thought').inputValue(), stored.draft.text);
  assert.equal(await page.locator('#key').inputValue(), stored.pickerKey);
  assert(!(await page.locator('#preview').textContent()).includes('Исходная строка'));
  await page.getByRole('button', {name: 'Подключиться снова'}).click();
  await notice(page, 'актуальное содержимое');
  assert.deepEqual(await page.evaluate(() => gis.prompts), ['']);
  assert.equal(await page.locator('#preview').textContent(), remote.text);
  assert.equal(state.patches, 0);
});

test('offline and lost PATCH response keep the same operation across reload and prevent duplicate writes', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  await page.locator('#thought').fill('Ровно одна мысль');
  state.offline = true;
  await page.locator('#save').click();
  await notice(page, 'Проверь интернет');
  const pending = (await saved(page)).draft;
  assert(pending.op);
  assert.equal(state.patches, 0);
  state.offline = false;
  state.loseReply = true;
  await page.locator('#save').click();
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  assert.equal(state.patches, 1);
  assert.deepEqual((await saved(page)).draft, pending);
  const remote = state.files.get('fixture-a');
  assert(remote.text.startsWith(original));
  remote.text += 'Изменение после доставки\r\n';
  remote.version++;
  await page.reload();
  await page.locator('#connect').click();
  await notice(page, 'актуальное содержимое');
  assert.equal(state.patches, 1);
  await page.locator('#save').click();
  await notice(page, 'без дубля');
  assert.equal(remote.text.split(recordBlock(pending)).length - 1, 1);
  assert(remote.text.endsWith('Изменение после доставки\r\n'));
  assert.equal(state.patches, 1);
  assert.equal((await saved(page)).draft, null);
  assert.equal(await page.locator('#thought').inputValue(), '');
});

test('shared device writes only to Drive, warns before losing a draft and opens clean', async t => {
  const {open, state} = await fixture(browser, t);
  let page = await open();
  assert.equal(await page.locator('#remember').isChecked(), false);
  await firstFile(page);
  await page.locator('#thought').fill('Проба общего режима');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#disconnect').click();
  assert.equal(await page.locator('#thought').inputValue(), 'Проба общего режима');
  state.offline = true;
  await page.locator('#save').click();
  await notice(page, 'Проверь интернет');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  state.offline = false;
  await page.locator('#save').click();
  await notice(page, 'подтверждено');
  assert.equal(state.patches, 1);
  await page.locator('#disconnect').click();
  assert.equal(await page.locator('#key').inputValue(), '');
  assert(!(await page.locator('#preview').textContent()).includes('общего режима'));
  await page.close();
  page = await open();
  assert.equal(await page.locator('#thought').inputValue(), '');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, gis.prompts.length]), [0, 0, 0]);
});

test('expiry, closed popup, refused scope and 401 recover on demand without auto-sending', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await page.clock.install();
  await firstFile(page, true);
  await page.locator('#thought').fill('Пережить истечение');
  await page.clock.fastForward(3600000);
  await notice(page, 'Срок доступа');
  assert.equal(await page.locator('#save').isDisabled(), true);
  assert.equal(await page.evaluate(() => gis.prompts.length), 1);
  await page.evaluate(() => { gis.cancel = true; });
  await page.locator('#connect').click();
  await notice(page, 'Окно входа');
  await page.evaluate(() => { gis.cancel = false; gis.grant = false; });
  await page.locator('#connect').click();
  await notice(page, 'не выдал доступ');
  await page.evaluate(() => { gis.grant = true; });
  await page.locator('#connect').click();
  await notice(page, 'актуальное содержимое');
  assert.equal(await page.evaluate(() => gis.prompts.at(-1)), 'consent');
  state.refusal = {status: 401, reason: 'authError'};
  await page.locator('#refresh').click();
  await notice(page, 'HTTP 401');
  assert.equal(await page.locator('#connect').isEnabled(), true);
  assert(!(await page.locator('#preview').textContent()).includes('Исходная строка'));
  state.refusal = null;
  await page.locator('#connect').click();
  await notice(page, 'актуальное содержимое');
  assert.equal(await page.locator('#thought').inputValue(), 'Пережить истечение');
  assert.equal(state.patches, 0);
});

test('file access recovery retains the draft and will not redirect it to another Markdown file', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  await page.locator('#thought').fill('Только в исходный файл');
  for (const status of [403, 404]) {
    state.refusal = {status, reason: status === 403 ? 'appNotAuthorizedToFile' : 'notFound'};
    await page.locator('#refresh').click();
    await notice(page, 'HTTP ' + status);
    assert.match(await page.locator('#status').textContent(), /Выбрать файл/);
    assert.equal(await page.locator('#save').isDisabled(), true);
  }
  state.refusal = null;
  await page.evaluate(() => { pickTest.id = 'fixture-b'; });
  await page.locator('#pick').click();
  await notice(page, 'Черновик привязан');
  assert.equal((await saved(page)).activeId, 'fixture-a');
  await page.evaluate(() => { pickTest.id = 'fixture-a'; });
  await page.locator('#pick').click();
  await notice(page, 'прочитан из Drive');
  await page.locator('#save').click();
  await notice(page, 'подтверждено');
  assert.equal(state.files.get('fixture-b').text, original);
});

test('remembers two validated test files, forget clears both tabs and preserves unrelated origin storage', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  await page.evaluate(() => { pickTest.id = 'fixture-b'; localStorage.setItem('unrelated', 'keep'); });
  await page.locator('#pick').click();
  await page.locator('#file').filter({hasText: 'fixture-b'}).waitFor();
  await page.locator('#known').selectOption('fixture-a');
  await notice(page, 'актуальное содержимое');
  assert.deepEqual((await saved(page)).fileIds, ['fixture-a', 'fixture-b']);
  const second = await open();
  assert.equal(await second.locator('#known').inputValue(), 'fixture-a');
  await page.locator('#thought').fill('Черновик перед удалением');
  await second.waitForFunction(() => document.getElementById('thought').value === 'Черновик перед удалением');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#forget').click();
  assert((await saved(page)).draft);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#forget').click();
  await notice(second, 'удалены в другой вкладке');
  for (const tab of [page, second]) {
    assert.equal(await tab.locator('#remember').isChecked(), false);
    assert.equal(await tab.locator('#thought').inputValue(), '');
    assert.deepEqual(await tab.evaluate(() => Object.keys(localStorage)), ['unrelated']);
  }
  assert.equal(state.patches, 0);
});

test('legacy draft explicitly moves to the tab with its original marker, even if already delivered', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  const d = {op: 'decafbad-aaaa-4bbb-8ccc-123456789abc', fileId: 'fixture-a', text: 'Старая операция'};
  state.files.get(d.fileId).text += recordBlock(d);
  await page.evaluate(draft => localStorage.setItem('my-day-test-draft-v1', JSON.stringify(draft)), d);
  await page.reload();
  assert.equal(await page.locator('#thought').inputValue(), '');
  await page.locator('#recover').click();
  assert.equal(await page.locator('#thought').inputValue(), d.text);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await page.locator('#connect').click();
  await notice(page, 'актуальное содержимое');
  await page.locator('#save').click();
  await notice(page, 'без дубля');
  assert.equal(state.patches, 0);
});

test('storage failure is visible, blocks an unprotected personal send, shared mode remains usable', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); }; });
  await page.locator('#thought').fill('Квота');
  await page.locator('#save').click();
  await page.locator('#storage-warning').filter({hasText: 'не сохранил'}).waitFor();
  assert.equal(state.patches, 0);
  assert.equal(await page.locator('#thought').isEditable(), true);
  await page.locator('#remember').uncheck();
  assert.equal(await saved(page), null);
  await page.locator('#save').click();
  await notice(page, 'подтверждено');
});

test('the prototype uses only its example data and the site fits a narrow viewport', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await page.setViewportSize({width: 360, height: 800});
  await firstFile(page);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const count = state.calls.length;
  await page.goto(site + 'prototype/');
  await page.locator('[data-mode=android]').click();
  await page.locator('#android-capture').click();
  await page.locator('#thought').fill('Проба макета');
  await page.getByRole('button', {name: 'Добавить в макет'}).click();
  await page.locator('[data-notes]').filter({hasText: 'Проба макета'}).waitFor();
  await page.locator('#model-update').click();
  await page.locator('[data-mode=windows]').click();
  await page.locator('[data-tasks=windows]').filter({hasText: 'Выбрать время'}).waitFor();
  assert.equal(state.calls.length, count);
});

test('changed Drive version suspends the write, retry keeps the new external content', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  await page.locator('#thought').fill('Дополнение');
  let reads = 0;
  state.onMetadata = file => {
    if (++reads === 3) { file.version++; file.text += 'Новая внешняя строка\r\n'; }
  };
  await page.locator('#save').click();
  await notice(page, 'изменился перед записью');
  assert.equal(state.patches, 0);
  const draft = (await saved(page)).draft;
  await page.locator('#save').click();
  await notice(page, 'подтверждено');
  assert.equal(state.files.get('fixture-a').text, original + 'Новая внешняя строка\r\n\n' + recordBlock(draft));
});

test('changed text under an existing operation marker is not silently appended or acknowledged', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  await page.locator('#thought').fill('Исходная мысль');
  state.loseReply = true;
  await page.locator('#save').click();
  await notice(page, 'Проверь интернет');
  const pending = (await saved(page)).draft;
  const file = state.files.get('fixture-a');
  file.text = file.text.replace(pending.text, 'Уже отредактировано');
  file.version++;
  await page.locator('#save').click();
  await notice(page, 'текст отличается');
  assert.deepEqual((await saved(page)).draft, pending);
  assert.equal(state.patches, 1);
});

test('only a Picker key is remembered and only a validated test Markdown can become a write target', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await page.locator('#remember').check();
  await page.locator('#key').fill('other-secret-placeholder');
  assert(!JSON.stringify(await saved(page)).includes('other-secret'));
  await firstFile(page, true);
  const b = state.files.get('fixture-b');
  b.name = 'Другой-файл.md';
  await page.evaluate(() => { pickTest.id = 'fixture-b'; });
  await page.locator('#pick').click();
  await notice(page, 'из тестового шаблона');
  assert(!state.mediaReads.includes('fixture-b'));
  b.name = 'My-Day-test.md';
  b.text = '# Другой заголовок\n';
  await page.locator('#pick').click();
  await notice(page, 'первой проверки');
  assert.deepEqual((await saved(page)).fileIds, ['fixture-a']);
  assert.equal(state.patches, 0);
});
