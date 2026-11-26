import {contentLines} from './today.js?v=0.16.0';

function cells(text) {
  if (!text.includes('|')) return null;
  const trimmed = text.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

// Store a heading and column signature so moving a table does not redirect its chart.
export function chartTables(raw) {
  const lines = raw.split(/\r\n?|\n/);
  const tables = [];
  let heading = '', previous = null, table = null;
  for (const line of contentLines(raw)) {
    if (line.literal || previous?.index !== line.lineIndex - 1) {
      table = null;
      previous = null;
    }
    if (line.literal) continue;
    const values = cells(line.text);
    const divider = values && values.length >= 2 && values.every(cell => /^:?-{3,}:?$/.test(cell));
    if (divider && previous?.cells?.length === values.length) {
      const headers = previous.cells;
      const signature = (heading ? heading + ' · ' : '') + headers.join(' | ');
      table = {signature, headers, rows: [], start: previous.index, end: line.lineIndex};
      tables.push(table);
    } else if (table && values) {
      table.rows.push({values, line: line.lineIndex + 1});
      table.end = line.lineIndex;
    } else {
      table = null;
      const title = /^ {0,3}#{1,6}[ \t]+(.+?)\s*$/.exec(line.text);
      if (title) heading = title[1].replace(/[ \t]+#+$/, '');
    }
    previous = {cells: values, index: line.lineIndex};
  }
  for (const entry of tables) entry.source = lines.slice(entry.start, entry.end + 1).join('\n');
  return tables;
}

function calendarDay(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const time = Date.parse(text + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text ? time : null;
}

export function chartSeries(table, {x, y, unit}) {
  if (!x || !y || !unit?.trim()) return {error: 'Выбери обе колонки и укажи единицу измерения.'};
  if (x === y) return {error: 'Выбери разные колонки для даты и значения.'};
  const ix = table.headers.indexOf(x), iy = table.headers.indexOf(y);
  if (ix < 0 || iy < 0 || table.headers.lastIndexOf(x) !== ix || table.headers.lastIndexOf(y) !== iy) {
    return {error: 'Названия выбранных колонок отсутствуют или повторяются. Уточни заголовки в таблице.'};
  }
  const dates = new Set(), points = [];
  for (const {values, line} of table.rows) {
    if (values.length !== table.headers.length) return {error: 'В строке ' + line + ' число ячеек отличается от заголовка.'};
    const label = values[ix], time = calendarDay(label);
    if (time === null) return {error: 'В строке ' + line + ' нужна существующая дата в формате ГГГГ-ММ-ДД.'};
    if (dates.has(label)) return {error: 'Дата ' + label + ' встречается несколько раз. Уточни значения в источнике.'};
    dates.add(label);
    const raw = values[iy];
    let value = null;
    if (raw !== '') {
      value = Number(raw.replace(',', '.'));
      if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(raw) || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        return {error: 'В строке ' + line + ' требуется число без разделителей тысяч и единиц.'};
      }
    }
    points.push({label, time, value});
  }
  if (!points.some(point => point.value !== null)) return {error: 'В выбранной колонке пока нет числовых значений.'};
  points.sort((a, b) => a.time - b.time);
  return {points};
}

const element = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

function plot(points, {x, y, unit}) {
  const figure = element('figure');
  figure.style.margin = '1rem 0';
  const caption = element('figcaption', y + ' (' + unit + ') по ' + x + ' · по возрастанию дат');
  const canvas = element('canvas');
  canvas.id = 'chart-plot';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', caption.textContent + '. Значения доступны в исходной таблице.');
  canvas.width = 680;
  canvas.height = 224;
  canvas.style.cssText = 'display:block;width:100%;height:auto;max-width:680px';
  figure.append(caption, canvas);
  const ctx = canvas.getContext('2d');
  const left = 82, right = 630, top = 22, bottom = 180;
  let min = Infinity, max = -Infinity;
  for (const {value} of points) {
    if (value !== null) { min = Math.min(min, value); max = Math.max(max, value); }
  }
  const first = points[0], last = points.at(-1);
  const posX = t => first.time === last.time ? (left + right) / 2 :
    left + (t - first.time) / (last.time - first.time) * (right - left);
  const posY = v => min === max ? (top + bottom) / 2 : bottom - (v - min) / (max - min) * (bottom - top);
  const style = getComputedStyle(document.documentElement);
  ctx.font = '16px system-ui';
  ctx.fillStyle = style.getPropertyValue('--ink').trim() || '#222';
  ctx.strokeStyle = style.getPropertyValue('--line').trim() || '#999';
  const format = new Intl.NumberFormat('ru', {maximumSignificantDigits: 5, notation:'compact'});
  ctx.textAlign = 'right';
  for (const value of new Set([min,max])) {
    const py = posY(value);
    ctx.fillText(format.format(value), left - 7, py + 5, left - 10);
    ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke();
  }
  ctx.textAlign = 'center';
  for (const point of new Set([first,last])) ctx.fillText(point.label, posX(point.time), bottom + 26);
  ctx.strokeStyle = ctx.fillStyle = style.getPropertyValue('--accent').trim() || '#28674e';
  ctx.lineWidth = 2.5;
  let previous = null;
  for (const point of points) {
    if (point.value !== null) {
      const px = posX(point.time), py = posY(point.value);
      if (previous) {
        ctx.beginPath(); ctx.moveTo(previous.x, previous.y); ctx.lineTo(px, py); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
      previous = {x:px, y:py};
    } else previous = null;
  }
  return figure;
}

// Edits affect only this open chart. The reader exposes a valid selection to the explicit save action.
export function mountChart(container, tables, draft, changed) {
  const controls = element('div'), display = element('div'), source = element('div');
  container.append(controls, display, source);
  const field = (id, title, tag) => {
    const input = element(tag);
    input.id = id;
    const label = element('label', title);
    label.htmlFor = id;
    controls.append(label, input);
    return input;
  };
  const select = field('chart-table', 'Таблица', 'select');
  select.add(new Option('Выбери таблицу', ''));
  tables.forEach((table, i) => select.add(new Option((i + 1) + '. ' + table.signature, String(i))));
  const matches = tables.filter(table => table.signature === draft.table);
  if (matches.length === 1) select.value = String(tables.indexOf(matches[0]));
  else if (draft.line != null) {
    const chosen = tables.findIndex(table => table.start === draft.line && table.signature === draft.table);
    if (chosen >= 0) select.value = String(chosen);
  }
  const x = field('chart-x', 'Колонка дат', 'select');
  const y = field('chart-y', 'Колонка значений', 'select');
  const unit = field('chart-unit', 'Единица измерения', 'input');
  unit.maxLength = 300;
  unit.value = draft.unit ?? '';
  const tableAt = () => select.value === '' ? null : tables[Number(select.value)];
  function redraw() {
    display.replaceChildren();
    const table = tableAt();
    let valid = false;
    if (table) {
      const config = {table:table.signature, x:x.value, y:y.value, unit:unit.value.trim()};
      const series = chartSeries(table, config);
      if (series.error) display.append(element('p', series.error));
      else {
        display.append(plot(series.points, config));
        const unique = tables.filter(t => t.signature === table.signature).length === 1;
        valid = unique && config.table.length <= 2048 && config.x.length <= 300 && config.y.length <= 300 &&
          config.unit.length <= 300 && !Object.values(config).some(value => /[\x00-\x1f\x7f]/.test(value));
        if (!valid) display.append(element('p', 'Для сохранения нужны короткие уникальные названия таблицы и колонок.'));
      }
      changed({...config, line:table.start}, valid ? config : null);
    } else {
      display.append(element('p', draft.table ? 'Сохранённую таблицу не удалось определить однозначно. Выбери её снова.' :
        'Выбери таблицу, чтобы настроить график.'));
      changed(draft, null);
    }
  }
  function columns(restore) {
    const table = tableAt();
    source.replaceChildren();
    for (const [input, name] of [[x,'x'], [y,'y']]) {
      input.replaceChildren(new Option('Выбери колонку', ''));
      input.disabled = !table;
      for (const label of new Set(table?.headers ?? [])) {
        if (label) input.add(new Option(label, label));
      }
      if (restore && [...input.options].some(option => option.value === draft[name])) input.value = draft[name];
    }
    unit.disabled = !table;
    if (table) {
      const original = element('pre', table.source);
      original.id = 'chart-source';
      source.append(element('h4', 'Исходная таблица'), original);
    }
    redraw();
  }
  select.onchange = () => columns(false);
  x.onchange = y.onchange = unit.oninput = redraw;
  columns(true);
}
