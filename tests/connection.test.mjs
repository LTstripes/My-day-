import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, original, saved, site} from './browser.mjs';
import {appendRecord, recordBlock} from '../web/core.js';
import {saveDraft} from '../web/drive.js';

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
  assert.deepEqual(Object.keys(stored).sort(), ['activeId', 'connectionEpoch', 'draft', 'fileIds', 'noteNames', 'pickerKey', 'preferredIds', 'project', 'version']);
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
  await page.locator('#thought').fill('Ровно одна мысль\nсо второй строкой');
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
  remote.text = remote.text.replace(/\r?\n/g, '\r\n') + 'Изменение после доставки\r\n';
  remote.version++;
  await page.reload();
  await page.locator('#connect').click();
  await notice(page, 'без дубля');
  assert.equal(remote.text.split(recordBlock(pending).replaceAll('\n', '\r\n')).length - 1, 1);
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
  await notice(page, 'без дубля');
  assert.equal(await page.locator('#thought').inputValue(), '');
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

test('operation markers in Markdown examples and malformed copies require manual review', () => {
  const draft = {op: 'decafbad-aaaa-4bbb-8ccc-123456789abc', text: 'Первая строка\nВторая строка'};
  const block = recordBlock(draft);
  for (const content of [
    '~~~md\n' + block + '~~~\n', '<!-- пример\n' + block + '-->\n',
    '---\nпример: |\n' + block + '---\n', 'цитата ' + block,
    block + '<!-- my-day: ' + draft.op.toUpperCase() + ' -->\n',
    block.replace('Вторая строка', 'Вторая строка с правками')
  ]) {
    assert.throws(() => appendRecord(content, draft), /Черновик сохранён/);
  }
});

test('readback rejects a changed original prefix even when the delivered operation matches', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  await page.locator('#thought').fill('Проверка исходного текста');
  state.onMetadata = file => {
    if (!state.patches) return;
    file.text = file.text.replace('Исходная строка.', 'Внешняя замена.').replaceAll('\r\n', '\n');
    file.version++;
    state.onMetadata = null;
  };
  await page.locator('#save').click();
  await notice(page, 'Не удалось подтвердить исходный текст');
  assert.equal((await saved(page)).draft.text, 'Проверка исходного текста');
  assert.equal(state.patches, 1);
});

test('readback and retry recognize only one confirmed operation after an editor changes line endings', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  const file = state.files.get('fixture-a');
  await page.locator('#thought').fill('Мысль\nс продолжением');
  // The simulated editor runs after PATCH and before the readback snapshot.
  state.onMetadata = () => {
    if (!state.patches) return;
    file.text = file.text.replaceAll('\r\n', '\n');
    file.version++;
    state.onMetadata = null;
  };
  await page.locator('#save').click();
  await notice(page, 'подтверждено');
  assert.equal((await saved(page)).draft, null);

  await page.locator('#thought').fill('Вторая мысль\nна двух строках');
  state.loseReply = true;
  await page.locator('#save').click();
  await notice(page, 'Проверь интернет');
  const pending = (await saved(page)).draft;
  const once = file.text.replace(/\r?\n/g, '\r\n');
  file.text = once + '\r\n' + recordBlock(pending);
  file.version++;
  await page.locator('#refresh').click();
  await notice(page, 'Метка неоднозначна');
  await page.locator('#save').click();
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  assert.deepEqual((await saved(page)).draft, pending);
  assert.equal(state.patches, 2);
  file.text = once;
  file.version++;
  await page.locator('#save').click();
  await notice(page, 'без дубля');
  assert.equal((await saved(page)).draft, null);
  assert.equal(file.text, once);
  assert.equal(state.patches, 2);
});

