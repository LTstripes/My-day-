import {NOW, TASKS} from './core.js?v=0.14.0';
import {preferredFile} from './device.js?v=0.15.0';
import {nowContext, todayTasks} from './today.js?v=0.15.0';

const panels = new Map([
  [NOW, {element: document.getElementById('today-context')}],
  [TASKS, {element: document.getElementById('today-tasks')}]
]);
const finder = document.getElementById('today-task-find');
const query = document.getElementById('today-task-query');
const matches = document.getElementById('today-task-matches');
let localDate = '', timeZone = '', midnightTimer;

function folded(text) {
  return text.normalize('NFC').toLowerCase().replaceAll('ё', 'е').replace(/\s+/gu, ' ');
}

query.oninput = () => render(TASKS, panels.get(TASKS));
query.onkeydown = event => {
  if (event.isComposing) return;
  if (event.key === 'Enter') event.preventDefault();
  if (event.key === 'Escape') {
    event.preventDefault();
    finder.open = false;
    finder.querySelector('summary').focus();
  }
};
finder.ontoggle = () => {
  if (finder.open && !finder.hidden) query.focus({preventScroll: true});
  if (!finder.open && query.value) {
    query.value = '';
    render(TASKS, panels.get(TASKS));
  }
};

let complete, onSourceChange, actionsEnabled = false;
export function onTaskSourceChange(handler) {
  onSourceChange = handler;
}
export function taskSource() {
  const panel = panels.get(TASKS);
  if (!panel.id || !panel.readAt || panel.error) return null;
  return {fileId: panel.id, version: panel.version, content: panel.content, canEdit: panel.canEdit, date: localDate};
}
export function onTaskCompletion(handler) {
  complete = handler;
}
export function setTaskActionsEnabled(enabled) {
  actionsEnabled = enabled;
  for (const button of panels.get(TASKS).element.querySelectorAll('[data-complete], [data-reopen]')) button.disabled = !enabled;
}

function checkboxAction(entry, source) {
  const reopen = entry.kind === 'done';
  const target = {...source, line: entry.lineIndex};
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.dataset[reopen ? 'reopen' : 'complete'] = '';
  button.textContent = reopen ? 'Вернуть в дела' : 'Выполнено';
  button.setAttribute('aria-label', button.textContent + ' — ' + entry.text);
  button.disabled = !actionsEnabled;
  button.onclick = () => complete(target, reopen);
  return button;
}

function completedTasks(entries, fileId, open, source) {
  const details = document.createElement('details');
  details.dataset.fileId = fileId;
  details.dataset.date = localDate;
  const summary = document.createElement('summary');
  summary.textContent = 'Выполнено задач: ' + entries.length;
  const list = document.createElement('ul');
  details.append(summary, list);
  details.open = open;
  function showItems() {
    if (details.open === list.hasChildNodes()) return;
    list.replaceChildren();
    if (!details.open) return;
    for (const entry of entries) {
      const item = document.createElement('li');
      item.textContent = entry.text;
      if (source) item.append(checkboxAction(entry, source));
      list.append(item);
    }
  }
  details.ontoggle = showItems;
  if (open) showItems();
  return details;
}

function render(name, panel) {
  const {element, id, content, readAt, error} = panel;
  const body = element.querySelector('[data-body]');
  const state = element.querySelector('[data-state]');
  const link = element.querySelector('[data-open]');
  const heading = element.querySelector('h3');
  const previous = body.querySelector('details');
  const sameList = previous && previous.dataset.fileId === id && previous.dataset.date === localDate;
  const keepOpen = Boolean(sameList && previous.open);
  const keepFocus = sameList && previous.contains(document.activeElement);
  body.replaceChildren();
  if (name === TASKS) {
    heading.textContent = 'Дела на сегодня';
    if (content == null || panel.filterDate !== localDate || panel.filterFile !== id) {
      finder.open = false;
      panel.filterDate = localDate;
      panel.filterFile = content == null ? null : id;
      query.value = '';
    }
    if (content == null) {
      finder.hidden = true;
      matches.textContent = '';
    }
  }
  if (content != null) {
    if (name === NOW) {
      body.textContent = nowContext(content) || 'В заметке пока нет текста.';
    } else {
      const {items, selected, unsupported} = todayTasks(content, localDate);
      heading.textContent = selected ? 'Дела на сегодня' : 'Список дел';
      const source = panel.canEdit && !error ? {fileId: id, date: localDate, version: panel.version, content} : null;
      finder.hidden = items.length === 0;
      const term = finder.open && items.length ? folded(query.value.trim()) : '';
      const filtered = term ? items.filter(entry => folded(entry.text).includes(term)) : items;
      const count = 'Найдено: ' + filtered.length + ' из ' + items.length + '.';
      matches.textContent = term ? (filtered.length ? count : 'Совпадений нет.') : '';
      const visible = filtered.filter(entry => entry.kind !== 'done');
      const done = filtered.filter(entry => entry.kind === 'done');
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
          if (entry.kind === 'open' && source) item.append(checkboxAction(entry, source));
          list.append(item);
        }
        body.append(list);
      } else if (!term && unsupported) {
        body.textContent = done.length ? 'В заметке есть текст вне списка. Полный текст доступен в Drive.' :
          'Формат списка не распознан. Открой источник в Drive, чтобы увидеть текст.';
      } else if (!term && items.length) {
        body.textContent = 'Все задачи в списке выполнены.';
      } else if (!term) {
        body.textContent = selected ? 'В разделе дня нет пунктов списка.' : 'Нет пунктов для показа сегодня.';
      }
      // Keep the disclosure state while a query temporarily hides every completed item.
      if (items.some(entry => entry.kind === 'done')) {
        const details = completedTasks(done, id, keepOpen, source);
        details.hidden = !done.length;
        body.append(details);
        if (keepFocus && !details.hidden) details.querySelector('summary').focus({preventScroll: true});
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
  state.hidden = !id && !panel.ambiguous && !error;
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
    date.title = zone;
    date.textContent = now.toLocaleDateString('ru-RU', {weekday: 'long', day: 'numeric', month: 'long'});
    document.getElementById('today-zone').textContent = zone;
    for (const [name, panel] of panels) render(name, panel);
  }
  const nextDay = new Date(now);
  nextDay.setHours(24, 0, 0, 0);
  clearTimeout(midnightTimer);
  midnightTimer = setTimeout(updateDayDate, nextDay - now);
}
