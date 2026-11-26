const headingPattern = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/;
const listPattern = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/;
const fencePattern = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const taskMarker = /^<!-- my-day:task:([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}) -->$/i;

function columnWidth(prefix) {
  let column = 0;
  for (const character of prefix) column += character === '\t' ? 4 - column % 4 : 1;
  return column;
}

// Keep literal blocks separate so example checkboxes and headings never become real tasks.
export function* contentLines(markdown, forInsertion = false) {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r\n?|\n/);
  let first = 0;
  if (/^---[ \t]*$/.test(lines[0])) {
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(line));
    if (end !== -1) first = end + 1;
    else if (forInsertion) throw new Error('В начале файла не закрыт блок свойств. Проверь его в заметке.');
  }

  const listIndents = [];
  let fence = '';
  let htmlEnd = '';
  let commentEnd = '';
  for (let i = first; i < lines.length; i++) {
    let text = lines[i];
    const marker = fencePattern.exec(text);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = '';
      else yield {text, literal: true};
      continue;
    }
    if (!commentEnd) {
      const rawTag = htmlEnd || /^ {0,3}<(pre|script|style|textarea)(?:[\t >]|$)/i.exec(text)?.[1].toLowerCase();
      if (rawTag) {
        htmlEnd = text.toLowerCase().includes('</' + rawTag + '>') ? '' : rawTag;
        yield {text, literal: true};
        continue;
      }
    }
    if (!commentEnd && text.trim()) {
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
    const taskOp = forInsertion && !commentEnd && taskMarker.exec(text)?.[1];
    if (commentEnd) {
      const end = text.indexOf(commentEnd);
      if (end === -1) continue;
      text = text.slice(end + commentEnd.length);
      commentEnd = '';
    }
    text = text.replace(/`[^`]+`|<!--.*?(-->|$)|%%.*?(%%|$)/g, (part, htmlEnd, obsidianEnd) => {
      if (part.startsWith('`')) return part;
      if (!htmlEnd && !obsidianEnd) commentEnd = part.startsWith('%%') ? '%%' : '-->';
      return '';
    });
    const list = listPattern.exec(text);
    if (list) listIndents.push(columnWidth(list[1] + list[2] + list[3]));
    yield {text, literal: false, lineIndex: i, taskOp};
  }
  if (forInsertion && (fence || htmlEnd || commentEnd)) throw new Error('В заметке не закрыт блок кода или комментарий. Проверь файл перед добавлением.');
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

function listItem(text, includeNumbered) {
  const list = listPattern.exec(text);
  const label = list?.[4].trim();
  if (!label) return null;
  const checkbox = /^\[([ xX])\][ \t]+(.+)$/.exec(label);
  if (checkbox) return {kind: checkbox[1] === ' ' ? 'open' : 'done', text: checkbox[2]};
  if ((!includeNumbered && !/^[-+*]$/.test(list[2])) || /^\[.?\](?:\s|$)/.test(label)) return null;
  return {kind: 'bullet', text: label};
}

