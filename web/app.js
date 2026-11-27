import {INBOX, NOW, readableNote, recordConflictMessage, recordDelivery, TASKS, TEST_FILE, writableNote} from './core.js?v=0.14.0';
import {DEVICE_KEY, LEGACY_DRAFT, newDevice, preferredFile, readDevice, readDraft, validId, validPickerKey, validProject, withoutSource} from './device.js?v=0.21.0';
import {driveError, markdownSnapshot, planSnapshot, saveDraft, snapshot} from './drive.js?v=0.18.1';
import {initReturnLink} from './return-link.js?v=0.20.0';
import {initNoteReader} from './note-reader.js?v=0.18.0';
import {saveAttention, saveView} from './save-view.js?v=0.18.0';
import {attentionDate, initAttention} from './attention.js?v=0.21.0';
import {addTask, completeTask} from './complete-task.js?v=0.16.0';
import {firstPlanAction, insertTask} from './today.js?v=0.16.0';
import {clearDay, dayFileFailed, onTaskCompletion, onTaskSourceChange, setTaskActionsEnabled, showDayFile, syncDaySources, taskSource, updateDayDate} from './day-view.js?v=0.17.0';
import {initTaskEntry} from './task-entry.js?v=0.19.0';
import {initNoteSearch} from './search-view.js?v=0.14.0';
import {buildHandoffHistory} from './handoff.js?v=0.15.0';
import {initReceipts, markRecord} from './receipts.js?v=0.20.0';
import {leaveForReload, prepareReload, resumeReload} from './reload.js?v=0.6.1';

const CLIENT = '327713401108-rdi4uv2duskfvn8d368i2ui56uhqsulo.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const $ = id => document.getElementById(id);
const compactScreen = window.matchMedia('(max-width: 680px)');
$('page-menu').open = !compactScreen.matches;
compactScreen.addEventListener('change', event => { $('page-menu').open = !event.matches; });
$('page-menu').addEventListener('click', event => {
  if (compactScreen.matches && event.target.closest('a')) $('page-menu').open = false;
});

