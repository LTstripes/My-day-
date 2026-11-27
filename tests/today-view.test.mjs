import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, saved} from './browser.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

function addSources(state) {
  const context = {name: 'Now.md', text: '# Now\nСверить план поездки.\n', version: 1, canEdit: false};
  const tasks = {name: 'To Do now.md', text: '## Сегодня\n- [ ] Сверить расписание\n', version: 1, canEdit: false};
  state.files.set('day-context', context);
  state.files.set('day-tasks', tasks);
  return {context, tasks};
}

function changeText(file, text) {
  file.text = text;
  file.version++;
}

async function pick(page, id, button) {
  await page.evaluate(fileId => { pickTest.id = fileId; }, id);
  await button.click();
}

const pickerFor = (page, name) => page.locator('[data-day-pick="' + name + '"]');
const waitText = (card, text) => card.filter({hasText: text}).waitFor();

test('Today displays ordinary bullets beside open tasks, preserves the source and explains an unrecognised format', async t => {
  const {open, state} = await fixture(browser, t);
  const {context, tasks} = addSources(state);
  context.text = '# Now\n- Деталь контекста\n';
  tasks.text = '- Проверить билеты\n* [ ] Собрать сумку\n- [x] Оплатить поездку\n\n';
  const page = await open();
  await firstFile(page, true);
  const card = page.locator('#today-tasks');
  await pick(page, 'day-context', pickerFor(page, 'Now.md'));
  await waitText(page.locator('#today-context'), 'Деталь контекста');
  await pick(page, 'day-tasks', pickerFor(page, 'To Do now.md'));
  await waitText(card, 'Выполнено задач: 1');
  assert.equal(await card.locator('li[data-kind=bullet]').textContent(), 'Проверить билеты');
  assert.match(await card.locator('li[data-kind=open]').textContent(), /Собрать сумку/);
  assert.doesNotMatch(await card.textContent(), /Деталь контекста|Оплатить поездку/);
  assert.equal(await card.locator('[data-open]').getAttribute('href'), 'https://drive.google.com/open?id=day-tasks');
  assert.match(await card.locator('[data-state]').textContent(), /Прочитано/);
  changeText(tasks, '# To Do now\n## Сегодня\nЧто-то в свободной форме.\n');
  await page.locator('#today-refresh').click();
  await waitText(card, 'Формат списка не распознан');
  assert.equal(state.patches, 0);
});

test('completed tasks follow the selected source, preserve keyboard focus on refresh and disappear after revocation', async t => {
  const {open, state} = await fixture(browser, t);
  const {tasks} = addSources(state);
  tasks.text = '## Сегодня\n- [x] Забрать посылку\n- [X] Купить чай\n## Завтра\n- [x] Отнести письмо';
  const page = await open();
  await firstFile(page, true);
  const pickTasks = pickerFor(page, 'To Do now.md');
  await pick(page, 'day-tasks', pickTasks);
  const body = page.locator('#today-tasks [data-body]');
  const summary = body.locator('summary');
  const rows = body.locator('details li');
  await waitText(body, 'Все задачи в списке выполнены');
  assert.equal(await summary.textContent(), 'Выполнено задач: 2');
  assert.equal(await rows.count(), 0);
  const reads = state.mediaReads.length;
  await summary.focus();
  await summary.press('Enter');
  await rows.first().waitFor();
  assert.deepEqual(await rows.allTextContents(), ['Забрать посылку', 'Купить чай']);
  assert.equal(state.mediaReads.length, reads);
  assert.equal(await body.getByRole('button').count(), 0);
  changeText(tasks, '## Сегодня\n- [x] Куплен чай\nЕщё один абзац');
  await page.locator('#today-refresh').evaluate(button => button.click());
  await rows.filter({hasText:'Куплен чай'}).waitFor();
  assert.equal(await summary.evaluate(node => node === document.activeElement), true);
  assert.equal(await summary.textContent(), 'Выполнено задач: 1');
  assert.match(await body.textContent(), /текст вне списка/);
  state.files.set('other-tasks', {name:'To Do now.md', text:'- [x] Вторая заметка', version:1});
  await pick(page, 'other-tasks', pickTasks);
  await waitText(body, 'Все задачи в списке выполнены');
  assert.equal(await body.locator('details').evaluate(node => node.open), false);
  await summary.press('Space');
  await rows.filter({hasText:'Вторая заметка'}).waitFor();
  state.files.get('other-tasks').refusal = {status:403, reason:'appNotAuthorizedToFile'};
  await page.locator('#today-refresh').click();
  await summary.waitFor({state:'detached'});
  assert.equal(await body.textContent(), '');
  assert.equal(state.patches, 0);
});

