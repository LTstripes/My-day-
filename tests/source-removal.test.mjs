import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, saved, notice} from './browser.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function pick(page, id, selector) {
  await page.evaluate(id => { pickTest.id = id; }, id);
  await page.locator(selector).click();
}
async function selectSource(page, id) {
  await page.locator('#source-manager').evaluate(details => { details.open = true; });
  await page.locator('#source-select').selectOption(id);
}

test('one removal clears both roles, pinned day and search reader while preserving an unrelated Inbox draft', async t => {
  const {open, state} = await fixture(browser, t);
  const source = {name: 'To Do now.md', text: '- [ ] Уточнить маршрут', version: 1};
  state.files.set('day-file', {...source});
  state.files.set('day-copy', {...source, text: '- [ ] Другой план'});
  const page = await open();
  await firstFile(page, true);
  await page.locator('#thought').fill('Мысль в исходном Inbox');
  const draft = (await saved(page)).draft;
  await pick(page, 'day-file', '[data-day-pick="To Do now.md"]');
  await page.locator('#today-tasks').filter({hasText: 'Уточнить маршрут'}).waitFor();
  await pick(page, 'day-copy', '#plan-pick');
  await page.locator('#plan-action').filter({hasText: 'Другой план'}).waitFor();
  await pick(page, 'day-file', '#plan-pick');
  await page.locator('#plan-action').filter({hasText: 'Уточнить маршрут'}).waitFor();
  await page.locator('#plan-pin').click();
  await page.locator('#search-query').fill('маршрут');
  await page.locator('#search-submit').click();
  await page.locator('[data-file-id="day-file"] [data-hit]').first().click();
  await page.locator('#search-text mark').waitFor();

  await selectSource(page, 'day-file');
  const select = page.locator('#source-select');
  assert.equal(await select.locator('option[value=day-file]').count(), 1);
  assert.match(await select.locator('option[value=day-file]').textContent(), /ID day-file/);
  assert.match(await select.locator('option[value=day-copy]').textContent(), /ID day-copy/);
  await page.locator('#source-remove').click();
  await page.locator('#plan-action').filter({hasText: 'Другой план'}).waitFor();
  const current = await saved(page);
  assert.equal(current.activeId, 'fixture-a');
  assert.deepEqual(current.draft, draft);
  assert.doesNotMatch(JSON.stringify(current), /day-file/);
  assert(!current.pinnedPlanId);
  assert.equal(await page.locator('#today-plan').isHidden(), true);
  assert.equal(await page.locator('#today-tasks a[data-open]').getAttribute('href'), null);
  assert.equal(await page.locator('#search-detail').isHidden(), true);
  assert.equal(await page.locator('#search-text').textContent(), '');
  assert.equal(await page.locator('#search-results [data-file-id="day-file"]').count(), 0);
  assert.deepEqual(state.files.get('day-file'), source);
  assert.deepEqual([...new Set(state.calls)], ['GET']);
  const reads = state.mediaReads.length;
  await page.reload();
  await page.locator('#connect').click();
  await page.locator('#plan-action').filter({hasText: 'Другой план'}).waitFor();
  assert(!state.mediaReads.slice(reads).includes('day-file'));
  assert.equal(await page.locator('#thought').inputValue(), draft.text);
});

test('the last shared source is protected during a draft and a pending delivery; it can be removed with the network offline', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page);
  await page.locator('#thought').fill('Тестовая мысль');
  await selectSource(page, 'fixture-a');
  const remove = page.locator('#source-remove');
  assert.equal(await remove.isDisabled(), true);
  state.loseReply = true;
  await page.locator('#save').click();
  await notice(page, 'Не удалось связаться');
  assert.equal(await remove.isDisabled(), true);
  assert.equal(await page.locator('#thought').inputValue(), 'Тестовая мысль');
  await page.locator('#refresh').click();
  await notice(page, 'без дубля');
  await ctx.setOffline(true);
  const calls = state.calls.length;
  await remove.click();
  assert.equal(await page.locator('#source-manager').isHidden(), true);
  assert.equal(await page.locator('#drive-link').getAttribute('href'), null);
  assert.equal(await page.locator('#file').textContent(), 'Файл ещё не выбран.');
  assert.equal(await saved(page), null);
  assert.equal(state.calls.length, calls);
  await ctx.setOffline(false);
  await page.locator('#pick').click();
  await page.locator('#preview').filter({hasText: 'Тестовая мысль'}).waitFor();
  await selectSource(page, 'fixture-a');
  assert.equal(await page.locator('#source-remove').isEnabled(), true);
  assert.equal(state.patches, 1);
});