let device = newDevice(), personal = false, stored = null, legacy = null, storageFault = false;
let client = null, session = null, expiryTimer, pickerReady = false, pickerWindow = null, awaitingLogin = false, busy = false;
let promptNext = null, hasConnected = false, readAt = '', refreshAfterBusy = false;
let handoff = null, networkChanged = false;
let returnCheck = null;
let hiddenSince = null, overviewDue = false;
const planReads = new Map();
const planCards = new Map();
let resuming = false;
const attention = initAttention($('today-attention'), openAttentionNote);
const reader = initNoteReader(readerSelectionChanged);
const readerReturn = initReturnLink($('reader-back'));
let readerAttempt = null;
// A single action may read the same ID through several roles. A Drive access
// refusal invalidates every response for that ID until a new action starts.
const deniedFileReads = new Set();
let readOnlyCaptureId = null;
const taskEntry = initTaskEntry({edit: editTaskDraft, discard: discardTaskDraft, submit: submitTask, changed: controls});
const receipts = initReceipts(readReceipt);
onTaskSourceChange(controls);
const search = initNoteSearch({
  run: action => run(action, 'search'),
  async read(file, signal) {
    const current = session;
    const requestFile = sessionRequest(current, signal);
    const result = await (file.note ? snapshot(file.id, requestFile, file.name, {viewOnly: true}) :
      file.plan ? planSnapshot(file.id, requestFile, file.name) : markdownSnapshot(file.id, requestFile, file.name));
    if (signal.aborted || current !== session || deniedFileReads.has(file.id)) return;
    if (Date.now() >= current.until) { expire(); return; }
    if (networkChanged || !navigator.onLine) throw new Error('Связь прервалась. Повтори поиск.');
    if (file.plan) showPlanResult(result);
    showReaderAndAttention(result);
    if (handoff?.fileId === file.id &&
        (handoff.version !== result.meta.version || !result.meta.capabilities?.canEdit)) setHandoff(null);
    return result;
  },
  onError(file, error) {
    if (device.readerId === file.id) reader.clear(errorMessage(error), true);
    applyReadError(file.id, error, false, file.plan);
    return errorMessage(error);
  }
});

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function storageWarning(message = '') {
  storageFault = Boolean(message);
  $('storage-warning').textContent = message;
  $('storage-warning').hidden = !message;
}
function persist() {
  if (!personal) return true;
  try {
    if (localStorage.getItem(DEVICE_KEY) !== stored) {
      storageWarning('Настройки изменились в другой вкладке. Скопируй свой черновик и обнови эту вкладку.');
      return false;
    }
    const next = JSON.stringify(device);
    localStorage.setItem(DEVICE_KEY, next);
    stored = next;
    storageWarning();
    return true;
  } catch {
    storageWarning('Браузер не сохранил изменения. Оставь вкладку открытой или скопируй черновик.');
    return false;
  }
}
function restore() {
  try {
    stored = localStorage.getItem(DEVICE_KEY);
    if (stored !== null) {
      device = readDevice(stored);
      personal = true;
    }
    const raw = localStorage.getItem(LEGACY_DRAFT);
    if (raw !== null) legacy = readDraft(JSON.parse(raw), true);
  } catch {
    storageWarning('Не удалось прочитать локальные данные. Можно работать в этой вкладке или забыть настройки.');
  }
}
function setHandoff(target, confirmedOp = null) {
  const previous = handoff && handoff.fileId === target?.fileId ? handoff : null;
  const checking = !confirmedOp && returnCheck?.fileId === target?.fileId ? returnCheck : null;
  handoff = target;
  $('handoff-queue').hidden = $('today-handoff').hidden = !target;
  const name = target && device.noteNames[target.fileId];
  const sameName = target && device.fileIds.some(id => id !== target.fileId && device.noteNames[id] === name);
  $('handoff-source').textContent = target ? name + (sameName ? ' · ID ' + target.fileId : '') : '';
  $('handoff-counts').textContent = '';
  const filter = $('handoff-filter');
  filter.value = previous?.filter ?? 'all';
  if (target) {
    target.selectedOp = confirmedOp ?? checking?.op ?? previous?.selectedOp ?? null;
    const selected = target.records.find(record => record.op === target.selectedOp);
    // Keep an explicitly chosen thought visible when its answer changes group.
    if (selected && filter.value !== 'all' && selected.resultState !== filter.value) filter.value = 'all';
    const counts = {missing: 0, saved: 0, ambiguous: 0};
    for (const record of target.records) counts[record.resultState]++;
    $('handoff-counts').textContent = 'Без ответа: ' + counts.missing + ' · С ответом: ' + counts.saved +
      ' · Неоднозначные: ' + counts.ambiguous;
  }
  if (checking?.phase === 'due') checking.phase = 'ready';
  renderHandoffQueue(checking);
}
function renderHandoffQueue(checking = null) {
  const select = $('handoff-record');
  select.replaceChildren();
  const filter = $('handoff-filter').value;
  const records = handoff?.records ?? [];
  const selected = records.find(record => record.op === handoff?.selectedOp);
  const lostRecord = handoff?.selectedOp && !selected;
  if (handoff) {
    handoff.filter = filter;
    for (const [index, record] of records.entries()) {
      if (filter !== 'all' && record.resultState !== filter) continue;
      const position = record.op === handoff.defaultOp ? 'Последняя' : String(index + 1);
      select.add(new Option(position + ' · ' + record.snippet, record.op));
    }
  }
  const hasOptions = select.options.length > 0;
  $('handoff').hidden = !hasOptions;
  if (hasOptions) {
    if (lostRecord || (filter === 'all' && !handoff.defaultOp && !selected)) {
      const placeholder = new Option('Выбери сохранённую запись', '');
      placeholder.disabled = true;
      select.add(placeholder, 0);
      select.value = '';
    } else if (selected) {
      select.value = selected.op;
    }
  }
  const empty = $('handoff-empty');
  empty.hidden = !handoff || hasOptions;
  empty.textContent = empty.hidden ? '' : records.length ? 'В этой группе пока нет мыслей.' :
    'Здесь пока нет мыслей, которые можно выбрать для разбора.';
  selectHandoffRecord(checking && selected?.op === checking.op && selected.resultState === 'missing');
  if (lostRecord) {
    const message = 'Выбранную запись больше не удаётся определить.';
    if (hasOptions) $('handoff-result-state').textContent = message + ' Выбери запись из списка.';
    else empty.textContent = message + ' ' + empty.textContent;
  }
}
function closeHandoffDetails() {
  returnCheck = null;
  if (handoff) handoff.copyAttempt = null;
  $('handoff-details').hidden = true;
  $('handoff-open').setAttribute('aria-expanded', 'false');
  $('handoff-command').value = '';
  $('handoff-status').textContent = '';
}
function selectHandoffRecord(keepDetails = false) {
  closeHandoffReader();
  const record = handoff?.records.find(record => record.op === $('handoff-record').value);
  if (handoff) {
    handoff.record = record;
    const records = handoff.records;
    const index = records.indexOf(record);
    handoff.next = records.find((other, i) => i > index && other.resultState === 'missing') ??
      records.find((other, i) => i < index && other.resultState === 'missing');
  }
  if (!keepDetails) closeHandoffDetails();
  const state = record?.resultState;
  $('handoff-show-source').hidden = !record?.sourceRange;
  $('handoff-show-answer').hidden = state !== 'saved' || !record.answerRange;
  $('handoff-result').textContent = record?.result ?? '';
  $('handoff-result').hidden = !record?.result;
  $('handoff-result-state').textContent = state === 'saved' ? 'Ответ сохранён в Drive.' :
    state === 'missing' ? 'Ответа в Drive пока нет.' :
    state === 'ambiguous' ? 'Ответ в Drive не удалось однозначно подтвердить.' :
    handoff?.records.length ? 'Последнюю запись нельзя однозначно определить. Выбери запись из списка.' : '';
  $('handoff-open').textContent = record && record.op === handoff.defaultOp ?
    'Разобрать последнюю запись' : 'Разобрать выбранную запись';
}
function handoffAvailable() {
  if (session && Date.now() >= session.until) expire();
  return handoff && session && navigator.onLine && !busy && !pickerWindow;
}
function closeHandoffReader() {
  if ($('handoff-back').hidden) return;
  $('preview').textContent = handoff?.readable.text ?? 'Обнови заметку, чтобы снова прочитать её.';
  $('handoff-back').hidden = true;
}
function openHandoffReader(range) {
  if (!handoffAvailable() || !range) return;
  const mark = markRecord($('preview'), handoff.readable, range);
  if (!mark) return;
  $('handoff-back').hidden = false;
  mark.focus({preventScroll: true});
  mark.scrollIntoView({block: 'center'});
}
$('handoff-show-source').onclick = () => openHandoffReader(handoff?.record?.sourceRange);
$('handoff-show-answer').onclick = () => {
  if (handoff?.record?.resultState === 'saved') openHandoffReader(handoff.record.answerRange);
};
$('handoff-back').onclick = () => {
  if (!handoffAvailable()) return;
  closeHandoffReader();
  $('handoff-record').focus();
};
$('today-handoff').onclick = () => {
  if (!handoffAvailable()) return;
  closeHandoffReader();
  $('handoff-filter').focus();
};
$('handoff-filter').onchange = () => {
  if (!handoffAvailable()) return;
  const filter = $('handoff-filter').value;
  const current = handoff.record;
  handoff.selectedOp = current && (filter === 'all' || current.resultState === filter) ? current.op : null;
  renderHandoffQueue();
  handoff.selectedOp = handoff.record?.op ?? null;
  controls();
};
$('handoff-next').onclick = () => {
  if (!handoffAvailable() || !handoff.next) return;
  if (handoff.filter !== 'all') $('handoff-filter').value = 'missing';
  handoff.selectedOp = handoff.next.op;
  renderHandoffQueue();
  controls();
  $('handoff-record').focus();
};
$('handoff-record').onchange = () => {
  if (!handoffAvailable()) return;
  selectHandoffRecord();
  handoff.selectedOp = handoff.record?.op ?? null;
  controls();
};
$('handoff-open').onclick = () => {
  if (!handoffAvailable() || !handoff.record?.command) return;
  if (!$('handoff-details').hidden) { closeHandoffDetails(); return; }
  $('handoff-details').hidden = false;
  $('handoff-open').setAttribute('aria-expanded', 'true');
  $('handoff-command').value = handoff.record.command;
  $('handoff-status').textContent = '';
  handoff.selectedOp = handoff.record.op;
  returnCheck = {fileId: handoff.fileId, op: handoff.record.op, phase: 'ready'};
};
function leaveHandoff() {
  if (returnCheck && !pickerWindow) returnCheck.phase = 'away';
}
function returnToHandoff() {
  if (!document.hidden && returnCheck?.phase === 'away') returnCheck.phase = 'due';
  checkOnReturn();
}
function checkOnReturn() {
  if (document.hidden || busy || awaitingLogin || pickerWindow || resuming || storageFault ||
      !session || !navigator.onLine || Date.now() >= session.until) return;
  const check = returnCheck?.phase === 'due' && handoffAvailable() ? returnCheck : null;
  if (overviewDue) {
    overviewDue = false;
    if (hasOverviewSources()) {
      run(() => refreshOverview(check), 'overview');
      return;
    }
  }
  if (check) {
    check.phase = 'ready';
    run(() => refreshFiles([check.fileId], check), 'return');
  }
}
$('handoff-copy').onclick = async () => {
  if (!handoffAvailable() || !handoff.record?.command || $('handoff-details').hidden) return;
  const attempt = {};
  handoff.copyAttempt = attempt;
  let copied = false;
  try {
    await navigator.clipboard.writeText(handoff.record.command);
    copied = true;
  } catch { /* The visible text remains available when clipboard permission is missing. */ }
  if (!handoffAvailable() || handoff.copyAttempt !== attempt) return;
  if (copied) {
    $('handoff-status').textContent = 'Команда скопирована. Вставь её в чат с помощником.';
  } else {
    $('handoff-command').focus();
    $('handoff-command').select();
    $('handoff-status').textContent = 'Текст команды выделен. Скопируй его вручную через меню браузера или клавишами Ctrl+C (⌘C на Mac).';
  }
};
function clearPreview() {
  placeCapture(false);
  setHandoff(null);
  readAt = '';
  $('preview').textContent = 'Здесь появится текст из Drive.';
  $('fresh').textContent = 'Файл ещё не прочитан в этом подключении.';
  $('drive-link').hidden = true;
  $('drive-link').removeAttribute('href');
}
const planAccessMessage = 'Нет доступа к плану. Проверь аккаунт Google и снова выбери этот файл в разделе «Планы».';
function planLabel(plan) {
  if (!plan) return '';
  const duplicate = device.plans.some(other => other.id !== plan.id && other.name === plan.name);
  return duplicate ? plan.name + ' · ID ' + plan.id : plan.name;
}
function renderPlanCard(prefix, plan) {
  const card = planCards.get(plan?.id);
  $(prefix + '-source').textContent = planLabel(plan);
  const action = $(prefix + '-action');
  action.textContent = card?.action ?? '';
  action.hidden = !card?.action;
  const state = $(prefix + '-state');
  state.textContent = card?.message ?? (plan ? 'Подключи Google Drive, чтобы прочитать план.' : 'Выбери Markdown-файл проекта или поездки.');
  state.classList.toggle('error', Boolean(card?.error));
  const link = $(prefix + '-link');
  link.hidden = !card?.fresh;
  if (card?.fresh) link.href = 'https://drive.google.com/open?id=' + encodeURIComponent(plan.id);
  else link.removeAttribute('href');
}
function renderPlans() {
  renderPlanCard('plan', device.plan);
  $('plan-next').hidden = $('plan-action').hidden;
  const pinned = device.plans?.find(plan => plan.id === device.pinnedPlanId);
  renderPlanCard('today-plan', pinned);
  $('today-plan').hidden = !pinned;
  const isPinned = Boolean(pinned && pinned.id === device.plan?.id);
  $('plan-pin').hidden = !device.plan;
  $('plan-pin').setAttribute('aria-pressed', String(isPinned));
  $('plan-pin').textContent = isPinned ? 'Открепить от «Сегодня»' : 'Закрепить на экране «Сегодня»';
}
function listPlans() {
  const select = $('plan-select');
  select.replaceChildren();
  for (const plan of device.plans ?? []) select.add(new Option(planLabel(plan), plan.id));
  select.value = device.plan?.id ?? '';
  $('plan-list').hidden = select.options.length < 2;
  $('plan-pick').textContent = device.plan ? 'Добавить план' : 'Выбрать план';
  for (const id of planCards.keys()) {
    if (id !== device.plan?.id && id !== device.pinnedPlanId) planCards.delete(id);
  }
  renderPlans();
}
function clearPlans(message, error = false) {
  planReads.clear();
  planCards.clear();
  if (message) {
    for (const id of [device.plan?.id, device.pinnedPlanId].filter(Boolean)) planCards.set(id, {message, error});
  }
  renderPlans();
}
function setPlanCard(id, card) {
  if (!id || (id !== device.plan?.id && id !== device.pinnedPlanId)) return;
  planCards.set(id, card);
  renderPlans();
}
function showPlanResult(result) {
  if (networkChanged || !navigator.onLine || !session || Date.now() >= session.until) return;
  if (!device.plans?.some(plan => plan.id === result.meta.id && plan.name === result.meta.name)) return;
  const action = firstPlanAction(result.content);
  const message = (action ? '' : 'В плане нет незавершённых действий. ') + 'Прочитано из Drive · ' + new Date().toLocaleString('ru-RU');
  setPlanCard(result.meta.id, {action, message, fresh: true});
}
function planFailed(id, error) {
  attention.unavailable(id);
  if (error.access === 'file') {
    receipts.remove(id);
    deniedFileReads.add(id);
    if (id === device.readerId) reader.clear(errorMessage(error), true);
  }
  planReads.delete(id);
  setPlanCard(id, {message: error.access === 'file' ? planAccessMessage : errorMessage(error), error: true});
}
async function readPlan(id = device.plan?.id, picking = false, read = planSnapshot) {
  if (!id) return;
  const current = session;
  const attempt = {};
  planReads.set(id, attempt);
  const known = device.plans?.find(plan => plan.id === id);
  setPlanCard(id, {message: 'Читаем план из Drive…'});
  try {
    const result = await read(id, sessionRequest(current), picking ? undefined : known?.name);
    if (session !== current || planReads.get(id) !== attempt || deniedFileReads.has(id)) return;
    if (Date.now() >= current.until) { expire(); return; }
    if (networkChanged || !navigator.onLine) { clearPlans('Связь прервалась. Повтори чтение плана.', true); return; }
    if (picking) {
      const plan = {id, name: result.meta.name};
      const plans = known ? device.plans.map(item => item.id === id ? plan : item) : [...(device.plans ?? []), plan];
      if (!savePlanSelection(plan, plans)) return;
      $('setup').open = false;
    }
    showPlanResult(result);
    showReaderAndAttention(result);
    search.changed(result.meta);
    return true;
  } catch (error) {
    if (session !== current || planReads.get(id) !== attempt) return;
    if (error.access === 'expired' || error.access === 'consent') { fail(error); return; }
    if (error.access === 'file' && device.fileIds.includes(id)) applyReadError(id, error);
    else {
      planFailed(id, error);
      search.unavailable(id, error.access === 'file' ? planAccessMessage : errorMessage(error));
    }
    if (picking && device.plan?.id !== id) {
      const message = error.access === 'file' ? planAccessMessage : errorMessage(error);
      $('plan-state').textContent = message + (device.plan ? ' Сохранён прежний выбор плана.' : '');
      $('plan-state').classList.add('error');
    }
  } finally {
    if (planReads.get(id) === attempt) planReads.delete(id);
  }
}
function savePlanSelection(plan, plans) {
  const previous = device;
  device = {...device, plan, plans};
  if (!persist()) {
    device = previous;
    listPlans();
    return false;
  }
  listPlans();
  syncSearchFiles();
  return true;
}
function readPlans(ids) {
  return Promise.all([...new Set(ids.filter(Boolean))].map(id => readPlan(id)));
}
async function readReader(id = device.readerId, selecting = false, expectedName) {
  if (!id) return;
  const current = session, attempt = {};
  const known = sourcesFor(device).get(id);
  readerAttempt = attempt;
  reader.clear('Читаем заметку из Drive…');
  const valid = () => current === session && readerAttempt === attempt &&
    (!known || sourcesFor(device).get(id)?.name === known.name);
  try {
    const result = await markdownSnapshot(id, sessionRequest(current), expectedName ?? (selecting ? undefined : known?.name));
    if (!valid() || deniedFileReads.has(id)) return;
    if (Date.now() >= current.until) { expire(); return; }
    if (!navigator.onLine || networkChanged) { reader.clear('Связь прервалась. Повтори чтение заметки.', true); return; }
    if (selecting) {
      const note = {id, name: result.meta.name};
      const notes = [...(device.notes ?? [])];
      const index = notes.findIndex(other => other.id === id);
      if (index < 0) notes.push(note);
      else notes[index] = note;
      const previous = device;
      device = {...device, notes, readerId: id};
      if (!persist()) { device = previous; syncSearchFiles(); return; }
      syncSearchFiles();
      $('setup').open = false;
    }
    showReaderAndAttention(result);
    search.changed(result.meta);
  } catch (error) {
    if (!valid()) return;
    if (error.access === 'expired' || error.access === 'consent') { fail(error); return; }
    applyReadError(id, error);
    const previous = sourcesFor(device).get(device.readerId);
    const failedSelection = selecting && id !== device.readerId;
    let message = errorMessage(error);
    if (failedSelection) {
      const label = expectedName || known?.name;
      message = (label ? 'Не удалось открыть «' + label + '». ' : 'Не удалось открыть выбранный файл. ') + message;
      if (previous) message += ' В списке осталась «' + previous.name + '». Нажми «Обновить заметку», чтобы прочитать её.';
    }
    reader.clear(message, true);
    $('reader-select').value = device.readerId ?? '';
  } finally {
    if (valid()) readerAttempt = null;
  }
}
function syncFields() {
  $('remember').checked = personal;
  $('key').value = device.pickerKey;
  $('project').value = device.project;
  $('setup').open = !device.pickerKey;
  $('thought').value = device.draft?.text ?? '';
}
function sourcesFor(device) {
  const files = new Map(device.fileIds.map(id => [id, {id, name: device.noteNames[id], note: true, plan: false}]));
  for (const {id, name} of device.plans ?? (device.plan ? [device.plan] : [])) {
    // Keep note validation for a file selected in both sections under the same name.
    files.set(id, {id, name, note: files.get(id)?.name === name, plan: true});
  }
  for (const {id, name} of device.notes ?? []) {
    if (files.get(id)?.name !== name) files.set(id, {id, name, note: false, plan: false});
  }
  return files;
}
function syncSearchFiles() {
  attention.setSources(device.notes ?? []);
  const files = [...sourcesFor(device).values()];
  search.setFiles(files);
  const chosen = files.find(file => file.id === device.readerId);
  const roleView = chosen?.note && chosen.id === preferredFile(device, TASKS) ? 'list' :
    chosen?.plan ? 'plan' : 'text';
  reader.setFiles(files, device.readerId, roleView);
  const select = $('source-select'), previous = select.value;
  select.replaceChildren(new Option('Выбери заметку или план', ''));
  for (const file of files) {
    const duplicate = files.some(other => other.id !== file.id && other.name === file.name);
    select.add(new Option(duplicate ? file.name + ' · ID ' + file.id : file.name, file.id));
  }
  select.value = files.some(file => file.id === previous) ? previous : '';
  $('source-manager').hidden = !files.length;
  sourceControls();
}
function sourceControls() {
  const id = $('source-select').value;
  const hasDraft = id && (id === device.draft?.fileId || id === device.taskDraft?.fileId || id === legacy?.fileId);
  const locked = Boolean(busy || awaitingLogin || pickerWindow || resuming || storageFault);
  $('source-select').disabled = locked;
  $('source-remove').disabled = locked || !id || Boolean(hasDraft);
  $('source-hint').textContent = hasDraft
    ? (id === device.taskDraft?.fileId ? 'К файлу привязан черновик дела. Сохрани его или очисти.' :
      'К файлу привязан черновик. Сначала сохрани мысль в Drive.')
    : 'Файл останется в Google Drive.';
}
function listFiles() {
  syncDaySources(device);
  syncSearchFiles();
  const select = $('known');
  select.replaceChildren();
  for (const id of device.fileIds) select.add(new Option(device.noteNames[id] + ' · ' + id, id));
  select.value = device.activeId ?? '';
  const name = device.noteNames[device.activeId];
  const readOnly = Boolean(name && !writableNote(name));
  $('first-pick').hidden = Boolean(device.activeId);
  $('known-files').hidden = device.fileIds.length < 2;
  $('file').textContent = device.activeId ? name + ' · ID ' + device.activeId : 'Файл ещё не выбран.';
  $('capture').hidden = readOnly;
  if (readOnly || !device.activeId) placeCapture(false);
  $('notes').classList.toggle('reading', readOnly);
  $('preview-title').textContent = name ? name + (readOnly ? ' · только чтение' : '') : 'Содержимое файла';
  $('target').textContent = name ? 'Запись в ' + name : 'Текст мысли';
}
function rememberFile(id, name) {
  if (!device.fileIds.includes(id)) device.fileIds.push(id);
  device.noteNames[id] = name;
}
function selectId(id, name) {
  if (device.activeId !== id) clearPreview();
  rememberFile(id, name);
  device.activeId = id;
  listFiles();
  return persist();
}
function captureId() {
  return device.noteNames[device.activeId] === INBOX ? device.activeId : preferredFile(device, INBOX);
}
let attentionSnapshot = null;
let savedAttention = null;
function renderAttentionEditor() {
  const opened = reader.opened();
  if (opened === attentionSnapshot) return;
  const details = $('reader-attention');
  if (opened?.meta.id !== attentionSnapshot?.meta.id) details.open = false;
  attentionSnapshot = opened;
  savedAttention = opened ? attentionDate(opened.content) : null;
  $('reader-attention-date').value = savedAttention?.day ?? '';
  $('reader-attention-current').textContent = savedAttention?.invalid ? 'Текущую дату не удалось распознать.' :
    savedAttention?.instant != null ? 'Точный срок: ' + new Date(savedAttention.instant).toLocaleString('ru-RU', {
      dateStyle: 'medium', timeStyle: 'long'
    }) : savedAttention?.day ? 'Сохранена календарная дата.' : 'Дата пока не задана.';
  $('reader-attention-clear').hidden = !savedAttention;
  $('reader-attention-status').textContent = '';
}
function updateAttentionButtons() {
  const opened = reader.opened();
  const input = $('reader-attention-date');
  const reason = opened && !readerNote(opened.meta.id, opened.meta.name) ? 'Дата внимания доступна для файла, выбранного в «Моих заметках».' :
    opened?.meta.name === TEST_FILE ? 'Для даты внимания выбери обычную заметку Markdown.' :
    opened && !opened.meta.capabilities?.canEdit ? 'Для изменения даты нужен доступ на редактирование.' : '';
  const locked = busy || !session || Date.now() >= session.until || !navigator.onLine || storageFault || !opened || reason;
  input.disabled = Boolean(locked);
  $('reader-attention-save').disabled = Boolean(locked || !input.value || !input.validity.valid || input.value === savedAttention?.day);
  $('reader-attention-clear').disabled = Boolean(locked);
  $('reader-attention-hint').textContent = reason || (savedAttention?.instant != null ?
    'Сохранение календарной даты заменит точный срок.' : '');
}
function readerSelectionChanged() {
  $('reader-save-status').textContent = '';
  renderAttentionEditor();
  updateAttentionButtons();
  updateViewSaveButton();
}
function updateViewSaveButton() {
  const selected = reader.selection();
  const locked = busy || !session || Date.now() >= session.until || !navigator.onLine || storageFault;
  const reason = selected && !readerNote(selected.fileId, selected.name) ? 'Для этого плана вид переключается только на экране.' :
    selected?.name === TEST_FILE ? 'Для тестового шаблона доступно только временное переключение вида.' :
    selected && !selected.canEdit ? 'Для сохранения вида нужен доступ на редактирование.' : '';
  $('reader-save').disabled = Boolean(locked || !selected || reason);
  $('reader-save-hint').textContent = reason;
  $('reader-display').inert = busy === 'save-view' || busy === 'save-attention';
}
function controls() {
  updateAttentionButtons();
  updateViewSaveButton();
  const locked = Boolean(busy || awaitingLogin || pickerWindow || resuming);
  const editingLocked = locked && !['search', 'return', 'plan', 'reader', 'overview'].includes(busy);
  const connected = Boolean(session && Date.now() < session.until);
  const draft = device.draft;
  const canWrite = writableNote(device.noteNames[device.activeId]);
  $('today-handoff').disabled = $('handoff-filter').disabled = locked || !connected || !handoff;
  $('handoff-record').disabled = locked || !connected || !handoff?.records.length;
  $('handoff-next').disabled = locked || !connected || !handoff?.next;
  $('handoff-back').disabled = $('handoff-show-source').disabled = $('handoff-show-answer').disabled = locked || !connected;
  $('handoff-open').disabled = $('handoff-copy').disabled = locked || !connected || !handoff?.record?.command;
  $('remember').disabled = locked;
  $('key').disabled = $('project').disabled = locked;
  $('connect').disabled = locked || !client || connected;
  $('connect').toggleAttribute('data-connected', connected);
  $('connect').textContent = awaitingLogin ? 'Ожидаем вход в Google…' : connected ? 'Google Drive подключён' :
    (hasConnected || device.activeId || device.plan || device.readerId ? 'Подключиться снова' : 'Подключить Google Drive');
  $('disconnect').disabled = editingLocked || !session;
  $('forget').disabled = editingLocked;
  sourceControls();
  search.setControls(connected, locked);
  receipts.enable(connected && !locked && navigator.onLine);
  const canSendTask = connected && !locked && !storageFault && navigator.onLine;
  setTaskActionsEnabled(canSendTask);
  taskEntry.update(taskSource(), device.taskDraft, editingLocked, canSendTask);
  $('search-draft').hidden = !draft;
  $('search-draft').disabled = editingLocked;
  $('pick').disabled = locked || !connected || !pickerReady;
  $('plan-pick').disabled = $('pick').disabled || !navigator.onLine;
  $('reader-pick').disabled = $('plan-pick').disabled || storageFault;
  $('reader-select').disabled = locked || !connected || !navigator.onLine || storageFault;
  $('today-plan-open').disabled = $('reader-select').disabled || !device.pinnedPlanId;
  $('reader-refresh').hidden = !device.readerId;
  $('reader-refresh').disabled = locked || !connected || !navigator.onLine;
  $('plan-refresh').disabled = locked || !connected || !device.plan || !navigator.onLine;
  $('plan-select').disabled = $('plan-refresh').disabled;
  $('plan-pin').disabled = locked || !connected || (device.pinnedPlanId !== device.plan?.id && !planCards.get(device.plan?.id)?.fresh);
  for (const button of document.querySelectorAll('[data-day-pick]')) button.disabled = $('pick').disabled;
  $('today-refresh').disabled = locked || !connected || !navigator.onLine || !hasOverviewSources();
  $('today-capture').disabled = locked || (!draft && (!connected || (!captureId() && !pickerReady)));
  $('today-capture').textContent = draft ? 'К черновику' : 'Записать мысль';
  $('known').disabled = locked || Boolean(draft) || !connected;
  $('refresh').disabled = locked || !connected || !device.activeId;
  $('thought').disabled = editingLocked || !canWrite || Boolean(draft?.op);
  $('save').disabled = locked || !connected || !canWrite || !draft?.text.trim() || draft.fileId !== device.activeId || !readAt;
  $('save').textContent = draft?.op ? 'Проверить и повторить' : 'Добавить в Drive';
  $('discard').disabled = locked || !draft;
  $('legacy').hidden = !legacy;
  $('recover').disabled = locked || Boolean(draft);
  $('device-hint').textContent = personal ?
    'В этом браузере сохраняются ограниченный ключ Picker, номер проекта, выбранные файлы и черновики мыслей и дел. При F5 My Day попробует восстановить доступ. Токен Google остаётся в памяти.' :
    'На общем компьютере оставь флажок снятым. Ключ, выбор файлов и черновики будут жить только в этой вкладке.';
  const where = personal && !storageFault ? 'Черновик сохранён на устройстве.' : 'Черновик в этой вкладке. Оставь её открытой.';
  $('draft').textContent = !draft ? 'Черновика нет.' : where + (draft.op ?
    ' Отправка начата. Повтор сначала проверит метку записи в том же файле.' : ' Запись ещё не отправлена.');
}

