import {DEVICE_KEY, LEGACY_DRAFT, newDevice, readDevice, readDraft, validId, validPickerKey, validProject} from './device.js';
import {driveError, saveDraft, snapshot} from './drive.js';

const CLIENT = '327713401108-rdi4uv2duskfvn8d368i2ui56uhqsulo.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const $ = id => document.getElementById(id);

let device = newDevice(), personal = false, stored = null, legacy = null, storageFault = false;
let client = null, session = null, expiryTimer, pickerReady = false, pickerWindow = null, awaitingLogin = false, busy = false;
let promptNext = null, hasConnected = false, readAt = '';

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
function clearPreview() {
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
  const select = $('known');
  select.replaceChildren();
  for (const id of device.fileIds) select.add(new Option('My-Day-test.md · ' + id, id));
  select.value = device.activeId ?? '';
  $('first-pick').hidden = Boolean(device.activeId);
  $('known-files').hidden = device.fileIds.length < 2;
  $('file').textContent = device.activeId ? 'My-Day-test.md · ID ' + device.activeId : 'Файл ещё не выбран.';
}
function selectId(id) {
  if (device.activeId !== id) clearPreview();
  if (!device.fileIds.includes(id)) device.fileIds.push(id);
  device.activeId = id;
  listFiles();
  persist();
}
function controls() {
  const locked = busy || awaitingLogin || Boolean(pickerWindow);
  const connected = Boolean(session && Date.now() < session.until);
  const draft = device.draft;
  $('remember').disabled = locked;
  $('key').disabled = $('project').disabled = locked;
  $('connect').disabled = locked || !client || connected;
  $('connect').textContent = connected ? 'Google Drive подключён' :
    (hasConnected || device.activeId ? 'Подключиться снова' : 'Подключить Google Drive');
  $('disconnect').disabled = locked || !session;
  $('forget').disabled = locked;
  $('pick').disabled = locked || !connected || !pickerReady;
  $('known').disabled = locked || Boolean(draft) || !connected;
  $('refresh').disabled = locked || !connected || !device.activeId;
  $('thought').disabled = locked || !device.activeId || Boolean(draft?.op);
  $('save').disabled = locked || !connected || !draft?.text.trim() || draft.fileId !== device.activeId || !readAt;
  $('save').textContent = draft?.op ? 'Проверить и повторить' : 'Добавить в Drive';
  $('discard').disabled = locked || !draft;
  $('legacy').hidden = !legacy;
  $('recover').disabled = locked || Boolean(draft);
  $('device-hint').textContent = personal ?
    'В этом браузере сохраняются ограниченный ключ Picker, номер проекта, ID тестовых файлов и текст черновика. Токен Google живёт только во вкладке.' :
    'На общем компьютере оставь флажок снятым. Ключ, выбор файлов и черновик будут жить только в этой вкладке.';
  const where = personal && !storageFault ? 'Черновик сохранён на устройстве.' : 'Черновик в этой вкладке. Оставь её открытой.';
  $('draft').textContent = !draft ? 'Черновика нет.' : where + (draft.op ?
    ' Отправка начата. Повтор сначала проверит метку записи в том же файле.' : ' Запись ещё не отправлена.');
}

