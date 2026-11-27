import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, releaseLabel, saved} from './browser.mjs';

const label = 'Проверить маршрут';
const otherOp = '11111111-1111-4111-8111-111111111111';
const live = process.env.MY_DAY_RECEIPT_SMOKE === 'live';
let browser;
before(async () => { browser = await chromium.launch(live ? {channel:'chrome'} : {}); });
after(async () => { await browser?.close(); });

async function setup(t, inbox = false) {
  const {ctx, state, open} = await fixture(browser, t, {viewport:{width:360,height:760}, serviceWorkers:'block'});
  if (inbox) state.files.get('fixture-a').name = 'Мысли.md';
  let page;
  if (live) {
    const site = 'https://ltstripes.github.io/My-day-/';
    await ctx.route(site + '**', route => route.continue());
    page = await ctx.newPage();
    await page.goto(site);
    await page.getByText(releaseLabel, {exact:true}).waitFor();
  } else page = await open();
  page.setDefaultTimeout(5500);
  await firstFile(page, true);
  return {page, state};
}

test('last confirmed thought reads the exact original ID and operation, leaving the next Inbox draft and keyboard return intact', async t => {
  const {page, state} = await setup(t);
  const first = state.files.get('fixture-a'), second = state.files.get('fixture-b');
  const earlier = '<!-- my-day:' + otherOp + ' -->\r\n' + label + '\r\n';
  first.text += earlier;
  first.version++;
  await page.locator('#thought').fill(label);
  await page.locator('#save').click();
  const button = page.locator('#today [data-receipt="thought"] button').first();
  await button.waitFor();
  const op = first.text.match(/<!-- my-day:([a-f\d-]+) -->/g).at(-1);
  assert.notEqual(op, '<!-- my-day:' + otherOp + ' -->');
  second.text += op + '\n' + label + '\n';
  await page.evaluate(() => { pickTest.id = 'fixture-b'; });
  await page.locator('#pick').click();
  await page.waitForFunction(() => document.getElementById('known').value === 'fixture-b' && !document.getElementById('thought').disabled);
  await page.locator('#thought').fill('Следующая мысль по другому адресу');
  const draft = (await saved(page)).draft;
  const active = await page.evaluate(() => pickTest.opens);
  const panel = page.locator('#receipt-detail');
  first.text += '\nХвост свежей версии';
  first.version++;
  const originalText = first.text;
  state.mediaReads.length = 0;
  await button.focus();
  await button.press('Enter');
  await panel.locator('mark').waitFor();
  assert.equal(await panel.locator('mark').textContent(), label);
  assert((await panel.locator('mark').evaluate(mark => mark.previousSibling.textContent)).includes(label));
  assert((await panel.locator('pre').textContent()).endsWith('Хвост свежей версии'));
  assert((await panel.locator('a').getAttribute('href')).endsWith('id=fixture-a'));
  assert.equal(await panel.locator('mark').evaluate(mark => document.activeElement === mark), true);
  await panel.locator('button').press('Enter');
  assert.equal(await button.evaluate(el => document.activeElement === el), true);
  assert.equal(await panel.isVisible(), false);
  assert.deepEqual((await saved(page)).draft, draft);
  assert.deepEqual(state.mediaReads, ['fixture-a']);
  assert.equal(await page.evaluate(() => pickTest.opens), active);
  assert.equal(first.text, originalText);
  assert.equal(state.patches, 1);

  first.text += '\n' + op + '\n' + label + '\n';
  first.version++;
  await button.click();
  await panel.getByText(/больше не удаётся однозначно/).waitFor();
  assert.equal(await panel.locator('mark').count(), 0);
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(state.patches, 1);
  await page.locator('#disconnect').click();
  assert.equal(await page.locator('[data-receipt]:visible').count(), 0);
  assert.equal(await panel.isVisible(), false);
});

test('a lost task reply creates a receipt only on verified retry; its closed form still opens the checked task by operation', async t => {
  const {state, page} = await setup(t);
  const fileId = 'task-file';
  const file = {name:'To Do now.md', version:1, text:'<!-- my-day:task:' + otherOp + ' -->\r\n- [ ] ' + label + '\r\n'};
  state.files.set(fileId, file);
  await page.locator('#thought').fill('Черновик мысли');
  await page.evaluate(id => { pickTest.id = id; }, fileId);
  await page.locator('[data-day-pick="To Do now.md"]').click();
  const field = page.locator('#task-text'), add = page.locator('#task-add');
  await page.locator('#task-entry summary').click();
  await field.fill(label);
  state.loseReply = true;
  await add.click();
  await page.locator('#task-status').filter({hasText:'неясен'}).waitFor();
  assert.equal(await page.locator('[data-receipt="task"]').isVisible(), false);
  const {op} = (await saved(page)).taskDraft;
  await add.click();
  const receipt = page.locator('[data-receipt="task"]');
  await receipt.waitFor();
  assert.equal(state.patches, 1);
  await field.fill('Следующее дело');
  await page.locator('#task-entry summary').click();
  assert.equal(await field.isVisible(), false);
  const drafts = await saved(page);
  file.text = file.text.replace(new RegExp('(' + op + ' -->\\r?\\n)- \\[ \\] '), '$1- [x] ');
  file.version++;
  await receipt.locator('button').click();
  const panel = page.locator('#receipt-detail');
  await panel.locator('mark').waitFor();
  assert.equal(await panel.locator('mark').textContent(), '- [x] ' + label);
  assert.equal(state.patches, 1);
  assert.deepEqual((await saved(page)).draft, drafts.draft);
  assert.deepEqual((await saved(page)).taskDraft, drafts.taskDraft);
  file.text = file.text.replace('my-day:task:' + op, 'удалённая метка');
  file.version++;
  await receipt.locator('button').click();
  await panel.getByText(/больше не удаётся однозначно/).waitFor();
  assert.equal(await panel.locator('mark').count(), 0);
  assert((await panel.locator('a').getAttribute('href')).endsWith('id=' + fileId));
  assert.equal(state.patches, 1);
});

test('collapsed Today keeps the confirmed thought visible, and reloading keeps only the new draft', async t => {
  const {page, state} = await setup(t, true);
  await page.locator('#today-capture').click();
  await page.locator('#thought').fill(label);
  await page.locator('#save').click();
  const receipt = page.locator('#today > [data-receipt="thought"]');
  await receipt.waitFor();
  await page.locator('#thought').fill('Новый черновик');
  await page.locator('#today-capture-close').click();
  assert.equal(await receipt.isVisible(), true);
  await receipt.locator('button').click();
  await page.locator('#receipt-detail mark').waitFor();
  assert.equal((await saved(page)).draft.text, 'Новый черновик');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('thought').value === 'Новый черновик');
  assert.equal(await page.locator('[data-receipt]:visible').count(), 0);
  assert.equal(state.patches, 1);
});

test('uncertain thought delivery waits for explicit readback; a failed local cleanup leaves a visible warning and retryable draft', async t => {
  const {page, state} = await setup(t);
  const receipt = page.locator('#capture [data-receipt]');
  await page.locator('#thought').fill(label);
  state.loseReply = true;
  await page.locator('#save').click();
  await page.locator('#status.error').waitFor();
  assert.equal(await receipt.isVisible(), false);
  const draft = (await saved(page)).draft;
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'my-day-device-v1' && !JSON.parse(value).draft) throw new Error('unavailable');
      return write.call(this, key, value);
    };
  });
  await page.locator('#refresh').click();
  await receipt.getByText(/Черновик остался/).waitFor();
  assert.equal(await page.locator('#thought').inputValue(), label);
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(state.patches, 1);
});
