import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, saved} from './browser.mjs';
import {recordBlock} from '../web/core.js';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const selected = '12345678-abcd-4abc-8abc-123456789abc';
const otherSaved = '23456789-abcd-4abc-8abc-234567890abc';
const missing = '34567890-abcd-4abc-8abc-345678901abc';
const ambiguous = '45678901-abcd-4abc-8abc-456789012abc';
const latest = '56789012-abcd-4abc-8abc-567890123abc';
const source = '**Одинаковая мысль** про <em>чай</em>.';
const answer = 'Одинаковый ответ с `Markdown` и <em>тегом</em>.';
const draftText = 'Черновик, который ещё не отправляли';

function reply(op, body) {
  return '<!-- my-day:assistant:' + op + ' -->\n\n' + body + '\n';
}

async function setup(t, ...blocks) {
  const {open, state} = await fixture(browser, t, {viewport: {width: 360, height: 760}});
  const file = state.files.get('fixture-a');
  file.text += blocks.join('\n').replaceAll('\n', '\r\n');
  const page = await open();
  const driveRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).origin === 'https://www.googleapis.com') driveRequests.push(request.method());
  });
  await firstFile(page, true);
  await page.locator('#today-handoff').click();
  return {file, state, page, driveRequests, filter: page.locator('#handoff-filter'), record: page.locator('#handoff-record'),
    preview: page.locator('#preview'), mark: page.locator('#preview mark'), back: page.locator('#handoff-back'),
    showSource: page.locator('#handoff-show-source'), showAnswer: page.locator('#handoff-show-answer')};
}

async function assertHighlighted(page, lead, text) {
  const mark = page.locator('#preview mark');
  assert.equal(await mark.count(), 1);
  assert.equal(await mark.textContent(), text);
  const offset = await mark.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('preview'));
    range.setEndBefore(element);
    return range.toString().length;
  });
  const note = await page.locator('#preview').textContent();
  assert(note.includes(lead));
  assert.equal(offset, note.indexOf(text, note.indexOf(lead) + lead.length));
  assert(note.indexOf(text) < offset);
  await page.waitForFunction(() => {
    const preview = document.getElementById('preview');
    const mark = preview.querySelector('mark');
    if (!mark) return false;
    const box = mark.getBoundingClientRect();
    const bounds = preview.getBoundingClientRect();
    return box.bottom > Math.max(0, bounds.top) && box.top < Math.min(innerHeight, bounds.bottom);
  }, {}, {timeout: 5000});
}

test('the narrow note reader highlights the selected thought and answer at their exact locations and returns to the queue', async t => {
  const sourceLead = 'Перед выбранной мыслью.';
  const answerLead = 'Перед выбранным ответом.';
  const continuation = 'Вторая строка полного ответа.';
  const closing = 'Последняя строка полной заметки.';
  const {file, state, page, driveRequests, filter, record, preview, mark, back, showSource, showAnswer} = await setup(t,
    source, answer, recordBlock({op: otherSaved, text: source}),
    reply(otherSaved, answer),
    'Дополнительные строки в заметке.\n'.repeat(24),
    sourceLead, recordBlock({op: selected, text: source}),
    'Дальше идёт другой раздел.\n'.repeat(24),
    answerLead, reply(selected, answer + '\n' + continuation),
    recordBlock({op: latest, text: source}), reply(latest, answer), closing);
  const original = file.text;
  const fullNote = await preview.textContent();
  assert(fullNote.includes(continuation));
  assert(fullNote.includes(closing));
  assert.doesNotMatch(fullNote, /<!-- my-day:/);
  const before = driveRequests.length;
  await page.locator('#thought').fill(draftText);
  const draft = (await saved(page)).draft;
  assert.equal(await record.inputValue(), latest);
  await filter.selectOption('saved');
  await record.selectOption(selected);

  await showSource.click();
  await assertHighlighted(page, sourceLead, source);
  assert.equal(await preview.textContent(), fullNote);
  assert.equal(await preview.locator('em').count(), 0);
  assert.equal(await back.isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await back.click();
  assert.equal(await mark.count(), 0);
  assert.equal(await back.isVisible(), false);
  assert.equal(await filter.inputValue(), 'saved');
  assert.equal(await record.inputValue(), selected);
  assert.equal(await record.evaluate(element => element === document.activeElement), true);

  await showAnswer.click();
  await assertHighlighted(page, answerLead, answer);
  assert.equal(await preview.textContent(), fullNote);
  assert.equal(await preview.locator('em').count(), 0);
  await back.click();
  assert.equal(await filter.inputValue(), 'saved');
  assert.equal(await record.inputValue(), selected);
  assert.equal(await mark.count(), 0);
  assert.equal(driveRequests.length, before);

  await showSource.click();
  await assertHighlighted(page, sourceLead, source);
  await page.locator('#disconnect').click();
  await notice(page, 'Отключено.');
  assert.equal(await mark.count(), 0);
  assert.equal(await back.isVisible(), false);
  assert.equal(await showSource.isVisible(), false);
  assert.equal(await showAnswer.isVisible(), false);
  assert.doesNotMatch(await preview.textContent(), /Одинаковая мысль|Одинаковый ответ/);
  assert.equal(await page.locator('#thought').inputValue(), draftText);
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(driveRequests.length, before);
  assert.equal(state.patches, 0);
  assert.equal(file.text, original);
});

test('missing and ambiguous replies have no reader action, and switching same-named notes clears the old reader', async t => {
  const {state, page, filter, record, preview, mark, back, showSource, showAnswer} = await setup(t,
    recordBlock({op: missing, text: 'Исходник без сохранённого ответа.'}),
    recordBlock({op: ambiguous, text: 'Исходник с неоднозначным ответом.'}),
    reply(ambiguous, 'Первый неоднозначный ответ.'), reply(ambiguous, 'Второй неоднозначный ответ.'));

  await filter.selectOption('missing');
  assert.equal(await record.inputValue(), missing);
  assert.equal(await showAnswer.isVisible(), false);
  await showSource.click();
  assert.equal(await mark.textContent(), 'Исходник без сохранённого ответа.');
  await back.click();

  await filter.selectOption('ambiguous');
  assert.equal(await record.inputValue(), ambiguous);
  assert.equal(await showAnswer.isVisible(), false);
  await showSource.click();
  assert.equal(await mark.textContent(), 'Исходник с неоднозначным ответом.');
  assert.equal(await back.isVisible(), true);

  const secondNote = 'Текст другой одноимённой заметки.';
  state.files.get('fixture-b').text += secondNote;
  await page.evaluate(() => { pickTest.id = 'fixture-b'; });
  await page.locator('#pick').click();
  await preview.filter({hasText: secondNote}).waitFor();
  assert.equal((await saved(page)).activeId, 'fixture-b');
  assert.equal(await mark.count(), 0);
  assert.equal(await back.isVisible(), false);
  assert.equal(await showSource.isVisible(), false);
  assert.equal(await showAnswer.isVisible(), false);
  assert.doesNotMatch(await preview.textContent(), /Исходник с неоднозначным ответом/);
  await page.locator('#known').selectOption('fixture-a');
  await preview.filter({hasText: 'Исходник с неоднозначным ответом.'}).waitFor();
  assert.equal(await mark.count(), 0);
  assert.equal(await back.isVisible(), false);
  assert.equal(state.patches, 0);
});