test('rejects secrets, unknown filenames and a test file without the template heading', async t => {
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

test('a returning 0.2 personal profile recovers its 0.1 draft and original file with one connect click', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  const old = {fileId: 'fixture-b', op: 'decafbad-aaaa-4bbb-8ccc-0123456789ab', text: 'Недоставленный черновик'};
  await page.evaluate(draft => {
    localStorage.setItem('my-day-device-v1', JSON.stringify({version: 1, fileIds: [], draft: null}));
    localStorage.setItem('my-day-test-draft-v1', JSON.stringify(draft));
  }, old);
  await page.reload();
  assert.equal(await page.locator('#remember').isChecked(), true);
  assert.equal(await page.locator('#thought').inputValue(), old.text);
  assert.equal(await page.locator('#recover').isHidden(), true);
  await page.getByRole('button', {name: 'Подключиться снова'}).click();
  await notice(page, 'Для отправки');
  assert.equal(state.patches, 0);
  assert.equal(await page.evaluate(() => pickTest.opens), 0);
  assert.deepEqual((await saved(page)).draft, old);
  await page.locator('#save').click();
  await notice(page, 'подтверждено');
  assert.equal(state.patches, 1);
  assert.equal(state.files.get(old.fileId).text, original + '\n' + recordBlock(old));
});

test('legacy migration waits for consent, preserves a newer draft, and keeps its source on storage failure', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  const old = {fileId: 'fixture-b', op: 'decafbad-aaaa-4bbb-8ccc-0123456789ab', text: 'Из прежней версии'};
  await page.evaluate(draft => localStorage.setItem('my-day-test-draft-v1', JSON.stringify(draft)), old);
  await page.reload();
  await firstFile(page);
  await page.locator('#thought').fill('Новый текст');
  await page.locator('#remember').check();
  assert.equal((await saved(page)).draft.text, 'Новый текст');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('my-day-test-draft-v1')).text), old.text);
  await page.evaluate(() => localStorage.removeItem('my-day-device-v1'));
  await page.reload();
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'my-day-device-v1' && JSON.parse(value).draft) throw new Error('quota');
      return set.call(this, key, value);
    };
  });
  await page.locator('#remember').check();
  await page.locator('#storage-warning').filter({hasText: 'не сохранил'}).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('my-day-test-draft-v1')).op), old.op);
  assert.equal(await page.locator('#thought').inputValue(), old.text);
  assert.equal(state.patches, 0);
});

test('selected Inbox appends to its own ID; Now and To Do open read-only and restore by ID after login', async t => {
  const {open, state} = await fixture(browser, t);
  const source = '\uFEFF# Входящие\r\n\r\nСохранить исходную строку.\r\n';
  state.files.set('inbox', {name: 'Мысли.md', text: source, version: 1});
  state.files.set('context', {name: 'Now.md', text: '# Контекст\nТестовый приоритет\n', version: 1, canEdit: false});
  state.files.set('tasks', {name: 'To Do now.md', text: '- [ ] Тестовая задача\n', version: 1});
  const page = await open();
  await firstFile(page, true);
  for (const id of ['inbox', 'context', 'tasks']) {
    await page.evaluate(id => { pickTest.id = id; }, id);
    await page.locator('#pick').click();
    await notice(page, state.files.get(id).name + ' — файл прочитан');
    assert.equal(await page.locator('#preview').textContent(), state.files.get(id).text);
    if (id === 'inbox') {
      assert.match(await page.locator('#target').textContent(), /Мысли\.md/);
      await page.locator('#thought').fill('Новая входящая мысль');
      await page.locator('#save').click();
      await notice(page, 'подтверждено');
      assert(state.files.get('inbox').text.startsWith(source));
      assert.equal(state.files.get('inbox').text.split('Новая входящая мысль').length - 1, 1);
    } else {
      assert.equal(await page.locator('#capture').isHidden(), true);
      assert.equal(await page.locator('#save').isDisabled(), true);
      assert.match(await page.locator('#preview-title').textContent(), /только чтение/);
    }
  }
  assert.equal(state.files.get('fixture-a').text, original);
  assert(!JSON.stringify(await saved(page)).includes('Тестовая задача'));
  const tasks = state.files.get('tasks');
  tasks.text += 'Внешнее дополнение\n';
  tasks.version++;
  await page.reload();
  await page.locator('#connect').click();
  await notice(page, 'актуальное содержимое To Do now.md');
  assert.equal(await page.locator('#preview').textContent(), tasks.text);
  await page.locator('#known').selectOption('inbox');
  await notice(page, 'актуальное содержимое Мысли.md');
  assert.equal(await page.locator('#capture').isVisible(), true);
  assert.equal(state.patches, 1);
});

test('a renamed test file cannot redirect an outstanding draft even to a supported Inbox', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  await page.locator('#thought').fill('Только в исходную тестовую заметку');
  state.files.get('fixture-a').name = 'Мысли.md';
  await page.locator('#save').click();
  await notice(page, 'Имя выбранного файла изменилось');
  assert.equal(state.patches, 0);
  assert.equal((await saved(page)).draft.fileId, 'fixture-a');
  assert.equal(state.files.get('fixture-a').text, original);
  state.files.get('fixture-a').name = 'My-Day-test.md';
  await page.locator('#save').click();
  await notice(page, 'подтверждено');
  assert.equal(state.patches, 1);
});

test('the Drive writer rejects both reading-only names before making any request', async () => {
  for (const name of ['Now.md', 'To Do now.md']) {
    await assert.rejects(saveDraft({fileId: 'tasks'}, () => assert.fail('Unexpected Drive request'), name), /только для чтения/);
  }
});
