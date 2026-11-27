import {readableNote} from './core.js?v=0.14.0';
import {searchNote} from './search-match.js?v=0.5.0';

const $ = id => document.getElementById(id);
const pageSize = 5;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function initNoteSearch({run, read, onError, openInReader}) {
  const input = $('search-query'), results = $('search-results'), detail = $('search-detail');
  const scope = $('search-file'), openReader = $('search-open-reader'), status = $('search-status');
  let files = [], online = false, locked = false, job = null, opener = null, readerTarget = null;

  function sameName(file) {
    return files.some(other => other.name === file.name && other.id !== file.id);
  }
  function listScopes() {
    const selected = scope.value;
    scope.replaceChildren(new Option('Все выбранные файлы', ''));
    for (const file of files) {
      const label = sameName(file) ? file.name + ' · ID ' + file.id : file.name;
      scope.add(new Option(label, file.id));
    }
    scope.value = files.some(file => file.id === selected) ? selected : '';
  }

  function hint() {
    if (!online) return 'Для поиска подключи Google Drive.';
    if (!files.length) return 'Сначала выбери файл в разделе «Мои заметки» или «Планы».';
    return scope.value ? 'Поиск перечитает выбранный файл из Drive.' : 'Поиск перечитает выбранные заметки и планы из Drive.';
  }
  function readerControls() {
    openReader.hidden = !readerTarget;
    openReader.disabled = !readerTarget || !online || locked;
  }
  function controls() {
    input.disabled = scope.disabled = !online || !files.length;
    $('search-submit').disabled = input.disabled || locked || !input.value.trim();
    $('search-clear').hidden = !input.value;
    readerControls();
    if (!job) status.textContent = hint();
  }
  function closeDetail(refocus = false) {
    const previous = opener;
    opener = null;
    readerTarget = null;
    readerControls();
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
    readerTarget = {id: row.id, name: row.name, version: row.version, query: job.query, offset: hit?.start ?? null};
    readerControls();
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
    if (sameName(row)) {
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
      summary = scope.value ? 'Не удалось прочитать выбранный файл.' :
        'Не удалось проверить все файлы. Прочитано ' + (rows.length - failures.length) + ' из ' + rows.length + '.' +
        (found.length ? ' ' + summary : '');
    }
    status.textContent = summary;
  }
  async function search() {
    const query = input.value.trim();
    const selected = scope.value;
    const sources = selected ? files.filter(file => file.id === selected) : files;
    if (!query || !online || !sources.length) return;
    reset(false);
    const current = {query, controller: new AbortController(), rows: sources.map(file => ({...file})), done: false};
    job = current;
    let checked = 0;
    status.textContent = selected ? 'Читаем выбранный файл из Drive…' : 'Читаем выбранные файлы из Drive…';
    async function check(row) {
      let result;
      if (!row.error) {
        try {
          result = await read(row, current.controller.signal);
        } catch (error) {
          if (job !== current) return;
          if (!row.error) row.error = onError(row, error);
        }
      }
      if (job !== current) return;
      if (result && !row.error) {
        const {meta, content} = result;
        row.version = meta.version;
        row.match = searchNote(row.name, content, query);
        if (row.match.nameMatch || row.match.total) {
          row.content = content;
          row.readAt = new Date().toLocaleString('ru-RU');
        }
      }
      status.textContent = 'Проверено файлов — ' + (++checked) + ' из ' + current.rows.length + '.';
    }
    for (let i = 0; i < current.rows.length && job === current; i += 4) {
      await Promise.all(current.rows.slice(i, i + 4).map(check));
    }
    if (job !== current) return;
    current.done = true;
    showResults();
  }
  function invalidate(id, message, version) {
    if (!job) return;
    const row = job.rows.find(file => file.id === id);
    if (!row || (version && row.version === version) || row.error === message) return;
    if (detail.dataset.fileId === id) closeDetail();
    delete row.content;
    delete row.match;
    row.error = message;
    if (job.done) showResults();
  }
  $('search-form').onsubmit = event => {
    event.preventDefault();
    if (!$('search-submit').disabled) run(search);
  };
  input.oninput = () => reset(false);
  scope.onchange = () => reset(false);
  $('search-clear').onclick = () => { reset(); input.focus(); };
  $('search-back').onclick = () => closeDetail(true);
  openReader.onclick = () => {
    const target = readerTarget;
    if (target && !openReader.disabled) {
      openInReader({...target, origin: () => readerTarget === target ? openReader : null});
    }
  };

  listScopes();
  return {
    reset,
    setControls(connected, busy) {
      const ended = online && !connected;
      online = connected;
      locked = busy;
      if (ended) {
        scope.value = '';
        reset();
      } else controls();
    },
    setFiles(next) {
      if (next.length === files.length && next.every(({id, name, note, plan}, i) =>
        files[i].id === id && files[i].name === name && files[i].note === note && files[i].plan === plan)) return;
      files = next;
      listScopes();
      reset(false);
    },
    changed(meta) { invalidate(meta.id, 'Файл обновился. Нажми «Найти» ещё раз.', meta.version); },
    unavailable(id, message) { invalidate(id, message); }
  };
}
