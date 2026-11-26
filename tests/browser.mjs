import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';

export const site = 'https://my-day.test/My-day-/';
export const releaseLabel = 'My Day · ' + JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
export const original = '\uFEFF# My Day test\r\n\r\nИсходная строка.\r\n';
const key = 'AIza' + 'p'.repeat(35);
const bearer = 'synthetic-browser-token';
const paths = new Map(['index.html', 'web/app.js', 'web/note-reader.js', 'web/note-views.js', 'web/device.js', 'web/drive.js', 'web/core.js', 'web/day-view.js',
  'web/today.js', 'web/task-entry.js', 'web/complete-task.js', 'web/search-match.js', 'web/search-view.js', 'web/handoff.js', 'web/reload.js', 'prototype/index.html',
  'web/save-view.js', 'web/conditional-write.js', 'web/note-properties.js', 'web/note-chart.js', 'web/attention.js']
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
export async function fixture(browser, t, contextOptions = {}, liveWorker = false) {
  const ctx = await browser.newContext({locale: 'ru-RU', ...contextOptions});
  let appUrl = site;
  if (liveWorker) {
    // Chromium downloads worker scripts itself, outside Playwright's page routes.
    const script = await readFile(new URL('../reload-worker.js', import.meta.url));
    const server = createServer(async (request, response) => {
      const name = new URL(request.url, site).pathname.slice('/My-day-/'.length) || 'index.html';
      if (name === 'reload-worker.js') {
        response.writeHead(200, {'Content-Type': 'text/javascript'});
        response.end(script);
      } else if (paths.has(name)) {
        response.writeHead(200, {'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8'});
        response.end(await readFile(paths.get(name)));
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    appUrl = 'http://127.0.0.1:' + server.address().port + '/My-day-/';
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  }
  const state = {calls: [], mediaReads: [], patches: 0, files: new Map(), errors: []};
  for (const id of ['fixture-a', 'fixture-b']) state.files.set(id, {text: original, name: 'My-Day-test.md', version: 1});
  await ctx.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(appUrl).origin) {
      if (liveWorker) return route.continue();
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
    const headers = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'PATCH, PUT, GET, OPTIONS'};
    if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
    assert.equal(req.headers().authorization, 'Bearer ' + bearer);
    const id = url.pathname.split('/').at(-1), file = state.files.get(id);
    if (state.offline || file?.offline) return route.abort();
    const refusal = state.refusal ?? file?.refusal;
    if (refusal) return route.fulfill({status: refusal.status, headers, json: {error: {errors: [{reason: refusal.reason}]}}});
    if (!file) return route.fulfill({status: 404, headers, json: {error: {}}});
    const etag = () => '"fixture-v' + file.version + '"';
    if (url.pathname.startsWith('/drive/v2/files/')) {
      return route.fulfill({headers, json: {id, version: String(file.version), etag: etag()}});
    }
    if (req.method() === 'PUT') {
      assert.equal(url.pathname, '/upload/drive/v2/files/' + id);
      assert.equal(url.searchParams.get('uploadType'), 'media');
      state.beforeTaskWrite?.(file);
      if (req.headers()['if-match'] !== etag()) return route.fulfill({status: 412, headers, json: {error: {}}});
    }
    if (req.method() === 'PATCH' || req.method() === 'PUT') {
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
    await page.goto(appUrl);
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
  assert.deepEqual(settings, [key, '327713401108', new URL(page.url()).origin, bearer]);
}
