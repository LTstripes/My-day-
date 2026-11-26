import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright-core';
import {fixture, firstFile} from './browser.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function sharedSource(t) {
  const {ctx, open, state} = await fixture(browser, t);
  const page = await open();
  const file = state.files.get('fixture-a');
  file.name = 'Мысли.md';
  file.text = '- [ ] Приватный тестовый пункт';
  await firstFile(page, true);
  await page.locator('#reader-select').selectOption('fixture-a');
  await page.locator('#reader-content').filter({hasText: 'Приватный тестовый пункт'}).waitFor();
  await page.locator('#plan-pick').click();
  await page.locator('#plan-action').filter({hasText: 'Приватный тестовый пункт'}).waitFor();
  await page.locator('#disconnect').click();
  return {ctx, page, state, file};
}

test('one real file access denial suppresses delayed successes from other roles until the next refresh', async t => {
  const {ctx, page, state} = await sharedSource(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const path = '**/drive/v3/files/fixture-a?alt=media';
  await ctx.route(path, async route => {
    requests++;
    if (requests === 1) {
      await route.fulfill({status: 403, headers: {'Access-Control-Allow-Origin': '*'}, json: {
        error: {errors: [{reason: 'insufficientFilePermissions'}]}
      }});
    } else {
      await held;
      await route.fallback();
    }
  });
  try {
    await page.locator('#connect').click();
    await page.locator('#reader-state').filter({hasText: '403'}).waitFor();
  } finally { release(); }
  await page.waitForFunction(() => !document.querySelector('#reader-refresh').disabled);
  assert.equal(await page.locator('#reader-content').textContent(), '');
  assert.equal(await page.locator('#reader-link').getAttribute('href'), null);
  assert.equal(await page.locator('#plan-action').textContent(), '');
  assert.equal(await page.locator('#plan-link').getAttribute('href'), null);
  assert.doesNotMatch(await page.locator('#preview').textContent(), /Приватный/);
  await ctx.unroute(path);
  await page.locator('#reader-refresh').click();
  await page.locator('#reader-content').filter({hasText: 'Приватный тестовый пункт'}).waitFor();
  assert.equal(state.patches, 0);
});

test('loss of edit permission retains the readable Inbox in its independent reader', async t => {
  const {file, page, state} = await sharedSource(t);
  file.canEdit = false;
  await page.locator('#connect').click();
  await page.locator('#reader-content').filter({hasText: 'Приватный тестовый пункт'}).waitFor();
  await page.waitForFunction(() => !document.querySelector('#reader-refresh').disabled);
  assert.equal(await page.locator('#save').isDisabled(), true);
  assert.equal(await page.locator('#reader-link').getAttribute('href'), 'https://drive.google.com/open?id=fixture-a');
  assert.equal(state.patches, 0);
});
