import assert from 'node:assert/strict';
import {test} from 'node:test';
import {noteProperties} from '../web/note-properties.js';
import {patchView, saveView} from '../web/save-view.js';

const source = '\uFEFF---\r\ntags: [книги, планы]\n# комментарий\r\nmyday_view : "text"  # вид\r\n' +
  'aliases:\r\n  - "книга"\n...\r\n# Покупки\n- [ ] Чай\r\n<!-- my-day:служебное -->';
const next = source.replace('"text"', '"list"');
const choice = {fileId: 'synthetic', name: 'Books.md', version: '4', view: 'list'};

test('change or add exactly the intended scalars, preserving comments, BOM, carriage returns, body and EOF', () => {
  assert.equal(patchView(source, 'list'), next);
  assert.equal(patchView('\uFEFF# Новый\r\nКонец', 'text'), '\uFEFF---\r\nmyday_view: text\r\n---\r\n# Новый\r\nКонец');
  assert.equal(patchView('---\nx: "a # b"\n---', 'plan'), '---\nx: "a # b"\nmyday_view: plan\n---');
  const withNotes = "---\rmyday_view: 'text' # прежний\r---\r---\rmyday_view: text\r";
  assert.equal(patchView(withNotes, 'plan'), withNotes.replace("'text'", "'plan'"));
  assert.equal(patchView(source, 'text'), source);
});

test('save chart configuration with quoted scalars and preserve it when switching back to text', () => {
  const chart = {table:'Книги · Дата | Страницы', x:'Дата', y:'Страницы "всего"', unit:"день #1: 'лист'"};
  const raw = source.replace('tags:', "myday_chart_unit: 'шт'  # прежняя единица\n" + 'tags:');
  const result = patchView(raw, 'chart', chart);
  assert(result.endsWith(raw.slice(raw.indexOf('...'))));
  assert(result.includes("myday_chart_unit: 'день #1: ''лист'''  # прежняя единица\n"));
  assert(result.includes('myday_chart_y: "Страницы \\"всего\\""\r\n'));
  const {valid, values} = noteProperties(result);
  assert.equal(valid, true);
  for (const [key, value] of Object.entries(chart)) assert.equal(values.get('myday_chart_' + key), value);
  assert.equal(patchView(result, 'chart', chart), result);
  assert.equal(patchView(result, 'text'), result.replace('"chart"  # вид', '"text"  # вид'));
  for (const invalid of [{...chart,x:chart.y},{...chart,unit:''},{...chart,table:'x\ny'}]) {
    assert.throws(() => patchView(raw, 'chart', invalid));
  }
});

test('ambiguous and malformed frontmatter never gets rewritten', () => {
  for (const fields of ['myday_view: text\n"myday_view": plan', 'myday_view: |\n  list',
    'extra:\n  key: nested', 'aliases: &list a', '<<: *defaults', 'myday_view: [list]',
    'tags: [one # not closed]', 'oops: "unclosed', 'tag: "\\q"', 'key:value', '  key: value',
    'tags:\n  - one\n - two', 'key\tinside: x', '# comment with NUL\0']) {
    assert.throws(() => patchView('---\n' + fields + '\n---\n- строка', 'plan'), /однозначно/);
  }
  assert.throws(() => patchView('---\nmyday_view: list\n', 'text'), /однозначно/);
  assert.throws(() => patchView('--- # comment\nmyday_view: text\n---', 'text'), /однозначно/);
  assert.throws(() => patchView('%TAG !e! tag:example.com,2026:\n---\n# A', 'plan'), /однозначно/);
});

function fixture() {
  const state = {text:source, version:4, puts:0, canEdit:true, name:choice.name, requests:[]};
  const edit = value => { state.text = value; state.version++; };
  const etag = () => '"v' + state.version + '"';
  async function request(url, options) {
    const target = new URL(url);
    state.requests.push(target.pathname);
    assert.equal(target.pathname.split('/').at(-1), choice.fileId);
    if (options?.method) {
      assert.equal(target.pathname, '/upload/drive/v2/files/' + choice.fileId);
      assert.equal(options.method, 'PUT');
      assert.equal(target.searchParams.get('uploadType'), 'media');
      assert.equal(options.headers['Content-Type'], 'text/markdown');
      state.beforePut?.();
      if (options.headers['If-Match'] !== etag()) throw Object.assign(new Error('412'), {httpStatus:412});
      if (state.refuse) throw Object.assign(new Error('Drive отказал'), {httpStatus:403});
      state.puts++;
      edit(Buffer.from(options.body).toString('utf8'));
      state.afterPut?.();
      return Response.json({});
    }
    if (target.pathname.startsWith('/drive/v2/')) {
      return Response.json({id:choice.fileId, version:String(state.version), etag:state.tag ?? etag()});
    }
    if (target.searchParams.has('alt')) return new Response(state.text);
    return Response.json({id:choice.fileId, name:state.name, mimeType:'text/markdown', version:String(state.version),
      size:String(Buffer.byteLength(state.text)), capabilities:{canEdit:state.canEdit}});
  }
  return {state, edit, run:(args = choice) => saveView(args, request)};
}

test('verify the bytes after saving, confirm a delivered retry without issuing another write', async () => {
  const {state, edit, run} = fixture();
  const outcome = await run();
  assert.equal(outcome.verified.content, next);
  assert.equal(outcome.already, false);
  edit(next + '\nНезависимая правка');
  assert.equal((await run()).already, true);
  assert.equal(state.puts, 1);
  assert(state.requests.at(-1).startsWith('/drive/v3/files/'));
});

test('a stale displayed version and ETag race preserve the external edit; no writes for denied files or legacy template', async () => {
  for (const mode of ['stale', '412', 'weak', 'read-only', '403', 'renamed', 'template', 'invalid-version']) {
    const {state, edit, run} = fixture();
    const args = {...choice};
    if (mode === 'stale') edit(source + '\nДругое изменение');
    if (mode === '412') state.beforePut = () => edit(source + '\nДругое изменение');
    if (mode === 'weak') state.tag = 'W/"etag"';
    if (mode === 'read-only') state.canEdit = false;
    if (mode === '403') state.refuse = true;
    if (mode === 'renamed') state.name = 'Other.md';
    if (mode === 'template') args.name = state.name = 'My-Day-test.md';
    if (mode === 'invalid-version') args.version = undefined;
    await assert.rejects(run(args), error => mode === 'stale' || mode === '412' ?
      error.reselect && error.current?.content === state.text : true);
    assert.equal(state.puts, 0, mode);
    assert.equal(state.text, ['stale','412'].includes(mode) ? source + '\nДругое изменение' : source);
  }
});

test('lost acknowledgement and differing readback leave delivery unresolved until a fresh read', async () => {
  for (const mode of ['lost', 'external']) {
    const {state, run} = fixture();
    state.afterPut = () => {
      if (mode === 'lost') throw new TypeError('lost response');
      state.text += '\nДругой клиент сохранил абзац';
      state.version++;
    };
    await assert.rejects(run(), e => e.uncertain === true);
    assert.equal((await run()).already, true);
    assert.equal(state.puts, 1);
    assert(state.text.startsWith(next));
  }
});
