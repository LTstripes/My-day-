import {readableNote} from './core.js?v=0.6.1';
import {searchNote} from './search-match.js?v=0.5.0';

const $ = id => document.getElementById(id);
const pageSize = 5;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function initNoteSearch({run, read, onError}) {
  const input = $('search-query'), results = $('search-results'), detail = $('search-detail');
  const status = $('search-status');
  let files = [], online = false, locked = false, job = null, opener = null;

  function hint() {
    if (!online) return 'Для поиска подключи Google Drive.';
    if (!files.length) return 'Сначала выбери файл в разделе «Мои заметки».';
    return 'Поиск перечитает выбранные файлы из Drive.';
  }
  function controls() {
    input.disabled = !online || !files.length;
    $('search-submit').disabled = input.disabled || locked || !input.value.trim();
    $('search-clear').hidden = !input.value;
    if (!job) status.textContent = hint();
  }
  function closeDetail(refocus = false) {
    const previous = opener;
    opener = null;
    detail.hidden = true;
    delete detail.dataset.fileId;
    $('search-text').replaceChildren();
    $('search-detail-title').textContent = $('search-position').textContent = '';
    $('search-drive-link').removeAttribute('href');
    results.hidden = false;
    if (refocus) (previous?.isConnected ? previous : input).focus();
  }
  function reset(clearQuery = true) {
    job?.controller.abort();
    job = null;
    closeDetail();
    results.replaceChildren();
    if (clearQuery) input.value = '';
    controls();
  }
  function openDetail(row, hit, button) {
    opener = button;
    results.hidden = true;
    detail.hidden = false;
    detail.dataset.fileId = row.id;
    $('search-detail-title').textContent = row.name;
    const position = hit ? 'Строка ' + hit.line + ' · ' : '';
    $('search-position').textContent = position + 'Только чтение · ' + row.readAt;
    $('search-drive-link').href = 'https://drive.google.com/open?id=' + encodeURIComponent(row.id);
    const body = $('search-text');
    body.replaceChildren();
    const note = readableNote(row.content);
    let marker;
    if (hit) {
      const start = note.offset(hit.start), end = note.offset(hit.end);
      marker = element('mark', note.text.slice(start, end));
      body.append(note.text.slice(0, start), marker, note.text.slice(end));
    } else {
      body.textContent = note.text;
    }
    body.scrollTop = 0;
    $('search-detail-title').focus();
    marker?.scrollIntoView({block: 'nearest'});
  }
  function group(row) {
    const card = element('article', '', 'search-group');
    card.dataset.fileId = row.id;
    card.append(element('h3', row.name));
    if (files.some(file => file.name === row.name && file.id !== row.id)) {
      card.append(element('small', 'ID ' + row.id, 'search-id'));
    }
    if (row.error) {
      card.append(element('p', row.error, 'search-error'));
      return card;
    }
    if (row.match.nameMatch) {
      const titleHit = element('button', 'Открыть совпадение в названии', 'search-link');
      titleHit.type = 'button';
      titleHit.onclick = () => openDetail(row, null, titleHit);
      card.append(titleHit);
    }
    const list = element('ul');
    for (const hit of row.match.hits) {
      const button = element('button', '', 'search-hit');
      button.type = 'button';
      button.dataset.hit = hit.start;
      button.append(element('small', 'Строка ' + hit.line), hit.before, element('mark', hit.match), hit.after);
      button.onclick = () => openDetail(row, hit, button);
      const item = element('li');
      item.append(button);
      list.append(item);
    }
    card.append(list);
    if (row.match.total > row.match.hits.length) {
      const more = element('button', 'Ещё совпадения · показано ' + row.match.hits.length + ' из ' + row.match.total, 'search-link');
      more.type = 'button';
      more.onclick = () => {
        const displayed = row.match.hits.length;
        row.match = searchNote(row.name, row.content, job.query, displayed + pageSize);
        const replacement = group(row);
        card.replaceWith(replacement);
        replacement.querySelectorAll('[data-hit]')[displayed]?.focus();
      };
      card.append(more);
    }
    return card;
  }
  function showResults() {
    const rows = job.rows;
    const found = rows.filter(row => row.match?.nameMatch || row.match?.total);
    const failures = rows.filter(row => row.error);
    results.replaceChildren(...found.map(row => group(row)), ...failures.map(row => group(row)));
    let summary = found.length ? 'Файлов с совпадениями — ' + found.length + '.' : 'Совпадений нет.';
    if (failures.length) {
      summary = 'Не удалось проверить все файлы. Прочитано ' + (rows.length - failures.length) + ' из ' + rows.length + '.' +
        (found.length ? ' ' + summary : '');
    }
    status.textContent = summary;
  }
  async function search() {
    const query = input.value.trim();
    if (!query || !online || !files.length) return;
    reset(false);
    const current = {query, controller: new AbortController(), rows: files.map(file => ({...file})), done: false};
    job = current;
    let checked = 0;
    status.textContent = 'Читаем выбранные файлы из Drive…';
    async function check(row) {
      try {
        const {meta, content} = await read(row, current.controller.signal);
        if (job !== current) return;
        row.version = meta.version;
        row.match = searchNote(row.name, content, query);
        if (row.match.nameMatch || row.match.total) {
          row.content = content;
          row.readAt = new Date().toLocaleString('ru-RU');
        }
      } catch (error) {
        if (job !== current) return;
        row.error = onError(row.id, error);
      }
      if (job === current) status.textContent = 'Проверено файлов — ' + (++checked) + ' из ' + current.rows.length + '.';
    }
    for (let i = 0; i < current.rows.length && job === current; i += 4) {
      await Promise.all(current.rows.slice(i, i + 4).map(check));
    }
    if (job !== current) return;
    current.done = true;
    showResults();
  }
  function invalidate(id, message, version) {
    if (!job?.done) return;
    const row = job.rows.find(file => file.id === id);
    if (!row || (version && row.version === version) || row.error === message) return;
    if (detail.dataset.fileId === id) closeDetail();
    delete row.content;
    delete row.match;
    row.error = message;
    showResults();
  }
  $('search-form').onsubmit = event => {
    event.preventDefault();
    if (!$('search-submit').disabled) run(search);
  };
  input.oninput = () => reset(false);
  $('search-clear').onclick = () => { reset(); input.focus(); };
  $('search-back').onclick = () => closeDetail(true);

  return {
    reset,
    setControls(connected, busy) {
      const ended = online && !connected;
      online = connected;
      locked = busy;
      if (ended) reset();
      else controls();
    },
    setFiles(ids, names) {
      if (ids.length === files.length && ids.every((id, i) => files[i].id === id && files[i].name === names[id])) return;
      files = ids.map(id => ({id, name: names[id]}));
      reset(false);
    },
    changed(meta) { invalidate(meta.id, 'Файл обновился. Нажми «Найти» ещё раз.', meta.version); },
    unavailable(id, message) { invalidate(id, message); }
  };
}
