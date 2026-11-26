const headingPattern = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/;
const listPattern = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/;
const fencePattern = /^[ \t]*(`{3,}|~{3,})(.*)$/;

function columnWidth(prefix) {
  let column = 0;
  for (const character of prefix) column += character === '\t' ? 4 - column % 4 : 1;
  return column;
}

// Keep literal blocks separate so example checkboxes and headings never become real tasks.
function* contentLines(markdown) {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r\n?|\n/);
  let first = 0;
  if (/^---[ \t]*$/.test(lines[0])) {
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(line));
    if (end !== -1) first = end + 1;
  }

  const listIndents = [];
  let fence = '';
  let inComment = false;
  for (let i = first; i < lines.length; i++) {
    let text = lines[i];
    const marker = fencePattern.exec(text);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = '';
      else yield {text, literal: true};
      continue;
    }
    if (!inComment && text.trim()) {
      const spaces = columnWidth(text.match(/^[ \t]*/)[0]);
      while (listIndents.length && listIndents.at(-1) > spaces) listIndents.pop();
      if (spaces >= (listIndents.at(-1) ?? 0) + 4) {
        yield {text, literal: true};
        continue;
      }
      if (marker) {
        fence = marker[1];
        continue;
      }
    }
    if (inComment) {
      const end = text.indexOf('-->');
      if (end === -1) continue;
      text = text.slice(end + 3);
      inComment = false;
    }
    text = text.replace(/`[^`]+`|<!--.*?(-->|$)/g, (part, end) => {
      if (part.startsWith('`')) return part;
      inComment = !end;
      return '';
    });
    const list = listPattern.exec(text);
    if (list) listIndents.push(columnWidth(list[1] + list[2] + list[3]));
    yield {text, literal: false};
  }
}

function dayHeading(title, isoDate) {
  const words = title.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.some(word => ['вчера', 'завтра', 'позавчера', 'послезавтра'].includes(word))) return false;
  const date = title.match(/(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?!\d)/);
  if (date) return date[1] === isoDate;
  const today = words.indexOf('сегодня');
  return today === -1 ? undefined : words[today - 1] !== 'не';
}

function openCheckbox(text) {
  return listPattern.exec(text)?.[4].match(/^\[ \][ \t]+(.+)$/)?.[1].trim();
}

export function firstPlanAction(markdown) {
  for (const {text, literal} of contentLines(markdown)) {
    const action = !literal && openCheckbox(text);
    if (action) return action;
  }
  return null;
}

export function todayTasks(markdown, isoDate) {
  const sections = [];
  const selectedItems = [];
  const openItems = [];
  let selected = false;
  let inToday = false;
  for (const {text, literal} of contentLines(markdown)) {
    if (literal) continue;
    const heading = headingPattern.exec(text);
    if (heading) {
      sections.length = heading[1].length - 1;
      sections.push(dayHeading(heading[2], isoDate));
      inToday = sections.includes(true) && !sections.includes(false);
      if (inToday) selected = true;
      continue;
    }
    const item = openCheckbox(text);
    if (item) {
      openItems.push(item);
      if (inToday) selectedItems.push(item);
    }
  }
  return {items: selected ? selectedItems : openItems, selected};
}

export function nowContext(markdown) {
  const result = [];
  for (const {text, literal} of contentLines(markdown)) {
    const heading = !literal && headingPattern.exec(text);
    if (heading) {
      const title = heading[2].replace(/[ \t]+#+$/, '');
      if (title.toLowerCase() !== 'now') result.push(title);
    } else {
      result.push(text.trimEnd());
    }
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
