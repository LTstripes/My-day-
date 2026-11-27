import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, releaseLabel, saved} from './browser.mjs';

const live = process.env.MY_DAY_PINNED_READER_SMOKE === 'live';
let browser;
before(async () => { browser = await chromium.launch(live ? {channel: 'chrome'} : {}); });
after(async () => { await browser?.close(); });

const pinned = {id: 'trip-east', name: 'Поездка.md'};
const browsing = {id: 'trip-west', name: pinned.name};
const reminder = {id: 'reminder', name: 'Адрес.md'};
const otherReminder = {id: 'reminder-other', name: reminder.name};
const source = '---\nmyday_view: list\n---\n# Маршрут\n- [ ] Заказать поезд\n\nСоседний абзац о вокзале.\n';
const due = '---\nmyday_attention: 2026-11-27\n---\n';
const profile = {
  version: 1, fileIds: ['inbox', 'tasks'], noteNames: {inbox:'Мысли.md', tasks:'To Do now.md'},
  preferredIds: {'To Do now.md': 'tasks'}, activeId: 'inbox',
  draft: {fileId: 'inbox', text: 'Мысль у окна', op: null}, taskDraft: {fileId: 'tasks', text: 'Собрать вещи', op: null},
  plan: browsing, plans:[pinned, browsing], pinnedPlanId: pinned.id,
  notes: [reminder, otherReminder], readerId: reminder.id
};

async function setup(t, storedProfile = profile) {
  const {ctx, open, state} = await fixture(browser, t, {viewport:{width:360,height:760}, serviceWorkers:'block'});
  const file = (name, text) => ({name, text, version:1});
  state.files.set('inbox', file('Мысли.md', '# Мысли\n'));
  state.files.set('tasks', file('To Do now.md', '- [ ] Текущее дело\n\nКонтекст списка задач.\n'));
  state.files.set('tasks-copy', file('To Do now.md', '- [ ] Дело из копии\n'));
  state.files.set('focus', file('Now.md', '# Now\nКонтекст дня.\n'));
  state.files.set(pinned.id, file(pinned.name, source));
  state.files.set(browsing.id, file(browsing.name, '- [ ] Заполнить заявку'));
  state.files.set(reminder.id, file(reminder.name, due + 'Первый адрес'));
  state.files.set(otherReminder.id, file(otherReminder.name, due + 'Второй адрес'));
  let page;
  if (live) {
    const site = 'https://ltstripes.github.io/My-day-/';
    await ctx.route(site + '**', route => route.continue());
    page = await ctx.newPage();
    await page.goto(site);
    await page.getByText(releaseLabel, {exact:true}).waitFor();
  } else page = await open();
  page.setDefaultTimeout(7500);
  await page.evaluate(data => localStorage.setItem('my-day-device-v1', JSON.stringify(data)), storedProfile);
  await page.reload();
  await page.clock.setFixedTime(new Date('2026-11-27T11:00:00Z'));
  await page.locator('#connect').click();
  await page.locator('#today-plan-action').filter({hasText:'Заказать поезд'}).waitFor();
  await page.waitForFunction(() => !document.getElementById('today-plan-open').disabled);
  return {page, state};
}

async function keyboardOpen(page, selector) {
  const button = page.locator(selector);
  await button.focus();
  await button.press('Enter');
}
const focusId = page => page.evaluate(() => document.activeElement.id);

test('Today opens the preferred focus and task source, keeps drafts, and remembers the reader selection', async t => {
  const storedProfile = {...profile, fileIds:[...profile.fileIds,'focus','tasks-copy'],
    noteNames:{...profile.noteNames,focus:'Now.md','tasks-copy':'To Do now.md'},
    preferredIds:{...profile.preferredIds,'Now.md':'focus'}};
  const {page,state} = await setup(t, storedProfile);
  const drafts = await saved(page);
  const tasks = '[data-day-reader="To Do now.md"]';
  const now = '[data-day-reader="Now.md"]';
  await keyboardOpen(page,tasks);
  await page.locator('#reader-link[href$="=tasks"]').waitFor();
  assert.equal(await page.locator('#reader-view').inputValue(),'list');
  assert.equal(await page.locator('#reader-save').isDisabled(),true);
  await page.locator('#reader-full').click();
  await page.locator('#reader-content').getByText(/Контекст списка задач/).waitFor();
  assert.doesNotMatch(await page.locator('#reader-content').textContent(),/Дело из копии/);
  await page.locator('#reader-back').click();
  assert.equal(await page.locator(tasks).evaluate(el => el === document.activeElement),true);
  await keyboardOpen(page,now);
  await page.locator('#reader-link[href$="=focus"]').waitFor();
  assert.equal(await page.locator('#reader-view').inputValue(),'text');
  await page.locator('#reader-content').getByText(/Контекст дня/).waitFor();
  await page.reload();
  await page.locator('#connect').click();
  await page.locator('#reader-link[href$="=focus"]').waitFor();
  const after = await saved(page);
  assert.equal(after.activeId,'inbox');
  assert.equal(after.readerId,'focus');
  assert.equal(after.preferredIds['To Do now.md'],'tasks');
  assert.deepEqual(after.notes,drafts.notes);
  assert.deepEqual(after.draft,drafts.draft);
  assert.deepEqual(after.taskDraft,drafts.taskDraft);
  assert.equal(state.patches,0);
});

