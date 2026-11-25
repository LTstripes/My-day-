import {appendRecord, recordBlock, supportedNote, TEST_FILE, writableNote} from './core.js?v=0.4.0';

const FILES = 'https://www.googleapis.com/drive/v3/files/';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files/';
const MAX_BYTES = 500000;

export function driveError(status, body, operation) {
  const err = body?.error;
  const reasons = [err?.status, ...[err?.errors, err?.details].filter(Array.isArray).flat().map(item => item?.reason)]
    .filter(code => typeof code === 'string' && /^[\w-]{1,100}$/.test(code));
  const has = (...codes) => codes.some(code => reasons.includes(code));
  let access, advice;
  if (status === 401 || has('ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientPermissions')) {
    access = status === 401 ? 'expired' : 'consent';
    advice = 'Нажми «Подключиться снова» и разреши My Day доступ к выбранным файлам.';
  } else if (status === 404 || has('appNotAuthorizedToFile', 'insufficientFilePermissions')) {
    access = 'file';
    advice = 'Проверь аккаунт Google и доступ к заметке. Нажми «Выбрать файл» и укажи тот же файл.';
  } else if (has('SERVICE_DISABLED', 'accessNotConfigured', 'apiDisabled')) {
    advice = 'Проверь, что Google Drive API включён в проекте OAuth-клиента.';
  } else if (has('fileNotDownloadable')) {
    advice = 'Выбери обычный Markdown-файл, загруженный без преобразования в Google Документы.';
  } else if (status === 403 && !has('rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded')) {
    access = 'file';
    advice = 'Google отказал в доступе. Проверь аккаунт, разрешение на файл и выбери его снова.';
  } else {
    advice = 'Повтори попытку позже.';
  }
  const codes = [...new Set(reasons)].join(', ');
  const error = new Error(`Google Drive · ${operation} · HTTP ${status}${codes ? ' (' + codes + ')' : ''}. ${advice}`);
  error.access = access;
  error.httpStatus = status;
  return error;
}

async function metadata(id, request) {
  const response = await request(FILES + encodeURIComponent(id) + '?fields=id,name,mimeType,version,size,trashed,capabilities(canEdit)');
  return response.json();
}

function checkFile(meta, id, expectedName) {
  if (meta.id !== id || meta.trashed || meta.mimeType?.startsWith('application/vnd.google-apps.') || !supportedNote(meta.name)) {
    throw new Error('Выбери Мысли.md, Now.md, To Do now.md или My-Day-test.md из тестового шаблона.');
  }
  if (expectedName && meta.name !== expectedName) {
    throw new Error('Имя выбранного файла изменилось. Ожидался ' + expectedName + '. Проверь название в Drive.');
  }
  if (Number(meta.size) > MAX_BYTES) throw new Error('Заметка превышает лимит 500 КБ.');
  if (writableNote(meta.name) && !meta.capabilities?.canEdit) throw new Error('Для записи в ' + meta.name + ' требуется право редактирования.');
}

export async function snapshot(id, request, expectedName) {
  const before = await metadata(id, request);
  checkFile(before, id, expectedName);
  const response = await request(FILES + encodeURIComponent(id) + '?alt=media');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) throw new Error('Заметка превышает лимит 500 КБ.');
  let content;
  try { content = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { throw new Error('Заметка должна быть сохранена в UTF-8.'); }
  const after = await metadata(id, request);
  checkFile(after, id, before.name);
  if (!before.version || before.version !== after.version) throw new Error('Не удалось подтвердить версию файла. Нажми «Обновить».');
  if (after.name === TEST_FILE && !/^\uFEFF?# My Day test\r?\n/.test(content)) {
    throw new Error('Для первой проверки нужен My-Day-test.md с заголовком из тестового шаблона.');
  }
  return {meta: after, content};
}

export async function saveDraft(draft, request, expectedName) {
  if (!writableNote(expectedName)) throw new Error('Эта заметка открывается только для чтения.');
  const current = await snapshot(draft.fileId, request, expectedName);
  const next = appendRecord(current.content, draft);
  if (!next.already) {
    const bytes = new TextEncoder().encode(next.content);
    if (bytes.length > MAX_BYTES) throw new Error('С этой записью файл превысит лимит 500 КБ.');
    const latest = await metadata(draft.fileId, request);
    checkFile(latest, draft.fileId, expectedName);
    if (latest.version !== current.meta.version) throw new Error('Файл изменился перед записью. Повтори попытку.');
    await request(UPLOAD + encodeURIComponent(draft.fileId) + '?uploadType=media', {
      method: 'PATCH', headers: {'Content-Type': current.meta.mimeType || 'text/markdown; charset=UTF-8'}, body: bytes
    });
  }
  const verified = await snapshot(draft.fileId, request, expectedName);
  if (!verified.content.includes(recordBlock(draft)) || (!next.already && !verified.content.startsWith(current.content))) {
    throw new Error('Не удалось подтвердить исходный текст и запись. Проверь файл перед повтором.');
  }
  return {verified, already: next.already};
}
