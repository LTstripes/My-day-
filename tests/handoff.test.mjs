import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, notice, original, saved, site} from './browser.mjs';
import {recordBlock} from '../web/core.js';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const older = {op: '12345678-abcd-4abc-8abc-123456789abc', text: 'Содержимое старой мысли'};
const other = {op: '23456789-abcd-4abc-8abc-234567890abc', text: 'Параграф другой заметки'};
const newest = {op: '34567890-abcd-4abc-8abc-345678901abc', text: 'Новая мысль из Drive'};
const privateText = 'Не переносить тело записи в команду';
const answerBlock = (record, text) => '\n<!-- my-day:assistant:' + record.op + ' -->\n' + text + '\n';

async function openCommand(page) {
  await page.locator('#handoff-open').click();
  const field = page.locator('#handoff-command');
  await field.waitFor();
  assert.equal(await field.evaluate(element => element.readOnly), true);
  return field.inputValue();
}

function assertRecord(command, fileId, op) {
  assert.match(command, new RegExp('(?<![\\w-])' + fileId + '(?![\\w-])'));
  assert(command.includes('<!-- my-day:' + op + ' -->'));
  assert(command.includes('<!-- my-day:assistant:' + op + ' -->'));
}

test('handoff copies references to the latest saved record in the active same-name file', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  const first = state.files.get('fixture-a');
  const second = state.files.get('fixture-b');
  first.text += '\n' + recordBlock(older);
  second.text += '\n' + recordBlock(other);
  const previousFirstText = first.text;
  const previousSecondText = second.text;
  await ctx.addInitScript(() => {
    window.handoffClipboard = [];
    Object.defineProperty(navigator, 'clipboard', {value: {
      async writeText(text) { window.handoffClipboard.push(text); }
    }});
  });
  const page = await open();
  await firstFile(page, true);
  await page.evaluate(() => { pickTest.id = 'fixture-b'; });
  await page.locator('#pick').click();
  await page.locator('#preview').filter({hasText: other.text}).waitFor();
  assertRecord(await openCommand(page), 'fixture-b', other.op);
  await page.locator('#known').selectOption('fixture-a');
  await notice(page, 'актуальное содержимое');
  assertRecord(await openCommand(page), 'fixture-a', older.op);

  await page.locator('#thought').fill(privateText);
  await page.locator('#save').click();
  await notice(page, 'подтверждено повторным чтением');
  const latest = first.text.match(/<!-- my-day:([\da-f-]+) -->\nНе переносить тело записи в команду\n/);
  assert(latest);
  assert(first.text.startsWith(previousFirstText));
  assert.equal(second.text, previousSecondText);
  assert.equal(state.patches, 1);
  assert.equal((await saved(page)).draft, null);
  assert.equal(await page.locator('#handoff-details').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.handoffClipboard), []);

  const requests = [];
  page.on('request', request => requests.push(request.url()));
  const command = await openCommand(page);
  const key = await page.locator('#key').inputValue();
  assertRecord(command, 'fixture-a', latest[1]);
  for (const excluded of [older.op, other.op, 'fixture-b', older.text, other.text, privateText, key, 'synthetic-browser-token']) {
    assert(!command.includes(excluded), 'Command includes data outside the selected record references');
  }
  await page.locator('#handoff-copy').click();
  await page.locator('#handoff-status').filter({hasText: /скопирован/i}).waitFor();
  assert.deepEqual(await page.evaluate(() => window.handoffClipboard), [command]);
  assert.deepEqual(requests, []);
  assert.equal(page.url(), site);
  assert.equal(ctx.pages().length, 1);
  assert.equal(state.patches, 1);
  assert(!JSON.stringify(await saved(page)).includes(latest[1]));
});

