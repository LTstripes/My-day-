import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, releaseLabel} from './browser.mjs';

const live = process.env.MY_DAY_ATTENTION_SMOKE === 'live';
let browser;
before(async () => { browser = await chromium.launch(live ? {channel: 'chrome'} : {}); });
after(async () => { await browser?.close(); });

async function openAttentionPage(ctx, open) {
  if (!live) return open();
  const site = 'https://ltstripes.github.io/My-day-/';
  await ctx.route(site + '**', route => route.continue());
  const page = await ctx.newPage();
  await page.goto(site);
  await page.getByText(releaseLabel, {exact:true}).waitFor();
  return page;
}

test('Today reads only selected notes, refreshes an inactive date, and drops revoked or forgotten content', async t => {
  const {ctx, state, open} = await fixture(browser, t, {serviceWorkers:'block', timezoneId:'Europe/Moscow'});
  const body = date => '---\nmyday_attention: ' + date + '\n---\nТолько синтетический текст.';
  const file = (name, date) => ({name, text:body(date), version:1, canEdit:false});
  state.files.set('upcoming', file('Забрать образец.md', '2026-11-30'));
  state.files.set('future', file('Следующая встреча.md', '2027-01-30'));
  state.files.set('unused', file('Посторонняя заметка.md', '2026-11-26'));
  const page = await openAttentionPage(ctx, open);
  page.setDefaultTimeout(6500);
  await page.clock.setFixedTime(new Date('2026-11-26T15:00:00Z'));
  await firstFile(page, true);
  const panel = page.locator('#today-attention');
  const entry = panel.locator('li').filter({hasText:'Забрать образец.md'});
  for (const id of ['upcoming', 'future']) {
    await page.evaluate(key => { pickTest.id = key; }, id);
    await page.locator('#reader-pick').click();
    await page.waitForFunction(id => document.querySelector('#reader-select').value === id, id);
  }
  await entry.filter({hasText:'Скоро'}).waitFor();
  assert.equal(await entry.locator('time').getAttribute('datetime'), '2026-11-30');
  assert.equal(await entry.locator('a').getAttribute('href'), 'https://drive.google.com/open?id=upcoming');
  assert.equal(await panel.locator('li').count(), 1);

  const other = state.files.get('upcoming');
  other.text = body('2026-11-26');
  other.version++;
  const from = state.mediaReads.length;
  await page.locator('#today-refresh').click();
  await entry.filter({hasText:'Сегодня'}).waitFor();
  assert.equal(state.mediaReads.slice(from).filter(id => id === 'upcoming').length, 1);
  other.refusal = {status:403, reason:'insufficientFilePermissions'};
  await page.locator('#today-refresh').click();
  await panel.getByRole('status').filter({hasText:'недоступна'}).waitFor();
  assert.equal(await panel.locator('a').count(), 0);
  assert.equal(await panel.getByRole('button').count(), 0);
  assert(!((await panel.textContent()).includes('Забрать образец')));

  await page.locator('#disconnect').click();
  await panel.waitFor({state:'hidden'});
  assert.equal(state.patches, 0);
  assert(!state.mediaReads.includes('unused'));
});

test('attention orders overdue dates first and opens the selected namesake by id', async t => {
  const {open} = await fixture(browser, t, {serviceWorkers:'block', timezoneId:'Europe/Moscow'});
  const page = await open();
  await page.clock.setFixedTime(new Date('2026-11-26T15:00:00Z'));
  const name = 'Отчёт <пример>.md';
  const times = ['2026-11-27', '2026-11-26T23:00+03:00', '2026-11-26',
    '2026-11-26T12:00+03:00', '2026-11-26T02:00+03:00', '2026-11-25'];
  await page.evaluate(async ({name, times}) => {
    const {initAttention} = await import('./web/attention.js');
    const panel = document.querySelector('#today-attention').cloneNode(true);
    panel.id = 'sample-attention';
    document.querySelector('main').append(panel);
    const attention = initAttention(panel, id => { panel.dataset.opened = id; });
    const notes = times.map((_, index) => ({id:'note-' + index, name}));
    attention.setSources(notes);
    times.forEach((time, index) => attention.show({meta:notes[index], content:'---\nmyday_attention: ' + time + '\n---'}));
  }, {name,times});
  const panel = page.locator('#sample-attention');
  assert.deepEqual(await panel.locator('time').evaluateAll(nodes => nodes.map(node => node.dateTime)), [...times].reverse());
  const row = panel.locator('li').filter({has:page.locator('time[datetime="2026-11-26T02:00+03:00"]')});
  const link = row.getByRole('link', {name:'Открыть в Drive: ' + name, exact:true});
  assert.equal(await link.getAttribute('href'), 'https://drive.google.com/open?id=note-4');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  const button = row.getByRole('button', {name:'Открыть в заметках: ' + name, exact:true});
  await button.focus();
  await button.press('Enter');
  assert.equal(await panel.getAttribute('data-opened'), 'note-4');
});

