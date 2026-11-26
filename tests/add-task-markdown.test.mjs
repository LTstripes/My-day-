import assert from 'node:assert/strict';
import {test} from 'node:test';
import {insertTask, taskDelivery, taskPlaces, todayTasks} from '../web/today.js';

const date = '2026-11-26';
const draft = {op: 'cabba9e0-1234-4010-8010-0123456789ab', text: 'Забрать заказ', date};
const marker = '<!-- my-day:task:' + draft.op + ' -->';
const block = marker + '\r\n- [ ] Забрать заказ\r\n';

test('appends a single visible checkbox without modifying the original bytes of a bare list', () => {
  const before = '\uFEFF- Погулять\r\n- [x] Выбрать чай';
  assert.equal(taskPlaces(before, date).defaultId, 'end');
  const after = insertTask(before, draft);
  assert.equal(after, before + '\r\n' + block);
  assert.deepEqual(todayTasks(after, date).items.at(-1), {lineIndex: 3, kind: 'open', text: draft.text});
  for (const prefix of ['', '\uFEFF']) {
    assert.equal(insertTask(prefix, draft), prefix + block.replaceAll('\r\n', '\n'));
  }
});

test('writes inside today before nested headings using local newlines; frontmatter, literals and comments are excluded', () => {
  const prefix = '\uFEFF---\nexample: "## Сегодня"\n---\n# To Do now\n## Вчера\n- [ ] Вчерашнее\n' +
    '```md\n## Сегодня\n```\n<!--\n## Сегодня\n-->\n%%\n## Сегодня\n%%\n' +
    '## 2026-11-26\r\n- Текущий пункт\r\n';
  const suffix = '### Позвонить завтра\r\n- Другое\r\n## 2026-11-27\n- Позже\n';
  assert.ok(taskPlaces(prefix + suffix, date).defaultId);
  assert.equal(insertTask(prefix + suffix, draft), prefix + block + suffix);
});

test('ambiguous matching sections require selection and give separate choices with original line numbers', () => {
  const before = '## Сегодня\n- Утро\n## Сегодня\n- Вечер\n## Завтра\n- Другое';
  const {choices, defaultId} = taskPlaces(before, date);
  assert.equal(choices.length, 2);
  assert.equal(defaultId, null);
  assert.notEqual(choices[0].label, choices[1].label);
  assert.throws(() => insertTask(before, draft), /раздел/);
  assert.throws(() => insertTask(before, {...draft, place: 'line-4'}), /раздел/);
  const after = insertTask(before, {...draft, place: choices[1].id});
  assert.equal(after, before.replace('## Завтра', block.replaceAll('\r\n', '\n') + '## Завтра'));
});

test('when today is missing, a new current-date heading requires explicit selection', () => {
  const before = '# 2026-11-25\r\n- До сегодня\r\n# 2026-11-27\r\n- Позже\r\n';
  const {choices, defaultId} = taskPlaces(before, date);
  assert.equal(defaultId, null);
  assert.deepEqual(choices.map(({id}) => id), ['new-day']);
  assert.throws(() => insertTask(before, draft), /раздел/);
  assert.equal(insertTask(before, {...draft, place: 'new-day'}), before + '# 2026-11-26\r\n' + block);
});

test('retries recognize checked or unchecked tasks across edited line endings but not modified or ambiguous markers', () => {
  const delivered = insertTask('', draft);
  for (const checked of ['[ ]', '[x]', '[X]']) {
    const external = 'Внешняя строка\r\n' + delivered.replace('[ ]', checked).replaceAll('\n', '\r\n');
    assert.equal(taskDelivery(external, draft), 'delivered');
    assert.equal(insertTask(external, draft), external);
  }
  for (const conflict of [delivered + marker, delivered + '<!-- my-day:task:' + draft.op,
    delivered.replace('заказ', 'чай'), '```\n' + delivered + '```', '<!--\n' + delivered,
    '---\n' + delivered + '---\n', delivered.replace(marker, '  ' + marker),
    delivered.replace('<!-- my-day:task:', 'my-day:t:')]) {
    assert.equal(taskDelivery(conflict, draft), 'conflict');
    assert.throws(() => insertTask(conflict, draft), /Метка/);
  }
  assert.equal(taskDelivery('- [ ] Забрать заказ', draft), 'missing');
});

test('refuses unsafe markup instead of swallowing a task or leaving a dangling comment', () => {
  for (const invalid of ['---\nkey: value\n', '## Сегодня\n~~~md\nsample', '<!-- hidden', '%% hidden']) {
    assert.throws(() => insertTask(invalid, draft), /не закрыт/);
  }
  for (const text of ['первая\n- [ ] вторая', 'скрытый <!-- текст', '%% скрыто %%', 'a'.repeat(301), marker]) {
    assert.throws(() => insertTask('', {...draft, text}));
  }
});
