import {MAX_BYTES, SnapshotVersionChanged} from './drive.js?v=0.15.0';

const FILES = 'https://www.googleapis.com/drive/v2/files/';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v2/files/';

export function selectionError(current, message) {
  const error = new Error(message);
  error.current = current;
  return error;
}

export async function conditionalWrite(current, content, request, readBack) {
  const id = current.meta.id;
  if (!current.meta.capabilities?.canEdit) {
    throw selectionError(current, 'Для записи требуется право редактирования файла.');
  }
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_BYTES) throw selectionError(current, 'После изменения файл превысит лимит 500 КБ.');

  // The v2 ETag must belong to the same version as the bytes used to construct the update.
  const path = encodeURIComponent(id);
  const response = await request(FILES + path + '?fields=id,version,etag');
  const tag = await response.json();
  const changed = async () => ({verified: await readBack(), changed: true});
  if (tag.id !== id || tag.version !== current.meta.version) return changed();
  if (typeof tag.etag !== 'string' || !/^"[^"\s]+"$/.test(tag.etag)) {
    throw selectionError(current, 'Drive не вернул метку версии для безопасной записи. Обнови заметку и повтори попытку.');
  }
  try {
    await request(UPLOAD + path + '?uploadType=media', {
      method: 'PUT',
      headers: {'If-Match': tag.etag, 'Content-Type': current.meta.mimeType || 'text/markdown; charset=UTF-8'},
      body: bytes
    });
  } catch (error) {
    if (error.httpStatus === 412) return changed();
    if (!error.httpStatus || error.httpStatus === 408 || error.httpStatus >= 500) error.uncertain = true;
    throw error;
  }
  try {
    const verified = await readBack().catch(error => {
      if (error instanceof SnapshotVersionChanged) return readBack();
      throw error;
    });
    return {verified, changed: false};
  } catch (error) {
    // The write was accepted. A readback error leaves delivery unresolved even for a 403/404.
    error.uncertain = true;
    throw error;
  }
}