test('a new day or login folds the completed list, and a day without tasks has no disclosure', async t => {
  const {open, state} = await fixture(browser, t, {timezoneId:'UTC'});
  const {tasks} = addSources(state);
  tasks.text = '## 2026-11-26\n- [x] Четверг\n## 2026-11-27\n- [X] Пятница';
  const page = await open();
  await page.clock.install({time:new Date('2026-11-26T23:58:00Z')});
  await page.reload();
  await firstFile(page, true);
  await pick(page, 'day-tasks', pickerFor(page, 'To Do now.md'));
  const body = page.locator('#today-tasks [data-body]');
  const summary = body.locator('summary');
  await summary.click();
  await body.getByText('Четверг', {exact:true}).waitFor();
  await page.clock.fastForward(121000);
  await page.locator('#today-date[datetime="2026-11-27"]').waitFor();
  assert.equal(await body.locator('details').evaluate(node => node.open), false);
  await summary.click();
  await body.getByText('Пятница', {exact:true}).waitFor();
  await page.locator('#disconnect').click();
  await summary.waitFor({state:'detached'});
  assert.equal(await body.textContent(), '');
  await page.locator('#connect').click();
  await summary.waitFor();
  assert.equal(await body.locator('details').evaluate(node => node.open), false);
  changeText(tasks, '## Сегодня\n\n## Завтра\n- [x] Другая дата');
  await page.locator('#today-refresh').click();
  await waitText(body, 'В разделе дня нет пунктов списка.');
  assert.equal(await body.locator('details').count(), 0);
  assert.equal(state.patches, 0);
});

test('quick capture keeps the explicitly open Inbox when another file has the same name', async t => {
  const {open, state} = await fixture(browser, t);
  const original = '# Мысли\n';
  for (const id of ['inbox-a', 'inbox-b']) state.files.set(id, {name: 'Мысли.md', text: original, version: 1});
  const page = await open();
  await firstFile(page, true);
  for (const id of ['inbox-a', 'inbox-b']) {
    await pick(page, id, page.locator('#pick'));
    await page.locator('#file').filter({hasText: id}).waitFor();
  }
  await page.locator('#known').selectOption('inbox-a');
  await notice(page, 'актуальное содержимое');
  await page.locator('#today-capture').click();
  await page.locator('#thought').fill('Мысль для первой заметки');
  assert.equal((await saved(page)).draft.fileId, 'inbox-a');
  await page.locator('#save').click();
  await notice(page, 'подтверждено');
  assert.match(state.files.get('inbox-a').text, /Мысль для первой заметки/);
  assert.equal(state.files.get('inbox-b').text, original);

  // An older profile can have two Inbox IDs and an active choice without a preference.
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('my-day-device-v1'));
    delete stored.preferredIds;
    localStorage.setItem('my-day-device-v1', JSON.stringify(stored));
  });
  state.pickerDown = true;
  await page.reload();
  await page.locator('#connect').click();
  await notice(page, 'актуальное содержимое');
  await page.locator('#today-capture').click();
  assert.equal(await page.locator('#thought').evaluate(field => document.activeElement === field), true);
  assert.equal((await saved(page)).activeId, 'inbox-a');
  assert.equal(state.patches, 1);
});

