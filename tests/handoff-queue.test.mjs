import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, saved} from './browser.mjs';
import {recordBlock} from '../web/core.js';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const older = {op: '12345678-abcd-4abc-8abc-123456789abc', text: 'Первая мысль без ответа'};
const ambiguous = {op: '23456789-abcd-4abc-8abc-234567890abc', text: 'Мысль с двумя ответами'};
const answered = {op: '34567890-abcd-4abc-8abc-345678901abc', text: 'Мысль с готовым разбором'};
const latest = {op: '45678901-abcd-4abc-8abc-456789012abc', text: 'Свежая мысль без ответа'};
const draftText = 'Черновик, который ещё не отправляли';
const answerText = 'Сохранённый разбор готовой мысли.';

function answer(record, content) {
  return '<!-- my-day:assistant:' + record.op + ' -->\n' + content + '\n';
}

function append(file, ...blocks) {
  file.text += '\n' + blocks.join('\n');
  file.version++;
}

async function setup(t, ...blocks) {
  const {ctx, open, state} = await fixture(browser, t, {viewport: {width: 360, height: 800}});
  const file = state.files.get('fixture-a');
  append(file, ...blocks);
  // Observe any fetch the navigation initiates, even before its response arrives.
  await ctx.addInitScript(() => {
    const fetchFromPage = window.fetch.bind(window);
    window.queueDriveRequests = 0;
    window.fetch = (url, options) => {
      if (new URL(url).origin === 'https://www.googleapis.com') window.queueDriveRequests++;
      return fetchFromPage(url, options);
    };
  });
  const page = await open();
  const today = page.locator('#today-handoff');
  assert.equal(await today.isVisible(), false);
  await firstFile(page, true);
  return {file, state, page, today, queue: page.locator('#handoff-queue'), counts: page.locator('#handoff-counts'),
    filter: page.locator('#handoff-filter'), next: page.locator('#handoff-next'), record: page.locator('#handoff-record'),
    result: page.locator('#handoff-result'), empty: page.locator('#handoff-empty')};
}

function driveRequests(page) {
  return page.evaluate(() => window.queueDriveRequests);
}

function recordValues(select) {
  return select.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
}

test('Today opens the active note queue and filters and advances without Drive I/O or draft changes', async t => {
  const {file, state, page, today, queue, counts, filter, next, record, result} = await setup(t,
    recordBlock(older), recordBlock(ambiguous), recordBlock(answered), recordBlock(latest),
    answer(ambiguous, 'Первый неоднозначный разбор.'), answer(ambiguous, 'Второй неоднозначный разбор.'),
    answer(answered, answerText));
  const original = file.text;
  await page.locator('#thought').fill(draftText);
  const draft = (await saved(page)).draft;
  const before = await driveRequests(page);

  await today.click();
  assert.equal(await filter.evaluate(element => document.activeElement === element), true);
  assert.equal(await filter.inputValue(), 'all');
  assert.match(await counts.textContent(), /Без ответа: 2 · С ответом: 1 · Неоднозначные: 1/);
  assert.deepEqual(await recordValues(record), [latest.op, answered.op, ambiguous.op, older.op]);
  assert.equal(await record.inputValue(), latest.op);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  await filter.selectOption('missing');
  assert.deepEqual(await recordValues(record), [latest.op, older.op]);
  assert.equal(await record.inputValue(), latest.op);
  await page.locator('#handoff-open').click();
  const command = page.locator('#handoff-command');
  assert((await command.inputValue()).includes(latest.op));
  await next.click();
  assert.equal(await record.inputValue(), older.op);
  assert.equal(await command.inputValue(), '');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  });
  await next.click();
  assert.equal(await record.inputValue(), latest.op);

  await filter.selectOption('saved');
  assert.deepEqual(await recordValues(record), [answered.op]);
  await record.selectOption(answered.op);
  assert.equal(await result.textContent(), answerText);

  await filter.selectOption('ambiguous');
  assert.deepEqual(await recordValues(record), [ambiguous.op]);
  await record.selectOption(ambiguous.op);
  assert.equal(await page.locator('#handoff-open').isDisabled(), true);
  assert.equal(await result.isVisible(), false);
  assert.match(await page.locator('#handoff-result-state').textContent(), /не удалось однозначно подтвердить/);
  await next.click();
  assert.equal(await filter.inputValue(), 'missing');
  assert.equal(await record.inputValue(), older.op);

  assert.equal(await driveRequests(page), before);
  assert.equal(await page.locator('#thought').inputValue(), draftText);
  assert.deepEqual((await saved(page)).draft, draft);
  await page.locator('#disconnect').click();
  await notice(page, 'Отключено.');
  assert.equal(await today.isVisible(), false);
  assert.equal(await queue.isVisible(), false);
  assert.equal(await counts.textContent(), '');
  assert.deepEqual(await recordValues(record), []);
  assert.equal(await result.textContent(), '');
  assert.equal(await page.locator('#thought').inputValue(), draftText);
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(state.patches, 0);
  assert.equal(file.text, original);
});

