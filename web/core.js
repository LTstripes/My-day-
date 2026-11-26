export const TEST_FILE = 'My-Day-test.md';
export const INBOX = 'Мысли.md';
export const NOW = 'Now.md';
export const TASKS = 'To Do now.md';

export function writableNote(name) {
  return name === TEST_FILE || name === INBOX;
}

export function supportedNote(name) {
  return writableNote(name) || name === NOW || name === TASKS;
}

const recordMarker = /^<!-- my-day:(?:assistant:)?[\da-fA-F]{8}-(?:[\da-fA-F]{4}-){3}[\da-fA-F]{12} -->$/;
const frontmatter = /^\uFEFF?---[ \t]*(?:\r\n|[\r\n])[\s\S]*?^(?:---|\.\.\.)[ \t]*(?:\r\n|[\r\n]|$)/m;
const fenceDelimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function readableNote(content) {
  const header = frontmatter.exec(content);
  const first = header?.index === 0 ? header[0].length : 0;
  const removed = [];
  const parts = [];
  let from = 0, fence = '', inComment = false;

  for (const match of content.matchAll(/^([^\r\n]+)(?:\r\n|[\r\n]|$)/gm)) {
    if (match.index < first) continue;
    const line = match.index === 0 ? match[1].replace(/^\uFEFF/, '') : match[1];
    const delimiter = fenceDelimiter.exec(line);
    if (fence) {
      if (delimiter && delimiter[1].startsWith(fence) && !delimiter[2].trim()) fence = '';
      continue;
    }
    if (!inComment && delimiter && (delimiter[1][0] !== '`' || !delimiter[2].includes('`'))) {
      fence = delimiter[1];
      continue;
    }
    if (!inComment && recordMarker.test(line)) {
      const start = match.index + match[1].length - line.length;
      const end = match.index + match[0].length;
      parts.push(content.slice(from, start));
      removed.push({start, end});
      from = end;
      continue;
    }
    for (const [token] of line.matchAll(inComment ? /<!--|-->/g : /`[^`]*`|<!--|-->/g)) {
      if (!inComment && token === '<!--') inComment = true;
      else if (inComment && token === '-->') inComment = false;
    }
  }
  parts.push(content.slice(from));
  return {
    text: parts.join(''),
    // Search reports positions in the original note, including the hidden lines.
    offset(position) {
      let offset = position;
      for (const {start, end} of removed) {
        if (start >= position) break;
        offset -= Math.min(end, position) - start;
      }
      return offset;
    }
  };
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
