import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addTask} from '../web/complete-task.js';
import {taskDelivery, taskPlaces} from '../web/today.js';

const source = '\uFEFF# To Do now\r\n## Сегодня\r\n- [ ] Существующее дело\r\n## Завтра\r\n- Планы\n';
const id = 'test-today', date = '2026-11-26';
const text = 'Забрать заказ', op = 'e3f80cae-5e0f-4d0d-8d91-aef388baeab4';

function fixture(initial = source) {
  const state = {content: initial, version: 3, writes: 0, attempts: 0, canEdit: true, name: 'To Do now.md'};
  const draft = {fileId: id, version: '3', date, text, op, place: taskPlaces(initial, date).defaultId};
  const etag = () => '"fixture-' + state.version + '"';
  function edit(content) {
    state.content = content;
    state.version++;
  }
  async function request(url, options = {}) {
    const {pathname, searchParams} = new URL(url);
    if (options.method) {
      assert.equal(pathname, '/upload/drive/v2/files/' + id);
      assert.equal(searchParams.get('uploadType'), 'media');
      assert.equal(options.method, 'PUT');
      assert.equal(options.headers['Content-Type'], 'text/markdown');
      state.attempts++;
      const update = new TextDecoder('utf-8', {ignoreBOM: true}).decode(options.body);
      state.beforePut?.(update);
      if (options.headers['If-Match'] !== etag()) throw Object.assign(new Error('stale'), {httpStatus: 412});
      if (state.refuse) throw Object.assign(new Error('forbidden'), {httpStatus: 403});
      edit(update);
      state.writes++;
      state.afterPut?.();
      return Response.json({id});
    }
    if (pathname === '/drive/v2/files/' + id) {
      return Response.json({id, version: String(state.version), etag: etag(), ...state.tag});
    }
    assert.equal(pathname, '/drive/v3/files/' + id);
    if (searchParams.get('alt') === 'media') {
      const media = new Response(state.content);
      if (state.writes) state.readback?.();
      return media;
    }
    return Response.json({id, name: state.name, version: String(state.version), mimeType: 'text/markdown',
      capabilities: {canEdit: state.canEdit}, size: String(Buffer.byteLength(state.content))});
  }
  return {state, request, draft, edit};
}

test('add one task in the selected day and acknowledge only after reading it back; retry has no PUT', async () => {
  const {state, request, draft} = fixture();
  const result = await addTask(draft, request);
  assert.equal(result.already, false);
  assert.equal(result.verified.meta.id, id);
  assert.equal(result.verified.content, state.content);
  assert.equal(taskDelivery(result.verified.content, draft), 'delivered');
  const line = state.content.indexOf('- [ ] ' + text);
  assert(line > state.content.indexOf('Существующее дело') && line < state.content.indexOf('## Завтра'));
  assert(state.content.startsWith('\uFEFF# To Do now\r\n## Сегодня\r\n- [ ] Существующее дело\r\n'));
  assert(state.content.endsWith('## Завтра\r\n- Планы\n'));
  assert.equal((await addTask(draft, request)).already, true);
  assert.equal(state.attempts, 1);
});

test('lost reply followed by unrelated edits, checked task and line-ending conversion confirms by op', async () => {
  const {state, request, draft, edit} = fixture();
  state.afterPut = () => { throw new TypeError('lost reply'); };
  await assert.rejects(addTask(draft, request), error => error.uncertain && error.message === 'lost reply');
  edit(state.content.replace('- [ ] ' + text, '- [x] ' + text).replaceAll('\r\n', '\n') + 'Внешняя строка\n');
  const recovered = await addTask(draft, request);
  assert.equal(recovered.already, true);
  assert.equal(recovered.verified.content, state.content);
  assert.equal(state.attempts, 1);
});

test('missing operation after a version change requires explicit fresh destination and never writes', async () => {
  const {state, request, draft, edit} = fixture();
  edit('Добавлено извне\n' + source);
  await assert.rejects(addTask(draft, request), error => error.reselect && error.current?.content === state.content);
  assert.equal(state.attempts, 0);

  const lost = fixture();
  lost.state.afterPut = () => { throw new TypeError('lost reply'); };
  await assert.rejects(addTask(lost.draft, lost.request), error => error.uncertain);
  lost.edit(source + 'Правка убрала и флажок, и метку\n');
  await assert.rejects(addTask(lost.draft, lost.request), error => error.reselect && error.current?.content === lost.state.content);
  assert.equal(lost.state.attempts, 1);
});

test('concurrent Drive write wins on 412, including when a second tab sent the exact same op', async () => {
  for (const sameOp of [true, false]) {
    const {state, request, draft, edit} = fixture();
    state.beforePut = update => edit(sameOp ? update : source + 'Новая внешняя строка\n');
    if (sameOp) assert.equal((await addTask(draft, request)).already, true);
    else await assert.rejects(addTask(draft, request), error => error.reselect && error.current?.content === state.content);
    assert.equal(state.attempts, 1);
    assert.equal(state.writes, 0);
  }
});

test('readback that loses a marker or changes its task, or fails twice during version drift, is unconfirmed', async () => {
  for (const fault of ['gone', 'changed', 'duplicate', 'drift', 'forbidden']) {
    const {state, request, draft, edit} = fixture();
    state.readback = () => {
      if (fault === 'drift') state.version++;
      if (fault === 'forbidden') throw Object.assign(new Error('denied on readback'), {httpStatus: 403});
    };
    state.afterPut = () => {
      if (fault === 'gone') edit(source);
      if (fault === 'changed') edit(state.content.replace(text, 'Изменено'));
      if (fault === 'duplicate') edit(state.content + state.content);
    };
    await assert.rejects(addTask(draft, request), error => error.uncertain === true);
    assert.equal(state.attempts, 1);
    if (fault === 'changed' || fault === 'duplicate') {
      await assert.rejects(addTask(draft, request), error => error.uncertain && !error.reselect);
      assert.equal(state.attempts, 1);
    }
  }
});

test('permission, wrong name, absent strong ETag and UTF-8 size overflow leave the file intact', async () => {
  const large = '## Сегодня\n- [ ] ' + 'Ж'.repeat(249975) + '\n';
  for (const setup of [{canEdit: false}, {name: 'Now.md'}, {refuse: true}, {tag: {etag: 'W/"weak"'}}, {large: true}]) {
    const {state, request, draft} = fixture(setup.large ? large : source);
    Object.assign(state, setup);
    const before = state.content;
    await assert.rejects(addTask(draft, request), error => !error.uncertain);
    assert.equal(state.writes, 0);
    assert.equal(state.content, before);
    assert.equal(state.attempts, setup.refuse ? 1 : 0);
  }
});