test('choosing an older record keeps its verified answer through refresh and a save selects the new record', async t => {
  const {open, state} = await fixture(browser, t, {viewport: {width: 375, height: 812}});
  const file = state.files.get('fixture-a');
  file.text += '\n' + recordBlock(older) + '\n' + recordBlock(other);
  const page = await open();
  await firstFile(page, true);
  const select = page.getByLabel('Сохранённая запись');
  const answerState = page.locator('#handoff-result-state');
  const answer = page.locator('#handoff-result');
  const command = page.locator('#handoff-command');
  assert.equal(await select.inputValue(), other.op);
  const labels = await select.locator('option').allTextContents();
  assert.deepEqual(labels, ['Последняя · ' + other.text, '2 · ' + older.text]);
  assert(await select.evaluate(element => element.getBoundingClientRect().right <= window.innerWidth));

  const refresh = async () => {
    file.version++;
    await page.locator('#refresh').click();
    await notice(page, 'актуальное содержимое');
  };
  file.text += '\n' + recordBlock(newest);
  await refresh();
  assert.equal(await select.inputValue(), newest.op);
  await select.selectOption(older.op);
  assert.equal(await answerState.textContent(), 'Ответа в Drive пока нет.');
  assertRecord(await openCommand(page), 'fixture-a', older.op);
  await page.locator('#thought').fill(privateText);
  const draft = (await saved(page)).draft;
  file.text += answerBlock(older, 'Разбор старой мысли.\nВторая строка разбора.') +
    answerBlock(newest, 'Разбор новой мысли.');
  await refresh();
  assert.equal(await select.inputValue(), older.op);
  assert.equal(await answerState.textContent(), 'Ответ сохранён в Drive.');
  assert.equal(await answer.textContent(), 'Разбор старой мысли.');
  assert.equal(await command.inputValue(), '');
  assert.equal(await page.locator('#thought').inputValue(), privateText);
  assert.deepEqual((await saved(page)).draft, draft);
  assert.equal(state.patches, 0);
  assert(!JSON.stringify(await saved(page)).includes(older.op));

  await page.locator('#save').click();
  await notice(page, 'подтверждено повторным чтением');
  const savedOp = file.text.match(/<!-- my-day:([\da-f-]+) -->\nНе переносить тело записи в команду\n/)?.[1];
  assert(savedOp);
  assert.equal(await select.inputValue(), savedOp);
  assert.equal(await answerState.textContent(), 'Ответа в Drive пока нет.');
  assert.equal(await answer.textContent(), '');
  assertRecord(await openCommand(page), 'fixture-a', savedOp);
  assert.equal((await saved(page)).draft, null);
  assert.equal(state.patches, 1);
});

test('ambiguous answers and deferred clipboard results cannot leak into a different selection', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  const file = state.files.get('fixture-a');
  file.text += '\n' + recordBlock(older) + '\n' + recordBlock(other) + '\n' + recordBlock(newest) +
    answerBlock(older, 'Первый спорный текст.') + answerBlock(older, 'Второй спорный текст.');
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {value: {
      writeText(text) {
        window.handoffClipboardText = text;
        return new Promise((_resolve, reject) => { window.rejectHandoffCopy = reject; });
      }
    }});
  });
  const page = await open();
  await firstFile(page, true);
  const select = page.locator('#handoff-record');
  const answerState = page.locator('#handoff-result-state');
  const answer = page.locator('#handoff-result');
  const status = page.locator('#handoff-status');
  const latestCommand = await openCommand(page);
  await page.locator('#handoff-copy').click();
  assert.equal(await page.evaluate(() => window.handoffClipboardText), latestCommand);

  await select.selectOption(older.op);
  assert.match(await answerState.textContent(), /не удалось однозначно подтвердить/);
  assert.equal(await answer.textContent(), '');
  assert.equal(await page.locator('#handoff-open').isDisabled(), true);
  await select.selectOption(other.op);
  assert.equal(await answerState.textContent(), 'Ответа в Drive пока нет.');
  const selectedCommand = await openCommand(page);
  assertRecord(selectedCommand, 'fixture-a', other.op);
  await page.evaluate(() => window.rejectHandoffCopy(new Error('Clipboard denied')));
  assert.equal(await status.textContent(), '');
  assert.equal(await page.locator('#handoff-command').evaluate(element => element === document.activeElement), false);

  file.text += answerBlock(other, 'Актуальный ответ.');
  file.version++;
  await page.locator('#search-query').fill(other.text);
  await page.locator('#search-submit').click();
  await page.locator('#search-results [data-file-id="fixture-a"] [data-hit]').first().waitFor();
  assert.equal(await page.locator('#handoff').isVisible(), false);
  assert.deepEqual(await select.locator('option').allTextContents(), []);
  assert.equal(await answerState.textContent(), '');
  assert.equal(await page.locator('#handoff-command').inputValue(), '');

  await page.locator('#refresh').click();
  await notice(page, 'актуальное содержимое');
  await select.selectOption(other.op);
  assert.equal(await answer.textContent(), 'Актуальный ответ.');
  assertRecord(await openCommand(page), 'fixture-a', other.op);
  const second = await open();
  assert.equal(await second.locator('#handoff').isVisible(), false);
  await second.locator('#connect').click();
  await notice(second, 'актуальное содержимое');
  assert.equal(await second.locator('#handoff-record').inputValue(), newest.op);
  await second.locator('#disconnect').click();
  await notice(page, 'завершено в другой вкладке');
  assert.deepEqual(await select.locator('option').allTextContents(), []);
  assert.equal(await answer.textContent(), '');
  assert.equal(await page.locator('#handoff-command').inputValue(), '');
  assert.equal(state.patches, 0);
});

