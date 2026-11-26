import assert from 'node:assert/strict';
import {test} from 'node:test';
import {completeTask} from '../web/complete-task.js';

const original = '\uFEFF# To Do now\r\n## Сегодня\n- Купить чай\r\n  + [ ] Полить ёлку <!-- сад -->\r- [ ] Вторая\n';
const finished = original.replace('+ [ ]', '+ [x]');
const selection = {fileId: 'synthetic-tasks', line: 3, date: '2026-11-26', content: original};

function fixture() {
  const state = {content: original, version: 7, name: 'To Do now.md', canEdit: true, writes: 0};
  const id = selection.fileId;
  async function request(url, options) {
    const path = new URL(url);
    assert.equal(path.hostname, 'www.googleapis.com');
    assert.equal(path.pathname.split('/').at(-1), id);
    if (options?.method) {
      assert.equal(options.method, 'PUT');
      assert.equal(path.pathname, '/upload/drive/v2/files/' + id);
      assert.equal(path.searchParams.get('uploadType'), 'media');
      assert.equal(options.headers['Content-Type'], 'text/markdown');
      state.beforeWrite?.();
      if (options.headers['If-Match'] !== '"tag-' + state.version + '"') {
        throw Object.assign(new Error('Precondition Failed'), {httpStatus: 412});
      }
      if (state.refuseWrite) throw Object.assign(new Error('Forbidden'), {httpStatus: 403});
      state.content = new TextDecoder('utf-8', {ignoreBOM: true}).decode(options.body);
      state.writes++;
      state.version++;
      state.afterWrite?.();
      return Response.json({});
    }
    if (path.pathname === '/drive/v2/files/' + id) {
      return Response.json({id, version: String(state.version), etag: '"tag-' + state.version + '"', ...state.tag});
    }
    assert.equal(path.pathname, '/drive/v3/files/' + id);
    if (path.searchParams.get('alt') === 'media') {
      const response = new Response(state.content);
      if (state.writes) state.duringReadback?.();
      return response;
    }
    return Response.json({id, version: String(state.version), name: state.name, mimeType: 'text/markdown',
      capabilities: {canEdit: state.canEdit}});
  }
  return {state, request};
}

test('one conditional update to the selected file preserves BOM, mixed newlines, comments and every other byte', async () => {
  const {state, request} = fixture();
  const result = await completeTask(selection, request);
  assert.equal(state.writes, 1);
  assert.equal(result.already, false);
  assert.equal(result.verified.meta.id, selection.fileId);
  assert.equal(result.verified.content, finished);
  assert.equal(state.content, finished);
});

test('a version change during readback retries one complete snapshot without sending a second write', async () => {
  const {state, request} = fixture();
  let reads = 0;
  state.duringReadback = () => { if (++reads === 1) state.version++; };
  const result = await completeTask(selection, request);
  assert.equal(result.verified.content, finished);
  assert.equal(result.verified.meta.version, String(state.version));
  assert.equal(reads, 2);
  assert.equal(state.writes, 1);
});

test('a second version change or a stable external edit cannot confirm the initial write', async () => {
  for (const keepChanging of [true, false]) {
    const {state, request} = fixture();
    let reads = 0;
    state.duringReadback = () => {
      if (++reads === 1) {
        state.content += '\nПараллельная правка';
        state.version++;
      } else if (keepChanging) state.version++;
    };
    await assert.rejects(completeTask(selection, request), error => keepChanging ?
      error.message.includes('подтвердить версию') : error.current?.content === state.content);
    assert.equal(reads, 2);
    assert.equal(state.writes, 1);
    assert(state.content.endsWith('Параллельная правка'));
  }
});

test('a lost response can be retried without another write or a toggle', async () => {
  const {state, request} = fixture();
  state.afterWrite = () => { throw new TypeError('network'); };
  await assert.rejects(completeTask(selection, request), /network/);
  const retry = await completeTask(selection, request);
  assert.equal(retry.already, true);
  assert.equal(retry.verified.content, finished);
  assert.equal(state.writes, 1);
});

test('stale selection, duplicate labels and non-checkbox entries never change a neighbour', async () => {
  const commented = '## Сегодня\n<!-- пример\n- [ ] скрытый --> - [ ] Настоящий пункт';
  for (const [shown, latest, line] of [
    [original, '# Новая строка\n' + original, 3],
    [original, original.replace('Полить ёлку', 'Другое дело'), 3],
    [original + '- [ ] Полить ёлку', original + '- [ ] Полить ёлку', 3],
    [original, original, 2],
    [original, original, 0],
    [commented, commented, 2],
    [finished, finished, 3]
  ]) {
    const {state, request} = fixture();
    state.content = latest;
    await assert.rejects(completeTask({...selection, content: shown, line}, request),
      error => error.current?.content === latest);
    assert.equal(state.writes, 0);
  }
});

test('the conditional write rejects an intervening edit and returns the freshly read list', async () => {
  const {state, request} = fixture();
  const external = original + 'Дописано извне\n';
  state.beforeWrite = () => { state.content = external; state.version++; };
  await assert.rejects(completeTask(selection, request), error => error.current?.content === external);
  assert.equal(state.writes, 0);
  assert.equal(state.content, external);
});

test('another filename, missing edit access, mismatched version and missing or weak ETag stop the update', async () => {
  for (const change of [{name: 'Now.md'}, {canEdit: false}, {refuseWrite: true},
    {tag: {version: '8'}}, {tag: {etag: null}}, {tag: {etag: 'W/"tag-7"'}}]) {
    const {state, request} = fixture();
    Object.assign(state, change);
    await assert.rejects(completeTask(selection, request));
    assert.equal(state.content, original);
    assert.equal(state.writes, 0);
  }
});

test('an acknowledged write with differing readback is reported as unconfirmed', async () => {
  const {state, request} = fixture();
  state.afterWrite = () => { state.content += '\nПараллельная правка'; state.version++; };
  await assert.rejects(completeTask(selection, request),
    error => error.message.includes('не подтвердил') && error.current?.content === state.content);
  assert.equal(state.writes, 1);
});
