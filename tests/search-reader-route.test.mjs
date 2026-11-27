import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile, releaseLabel, saved} from './browser.mjs';

const live = process.env.MY_DAY_SEARCH_READER_SMOKE === 'live';
const site = 'https://ltstripes.github.io/My-day-/';
let browser;
before(async () => { browser = await chromium.launch(live ? {channel:'chrome'} : {}); });
after(async () => { await browser?.close(); });

async function setup(t) {
  const {ctx, open, state} = await fixture(browser, t, {serviceWorkers:'block', viewport:{width:360,height:800}});
  const name = 'Маршрут.md';
  state.files.set('route-one',{name,text:'# Первая поездка\nПервый маршрут.\n',version:1});
  const selected = {name,text:'---\nmyday_view: plan\n---\n- [ ] Найти ключи\nДругой маршрут.\nЕще один маршрут.\n',version:1};
  state.files.set('route-two',selected);
  let page;
  if (live) {
    await ctx.route(site+'**',route=>route.continue());
    page = await ctx.newPage();
    await page.goto(site);
    await page.getByText(releaseLabel,{exact:true}).waitFor();
  } else page = await open();
  page.setDefaultTimeout(7500);
  await firstFile(page,true);
  await page.locator('#thought').fill('Несвязанный черновик');
  for (const id of ['route-one','route-two']) {
    await page.evaluate(value=>{pickTest.id=value;},id);
    await page.locator('#reader-pick').click();
    await page.locator('#reader-link[href$="='+id+'"]').waitFor();
  }
  const scope = page.locator('#search-file');
  assert.match(await scope.locator('option[value="route-two"]').textContent(),/Маршрут\.md.*route-two/);
  await scope.selectOption('route-two');
  const before = state.mediaReads.length;
  await page.locator('#search-query').fill('маршрут');
  await page.locator('#search-submit').click();
  await page.locator('#search-status').getByText(/Файлов с совпадениями/).waitFor();
  assert.deepEqual(state.mediaReads.slice(before),['route-two']);
  await page.locator('#search-results [data-hit]').nth(1).click();
  await page.locator('#search-detail[data-file-id="route-two"]').waitFor();
  return {page,state,selected};
}

test('a selected search hit opens the exact occurrence and returns to the same result', async t => {
  const {page,state} = await setup(t);
  const draft = (await saved(page)).draft;
  const opener = page.locator('#search-open-reader');
  await opener.focus();
  await opener.press('Enter');
  await page.locator('#reader-find-status').getByText(/2 из 2/).waitFor();
  assert.equal(await page.locator('#reader-select').inputValue(),'route-two');
  assert.equal(await page.locator('#reader-find-query').inputValue(),'маршрут');
  assert.equal(await page.locator('#reader-find-results mark').textContent(),'маршрут');
  assert.equal(new URL(page.url()).hash,'#note-reader');
  const back = page.getByRole('button',{name:'К результату поиска',exact:true});
  await back.click();
  assert.equal(new URL(page.url()).hash,'#search');
  assert.equal(await opener.evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.locator('#search-file').inputValue(),'route-two');
  assert.equal(await page.locator('#search-query').inputValue(),'маршрут');
  assert.deepEqual((await saved(page)).draft,draft);
  assert.equal(state.patches,0);
});

test('an externally changed hit is located in the fresh version, with return to the search query', async t => {
  const {page,state,selected} = await setup(t);
  selected.version++;
  selected.text = '# Новый маршрут.\n';
  await page.locator('#search-open-reader').click();
  await page.locator('#reader-find-status').getByText(/1 из 1/).waitFor();
  assert.match(await page.locator('#reader-find-results').textContent(),/Новый маршрут/);
  assert.doesNotMatch(await page.locator('#reader-find-results').textContent(),/Еще один/);
  await page.getByRole('button',{name:'К результату поиска',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.activeElement.id),'search-query');
  assert.equal(await page.locator('#search-query').inputValue(),'маршрут');
  assert.equal(state.patches,0);
});
