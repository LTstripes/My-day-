import {TEST_FILE} from './core.js?v=0.14.0';
import {validId, validMarkdownName} from './device.js?v=0.15.0';
import {markdownSnapshot} from './drive.js?v=0.15.0';
import {conditionalWrite, selectionError} from './conditional-write.js?v=0.16.0';
import {noteProperties} from './note-properties.js?v=0.16.0';
import {attentionDate} from './attention.js?v=0.18.0';

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
  const plain = key === 'myday_view' || key === 'myday_attention';
  return plain && !oldToken.startsWith('"') ? value : JSON.stringify(value);
}

function removeField(raw, span) {
  const from = Math.max(raw.lastIndexOf('\n', span.from - 1), raw.lastIndexOf('\r', span.from - 1)) + 1;
  const tail = /^[^\r\n]*(?:\r\n|[\r\n]|$)/.exec(raw.slice(span.to))[0];
  // Keep a trailing comment, its spacing and its original line ending.
  return {from, to: tail.includes('#') ? span.to : span.to + tail.length, value: ''};
}

function patchProperties(raw, fields) {
  const header = noteProperties(raw);
  if (!header.valid) throw new Error(unsafeHeader);
  const edits = [], missing = [];
  for (const [key, value] of fields) {
    const span = header.spans.get(key);
    if (!span) {
      if (value !== null) missing.push(key + ': ' + encodedValue(key, value));
    } else {
      const previous = header.values.get(key);
      if (previous == null) throw new Error(unsafeHeader);
      if (value === null) edits.push(removeField(raw, span));
      else if (previous !== value) edits.push({...span, value: encodedValue(key, value, span.token)});
    }
  }
  if (header.close === null) {
    const body = raw.slice(header.bom);
    // A malformed document opener is not a safe place for a second header.
    if (/^(?:[ \t]+---[ \t]*(?:[\r\n]|$)|---[ \t]+#|%(?:TAG|YAML)(?:[ \t]|$))/.test(body)) throw new Error(unsafeHeader);
    if (!missing.length) return raw;
    return raw.slice(0, header.bom) + ['---', ...missing, '---', ''].join(header.eol) + body;
  }
  if (missing.length) edits.push({from: header.close, to: header.close, value: missing.join(header.eol) + header.eol});
  // Descending edits preserve all indices and untouched bytes, including mixed EOLs.
  for (const {from, to, value} of edits.sort((a, b) => b.from - a.from)) {
    raw = raw.slice(0, from) + value + raw.slice(to);
  }
  return raw;
}

export function patchView(raw, view, chart) {
  return patchProperties(raw, desiredProperties(view, chart));
}

function attentionPatch(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(date)) {
    // A precise existing time is accepted unchanged, including its original offset and quoting.
    return raw => {
      const current = attentionDate(raw);
      if (current?.instant != null && current.value === date) return raw;
      throw new Error('Для новой даты внимания выбери календарный день без времени.');
    };
  }
  if (date !== null) {
    const instant = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Date(date + 'T00:00:00Z') : null;
    if (!instant || !Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) {
      throw new Error('Выбери существующую дату внимания в формате ГГГГ-ММ-ДД.');
    }
  }
  const fields = new Map([['myday_attention', date]]);
  return raw => patchProperties(raw, fields);
}

export function patchAttention(raw, date) {
  return attentionPatch(date)(raw);
}

function changed(current, subject) {
  const error = selectionError(current, 'Заметка изменилась. Сверь свежий текст и заново выбери ' + subject + ' перед сохранением.');
  error.reselect = true;
  return error;
}

async function saveProperties({fileId, name, version}, request, makePatch, subject) {
  if (!validId(fileId) || !validMarkdownName(name) || typeof version !== 'string' || !version) {
    throw new Error('Открой и прочитай нужную заметку перед сохранением.');
  }
  if (name === TEST_FILE) throw new Error('Для тестового шаблона My-Day-test.md доступен временный просмотр. Выбери другой Markdown.');
  const patch = makePatch();
  const readBack = () => markdownSnapshot(fileId, request, name);
  const current = await readBack();
  function alreadySaved(file) {
    try { return patch(file.content) === file.content; }
    catch { return false; }
  }
  if (current.meta.version !== version) {
    if (alreadySaved(current)) return {verified: current, already: true};
    throw changed(current, subject);
  }
  const next = patch(current.content);
  if (next === current.content) return {verified: current, already: true};
  const result = await conditionalWrite(current, next, request, readBack);
  if (result.changed) {
    // A retry or a second tab may have already applied this very choice.
    if (alreadySaved(result.verified)) return {verified: result.verified, already: true};
    throw changed(result.verified, subject);
  }
  if (result.verified.content !== next) {
    const error = selectionError(result.verified, 'Drive не подтвердил ожидаемый текст после сохранения. Сверь заметку.');
    error.uncertain = true;
    throw error;
  }
  return {verified: result.verified, already: false};
}

export function saveView(selection, request) {
  return saveProperties(selection, request, () => {
    const fields = desiredProperties(selection.view, selection.chart);
    return raw => patchProperties(raw, fields);
  }, 'вид');
}

export function saveAttention(selection, request) {
  return saveProperties(selection, request, () => attentionPatch(selection.date), 'дату внимания');
}
