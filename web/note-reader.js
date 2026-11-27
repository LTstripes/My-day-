import {noteView} from './note-views.js?v=0.16.0';
import {mountChart} from './note-chart.js?v=0.16.0';
import {initNoteFind} from './note-find.js?v=0.26.0';

const $ = id => document.getElementById(id);
const make = (tag, text) => {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
};

export function initNoteReader(onSelectionChange = () => {}) {
  const select = $('reader-select'), view = $('reader-view'), content = $('reader-content');
  const state = $('reader-state'), link = $('reader-link');
  const find = initNoteFind();
  let sourceId = null, sourceName = '', defaultView = 'text', override = null, current = null;
  let chartDraft = null, validChart = null;

  function render() {
    content.replaceChildren();
    const visible = Boolean(current);
    $('reader-display').hidden = !visible;
    link.hidden = !visible;
    validChart = null;
    if (!visible) { link.removeAttribute('href'); onSelectionChange(); return; }
    link.href = 'https://drive.google.com/open?id=' + encodeURIComponent(sourceId);
    const result = noteView(current.content, {override, defaultView});
    view.value = result.view;
    $('reader-full').hidden = result.view === 'text';
    $('reader-notice').textContent = result.notice || '';
    if (result.view === 'text') {
      content.append(make('pre', result.text));
    } else if (result.view === 'chart') {
      mountChart(content, result.tables, chartDraft ?? result.chart, (draft, selection) => {
        chartDraft = draft;
        validChart = selection;
        onSelectionChange();
      });
    } else if (result.view === 'plan') {
      content.append(make('h4', 'Ближайшее действие'), make('p', result.action));
    } else {
      for (const group of result.groups) {
        if (group.heading) content.append(make('h4', group.heading));
        const list = document.createElement('ul');
        for (const item of group.items) {
          const row = document.createElement('li');
          if (item.kind === 'open' || item.kind === 'done') {
            const done = item.kind === 'done';
            const mark = make('span', done ? '☑ ' : '☐ ');
            mark.setAttribute('aria-hidden', 'true');
            row.append(mark);
            row.append(make('span', done ? 'Выполнено: ' : 'Открыто: '));
            row.lastChild.className = 'visually-hidden';
          }
          row.append(item.text);
          list.append(row);
        }
        content.append(list);
      }
    }
    onSelectionChange();
  }
  function clear(message = '', error = false) {
    current = null;
    find.setFile(null);
    render();
    state.textContent = message || (sourceId ? 'Подключи Drive, чтобы прочитать заметку.' : '');
    state.classList.toggle('error', error);
  }
  function setFiles(files, id, roleView) {
    const chosen = files.find(file => file.id === id);
    const changed = sourceId !== (chosen?.id ?? null) || sourceName !== (chosen?.name ?? '');
    sourceId = chosen?.id ?? null;
    sourceName = chosen?.name ?? '';
    const roleChanged = defaultView !== roleView;
    defaultView = roleView;
    select.replaceChildren(new Option('Выбери заметку', ''));
    for (const file of files) {
      const duplicate = files.some(other => other.id !== file.id && other.name === file.name);
      select.add(new Option(duplicate ? file.name + ' · ID ' + file.id : file.name, file.id));
    }
    select.value = sourceId ?? '';
    $('reader-choices').hidden = !files.length;
    if (changed) { override = null; chartDraft = null; clear(); }
    else if (roleChanged && current) render();
  }
  view.onchange = () => { override = view.value; render(); };
  $('reader-full').onclick = () => { override = 'text'; render(); view.focus(); };
  return {
    setFiles, clear, findText: find.findText,
    loading(id) {
      const message = 'Читаем заметку из Drive…';
      if (id !== sourceId || !current || !find.isOpen()) { clear(message); return; }
      state.textContent = message;
      state.classList.remove('error');
    },
    opened() { return current; },
    selection() {
      if (!current || (view.value === 'chart' && !validChart)) return null;
      const meta = current.meta;
      return {fileId:meta.id, name:meta.name, version:meta.version, canEdit:Boolean(meta.capabilities?.canEdit),
        view:view.value, ...(validChart ? {chart:{...validChart}} : {})};
    },
    reset() { override = null; chartDraft = null; clear(); },
    show(result) {
      if (result.meta.id !== sourceId || result.meta.name !== sourceName) return;
      if (chartDraft && current?.meta.version !== result.meta.version) {
        // Line numbers disambiguate identical tables only in their original snapshot.
        delete chartDraft.line;
        if (!override) chartDraft = null;
      }
      current = result;
      find.setFile(result);
      render();
      state.textContent = 'Прочитано из Drive · ' + new Date().toLocaleString('ru-RU');
      state.classList.remove('error');
    }
  };
}