function endSession() {
  if (pickerWindow) { pickerWindow.setVisible(false); pickerWindow = null; }
  session?.abort.abort();
  session = null;
  clearTimeout(expiryTimer);
  clearPreview();
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
  const signal = AbortSignal.any && AbortSignal.timeout ?
    AbortSignal.any([current.abort.signal, AbortSignal.timeout(30000)]) : current.abort.signal;
  const response = await fetch(url, {...options, cache: 'no-store', signal,
    headers: {...options.headers, Authorization: 'Bearer ' + current.token}});
  if (!response.ok) {
    const operation = options.method === 'PATCH' ? 'запись' : url.includes('alt=media') ? 'чтение текста' : 'чтение сведений о файле';
    throw driveError(response.status, await response.json().catch(() => null), operation);
  }
  return response;
}
function show(result) {
  $('preview').textContent = result.content;
  readAt = new Date().toLocaleString('ru-RU');
  $('fresh').textContent = 'Прочитано из Drive · ' + readAt;
  $('drive-link').href = 'https://drive.google.com/open?id=' + encodeURIComponent(result.meta.id);
  $('drive-link').hidden = false;
}
function fail(error) {
  if (error.access === 'expired' || error.access === 'consent') {
    endSession();
    if (error.access === 'consent') promptNext = 'consent';
  } else if (error.access === 'file') {
    clearPreview();
    promptNext = 'select_account';
  } else if (readAt) {
    $('fresh').textContent = 'Последнее чтение · ' + readAt + '. Данные могут быть устаревшими.';
  }
  const message = error instanceof TypeError || error.name === 'TimeoutError' ?
    'Не удалось связаться с Drive. Проверь интернет и повтори попытку.' : error.message;
  status(message || 'Не удалось выполнить операцию.', true);
}
async function run(action) {
  if (busy || awaitingLogin || pickerWindow) return;
  const current = session;
  busy = true;
  controls();
  try { await action(); }
  catch (error) { if (current === session) fail(error); }
  finally { busy = false; controls(); }
}
async function readActive() {
  status('Читаем тестовый файл из Drive…');
  show(await snapshot(device.activeId, request));
  status('Получено актуальное содержимое из Google Drive.');
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
  session = {token: response.access_token, until: Date.now() + usable, abort: new AbortController()};
  hasConnected = true;
  expiryTimer = setTimeout(expire, usable);
  controls();
  if (device.activeId) run(readActive);
  else status('Google Drive подключён. Выбери тестовый файл.');
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
    callback: connected, error_callback: () => {
      if (!awaitingLogin) return;
      awaitingLogin = false;
      status('Окно входа не открылось или было закрыто. Разреши всплывающее окно Google и нажми кнопку подключения.', true);
      controls();
    }});
  status(device.activeId ? 'Выбор файла восстановлен. Подключись, чтобы прочитать его из Drive.' : 'Подключи Google Drive и выбери тестовый файл.');
  controls();
}
function pickerFailed() {
  $('picker-error').textContent = 'Picker не загрузился. Для выбора нового файла проверь интернет и обнови страницу.';
  $('picker-error').hidden = false;
}
$('connect').onclick = () => {
  if (session && Date.now() >= session.until) expire();
  if (!client || busy || awaitingLogin || pickerWindow || session) return;
  awaitingLogin = true;
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
  if (personal) { endSession(); promptNext = 'select_account'; }
  else resetTab();
  status(personal ? 'Отключено. Настройки и черновик доступны на этом устройстве.' : 'Отключено. Данные этого сеанса очищены.');
  controls();
};
$('remember').onchange = () => {
  if ($('remember').checked) {
    personal = true;
    if (!persist()) personal = false;
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
$('recover').onclick = () => {
  if (!legacy || device.draft) return;
  device.draft = legacy;
  selectId(legacy.fileId);
  $('thought').value = legacy.text;
  if (!personal || !storageFault) {
    try { localStorage.removeItem(LEGACY_DRAFT); legacy = null; }
    catch { storageWarning('Браузер не дал удалить старую копию черновика.'); }
  }
  status('Черновик версии 0.1.1 восстановлен с прежней меткой отправки.');
  controls();
  if (session) run(readActive);
};
for (const field of ['key', 'project']) $(field).oninput = () => {
  const value = $(field).value.trim();
  if (field === 'key') device.pickerKey = validPickerKey(value) ? value : '';
  if (field === 'project' && validProject(value)) device.project = value;
  persist();
  controls();
};
$('pick').onclick = () => {
  if (!session || !pickerReady || busy || awaitingLogin || pickerWindow) return;
  if (Date.now() >= session.until) { expire(); return; }
  if (!validPickerKey($('key').value.trim()) || !validProject($('project').value.trim())) {
    $('setup').open = true;
    status('Для выбора файла введи ограниченный ключ Google Picker (AIza…) и числовой номер проекта.', true);
    return;
  }
  try {
    const current = session;
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true)
      .setSelectFolderEnabled(false).setMode(google.picker.DocsViewMode.LIST);
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
        if (device.draft && device.draft.fileId !== id) {
          status('Черновик привязан к другому файлу. Выбери исходный файл или сначала очисти черновик.', true);
          return;
        }
        run(async () => {
          const result = await snapshot(id, request);
          selectId(id);
          show(result);
          $('setup').open = false;
          status('Тестовый файл прочитан из Drive.');
        });
      }).build();
    controls();
    pickerWindow.setVisible(true);
  } catch (error) { pickerWindow = null; fail(error); controls(); }
};
$('known').onchange = () => {
  if (device.draft || !device.fileIds.includes($('known').value)) return;
  selectId($('known').value);
  run(readActive);
};
$('refresh').onclick = () => run(readActive);
$('thought').oninput = () => {
  if (!device.activeId || device.draft?.op) return;
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
  if (!draft?.text.trim() || draft.fileId !== device.activeId || !readAt) return;
  if (!draft.op) {
    device.draft = {...draft, op: crypto.randomUUID(), text: draft.text.trim()};
    if (!persist()) { device.draft = draft; return; }
    draft = device.draft;
    $('thought').value = draft.text;
  } else if (!persist()) {
    return;
  }
  const {verified, already} = await saveDraft(draft, request);
  show(verified);
  device.draft = null;
  if (!persist()) { device.draft = draft; status('Drive подтвердил запись. Не удалось очистить местный черновик.', true); return; }
  $('thought').value = '';
  status(already ? 'Запись уже была в Drive. Повтор подтверждён без дубля.' : 'Записано в Google Drive и подтверждено повторным чтением.');
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
    } else if (busy || storageFault) {
      storageWarning('Личные данные изменились в другой вкладке. Проверь свой черновик и обнови страницу.');
    } else {
      const previousId = device.activeId;
      device = readDevice(latest);
      stored = latest;
      syncFields();
      listFiles();
      if (previousId !== device.activeId) {
        clearPreview();
        if (session && device.activeId) run(readActive);
      }
    }
  } catch {
    storageWarning('Не удалось прочитать настройки, изменённые в другой вкладке.');
  }
  controls();
});
document.addEventListener('visibilitychange', () => { if (session && Date.now() >= session.until) expire(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

restore();
syncFields();
listFiles();
controls();
loadScript('https://accounts.google.com/gsi/client', initAuth, () => {
  status('Не загрузилась библиотека входа Google. Проверь интернет и обнови страницу.', true);
});
loadScript('https://apis.google.com/js/api.js', () => {
  gapi.load('picker', {callback: () => { pickerReady = true; controls(); }, onerror: pickerFailed, timeout: 15000, ontimeout: pickerFailed});
}, pickerFailed);
