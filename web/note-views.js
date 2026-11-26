import {noteProperties} from './note-properties.js?v=0.16.0';
import {readableNote} from './core.js?v=0.15.0';
import {firstPlanAction, noteList} from './today.js?v=0.16.0';
import {chartTables} from './note-chart.js?v=0.16.0';

const views = new Set(['text', 'list', 'plan', 'chart']);
const propertiesNotice = 'Не удалось однозначно прочитать свойства заметки.';
const unknownNotice = 'Указанный в свойствах вид пока не поддерживается.';

function viewProperty(raw) {
  const {valid, unclosed, values} = noteProperties(raw);
  if (unclosed) return {notice: 'В начале заметки не закрыт блок свойств.', unclosed: true};
  if (!valid) return {notice: propertiesNotice};
  const view = values.get('myday_view');
  if (values.has('myday_view') && typeof view !== 'string') return {notice: propertiesNotice};
  if (view && !views.has(view)) return {notice: unknownNotice};
  const chart = {};
  for (const key of ['table','x','y','unit']) {
    const name = 'myday_chart_' + key;
    if (!values.has(name)) continue;
    const value = values.get(name);
    if (typeof value !== 'string') return {notice: propertiesNotice};
    chart[key] = value;
  }
  return {view, chart};
}

export function noteView(raw, {override, defaultView = 'text'} = {}) {
  const property = viewProperty(raw);
  const result = {view: 'text', text: readableNote(raw).text, groups: [], action: null, notice: property.notice ?? ''};
  if (property.unclosed || (property.notice && !override)) return result;
  const selected = override ?? property.view ?? defaultView;
  if (selected === 'chart') {
    const tables = chartTables(raw);
    if (tables.length) {
      Object.assign(result, {view:'chart', tables, chart:property.chart ?? {}});
    } else result.notice = 'В заметке нет Markdown-таблицы с заголовком и строкой разделителей. Открыт полный текст.';
  } else if (selected === 'list') {
    result.groups = noteList(raw);
    if (result.groups.length) result.view = 'list';
    else result.notice = 'В заметке нет распознанных пунктов списка. Открыт полный текст.';
  } else if (selected === 'plan') {
    result.action = firstPlanAction(raw);
    if (result.action) result.view = 'plan';
    else result.notice = 'В заметке нет открытых флажков для следующего действия. Открыт полный текст.';
  }
  return result;
}
