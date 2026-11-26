import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nowContext, todayTasks} from '../web/today.js';

const date = '2026-11-25';
const item = (lineIndex, kind, text) => ({lineIndex, kind, text});

test('a selected To Do now file can just contain two bullet lines and trailing blank lines', () => {
  const result = todayTasks('- Купить чай\n- Позвонить\n\n', date);
  assert.deepEqual(result, {items: [item(0, 'bullet', 'Купить чай'), item(1, 'bullet', 'Позвонить')],
    selected: false, unsupported: false});
});

test('today includes nested topics and a separately dated section in source order', () => {
  const markdown = [
    '# Дела', '- [ ] Без даты', '## Сегодня', '- [ ] Первая', '- [x] Готово',
    '### Работа', '1. [ ] Вторая', '### Планы на завтра', '- [ ] В другой день',
    '### Дом', '* [ ] Третья', '## Архив', '- [ ] Архивная',
    '## Среда · 2026-11-25', '+ [ ] Четвёртая', '### 2026-11-26', '- [ ] Позже'
  ].join('\r\n');
  assert.deepEqual(todayTasks(markdown, date), {items: [item(3, 'open', 'Первая'), item(4, 'done', 'Готово'),
    item(6, 'open', 'Вторая'), item(10, 'open', 'Третья'), item(14, 'open', 'Четвёртая')], selected: true, unsupported: false});
});

test('other days never leak into the undated fallback or a completed day', () => {
  const otherDays = '## Сегодня — 2026-11-24\n- [ ] Вчера\n### Сегодня\n- [X] Выполнено\n## Завтра\n- [ ] Завтра\n';
  assert.deepEqual(todayTasks('- Без даты\n' + otherDays, date), {items: [item(0, 'bullet', 'Без даты')], selected: false, unsupported: false});
  assert.deepEqual(todayTasks(otherDays + '## 2026-11-25\n* [x] Уже сделано', date),
    {items: [item(7, 'done', 'Уже сделано')], selected: true, unsupported: false});
});

test('metadata, comments and code never create day headings or checklist items', () => {
  const markdown = [
    '\uFEFF---', '## Сегодня', '- [ ] YAML', '---', '# Дела',
    '<!-- скрыто', '## Сегодня', '- [ ] Служебное -->', '    - [ ] Образец с отступом',
    '~~~~markdown', '## Сегодня', '~~~', '- [ ] Образец в коде', '<!--', '~~~~',
    '1. Подготовка', '    - [ ] Вложенная', '          - [ ] Код внутри списка',
    '- [ ] Отправить <!-- временная пометка -->письмо', '- [x] Отправлено', '- [ ]   '
  ].join('\n');
  assert.deepEqual(todayTasks(markdown, date), {items: [item(16, 'open', 'Вложенная'), item(18, 'open', 'Отправить письмо'),
    item(19, 'done', 'Отправлено')], selected: false, unsupported: true});
});

test('only visible bullets within today are listed; unsupported lines never become bullets', () => {
  const markdown = ['# To Do now', '## Сегодня', '- Купить чай', '* Позвонить', '+ [ ] Открытый',
    '- [X] Закрытый', '<!--', '- Служебное', '-->', '~~~', '- Пример', '~~~',
    '%%', '- Личное примечание', '%%', '- [/] Другой статус', '- - -', '## Завтра', '- Чужой день'].join('\n');
  assert.deepEqual(todayTasks(markdown, date), {items: [item(2, 'bullet', 'Купить чай'), item(3, 'bullet', 'Позвонить'),
    item(4, 'open', 'Открытый'), item(5, 'done', 'Закрытый')], selected: true, unsupported: true});
});

test('Now keeps paragraphs and meaningful later sections while hiding the file title and metadata', () => {
  const operation = 'decafbad-aaaa-4bbb-8ccc-123456789abc';
  const markdown = [
    '\uFEFF---', 'tags: [личное]', '...', '# Now', '',
    '<!-- my-day:' + operation + ' -->', 'Вводный абзац.', '',
    '<!-- my-day:assistant:' + operation + ' -->', '## Текущий фокус ##',
    'Сделать <!-- скрытая', 'пометка -->одну вещь.', '', '## Позже', '- Другая мысль'
  ].join('\r\n');
  assert.equal(nowContext(markdown), 'Вводный абзац.\n\nТекущий фокус\nСделать\nодну вещь.\n\nПозже\n- Другая мысль');
  assert.equal(nowContext('---\n# Первый абзац\nВажный текст'), '---\nПервый абзац\nВажный текст');
  assert.equal(nowContext('# Now\n<!-- только служебная запись -->'), '');
  assert.equal(nowContext('Пример `<!--`.\nПродолжение.'), 'Пример `<!--`.\nПродолжение.');
});
