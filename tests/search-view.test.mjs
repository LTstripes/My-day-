import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, original, saved} from './browser.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const resultFor = (page, id) => page.locator('#search-results [data-file-id="' + id + '"]');
const waitText = (locator, text) => locator.filter({hasText: text}).waitFor();

async function pickFile(page, id) {
  await page.evaluate(value => { pickTest.id = value; }, id);
  await page.locator('#pick').click();
  await waitText(page.locator('#file'), id);
}

async function search(page, query) {
  await page.locator('#search-query').fill(query);
  await page.locator('#search-query').press('Enter');
}

async function assertCleared(page, privateText) {
  assert.equal(await page.locator('#search-query').inputValue(), '');
  assert.equal(await page.locator('#search-results [data-hit]').count(), 0);
  assert.equal(await page.locator('#search-detail').isVisible(), false);
  assert(!(await page.locator('#search').textContent()).includes(privateText));
}

async function holdNextSearch(ctx, page, fileId) {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const media = '**/drive/v3/files/' + fileId + '?alt=media';
  await ctx.route(media, async route => { await hold; await route.fallback(); }, {times: 1});
  try {
    await Promise.all([page.waitForRequest(media, {timeout: 5000}), page.locator('#search-submit').click()]);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

test('search checks only the picked files and opens the exact same-name source without redirecting a draft', async t => {
  const {open, state} = await fixture(browser, t);
  state.files.get('fixture-a').text += 'Первый перелёт отмечен на карте.\n';
  state.files.get('fixture-b').text += Array.from({length: 6},
    (_, index) => 'Перелёт из второй заметки, вариант ' + (index + 1) + '.').join('\n\n');
  const inbox = '# Мысли\nЧерновики пишутся сюда.\n';
  state.files.set('inbox', {name: 'Мысли.md', text: inbox, version: 1});
  state.files.set('unselected', {name: 'Now.md', text: 'Перелёт вне набора.\n', version: 1});
  const page = await open();
  assert.equal(await page.locator('#search').isVisible(), true);
  assert.equal(await page.locator('#search-submit').isDisabled(), true);
  assert.equal(state.calls.length, 0);
  await firstFile(page, true);
  await pickFile(page, 'fixture-b');
  await pickFile(page, 'inbox');
  // A previously connected file may now be viewable but no longer editable.
  state.files.get('fixture-b').canEdit = false;
  await page.locator('#thought').fill('Чай в термос');
  const profile = await saved(page);
  const driveRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname === 'www.googleapis.com') driveRequests.push(url);
  });

  await page.locator('#search-query').fill('ПЕРЕЛЕТ');
  await page.waitForLoadState('networkidle');
  assert.equal(driveRequests.length, 0);
  const start = state.mediaReads.length;
  await page.locator('#search-query').press('Enter');
  await waitText(resultFor(page, 'fixture-a'), 'Первый');
  const second = resultFor(page, 'fixture-b');
  await waitText(second, 'из второй заметки');
  assert.deepEqual(state.mediaReads.slice(start).sort(), ['fixture-a', 'fixture-b', 'inbox']);
  assert(driveRequests.every(url => profile.fileIds.includes(url.pathname.split('/').at(-1))));
  assert(driveRequests.every(url => !decodeURIComponent(url.href).toUpperCase().includes('ПЕРЕЛЕТ')));
  assert(!decodeURIComponent(page.url()).toUpperCase().includes('ПЕРЕЛЕТ'));
  assert(!JSON.stringify(await saved(page)).includes('ПЕРЕЛЕТ'));

  await page.setViewportSize({width: 360, height: 760});
  const beforeMore = state.calls.length;
  await second.getByRole('button', {name: /Ещё совпадения/}).click();
  await second.locator('[data-hit]').filter({hasText: 'вариант 6'}).click();
  assert.equal(state.calls.length, beforeMore);
  const detail = page.locator('#search-detail');
  await waitText(detail, 'из второй заметки');
  assert.equal(await detail.locator('mark').first().textContent(), 'Перелёт');
  const link = new URL(await page.locator('#search-drive-link').getAttribute('href'));
  assert.equal(link.hostname, 'drive.google.com');
  assert(link.searchParams.get('id') === 'fixture-b' || link.pathname.split('/').includes('fixture-b'));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#search-back').click();
  await second.waitFor();
  assert.equal(await page.locator('#search-query').inputValue(), 'ПЕРЕЛЕТ');
  await second.locator('[data-hit]').first().click();
  await page.locator('#search-draft').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'thought');
  assert.equal(await page.locator('#thought').inputValue(), profile.draft.text);
  assert.equal(await page.locator('#preview').textContent(), inbox);
  assert.deepEqual(await saved(page), profile);
  await search(page, 'my-day-test.md');
  await resultFor(page, 'fixture-a').waitFor();
  await resultFor(page, 'fixture-b').waitFor();
  assert.equal(await resultFor(page, 'inbox').count(), 0);
  assert.equal(state.patches, 0);
});

