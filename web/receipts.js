import {readableNote} from './core.js?v=0.14.0';
import {buildHandoffHistory} from './handoff.js?v=0.15.0';
import {taskRecord} from './today.js?v=0.20.0';
import {initReturnLink} from './return-link.js?v=0.20.0';

export function markRecord(container, readable, range) {
  if (!range) return null;
  const start = readable.offset(range.start), end = readable.offset(range.end);
  if (start >= end) return null;
  const mark = document.createElement('mark');
  mark.textContent = readable.text.slice(start, end);
  mark.tabIndex = -1;
  container.replaceChildren(readable.text.slice(0, start), mark, readable.text.slice(end));
  return mark;
}

function receiptRange(kind, file, op) {
  if (kind === 'task') return taskRecord(file.content, op).range;
  return buildHandoffHistory(file.meta.id, file.meta.name, file.content).records.find(record => record.op === op)?.sourceRange;
}

export function initReceipts(read) {
  const slots = [...document.querySelectorAll('[data-receipt]')];
  const panel = document.getElementById('receipt-detail');
  const heading = panel.querySelector('h2'), state = panel.querySelector('[role=status]');
  const preview = panel.querySelector('pre'), link = panel.querySelector('a'), back = panel.querySelector('button');
  const returnLink = initReturnLink(back);
  const last = new Map();
  let viewing = null;
  function close() {
    viewing = null;
    panel.hidden = true;
    heading.textContent = state.textContent = preview.textContent = '';
    link.removeAttribute('href');
    returnLink.clear();
  }
  back.addEventListener('click', close);
  async function open(kind, origin) {
    const receipt = last.get(kind);
    if (!receipt) return;
    close();
    const attempt = {receipt};
    viewing = attempt;
    origin.closest('[data-receipt]').after(panel);
    returnLink.remember(origin, document.getElementById('today-capture'));
    heading.textContent = receipt.name;
    state.textContent = 'Читаем запись из Drive…';
    link.href = 'https://drive.google.com/open?id=' + encodeURIComponent(receipt.fileId);
    preview.hidden = true;
    panel.hidden = false;
    let target = state;
    try {
      const file = await read(receipt);
      if (viewing !== attempt || !file) return;
      const range = receiptRange(kind, file, receipt.op);
      const mark = markRecord(preview, readableNote(file.content), range);
      if (mark) {
        preview.hidden = false;
        target = mark;
        state.textContent = 'Запись в контексте заметки';
      } else {
        state.textContent = 'Запись больше не удаётся однозначно определить. Открой исходный файл в Drive.';
      }
    } catch (error) {
      if (viewing !== attempt) return;
      state.textContent = error.message;
    }
    // A slow response must not take focus away from a new draft or another action.
    if (document.activeElement === origin || document.activeElement === document.body) {
      target.focus({preventScroll:true});
      target.scrollIntoView({block:'center'});
    }
  }
  for (const slot of slots) {
    const button = slot.querySelector('button');
    button.onclick = () => open(slot.dataset.receipt, button);
  }
  function remove(fileId) {
    if (!fileId || viewing?.receipt.fileId === fileId) close();
    for (const [kind, receipt] of last) {
      if (fileId && receipt.fileId !== fileId) continue;
      last.delete(kind);
      for (const slot of slots.filter(slot => slot.dataset.receipt === kind)) {
        slot.hidden = true;
        slot.querySelector('p').textContent = '';
      }
    }
  }
  return {
    remove,
    enable(enabled) { for (const slot of slots) slot.querySelector('button').disabled = !enabled; },
    confirm(kind, file, draft, cleaned) {
      if (viewing && last.get(kind) === viewing.receipt) close();
      const receipt = {fileId:file.meta.id, name:file.meta.name, op:draft.op};
      last.set(kind, receipt);
      const text = draft.text.trim().replace(/\s+/g, ' ');
      const snippet = text.length <= 80 ? text : text.slice(0, 79).replace(/[\uD800-\uDBFF]$/, '') + '…';
      const message = (kind === 'task' ? 'Последнее дело' : 'Последняя мысль') + ' в ' + receipt.name + ' — «' + snippet + '».';
      for (const slot of slots.filter(slot => slot.dataset.receipt === kind)) {
        slot.hidden = false;
        slot.querySelector('p').textContent = message + (cleaned ? '' : ' Drive подтвердил запись. Черновик остался на устройстве.');
      }
    }
  };
}
