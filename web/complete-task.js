import {TASKS} from './core.js?v=0.12.0';
import {snapshot} from './drive.js?v=0.12.0';
import {todayTasks} from './today.js?v=0.12.0';

const FILES = 'https://www.googleapis.com/drive/v2/files/';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v2/files/';

function selectionError(current, message) {
  const error = new Error(message);
  error.current = current;
  return error;
}

function completedContent({content, line, date}, current) {
  const {items} = todayTasks(content, date);
  const item = items.find(entry => entry.lineIndex === line);
  if (item?.kind !== 'open') {
    throw selectionError(current, 'Выбери открытый флажок в списке дел.');
  }
  if (items.filter(entry => entry.text === item.text).length !== 1) {
    throw selectionError(current, 'В списке несколько пунктов с таким текстом. Открой источник и уточни нужный пункт.');
  }
  // Keep the delimiters so mixed line endings, the BOM and all other bytes survive.
  const lines = content.split(/(\r\n|[\r\n])/);
  const i = line * 2;
  const marker = /^(?:\uFEFF)?[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[ \]/.exec(lines[i]);
  if (!marker) throw selectionError(current, 'Для этого оформления флажок можно отметить в источнике.');
  const pos = marker[0].length - 2;
  const offset = lines.slice(0, i).join('').length + pos;
  const next = content.slice(0, offset) + 'x' + content.slice(offset + 1);
  // A checkbox-shaped prefix can belong to a multiline HTML comment that ends on this line.
  const marked = todayTasks(next, date).items.find(entry => entry.lineIndex === line);
  if (marked?.kind !== 'done' || marked.text !== item.text) {
    throw selectionError(current, 'Для этого оформления флажок можно отметить в источнике.');
  }
  if (current.content === next || current.content === content.slice(0, offset) + 'X' + content.slice(offset + 1)) {
    return {already: true};
  }
  if (current.content !== content) {
    throw selectionError(current, 'Список изменился. Проверь обновлённые дела и выбери пункт ещё раз.');
  }
  return {already: false, content: next};
}

export async function completeTask(selection, request) {
  const id = selection.fileId;
  const read = () => snapshot(id, request, TASKS, {viewOnly: true});
  const current = await read();
  const next = completedContent(selection, current);
  if (next.already) return {verified: current, already: true};
  if (!current.meta.capabilities?.canEdit) {
    throw selectionError(current, 'Для отметки дела требуется право редактирования To Do now.md.');
  }

  // Drive v2 exposes the file ETag. Bind it to the version of the bytes we actually read.
  const path = encodeURIComponent(id);
  const response = await request(FILES + path + '?fields=id,version,etag');
  const tag = await response.json();
  const changed = async () => selectionError(await read(), 'Список изменился перед записью. Выбери дело ещё раз.');
  if (tag.id !== id || tag.version !== current.meta.version) throw await changed();
  if (typeof tag.etag !== 'string' || !/^"[^"\s]+"$/.test(tag.etag)) {
    throw selectionError(current, 'Drive не вернул метку версии для безопасной записи. Открой дело в источнике.');
  }
  try {
    await request(UPLOAD + path + '?uploadType=media', {
      method: 'PUT',
      headers: {'If-Match': tag.etag, 'Content-Type': current.meta.mimeType || 'text/markdown; charset=UTF-8'},
      body: new TextEncoder().encode(next.content)
    });
  } catch (error) {
    if (error.httpStatus === 412) throw await changed();
    throw error;
  }
  const verified = await read();
  if (verified.content !== next.content) {
    throw selectionError(verified, 'Drive не подтвердил ожидаемое содержимое после записи. Проверь обновлённый список.');
  }
  return {verified, already: false};
}
