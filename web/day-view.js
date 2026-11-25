import {NOW, TASKS} from './core.js?v=0.4.0';
import {preferredFile} from './device.js?v=0.4.0';
import {nowContext, todayTasks} from './today.js?v=0.4.0';

const panels = new Map([
  [NOW, {element: document.getElementById('today-context')}],
  [TASKS, {element: document.getElementById('today-tasks')}]
]);
let localDate = '', timeZone = '', midnightTimer;

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
      const {items, selected} = todayTasks(content, localDate);
      heading.textContent = selected ? 'Дела на сегодня' : 'Открытые дела';
      if (items.length) {
        const list = document.createElement('ul');
        for (const text of items) {
          const item = document.createElement('li');
          item.textContent = text;
          list.append(item);
        }
        body.append(list);
      } else {
        body.textContent = selected ? 'В разделе дня нет открытых дел.' : 'В заметке нет открытых дел.';
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
  if (error) message = readAt ? message + '. Данные могут быть устаревшими. ' + error : error;
  state.textContent = message;
  state.classList.toggle('error', Boolean(error));
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
  Object.assign(panel, {content, readAt: new Date(), error: ''});
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
