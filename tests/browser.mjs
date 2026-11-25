import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

export const site = 'https://my-day.test/My-day-/';
export const original = '\uFEFF# My Day test\r\n\r\nИсходная строка.\r\n';
const key = 'AIza' + 'p'.repeat(35);
const bearer = 'synthetic-browser-token';
const paths = new Map(['index.html', 'web/app.js', 'web/device.js', 'web/drive.js', 'web/core.js', 'web/day-view.js',
  'web/today.js', 'web/search-match.js', 'web/search-view.js', 'prototype/index.html']
  .map(path => [path, new URL('../' + path, import.meta.url)]));

// The real page calls the public GIS and Picker interfaces. Only these two scripts and the network are replaced.
function fakeIdentity() {
  window.google ??= {};
  window.gis = {prompts: [], grant: true, lifetime: 3600};
  window.google.accounts = {oauth2: {
    hasGrantedAllScopes: (response, scope) => response.scope === scope,
    initTokenClient: config => ({requestAccessToken: ({prompt}) => {
      gis.prompts.push(prompt);
      if (gis.cancel) return config.error_callback({type: 'popup_closed'});
      config.callback({access_token: 'synthetic-browser-token', scope: gis.grant ? config.scope : '', expires_in: gis.lifetime});
    }})
  }};
}
function fakePicker() {
  window.google ??= {};
  window.pickTest = {id: 'fixture-a', opens: 0};
  class View {
    setIncludeFolders() { return this; }
    setSelectFolderEnabled() { return this; }
    setMode() { return this; }
    setQuery(query) { pickTest.query = query; return this; }
  }
  class Builder {
    addView() { return this; }
    setOAuthToken(token) { pickTest.token = token; return this; }
    setDeveloperKey(value) { pickTest.key = value; return this; }
    setAppId(value) { pickTest.project = value; return this; }
    setOrigin(value) { pickTest.origin = value; return this; }
    setCallback(callback) { this.callback = callback; return this; }
    build() { return this; }
    setVisible(visible) {
      if (!visible) return;
      pickTest.opens++;
      this.callback({action: pickTest.id ? 'picked' : 'cancel', docs: [{id: pickTest.id}]});
    }
  }
  google.picker = {DocsView: View, PickerBuilder: Builder, DocsViewMode: {LIST: 'list'}, ViewId: {DOCS: 'docs'},
    Action: {CANCEL: 'cancel', PICKED: 'picked'}, Response: {ACTION: 'action', DOCUMENTS: 'docs'}, Document: {ID: 'id'}};
  window.gapi = {load: (_name, options) => options.callback()};
}
export async function fixture(browser, t, contextOptions = {}) {
  const ctx = await browser.newContext({locale: 'ru-RU', ...contextOptions});
  const state = {calls: [], mediaReads: [], patches: 0, files: new Map(), errors: []};
  for (const id of ['fixture-a', 'fixture-b']) state.files.set(id, {text: original, name: 'My-Day-test.md', version: 1});
  await ctx.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === 'https://my-day.test') {
      let name = url.pathname.slice('/My-day-/'.length);
      if (!name || name.endsWith('/')) name += 'index.html';
      if (!paths.has(name)) return route.fulfill({status: 404});
      return route.fulfill({body: await readFile(paths.get(name)), contentType: name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8'});
    }
    if (url.href === 'https://accounts.google.com/gsi/client') {
      return route.fulfill({body: '(' + fakeIdentity + ')()', contentType: 'text/javascript'});
    }
    if (url.href === 'https://apis.google.com/js/api.js') {
      if (state.pickerDown) return route.abort();
      return route.fulfill({body: '(' + fakePicker + ')()', contentType: 'text/javascript'});
    }
    if (url.origin !== 'https://www.googleapis.com') return route.abort();
    state.calls.push(req.method());
    const headers = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'PATCH, GET, OPTIONS'};
    if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
    assert.equal(req.headers().authorization, 'Bearer ' + bearer);
    const id = url.pathname.split('/').at(-1), file = state.files.get(id);
    if (state.offline || file?.offline) return route.abort();
    const refusal = state.refusal ?? file?.refusal;
    if (refusal) return route.fulfill({status: refusal.status, headers, json: {error: {errors: [{reason: refusal.reason}]}}});
    if (!file) return route.fulfill({status: 404, headers, json: {error: {}}});
    if (req.method() === 'PATCH') {
      state.patches++;
      file.text = req.postDataBuffer().toString('utf8');
      file.version++;
      if (state.loseReply) { state.loseReply = false; return route.abort(); }
      return route.fulfill({headers, json: {id}});
    }
    if (url.searchParams.has('alt')) {
      state.mediaReads.push(id);
      return route.fulfill({headers, body: Buffer.from(file.text), contentType: 'text/markdown'});
    }
    state.onMetadata?.(file);
    return route.fulfill({headers, json: {id, name: file.name, mimeType: 'text/markdown', size: String(Buffer.byteLength(file.text)),
      version: String(file.version), capabilities: {canEdit: file.canEdit ?? true}, trashed: false}});
  });
  ctx.on('page', page => page.on('pageerror', error => state.errors.push(error.message)));
  t.after(async () => { await ctx.close(); assert.deepEqual(state.errors, []); });
  async function open() {
    const page = await ctx.newPage();
    await page.goto(site);
    await page.waitForFunction(() => !document.getElementById('connect').disabled);
    return page;
  }
  return {ctx, state, open};
}
export const notice = (page, text) => page.locator('#status').filter({hasText: text}).waitFor();
export const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('my-day-device-v1')));
export async function firstFile(page, personal = false) {
  if (personal) await page.locator('#remember').check();
  await page.locator('#key').fill(key);
  await page.locator('#connect').click();
  await page.locator('#pick').click();
  await notice(page, 'прочитан из Drive');
  const settings = await page.evaluate(() => [pickTest.key, pickTest.project, pickTest.origin, pickTest.token]);
  assert.deepEqual(settings, [key, '327713401108', new URL(site).origin, bearer]);
}
