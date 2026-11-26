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

function* recordMarkers(content) {
  const header = frontmatter.exec(content);
  const first = header?.index === 0 ? header[0].length : 0;
  let fence = '', inComment = false;

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
      yield {start, end};
      continue;
    }
    for (const [token] of line.matchAll(inComment ? /<!--|-->/g : /`[^`]*`|<!--|-->/g)) {
      if (!inComment && token === '<!--') inComment = true;
      else if (inComment && token === '-->') inComment = false;
    }
  }
}

export function readableNote(content) {
  const removed = [...recordMarkers(content)];
  const parts = [];
  let from = 0;
  for (const {start, end} of removed) {
    parts.push(content.slice(from, start));
    from = end;
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

export const recordConflictMessage = 'Метка неоднозначна или текст отличается. Черновик сохранён. Проверь файл вручную.';

// Compare LF/CRLF in memory. The content sent to Drive keeps its original bytes.
export function lfText(text) {
  return text.replaceAll('\r\n', '\n');
}

export function recordDelivery(source, draft) {
  let position = -1;
  const op = draft.op.toLowerCase();
  // Also count copies in examples and malformed markers carrying the same operation ID.
  for (const match of source.matchAll(/<!--[ \t]*my-day[ \t]*:[ \t]*([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\b/gi)) {
    if (match[1].toLowerCase() !== op) continue;
    if (position !== -1) return 'conflict';
    position = match.index;
  }
  if (position === -1) return 'missing';
  for (const {start} of recordMarkers(source)) {
    if (start === position) {
      return lfText(source.slice(start)).startsWith(lfText(recordBlock(draft))) ? 'delivered' : 'conflict';
    }
  }
  return 'conflict';
}

export function appendRecord(source, draft) {
  const delivery = recordDelivery(source, draft);
  if (delivery === 'delivered') return {content: source, already: true};
  if (delivery === 'conflict') throw new Error(recordConflictMessage);
  return {content: source + (source.endsWith('\n') ? '\n' : '\n\n') + recordBlock(draft), already: false};
}
