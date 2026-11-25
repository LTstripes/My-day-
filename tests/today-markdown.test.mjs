import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nowContext, todayTasks} from '../web/today.js';

const date = '2026-11-25';

test('today includes nested topics and a separately dated section in source order', () => {
  const markdown = [
    '# Дела', '- [ ] Без даты', '## Сегодня', '- [ ] Первая', '- [x] Готово',
    '### Работа', '1. [ ] Вторая', '### Планы на завтра', '- [ ] В другой день',
    '### Дом', '* [ ] Третья', '## Архив', '- [ ] Архивная',
    '## Среда · 2026-11-25', '+ [ ] Четвёртая', '### 2026-11-26', '- [ ] Позже'
  ].join('\r\n');
  assert.deepEqual(todayTasks(markdown, date), {items: ['Первая', 'Вторая', 'Третья', 'Четвёртая'], selected: true});
});

test('an empty today stays empty; a file without today offers only the open checklist', () => {
  const otherDays = '## Сегодня — 2026-11-24\n- [ ] Вчера\n### Сегодня\n- [X] Выполнено\n## Завтра\n- [ ] Завтра\n';
  assert.deepEqual(todayTasks(otherDays, date), {items: ['Вчера', 'Завтра'], selected: false});
  assert.deepEqual(todayTasks(otherDays + '## 2026-11-25\n* [x] Уже сделано', date), {items: [], selected: true});
});

test('metadata, comments, code and completed tasks never create day headings or checklist items', () => {
  const markdown = [
    '\uFEFF---', '## Сегодня', '- [ ] YAML', '---', '# Дела',
    '<!-- скрыто', '## Сегодня', '- [ ] Служебное -->', '    - [ ] Образец с отступом',
    '~~~~markdown', '## Сегодня', '~~~', '- [ ] Образец в коде', '<!--', '~~~~',
    '1. Подготовка', '    - [ ] Вложенная', '          - [ ] Код внутри списка',
    '- [ ] Отправить <!-- временная пометка -->письмо', '- [x] Отправлено', '- [ ]   '
  ].join('\n');
  assert.deepEqual(todayTasks(markdown, date), {items: ['Вложенная', 'Отправить письмо'], selected: false});
});

test('Now keeps paragraphs and meaningful later sections while hiding the file title and metadata', () => {
  const markdown = [
    '\uFEFF---', 'tags: [личное]', '...', '# Now', '',
    'Вводный абзац.', '', '<!-- my-day:example -->', '', '## Текущий фокус ##',
    'Сделать <!-- скрытая', 'пометка -->одну вещь.', '', '## Позже', '- Другая мысль'
  ].join('\r\n');
  assert.equal(nowContext(markdown), 'Вводный абзац.\n\nТекущий фокус\nСделать\nодну вещь.\n\nПозже\n- Другая мысль');
  assert.equal(nowContext('---\n# Первый абзац\nВажный текст'), '---\nПервый абзац\nВажный текст');
  assert.equal(nowContext('# Now\n<!-- только служебная запись -->'), '');
  assert.equal(nowContext('Пример `<!--`.\nПродолжение.'), 'Пример `<!--`.\nПродолжение.');
});