test('an interrupted save exposes a command only after Drive confirms the record and supports manual copy', async t => {
  const {ctx, open, state} = await fixture(browser, t);
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {value: {
      async writeText() { throw new DOMException('Clipboard access denied', 'NotAllowedError'); }
    }});
  });
  const page = await open();
  assert.equal(await page.locator('#handoff').isVisible(), false);
  await firstFile(page, true);
  await page.locator('#thought').fill(privateText);
  assert.equal(await page.locator('#handoff').isVisible(), false);
  state.offline = true;
  await page.locator('#save').click();
  await notice(page, 'Проверь интернет');
  const pending = (await saved(page)).draft;
  assert(pending.op);
  assert.equal(await page.locator('#handoff').isVisible(), false);

  state.offline = false;
  state.loseReply = true;
  await page.locator('#save').click();
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  assert.equal(state.patches, 1);
  assert.deepEqual((await saved(page)).draft, pending);
  assert.equal(await page.locator('#handoff').isVisible(), false);
  await page.locator('#refresh').click();
  await notice(page, 'Доставка подтверждена без дубля');
  assert.equal((await saved(page)).draft, null);
  const command = await openCommand(page);
  assertRecord(command, pending.fileId, pending.op);
  assert(!command.includes(privateText));
  await page.locator('#handoff-copy').click();
  await page.locator('#handoff-status').filter({hasText: /вручную|Ctrl\+C/i}).waitFor();
  assert.deepEqual(await page.locator('#handoff-command').evaluate(field => [
    document.activeElement === field, field.selectionStart, field.selectionEnd
  ]), [true, 0, command.length]);
  assert.equal(state.patches, 1);
});

test('examples and an existing assistant result do not redirect handoff, and duplicate source markers block it', async t => {
  const {open, state} = await fixture(browser, t);
  const file = state.files.get('fixture-a');
  file.text = original + '\r\n' + recordBlock(older).replaceAll('\n', '\r\n') +
    '\r\n<!-- my-day:assistant:' + older.op + ' -->\r\nУже сохранённый разбор\r\n' +
    '\r\n```markdown\r\n' + recordBlock(other).replaceAll('\n', '\r\n') + '```\r\n';
  const page = await open();
  await firstFile(page);
  const command = await openCommand(page);
  assertRecord(command, 'fixture-a', older.op);
  assert(!command.includes(other.op));
  assert(!command.includes('Уже сохранённый разбор'));
  file.text += '\r\n' + recordBlock(older);
  file.version++;
  await page.locator('#refresh').click();
  await notice(page, 'актуальное содержимое');
  assert.equal(await page.locator('#handoff').isVisible(), false);
  assert.equal(await page.locator('#handoff-command').inputValue(), '');
  assert.equal(state.patches, 0);
});

test('handoff does not redirect a draft via search and clears on read-only files and loss of access', async t => {
  const {open, state} = await fixture(browser, t);
  const first = state.files.get('fixture-a');
  first.text += '\n' + recordBlock(older);
  state.files.get('fixture-b').text += '\n' + recordBlock(other);
  state.files.set('focus', {name: 'Now.md', text: '# Now\n\n' + recordBlock(other), version: 1, canEdit: false});
  const page = await open();
  await firstFile(page, true);
  await page.evaluate(() => { pickTest.id = 'fixture-b'; });
  await page.locator('#pick').click();
  await page.locator('#preview').filter({hasText: other.text}).waitFor();
  await page.evaluate(() => { pickTest.id = 'focus'; });
  await page.locator('#pick').click();
  await page.locator('#preview-title').filter({hasText: 'только чтение'}).waitFor();
  assert.equal(await page.locator('#handoff').isVisible(), false);
  await page.locator('#known').selectOption('fixture-a');
  await notice(page, 'актуальное содержимое');
  await page.locator('#thought').fill(privateText);
  const savedDraft = (await saved(page)).draft;
  await page.locator('#search-query').fill(other.text);
  await page.locator('#search-submit').click();
  await page.locator('#search-results [data-file-id="fixture-b"] [data-hit]').first().click();
  await page.locator('#search-detail').waitFor();
  assert.equal(await page.locator('#thought').inputValue(), privateText);
  assert.equal(await page.locator('#known').inputValue(), 'fixture-a');
  const command = await openCommand(page);
  assertRecord(command, 'fixture-a', older.op);
  assert(!command.includes(other.op));
  assert(!command.includes(privateText));

  first.refusal = {status: 403, reason: 'appNotAuthorizedToFile'};
  await page.locator('#refresh').click();
  await notice(page, 'HTTP 403');
  assert.equal(await page.locator('#handoff').isVisible(), false);
  assert.equal(await page.locator('#handoff-command').inputValue(), '');
  delete first.refusal;
  await page.locator('#refresh').click();
  await notice(page, 'актуальное содержимое');
  assert.equal(await openCommand(page), command);

  await page.locator('#disconnect').click();
  assert.equal(await page.locator('#handoff').isVisible(), false);
  assert.equal(await page.locator('#handoff-command').inputValue(), '');
  await page.reload();
  assert.equal(await page.locator('#handoff').isVisible(), false);
  assert.equal(await page.locator('#handoff-command').inputValue(), '');
  assert.deepEqual((await saved(page)).draft, savedDraft);
  await page.locator('#connect').click();
  await notice(page, 'актуальное содержимое');
  assert.equal(await openCommand(page), command);
  assert.deepEqual((await saved(page)).draft, savedDraft);
  assert.equal(state.patches, 0);
});
