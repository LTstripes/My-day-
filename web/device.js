import {INBOX, NOW, supportedNote, TASKS, TEST_FILE} from './core.js?v=0.14.0';

export const DEVICE_KEY = 'my-day-device-v1';
export const LEGACY_DRAFT = 'my-day-test-draft-v1';
export const DEFAULT_PROJECT = '327713401108';

export const validPickerKey = value => typeof value === 'string' && /^AIza[A-Za-z0-9_-]{35}$/.test(value);
export const validProject = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
export const validId = value => typeof value === 'string' && /^[\w-]{1,256}$/.test(value);
export const validMarkdownName = value => typeof value === 'string' && /\.md$/i.test(value);

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

function readTaskDraft(value) {
  const draft = readDraft(value);
  if (!draft || draft.text.length > 300 || /[\r\n]/.test(draft.text)) return null;
  if (value.version != null) {
    if (!draft.op || typeof value.version !== 'string' || !/^\d+$/.test(value.version) ||
        typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
        typeof value.place !== 'string' || !value.place || value.place.length > 300) return null;
    Object.assign(draft, {version: value.version, date: value.date, place: value.place});
  }
  return draft;
}

export function readDevice(raw) {
  return normalizeDevice(JSON.parse(raw));
}

export function withoutSource(device, id) {
  if (device.draft?.fileId === id || device.taskDraft?.fileId === id) return device;
  return normalizeDevice({...device,
    fileIds: device.fileIds.filter(fileId => fileId !== id),
    notes: device.notes?.filter(note => note.id !== id),
    plans: device.plans?.filter(plan => plan.id !== id),
    plan: device.plan?.id === id ? null : device.plan
  });
}

function markdownSources(records) {
  const sources = new Map();
  for (const entry of Array.isArray(records) ? records : []) {
    if (validId(entry?.id) && validMarkdownName(entry.name)) {
      sources.set(entry.id, {id: entry.id, name: entry.name});
    }
  }
  return sources;
}

function normalizeDevice(saved) {
  if (saved?.version !== 1 || !Array.isArray(saved.fileIds)) throw new Error('Некорректные настройки My Day.');
  const device = newDevice();
  if (typeof saved.connectionEpoch === 'string' && /^[a-f0-9-]{36}$/i.test(saved.connectionEpoch)) {
    device.connectionEpoch = saved.connectionEpoch;
  }
  if (validPickerKey(saved.pickerKey)) device.pickerKey = saved.pickerKey;
  if (validProject(saved.project)) device.project = saved.project;
  const plans = markdownSources(saved.plans);
  // 0.10 stored the current plan on its own.
  if (validId(saved.plan?.id) && validMarkdownName(saved.plan.name)) {
    plans.set(saved.plan.id, {id: saved.plan.id, name: saved.plan.name});
  }
  if (plans.size) {
    device.plans = [...plans.values()];
    device.plan = plans.get(saved.plan?.id) ?? device.plans[0];
    if (plans.has(saved.pinnedPlanId)) device.pinnedPlanId = saved.pinnedPlanId;
  }
  const notes = markdownSources(saved.notes);
  const roleIds = new Set(saved.fileIds.filter(validId));
  device.draft = readDraft(saved.draft);
  if (saved.draft != null && !device.draft) throw new Error('Не удалось прочитать сохранённый черновик.');
  if (device.draft) roleIds.add(device.draft.fileId);
  for (const id of roleIds) {
    // In 0.2 saved source IDs had no names and belonged to the test template.
    const name = saved.noteNames && Object.hasOwn(saved.noteNames, id) ? saved.noteNames[id] : TEST_FILE;
    if (!supportedNote(name)) {
      if (validMarkdownName(name) && !notes.has(id)) notes.set(id, {id, name});
      // Preserve an existing draft and its exact destination even if its role is
      // unsupported. The writer validates both the name and live file metadata.
      if (device.draft?.fileId !== id) continue;
    }
    device.fileIds.push(id);
    device.noteNames[id] = name;
  }
  if (notes.size) {
    device.notes = [...notes.values()];
    const selection = saved.readerId ?? saved.activeId;
    device.readerId = notes.has(selection) ? selection : device.notes[0].id;
  }
  for (const name of [NOW, TASKS, INBOX]) {
    const id = saved.preferredIds?.[name];
    if (validId(id) && device.noteNames[id] === name) device.preferredIds[name] = id;
  }
  if (saved.taskDraft != null) {
    const taskDraft = readTaskDraft(saved.taskDraft);
    if (!taskDraft || device.noteNames[taskDraft.fileId] !== TASKS) throw new Error('Не удалось восстановить черновик дела.');
    device.taskDraft = taskDraft;
    device.preferredIds[TASKS] = taskDraft.fileId;
  }
  device.activeId = device.draft?.fileId ?? (device.fileIds.includes(saved.activeId) ? saved.activeId : device.fileIds[0] ?? null);
  return device;
}
