import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, releaseLabel, saved} from './browser.mjs';

const live = process.env.MY_DAY_TASK_FILTER_SMOKE === 'live';
const site = 'https://ltstripes.github.io/My-day-/';
let browser;
before(async () => { browser = await chromium.launch(live ? {channel:'chrome'} : {}); });
after(async () => { await browser?.close(); });

async function pick(page, id) {
  await page.evaluate(value => { pickTest.id = value; }, id);
  await page.locator('[data-day-pick="To Do now.md"]').click();
}

async function setup(t, text, timed = false) {
  const {open, ctx, state} = await fixture(browser, t, {serviceWorkers:'block', timezoneId:'UTC', viewport:{width:360,height:800}});
  const tasks = {name:'To Do now.md', text, version:1, canEdit:true};
  state.files.set('tasks', tasks);
  let page;
  if (live) {
    await ctx.route(site + '**', route => route.continue());
    page = await ctx.newPage();
    assert.equal((await page.goto(site)).status(), 200);
    await page.getByText(releaseLabel, {exact:true}).waitFor();
  } else page = await open();
  page.setDefaultTimeout(6500);
  if (timed) {
    await page.clock.install({time:new Date('2026-11-27T23:58:00Z')});
    await page.reload();
  }
  await firstFile(page, true);
  const find = page.locator('#today-task-find'), query = page.locator('#today-task-query');
  assert.equal(await find.isVisible(), false);
  await pick(page, 'tasks');
  await find.waitFor();
  return {page,state,tasks,find,query,matches:page.locator('#today-task-matches'),body:page.locator('#today-tasks [data-body]')};
}

test('keyboard filtering covers only this day, preserves both drafts and performs no Drive calls', async t => {
  const {page,state,find,query,matches,body} = await setup(t,
    '## Сегодня\n- Ёж  дома\n- [ ] ЕЖ дома с книгой\n- [x] Ёж дома с чаем\n- [x] Самолёт\n## Завтра\n- [ ] Ёж дома завтра');
  await page.locator('#thought').fill('Мысль для Inbox');
  await page.locator('#task-entry summary').click();
  await page.locator('#task-text').fill('Отдельный черновик дела');
  await body.locator('summary').click();
  await body.locator('details li').first().waitFor();
  const before = await saved(page);
  const calls = state.calls.length;
  const summary = find.locator('summary');
  await summary.press('Enter');
  await page.waitForFunction(() => document.activeElement.id === 'today-task-query');
  await query.fill(' еЖ ДоМа ');
  await query.press('Enter');
  assert.equal(await matches.textContent(), 'Найдено: 3 из 4.');
  assert.equal(await body.locator('li').count(), 3);
  assert.equal(await body.locator('details').evaluate(node => node.open), true);
  assert.doesNotMatch(await body.textContent(), /Самолёт|завтра/);
  await query.fill('[.*]');
  assert.equal(await matches.textContent(), 'Совпадений нет.');
  assert.equal(await body.locator('li:visible').count(), 0);
  await query.fill('самолет');
  await body.locator('details li').filter({hasText:'Самолёт'}).waitFor();
  assert.equal(await matches.textContent(), 'Найдено: 1 из 4.');
  assert.doesNotMatch(await body.textContent(), /Все задачи/);
  await query.press('Escape');
  await page.waitForFunction(() => !document.getElementById('today-task-query').value);
  assert.equal(await summary.evaluate(node => node === document.activeElement), true);
  assert.equal(await body.locator('li').count(), 4);
  assert.deepEqual(await saved(page), before);
  assert.equal(state.calls.length, calls);
  assert.equal(state.patches, 0);
});

test('filtered checkbox actions use the original lines and ordinary refresh keeps the query', async t => {
  const original = '## Вчера\n- [x] Паром\n## Сегодня\n- [ ] Билет\n- [X] Паром\n## Завтра\n- [x] Паром';
  const {page,state,tasks,find,query,matches,body} = await setup(t, original);
  await find.locator('summary').click();
  await query.fill('паром');
  await body.locator('summary').click();
  await body.getByRole('button', {name:'Вернуть в дела — Паром'}).click();
  const complete = body.getByRole('button', {name:'Выполнено — Паром'});
  await complete.waitFor();
  assert.equal(tasks.text, original.replace('[X]', '[ ]'));
  await complete.click();
  await body.locator('summary').waitFor();
  assert.equal(tasks.text, original.replace('[X]', '[x]'));
  assert.equal(state.patches, 2);
  tasks.text = tasks.text.replace('Билет', 'Билет на паром');
  tasks.version++;
  await page.locator('#today-refresh').click();
  await matches.filter({hasText:'Найдено: 2 из 2.'}).waitFor();
  assert.equal(await query.inputValue(), 'паром');
  assert.equal(state.patches, 2);
});

test('switching day, source, access or session clears the private filter', async t => {
  const {page,state,find,query,matches,body} = await setup(t,
    '## 2026-11-27\n- Вечер\n## 2026-11-28\n- Утро', true);
  async function filter(text) {
    await find.locator('summary').click();
    await query.fill(text);
  }
  async function reset() {
    assert.equal(await find.evaluate(node => node.open), false);
    assert.equal(await query.inputValue(), '');
    assert.equal(await matches.textContent(), '');
  }
  await filter('Вечер');
  await page.clock.fastForward(121000);
  await body.getByText('Утро').waitFor();
  await reset();
  await filter('Утро');
  const second = {name:'To Do now.md', text:'- Другой список', version:1};
  state.files.set('second', second);
  await pick(page, 'second');
  await body.getByText('Другой список').waitFor();
  await reset();
  await filter('Другой');
  second.refusal = {status:403, reason:'appNotAuthorizedToFile'};
  await page.locator('#today-refresh').click();
  await find.waitFor({state:'hidden'});
  await reset();
  assert.equal(await body.textContent(), '');
  delete second.refusal;
  await page.locator('#today-refresh').click();
  await filter('Список');
  await page.locator('#disconnect').click();
  await find.waitFor({state:'hidden'});
  await reset();
  assert.equal(state.patches, 0);
});
