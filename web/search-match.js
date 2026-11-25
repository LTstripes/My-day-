// Search original slices so result offsets use the same UTF-16 coordinates as the note viewer.
function* visibleBlocks(content) {
  let start = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (content.startsWith('---', start)) {
    const header = /^\uFEFF?---[ \t]*(?:\r\n|[\r\n])[\s\S]*?^(?:---|\.\.\.)[ \t]*(?:\r\n|[\r\n]|$)/m.exec(content);
    if (header?.index === 0) start = header[0].length;
  }

  // Fence lines, comments and blank lines separate snippets. Protect literal code from comment parsing.
  const boundaries = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)|`[^`\r\n]*`|<!--|(?:\r\n|\r(?!\n)|\n)[^\S\r\n]*(?:\r\n|[\r\n])/gmu;
  boundaries.lastIndex = start;
  let fence = '';
  for (let token; (token = boundaries.exec(content));) {
    if (token[1]) {
      if (fence && (!token[1].startsWith(fence) || token[2].trim())) continue;
      fence = fence ? '' : token[1];
    } else if (token[0] === '<!--') {
      if (fence && !content.startsWith('<!-- my-day:', token.index)) continue;
      const end = content.indexOf('-->', boundaries.lastIndex);
      boundaries.lastIndex = end === -1 ? content.length : end + 3;
    } else if (token[0].startsWith('`')) {
      continue;
    }
    if (start < token.index) yield {start, text: content.slice(start, token.index)};
    start = boundaries.lastIndex;
  }
  if (start < content.length) yield {start, text: content.slice(start)};
}

function excerpt(text, start, end) {
  const radius = 55;
  let left = Math.max(0, start - radius);
  let right = Math.min(text.length, end + radius);
  if (left && /[\uDC00-\uDFFF]/.test(text[left])) left--;
  if (right < text.length && /[\uDC00-\uDFFF]/.test(text[right])) right++;
  return {
    before: (left ? '…' : '') + text.slice(left, start).replace(/\s+/gu, ' '),
    match: text.slice(start, end).replace(/\s+/gu, ' '),
    after: text.slice(end, right).replace(/\s+/gu, ' ') + (right < text.length ? '…' : '')
  };
}

export function searchNote(name, content, query, limit = 5) {
  const result = {nameMatch: false, total: 0, hits: []};
  const terms = query.trim();
  if (!terms) return result;
  const literal = terms.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[её]\u0308?/giu, '(?:ё|е\\u0308?)').replace(/\s+/gu, '\\s+');
  const expression = new RegExp(literal, 'giu');
  result.nameMatch = expression.test(name);
  const lineBreaks = /\r\n|[\r\n]/g;
  let nextBreak = lineBreaks.exec(content);
  let line = 1;
  for (const block of visibleBlocks(content)) {
    expression.lastIndex = 0;
    for (let found; (found = expression.exec(block.text));) {
      result.total++;
      if (result.hits.length >= limit) continue;
      const start = block.start + found.index;
      const end = block.start + expression.lastIndex;
      while (nextBreak && nextBreak.index < start) {
        line++;
        nextBreak = lineBreaks.exec(content);
      }
      result.hits.push({start, end, line, ...excerpt(block.text, found.index, expression.lastIndex)});
    }
  }
  return result;
}
