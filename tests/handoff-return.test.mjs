import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, saved} from './browser.mjs';
import {recordBlock} from '../web/core.js';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const older = {op: '12345678-abcd-4abc-8abc-123456789abc', text: 'Первая сохранённая мысль'};
const later = {op: '23456789-abcd-4abc-8abc-234567890abc', text: 'Следующая сохранённая мысль'};
const external = {op: '34567890-abcd-4abc-8abc-345678901abc', text: 'Внешняя новая мысль'};
const draftText = 'Черновик для другой мысли';
const answerText = 'Разбор первой сохранённой мысли.';
const media = '**/drive/v3/files/fixture-a?alt=media';

function append(file, text) {
  file.text += '\n' + text;
  file.version++;
}

function answer(record, text) {
  return '<!-- my-day:assistant:' + record.op + ' -->\n' + text + '\n';
}

async function setup(t) {
  const data = await fixture(browser, t, {viewport: {width: 360, height: 800}});
  const file = data.state.files.get('fixture-a');
  append(file, recordBlock(older) + '\n' + recordBlock(later));
  // Count initiated requests synchronously, including any that are still in flight.
  await data.ctx.addInitScript(() => {
    const fetchFromPage = window.fetch.bind(window);
    window.driveRequests = [];
    window.fetch = (url, options) => {
      if (new URL(url).origin === 'https://www.googleapis.com') {
        window.driveRequests.push([url, options?.method ?? 'GET']);
      }
      return fetchFromPage(url, options);
    };
  });
  const page = await data.open();
  await firstFile(page, true);
  return {...data, file, page};
}

function requestCount(page) {
  return page.evaluate(() => window.driveRequests.length);
}

async function prepareOlder(page) {
  await page.locator('#handoff-record').selectOption(older.op);
  await page.locator('#handoff-open').click();
  const command = await page.locator('#handoff-command').inputValue();
  assert(command.includes('fixture-a'));
  assert(command.includes('<!-- my-day:' + older.op + ' -->'));
}

// The bundled headless shell keeps tabs visible. Exercise both return notifications explicitly.
async function signal(page, events) {
  await page.evaluate(events => {
    for (const event of events) {
      if (event === 'hidden' || event === 'visible') {
        Object.defineProperty(document, 'hidden', {configurable: true, value: event === 'hidden'});
        Object.defineProperty(document, 'visibilityState', {configurable: true, value: event});
        document.dispatchEvent(new Event('visibilitychange'));
      } else window.dispatchEvent(new Event(event));
    }
  }, events);
}

async function holdReturnRead(page) {
  let resume;
  const held = new Promise(resolve => { resume = resolve; });
  await page.context().route(media, async route => { await held; await route.fallback(); }, {times: 1});
  try {
    await Promise.all([
      page.waitForRequest(media, {timeout: 5000}),
      signal(page, ['hidden', 'visible', 'focus'])
    ]);
  } catch (error) {
    resume();
    throw error;
  }
  return resume;
}

test('returning after preparing a command reads only that note once and preserves the selected thought and draft', async t => {
  const {file, page, state} = await setup(t);
  state.files.set('today', {name: 'Now.md', text: '# Now\nВыбранный источник обзора.\n', version: 1, canEdit: false});
  await page.evaluate(() => { pickTest.id = 'today'; });
  await page.locator('[data-day-pick="Now.md"]').click();
  await page.locator('#today-context').filter({hasText: 'Выбранный источник обзора.'}).waitFor();
  const before = await requestCount(page);
  const readsBefore = state.mediaReads.length;
  await signal(page, ['hidden', 'blur', 'visible', 'focus']);
  assert.equal(await requestCount(page), before);

  await prepareOlder(page);
  await page.locator('#thought').fill(draftText);
  const draft = (await saved(page)).draft;
  await signal(page, ['visible', 'focus', 'focus']);
  assert.equal(await requestCount(page), before);
  await signal(page, ['hidden', 'blur']);
  assert.equal(await requestCount(page), before);

  append(file, recordBlock(external) + answer(external, 'Разбор новой мысли.') + answer(older, answerText + '\nПодробности разбора.'));
  const externalText = file.text;
  await signal(page, ['visible', 'focus', 'focus', 'visible']);
  await page.locator('#handoff-result').filter({hasText: answerText}).waitFor();
  assert.equal(await page.locator('#handoff-result').textContent(), answerText);
  assert.equal(await page.locator('#handoff-result-state').textContent(), 'Ответ сохранён в Drive.');
  assert.equal(await page.locator('#handoff-record').inputValue(), older.op);
  assert.equal(await page.locator('#handoff-record option').first().getAttribute('value'), external.op);
  assert.equal(await page.locator('#thought').inputValue(), draftText);
  assert.deepEqual((await saved(page)).draft, draft);
  await signal(page, ['hidden', 'visible', 'focus']);
  assert.deepEqual(state.mediaReads.slice(readsBefore), ['fixture-a']);
  assert.equal(await requestCount(page), before + 3);
  assert.equal(state.patches, 0);
  assert.equal(file.text, externalText);
});