test('fresh results show an external change and distinguish an unavailable file from no matches', async t => {
  const {open, state} = await fixture(browser, t);
  const first = state.files.get('fixture-a');
  first.text += 'Встреча перенесена на пятницу.\n';
  first.text += Array.from({length: 20}, (_, i) => 'Встреча клуба, пункт ' + (i + 1) + '.').join('\n\n');
  const focus = {name: 'Now.md', text: '# Now\nВстреча в синем зале.\n', version: 1, canEdit: false};
  state.files.set('focus', focus);
  const page = await open();
  await firstFile(page);
  await page.evaluate(() => { pickTest.id = 'focus'; });
  await page.locator('[data-day-pick="Now.md"]').click();
  await waitText(page.locator('#today-context'), 'в синем зале');
  await search(page, 'Встреча');
  await waitText(resultFor(page, 'focus'), 'в синем зале');
  const many = resultFor(page, 'fixture-a');
  const more = many.getByRole('button', {name: /Ещё совпадения/});
  await more.click();
  await more.click();
  assert.equal(await many.locator('[data-hit]').count(), 15);
  await resultFor(page, 'focus').locator('[data-hit]').first().click();
  await waitText(page.locator('#search-detail'), 'в синем зале');
  focus.refusal = {status: 403, reason: 'appNotAuthorizedToFile'};
  await page.locator('#today-refresh').click();
  await waitText(page.locator('#today-context'), '403');
  assert.equal(await page.locator('#search-detail').isVisible(), false);
  assert(!(await page.locator('#search').textContent()).includes('в синем зале'));
  // Invalidating the other file redraws the list, but the next page must continue from 15.
  await more.click();
  assert.equal(await many.locator('[data-hit]').count(), 20);
  first.text = original + 'Встреча перенесена на вторник.\n';
  first.version++;
  await page.locator('#search-submit').click();
  await waitText(resultFor(page, 'fixture-a'), 'на вторник');
  const section = page.locator('#search');
  await waitText(section, /частич|недоступ|не удалось|403|прочитан[ао]?\s+1\s+из\s+2/i);
  assert.doesNotMatch(await section.textContent(), /в синем зале|на пятницу/);
  assert(!(await page.locator('#today-context').textContent()).includes('в синем зале'));

  await search(page, 'Гиацинтовый');
  await waitText(section, /частич|недоступ|не удалось|403|прочитан[ао]?\s+1\s+из\s+2/i);
  await page.locator('#search-results [data-hit]').first().waitFor({state: 'detached'});
  delete focus.refusal;
  await page.locator('#search-submit').click();
  await waitText(page.locator('#search-status'), /ничего не найдено|совпадений нет|совпадений не найдено|найдено\D*0/i);
  assert.equal(await page.locator('#search-results [data-hit]').count(), 0);
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  assert.equal(state.patches, 0);
});

test('clearing, expiry and disconnect remove the private search including its open excerpt', async t => {
  const {open, state} = await fixture(browser, t);
  const file = state.files.get('fixture-a');
  file.text += 'Путеводитель лежит на полке.\n';
  const page = await open();
  await firstFile(page, true);
  await search(page, 'Путеводитель');
  await resultFor(page, 'fixture-a').locator('[data-hit]').first().click();
  await waitText(page.locator('#search-detail'), 'на полке');
  await page.locator('#search-clear').click();
  await assertCleared(page, 'на полке');

  await search(page, 'Путеводитель');
  await resultFor(page, 'fixture-a').waitFor();
  file.refusal = {status: 401, reason: 'authError'};
  await page.locator('#search-submit').click();
  await notice(page, '401');
  await assertCleared(page, 'на полке');

  delete file.refusal;
  await page.locator('#connect').click();
  await notice(page, 'актуальное содержимое');
  await search(page, 'Путеводитель');
  await resultFor(page, 'fixture-a').locator('[data-hit]').first().click();
  await waitText(page.locator('#search-detail'), 'на полке');
  await page.locator('#disconnect').click();
  await assertCleared(page, 'на полке');
  assert.equal(state.patches, 0);
});

