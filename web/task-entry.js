import {taskPlaces} from './today.js?v=0.15.0';

export function initTaskEntry({edit, discard, submit, changed}) {
  const byId = id => document.getElementById(id);
  const entry = byId('task-entry');
  const form = byId('task-add-form'), text = byId('task-text'), select = byId('task-place');
  const button = byId('task-add'), clear = byId('task-discard'), hint = byId('task-status');
  let key = '', shownId = '', placesError = '', notice = '', isError = false;
  let hadDraft = false, previousAccess;

  function message(value = '', error = false) {
    notice = value;
    isError = error;
    hint.textContent = value;
    hint.classList.toggle('error', error);
    if (value) entry.open = true;
  }
  text.oninput = () => { message(); edit(text.value); };
  select.onchange = changed;
  clear.onclick = discard;
  form.onsubmit = event => {
    event.preventDefault();
    if (!button.disabled) submit(select.value);
  };
  function update(source, draft, locked, canSend) {
    entry.hidden = form.hidden = !source?.canEdit && !draft;
    const fileId = draft?.fileId ?? source?.fileId ?? '';
    const access = source?.canEdit;
    if (fileId !== shownId) {
      message();
      entry.open = Boolean(draft);
      shownId = fileId;
    } else if (draft && (!hadDraft || access !== previousAccess)) {
      if (access !== previousAccess) message();
      entry.open = true;
    }
    hadDraft = Boolean(draft);
    previousAccess = access;
    const next = source ? [source.fileId, source.version, source.date].join('/') : '';
    if (key !== next) {
      const previousError = placesError;
      key = next;
      placesError = '';
      select.replaceChildren();
      byId('task-place-field').hidden = true;
      if (source) {
        try {
          const {choices, defaultId} = taskPlaces(source.content, source.date);
          if (!defaultId) select.add(new Option('Выбери раздел', ''));
          for (const {id, label} of choices) select.add(new Option(label, id));
          select.value = defaultId ?? '';
          byId('task-place-field').hidden = Boolean(defaultId);
        } catch (error) { placesError = error.message; }
      }
      if (placesError && placesError !== previousError) entry.open = true;
    }
    if (text.value !== (draft?.text ?? '')) text.value = draft?.text ?? '';
    const pending = Boolean(draft?.version);
    text.readOnly = Boolean(draft?.op);
    text.disabled = locked || (!source && !draft);
    select.disabled = locked || pending;
    button.disabled = !canSend || source?.fileId !== draft?.fileId || !source || !draft?.text.trim() ||
      (!pending && (!source.canEdit || !select.value || Boolean(placesError)));
    button.textContent = pending ? (source?.canEdit ? 'Проверить и повторить' : 'Проверить отправку') : 'Добавить дело';
    clear.hidden = !draft;
    clear.disabled = locked;
    const fallback = !source && draft ? 'Черновик сохранён. Подключись и обнови список дел.' :
      source && !source.canEdit ? (pending ? 'Файл доступен для чтения. Можно проверить предыдущую отправку.' : 'Для добавления дела нужен доступ на редактирование.') :
      pending ? 'Отправка начата. При повторе My Day сначала сверит дело с Drive.' :
      draft?.op ? 'Список изменился. Сверь дело с файлом в Drive и подтверди выбор раздела.' : '';
    hint.textContent = notice || placesError || fallback;
    hint.classList.toggle('error', isError || Boolean(placesError));
  }
  return {update, message};
}
