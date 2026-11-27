import {TASKS} from './core.js?v=0.14.0';
import {snapshot} from './drive.js?v=0.15.0';
import {conditionalWrite, selectionError} from './conditional-write.js?v=0.16.0';
import {insertTask, taskDelivery, todayTasks} from './today.js?v=0.15.0';

function checkboxContent({content, line, date, version}, current, reopen) {
  const {items} = todayTasks(content, date);
  const item = items.find(entry => entry.lineIndex === line);
  if (item?.kind !== (reopen ? 'done' : 'open')) {
    throw selectionError(current, reopen ? 'Выбери выполненное дело в списке.' : 'Выбери открытый флажок в списке дел.');
  }
  if (!reopen && items.filter(entry => entry.text === item.text).length !== 1) {
    throw selectionError(current, 'В списке несколько пунктов с таким текстом. Открой источник и уточни нужный пункт.');
  }
  if (reopen && (typeof version !== 'string' || !version)) throw changedSelection(current);

  // Locate the checkbox at its original row, including the BOM and original line endings.
  const lines = content.split(/(\r\n|[\r\n])/);
  const i = line * 2;
  const marker = /^(?:\uFEFF)?[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[([ xX])\]/.exec(lines[i]);
  const unsupported = 'Для этого оформления измени флажок в источнике.';
  const expectedMark = reopen ? /^[xX]$/ : /^ $/;
  if (!marker || !expectedMark.test(marker[1])) throw selectionError(current, unsupported);
  const offset = lines.slice(0, i).join('').length + marker[0].length - 2;
  const replace = value => content.slice(0, offset) + value + content.slice(offset + 1);
  const next = replace(reopen ? ' ' : 'x');
  // Reject a checkbox-shaped prefix inside an HTML comment ending on the same line.
  const marked = todayTasks(next, date).items.find(entry => entry.lineIndex === line);
  if (marked?.kind !== (reopen ? 'open' : 'done') || marked.text !== item.text) {
    throw selectionError(current, unsupported);
  }
  if (current.content === next || (!reopen && current.content === replace('X'))) return {already: true};
  if (current.content !== content || (version !== undefined && version !== current.meta.version)) throw changedSelection(current);
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

async function changeCheckbox(selection, request, reopen) {
  const current = await readList(selection.fileId, request);
  const next = checkboxContent(selection, current, reopen);
  if (next.already) return {verified: current, already: true};
  const {verified, changed} = await conditionalWrite(current, next.content, request, () => readList(selection.fileId, request));
  if (changed) {
    if (reopen && verified.content === next.content) return {verified, already: true};
    throw changedSelection(verified);
  }
  if (verified.content !== next.content) {
    throw selectionError(verified, 'Drive не подтвердил ожидаемое содержимое после записи. Проверь обновлённый список.');
  }
  return {verified, already: false};
}

export function completeTask(selection, request) {
  return changeCheckbox(selection, request, false);
}

export function reopenTask(selection, request) {
  return changeCheckbox(selection, request, true);
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
  const {verified, changed} = await conditionalWrite(current, content, request, () => readList(draft.fileId, request));
  // Another tab may have delivered the same operation before our conditional update.
  if (isTaskDelivered(verified, draft)) return {verified, already: changed};
  if (changed) throw changedSelection(verified);
  const error = selectionError(verified, 'Не удалось подтвердить добавленное дело. Сверь список в Drive перед повтором.');
  error.uncertain = true;
  throw error;
}
