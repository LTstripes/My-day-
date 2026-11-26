import assert from 'node:assert/strict';
import {test, before, after} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice} from './browser.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

test('personal reload reuses the current grant once and reads fresh Drive without a popup or write', async t => {
  const {open, state} = await fixture(browser, t, {}, true);
  const page = await open();
  await firstFile(page, true);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.locator('#thought').fill('Черновик остаётся здесь');
  const file = state.files.get('fixture-a');
  file.text += 'После обновления страницы';
  file.version++;
  await page.reload();
  await notice(page, 'актуальное содержимое');
  assert.deepEqual(await page.evaluate(() => gis.prompts), []);
  assert.equal(await page.locator('#thought').inputValue(), 'Черновик остаётся здесь');
  assert.match(await page.locator('#preview').textContent(), /После обновления страницы/);
  assert.equal(state.patches, 0);
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  assert(!await page.evaluate(() => JSON.stringify(localStorage).includes('synthetic-browser-token')));
});

test('reload after the browser stops an idle worker still reads the note, and Drive can refuse the grant', async t => {
  const {ctx, open, state} = await fixture(browser, t, {}, true);
  const page = await open();
  await firstFile(page, true);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.reload();
  await notice(page, 'актуальное содержимое');
  assert.deepEqual(await page.evaluate(() => gis.prompts), []);
  await page.locator('#thought').fill('Не отправлять');
  state.refusal = {status: 401, reason: 'authError'};
  await page.reload();
  await notice(page, 'HTTP 401');
  assert.equal(await page.locator('#connect').isEnabled(), true);
  assert.equal(await page.locator('#thought').inputValue(), 'Не отправлять');
  assert(!await page.locator('#preview').textContent().then(text => text.includes('Исходная строка')));
  assert.equal(state.patches, 0);
  assert.deepEqual(await page.evaluate(() => gis.prompts), []);
});

test('a new tab reconnects explicitly and disconnect in another tab prevents both reloads from reconnecting', async t => {
  const {open, state} = await fixture(browser, t, {}, true);
  const page = await open();
  await firstFile(page, true);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  const second = await open();
  await second.reload();
  await second.getByRole('button', {name: 'Подключиться снова'}).waitFor();
  assert.equal(await second.locator('#connect').isEnabled(), true);
  assert.equal(await second.locator('#refresh').isDisabled(), true);
  await second.locator('#connect').click();
  await notice(second, 'актуальное содержимое');
  await second.locator('#disconnect').click();
  await notice(page, 'завершено в другой вкладке');
  const calls = state.calls.length;
  await Promise.all([page.reload(), second.reload()]);
  for (const tab of [page, second]) {
    await tab.getByRole('button', {name: 'Подключиться снова'}).waitFor();
    assert.deepEqual(await tab.evaluate(() => gis.prompts), []);
    assert.equal(await tab.locator('#refresh').isDisabled(), true);
  }
  assert.equal(state.calls.length, calls);
});

test('shared mode after forgetting a connected personal profile stays disconnected across reload', async t => {
  const {open, state} = await fixture(browser, t, {}, true);
  const page = await open();
  await firstFile(page, true);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.locator('#forget').click();
  await firstFile(page);
  const count = state.calls.length;
  await page.reload();
  await page.getByRole('button', {name: 'Подключить Google Drive'}).waitFor();
  assert.equal(await page.locator('#refresh').isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, ...gis.prompts]), [0, 0]);
  assert.equal(state.calls.length, count);
});

test('sign-out in a second tab ends access and preserves an unsaved draft after storage failure', async t => {
  const {open, state} = await fixture(browser, t, {}, true);
  const first = await open();
  await firstFile(first, true);
  const second = await open();
  await second.locator('#connect').click();
  await notice(second, 'актуальное содержимое');
  await first.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); }; });
  await first.locator('#thought').fill('Только в памяти первой вкладки');
  await first.locator('#storage-warning').filter({hasText: 'не сохранил'}).waitFor();
  await second.locator('#disconnect').click();
  await notice(first, 'завершено в другой вкладке');
  assert.equal(await first.locator('#thought').inputValue(), 'Только в памяти первой вкладки');
  assert.equal(await first.locator('#save').isDisabled(), true);
  assert.equal(await first.locator('#refresh').isDisabled(), true);
  assert.equal(state.patches, 0);
});
