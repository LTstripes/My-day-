import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chartTables, chartSeries} from '../web/note-chart.js';
import {noteView} from '../web/note-views.js';

const readings = [
  '## Чтение',
  '| Дата | Страницы |',
  '| :--- | ---: |',
  '| 2024-03-01 | 2,5 |',
  '| 2024-02-29 | |',
  '| 2024-02-28 | 0 |'
].join('\n');
const axes = {x:'Дата', y:'Страницы', unit:'стр.'};

test('chart uses the selected table and exact source columns; empty values break a series', () => {
  const [table] = chartTables(readings);
  const {points} = chartSeries(table, axes);
  assert.deepEqual(points.map(({label, value}) => [label, value]), [
    ['2024-02-28', 0], ['2024-02-29', null], ['2024-03-01', 2.5]
  ]);
  assert.deepEqual(points[1].time - points[0].time, 86_400_000);
  assert.equal(table.source, readings.slice(readings.indexOf('|')));
  assert.equal(noteView(readings, {override:'chart'}).view, 'chart');
  assert.equal(noteView(readings, {override:'text'}).text, readings);
});

test('reader restores chart parameters from frontmatter and the signature survives moved tables', () => {
  const first = chartTables(readings)[0];
  const front = ['---', 'myday_view: chart', 'myday_chart_table: ' + JSON.stringify(first.signature),
    'myday_chart_x: Дата', "myday_chart_y: 'Страницы' # значение", 'myday_chart_unit: "стр."',
    '---'].join('\r\n');
  const other = '# Архив\n| Название | Главы |\n| --- | --- |\n| A | 2 |';
  const raw = [front, other, readings].join('\n\n');
  const view = noteView(raw);
  assert.deepEqual(view.chart, {table:first.signature, ...axes});
  assert.equal(view.tables[1].signature, view.chart.table);
  assert.deepEqual(view.tables[1].headers, ['Дата','Страницы']);
  assert.notEqual(view.tables[0].signature, view.tables[1].signature);
});

test('invalid dates, shapes and values give a reason without plotting partial rows', () => {
  for (const [needle, replacement, error] of [
    ['2024-02-29', '2023-02-29', /ГГГГ-ММ-ДД/],
    ['2024-02-29', '2024-03-01', /несколько раз/],
    ['2,5', 'неизвестно', /требуется число/],
    ['2,5', '1 | 2', /число ячеек/],
    ['2,5', '9007199254740992', /требуется число/]
  ]) {
    const [table] = chartTables(readings.replace(needle, replacement));
    assert.match(chartSeries(table, axes).error, error);
  }
  const [table] = chartTables(readings);
  assert.match(chartSeries(table, {...axes, y:'Нет такой колонки'}).error, /заголовки/);
  assert.match(chartSeries(table, {...axes, unit:''}).error, /единицу/);
  const duplicate = chartTables(readings.replace('Страницы |', 'Дата |'))[0];
  assert.match(chartSeries(duplicate, axes).error, /заголовки/);
  assert.match(chartSeries(chartTables(readings.replace('2,5 |', ' |').replace('0 |',' |'))[0], axes).error, /нет числовых/);
});

test('literal table examples and frontmatter do not become chart data', () => {
  const raw = ['---', 'myday_view: chart', '---', '~~~markdown', readings, '~~~', '<!--',
    readings, '-->', '<pre>', readings, '</pre>', '%%', readings, '%%'].join('\n');
  assert.deepEqual(chartTables(raw), []);
  const view = noteView(raw);
  assert.equal(view.view, 'text');
  assert.match(view.notice, /нет Markdown-таблицы/);
  assert.equal(view.text, raw);
  const escaped = chartTables('Дата | Вход\\|выход\n--- | ---\n2024-02-29 | 3')[0];
  assert.deepEqual(escaped.headers, ['Дата', 'Вход|выход']);
});
