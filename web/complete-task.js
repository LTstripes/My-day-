import {TASKS} from './core.js?v=0.14.0';
import {MAX_BYTES, snapshot, SnapshotVersionChanged} from './drive.js?v=0.14.0';
import {insertTask, taskDelivery, todayTasks} from './today.js?v=0.14.0';

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

function readList(id, request) {
  return snapshot(id, request, TASKS, {viewOnly: true});
}

function changedSelection(current) {
  const error = selectionError(current, 'Список изменился перед записью. Сверь обновлённые дела и подтверди свой выбор ещё раз.');
  error.reselect = true;
  return error;
}

async function writeList(current, content, request) {
  const id = current.meta.id;
  if (!current.meta.capabilities?.canEdit) {
    throw selectionError(current, 'Для записи дела требуется право редактирования To Do now.md.');
  }
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_BYTES) throw selectionError(current, 'С новой задачей файл превысит лимит 500 КБ.');

  // The v2 ETag must belong to the same version as the bytes used to construct the update.
  const path = encodeURIComponent(id);
  const response = await request(FILES + path + '?fields=id,version,etag');
  const tag = await response.json();
  const changed = async () => ({verified: await readList(id, request), changed: true});
  if (tag.id !== id || tag.version !== current.meta.version) return changed();
  if (typeof tag.etag !== 'string' || !/^"[^"\s]+"$/.test(tag.etag)) {
    throw selectionError(current, 'Drive не вернул метку версии для безопасной записи. Открой дело в источнике.');
  }
  try {
    await request(UPLOAD + path + '?uploadType=media', {
      method: 'PUT',
      headers: {'If-Match': tag.etag, 'Content-Type': current.meta.mimeType || 'text/markdown; charset=UTF-8'},
      body: bytes
    });
  } catch (error) {
    if (error.httpStatus === 412) return changed();
    if (!error.httpStatus || error.httpStatus === 408 || error.httpStatus >= 500) error.uncertain = true;
    throw error;
  }
  try {
    const verified = await readList(id, request).catch(error => {
      if (error instanceof SnapshotVersionChanged) return readList(id, request);
      throw error;
    });
    return {verified, changed: false};
  } catch (error) {
    // The write was accepted. A readback error leaves delivery unresolved even for a 403/404.
    error.uncertain = true;
    throw error;
  }
}

export async function completeTask(selection, request) {
  const current = await readList(selection.fileId, request);
  const next = completedContent(selection, current);
  if (next.already) return {verified: current, already: true};
  const {verified, changed} = await writeList(current, next.content, request);
  if (changed) throw changedSelection(verified);
  if (verified.content !== next.content) {
    throw selectionError(verified, 'Drive не подтвердил ожидаемое содержимое после записи. Проверь обновлённый список.');
  }
  return {verified, already: false};
}

function isTaskDelivered(file, draft) {
  const delivery = taskDelivery(file.content, draft);
  if (delivery === 'conflict') {
    const error = selectionError(file, 'Метка дела неоднозначна или запись изменилась. Сверь дело в источнике.');
    error.uncertain = true;
    throw error;
  }
  return delivery === 'delivered';
}

export async function addTask(draft, request) {
  const current = await readList(draft.fileId, request);
  if (isTaskDelivered(current, draft)) return {verified: current, already: true};
  if (draft.version !== current.meta.version) throw changedSelection(current);
  const content = insertTask(current.content, draft);
  const {verified, changed} = await writeList(current, content, request);
  // Another tab may have delivered the same operation before our conditional update.
  if (isTaskDelivered(verified, draft)) return {verified, already: changed};
  if (changed) throw changedSelection(verified);
  const error = selectionError(verified, 'Не удалось подтвердить добавленное дело. Сверь список в Drive перед повтором.');
  error.uncertain = true;
  throw error;
}
