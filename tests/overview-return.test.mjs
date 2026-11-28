import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, releaseLabel, saved} from './browser.mjs';
import {recordBlock} from '../web/core.js';

const origin = 'https://ltstripes.github.io/My-day-/';
const live = process.env.MY_DAY_OVERVIEW_SMOKE === 'live';
const thought = {op:'11111111-2222-4333-8444-555555555555', text:'Что взять в поездку'};
let browser;
before(async () => { browser = await chromium.launch(live ? {channel:'chrome'} : {}); });
after(async () => { await browser?.close(); });

async function visibility(page, hidden) {
  await page.evaluate(hidden => {
    Object.defineProperty(document, 'hidden', {configurable:true, value:hidden});
    document.dispatchEvent(new Event('visibilitychange'));
    if (!hidden) window.dispatchEvent(new Event('focus'));
  }, hidden);
}

async function setup(t, time = '2026-11-27T15:00:00+03:00') {
  const {ctx, state, open} = await fixture(browser, t, {serviceWorkers:'block', timezoneId:'Europe/Moscow'});
  await ctx.clock.setFixedTime(new Date(time));
  const file = (id, name, text) => state.files.set(id, {name, text, version:1});
  file('now','Now.md','# Now\nПервый фокус');
  file('tasks','To Do now.md','## Сегодня\n- Купить чай\n## 2026-11-27\n- Собрать карту\n## 2026-11-28\n- Проверить билеты\n');
  file('plan','Маршрут.md','- [ ] Собрать вещи\n');
  file('attention','Дневник.md','---\nmyday_attention: 2026-11-27\n---\n# Дневник\n');
  file('unselected','Чужой источник.md','# Пример\n');
  const inbox = state.files.get('fixture-a');
  inbox.text += '\n' + recordBlock(thought);
  let page;
  if (live) {
    await ctx.route(origin+'**', r => r.continue());
    page = await ctx.newPage();
    await page.goto(origin);
  } else page = await open();
  await page.getByText(releaseLabel,{exact:true}).waitFor();
  await firstFile(page, true);
  const pick = async (id, control, ready) => {
    await page.evaluate(id => { pickTest.id = id; }, id);
    await page.locator(control).click();
    await page.locator(ready).waitFor();
  };
  await pick('now','#today-context [data-day-pick]', '#today-context [data-open][href$="=now"]');
  await pick('tasks','#today-tasks [data-day-pick]','#today-tasks [data-open][href$="=tasks"]');
  await pick('plan','#plan-pick','#plan-link[href$="=plan"]');
  await page.locator('#plan-pin').click();
  await pick('attention','#reader-pick','#reader-link[href$="=attention"]');
  // Also register the task file as a note. Its snapshot must serve both roles.
  await pick('tasks','#reader-pick','#reader-link[href$="=tasks"]');
  return {page, ctx, state, inbox};
}

function edit(state, id, change) {
  const file = state.files.get(id);
  file.text = change(file.text);
  file.version++;
}

test('a single long return refreshes all selected sources and the assistant answer, keeping drafts and focused destination', async t => {
  const {page, state} = await setup(t);
  await page.locator('#task-entry summary').click();
  await page.locator('#task-text').fill('Задача в черновике');
  const place = page.locator('#task-place');
  const destination = await place.locator('option').last().getAttribute('value');
  await place.selectOption(destination);
  await page.locator('#thought').fill('Мысль в черновике');
  await page.locator('#handoff-open').click();
  await place.focus();
  const before = state.mediaReads.length;
  const drafts = await saved(page);
  await visibility(page, true);
  await page.clock.setFixedTime(new Date('2026-11-27T15:00:20+03:00'));
  // Stay hidden before the qualifying return.
  assert.equal(state.mediaReads.length, before);

  edit(state,'now', value => value.replace('Первый фокус','Новый фокус'));
  edit(state,'tasks', value => value.replace('Купить чай','Купить кофе'));
  edit(state,'plan', value => value.replace('Собрать вещи','Сверить маршрут'));
  edit(state,'attention', value => value.replace('2026-11-27','2026-11-28'));
  edit(state,'fixture-a', value => value + '\n<!-- my-day:assistant:' + thought.op + ' -->\nВзять карту.\n');
  await page.clock.setFixedTime(new Date('2026-11-27T15:01:00+03:00'));
  await visibility(page, false);
  await visibility(page, false);
  await notice(page,'Обзор обновлён');
  assert.deepEqual(state.mediaReads.slice(before).sort(), ['attention','fixture-a','now','plan','tasks']);
  await page.locator('#today-context').getByText('Новый фокус').waitFor();
  await page.locator('#today-tasks').getByText('Купить кофе').waitFor();
  await page.locator('#today-plan').getByText('Сверить маршрут').waitFor();
  assert.equal(await page.locator('#today-attention time').getAttribute('datetime'),'2026-11-28');
  await page.locator('#handoff-result').getByText('Взять карту.').waitFor();
  assert.equal(await place.inputValue(), destination);
  assert.equal(await page.evaluate(() => document.activeElement.id),'task-place');
  assert.deepEqual((await saved(page)).draft, drafts.draft);
  assert.deepEqual((await saved(page)).taskDraft, drafts.taskDraft);
  assert.equal(state.patches,0);
});

test('a short switch does not read, a new local day does, and one rejected file does not prevent other updates', async t => {
  const {page, state} = await setup(t, '2026-11-27T23:59:35+03:00');
  let before = state.mediaReads.length;
  await visibility(page, true);
  await page.clock.setFixedTime(new Date('2026-11-27T23:59:42+03:00'));
  await visibility(page, false);
  assert.equal(state.mediaReads.length,before);
  await visibility(page,true);
  await page.clock.setFixedTime(new Date('2026-11-28T00:00:02+03:00'));
  state.files.get('plan').refusal = {status:403,reason:'insufficientFilePermissions'};
  edit(state,'now', value => value.replace('Первый фокус','Фокус следующего дня'));
  await visibility(page,false);
  await notice(page,'Не удалось обновить весь обзор');
  assert.equal(await page.locator('#today-date').getAttribute('datetime'),'2026-11-28');
  await page.locator('#today-tasks').getByText('Проверить билеты').waitFor();
  await page.locator('#today-context').getByText('Фокус следующего дня').waitFor();
  assert.equal(await page.locator('#today-plan-state').evaluate(node=>node.classList.contains('error')),true);
  assert.deepEqual(state.mediaReads.slice(before).sort(), ['attention','now','tasks']);
  assert.equal(state.patches,0);
});

test('a qualifying return while saving is deferred and never sends a second write', async t => {
  const {page, ctx, state} = await setup(t);
  const upload = '**/upload/drive/v3/files/fixture-a?uploadType=media';
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await ctx.route(upload, async route => { await hold; await route.fallback(); }, {times:1});
  try {
    await page.locator('#thought').fill('Записать один раз');
    await Promise.all([page.waitForRequest(upload),page.locator('#save').click()]);
    await visibility(page,true);
    await page.clock.setFixedTime(new Date('2026-11-27T15:01:05+03:00'));
    const before = state.mediaReads.length;
    await visibility(page,false);
    await visibility(page,false);
    assert.equal(state.mediaReads.length,before);
  } finally { release(); }
  await notice(page,'Обзор обновлён');
  assert.equal(state.patches,1);
  assert.equal(state.files.get('fixture-a').text.split('Записать один раз').length,2);
  assert.equal(await page.locator('#thought').inputValue(),'');
});
