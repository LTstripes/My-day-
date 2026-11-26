import {INBOX, NOW, readableNote, recordBlock, TASKS, TEST_FILE, writableNote} from './core.js?v=0.6.1';
import {DEVICE_KEY, LEGACY_DRAFT, newDevice, preferredFile, readDevice, readDraft, validId, validPickerKey, validProject} from './device.js?v=0.6.1';
import {driveError, saveDraft, snapshot} from './drive.js?v=0.5.0';
import {clearDay, dayFileFailed, showDayFile, syncDaySources, updateDayDate} from './day-view.js?v=0.4.0';
import {initNoteSearch} from './search-view.js?v=0.6.1';
import {buildHandoffHistory} from './handoff.js?v=0.7.0';
import {leaveForReload, prepareReload, resumeReload} from './reload.js?v=0.6.1';

const CLIENT = '327713401108-rdi4uv2duskfvn8d368i2ui56uhqsulo.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const $ = id => document.getElementById(id);

let device = newDevice(), personal = false, stored = null, legacy = null, storageFault = false;
let client = null, session = null, expiryTimer, pickerReady = false, pickerWindow = null, awaitingLogin = false, busy = false;
let promptNext = null, hasConnected = false, readAt = '', refreshAfterBusy = false;
let handoff = null, networkChanged = false;
let returnCheck = null;
let resuming = false;
const search = initNoteSearch({
  run: action => run(action, 'search'),
  async read(file, signal) {
    const current = session;
    const result = await snapshot(file.id, sessionRequest(current, signal), file.name, {viewOnly: true});
    if (!signal.aborted && current === session && handoff?.fileId === file.id &&
        (handoff.version !== result.meta.version || !result.meta.capabilities?.canEdit)) setHandoff(null);
    return result;
  },
  onError(id, error) {
    applyReadError(id, error);
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
  const priorOp = !confirmedOp && handoff?.fileId === target?.fileId ? handoff?.selectedOp : null;
  const checking = !confirmedOp && returnCheck?.fileId === target?.fileId ? returnCheck : null;
  const checkedRecord = checking && target.records.find(record => record.op === checking.op);
  handoff = target;
  $('handoff').hidden = !target;
  const select = $('handoff-record');
  select.replaceChildren();
  const lostRecord = checking && !checkedRecord;
  $('handoff-choice').hidden = !target || (target.records.length === 1 && Boolean(target.defaultOp) && !lostRecord);
  if (target) {
    target.selectedOp = target.records.some(record => record.op === priorOp) ? priorOp : null;
    if (!target.defaultOp || lostRecord) {
      const placeholder = new Option('Выбери сохранённую запись', '');
      placeholder.disabled = true;
      select.add(placeholder);
    }
    target.records.forEach((record, index) => {
      const position = index === 0 && target.defaultOp ? 'Последняя' : String(index + 1);
      select.add(new Option(position + ' · ' + record.snippet, record.op));
    });
    select.value = lostRecord ? '' : target.selectedOp ?? target.defaultOp ?? '';
  }
  if (checking?.phase === 'due') checking.phase = 'ready';
  selectHandoffRecord(checkedRecord?.resultState === 'missing');
  if (lostRecord) $('handoff-result-state').textContent = 'Выбранную запись больше не удаётся определить. Выбери запись из списка.';
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
  const record = handoff?.records.find(record => record.op === $('handoff-record').value);
  if (handoff) handoff.record = record;
  if (!keepDetails) closeHandoffDetails();
  const state = record?.resultState;
  $('handoff-result').textContent = record?.result ?? '';
  $('handoff-result').hidden = !record?.result;
  $('handoff-result-state').textContent = state === 'saved' ? 'Ответ сохранён в Drive.' :
    state === 'missing' ? 'Ответа в Drive пока нет.' :
    state === 'ambiguous' ? 'Ответ в Drive не удалось однозначно подтвердить.' :
    handoff ? 'Последнюю запись нельзя однозначно определить. Выбери запись из списка.' : '';
  $('handoff-open').textContent = record && record.op === handoff.defaultOp ?
    'Разобрать последнюю запись' : 'Разобрать выбранную запись';
}
function handoffAvailable() {
  if (session && Date.now() >= session.until) expire();
  return handoff && session && navigator.onLine && !busy && !pickerWindow;
}
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
  if (!document.hidden && returnCheck?.phase === 'away') {
    returnCheck.phase = 'due';
    checkOnReturn();
  }
}
function checkOnReturn() {
  if (returnCheck?.phase !== 'due' || !handoffAvailable() || document.hidden) return;
  const check = returnCheck;
  check.phase = 'ready';
  run(() => refreshFiles([check.fileId], check), 'return');
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
  setHandoff(null);
  readAt = '';
  $('preview').textContent = 'Здесь появится текст из Drive.';
  $('fresh').textContent = 'Файл ещё не прочитан в этом подключении.';
  $('drive-link').hidden = true;
  $('drive-link').removeAttribute('href');
}
function syncFields() {
  $('remember').checked = personal;
  $('key').value = device.pickerKey;
  $('project').value = device.project;
  $('setup').open = !device.pickerKey;
  $('thought').value = device.draft?.text ?? '';
}
function listFiles() {
  syncDaySources(device);
  search.setFiles(device.fileIds, device.noteNames);
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
function controls() {
  const locked = Boolean(busy || awaitingLogin || pickerWindow || resuming);
  const editingLocked = locked && busy !== 'search' && busy !== 'return';
  const connected = Boolean(session && Date.now() < session.until);
  const draft = device.draft;
  const canWrite = writableNote(device.noteNames[device.activeId]);
  $('handoff-record').disabled = locked || !connected || !handoff;
  $('handoff-open').disabled = $('handoff-copy').disabled = locked || !connected || !handoff?.record?.command;
  $('remember').disabled = locked;
  $('key').disabled = $('project').disabled = locked;
  $('connect').disabled = locked || !client || connected;
  $('connect').textContent = awaitingLogin ? 'Ожидаем вход в Google…' : connected ? 'Google Drive подключён' :
    (hasConnected || device.activeId ? 'Подключиться снова' : 'Подключить Google Drive');
  $('disconnect').disabled = editingLocked || !session;
  $('forget').disabled = editingLocked;
  search.setControls(connected, locked);
  $('search-draft').hidden = !draft;
  $('search-draft').disabled = editingLocked;
  $('pick').disabled = locked || !connected || !pickerReady;
  for (const button of document.querySelectorAll('[data-day-pick]')) button.disabled = $('pick').disabled;
  $('today-refresh').disabled = locked || !connected || !(preferredFile(device, NOW) || preferredFile(device, TASKS));
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
    'В этом браузере сохраняются ограниченный ключ Picker, номер проекта, выбранные файлы и черновик. При F5 My Day попробует восстановить доступ. Токен Google остаётся в памяти.' :
    'На общем компьютере оставь флажок снятым. Ключ, выбор файлов и черновик будут жить только в этой вкладке.';
  const where = personal && !storageFault ? 'Черновик сохранён на устройстве.' : 'Черновик в этой вкладке. Оставь её открытой.';
  $('draft').textContent = !draft ? 'Черновика нет.' : where + (draft.op ?
    ' Отправка начата. Повтор сначала проверит метку записи в том же файле.' : ' Запись ещё не отправлена.');
}

function endSession() {
  if (pickerWindow) { pickerWindow.setVisible(false); pickerWindow = null; }
  session?.abort.abort();
  session = null;
  refreshAfterBusy = false;
  clearTimeout(expiryTimer);
  clearPreview();
  clearDay();
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
    const operation = options.method === 'PATCH' ? 'запись' : url.includes('alt=media') ? 'чтение текста' : 'чтение сведений о файле';
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
  const history = !networkChanged && navigator.onLine && session && Date.now() < session.until ?
    buildHandoffHistory(result.meta.id, result.meta.name, result.content, confirmedOp) : null;
  setHandoff(history?.records.length ? {...history, fileId: result.meta.id, version: result.meta.version} : null, confirmedOp);
  $('preview').textContent = readableNote(result.content).text;
  readAt = new Date().toLocaleString('ru-RU');
  $('fresh').textContent = 'Прочитано из Drive · ' + readAt;
  $('drive-link').href = 'https://drive.google.com/open?id=' + encodeURIComponent(result.meta.id);
  $('drive-link').hidden = false;
}
function finishDraft(message) {
  const draft = device.draft;
  device.draft = null;
  if (!persist()) {
    device.draft = draft;
    status('Drive подтвердил запись. Не удалось очистить местный черновик.', true);
    return;
  }
  $('thought').value = '';
  status(message);
}
function showRead(result, message) {
  const draft = device.draft;
  const pending = draft?.op && draft.fileId === result.meta.id;
  const delivered = pending && result.content.includes(recordBlock(draft));
  show(result, delivered ? draft.op : null);
  if (delivered) {
    finishDraft('Запись уже есть в ' + result.meta.name + '. Доставка подтверждена без дубля.');
    return;
  }
  if (pending) {
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
  } else if (error.access === 'file') {
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
  busy = operation;
  controls();
  try { await action(); }
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
function applyReadError(id, error, report = false) {
  if (error.access === 'expired' || error.access === 'consent') { fail(error); return; }
  dayFileFailed(id, error, errorMessage(error));
  search.unavailable(id, errorMessage(error));
  if (device.activeId === id) fail(error);
  else if (report) status(errorMessage(error), true);
}
function updateSources(result) {
  showDayFile(result);
  search.changed(result.meta);
}
async function refreshFiles(ids, check = null) {
  const current = session;
  const fetchInSession = sessionRequest(current);
  await Promise.all([...new Set(ids.filter(Boolean))].map(async id => {
    try {
      const result = await snapshot(id, fetchInSession, device.noteNames[id]);
      if (session !== current) return;
      if (check && (returnCheck !== check || device.activeId !== id)) return;
      if (check && Date.now() >= current.until) { expire(); return; }
      updateSources(result);
      if (device.activeId === id) {
        const message = 'Получено актуальное содержимое ' + result.meta.name + '.';
        if (check) {
          show(result);
          status(handoff?.record ? message : 'Выбранную запись больше не удаётся определить в ' + result.meta.name + '.');
        } else showRead(result, message);
      }
    } catch (error) {
      if (session === current && (!check || returnCheck === check)) applyReadError(id, error);
    }
  }));
}
function dayIds() {
  return [preferredFile(device, NOW), preferredFile(device, TASKS)];
}
function readActive() {
  status('Читаем ' + device.noteNames[device.activeId] + ' из Drive…');
  return refreshFiles([device.activeId]);
}
function readOnConnect() {
  status('Читаем выбранные заметки из Drive…');
  return refreshFiles([device.activeId, ...dayIds()]);
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
  if (device.activeId) run(readOnConnect);
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
  if (!session && !resuming) status(device.activeId ? 'Нажми «Подключиться снова», чтобы открыть ' + device.noteNames[device.activeId] + '.' :
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
  const prompt = promptNext ?? (personal && device.activeId ? '' : 'select_account');
  promptNext = null;
  try { client.requestAccessToken({prompt}); }
  catch (error) { awaitingLogin = false; fail(error); controls(); }
};
function resetTab() {
  awaitingLogin = false;
  endSession();
  device = newDevice();
  personal = false;
  hasConnected = false;
  promptNext = 'select_account';
  syncFields();
  listFiles();
}
$('disconnect').onclick = () => {
  if (!personal && device.draft && !confirm('Отключиться и удалить черновик этой вкладки?')) return;
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
  if ((device.draft || legacy) && !confirm('Забыть настройки и удалить местный черновик? Записанное в Drive сохранится.')) return;
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
function chooseFile(expectedName) {
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
        const forDay = expectedName === NOW || expectedName === TASKS;
        if (!forDay && device.draft && device.draft.fileId !== id) {
          status('Черновик привязан к другому файлу. Выбери исходный файл или сначала очисти черновик.', true);
          return;
        }
        run(async () => {
          const pinned = device.noteNames[id];
          if (expectedName && pinned && expectedName !== pinned) {
            status('Выбери ' + expectedName + '. Этот файл уже выбран как ' + pinned + '.', true);
            return;
          }
          let result;
          try { result = await snapshot(id, sessionRequest(current), expectedName || pinned); }
          catch (error) {
            if (session === current) applyReadError(id, error, true);
            return;
          }
          if (session !== current) return;
          const name = result.meta.name;
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
        }).then(() => {
          if (expectedName === INBOX && session === current && device.activeId === id && readAt) focusDraft();
        });
      }).build();
    controls();
    pickerWindow.setVisible(true);
  } catch (error) { pickerWindow = null; fail(error); controls(); }
}
$('pick').onclick = () => chooseFile();
for (const button of document.querySelectorAll('[data-day-pick]')) {
  button.onclick = () => chooseFile(button.dataset.dayPick);
}
$('today-refresh').onclick = () => run(() => refreshFiles(dayIds()));
function focusDraft() {
  $('capture').scrollIntoView({block: 'center'});
  if (!$('thought').disabled) $('thought').focus();
  else if (!$('save').disabled) $('save').focus();
}
$('search-draft').onclick = focusDraft;
$('today-capture').onclick = async () => {
  if (device.draft) { focusDraft(); return; }
  const id = captureId();
  if (!id) { chooseFile(INBOX); return; }
  if (device.activeId !== id || !readAt) {
    selectId(id, INBOX);
    await run(readActive);
  }
  if (session && readAt && device.activeId === id) focusDraft();
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
  search.changed(verified.meta);
  show(verified, draft.op);
  finishDraft(already ? 'Запись уже была в Drive. Повтор подтверждён без дубля.' : 'Записано в ' + name + ' и подтверждено повторным чтением.');
});
window.addEventListener('beforeunload', event => {
  if (device.draft && (!personal || storageFault)) { event.preventDefault(); event.returnValue = true; }
});
window.addEventListener('storage', event => {
  if (event.key === LEGACY_DRAFT && event.newValue === null) { legacy = null; controls(); }
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
      if (device.connectionEpoch && next.connectionEpoch !== device.connectionEpoch) {
        endSession();
        awaitingLogin = false;
        promptNext = 'select_account';
        status('Подключение завершено в другой вкладке.');
      }
      if ((busy && busy !== 'search' && busy !== 'return') || storageFault) {
        storageWarning('Личные данные изменились в другой вкладке. Проверь свой черновик и обнови страницу.');
        controls();
        return;
      }
      const previousId = device.activeId;
      const previousName = device.noteNames[previousId];
      const previousSources = dayIds();
      device = next;
      stored = latest;
      syncFields();
      listFiles();
      const targetChanged = previousId !== device.activeId || previousName !== device.noteNames[device.activeId];
      if (targetChanged) clearPreview();
      const changed = dayIds().filter(id => id && !previousSources.includes(id));
      if (targetChanged && device.activeId) changed.push(device.activeId);
      if (session && changed.length) {
        if (busy) refreshAfterBusy = true;
        else run(() => refreshFiles(changed));
      }
    }
  } catch {
    storageWarning('Не удалось прочитать настройки, изменённые в другой вкладке.');
  }
  controls();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateDayDate();
  if (session && Date.now() >= session.until) expire();
  if (document.hidden) leaveHandoff();
  else returnToHandoff();
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
  if (returnCheck) fail(new Error('Нет сети. Подключись к интернету и нажми «Обновить», чтобы проверить ответ.'));
  else setHandoff(null);
});

restore();
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
