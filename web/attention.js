import {noteProperties} from './note-properties.js?v=0.16.0';
import {TEST_FILE} from './core.js?v=0.14.0';

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const timestamp = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const dayFormat = new Intl.DateTimeFormat('ru-RU', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'});
const statusNames = {overdue:'Просрочено', today:'Сегодня', soon:'Скоро'};
const statusOrder = Object.values(statusNames);

function localDay(date) {
  return [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
}

function validDay(day) {
  const date = new Date(day + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

export function attentionDate(markdown) {
  const properties = noteProperties(markdown);
  if (!properties.valid || !properties.values.has('myday_attention')) return null;
  const value = properties.values.get('myday_attention');
  if (typeof value === 'string') {
    if (dateOnly.test(value) && validDay(value)) return {day: value, value};
    const match = timestamp.exec(value);
    if (match && validDay(match[1]) && !value.endsWith('-00:00')) {
      const instant = Date.parse(value);
      if (Number.isFinite(instant)) return {instant, value};
    }
  }
  return {invalid: true};
}

export function attentionStatus(date, now) {
  if (!date || date.invalid) return null;
  const today = localDay(now);
  const dueDay = date.day ?? localDay(new Date(date.instant));
  if (date.instant != null ? date.instant <= now.getTime() : dueDay < today) return statusNames.overdue;
  if (dueDay === today) return statusNames.today;
  const end = new Date(now);
  end.setDate(end.getDate() + 7);
  return dueDay <= localDay(end) ? statusNames.soon : null;
}

export function initAttention(panel, onOpen) {
  const list = panel.querySelector('ul');
  const filter = panel.querySelector('#today-attention-filter');
  const empty = panel.querySelector('#today-attention-empty');
  const state = panel.querySelector('[role=status]:not(#today-attention-empty)');
  let sources = new Map(), timer;
  const dates = new Map(), failed = new Set(), pending = new Map();

  function actionButton(id, label, reschedule = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.dataset[reschedule ? 'rescheduleId' : 'fileId'] = id;
    button.textContent = label;
    button.setAttribute('aria-label', label + ': ' + sources.get(id));
    button.onclick = () => onOpen(id, reschedule);
    return button;
  }

  function render() {
    clearTimeout(timer);
    const now = new Date();
    // Re-evaluate calendar dates across DST, and timed entries as soon as they fall due.
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    let nextChange = midnight.getTime();
    const rows = [], invalid = [];
    for (const [id, date] of dates) {
      if (date.invalid) { invalid.push(sources.get(id)); continue; }
      if (date.instant > now.getTime()) nextChange = Math.min(nextChange, date.instant);
      const status = attentionStatus(date, now);
      if (status) rows.push({id, date, status, day: date.day ?? localDay(new Date(date.instant))});
    }
    rows.sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) ||
      a.day.localeCompare(b.day) || (a.date.instant ?? -Infinity) - (b.date.instant ?? -Infinity) ||
      sources.get(a.id).localeCompare(sources.get(b.id), 'ru'));
    list.replaceChildren();
    const selected = statusNames[filter.value];
    const visible = selected ? rows.filter(row => row.status === selected) : rows;
    empty.hidden = !rows.length || visible.length > 0;
    empty.textContent = empty.hidden ? '' : 'Среди прочитанных заметок нет сроков в группе «' + selected + '».';
    for (const {id, date, status} of visible) {
      const item = document.createElement('li');
      const link = document.createElement('a'), time = document.createElement('time');
      const name = sources.get(id);
      link.textContent = name;
      link.setAttribute('aria-label', 'Открыть в Drive: ' + name);
      link.href = 'https://drive.google.com/open?id=' + encodeURIComponent(id);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      time.dateTime = date.value;
      time.textContent = date.day ? dayFormat.format(new Date(date.day + 'T00:00:00Z')) :
        new Date(date.instant).toLocaleString('ru-RU', {day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit',
          minute: '2-digit', second: '2-digit', timeZoneName: 'short'});
      item.append(status + ' · ', time, ' · ', link);
      if (onOpen) {
        item.append(' ', actionButton(id, 'Открыть в заметках'));
        if (date.canEdit) item.append(' ', actionButton(id, 'Перенести', true));
      }
      list.append(item);
    }
    const messages = [];
    if (invalid.length) messages.push('Проверь дату внимания в ' + invalid.map(name => '«' + name + '»').join(', ') +
      '. Укажи календарную дату или время с часовым поясом.');
    if (failed.size) messages.push('Часть заметок недоступна. Обнови обзор, чтобы проверить их ещё раз.');
    state.textContent = messages.join(' ');
    panel.hidden = !rows.length && !messages.length;
    if (dates.size > invalid.length) timer = setTimeout(render, Math.max(1, nextChange - now.getTime()));
  }

  function forget(id) {
    dates.delete(id);
    failed.delete(id);
    pending.delete(id);
  }
  function setSources(notes) {
    const next = new Map(notes.map(({id, name}) => [id, name]));
    for (const [id, name] of sources) {
      if (next.get(id) !== name) forget(id);
    }
    sources = next;
    render();
  }
  function show({meta, content}) {
    if (sources.get(meta.id) !== meta.name) return;
    forget(meta.id);
    const date = attentionDate(content);
    if (date) dates.set(meta.id, {...date, canEdit: meta.capabilities?.canEdit === true && meta.name !== TEST_FILE});
    render();
  }
  function unavailable(id) {
    if (!sources.has(id)) return;
    forget(id);
    failed.add(id);
    render();
  }
  async function refresh(excludedIds, read) {
    const skip = new Set(excludedIds);
    const reads = [];
    for (const [id, name] of sources) {
      if (skip.has(id)) continue;
      const attempt = {};
      pending.set(id, attempt);
      dates.delete(id);
      failed.delete(id);
      reads.push((async () => {
        try {
          const result = await read(id, name);
          if (pending.get(id) === attempt) show(result);
          return true;
        } catch (error) {
          if (pending.get(id) !== attempt) return false;
          unavailable(id);
          if (error.access === 'expired' || error.access === 'consent') throw error;
          return false;
        } finally {
          if (pending.get(id) === attempt) pending.delete(id);
        }
      })());
    }
    render();
    return (await Promise.all(reads)).every(Boolean);
  }
  function clear({preserveFilter = false} = {}) {
    if (!preserveFilter) filter.value = '';
    dates.clear();
    failed.clear();
    pending.clear();
    render();
  }
  filter.addEventListener('change', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  window.addEventListener('focus', render);
  return {setSources, show, unavailable, refresh, clear};
}
