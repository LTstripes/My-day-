import {appendRecord, recordBlock, validateTestFile} from './core.js';

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
    advice = 'Проверь аккаунт Google и право редактирования. Нажми «Выбрать файл» и укажи тот же My-Day-test.md.';
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
  return error;
}

async function metadata(id, request) {
  const response = await request(FILES + encodeURIComponent(id) + '?fields=id,name,mimeType,version,size,trashed,capabilities(canEdit)');
  return response.json();
}

export async function snapshot(id, request) {
  const before = await metadata(id, request);
  if (before.id !== id || before.name !== 'My-Day-test.md' || before.mimeType?.startsWith('application/vnd.google-apps.') ||
      Number(before.size) > MAX_BYTES || before.trashed || !before.capabilities?.canEdit) {
    throw new Error('Выбери через Picker маленький редактируемый My-Day-test.md из тестового шаблона.');
  }
  const response = await request(FILES + encodeURIComponent(id) + '?alt=media');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) throw new Error('Тестовый файл слишком большой.');
  let content;
  try { content = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { throw new Error('Тестовая заметка должна быть сохранена в UTF-8.'); }
  const after = await metadata(id, request);
  if (!before.version || before.version !== after.version) throw new Error('Не удалось подтвердить версию файла. Нажми «Обновить».');
  validateTestFile(after, content);
  return {meta: after, content};
}

export async function saveDraft(draft, request) {
  const current = await snapshot(draft.fileId, request);
  const next = appendRecord(current.content, draft);
  if (!next.already) {
    const bytes = new TextEncoder().encode(next.content);
    if (bytes.length > MAX_BYTES) throw new Error('С этой записью файл превысит лимит тестовой версии (500 КБ).');
    const latest = await metadata(draft.fileId, request);
    if (latest.version !== current.meta.version) throw new Error('Файл изменился перед записью. Повтори попытку.');
    await request(UPLOAD + encodeURIComponent(draft.fileId) + '?uploadType=media', {
      method: 'PATCH', headers: {'Content-Type': current.meta.mimeType || 'text/markdown; charset=UTF-8'}, body: bytes
    });
  }
  const verified = await snapshot(draft.fileId, request);
  if (!verified.content.includes(recordBlock(draft)) || (!next.already && !verified.content.startsWith(current.content))) {
    throw new Error('Не удалось подтвердить исходный текст и запись. Проверь файл перед повтором.');
  }
  return {verified, already: next.already};
}
