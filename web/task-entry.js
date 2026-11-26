import {taskPlaces} from './today.js?v=0.15.0';

export function initTaskEntry({edit, discard, submit, changed}) {
  const byId = id => document.getElementById(id);
  const form = byId('task-add-form'), text = byId('task-text'), select = byId('task-place');
  const button = byId('task-add'), clear = byId('task-discard'), hint = byId('task-status');
  let key = '', shownId = '', placesError = '', notice = '', isError = false;

  function message(value = '', error = false) {
    notice = value;
    isError = error;
    hint.textContent = value;
    hint.classList.toggle('error', error);
  }
  text.oninput = () => { message(); edit(text.value); };
  select.onchange = changed;
  clear.onclick = discard;
  form.onsubmit = event => {
    event.preventDefault();
    if (!button.disabled) submit(select.value);
  };
  function update(source, draft, locked, canSend) {
    form.hidden = !source?.canEdit && !draft;
    const fileId = draft?.fileId ?? source?.fileId ?? '';
    if (fileId !== shownId) { message(); shownId = fileId; }
    const next = source ? [source.fileId, source.version, source.date].join('/') : '';
    if (key !== next) {
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