function endSession() {
  receipts.remove();
  if (pickerWindow) { pickerWindow.setVisible(false); pickerWindow = null; }
  session?.abort.abort();
  session = null;
  refreshAfterBusy = false;
  hiddenSince = null;
  overviewDue = false;
  clearTimeout(expiryTimer);
  clearPreview();
  clearDay();
  clearPlans();
  readerAttempt = null;
  reader.reset();
  attention.clear();
  search.reset();
}
function expire() {
  endSession();
  status('Срок доступа Google истёк. Нажми «Подключиться снова».', true);
  controls();
}
async function request(url, options = {}) {
  const current = session;
  if (!current || Date.now() >= current.until) {
    expire();
    throw new Error('Требуется повторное подключение.');
  }
  // Ending a session aborts both the session and any search in progress.
  const lifetime = options.signal ?? current.abort.signal;
  const signal = AbortSignal.any && AbortSignal.timeout ?
    AbortSignal.any([lifetime, AbortSignal.timeout(30000)]) : lifetime;
  const response = await fetch(url, {...options, cache: 'no-store', signal,
    headers: {...options.headers, Authorization: 'Bearer ' + current.token}});
  if (!response.ok) {
    const operation = ['PATCH', 'PUT'].includes(options.method) ? 'запись' : url.includes('alt=media') ? 'чтение текста' : 'чтение сведений о файле';
    throw driveError(response.status, await response.json().catch(() => null), operation);
  }
  return response;
}
function sessionRequest(current, signal) {
  return (url, options) => {
    if (session !== current || signal?.aborted) throw new DOMException('Чтение отменено.', 'AbortError');
    return request(url, signal ? {...options, signal} : options);
  };
}
function show(result, confirmedOp = null) {
  if (readOnlyCaptureId === result.meta.id) return;
  const history = !networkChanged && navigator.onLine && session && Date.now() < session.until &&
    result.meta.id === device.activeId && writableNote(result.meta.name) && result.meta.capabilities?.canEdit ?
    buildHandoffHistory(result.meta.id, result.meta.name, result.content, confirmedOp) : null;
  const verified = history && (!confirmedOp || history.defaultOp === confirmedOp);
  const readable = readableNote(result.content);
  setHandoff(verified ? {...history, fileId: result.meta.id, version: result.meta.version, readable} : null, confirmedOp);
  $('preview').textContent = readable.text;
  readAt = new Date().toLocaleString('ru-RU');
  $('fresh').textContent = 'Прочитано из Drive · ' + readAt;
  $('drive-link').href = 'https://drive.google.com/open?id=' + encodeURIComponent(result.meta.id);
  $('drive-link').hidden = false;
}
async function readReceipt(receipt) {
  const {fileId, name} = receipt;
  const current = session;
  const retained = () => current && current === session && device.fileIds.includes(fileId) && device.noteNames[fileId] === name;
  if (!retained()) return;
  try {
    const result = await snapshot(fileId, sessionRequest(current), name, {viewOnly:true});
    if (!retained()) return;
    if (Date.now() >= current.until) { expire(); return; }
    if (!navigator.onLine) throw new Error('Нет сети. Подключись и снова открой запись.');
    return result;
  } catch (error) {
    if (!retained()) return;
    if (error.access) {
      applyReadError(fileId, error, true);
      controls();
    }
    throw new Error(errorMessage(error));
  }
}
function finishDraft(message, verified) {
  const draft = device.draft;
  device.draft = null;
  if (!persist()) {
    device.draft = draft;
    receipts.confirm('thought', verified, draft, false);
    status('Drive подтвердил запись. Не удалось очистить местный черновик.', true);
    return;
  }
  $('thought').value = '';
  receipts.confirm('thought', verified, draft, true);
  status(message);
}
function showRead(result, message) {
  const draft = device.draft;
  const pending = draft?.op && draft.fileId === result.meta.id;
  const delivery = pending && recordDelivery(result.content, draft);
  const delivered = delivery === 'delivered';
  show(result, delivered ? draft.op : null);
  if (delivered) {
    finishDraft('Запись уже есть в ' + result.meta.name + '. Доставка подтверждена без дубля.', result);
    return;
  }
  if (pending) {
    if (delivery === 'conflict') {
      status(recordConflictMessage, true);
      return;
    }
    message += ' Черновик сохранён. Для отправки нажми «Проверить и повторить».';
  }
  status(message);
}
function errorMessage(error) {
  return error instanceof TypeError || error.name === 'TimeoutError' ?
    'Не удалось связаться с Drive. Проверь интернет и повтори попытку.' : error.message || 'Не удалось выполнить операцию.';
}
function fail(error) {
  setHandoff(null);
  if (error.access === 'expired' || error.access === 'consent') {
    endSession();
    if (error.access === 'consent') promptNext = 'consent';
  } else if (error.readOnly) {
    denyCapture(device.activeId);
  } else if (error.access === 'file') {
    planFailed(device.activeId, error);
    search.unavailable(device.activeId, errorMessage(error));
    clearPreview();
    promptNext = 'select_account';
  } else if (readAt) {
    $('fresh').textContent = 'Последнее чтение · ' + readAt + '. Данные могут быть устаревшими.';
  }
  status(errorMessage(error), true);
}
async function run(action, operation = 'drive') {
  if (busy || awaitingLogin || pickerWindow) return;
  const current = session;
  networkChanged = false;
  deniedFileReads.clear();
  readOnlyCaptureId = null;
  busy = operation;
  controls();
  try { return await action(); }
  catch (error) { if (current === session) fail(error); }
  finally {
    busy = false;
    controls();
    if (refreshAfterBusy) {
      refreshAfterBusy = false;
      if (session && current === session) run(readOnConnect);
    } else checkOnReturn();
  }
}
function applyReadError(id, error, report = false, planChecked = false) {
  attention.unavailable(id);
  if (error.access === 'expired' || error.access === 'consent') { fail(error); return; }
  if (error.access === 'file' || planChecked) planFailed(id, error);
  if (error.access === 'file' && id === device.readerId) reader.clear(errorMessage(error), true);
  dayFileFailed(id, error, errorMessage(error));
  const planOnly = device.plans?.some(plan => plan.id === id) && !device.fileIds.includes(id);
  search.unavailable(id, planOnly && error.access === 'file' ? planAccessMessage : errorMessage(error));
  if (device.activeId === id) fail(error);
  else if (report) status(errorMessage(error), true);
}
function denyCapture(id) {
  if (id === device.activeId && writableNote(device.noteNames[id])) {
    // Another read of this ID in the same operation can still be in flight.
    readOnlyCaptureId = id;
    clearPreview();
  }
}
function showReaderAndAttention(result) {
  if (networkChanged || !navigator.onLine || !session || Date.now() >= session.until || deniedFileReads.has(result.meta.id)) return;
  if (result.meta.capabilities?.canEdit === false) denyCapture(result.meta.id);
  reader.show(result);
  attention.show(result);
}
function updateSources(result) {
  showReaderAndAttention(result);
  showDayFile(result);
  search.changed(result.meta);
}
async function refreshFiles(ids, check = null, read = snapshot) {
  const current = session;
  const fetchInSession = sessionRequest(current);
  return Promise.all([...new Set(ids.filter(Boolean))].map(async id => {
    try {
      const result = await read(id, fetchInSession, device.noteNames[id]);
      if (session !== current || !device.fileIds.includes(id) || deniedFileReads.has(id)) return;
      const checkThis = check?.fileId === id;
      if (checkThis && (returnCheck !== check || device.activeId !== id)) return;
      if (networkChanged || !navigator.onLine) {
        dayFileFailed(id, new TypeError(), 'Нет сети. После подключения обнови обзор.');
        return;
      }
      if (Date.now() >= current.until) { expire(); return; }
      updateSources(result);
      if (readOnlyCaptureId === id) return false;
      if (device.activeId === id) {
        const message = 'Получено актуальное содержимое ' + result.meta.name + '.';
        if (checkThis) {
          show(result);
          status(handoff?.record ? message : 'Выбранную запись больше не удаётся определить в ' + result.meta.name + '.');
        } else showRead(result, message);
      }
      return true;
    } catch (error) {
      if (session === current && device.fileIds.includes(id) && (check?.fileId !== id || returnCheck === check)) {
        applyReadError(id, error);
      }
    }
  }));
}
function dayIds() {
  return [preferredFile(device, NOW), preferredFile(device, TASKS)];
}
function hasOverviewSources() {
  return dayIds().some(Boolean) || Boolean(device.pinnedPlanId || device.notes?.length);
}
function readActive() {
  status('Читаем ' + device.noteNames[device.activeId] + ' из Drive…');
  return refreshFiles([device.activeId]);
}
function refreshAttention(excludedIds) {
  const current = session;
  const read = async (id, name) => {
    try {
      const result = await markdownSnapshot(id, sessionRequest(current), name);
      if (!current || current !== session || Date.now() >= current.until || networkChanged || !navigator.onLine || deniedFileReads.has(id)) {
        throw new Error('Данные заметки устарели.');
      }
      return result;
    } catch (error) {
      if (current === session && error.access === 'file') applyReadError(id, error);
      throw error;
    }
  };
  return attention.refresh(excludedIds, read);
}
function readOnConnect() {
  status(device.activeId ? 'Читаем выбранные заметки из Drive…' : 'Google Drive подключён.');
  const refreshed = [device.activeId, ...dayIds()];
  const plans = [device.plan?.id, device.pinnedPlanId];
  return Promise.all([refreshFiles(refreshed), readPlans(plans), readReader(),
    refreshAttention([...refreshed, ...plans, device.readerId])]);
}
function connected(response) {
  if (!awaitingLogin) return;
  awaitingLogin = false;
  if (response.error || !response.access_token || !google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) {
    endSession();
    promptNext = 'consent';
    status('Google не выдал доступ к файлам. Нажми кнопку подключения и подтверди разрешение My Day.', true);
    controls();
    return;
  }
  endSession();
  const lifetime = Number(response.expires_in) * 1000;
  if (!Number.isFinite(lifetime) || lifetime <= 0) { expire(); return; }
  const usable = lifetime - Math.min(15000, lifetime / 10);
  if (personal && !device.connectionEpoch) {
    device.connectionEpoch = crypto.randomUUID();
    persist();
  }
  startSession(response.access_token, Date.now() + usable);
}
function startSession(token, until) {
  session = {token, until, abort: new AbortController()};
  hasConnected = true;
  expiryTimer = setTimeout(expire, until - Date.now());
  controls();
  if (device.activeId || device.plan || device.readerId) run(readOnConnect, device.activeId ? 'drive' : 'plan');
  else if (validPickerKey($('key').value.trim())) {
    status('Google Drive подключён. Нажми «Выбрать файл», чтобы открыть заметку.');
    if (pickerReady) $('pick').focus();
  } else {
    $('setup').open = true;
    status('Google Drive подключён. Введи ограниченный ключ Picker и нажми «Выбрать файл».');
    $('key').focus();
  }
}
function loadScript(src, ready, failed) {
  const script = document.createElement('script');
  script.src = src;
  script.onload = () => { try { ready(); } catch { failed(); } };
  script.onerror = failed;
  document.head.append(script);
}
function initAuth() {
  client = google.accounts.oauth2.initTokenClient({client_id: CLIENT, scope: SCOPE, include_granted_scopes: false,
    callback: connected, error_callback: error => {
      if (!awaitingLogin) return;
      awaitingLogin = false;
      status(error?.type === 'popup_closed' ? 'Окно входа закрыто. Нажми кнопку подключения ещё раз.' :
        'Окно входа не открылось. Разреши всплывающее окно для My Day и нажми кнопку подключения.', true);
      controls();
    }});
  const selectedName = device.noteNames[device.activeId] || device.plan?.name;
  if (!session && !resuming) status(selectedName ? 'Нажми «Подключиться снова», чтобы открыть ' + selectedName + '.' :
    'Нажми «Подключить Google Drive», затем выбери файл.');
  controls();
}
function pickerFailed() {
  $('picker-error').textContent = 'Picker не загрузился. Для выбора нового файла проверь интернет и обнови страницу.';
  $('picker-error').hidden = false;
}
$('connect').onclick = () => {
  if (session && Date.now() >= session.until) expire();
  if (!client || resuming || busy || awaitingLogin || pickerWindow || session) return;
  awaitingLogin = true;
  status('Заверши вход в окне Google. После входа My Day откроет выбранную заметку.');
  controls();
  const prompt = promptNext ?? (personal && (device.activeId || device.plan) ? '' : 'select_account');
  promptNext = null;
  try { client.requestAccessToken({prompt}); }
  catch (error) { awaitingLogin = false; fail(error); controls(); }
};
function resetTab() {
  readerReturn.clear();
  awaitingLogin = false;
  endSession();
  device = newDevice();
  listPlans();
  personal = false;
  hasConnected = false;
  promptNext = 'select_account';
  syncFields();
  listFiles();
}
$('disconnect').onclick = () => {
  if (!personal && (device.draft || device.taskDraft) && !confirm('Отключиться и удалить черновики этой вкладки?')) return;
  if (personal) {
    endSession();
    promptNext = 'select_account';
    device.connectionEpoch = crypto.randomUUID();
    persist();
  }
  else resetTab();
  status(personal ? 'Отключено. Настройки и черновик доступны на этом устройстве.' : 'Отключено. Данные этого сеанса очищены.');
  controls();
};
$('remember').onchange = () => {
  if ($('remember').checked) {
    personal = true;
    device.connectionEpoch = crypto.randomUUID();
    prepareReload();
    if (!persist()) personal = false;
    else if (canRestoreLegacy()) recoverLegacy();
  } else {
    try {
      localStorage.removeItem(DEVICE_KEY);
      stored = null;
      personal = false;
      storageWarning();
      status('Локальная копия удалена. До закрытия вкладки можно продолжать работу.');
    } catch { storageWarning('Браузер не дал удалить настройки. Проверь разрешение на хранение данных сайта.'); }
  }
  $('remember').checked = personal;
  controls();
};
$('forget').onclick = () => {
  if ((device.draft || device.taskDraft || legacy) && !confirm('Забыть настройки и удалить местные черновики? Записанное в Drive сохранится.')) return;
  try {
    localStorage.removeItem(LEGACY_DRAFT);
    localStorage.removeItem(DEVICE_KEY);
    stored = legacy = null;
    storageWarning();
    resetTab();
    status('Настройки, выбранные файлы и черновик забыты. Google Drive отключён.');
  } catch {
    resetTab();
    storageWarning('Браузер не подтвердил удаление. Очисти данные сайта в настройках браузера.');
  }
  controls();
};
function canRestoreLegacy() {
  return legacy && !device.draft && (!device.activeId || device.activeId === legacy.fileId)
    && (!device.noteNames[legacy.fileId] || device.noteNames[legacy.fileId] === TEST_FILE);
}
function recoverLegacy() {
  if (!legacy || device.draft) return;
  if (device.noteNames[legacy.fileId] && device.noteNames[legacy.fileId] !== TEST_FILE) {
    status('Для старого черновика нужен исходный My-Day-test.md.', true);
    return;
  }
  device.draft = legacy;
  $('thought').value = legacy.text;
  if (selectId(legacy.fileId, TEST_FILE)) {
    try { localStorage.removeItem(LEGACY_DRAFT); legacy = null; }
    catch { storageWarning('Браузер не дал удалить старую копию черновика.'); }
  }
  status(session ? 'Проверяем прежний черновик в Drive…' : 'Черновик восстановлен. Нажми «Подключиться снова».');
  controls();
  if (session) run(readActive);
}
$('recover').onclick = recoverLegacy;
for (const field of ['key', 'project']) $(field).oninput = () => {
  const value = $(field).value.trim();
  if (field === 'key') device.pickerKey = validPickerKey(value) ? value : '';
  if (field === 'project' && validProject(value)) device.project = value;
  persist();
  controls();
};
function chooseFile(expectedName, purpose = 'note') {
  if (!session || !pickerReady || busy || awaitingLogin || pickerWindow) return;
  if (Date.now() >= session.until) { expire(); return; }
  if (!validPickerKey($('key').value.trim()) || !validProject($('project').value.trim())) {
    $('setup').open = true;
    status('Для выбора файла введи ограниченный ключ Google Picker (AIza…) и числовой номер проекта.', true);
    $(validPickerKey($('key').value.trim()) ? 'project' : 'key').focus();
    return;
  }
  try {
    const current = session;
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true)
      .setSelectFolderEnabled(false).setMode(google.picker.DocsViewMode.LIST);
    if (expectedName) view.setQuery(expectedName);
    pickerWindow = new google.picker.PickerBuilder().addView(view).setOAuthToken(current.token)
      .setDeveloperKey($('key').value.trim()).setAppId($('project').value.trim()).setOrigin(location.origin).setCallback(data => {
        const action = data[google.picker.Response.ACTION];
        if (action !== google.picker.Action.CANCEL && action !== google.picker.Action.PICKED) return;
        if (current !== session) return;
        pickerWindow = null;
        controls();
        if (action === google.picker.Action.CANCEL) return;
        const id = data[google.picker.Response.DOCUMENTS]?.[0]?.[google.picker.Document.ID];
        if (!validId(id)) { status('Google не вернул ID файла.', true); return; }
        if (purpose === 'reader') { readerReturn.clear(); run(() => readReader(id, true), 'reader'); return; }
        if (purpose === 'plan') { run(() => readPlan(id, true), 'plan'); return; }
        const forDay = expectedName === NOW || expectedName === TASKS;
        if (!forDay && device.draft && device.draft.fileId !== id) {
          status('Черновик привязан к другому файлу. Выбери исходный файл или сначала очисти черновик.', true);
          return;
        }
        run(async () => {
          const wasKnown = sourcesFor(device).has(id);
          const selectionCurrent = () => session === current && (!wasKnown || sourcesFor(device).has(id));
          const pinned = device.noteNames[id];
          if (expectedName && pinned && expectedName !== pinned) {
            status('Выбери ' + expectedName + '. Этот файл уже выбран как ' + pinned + '.', true);
            return;
          }
          let result;
          try { result = await snapshot(id, sessionRequest(current), expectedName || pinned); }
          catch (error) {
            if (selectionCurrent()) applyReadError(id, error, true);
            return;
          }
          if (!selectionCurrent()) return;
          const name = result.meta.name;
          if (name === TASKS && device.taskDraft && device.taskDraft.fileId !== id) {
            status('Черновик дела привязан к прежнему списку. Сохрани его или очисти перед сменой источника.', true);
            return;
          }
          if (name !== TEST_FILE) device.preferredIds[name] = id;
          if (forDay && device.activeId && device.activeId !== id) {
            rememberFile(id, name);
            listFiles();
            persist();
            status(name + ' — источник обзора «Сегодня».');
          } else {
            selectId(id, name);
            showRead(result, name + ' — файл прочитан из Drive.');
          }
          updateSources(result);
          $('setup').open = false;
          return true;
        }).then(selected => {
          if (selected && expectedName === INBOX && session === current && device.activeId === id && readAt) openTodayCapture();
        });
      }).build();
    controls();
    pickerWindow.setVisible(true);
  } catch (error) { pickerWindow = null; fail(error); controls(); }
}
$('source-select').onchange = sourceControls;
$('source-remove').onclick = () => {
  const id = $('source-select').value;
  if ($('source-remove').disabled || !sourcesFor(device).has(id)) return;
  const previous = device;
  const label = $('source-select').selectedOptions[0].text;
  device = withoutSource(device, id);
  if (!persist()) {
    device = previous;
    controls();
    return;
  }
  syncSelection(previous);
  status(label + ' убран из списка источников My Day.');
  controls();
};
$('pick').onclick = () => chooseFile();
$('reader-pick').onclick = () => chooseFile(undefined, 'reader');
$('reader-select').onchange = () => {
  const id = $('reader-select').value;
  if (id) {
    readerReturn.clear();
    run(() => readReader(id, true, sourcesFor(device).get(id)?.name), 'reader');
  }
  else $('reader-select').value = device.readerId ?? '';
};
$('reader-refresh').onclick = () => run(() => readReader(), 'reader');
function readerNote(id, name) {
  return device.notes?.some(note => note.id === id && note.name === name);
}
function openTodayReader(source, origin) {
  if (!source || $('reader-select').disabled) return;
  readerReturn.remember(origin, $('today-title'));
  if (location.hash !== '#note-reader') history.pushState(null, '', '#note-reader');
  const title = $('reader-title');
  title.focus({preventScroll: true});
  title.scrollIntoView({block: 'start'});
  // Select only the reader ID. Opening a plan here never adds it to the editable note sources.
  if (device.readerId !== source.id) {
    const previous = device;
    device = {...device, readerId: source.id};
    if (!persist()) {
      device = previous;
      reader.clear('Не удалось сохранить выбор файла. Проверь настройки подключения.', true);
      return;
    }
    syncSearchFiles();
  }
  run(() => readReader(source.id, false, source.name), 'reader');
}
$('today-plan-open').onclick = () => {
  const id = device.pinnedPlanId;
  openTodayReader(device.plans?.find(plan => plan.id === id),
    () => device.pinnedPlanId === id ? $('today-plan-open') : null);
};
function openAttentionNote(id) {
  openTodayReader(device.notes?.find(note => note.id === id),
    () => $('today-attention').querySelector('button[data-file-id="' + CSS.escape(id) + '"]'));
}
$('reader-back').addEventListener('click', () => history.replaceState(null, '', '#today'));
function saveNoteProperty(selected, operation, resultLine, write, messageForResult) {
  const current = session;
  const matches = () => session === current && !storageFault && navigator.onLine && !networkChanged &&
    device.readerId === selected.fileId && readerNote(selected.fileId, selected.name);
  run(async () => {
    const setMessage = (message, error = false) => {
      resultLine.textContent = message;
      resultLine.classList.toggle('error', error);
    };
    const fetchInSession = sessionRequest(current);
    const guarded = (url, options) => {
      if (!matches() || Date.now() >= current.until || (personal && localStorage.getItem(DEVICE_KEY) !== stored)) {
        throw new Error('Выбор заметки или подключение изменились. Открой заметку ещё раз.');
      }
      return fetchInSession(url, options);
    };
    setMessage('Сверяем с Drive…');
    try {
      const {verified, already} = await write(selected, guarded);
      if (!matches()) return;
      updateSources(verified);
      showPlanResult(verified);
      if (device.activeId === verified.meta.id) show(verified);
      setMessage(messageForResult(already));
    } catch (error) {
      if (!matches()) return;
      if (error.access === 'expired' || error.access === 'consent') { fail(error); return; }
      if (error.reselect && operation === 'save-view') reader.reset();
      if (error.current) updateSources(error.current);
      if (error.access) applyReadError(selected.fileId, error, true);
      const message = errorMessage(error) + (error.uncertain ? ' Проверь файл в Drive или повтори сверку.' : '');
      setMessage(message, true);
      if ($('reader-display').hidden) status(message, true);
    }
  }, operation);
}
$('reader-save').onclick = () => {
  if ($('reader-save').disabled) return;
  saveNoteProperty(reader.selection(), 'save-view', $('reader-save-status'), saveView, already =>
    already ? 'Этот вид уже сохранён в заметке.' : 'Вид сохранён в заметке и подтверждён чтением из Drive.');
};
function changeAttentionDate(date) {
  const {meta} = reader.opened();
  saveNoteProperty({fileId:meta.id, name:meta.name, version:meta.version, date}, 'save-attention',
    $('reader-attention-status'), saveAttention, already => {
      if (date === null) return already ? 'В заметке уже нет даты внимания.' : 'Дата снята.';
      return already ? 'Эта дата уже сохранена в заметке.' : 'Дата сохранена в заметке.';
    });
}
$('reader-attention-date').oninput = updateAttentionButtons;
$('reader-attention-save').onclick = () => {
  if (!$('reader-attention-save').disabled) changeAttentionDate($('reader-attention-date').value);
};
$('reader-attention-clear').onclick = () => {
  if (!$('reader-attention-clear').disabled) changeAttentionDate(null);
};
$('plan-pick').onclick = () => chooseFile(undefined, 'plan');
$('plan-refresh').onclick = () => run(() => readPlan(), 'plan');
$('plan-select').onchange = () => run(async () => {
  const plan = device.plans?.find(item => item.id === $('plan-select').value);
  if (plan && savePlanSelection(plan, device.plans)) await readPlan(plan.id);
}, 'plan');
$('plan-pin').onclick = () => {
  if ($('plan-pin').disabled || !device.plan) return;
  const previous = device;
  device = {...device};
  if (device.pinnedPlanId === device.plan.id) delete device.pinnedPlanId;
  else device.pinnedPlanId = device.plan.id;
  if (!persist()) device = previous;
  listPlans();
  controls();
};
for (const button of document.querySelectorAll('[data-day-pick]')) {
  button.onclick = () => chooseFile(button.dataset.dayPick);
}
async function refreshOverview(check = null) {
  const current = session;
  overviewDue = false;
  if (check) check.phase = 'ready';
  status('Обновляем обзор из Drive…');
  const days = dayIds();
  const files = [...days, check?.fileId].filter(Boolean);
  const pinned = device.pinnedPlanId;
  // A file selected in two roles is still one Drive snapshot.
  const shared = new Map();
  const readFile = (id, request, name) => {
    const result = snapshot(id, request, name);
    if (id === pinned) shared.set(id, result);
    return result;
  };
  const [refreshed, planOK, datesOK] = await Promise.all([
    refreshFiles(files, check, readFile),
    pinned ? readPlan(pinned, false, (...args) => shared.get(pinned) ?? planSnapshot(...args)) : true,
    refreshAttention([...files, pinned])
  ]);
  if (!current || current !== session || refreshAfterBusy || storageFault) return;
  if (Date.now() >= current.until) { expire(); return; }
  if ($('status').classList.contains('error')) return;
  if (networkChanged || !navigator.onLine || !planOK || !datesOK || refreshed.some(ok => !ok)) {
    status('Не удалось обновить весь обзор. Проверь состояние источников ниже.', true);
  } else {
    status('Обзор обновлён из Drive.');
  }
}
$('today-refresh').onclick = () => run(() => refreshOverview(
  returnCheck?.phase === 'due' && returnCheck.fileId === device.activeId ? returnCheck : null
), 'overview');
function editTaskDraft(text) {
  const source = taskSource();
  const previous = device.taskDraft;
  const fileId = previous?.fileId ?? source?.fileId;
  if (!fileId || previous?.op) return;
  if (text) device.taskDraft = {fileId, text, op: null};
  else delete device.taskDraft;
  persist();
  controls();
}
function discardTaskDraft() {
  const previous = device.taskDraft;
  if (!previous || !confirm('Удалить черновик дела? Уже добавленное дело останется в Drive.')) return;
  delete device.taskDraft;
  if (!persist()) device.taskDraft = previous;
  else taskEntry.message();
  controls();
}
function displayTaskList(result) {
  updateSources(result);
  if (device.activeId === result.meta.id) show(result);
  showPlanResult(result);
}
function submitTask(place) {
  // Capture the selected section before a date change can rebuild its menu.
  const shown = taskSource();
  updateDayDate();
  const source = taskSource();
  const previous = device.taskDraft;
  if (!shown || !source || !previous || previous.fileId !== source.fileId || !session || storageFault) return;
  if (!previous.version && shown.date !== source.date) {
    taskEntry.message('Наступил новый день. Проверь раздел для дела и подтверди добавление.', true);
    return;
  }
  run(async () => {
    const current = session;
    const draft = previous.version ? previous : {...previous, op: previous.op ?? crypto.randomUUID(),
      text: previous.text.trim(), version: source.version, date: source.date, place};
    if (!previous.version) {
      try { insertTask(source.content, draft); }
      catch (error) { taskEntry.message(errorMessage(error), true); return; }
    }
    device.taskDraft = draft;
    if (!persist()) { device.taskDraft = previous; return; }
    const selected = () => session === current && !storageFault && device.taskDraft?.op === draft.op &&
      preferredFile(device, TASKS) === draft.fileId;
    const readOrWrite = sessionRequest(current);
    const guardedRequest = (url, options) => {
      if (!selected()) throw new Error('Источник дела изменился. Сверь черновик с актуальным списком.');
      if (options?.method === 'PUT') {
        updateDayDate();
        if (draft.date !== $('today-date').dateTime) {
          const error = new Error('Наступил новый день. Сверь список и заново подтверди добавление.');
          error.reselect = true;
          throw error;
        }
      }
      return readOrWrite(url, options);
    };
    taskEntry.message('Сверяем список с Drive…');
    try {
      const {verified, already} = await addTask(draft, guardedRequest);
      if (!selected()) return;
      displayTaskList(verified);
      delete device.taskDraft;
      if (!persist()) {
        device.taskDraft = draft;
        receipts.confirm('task', verified, draft, false);
        taskEntry.message('Drive подтвердил дело. Не удалось очистить местный черновик.', true);
        return;
      }
      receipts.confirm('task', verified, draft, true);
      const message = already ? 'Дело уже есть в Drive. Повтор подтверждён без дубля.' :
        'Дело добавлено и подтверждено чтением из Drive.';
      taskEntry.message(message);
      if (!verified.meta.capabilities?.canEdit) status(message);
    } catch (error) {
      if (!selected()) return;
      if (error.current) displayTaskList(error.current);
      let message = errorMessage(error);
      if (error.reselect) {
        device.taskDraft = {fileId: draft.fileId, text: draft.text, op: draft.op};
        if (!persist()) device.taskDraft = draft;
        if (previous.version) message += ' Предыдущая отправка могла пройти. Открой список в Drive и сверь текст перед новым добавлением.';
      } else if (error.uncertain) {
        message += ' Исход отправки неясен. При повторе My Day сначала проверит это дело в Drive.';
      }
      if (error.access && !error.current) applyReadError(draft.fileId, error, true);
      taskEntry.message(message, true);
    }
  }, 'add-task');
}
onTaskCompletion(target => run(async () => {
  const current = session;
  const {fileId, date} = target;
  updateDayDate();
  const stillSelected = () => current === session && preferredFile(device, TASKS) === fileId &&
    $('today-date').dateTime === date && !storageFault;
  if (!current || !stillSelected() || !navigator.onLine) return;
  const readOrWrite = sessionRequest(current);
  const guardedRequest = (url, options) => {
    if (!stillSelected()) throw new Error('Источник или день изменился. Выбери дело заново.');
    return readOrWrite(url, options);
  };

  status('Сверяем дело с актуальной версией в Drive…');
  try {
    const {verified, already} = await completeTask(target, guardedRequest);
    if (!stillSelected()) return;
    displayTaskList(verified);
    status(already ? 'Drive подтвердил, что дело уже выполнено.' : 'Дело выполнено. Отметка подтверждена чтением из Drive.');
  } catch (error) {
    if (!stillSelected()) return;
    if (error.current) {
      displayTaskList(error.current);
      status(errorMessage(error), true);
    } else {
      applyReadError(fileId, error, true);
    }
  }
}, 'complete-task'));
function placeCapture(inToday) {
  const editor = $('capture');
  const slot = $('today-capture-slot');
  const back = $('library-capture-back');
  if (inToday) {
    if (editor.parentElement !== slot) slot.prepend(editor);
  } else if (editor.parentElement === slot) {
    back.after(editor);
  }
  slot.hidden = back.hidden = !inToday;
  $('today-capture').setAttribute('aria-expanded', String(inToday));
}
function focusDraft() {
  $('capture').scrollIntoView({block: 'center'});
  if (!$('thought').disabled) $('thought').focus();
  else if (!$('save').disabled) $('save').focus();
}
function openTodayCapture() {
  if (session && Date.now() < session.until && readAt && !$('capture').hidden) placeCapture(true);
  focusDraft();
}
$('today-capture-close').onclick = () => {
  placeCapture(false);
  $('today-capture').focus();
};
$('library-capture-back').onclick = () => {
  placeCapture(false);
  focusDraft();
};
$('search-draft').onclick = focusDraft;
$('today-capture').onclick = async () => {
  if (device.draft) { openTodayCapture(); return; }
  const current = session;
  const id = captureId();
  if (!id) { chooseFile(INBOX); return; }
  if (device.activeId !== id || !readAt) {
    selectId(id, INBOX);
    const reads = await run(readActive);
    if (!reads?.[0]) return;
  }
  if (current && session === current && readAt && device.activeId === id) openTodayCapture();
};
$('known').onchange = () => {
  if (device.draft || !device.fileIds.includes($('known').value)) return;
  const id = $('known').value;
  selectId(id, device.noteNames[id]);
  run(readActive);
};
$('refresh').onclick = () => run(readActive);
$('thought').oninput = () => {
  if (!writableNote(device.noteNames[device.activeId]) || device.draft?.op) return;
  const text = $('thought').value;
  device.draft = text ? {fileId: device.activeId, text, op: null} : null;
  persist();
  controls();
};
$('discard').onclick = () => {
  if (!confirm('Удалить локальный черновик? Уже доставленная запись останется в Drive.')) return;
  const previous = device.draft;
  device.draft = null;
  if (persist()) $('thought').value = '';
  else device.draft = previous;
  controls();
};
$('save').onclick = () => run(async () => {
  let draft = device.draft;
  const name = device.noteNames[device.activeId];
  if (!writableNote(name) || !draft?.text.trim() || draft.fileId !== device.activeId || !readAt) return;
  if (!draft.op) {
    device.draft = {...draft, op: crypto.randomUUID(), text: draft.text.trim()};
    if (!persist()) { device.draft = draft; return; }
    draft = device.draft;
    $('thought').value = draft.text;
  } else if (!persist()) {
    return;
  }
  const current = session;
  const {verified, already} = await saveDraft(draft, sessionRequest(current), name);
  if (session !== current) return;
  updateSources(verified);
  showPlanResult(verified);
  show(verified, draft.op);
  finishDraft(already ? 'Запись уже была в Drive. Повтор подтверждён без дубля.' : 'Записано в ' + name + ' и подтверждено повторным чтением.', verified);
});
window.addEventListener('beforeunload', event => {
  if ((device.draft || device.taskDraft) && (!personal || storageFault)) { event.preventDefault(); event.returnValue = true; }
});
function syncSelection(previous) {
  const previousSources = [preferredFile(previous, NOW), preferredFile(previous, TASKS)];
  const targetChanged = previous.activeId !== device.activeId ||
    previous.noteNames[previous.activeId] !== device.noteNames[device.activeId];
  const planChanged = previous.plan?.id !== device.plan?.id || previous.pinnedPlanId !== device.pinnedPlanId ||
    JSON.stringify(previous.plans) !== JSON.stringify(device.plans);
  const readerChanged = previous.readerId !== device.readerId ||
    previous.notes?.find(note => note.id === device.readerId)?.name !== device.notes?.find(note => note.id === device.readerId)?.name;
  if (readerChanged) readerAttempt = null;
  listFiles();
  if (targetChanged) clearPreview();
  const before = sourcesFor(previous), retained = sourcesFor(device);
  for (const id of previous.fileIds) {
    if (!device.fileIds.includes(id) || previous.noteNames[id] !== device.noteNames[id]) receipts.remove(id);
  }
  for (const id of planReads.keys()) {
    if (before.has(id) && !retained.has(id)) planReads.delete(id);
  }
  if (planChanged) {
    for (const old of previous.plans ?? []) {
      const replacement = device.plans?.find(plan => plan.id === old.id);
      if (replacement?.name !== old.name) {
        planReads.delete(old.id);
        planCards.delete(old.id);
      }
    }
    listPlans();
  }
  const changed = dayIds().filter(id => id && !previousSources.includes(id));
  if (targetChanged && device.activeId) changed.push(device.activeId);
  const notesChanged = JSON.stringify(previous.notes) !== JSON.stringify(device.notes);
  if (session && navigator.onLine && (changed.length || planChanged || readerChanged || notesChanged)) {
    if (busy) refreshAfterBusy = true;
    else {
      const missingPlans = [device.plan?.id, device.pinnedPlanId].filter(id => id && !planCards.get(id)?.fresh);
      run(() => Promise.all([refreshFiles(changed), planChanged && readPlans(missingPlans), readerChanged && readReader(),
        notesChanged && refreshAttention([...changed, ...(planChanged ? missingPlans : []), ...(readerChanged ? [device.readerId] : [])])]));
    }
  }
}
window.addEventListener('storage', event => {
  if (event.key === LEGACY_DRAFT) {
    try { legacy = readDraft(JSON.parse(localStorage.getItem(LEGACY_DRAFT)), true); }
    catch { storageWarning('Не удалось прочитать черновик прежней версии. Проверь локальные настройки.'); }
    controls();
    return;
  }
  if (!personal || (event.key !== DEVICE_KEY && event.key !== null) || event.newValue === stored) return;
  try {
    const latest = localStorage.getItem(DEVICE_KEY);
    if (latest === stored) return;
    if (latest === null) {
      stored = null;
      resetTab();
      storageWarning();
      status('Локальные настройки удалены в другой вкладке.');
    } else {
      const next = readDevice(latest);
      const previous = device;
      const nextSources = sourcesFor(next);
      const removed = [...sourcesFor(previous).keys()].filter(id => !nextSources.has(id));
      if (device.connectionEpoch && next.connectionEpoch !== device.connectionEpoch) {
        endSession();
        awaitingLogin = false;
        promptNext = 'select_account';
        status('Подключение завершено в другой вкладке.');
      }
      const writing = busy && busy !== 'search' && busy !== 'return' && busy !== 'plan' && busy !== 'reader';
      const compatibleRemoval = removed.length && JSON.stringify(device.draft) === JSON.stringify(next.draft) &&
        JSON.stringify(device.taskDraft) === JSON.stringify(next.taskDraft);
      if ((writing && !compatibleRemoval) || storageFault) {
        // Keep possibly unsaved input in this tab while dropping other detached sources immediately.
        for (const id of removed) {
          if (device.draft?.fileId !== id && device.taskDraft?.fileId !== id) device = withoutSource(device, id);
        }
        device = {...device, plan: next.plan, plans: next.plans, pinnedPlanId: next.pinnedPlanId};
        syncSelection(previous);
        storageWarning('Личные данные изменились в другой вкладке. Проверь свой черновик и обнови страницу.');
        controls();
        return;
      }
      device = next;
      stored = latest;
      syncFields();
      if (removed.length && previous.connectionEpoch === next.connectionEpoch) {
        status('Список источников изменён в другой вкладке.');
      }
      syncSelection(previous);
    }
  } catch {
    storageWarning('Не удалось прочитать настройки, изменённые в другой вкладке.');
  }
  controls();
});
document.addEventListener('visibilitychange', () => {
  if (session && Date.now() >= session.until) expire();
  if (document.hidden) {
    if (session && !hiddenSince) hiddenSince = {time: Date.now(), date: $('today-date').dateTime};
    leaveHandoff();
    return;
  }
  updateDayDate();
  if (hiddenSince && session) {
    overviewDue ||= busy !== 'overview' &&
      (Date.now() - hiddenSince.time >= 60000 || hiddenSince.date !== $('today-date').dateTime);
  }
  hiddenSince = null;
  returnToHandoff();
});
window.addEventListener('blur', leaveHandoff);
window.addEventListener('focus', returnToHandoff);
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    endSession();
    location.reload();
  }
});
window.addEventListener('pagehide', event => {
  if (event.persisted || !session || !personal || storageFault) return;
  try {
    if (localStorage.getItem(DEVICE_KEY) === stored) leaveForReload(session, device.connectionEpoch);
  } catch { /* Browser storage may have been disabled since connection. */ }
});
window.addEventListener('offline', () => {
  networkChanged = true;
  for (const id of dayIds().filter(Boolean)) dayFileFailed(id, new TypeError(), 'Нет сети. После подключения обнови обзор.');
  clearPlans('Нет сети. После подключения обнови план или обзор.', true);
  readerAttempt = null;
  attention.clear();
  if (device.readerId) reader.clear('Нет сети. После подключения обнови заметку.', true);
  controls();
  if (returnCheck) fail(new Error('Нет сети. Подключись к интернету и нажми «Обновить», чтобы проверить ответ.'));
  else setHandoff(null);
});
window.addEventListener('online', () => {
  controls();
  checkOnReturn();
});

restore();
listPlans();
if (personal) prepareReload();
const epoch = device.connectionEpoch;
const attempt = resumeReload(personal && epoch);
if (attempt) {
  resuming = true;
  status('Восстанавливаем подключение к Drive…');
  attempt.then(grant => {
    resuming = false;
    try {
      if (grant?.token && grant.until > Date.now() && personal && !storageFault &&
          device.connectionEpoch === epoch && localStorage.getItem(DEVICE_KEY) === stored) {
        startSession(grant.token, grant.until);
        return;
      }
    } catch { /* Fall back to an explicit connection. */ }
    status('Нажми «Подключиться снова», чтобы открыть выбранные заметки.');
    controls();
  });
}
updateDayDate();
if (personal && canRestoreLegacy()) recoverLegacy();
syncFields();
listFiles();
controls();
loadScript('https://accounts.google.com/gsi/client', initAuth, () => {
  if (!session && !resuming) status('Не загрузилась библиотека входа Google. Проверь интернет и обнови страницу.', true);
});
loadScript('https://apis.google.com/js/api.js', () => {
  gapi.load('picker', {callback: () => { pickerReady = true; controls(); }, onerror: pickerFailed, timeout: 15000, ontimeout: pickerFailed});
}, pickerFailed);