test('Today reads selected sources on return, follows the local day and keeps a pending Inbox draft on its target', async t => {
  const {open, state} = await fixture(browser, t, {timezoneId: 'America/Los_Angeles'});
  const {context, tasks} = addSources(state);
  state.files.set('inbox', {name: 'Мысли.md', text: '# Входящие\n', version: 1});
  let page = await open();
  assert.equal(await page.locator('#today').isVisible(), true);
  assert.equal(state.calls.length, 0);
  await firstFile(page, true);
  await pick(page, 'inbox', page.locator('#today-capture'));
  await page.locator('#target').filter({hasText: 'Мысли.md'}).waitFor();
  await page.waitForFunction(() => document.activeElement.id === 'thought');
  await page.locator('#thought').fill('Сохранить этот черновик в Inbox');
  const draft = (await saved(page)).draft;
  await pick(page, 'day-context', pickerFor(page, 'Now.md'));
  await waitText(page.locator('#today-context'), 'Сверить план поездки');
  assert.equal(await pickerFor(page, 'To Do now.md').isEnabled(), true);
  assert(!state.mediaReads.includes('day-tasks'));
  await pick(page, 'day-tasks', pickerFor(page, 'To Do now.md'));
  await waitText(page.locator('#today-tasks'), 'Сверить расписание');
  assert.equal((await saved(page)).activeId, 'inbox');
  assert.deepEqual((await saved(page)).draft, draft);
  const stored = JSON.stringify(await saved(page));
  assert(!stored.includes('Сверить план поездки'));
  assert(!stored.includes('Сверить расписание'));
  await page.close();

  changeText(context, '# Now\nВнешнее уточнение фокуса.\n');
  changeText(tasks, '## 2026-11-25\n- [ ] План на среду\n- [x] Закрыто\n## 2026-11-26\n- [ ] План на четверг\n');
  const requests = state.calls.length;
  page = await open();
  // In Los Angeles it is still Wednesday, in UTC it is already Thursday.
  await page.clock.install({time: new Date('2026-11-26T07:58:00Z')});
  await page.reload();
  assert.equal(state.calls.length, requests);
  assert.deepEqual(await page.evaluate(() => gis.prompts), []);
  assert(!(await page.locator('#today').textContent()).includes('Сверить план поездки'));
  await page.getByRole('button', {name: 'Подключиться снова'}).click();
  await waitText(page.locator('#today-context'), 'Внешнее уточнение фокуса');
  const taskCard = page.locator('#today-tasks');
  await waitText(taskCard, 'План на среду');
  assert.doesNotMatch(await taskCard.textContent(), /План на четверг|Закрыто/);
  assert.equal(await page.locator('#today-date').getAttribute('datetime'), '2026-11-25');
  assert.match(await page.locator('#today-zone').textContent(), /America\/Los_Angeles/);
  const readsBeforeMidnight = state.calls.length;
  await page.clock.fastForward(121000);
  await waitText(taskCard, 'План на четверг');
  assert.doesNotMatch(await taskCard.textContent(), /План на среду/);
  assert.equal(await page.locator('#today-date').getAttribute('datetime'), '2026-11-26');
  assert.equal(state.calls.length, readsBeforeMidnight);
  assert.equal(await page.evaluate(() => pickTest.opens), 0);
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(await page.locator('#thought').inputValue(), draft.text);
  assert.equal(state.patches, 0);
  await page.locator('#today-capture').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'thought');
  await page.locator('#save').click();
  await notice(page, 'подтверждено');
  assert.equal(state.patches, 1);
  assert(state.files.get('inbox').text.includes(draft.text));
  assert(!context.text.includes(draft.text));
  assert(!tasks.text.includes(draft.text));
});

test('a failed source is marked stale, the other still refreshes, revocation and sign-out remove private text', async t => {
  const {open, state} = await fixture(browser, t);
  const {context, tasks} = addSources(state);
  const page = await open();
  await page.setViewportSize({width: 360, height: 760});
  await firstFile(page, true);
  const focusCard = page.locator('#today-context');
  const taskCard = page.locator('#today-tasks');
  await pick(page, 'day-context', pickerFor(page, 'Now.md'));
  await waitText(focusCard, 'Сверить план поездки');
  await pick(page, 'day-tasks', pickerFor(page, 'To Do now.md'));
  await waitText(taskCard, 'Сверить расписание');

  context.offline = true;
  changeText(tasks, '- [ ] Новый пункт из Drive\n');
  await page.locator('#today-refresh').click();
  await waitText(taskCard, 'Новый пункт из Drive');
  await waitText(focusCard, /устаре|ранее|не удалось обновить/i);
  assert.match(await focusCard.textContent(), /Сверить план поездки/);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  context.offline = false;
  changeText(context, '# Now\nДругой текущий фокус.\n');
  await page.locator('#today-refresh').click();
  await waitText(focusCard, 'Другой текущий фокус');
  assert.doesNotMatch(await focusCard.textContent(), /Сверить план поездки|устаре/i);
  context.refusal = {status: 403, reason: 'appNotAuthorizedToFile'};
  await page.locator('#today-refresh').click();
  await waitText(focusCard, /403|доступ|отказ/i);
  await focusCard.getByText('Другой текущий фокус', {exact: false}).waitFor({state: 'hidden'});
  assert.doesNotMatch(await focusCard.textContent(), /Другой текущий фокус/);
  assert.match(await taskCard.textContent(), /Новый пункт из Drive/);

  tasks.refusal = {status: 401, reason: 'authError'};
  await page.locator('#today-refresh').click();
  await page.waitForFunction(() => !document.getElementById('connect').disabled);
  assert.doesNotMatch(await page.locator('#today').textContent(), /Другой текущий фокус|Новый пункт из Drive/);
  assert.equal(await page.locator('#disconnect').isDisabled(), true);
  delete context.refusal;
  delete tasks.refusal;
  await page.locator('#connect').click();
  await waitText(focusCard, 'Другой текущий фокус');
  await waitText(taskCard, 'Новый пункт из Drive');
  await page.locator('#disconnect').click();
  assert.doesNotMatch(await page.locator('#today').textContent(), /Другой текущий фокус|Новый пункт из Drive/);
  assert.equal(state.patches, 0);
});

