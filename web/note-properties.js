// A conservative subset of Obsidian frontmatter. Offsets refer to the original
// JS string so clients can replace one scalar without serializing the document.
function scalar(raw) {
  if (!raw) return null;
  if (raw.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) throw new Error();
    return JSON.parse(raw);
  }
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) throw new Error();
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[!&*|>@%\x60{}[\]#,]|^[-?:](?:$|\s)|:\s|:$|[\[\]{},]/.test(raw)) throw new Error();
  return raw;
}

function fieldValue(raw) {
  // Quotes and flow lists may contain '#'; an inline comment must be separated
  // from a value by whitespace. Keep the comment outside the editable span.
  const quoted = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|\[[^\[\]]*\])(?=[ \t]*(?:$)|[ \t]+#)/.exec(raw);
  const token = quoted ? quoted[0] : raw.replace(/(?:^|[ \t]+)#.*$/, '').trimEnd();
  if (token.startsWith('[')) {
    if (!/^\[[^\[\]]*\]$/.test(token)) throw new Error();
    const items = token.slice(1, -1);
    if (items.trim()) for (const item of items.split(',')) {
      if (!item.trim() || (!/^["']/.test(item.trim()) && /(?:^|\s)#/.test(item))) throw new Error();
      scalar(item.trim());
    }
    return {token, value: null};
  }
  return {token, value: scalar(token)};
}

export function noteProperties(raw) {
  const values = new Map(), spans = new Map();
  const bom = raw.startsWith('\uFEFF') ? 1 : 0;
  const opening = /^---[ \t]*(\r\n|[\r\n]|$)/.exec(raw.slice(bom));
  const eol = opening?.[1] || raw.match(/\r\n|[\r\n]/)?.[0] || '\n';
  if (!opening) return {valid: true, values, spans, bom, eol, close: null};
  const lines = /([^\r\n]*)(\r\n|[\r\n]|$)/gy;
  lines.lastIndex = bom + opening[0].length;
  let sequence = false, sequenceIndent = null;
  // Scan the header only. A malformed or duplicate field invalidates the
  // entire map, including earlier fields whose meaning may be ambiguous.
  try {
    while (lines.lastIndex < raw.length) {
      const start = lines.lastIndex;
      const [, line] = lines.exec(raw);
      if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) return {valid: true, values, spans, bom, eol, close: start};
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)) throw new Error();
      if (!line.trim() || /^[ \t]*#/.test(line)) continue;
      const member = /^( *)- +(.+)$/.exec(line);
      if (member && sequence) {
        if (sequenceIndent !== null && sequenceIndent !== member[1].length) throw new Error();
        sequenceIndent = member[1].length;
        fieldValue(member[2]);
        continue;
      }
      const match = /^([^:#\s][^:#]*?)([ \t]*):([ \t]*)(.*)$/.exec(line);
      if (!match || (match[4] && !match[3])) throw new Error();
      const key = scalar(match[1]);
      if (!key || !/^[\p{L}_][\p{L}\p{M}\p{N}_ .-]*$/u.test(key) || values.has(key) ||
          /^(?:true|false|null|yes|no|on|off)$/i.test(key)) throw new Error();
      const {token, value} = fieldValue(match[4]);
      sequence = token.length === 0;
      sequenceIndent = null;
      values.set(key, value);
      const from = start + line.length - match[4].length;
      spans.set(key, {from, to: from + token.length, token});
    }
  } catch {
    return {valid: false, values: new Map(), spans: new Map(), unclosed: !/^(?:---|\.\.\.)[ \t]*$/m.test(raw.slice(bom + opening[0].length))};
  }
  return {valid: false, unclosed: true, values: new Map(), spans: new Map()};
}