test('a delayed plan selection cannot reattach a known note removed in another tab', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  const other = await open();
  await selectSource(other, 'fixture-a');
  const path = '**/drive/v3/files/fixture-a?alt=media';
  let release;
  const suspended = new Promise(resolve => { release = resolve; });
  await ctx.route(path, async route => { await suspended; await route.fallback(); }, {times: 1});
  try {
    await Promise.all([page.waitForRequest(path), pick(page, 'fixture-a', '#plan-pick')]);
    await other.locator('#source-remove').click();
    await page.locator('#source-manager').waitFor({state: 'hidden'});
  } finally { release(); }
  await page.waitForFunction(() => !document.getElementById('plan-pick').disabled);
  assert.equal(await page.locator('#plan-source').textContent(), '');
  assert.equal(await page.locator('#source-manager').isHidden(), true);
  assert.equal(await page.locator('#drive-link').getAttribute('href'), null);
  assert.equal(await page.locator('#file').textContent(), 'Файл ещё не выбран.');
  assert.doesNotMatch(await page.locator('#status').textContent(), /My-Day-test/);
  assert.doesNotMatch(JSON.stringify(await saved(page)), /fixture-a/);
  assert.deepEqual([...new Set(state.calls)], ['GET']);
});

test('legacy drafts are protected across tabs and failed local persistence leaves the selected source intact', async t => {
  const {open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  const other = await open();
  await selectSource(page, 'fixture-a');
  await other.evaluate(() => {
    localStorage.setItem('my-day-test-draft-v1', JSON.stringify({
      fileId: 'fixture-a', text: 'Старый черновик', op: 'ffdd8844-aaaa-4bbb-8ccc-001122334455'
    }));
  });
  await page.locator('#source-hint').filter({hasText: 'черновик'}).waitFor();
  assert.equal(await page.locator('#source-remove').isDisabled(), true);
  await other.evaluate(() => localStorage.removeItem('my-day-test-draft-v1'));
  await page.waitForFunction(() => !document.getElementById('source-remove').disabled);
  const before = await saved(page);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('storage unavailable'); }; });
  await page.locator('#source-remove').click();
  await page.locator('#storage-warning').filter({hasText: 'не сохранил'}).waitFor();
  assert.deepEqual(await saved(page), before);
  assert.equal(await page.locator('#file').textContent(), 'My-Day-test.md · ID fixture-a');
  assert.equal(await page.locator('#source-select').inputValue(), 'fixture-a');
  assert.equal(state.patches, 0);
});

test('removing an active note from a signed-out tab wins over an earlier in-flight read and keeps the replacement note', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  const page = await open();
  await firstFile(page, true);
  await pick(page, 'fixture-b', '#pick');
  await page.locator('#file').filter({hasText: 'fixture-b'}).waitFor();
  const other = await open();
  await selectSource(other, 'fixture-b');
  const old = state.files.get('fixture-b');
  old.text += '\nУбранный источник'; old.version++;
  const path = '**/drive/v3/files/fixture-b?alt=media';
  let release;
  const suspended = new Promise(resolve => { release = resolve; });
  await ctx.route(path, async route => { await suspended; await route.fallback(); }, {times: 1});
  try {
    await Promise.all([page.waitForRequest(path), page.locator('#refresh').click()]);
    await other.locator('#source-remove').click();
    await page.locator('#file').filter({hasText: 'fixture-a'}).waitFor();
    assert.equal(await page.locator('#source-select option[value="fixture-b"]').count(), 0);
  } finally { release(); }
  await page.waitForFunction(() => document.getElementById('drive-link').href.endsWith('fixture-a'));
  assert.doesNotMatch(await page.locator('#preview').textContent(), /Убранный источник/);
  assert.equal(await page.locator('#storage-warning').isHidden(), true);
  assert.equal((await saved(page)).activeId, 'fixture-a');
  assert.deepEqual([...new Set(state.calls)], ['GET']);
});
