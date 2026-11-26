import assert from 'node:assert/strict';
import {test} from 'node:test';
import {newDevice, preferredFile, readDevice, withoutSource} from '../web/device.js';
import {INBOX, NOW, TASKS, TEST_FILE} from '../web/core.js';
import {markdownSnapshot, saveDraft, snapshot, SnapshotVersionChanged} from '../web/drive.js';

const restore = data => readDevice(JSON.stringify(data));
const op = '95f765b1-9b03-4bdd-8694-38169d401772';

test('reader choices round-trip by ID without changing either draft, existing roles or plans', () => {
  const profile = {...newDevice(), fileIds: ['old', 'inbox', 'tasks'],
    noteNames: {inbox: INBOX, tasks: TASKS}, activeId: 'inbox',
    preferredIds: {[TASKS]: 'tasks'}, plans: [{id: 'route', name: 'Маршрут.md'}],
    pinnedPlanId: 'route', draft: {fileId: 'inbox', text: 'Мысль', op: null},
    taskDraft: {fileId: 'tasks', text: 'Дело', op, version: '7', date: '2026-11-26', place: 'end'},
    notes: [{id: 'a', name: 'Книги.md'}, {id: 'b', name: 'Книги.md'}, {id: 'ordinary', name: NOW},
      {id: 'route', name: 'Маршрут.md'}], readerId: 'b'};
  const device = restore(profile);
  assert.deepEqual(device.notes, profile.notes);
  assert.equal(device.readerId, 'b');
  assert.deepEqual(device.draft, profile.draft);
  assert.deepEqual(device.taskDraft, profile.taskDraft);
  assert.equal(device.activeId, 'inbox');
  assert.equal(device.pinnedPlanId, 'route');
  assert.equal(device.noteNames.old, TEST_FILE);
  assert.equal(preferredFile(device, NOW), null);
  assert.strictEqual(withoutSource(device, 'inbox'), device);
  assert.strictEqual(withoutSource(device, 'tasks'), device);
  const withoutPlan = withoutSource(device, 'route');
  assert(!withoutPlan.notes.some(note => note.id === 'route'));
  assert.equal(withoutPlan.plan, undefined);
  assert.equal(withoutSource(withoutPlan, 'b').readerId, 'a');
});

test('older named Markdown sources retain their name without becoming a writer or a plan', () => {
  const old = {version: 1, fileIds: ['old-test', 'other', 'guide', 'bad'],
    noteNames: {other: 'Дневник.md', guide: 'Справка.MD', bad: 'broken.pdf'}, activeId: 'guide'};
  const device = restore(old);
  assert.deepEqual(device.fileIds, ['old-test']);
  assert.equal(device.noteNames['old-test'], TEST_FILE);
  assert.deepEqual(device.notes, [{id: 'other', name: 'Дневник.md'}, {id: 'guide', name: 'Справка.MD'}]);
  assert.equal(device.readerId, 'guide');
  assert.equal(device.plan, undefined);
  assert.equal(device.activeId, 'old-test');
  assert.deepEqual(restore(device), device);
  const removed = withoutSource(withoutSource(device, 'guide'), 'other');
  assert(!removed.readerId);
  assert(!removed.notes?.length);
});

test('reader storage retains only source identities, including equal filenames with different IDs', () => {
  const device = restore({...newDevice(), notes: [{id: 'same', name: 'Черновое имя.md'},
    {id: 'same', name: 'Книга.md', content: 'Личная строка', view: 'list'},
    {id: 'other', name: 'Книга.md'}, {id: 'bad/id', name: 'Ещё.md'}, {id: 'pdf', name: 'Ещё.pdf'}],
    readerId: 'missing'});
  assert.deepEqual(device.notes, [{id: 'same', name: 'Книга.md'}, {id: 'other', name: 'Книга.md'}]);
  assert.equal(device.readerId, 'same');
  assert.equal(device.activeId, null);
  assert.deepEqual(device.fileIds, []);
});

function readFile(name, content, {before = {}, after = {}} = {}) {
  const meta = {id: 'chosen', name, version: '1', size: '48', capabilities: {canEdit: false},
    mimeType: 'text/markdown'};
  const calls = [];
  const request = async (url, options) => {
    assert.equal(options?.method ?? 'GET', 'GET');
    const target = new URL(url);
    assert.equal(target.pathname, '/drive/v3/files/chosen');
    if (target.searchParams.get('alt') === 'media') {
      calls.push('media');
      return new Response(content);
    }
    const changes = calls.length ? after : before;
    calls.push('meta');
    return Response.json({...meta, ...changes});
  };
  return {request, calls};
}

test('arbitrary read-only Markdown uses the same ID before and after reading, and preserves source bytes', async () => {
  const content = '\uFEFF---\r\nmyday_view: list\r\n---\r\n- [ ] Пункт\r\n';
  const file = readFile('Книги.MD', content);
  const result = await markdownSnapshot('chosen', file.request, 'Книги.MD');
  assert.equal(result.content, content);
  assert.equal(result.meta.id, 'chosen');
  await assert.rejects(saveDraft({fileId: 'chosen', op, text: 'Мысль'}, file.request, result.meta.name), /только для чтения/);
  assert.deepEqual(file.calls, ['meta', 'media', 'meta']);
});

test('metadata changes, malformed UTF-8 and native documents fail closed on a generic read', async () => {
  const inputs = [
    [readFile('Список.txt', 'text'), /\.md/],
    [readFile('Список.md', '', {before: {mimeType: 'application/vnd.google-apps.document'}}), /Markdown/],
    [readFile('Список.md', '', {before: {trashed: true}}), /Markdown/],
    [readFile('Список.md', '', {before: {id: 'different'}}), /Markdown/],
    [readFile('Список.md', '', {before: {size: '500001'}}), /500/],
    [readFile('Список.md', new Uint8Array([0xff])), /UTF-8/],
    [readFile('Список.md', '', {after: {version: '2'}}), SnapshotVersionChanged],
    [readFile('Список.md', '', {after: {name: 'Новый.md'}}), /Имя выбранного файла изменилось/],
  ];
  for (const [file, error] of inputs) await assert.rejects(markdownSnapshot('chosen', file.request), error);
});

test('reading a template name in the generic reader does not bypass the template writer guard', async () => {
  const content = '---\nmyday_view: text\n---\n# My Day test\n';
  const generic = readFile(TEST_FILE, content);
  assert.equal((await markdownSnapshot('chosen', generic.request)).content, content);
  const writer = readFile(TEST_FILE, content, {before: {capabilities: {canEdit: true}}, after: {capabilities: {canEdit: true}}});
  await assert.rejects(snapshot('chosen', writer.request, TEST_FILE), /первой проверки/);
  await assert.rejects(saveDraft({fileId: 'chosen', text: 'Мысль', op}, writer.request, TEST_FILE), /первой проверки/);
});