test('a reply arriving on return stays visible for the selected thought and updates the pending filter', async t => {
  const {file, state, page, today, counts, filter, next, record, result, empty} = await setup(t,
    recordBlock(older), recordBlock(answered), answer(answered, answerText));
  await page.locator('#thought').fill(draftText);
  const draft = (await saved(page)).draft;
  await today.click();
  await filter.selectOption('missing');
  assert.deepEqual(await recordValues(record), [older.op]);
  await record.selectOption(older.op);
  assert.equal(await next.isDisabled(), true);
  await page.locator('#handoff-open').click();
  const command = await page.locator('#handoff-command').inputValue();
  assert(command.includes('fixture-a') && command.includes('<!-- my-day:' + older.op + ' -->'));
  assert(!command.includes(answered.op));

  const readsBefore = state.mediaReads.length;
  const before = await driveRequests(page);
  const reply = 'Ответ пришёл, пока открывали чат.';
  append(file, answer(older, reply));
  const updated = file.text;
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
  });
  await result.filter({hasText: reply}).waitFor();
  assert.equal(await record.inputValue(), older.op);
  assert.equal(await result.textContent(), reply);
  assert.match(await counts.textContent(), /Без ответа: 0 · С ответом: 2 · Неоднозначные: 0/);
  assert.deepEqual(state.mediaReads.slice(readsBefore), ['fixture-a']);
  assert.equal(await driveRequests(page), before + 3);

  await filter.selectOption('missing');
  await empty.filter({hasText: 'В этой группе пока нет мыслей.'}).waitFor();
  assert.deepEqual(await recordValues(record), []);
  assert.equal(await next.isDisabled(), true);
  assert.equal(await result.isVisible(), false);
  assert.equal(await result.textContent(), '');
  assert.equal(await page.locator('#handoff-open').isDisabled(), true);
  assert.equal(await driveRequests(page), before + 3);
  assert.equal(await page.locator('#thought').inputValue(), draftText);
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(state.patches, 0);
  assert.equal(file.text, updated);
});

test('selecting a same-named empty note shows only its own assistant queue', async t => {
  const {state, page, today, queue, counts, record, empty, result} = await setup(t,
    recordBlock(answered), answer(answered, answerText));
  await result.filter({hasText: answerText}).waitFor();
  await page.evaluate(() => { pickTest.id = 'fixture-b'; });
  await page.locator('#pick').click();
  await page.locator('#file').filter({hasText: 'fixture-b'}).waitFor();
  await today.click();
  await empty.filter({hasText: 'Здесь пока нет мыслей, которые можно выбрать для разбора.'}).waitFor();
  assert.match(await counts.textContent(), /Без ответа: 0 · С ответом: 0 · Неоднозначные: 0/);
  assert.deepEqual(await recordValues(record), []);
  assert.equal(await result.textContent(), '');
  assert.doesNotMatch(await queue.textContent(), /готовым разбором|Сохранённый разбор/);

  await page.locator('#known').selectOption('fixture-a');
  await result.filter({hasText: answerText}).waitFor();
  assert.match(await counts.textContent(), /Без ответа: 0 · С ответом: 1 · Неоднозначные: 0/);
  assert.deepEqual(await recordValues(record), [answered.op]);
  assert.equal(state.patches, 0);
});
