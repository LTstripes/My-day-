import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, releaseLabel} from './browser.mjs';

const live = process.env.MY_DAY_ATTENTION_SMOKE === 'live';
let browser;
before(async () => { browser = await chromium.launch(live ? {channel: 'chrome'} : {}); });
after(async () => { await browser?.close(); });

test('Today reads only selected notes, refreshes an inactive date, and drops revoked or forgotten content', async t => {
  const {ctx, state, open} = await fixture(browser, t, {serviceWorkers:'block', timezoneId:'Europe/Moscow'});
  const body = date => '---\nmyday_attention: ' + date + '\n---\nТолько синтетический текст.';
  const file = (name, date) => ({name, text:body(date), version:1, canEdit:false});
  state.files.set('upcoming', file('Забрать образец.md', '2026-11-30'));
  state.files.set('future', file('Следующая встреча.md', '2027-01-30'));
  state.files.set('unused', file('Посторонняя заметка.md', '2026-11-26'));
  let page;
  if (live) {
    const site = 'https://ltstripes.github.io/My-day-/';
    await ctx.route(site + '**', route => route.continue());
    page = await ctx.newPage();
    await page.goto(site);
    await page.getByText(releaseLabel, {exact:true}).waitFor();
  } else page = await open();
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
  assert(!((await panel.textContent()).includes('Забрать образец')));

  await page.locator('#disconnect').click();
  await panel.waitFor({state:'hidden'});
  assert.equal(state.patches, 0);
  assert(!state.mediaReads.includes('unused'));
});
