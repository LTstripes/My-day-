import {NOW, TASKS} from './core.js?v=0.4.0';
import {preferredFile} from './device.js?v=0.4.0';
import {nowContext, todayTasks} from './today.js?v=0.14.0';

const panels = new Map([
  [NOW, {element: document.getElementById('today-context')}],
  [TASKS, {element: document.getElementById('today-tasks')}]
]);
let localDate = '', timeZone = '', midnightTimer;

let complete, onSourceChange, actionsEnabled = false;
export function onTaskSourceChange(handler) {
  onSourceChange = handler;
}
export function taskSource() {
  const panel = panels.get(TASKS);
  if (!panel.id || !panel.readAt || !panel.canEdit || panel.error) return null;
  return {fileId: panel.id, version: panel.version, content: panel.content, date: localDate};
}
export function onTaskCompletion(handler) {
  complete = handler;
}
export function setTaskActionsEnabled(enabled) {
  actionsEnabled = enabled;
  for (const button of panels.get(TASKS).element.querySelectorAll('[data-complete]')) button.disabled = !enabled;
}

function render(name, panel) {
  const {element, id, content, readAt, error} = panel;
  const body = element.querySelector('[data-body]');
  const state = element.querySelector('[data-state]');
  const link = element.querySelector('[data-open]');
  const heading = element.querySelector('h3');
  body.replaceChildren();
  if (name === TASKS) heading.textContent = 'Дела на сегодня';
  if (content != null) {
    if (name === NOW) {
      body.textContent = nowContext(content) || 'В заметке пока нет текста.';
    } else {
      const {items, selected, unsupported} = todayTasks(content, localDate);
      heading.textContent = selected ? 'Дела на сегодня' : 'Список дел';
      const visible = items.filter(entry => entry.kind !== 'done');
      if (visible.length) {
        const list = document.createElement('ul');
        for (const entry of visible) {
          const item = document.createElement('li');
          item.dataset.kind = entry.kind;
          if (entry.kind === 'open') {
            const marker = document.createElement('span');
            marker.setAttribute('role', 'img');
            marker.setAttribute('aria-label', 'Открытая задача');
            marker.textContent = '☐ ';
            item.append(marker);
          }
          item.append(entry.text);
          if (entry.kind === 'open' && panel.canEdit && !error) {
            const target = {fileId: id, date: localDate, line: entry.lineIndex, content};
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'secondary';
            button.dataset.complete = '';
            button.textContent = 'Выполнено';
            button.setAttribute('aria-label', 'Выполнено — ' + entry.text);
            button.disabled = !actionsEnabled;
            button.onclick = () => complete(target);
            item.append(button);
          }
          list.append(item);
        }
        body.append(list);
        if (visible.length < items.length) {
          const summary = document.createElement('small');
          summary.textContent = 'Выполнено задач: ' + (items.length - visible.length);
          body.append(summary);
        }
      } else if (unsupported) {
        body.textContent = 'Формат списка не распознан. Открой источник в Drive, чтобы увидеть текст.';
      } else if (items.length) {
        body.textContent = 'Все задачи в списке выполнены.';
      } else {
        body.textContent = selected ? 'В разделе дня нет пунктов списка.' : 'Нет пунктов для показа сегодня.';
      }
    }
  }
  link.hidden = !readAt;
  if (readAt) link.href = 'https://drive.google.com/open?id=' + encodeURIComponent(id);
  else link.removeAttribute('href');
  let message = id ? 'Источник выбран. Ожидает чтения из Drive.' : 'Выбери источник в Google Drive.';
  if (panel.ambiguous) message = 'Есть несколько файлов с таким именем. Выбери источник обзора.';
  if (readAt) {
    const stamp = {hour: '2-digit', minute: '2-digit'};
    if (readAt.toDateString() !== new Date().toDateString()) Object.assign(stamp, {day: 'numeric', month: 'short'});
    message = 'Прочитано ' + readAt.toLocaleString('ru-RU', stamp);
  }
  if (name === TASKS && readAt && !panel.canEdit) message += ' · Только чтение';
  if (error) message = readAt ? message + '. Данные могут быть устаревшими. ' + error : error;
  state.textContent = message;
  state.classList.toggle('error', Boolean(error));
  if (name === TASKS) onSourceChange?.();
}

export function syncDaySources(device) {
  for (const [name, panel] of panels) {
    const id = preferredFile(device, name);
    const ambiguous = !id && device.fileIds.some(file => device.noteNames[file] === name);
    if (id === panel.id && ambiguous === panel.ambiguous) continue;
    Object.assign(panel, {id, ambiguous, content: null, readAt: null, error: ''});
    render(name, panel);
  }
}

export function clearDay() {
  for (const [name, panel] of panels) {
    Object.assign(panel, {content: null, readAt: null, error: ''});
    render(name, panel);
  }
}

export function showDayFile({meta, content}) {
  const panel = panels.get(meta.name);
  if (panel?.id !== meta.id) return;
  Object.assign(panel, {content, version: meta.version, canEdit: meta.capabilities?.canEdit === true, readAt: new Date(), error: ''});
  render(meta.name, panel);
}

export function dayFileFailed(id, error, message) {
  for (const [name, panel] of panels) {
    if (panel.id !== id) continue;
    const temporary = error instanceof TypeError || error.name === 'TimeoutError' || error.httpStatus >= 500 ||
      error.httpStatus === 429 || (error.httpStatus === 403 && !error.access);
    if (!temporary) Object.assign(panel, {content: null, readAt: null});
    panel.error = message;
    render(name, panel);
  }
}

export function updateDayDate() {
  const now = new Date();
  const two = value => String(value).padStart(2, '0');
  const iso = [now.getFullYear(), two(now.getMonth() + 1), two(now.getDate())].join('-');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (iso !== localDate || zone !== timeZone) {
    localDate = iso;
    timeZone = zone;
    const date = document.getElementById('today-date');
    date.dateTime = iso;
    date.textContent = now.toLocaleDateString('ru-RU', {weekday: 'long', day: 'numeric', month: 'long'});
    document.getElementById('today-zone').textContent = zone;
    for (const [name, panel] of panels) render(name, panel);
  }
  const nextDay = new Date(now);
  nextDay.setHours(24, 0, 0, 0);
  clearTimeout(midnightTimer);
  midnightTimer = setTimeout(updateDayDate, nextDay - now);
}