test('a pending command stays bound to its selected thought and note', async t => {
  const {page, state} = await setup(t);
  await page.evaluate(() => { pickTest.id = 'fixture-b'; });
  await page.locator('#pick').click();
  await page.locator('#file').filter({hasText: 'fixture-b'}).waitFor();
  await page.locator('#known').selectOption('fixture-a');
  await notice(page, 'актуальное содержимое');

  await prepareOlder(page);
  await page.locator('#handoff-record').selectOption(later.op);
  let before = await requestCount(page);
  await signal(page, ['blur', 'focus']);
  assert.equal(await requestCount(page), before);

  await prepareOlder(page);
  await page.locator('#known').selectOption('fixture-b');
  await notice(page, 'актуальное содержимое');
  before = await requestCount(page);
  await signal(page, ['hidden', 'visible', 'focus']);
  assert.equal(await requestCount(page), before);
  assert.equal(await page.locator('#handoff').isVisible(), false);
  assert.equal(state.patches, 0);
});

test('a missing answer is checked on another return without silently choosing a replacement thought', async t => {
  const {file, page, state} = await setup(t);
  await prepareOlder(page);
  const selected = page.locator('#handoff-record');
  const details = page.locator('#handoff-details');
  const before = await requestCount(page);
  await signal(page, ['blur', 'focus']);
  await notice(page, 'актуальное содержимое');
  assert.equal(await selected.inputValue(), older.op);
  assert.equal(await details.isVisible(), true);
  assert.equal(await requestCount(page), before + 3);
  await signal(page, ['focus', 'focus', 'visible']);
  assert.equal(await requestCount(page), before + 3);

  file.text = file.text.replace(recordBlock(older), '');
  append(file, answer(later, 'Разбор следующей мысли.'));
  await signal(page, ['hidden', 'visible', 'focus']);
  await notice(page, 'Выбранную запись больше не удаётся определить');
  assert.equal(await selected.inputValue(), '');
  assert.equal(await details.isVisible(), false);
  assert.equal(await page.locator('#handoff-result').textContent(), '');
  assert.equal(await requestCount(page), before + 6);
  assert.equal(state.patches, 0);
});

test('failed return read marks data stale and preserves the draft for manual refresh', async t => {
  const {file, page, state} = await setup(t);
  await prepareOlder(page);
  await page.locator('#thought').fill(draftText);
  const draft = (await saved(page)).draft;
  file.refusal = {status: 503, reason: 'backendError'};
  await signal(page, ['blur', 'focus']);
  await notice(page, 'HTTP 503');
  assert.match(await page.locator('#fresh').textContent(), /устаревшими/);
  assert.equal(await page.locator('#handoff-result').isVisible(), false);
  assert.equal(await page.locator('#thought').inputValue(), draftText);
  assert.deepEqual((await saved(page)).draft, draft);

  delete file.refusal;
  append(file, answer(older, answerText));
  const before = await requestCount(page);
  await signal(page, ['hidden', 'visible', 'focus']);
  assert.equal(await requestCount(page), before);
  await page.locator('#refresh').click();
  await notice(page, 'актуальное содержимое');
  await page.locator('#handoff-record').selectOption(older.op);
  assert.equal(await page.locator('#handoff-result').textContent(), answerText);
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(state.patches, 0);
});

test('a return read completed after disconnect does not display its answer', async t => {
  const {file, page, state} = await setup(t);
  await prepareOlder(page);
  await page.locator('#thought').fill(draftText);
  const draft = (await saved(page)).draft;
  append(file, answer(older, answerText));
  const resume = await holdReturnRead(page);
  try {
    await page.locator('#disconnect').click();
    await notice(page, 'Отключено.');
  } finally {
    resume();
  }
  await page.waitForFunction(() => !document.getElementById('connect').disabled);
  assert.equal(await page.locator('#handoff').isVisible(), false);
  assert.equal(await page.locator('#handoff-result').textContent(), '');
  assert.equal(await page.locator('#thought').inputValue(), draftText);
  assert.deepEqual((await saved(page)).draft, draft);
  const before = await requestCount(page);
  await signal(page, ['hidden', 'visible', 'focus']);
  assert.equal(await requestCount(page), before);
  assert.equal(state.patches, 0);
});

test('a return read cannot overwrite the active note switched in another tab', async t => {
  const {file, open, page, state} = await setup(t);
  const nextNote = state.files.get('fixture-b');
  append(nextNote, recordBlock(external) + answer(external, 'Ответ во второй заметке.'));
  await page.evaluate(() => { pickTest.id = 'fixture-b'; });
  await page.locator('#pick').click();
  await page.locator('#handoff-result').filter({hasText: 'Ответ во второй заметке.'}).waitFor();
  await page.locator('#known').selectOption('fixture-a');
  await notice(page, 'актуальное содержимое');

  const second = await open();
  await second.locator('#connect').click();
  await notice(second, 'актуальное содержимое');
  await prepareOlder(page);
  append(file, answer(older, answerText));
  const resume = await holdReturnRead(page);
  try {
    await second.locator('#known').selectOption('fixture-b');
    await page.locator('#file').filter({hasText: 'fixture-b'}).waitFor();
    assert.equal(await page.locator('#handoff-result').textContent(), '');
  } finally {
    resume();
  }
  await page.locator('#handoff-result').filter({hasText: 'Ответ во второй заметке.'}).waitFor();
  assert.equal(await page.locator('#handoff-record').inputValue(), external.op);
  assert.doesNotMatch(await page.locator('#preview').textContent(), new RegExp(answerText));
  assert.equal(state.patches, 0);
});