test('pinned namesake opens in its own view, retains both drafts and source roles, and returns by keyboard', async t => {
  const {page, state} = await setup(t);
  await keyboardOpen(page, '#today-plan-open');
  await page.locator('#reader-link[href$="=trip-east"]').waitFor();
  assert.equal(await focusId(page), 'reader-title');
  assert.equal(await page.locator('#reader-select').inputValue(), pinned.id);
  assert.equal(await page.locator('#plan-select').inputValue(), browsing.id);
  assert.equal(await page.locator('#reader-view').inputValue(), 'list');
  assert.equal(await page.locator('#reader-save').isDisabled(), true);
  assert.equal(await page.locator('#reader-attention-date').isDisabled(), true);
  await page.locator('#reader-full').click();
  assert.match(await page.locator('#reader-content').textContent(), /Соседний абзац о вокзале/);
  assert.equal(await page.locator('#today-plan-link').getAttribute('href'), 'https://drive.google.com/open?id=trip-east');
  await keyboardOpen(page, '#reader-back');
  assert.equal(await focusId(page), 'today-plan-open');
  assert.equal(new URL(page.url()).hash, '#today');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const settings = await saved(page);
  for (const key of ['plan','pinnedPlanId','plans','notes','preferredIds','fileIds','draft','taskDraft','activeId']) {
    assert.deepEqual(settings[key], profile[key], key);
  }
  assert.equal(await page.locator('#thought').inputValue(), profile.draft.text);
  assert.equal(await page.locator('#task-text').inputValue(), profile.taskDraft.text);
  assert.equal(state.files.get(pinned.id).text, source);
  assert.deepEqual(await page.evaluate(() => [pickTest.opens, gis.prompts.length]), [0, 1]);
  assert.equal(state.patches, 0);

  await keyboardOpen(page, '#today-plan-open');
  await page.locator('#reader-link[href$="=trip-east"]').waitFor();
  await page.locator('#plan-select').selectOption(pinned.id);
  await page.locator('#plan-pin[aria-pressed="true"]').click();
  await page.locator('#today-plan').waitFor({state:'hidden'});
  await keyboardOpen(page, '#reader-back');
  assert.equal(await focusId(page), 'today-title');
  assert.equal(state.patches, 0);
});

test('a refused pinned read clears the previous note and retries the exact ID without another login or Picker', async t => {
  const {page, state} = await setup(t);
  await page.locator('#reader-content').filter({hasText:'Первый адрес'}).waitFor();
  state.files.get(pinned.id).refusal = {status:403, reason:'insufficientFilePermissions'};
  await keyboardOpen(page, '#today-plan-open');
  await page.locator('#reader-state.error').filter({hasText:'403'}).waitFor();
  assert.equal(await page.locator('#reader-select').inputValue(), pinned.id);
  assert.equal(await page.locator('#reader-content').textContent(), '');
  assert.equal(await page.locator('#reader-link').getAttribute('href'), null);
  delete state.files.get(pinned.id).refusal;
  await page.locator('#reader-refresh').click();
  await page.locator('#reader-link[href$="=trip-east"]').waitFor();
  assert.deepEqual(await page.evaluate(() => [pickTest.opens, gis.prompts.length]), [0, 1]);
  state.files.get(pinned.id).refusal = {status:401, reason:'authError'};
  await page.locator('#reader-refresh').click();
  await page.locator('#reader-display').waitFor({state:'hidden'});
  await page.locator('#status.error').filter({hasText:'401'}).waitFor();
  assert.equal(await page.locator('#reader-content').textContent(), '');
  await keyboardOpen(page, '#reader-back');
  assert.equal(await focusId(page), 'today-title');
  assert.deepEqual(await page.evaluate(() => [pickTest.opens, gis.prompts.length]), [0, 1]);
  assert.deepEqual([...new Set(state.calls)], ['GET']);
});

test('attention returns to the exact rebuilt button, or Today heading when its date disappears', async t => {
  const {page, state} = await setup(t);
  const button = '#today-attention button[data-file-id="reminder-other"]';
  await keyboardOpen(page, button);
  await page.locator('#reader-link[href$="=reminder-other"]').waitFor();
  await keyboardOpen(page, '#reader-back');
  assert.equal(await page.locator(button).evaluate(el => document.activeElement === el), true);
  await keyboardOpen(page, button);
  await page.locator('#reader-link[href$="=reminder-other"]').waitFor();
  const note = state.files.get(otherReminder.id);
  note.text = '# Второй адрес без даты'; note.version++;
  await page.locator('#reader-refresh').click();
  await page.locator(button).waitFor({state:'detached'});
  await keyboardOpen(page, '#reader-back');
  assert.equal(await focusId(page), 'today-title');
  assert.equal(state.patches, 0);
});