export function noteList(markdown) {
  const groups = [];
  let group = {heading: '', items: []};
  for (const {text, literal} of contentLines(markdown)) {
    if (literal) continue;
    const heading = headingPattern.exec(text);
    if (heading) {
      group = {heading: heading[2].replace(/[ \t]+#+$/, ''), items: []};
      continue;
    }
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(text)) continue;
    const entry = listItem(text, true);
    if (!entry) continue;
    if (!group.items.length) groups.push(group);
    group.items.push(entry);
  }
  return groups;
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
  const day = {items: [], unsupported: false};
  const undated = {items: [], unsupported: false};
  let selected = false;
  let scope = undated;
  for (const {text, literal, lineIndex} of contentLines(markdown)) {
    if (literal) continue;
    const heading = headingPattern.exec(text);
    if (heading) {
      sections.length = heading[1].length - 1;
      sections.push(dayHeading(heading[2], isoDate));
      scope = sections.includes(false) ? null : sections.includes(true) ? day : undated;
      if (scope === day) selected = true;
      continue;
    }
    if (!scope || !text.trim() || /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(text)) continue;
    const entry = listItem(text, false);
    if (entry) {
      scope.items.push({...entry, lineIndex});
    } else {
      scope.unsupported = true;
    }
  }
  return {...(selected ? day : undated), selected};
}

// Insert into a heading's own body, before its first subheading or the next
// section. This prevents an item for today from landing in a nested day.
function insertionPlaces(markdown, isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error('Не удалось определить дату дела.');
  const sections = [];
  const headings = [];
  for (const {text, literal, lineIndex} of contentLines(markdown, true)) {
    const heading = !literal && headingPattern.exec(text);
    if (!heading) continue;
    if (headings.length) headings.at(-1).endLine = lineIndex;
    const title = heading[2].replace(/[ \t]+#+$/, '');
    const day = dayHeading(title, isoDate);
    sections.length = heading[1].length - 1;
    sections.push(day);
    headings.push({id: 'line-' + lineIndex, label: title + ' · строка ' + (lineIndex + 1),
      title, eligible: !sections.includes(false), day});
  }
  if (!headings.length) return {choices: [{id: 'end', label: 'В конец списка'}], defaultId: 'end'};
  const today = headings.filter(heading => heading.eligible && heading.day === true);
  if (today.length) {
    const unique = today.length === 1 && (today[0].title.match(/\d{4}-\d{2}-\d{2}/g)?.length ?? 0) <= 1;
    return {choices: today, defaultId: unique ? today[0].id : null};
  }
  const choices = headings.filter(heading => heading.eligible && heading.day == null);
  // An undated file title alone is the same everyday list as a file without a title.
  if (headings.length === 1 && choices.length && /^to do now$/i.test(choices[0].title)) {
    return {choices, defaultId: choices[0].id};
  }
  choices.push({id: 'new-day', label: 'Создать раздел ' + isoDate});
  return {choices, defaultId: null};
}

export function taskPlaces(markdown, isoDate) {
  const {choices, defaultId} = insertionPlaces(markdown, isoDate);
  return {choices: choices.map(({id, label}) => ({id, label})), defaultId};
}

function validTask(draft) {
  return typeof draft.text === 'string' && draft.text === draft.text.trim() && draft.text.length > 0 &&
    draft.text.length <= 300 && !/[\x00-\x1f\x7f\u2028\u2029]/.test(draft.text) &&
    typeof draft.op === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(draft.op);
}

export function taskDelivery(markdown, draft) {
  if (!validTask(draft)) return 'conflict';
  // Even an ID left behind in a damaged comment requires manual review.
  const op = draft.op.toLowerCase();
  const source = markdown.toLowerCase();
  const reference = source.indexOf(op);
  if (reference === -1) return 'missing';
  if (source.indexOf(op, reference + op.length) !== -1) return 'conflict';
  const lines = markdown.split(/\r\n?|\n/);
  try {
    for (const {lineIndex, taskOp} of contentLines(markdown, true)) {
      if (taskOp && taskOp.toLowerCase() === op) {
        // A completed task still belongs to the same operation.
        const next = /^- \[[ xX]\] (.+)$/.exec(lines[lineIndex + 1] ?? '');
        return next?.[1] === draft.text ? 'delivered' : 'conflict';
      }
    }
  } catch { /* An operation inside malformed frontmatter is not confirmed. */ }
  return 'conflict';
}

export function insertTask(markdown, draft) {
  if (!validTask(draft)) throw new Error('Введи дело одной строкой, до 300 символов.');
  const delivery = taskDelivery(markdown, draft);
  if (delivery === 'delivered') return markdown;
  if (delivery === 'conflict') throw new Error('Метка дела или текст изменились. Проверь файл перед повтором.');
  const {choices, defaultId} = insertionPlaces(markdown, draft.date);
  const place = choices.find(choice => choice.id === (draft.place || defaultId));
  if (!place) throw new Error('Выбери, в какой раздел добавить дело.');

  const lines = markdown.split(/(\r\n|[\r\n])/);
  const index = place.endLine == null ? lines.length : 2 * place.endLine;
  const before = lines.slice(0, index).join('');
  const after = lines.slice(index).join('');
  const endOfLine = before.match(/(\r\n|[\r\n])[^\r\n]*$/)?.[1] ?? markdown.match(/\r\n|[\r\n]/)?.[0] ?? '\n';
  const lead = before && before !== '\uFEFF' && !/[\r\n]$/.test(before) ? endOfLine : '';
  const heading = place.id === 'new-day' ? '# ' + draft.date + endOfLine : '';
  const marker = '<!-- my-day:task:' + draft.op + ' -->';
  const checkbox = '- [ ] ' + draft.text;
  const content = before + lead + heading + marker + endOfLine + checkbox + endOfLine + after;
  // Comments embedded in the user's label or a heading hidden in a multiline
  // comment can make the new task invisible. Check the actual display parser.
  const markerLine = (before + lead + heading).split(/\r\n?|\n/).length - 1;
  if (!todayTasks(content, draft.date).items.some(item => item.lineIndex === markerLine + 1 &&
      item.kind === 'open' && item.text === draft.text) || taskDelivery(content, draft) !== 'delivered') {
    throw new Error('Такое оформление скрывает добавляемое дело. Проверь текст и раздел.');
  }
  return content;
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
