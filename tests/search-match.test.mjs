import assert from 'node:assert/strict';
import {test} from 'node:test';
import {searchNote} from '../web/search-match.js';
import {readableNote} from '../web/core.js';

test('a task operation marker is hidden while the result still highlights the source task', () => {
  const marker = '<!-- my-day:task:30dc3c4c-e910-4b84-894d-352c9ac77dbc -->';
  const source = '- Сверить заказ\r\n' + marker + '\r\n- [ ] Забрать посылку\r\n';
  const hit = searchNote('To Do now.md', source, 'посылку').hits[0];
  const view = readableNote(source);
  assert.equal(view.text, '- Сверить заказ\r\n- [ ] Забрать посылку\r\n');
  assert.equal(view.text.slice(view.offset(hit.start), view.offset(hit.end)), 'посылку');
  assert.equal(searchNote('To Do now.md', source, 'my-day:task').total, 0);
});

test('Russian folded spelling, literal punctuation, and independent filename matches', () => {
  const text = '😀 Письмо [ЁЖ]+. и подпись [еж]+.';
  const result = searchNote('[еж]+.md', text, '  [Еж]+.  ');
  assert.equal(result.nameMatch, true);
  assert.equal(result.total, 2);
  assert.deepEqual(result.hits.map(hit => text.slice(hit.start, hit.end)), ['[ЁЖ]+.', '[еж]+.']);
  const decomposed = '📌 Е\u0308лка';
  const folded = searchNote('x', decomposed, 'ёлка').hits[0];
  assert.equal(decomposed.slice(folded.start, folded.end), 'Е\u0308лка');
  assert.deepEqual(searchNote('Мысли.md', text, 'мысли'), {nameMatch: true, total: 0, hits: []});
  assert.deepEqual(searchNote('Мысли.md', text, ' \n  '), {nameMatch: false, total: 0, hits: []});
  assert.equal(searchNote('x', '(a) .+ \\ [a] ^$', '\\ [a] ^$').total, 1);
});

test('soft-wrapped phrases map to original UTF-16 positions and cannot span a blank line', () => {
  const content = '\uFEFF# Заметка\r\n\r\n🚂 Длинный\r\n  маршрут через город.\rСнова длинный\r\n\t \r\nмаршрут';
  const {total, hits: [hit]} = searchNote('Now.md', content, 'длинный маршрут');
  assert.equal(total, 1);
  assert.equal(hit.line, 3);
  assert.equal(hit.start, content.indexOf('Длинный'));
  assert.equal(content.slice(hit.start, hit.end), 'Длинный\r\n  маршрут');
  assert.equal(hit.match, 'Длинный маршрут');
  assert.equal(searchNote('x', 'а\r\nб\nа\rб\nа\nб', 'а б').total, 3);
  assert.equal(searchNote('x', 'а\n\nб\nа\r\rб', 'а б').total, 0);
});

test('metadata and application comments stay out of matches and excerpts on both sides', () => {
  const text = '\uFEFF---\r\nключ: скрыто\r\n---\r\nПеред <!-- скрыто\r\nmy-day:fixture -->После.\n<!-- my-day:fixture -->\nФинал';
  assert.equal(searchNote('x', text, 'скрыто').total, 0);
  assert.equal(searchNote('x', text, 'my-day:fixture').total, 0);
  for (const [word, line] of [['Перед', 4], ['После', 5], ['Финал', 7]]) {
    const [hit] = searchNote('x', text, word).hits;
    assert.equal(hit.line, line);
    assert.equal(hit.start, text.indexOf(word));
    assert.doesNotMatch(hit.before + hit.match + hit.after, /скрыто|my-day|<!--|-->/);
  }
  const examples = 'Пример `<!--`.\n```html\n<!-- пример -->\n```\nОбычный текст.';
  assert.equal(searchNote('x', examples, 'Обычный текст').hits[0].line, 5);
  assert.equal(searchNote('x', examples, 'пример').total, 2);
  const unclosedFence = '```md\n<!-- my-day:fixture -->\nНовая мысль';
  assert.equal(searchNote('x', unclosedFence, 'fixture').total, 0);
  assert.doesNotMatch(searchNote('x', unclosedFence, 'мысль').hits[0].before, /my-day/);
});

test('bounded excerpts retain whole surrogate pairs and the limit preserves the total', () => {
  const note = 'a'.repeat(200) + '🚆' + 'б'.repeat(54) + 'цель' + 'в'.repeat(54) + '🏔' + 'd'.repeat(100);
  const [hit] = searchNote('x', note, 'цель').hits;
  assert.match(hit.before, /^…🚆/);
  assert.match(hit.after, /🏔…$/);
  assert(hit.before.length < 60 && hit.after.length < 60);
  const content = 'проверка\n'.repeat(10000);
  const result = searchNote('x', content, 'проверка', 2);
  assert.equal(result.total, 10000);
  assert.deepEqual(result.hits.map(({line}) => line), [1, 2]);
  assert.equal(searchNote('x', content, 'проверка', 0).hits.length, 0);
});
