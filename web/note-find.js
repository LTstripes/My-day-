import {readableNote} from './core.js?v=0.14.0';
import {searchNote} from './search-match.js?v=0.5.0';

const $ = id => document.getElementById(id);
const hitLimit = 1000;

export function initNoteFind() {
  const details = $('reader-find'), input = $('reader-find-query');
  const prev = $('reader-find-prev'), next = $('reader-find-next'), status = $('reader-find-status');
  const results = $('reader-find-results'), body = results.querySelector('pre');
  const content = $('reader-content');
  let file = null, readable = null, hits = [], total = 0, index = 0;

  function render() {
    const hit = hits[index];
    prev.disabled = next.disabled = hits.length < 2;
    if (!hit) {
      body.textContent = readable.text;
      results.scrollTop = 0;
      status.textContent = input.value.trim() ? 'Совпадений нет.' : 'Введи слово или фразу.';
      return;
    }
    const start = readable.offset(hit.start), end = readable.offset(hit.end);
    const mark = document.createElement('mark');
    mark.textContent = readable.text.slice(start, end);
    body.replaceChildren(readable.text.slice(0, start), mark, readable.text.slice(end));
    status.textContent = (index + 1) + ' из ' + total + ' · Строка ' + hit.line +
      (total > hits.length ? '. Доступны первые ' + hits.length + '. Уточни запрос.' : '');

    const box = mark.getClientRects()[0];
    if (box) {
      const top = box.top - results.getBoundingClientRect().top - results.clientTop;
      if (top < 0 || top + box.height > results.clientHeight) {
        results.scrollTop += top - (results.clientHeight - box.height) / 2;
      }
    }
  }
  function find() {
    readable ??= readableNote(file.content);
    const match = searchNote('', file.content, input.value, hitLimit);
    hits = match.hits;
    total = match.total;
    index = Math.max(0, Math.min(index, hits.length - 1));
    render();
  }
  function move(step) {
    if (hits.length < 2) return;
    index = (index + step + hits.length) % hits.length;
    render();
  }
  function clearResults() {
    readable = null;
    hits = [];
    total = 0;
    results.hidden = true;
    body.replaceChildren();
    status.textContent = '';
    prev.disabled = next.disabled = true;
    content.hidden = false;
  }

  details.addEventListener('toggle', () => {
    if (details.open && file) {
      content.hidden = true;
      results.hidden = false;
      find();
      input.focus({preventScroll: true});
    } else {
      details.open = false;
      clearResults();
    }
  });
  input.addEventListener('input', () => {
    if (!details.open || !file) return;
    index = 0;
    find();
  });
  function keydown(event) {
    if (!details.open || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      details.open = false;
      details.querySelector('summary').focus({preventScroll: true});
    } else if (event.target === input && event.key === 'Enter') {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    }
  }
  details.addEventListener('keydown', keydown);
  results.addEventListener('keydown', keydown);
  prev.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));

  return {
    isOpen() { return Boolean(file && details.open); },
    setFile(result) {
      const sameFile = result && file && file.meta.id === result.meta.id && file.meta.name === result.meta.name;
      if (!sameFile) {
        details.open = false;
        index = 0;
        input.value = '';
        clearResults();
      }
      const changed = !sameFile || result.meta.version !== file.meta.version || result.content !== file.content;
      file = result;
      if (changed) {
        readable = null;
        if (file && details.open) find();
      }
    }
  };
}
