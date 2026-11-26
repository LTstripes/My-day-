import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, saved, original} from './browser.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function chooseForToday(page, id) {
  await page.evaluate(id => { pickTest.id = id; }, id);
  await page.locator('#today-capture').click();
}

async function inLibrary(page) {
  assert.equal(await page.locator('#notes > #capture').count(), 1);
  assert.equal(await page.locator('#today-capture-slot').isHidden(), true);
  assert.equal(await page.locator('#library-capture-back').isHidden(), true);
}

test('Today and the library share one editor, unsent thought and explicit Inbox', async t => {
  const {open, state} = await fixture(browser, t, {viewport: {width: 360, height: 800}});
  const page = await open();
  await firstFile(page, true);
  const inbox = {name: 'Мысли.md', text: '# Входящие\n', version: 1};
  state.files.set('inbox', inbox);
  await chooseForToday(page, 'inbox');
  const inline = page.locator('#today-capture-slot #thought');
  await inline.waitFor();
  assert.equal(await inline.evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#thought').count(), 1);
  const text = 'Проверить расписание перед встречей';
  await inline.fill(text);
  const draft = (await saved(page)).draft;
  assert.equal(draft.fileId, 'inbox');

  await page.locator('#today-capture-close').click();
  await inLibrary(page);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'today-capture');
  assert.equal(await page.locator('#notes #thought').inputValue(), text);
  assert.equal(await page.locator('#today-capture').textContent(), 'К черновику');
  await page.locator('#today-capture').click();
  await inline.waitFor();
  await page.locator('#library-capture-back').click();
  await inLibrary(page);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'thought');
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(state.patches, 0);

  await page.locator('#today-capture').click();
  await page.locator('#today-capture-slot #save').click();
  await notice(page, 'подтверждено');
  assert.equal(state.patches, 1);
  assert.equal(inbox.text.split(text).length, 2);
  assert.equal(state.files.get('fixture-a').text, original);
  assert.equal(await inline.inputValue(), '');
});

test('a template draft keeps its address and leaving the session restores the library editor', async t => {
  const {open} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  await page.locator('#thought').fill('Черновик тестового файла');
  await page.locator('#today-capture').click();
  await page.locator('#today-capture-slot #thought').waitFor();
  assert.equal((await saved(page)).draft.fileId, 'fixture-a');
  await page.locator('#disconnect').click();
  await inLibrary(page);
  assert.equal(await page.locator('#thought').inputValue(), 'Черновик тестового файла');
  page.once('dialog', d => d.accept());
  await page.locator('#forget').click();
  await inLibrary(page);
  assert.equal(await page.locator('#thought').inputValue(), '');
});

test('an unsuitable or read-only Inbox cannot open the Today editor', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  await chooseForToday(page, 'fixture-a');
  await notice(page, 'Выбери Мысли.md');
  await inLibrary(page);
  state.files.set('read-inbox', {name: 'Мысли.md', text: '# Входящие\n', version: 1, canEdit: false});
  await chooseForToday(page, 'read-inbox');
  await notice(page, 'требуется право редактирования');
  await inLibrary(page);
  assert.equal(state.patches, 0);
});

test('losing edit access closes Today while retaining the draft for a later verified write', async t => {
  const {open, state} = await fixture(browser, t);
  const inbox = {name: 'Мысли.md', text: '# Inbox\n', version: 1, canEdit: true};
  state.files.set('inbox', inbox);
  const page = await open();
  await firstFile(page, true);
  await chooseForToday(page, 'inbox');
  const text = 'Дождаться доступа к файлу';
  await page.locator('#today-capture-slot #thought').fill(text);
  const draft = (await saved(page)).draft;
  inbox.canEdit = false;
  await page.locator('#refresh').click();
  await notice(page, 'требуется право редактирования');
  await inLibrary(page);
  assert.equal(await page.locator('#save').isDisabled(), true);
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(state.patches, 0);

  inbox.canEdit = true;
  await page.locator('#refresh').click();
  await notice(page, 'актуальное содержимое');
  await page.locator('#today-capture').click();
  assert.equal(await page.locator('#today-capture-slot #thought').inputValue(), text);
  assert.equal(await page.locator('#save').isEnabled(), true);
});

test('forgetting in a second tab cancels an outstanding Today Inbox selection', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  const second = await open();
  state.files.set('pending', {name: 'Мысли.md', text: '# Входящие\n', version: 1});

  let finishRead;
  const hold = new Promise(resolve => { finishRead = resolve; });
  const media = '**/drive/v3/files/pending?alt=media';
  await ctx.route(media, async route => { await hold; await route.fallback(); }, {times: 1});
  try {
    await Promise.all([page.waitForRequest(media), chooseForToday(page, 'pending')]);
    await second.locator('#forget').click();
    await notice(page, 'удалены в другой вкладке');
  } finally { finishRead(); }
  await page.waitForFunction(() => !document.getElementById('connect').disabled);
  await inLibrary(page);
  assert.equal(await page.locator('#thought').isDisabled(), true);
  assert.equal(state.patches, 0);
});
