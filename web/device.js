import {INBOX, NOW, supportedNote, TASKS, TEST_FILE} from './core.js?v=0.4.0';

export const DEVICE_KEY = 'my-day-device-v1';
export const LEGACY_DRAFT = 'my-day-test-draft-v1';
export const DEFAULT_PROJECT = '327713401108';

export const validPickerKey = value => typeof value === 'string' && /^AIza[A-Za-z0-9_-]{35}$/.test(value);
export const validProject = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
export const validId = value => typeof value === 'string' && /^[\w-]{1,256}$/.test(value);

export function newDevice() {
  return {version: 1, pickerKey: '', project: DEFAULT_PROJECT, fileIds: [], noteNames: Object.create(null),
    preferredIds: {}, activeId: null, draft: null};
}

export function preferredFile(device, name) {
  if (device.preferredIds[name]) return device.preferredIds[name];
  const matches = device.fileIds.filter(id => device.noteNames[id] === name);
  return matches.length === 1 ? matches[0] : null;
}

export function readDraft(value, legacy = false) {
  if (!value || !validId(value.fileId) || typeof value.text !== 'string' ||
      !value.text.length || value.text.length > 3000) return null;
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  if (!(typeof value.op === 'string' && uuid.test(value.op)) && (legacy || value.op !== null)) return null;
  return {fileId: value.fileId, text: value.text, op: value.op};
}

export function readDevice(raw) {
  const saved = JSON.parse(raw);
  if (saved?.version !== 1 || !Array.isArray(saved.fileIds)) throw new Error('Некорректные настройки My Day.');
  const device = newDevice();
  if (typeof saved.connectionEpoch === 'string' && /^[a-f0-9-]{36}$/i.test(saved.connectionEpoch)) {
    device.connectionEpoch = saved.connectionEpoch;
  }
  if (validPickerKey(saved.pickerKey)) device.pickerKey = saved.pickerKey;
  if (validProject(saved.project)) device.project = saved.project;
  device.fileIds = [...new Set(saved.fileIds.filter(validId))];
  device.draft = readDraft(saved.draft);
  if (saved.draft != null && !device.draft) throw new Error('Не удалось прочитать сохранённый черновик.');
  if (device.draft && !device.fileIds.includes(device.draft.fileId)) device.fileIds.push(device.draft.fileId);
  // In 0.2 every remembered ID belonged to the test template.
  for (const id of device.fileIds) {
    const name = saved.noteNames?.[id];
    device.noteNames[id] = supportedNote(name) ? name : TEST_FILE;
  }
  for (const name of [NOW, TASKS, INBOX]) {
    const id = saved.preferredIds?.[name];
    if (validId(id) && device.noteNames[id] === name) device.preferredIds[name] = id;
  }
  device.activeId = device.draft?.fileId ?? (device.fileIds.includes(saved.activeId) ? saved.activeId : device.fileIds[0] ?? null);
  return device;
}
