import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildHandoff, buildHandoffHistory} from '../web/handoff.js';

const a = '12345678-abcd-4abc-8abc-123456789abc';
const b = '23456789-bcde-4bcd-9bcd-23456789abcd';
const c = '3456789a-cdef-4cde-acde-3456789abcde';
const file = 'test-file';
const name = 'My-Day-test.md';
const source = op => '<!-- my-day:' + op + ' -->';
const answer = op => '<!-- my-day:assistant:' + op + ' -->';
const history = (...lines) => buildHandoffHistory(file, name, lines.join('\r\n'));

test('history orders the active file by source and links a later answer by exact operation', () => {
  const {records, defaultOp} = history(source(a), 'Первая <!-- скрыто -->мысль.', 'Продолжение мысли.',
    source(b), 'Следующая мысль.', answer(a), 'Ответ на первую.', 'Посторонняя строка.');
  assert.equal(defaultOp, b);
  assert.deepEqual(records.map(({op, snippet, resultState, result}) => [op, snippet, resultState, result]), [
    [b, 'Следующая мысль.', 'missing', null], [a, 'Первая мысль.', 'saved', 'Ответ на первую.']
  ]);
  assert(records[1].command.includes(file));
  assert(records[1].command.includes(source(a)));
  assert(records[1].command.includes(answer(a)));
  for (const other of [b, 'Первая', 'Ответ на первую.', 'Посторонняя строка.']) {
    assert(!records[1].command.includes(other));
  }
});

test('code, metadata, quoted examples and comments do not create operations or answers', () => {
  const {records, defaultOp} = history('\uFEFF---', source(c), 'YAML', '...', '~~~md', source(c), 'Код', '~~~',
    '    ' + source(c), '> ' + source(c), '<!-- заметка', source(c), 'внутри', answer(c), '-->',
    'Пример `<!--`.', source(a), 'Мысль', '```', answer(a), 'Пример ответа', '```',
    '<!-- невидимый пример', source(c), 'пример', '-->');
  assert.equal(defaultOp, a);
  assert.deepEqual(records.map(({op, resultState}) => [op, resultState]), [[a, 'missing']]);
  assert.deepEqual(history('---', source(a), 'Незакрытая шапка').records, []);
});

test('unsafe latest source suppresses the default and keeps earlier safe choices', () => {
  for (const tail of [
    [source(b), 'Одна', source(b), 'Другая'],
    [source(b), 'Мысль', 'Образец `' + source(b) + '`'],
    [source(b), '', 'Чужой абзац'],
    [source(b), '~~~', '', '~~~'],
    [source(b), '<!-- пустой комментарий -->', 'Чужой абзац'],
    [source(b).replace(' -->', '-->'), 'Неполная метка'],
    ['<!-- my-day:invalid -->', 'Чужая мысль']
  ]) {
    const lines = [source(a), 'Старая мысль', ...tail];
    const {records, defaultOp} = history(...lines);
    assert.deepEqual(records.map(record => record.op), [a]);
    assert.equal(defaultOp, null);
    assert.equal(buildHandoff(file, name, lines.join('\n')), null);
  }
});

test('a duplicate, empty, malformed or preceding answer never confirms processing or allows another command', () => {
  const basic = [source(a), 'Мысль'];
  for (const lines of [
    [...basic, answer(a), 'Первый', answer(a), 'Второй'],
    [...basic, answer(a), 'Ответ', '```', answer(a), '```'],
    [...basic, answer(a), '', '## Следующий раздел'],
    [...basic, answer(a), '', '', 'Следующий абзац'],
    [...basic, answer(a), '', source(b), 'Следующая мысль'],
    [...basic, answer(a), source(b), 'Другая мысль'],
    [...basic, answer(a), '```', 'Образец ответа', '```'],
    [...basic, answer(a), '<!-- скрытый результат -->'],
    [...basic, answer(a).replace(' -->', '-->'), 'Текст'],
    [...basic, answer(a.toUpperCase()), 'Другой регистр'],
    [answer(a), 'Раньше записи', ...basic]
  ]) {
    const record = history(...lines).records.find(record => record.op === a);
    assert.equal(record.resultState, 'ambiguous');
    assert.equal(record.result, null);
    assert.equal(record.command, null);
  }
  assert.equal(history(...basic, answer(b), 'Похожий ответ к другой записи.', 'Готово.').records[0].resultState, 'missing');
});

test('a code thought remains selectable and a Markdown paragraph can follow the result marker', () => {
  for (const body of [['~~~md', source(b), 'Образец', '~~~'], ['    Код']]) {
    const {records, defaultOp} = history(source(a), ...body, answer(a), '', 'Разбор кода.');
    assert.equal(defaultOp, a);
    assert.equal(records.length, 1);
    assert.equal(records[0].snippet, 'Блок кода');
    assert.equal(records[0].result, 'Разбор кода.');
  }
});

test('save confirmation must identify the latest uniquely readable record in the active writable note', () => {
  const content = [source(a), 'Первая', source(b), 'Последняя'].join('\n');
  assert(buildHandoff(file, name, content, b).includes(source(b)));
  assert.deepEqual(buildHandoffHistory(file, name, content, a), {records: [], defaultOp: null});
  for (const [id, title] of [['unsafe id', name], [file, 'Now.md']]) {
    assert.deepEqual(buildHandoffHistory(id, title, content), {records: [], defaultOp: null});
  }
});
