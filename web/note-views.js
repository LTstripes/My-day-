import {readableNote} from './core.js?v=0.15.0';
import {firstPlanAction, noteList} from './today.js?v=0.15.0';

const views = new Set(['text', 'list', 'plan']);
const propertiesNotice = 'Не удалось однозначно прочитать свойства заметки.';
const unknownNotice = 'Указанный в свойствах вид пока не поддерживается.';

// Read only flat metadata. Unknown fields may contain ordinary scalars or simple
// tag lists. Leave more complex YAML to tools that implement the full language.
function simpleScalar(value) {
  if (value.startsWith('"')) return /^"(?:[^"\\]|\\.)*"(?:[ \t]+#.*)?$/.test(value);
  if (value.startsWith("'")) return /^'(?:[^']|'')*'(?:[ \t]+#.*)?$/.test(value);
  const plain = value.replace(/(?:^|[ \t]+)#.*$/, '');
  return !/^[!&*|>@%\x60]|^[-?:](?:$|\s)|[[\]{},]|:\s/.test(plain);
}

function viewProperty(raw) {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r\n?|\n/);
  if (!/^---[ \t]*$/.test(lines[0])) return {};
  const end = lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line));
  if (end === -1) return {notice: 'В начале заметки не закрыт блок свойств.', unclosed: true};

  let view = null, sequence = false;
  const keys = new Set();
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    // A trailing comment follows whitespace. Quoted view values cannot contain '#'.
    const field = /^([^:#\s][^:#]*?):(?:[ \t]+(.*)|$)/.exec(line);
    if (!field) {
      const member = /^ *- +(.+?)\s*$/.exec(line);
      if (sequence && member && simpleScalar(member[1])) continue;
      return {notice: propertiesNotice};
    }
    const key = field[1].trim().replace(/^(["'])([\w-]+)\1$/, '$2');
    if (keys.has(key)) return {notice: propertiesNotice};
    keys.add(key);
    const value = (field[2] ?? '').trimEnd();
    sequence = !value || value.startsWith('#');
    if (key === 'myday_view') {
      const match = /^(?:"([\w-]+)"|'([\w-]+)'|([\w-]+))(?:[ \t]+#.*)?$/.exec(value);
      if (!match) return {notice: propertiesNotice};
      view = match[1] ?? match[2] ?? match[3];
    } else {
      const list = /^\[([^\[\]{}]*)\](?:[ \t]+#.*)?$/.exec(value);
      if (!(list ? list[1].split(',').every(part => simpleScalar(part.trim())) : simpleScalar(value))) {
        return {notice: propertiesNotice};
      }
    }
  }
  if (view && !views.has(view)) return {notice: unknownNotice};
  return {view};
}

export function noteView(raw, {override, defaultView = 'text'} = {}) {
  const property = viewProperty(raw);
  const result = {view: 'text', text: readableNote(raw).text, groups: [], action: null, notice: property.notice ?? ''};
  if (property.unclosed || (property.notice && !override)) return result;
  const selected = override ?? property.view ?? defaultView;
  if (selected === 'list') {
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