test('attention filters locally, keeps the chosen group across refresh and midnight, and resets after disconnect', async t => {
  const {ctx, state, open} = await fixture(browser, t, {serviceWorkers:'block', timezoneId:'Europe/Moscow'});
  const text = day => '---\nmyday_attention: ' + day + '\n---\nТестовый маршрут.';
  state.files.set('west', {name:'Маршрут.md', text:text('2026-11-25'), version:1});
  state.files.set('east', {name:'Маршрут.md', text:text('2026-11-26'), version:1});
  const page = await openAttentionPage(ctx, open);
  page.setDefaultTimeout(6500);
  await page.clock.setFixedTime(new Date('2026-11-26T15:00:00Z'));
  await firstFile(page, true);
  for (const id of ['east', 'west']) {
    await page.evaluate(id => { pickTest.id = id; }, id);
    await page.locator('#reader-pick').click();
    await page.locator('#reader-link[href$="=' + id + '"]').waitFor();
  }
  const panel = page.locator('#today-attention');
  const filter = panel.getByLabel('Показать'), empty = panel.locator('#today-attention-empty');
  const ids = () => panel.locator('button[data-file-id]').evaluateAll(buttons => buttons.map(item => item.dataset.fileId));
  let requests = state.calls.length;
  assert.deepEqual(await ids(), ['west', 'east']);
  await filter.selectOption('overdue');
  assert.deepEqual(await ids(), ['west']);
  await filter.selectOption('soon');
  await empty.filter({hasText:'Скоро'}).waitFor();
  assert(await filter.isVisible());
  assert.deepEqual(await ids(), []);
  await filter.selectOption('today');
  assert.deepEqual(await ids(), ['east']);
  assert(await empty.isHidden());
  assert.equal(state.calls.length, requests);

  await panel.getByRole('button', {name:/Перенести/}).click();
  await page.locator('#reader-link[href$="=east"]').waitFor();
  await page.locator('#reader-attention-date:focus').waitFor();
  await page.locator('#reader-back').press('Enter');
  assert(await panel.locator('[data-reschedule-id="east"]').evaluate(el => el === document.activeElement));

  const east = state.files.get('east');
  east.text = text('2026-11-27');
  east.version++;
  await page.locator('#today-refresh').click();
  await page.waitForFunction(() => !document.getElementById('today-refresh').disabled);
  await empty.filter({hasText:'Сегодня'}).waitFor();
  assert.equal(await filter.inputValue(), 'today');
  requests = state.calls.length;
  await page.clock.setFixedTime(new Date('2026-11-27T15:00:00Z'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.deepEqual(await ids(), ['east']);
  assert(await empty.isHidden());
  await filter.selectOption('');
  assert.deepEqual(await ids(), ['west', 'east']);
  await filter.selectOption('overdue');
  assert.equal(state.calls.length, requests);
  await ctx.setOffline(true);
  await panel.waitFor({state:'hidden'});
  assert.equal(await filter.inputValue(), 'overdue');
  await ctx.setOffline(false);
  await page.locator('#disconnect').click();
  await panel.waitFor({state:'hidden'});
  assert.equal(await filter.inputValue(), '');
  assert.equal(state.patches, 0);
});
