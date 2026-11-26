import {TEST_FILE} from './core.js?v=0.14.0';
import {validId, validMarkdownName} from './device.js?v=0.15.0';
import {markdownSnapshot} from './drive.js?v=0.15.0';
import {conditionalWrite, selectionError} from './conditional-write.js?v=0.16.0';
import {noteProperties} from './note-properties.js?v=0.16.0';

const views = new Set(['text', 'list', 'plan', 'chart']);
const unsafeHeader = 'Свойства заметки нельзя однозначно изменить. Можно продолжить временный просмотр.';

function desiredProperties(view, chart) {
  if (!views.has(view)) throw new Error('Выбери поддерживаемый вид заметки.');
  const fields = new Map([['myday_view', view]]);
  if (view === 'chart') {
    for (const key of ['table', 'x', 'y', 'unit']) {
      const value = chart?.[key];
      if (typeof value !== 'string' || !value.trim() || value.length > (key === 'table' ? 2048 : 300) ||
          /[\x00-\x1f\x7f-\x9f\u2028\u2029\uD800-\uDFFF]/u.test(value)) {
        throw new Error('Укажи таблицу, обе колонки графика и единицу измерения.');
      }
      fields.set('myday_chart_' + key, value);
    }
    if (chart.x === chart.y) throw new Error('Выбери разные колонки для осей графика.');
  }
  return fields;
}

function encodedValue(key, value, oldToken = '') {
  if (oldToken.startsWith("'")) return "'" + value.replaceAll("'", "''") + "'";
  return key === 'myday_view' && !oldToken.startsWith('"') ? value : JSON.stringify(value);
}

export function patchView(raw, view, chart) {
  const fields = desiredProperties(view, chart);
  const header = noteProperties(raw);
  if (!header.valid) throw new Error(unsafeHeader);
  const edits = [], missing = [];
  for (const [key, value] of fields) {
    const span = header.spans.get(key);
    if (!span) missing.push(key + ': ' + encodedValue(key, value));
    else {
      const previous = header.values.get(key);
      if (previous == null) throw new Error(unsafeHeader);
      if (previous !== value) edits.push({...span, value: encodedValue(key, value, span.token)});
    }
  }
  if (header.close === null) {
    const body = raw.slice(header.bom);
    // A malformed document opener is not a safe place for a second header.
    if (/^(?:[ \t]+---[ \t]*(?:[\r\n]|$)|---[ \t]+#|%(?:TAG|YAML)(?:[ \t]|$))/.test(body)) throw new Error(unsafeHeader);
    return raw.slice(0, header.bom) + ['---', ...missing, '---', ''].join(header.eol) + body;
  }
  if (missing.length) edits.push({from: header.close, to: header.close, value: missing.join(header.eol) + header.eol});
  // Descending edits preserve all indices and untouched bytes, including mixed EOLs.
  for (const {from, to, value} of edits.sort((a, b) => b.from - a.from)) {
    raw = raw.slice(0, from) + value + raw.slice(to);
  }
  return raw;
}

function changed(current) {
  const error = selectionError(current, 'Заметка изменилась. Сверь свежий текст и заново выбери вид перед сохранением.');
  error.reselect = true;
  return error;
}

export async function saveView({fileId, name, version, view, chart}, request) {
  if (!validId(fileId) || !validMarkdownName(name) || typeof version !== 'string' || !version) {
    throw new Error('Открой и прочитай нужную заметку перед сохранением вида.');
  }
  if (name === TEST_FILE) throw new Error('Для тестового шаблона My-Day-test.md доступен временный просмотр. Выбери другой Markdown.');
  const desired = desiredProperties(view, chart);
  const alreadySaved = file => {
    const header = noteProperties(file.content);
    return header.valid && [...desired].every(([key, value]) => header.values.get(key) === value);
  };
  const readBack = () => markdownSnapshot(fileId, request, name);
  const current = await readBack();
  if (alreadySaved(current)) return {verified: current, already: true};
  if (current.meta.version !== version) throw changed(current);
  const next = patchView(current.content, view, chart);
  const result = await conditionalWrite(current, next, request, readBack);
  if (result.changed) {
    // A retry or a second tab may have already applied this very choice.
    if (alreadySaved(result.verified)) {
      return {verified: result.verified, already: true};
    }
    throw changed(result.verified);
  }
  if (result.verified.content !== next) {
    const error = selectionError(result.verified, 'Drive не подтвердил ожидаемый текст после сохранения вида. Сверь заметку.');
    error.uncertain = true;
    throw error;
  }
  return {verified: result.verified, already: false};
}
