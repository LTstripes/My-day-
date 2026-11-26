import assert from 'node:assert/strict';
import {test} from 'node:test';
import {noteView} from '../web/note-views.js';

test('a flat view property is read at the start of a note, an override is temporary', () => {
  const raw = "\uFEFF---\r\ntags: [поездка, подготовка]\r\naliases:\r\n  - Тест\r\nmyday_view: 'list'  # для чтения\r\n...\r\n# Шаги\r\n- [ ] Проверить билеты\r\n";
  assert.equal(noteView(raw, {defaultView: 'plan'}).view, 'list');
  const plan = noteView(raw, {override: 'plan'});
  assert.equal(plan.view, 'plan');
  assert.equal(plan.action, 'Проверить билеты');
  assert.equal(noteView(raw, {override: 'text'}).text, raw);
  assert.equal(noteView(raw).view, 'list');
  const body = 'Абзац\n---\nmyday_view: list\n---\n- [ ] Пример';
  assert.equal(noteView(body).view, 'text');
  assert.equal(noteView(body, {defaultView: 'plan'}).action, 'Пример');
  assert.equal(noteView('---\nmyday_kind: plan\n---\n- [ ] Пример').view, 'text');
});

test('unreadable or unknown properties keep the complete Markdown available', () => {
  for (const header of ['myday_view: graph', 'myday_view: plan\n"myday_view": list',
    'myday_view: [list]', 'myday_view: &v list', 'myday_view: |-',
    'invalid line\nmyday_view: list', 'tags: [missing close\nmyday_view: list',
    'nested:\n  myday_view: list']) {
    const raw = '---\n' + header + '\n---\n# Заголовок\n- Есть пункт\nАбзац';
    const result = noteView(raw, {defaultView: 'list'});
    assert.equal(result.view, 'text', header);
    assert(result.notice, header);
    assert.equal(result.text, raw, header);
  }
  const unclosed = '---\nmyday_view: list\n- Ложный пункт свойств';
  assert.equal(noteView(unclosed, {override: 'list'}).view, 'text');
  assert.equal(noteView(unclosed).text, unclosed);
});

test('general lists include every section and preserve checkbox states without parsing code or comments', () => {
  const marker = '<!-- my-day:task:decafbad-aaaa-4bbb-8ccc-123456789abc -->';
  const raw = ['# Сегодня', 'Вступление', '- Строка', '## Завтра', '1. Шаг', '- [X] Готово',
    '~~~dataviewjs', '- [ ] Из примера', '~~~', '<!--', '- [ ] Из комментария', '-->',
    '<pre>', '- [ ] Из HTML', '</pre>', marker, '%%', '- [ ] Скрыто', '%%', '- [ ] Действие',
    '***', 'Заключение'].join('\r\n');
  const {groups, text} = noteView(raw, {override: 'list'});
  assert.deepEqual(groups, [
    {heading: 'Сегодня', items: [{kind: 'bullet', text: 'Строка'}]},
    {heading: 'Завтра', items: [{kind: 'bullet', text: 'Шаг'}, {kind: 'done', text: 'Готово'},
      {kind: 'open', text: 'Действие'}]}
  ]);
  assert.equal(text, raw.replace(marker + '\r\n', ''));
  assert.equal(noteView(raw, {override: 'plan'}).action, 'Действие');
});

test('insufficient structured content falls back to readable text with an explanation', () => {
  for (const [raw, override] of [['# Эссе\nДва слова', 'list'], ['- [x] Готово\n- Идея', 'plan']]) {
    const view = noteView(raw, {override});
    assert.equal(view.view, 'text');
    assert.equal(view.text, raw);
    assert(view.notice);
  }
});