test('forgetting in another tab clears Today even when an earlier private read is still pending', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  const {context} = addSources(state);
  const page = await open();
  await firstFile(page, true);
  await pick(page, 'day-context', pickerFor(page, 'Now.md'));
  await waitText(page.locator('#today-context'), 'Сверить план поездки');
  const second = await open();
  changeText(context, '# Now\nОтвет из уже закрытого сеанса\n');

  let releaseRead;
  const resume = new Promise(resolve => { releaseRead = resolve; });
  const mediaRequest = '**/drive/v3/files/day-context?alt=media';
  await ctx.route(mediaRequest, async route => {
    await resume;
    await route.fallback();
  }, {times: 1});
  try {
    await Promise.all([
      page.waitForRequest(mediaRequest, {timeout: 5000}),
      page.locator('#today-refresh').click()
    ]);
    await second.locator('#forget').click();
    await notice(page, 'удалены в другой вкладке');
    assert.doesNotMatch(await page.locator('#today').textContent(), /Сверить план поездки/);
  } finally {
    releaseRead();
  }
  await page.waitForLoadState('networkidle');
  assert.doesNotMatch(await page.locator('#today').textContent(), /Сверить план поездки|Ответ из уже закрытого сеанса/);
  assert.equal(await saved(page), null);
  assert.equal(state.patches, 0);
});

test('a 0.3 profile with two Now files keeps both private until the owner chooses the source', async t => {
  const {open, state} = await fixture(browser, t);
  addSources(state);
  state.files.set('second-context', {name: 'Now.md', text: '# Now\nФокус второго файла.\n', version: 1});
  const page = await open();
  await firstFile(page, true);
  await page.evaluate(() => {
    const key = 'my-day-device-v1';
    const device = JSON.parse(localStorage.getItem(key));
    delete device.preferredIds;
    device.fileIds.push('day-context', 'second-context', 'day-tasks');
    Object.assign(device.noteNames, {'day-context': 'Now.md', 'second-context': 'Now.md', 'day-tasks': 'To Do now.md'});
    localStorage.setItem(key, JSON.stringify(device));
  });
  await page.reload();
  await page.locator('#connect').click();
  await waitText(page.locator('#today-tasks'), 'Сверить расписание');
  const focusCard = page.locator('#today-context');
  assert.doesNotMatch(await focusCard.textContent(), /Фокус второго файла|Сверить план поездки/);
  assert(!state.mediaReads.includes('day-context') && !state.mediaReads.includes('second-context'));

  const selectContext = pickerFor(page, 'Now.md');
  await pick(page, 'day-tasks', selectContext);
  await page.waitForFunction(() => !document.querySelector('[data-day-pick="Now.md"]').disabled);
  assert.equal((await saved(page)).preferredIds?.['Now.md'], undefined);
  assert.doesNotMatch(await focusCard.textContent(), /Сверить расписание/);
  await pick(page, 'second-context', selectContext);
  await waitText(focusCard, 'Фокус второго файла');
  assert.equal((await saved(page)).preferredIds['Now.md'], 'second-context');
  await page.reload();
  await page.locator('#connect').click();
  await waitText(focusCard, 'Фокус второго файла');
  assert.equal(await page.evaluate(() => pickTest.opens), 0);
  assert(!state.mediaReads.includes('day-context'));
  assert.equal(state.patches, 0);
});