test('forget in another tab invalidates a delayed search response', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  const file = state.files.get('fixture-a');
  file.text += 'Письмо в закрытом конверте.\n';
  const page = await open();
  await firstFile(page, true);
  await search(page, 'конверт');
  await waitText(resultFor(page, 'fixture-a'), 'Письмо');
  const other = await open();
  const resume = await holdNextSearch(ctx, page, 'fixture-a');
  try {
    await other.locator('#forget').click();
    await notice(page, 'удалены в другой вкладке');
    await assertCleared(page, 'закрытом конверте');
  } finally { resume(); }
  await page.waitForLoadState('networkidle');
  await assertCleared(page, 'закрытом конверте');
  assert.equal(await saved(page), null);
  assert.equal(state.patches, 0);
});

test('editing or clearing a pending query discards its late response and lets the owner keep typing a draft', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  state.files.get('fixture-a').text += 'Маршрут у маяка.\n\nРецепт пирога.\n';
  const page = await open();
  await firstFile(page, true);
  const query = page.locator('#search-query');
  await query.fill('Маршрут');
  const afterEdit = await holdNextSearch(ctx, page, 'fixture-a');
  try {
    await page.locator('#thought').fill('Не потерять набранную мысль');
    await query.fill('Рецепт');
  } finally { afterEdit(); }
  await page.waitForLoadState('networkidle');
  assert.equal(await query.inputValue(), 'Рецепт');
  assert.equal(await page.locator('#search-results [data-hit]').count(), 0);
  await page.locator('#search-submit').click();
  const match = resultFor(page, 'fixture-a').locator('[data-hit] mark');
  await waitText(match, 'Рецепт');
  assert.equal(await match.count(), 1);

  const afterClear = await holdNextSearch(ctx, page, 'fixture-a');
  try {
    await page.locator('#search-clear').click();
    await assertCleared(page, 'пирога');
  } finally { afterClear(); }
  await page.waitForLoadState('networkidle');
  await assertCleared(page, 'пирога');
  assert.equal((await saved(page)).draft.text, 'Не потерять набранную мысль');
  assert.equal(state.patches, 0);
});

test('a slow search accepts draft edits and a new active source from another personal tab', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  state.files.get('fixture-a').text += 'Подготовить дневной маршрут.\n';
  const context = '# Now\nНовый фокус из другой вкладки.\n';
  state.files.set('new-context', {name: 'Now.md', text: context, version: 1, canEdit: false});
  const page = await open();
  await firstFile(page, true);
  const other = await open();
  await other.locator('#connect').click();
  await notice(other, 'актуальное содержимое');
  await page.locator('#search-query').fill('маршрут');
  const firstResponse = await holdNextSearch(ctx, page, 'fixture-a');
  const firstText = 'Начато во второй вкладке';
  const completeText = firstText + ' и дополнено в первой.';
  try {
    await other.locator('#thought').fill(firstText);
    await page.waitForFunction(text => document.getElementById('thought').value === text, firstText, {timeout: 5000});
    assert.equal(await page.locator('#storage-warning').isHidden(), true);
    await page.locator('#thought').fill(completeText);
    await other.waitForFunction(text => document.getElementById('thought').value === text, completeText, {timeout: 5000});
  } finally { firstResponse(); }
  await page.locator('#save').click();
  await notice(page, 'подтверждено');
  assert.equal(state.files.get('fixture-a').text.split(completeText).length - 1, 1);
  assert.equal(state.patches, 1);
  await other.waitForFunction(() => document.getElementById('thought').value === '');

  const secondResponse = await holdNextSearch(ctx, page, 'fixture-a');
  try { await pickFile(other, 'new-context'); }
  finally { secondResponse(); }
  await waitText(page.locator('#file'), 'new-context');
  await waitText(page.locator('#preview'), 'Новый фокус из другой вкладки');
  await waitText(page.locator('#today-context'), 'Новый фокус из другой вкладки');
  assert.equal((await saved(page)).activeId, 'new-context');
  assert.equal(await page.locator('#storage-warning').isHidden(), true);
  assert.equal(state.patches, 1);
});
