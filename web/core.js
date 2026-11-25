export const TEST_FILE = 'My-Day-test.md';
export const INBOX = 'Мысли.md';

export function writableNote(name) {
  return name === TEST_FILE || name === INBOX;
}

export function supportedNote(name) {
  return writableNote(name) || name === 'Now.md' || name === 'To Do now.md';
}

export function recordBlock(draft) {
  return '<!-- my-day:' + draft.op + ' -->\n' + draft.text + '\n';
}

export function appendRecord(source, draft) {
  const block = recordBlock(draft);
  if (source.includes(block)) return {content: source, already: true};
  if (source.includes('<!-- my-day:' + draft.op + ' -->')) {
    throw new Error('Метка записи найдена, но текст отличается. Черновик сохранён. Проверь файл вручную.');
  }
  return {content: source + (source.endsWith('\n') ? '\n' : '\n\n') + block, already: false};
}
