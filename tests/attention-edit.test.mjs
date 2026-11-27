import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, releaseLabel} from './browser.mjs';

const published = process.env.MY_DAY_ATTENTION_EDIT_SMOKE === 'live';
const site = 'https://ltstripes.github.io/My-day-/';
let browser;
before(async () => { browser = await chromium.launch(published ? {channel:'chrome'} : {}); });
after(async () => { await browser?.close(); });

async function setup(t) {
  const {ctx, state, open} = await fixture(browser, t, {serviceWorkers:'block', timezoneId:'Europe/Moscow', viewport:{width:390,height:800}});
  if (published) await ctx.route(site + '**', route => route.continue());
  const page = published ? await ctx.newPage() : await open();
  if (published) await page.goto(site);
  await page.getByText(releaseLabel, {exact:true}).waitFor();
  await page.clock.setFixedTime(new Date('2026-11-27T08:00:00+03:00'));
  await firstFile(page, true);
  const pick = async (id, file) => {
    state.files.set(id, file);
    await page.evaluate(value => { pickTest.id = value; }, id);
    await page.locator('#reader-pick').click();
    await page.locator('#reader-link[href$="=' + id + '"]').waitFor();
  };
  return {page, state, pick};
}

test('set a date, open the exact note from Today, then remove it without rewriting the body', async t => {
  const {page, state, pick} = await setup(t);
  const original = '---\r\nmyday_view: list\r\n---\r\n# Дневник\r\n- Сверить маршрут\r\n';
  const note = {name:'Дневник.md', text:original, version:1};
  await pick('daily', note);
  await page.locator('#reader-attention summary').click();
  await page.locator('#reader-attention-date').fill('2026-11-27');
  assert.equal(state.patches, 0);
  await page.locator('#reader-attention-save').click();
  await page.locator('#reader-attention-status').getByText('Дата сохранена в заметке.').waitFor();
  assert.equal(state.patches, 1);
  assert.match(note.text, /myday_attention: ["']?2026-11-27/);
  assert.equal(note.text.replace(/^myday_attention:[^\r\n]*\r\n/m, ''), original);
  await pick('also-daily', {name:'Дневник.md', text:'# Другой дневник', version:1});
  const entry = page.locator('#today-attention li').filter({hasText:'Сегодня'});
  assert.equal(await entry.locator('a').getAttribute('href'), 'https://drive.google.com/open?id=daily');
  const open = entry.getByRole('button', {name:/Открыть в заметках/});
  await open.focus();
  await page.keyboard.press('Enter');
  await page.locator('#reader-link[href$="=daily"]').waitFor();
  assert.equal(new URL(page.url()).hash, '#note-reader');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'reader-title');
  await page.locator('#reader-attention summary').click();
  assert.equal(await page.locator('#reader-attention-date').inputValue(), '2026-11-27');
  await page.locator('#reader-attention-clear').click();
  await page.locator('#reader-attention-status').getByText('Дата снята.').waitFor();
  assert.equal(note.text, original);
  assert.equal(state.patches, 2);
  assert.equal(await page.locator('#today-attention').isHidden(), true);
});

test('a precise time remains intact until explicitly changed and concurrent editing wins', async t => {
  const {page, state, pick} = await setup(t);
  const note = {name:'Срок.md', text:'---\nmyday_attention: 2026-11-27T09:00:00+03:00\n---\n# Пример\n', version:1};
  await pick('timed', note);
  await page.locator('#reader-attention summary').click();
  await page.locator('#reader-attention-current').getByText(/Точный срок/).waitFor();
  assert.equal(await page.locator('#reader-attention-date').inputValue(), '');
  assert.equal(await page.locator('#reader-attention-save').isDisabled(), true);
  assert.equal(state.patches, 0);
  note.text += 'Внешняя правка.\n';
  note.version++;
  await page.locator('#reader-attention-date').fill('2026-11-28');
  await page.locator('#reader-attention-save').click();
  await page.locator('#reader-attention-status.error').waitFor();
  assert.equal(note.text.includes('2026-11-27T09:00:00+03:00'), true);
  assert.equal(note.text.endsWith('Внешняя правка.\n'), true);
  assert.equal(state.patches, 0);
  assert.equal(await page.locator('#reader-attention-save').isDisabled(), true);
  await pick('read-only', {name:'Чтение.md', text:'---\nmyday_attention: 2026-11-27\n---\n# Пример\n', version:1, canEdit:false});
  await page.locator('#reader-attention summary').click();
  await page.locator('#reader-attention-hint').getByText(/доступ на редактирование/).waitFor();
  assert.equal(await page.locator('#reader-attention-clear').isDisabled(), true);
});
