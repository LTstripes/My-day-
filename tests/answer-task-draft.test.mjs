import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, releaseLabel, saved} from './browser.mjs';
import {recordBlock} from '../web/core.js';

const live = process.env.MY_DAY_ANSWER_TASK_SMOKE === 'live';
const op = '44af1fb6-d573-4080-a09a-0328bd129e61';
const answerText = 'Проверить расписание утром. Потом сверить билеты.';
let browser;
before(async () => { browser = await chromium.launch(live ? {channel:'chrome'} : {}); });
after(async () => { await browser?.close(); });

async function setup(t, answer = answerText) {
  const {ctx, open, state} = await fixture(browser, t, {viewport:{width:360,height:800}, serviceWorkers:'block'});
  const inbox = state.files.get('fixture-a');
  inbox.text += '\n' + recordBlock({op,text:'Как подготовиться к поездке?'}) +
    '\n<!-- my-day:assistant:' + op + ' -->\n' + answer + '\nСледующая строка заметки.\n';
  const tasks = {name:'To Do now.md',text:'- Купить чай\n',version:1};
  const other = {name:'To Do now.md',text:'- Другой файл\n',version:1};
  state.files.set('target',tasks);
  state.files.set('namesake',other);
  let page;
  if (live) {
    const site = 'https://ltstripes.github.io/My-day-/';
    await ctx.route(site + '**', route => route.continue());
    page = await ctx.newPage();
    await page.goto(site);
    await page.getByText(releaseLabel,{exact:true}).waitFor();
  } else page = await open();
  page.setDefaultTimeout(7500);
  await firstFile(page,true);
  await page.evaluate(()=>{pickTest.id='target';});
  await page.locator('[data-day-pick="To Do now.md"]').click();
  await page.locator('#today-tasks a[data-open][href$="=target"]').waitFor();
  await page.locator('#handoff-task-phrase summary').click();
  return {page,state,inbox,tasks,other};
}

async function selectPhrase(page, from, to) {
  const answer = page.locator('#handoff-task-answer');
  await answer.focus();
  await answer.evaluate((field,[from,to]) => field.setSelectionRange(from,to), [from,to]);
}

test('only selected words reach the exact task draft and write on explicit submit', async t => {
  const {page,state,inbox,tasks,other} = await setup(t);
  const originalInbox = inbox.text, originalTasks = tasks.text, originalOther = other.text;
  const wanted = 'Потом сверить билеты';
  const start = answerText.indexOf(wanted);
  assert.equal(await page.locator('#handoff-task-answer').inputValue(),answerText);
  await page.locator('#thought').fill('Оставить эту мысль черновиком');
  const thought = (await saved(page)).draft;
  await selectPhrase(page,start,start+wanted.length);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id),'handoff-task-draft');
  await page.keyboard.press('Enter');
  await page.locator('#task-status').getByText(/Фраза перенесена/).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id),'task-text');
  assert.equal(await page.locator('#task-text').inputValue(),wanted);
  assert.deepEqual((await saved(page)).taskDraft,{fileId:'target',text:wanted,op:null});
  assert.deepEqual((await saved(page)).draft,thought);
  assert.equal(state.patches,0);
  await page.reload();
  await page.locator('#connect').click();
  await page.locator('#today-tasks a[data-open][href$="=target"]').waitFor();
  assert.equal(await page.locator('#task-text').inputValue(),wanted);
  assert.deepEqual((await saved(page)).draft,thought);
  await page.locator('#task-text').fill('Сверить билеты и карту');
  await page.locator('#task-add').click();
  await page.locator('#task-status').getByText(/подтверждено/).waitFor();
  assert.equal(state.patches,1);
  assert.equal(tasks.text.startsWith(originalTasks),true);
  assert.match(tasks.text,/- \[ \] Сверить билеты и карту/);
  assert.equal(inbox.text,originalInbox);
  assert.equal(other.text,originalOther);
  assert.deepEqual((await saved(page)).draft,thought);
});

test('freshness check stops an old answer and preserves an existing task draft', async t => {
  const {page,state,inbox} = await setup(t);
  inbox.text = inbox.text.replace(answerText,'Подготовить новый маршрут.');
  inbox.version++;
  await selectPhrase(page,0,9);
  await page.locator('#handoff-task-draft').click();
  await page.locator('#handoff-task-state').getByText(/Ответ изменился/).waitFor();
  assert.equal(await page.locator('#handoff-task-answer').inputValue(),'Подготовить новый маршрут.');
  assert.equal((await saved(page)).taskDraft,undefined);
  await page.locator('#task-entry summary').click();
  await page.locator('#task-text').fill('Уже есть черновик');
  assert.equal(await page.locator('#handoff-task-draft').isDisabled(),true);
  assert.match(await page.locator('#handoff-task-hint').textContent(),/Сначала закончи/);
  assert.equal((await saved(page)).taskDraft.text,'Уже есть черновик');
  assert.equal(state.patches,0);
});

test('unselected or too long text and a revoked task permission write nothing', async t => {
  const long = 'Пример '.repeat(60).trim();
  const {page,state,tasks} = await setup(t,long);
  await page.locator('#handoff-task-draft').click();
  await page.locator('#handoff-task-state').getByText(/до 300 символов/).waitFor();
  await selectPhrase(page,0,long.length);
  await page.locator('#handoff-task-draft').click();
  await page.locator('#handoff-task-state').getByText(/до 300 символов/).waitFor();
  tasks.canEdit = false;
  tasks.version++;
  await selectPhrase(page,0,6);
  await page.locator('#handoff-task-draft').click();
  await page.locator('#handoff-task-hint').getByText(/доступ на редактирование/).waitFor();
  assert.equal(await page.locator('#handoff-task-draft').isDisabled(),true);
  assert.equal((await saved(page)).taskDraft,undefined);
  assert.equal(state.patches,0);
});
