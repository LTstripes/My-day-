export function recordBlock(draft) { return "<!-- my-day:"+draft.op+" -->\n"+draft.text+"\n"; }

export function appendRecord(source,draft) {
  const block=recordBlock(draft);
  if(source.includes(block)) return {content:source,already:true};
  if(source.includes("<!-- my-day:"+draft.op+" -->")) throw new Error("Метка записи найдена, но текст отличается. Черновик сохранён; проверь файл вручную.");
  return {content:source+(source.endsWith("\n")?"\n":"\n\n")+block,already:false};
}

export function validateTestFile(meta,source) {
  if(meta.name!=="My-Day-test.md" || meta.trashed || !meta.capabilities?.canEdit || meta.mimeType?.startsWith("application/vnd.google-apps.") || !source.replace(/^\uFEFF/,"").startsWith("# My Day test\n") && !source.replace(/^\uFEFF/,"").startsWith("# My Day test\r\n")) throw new Error("Для первой проверки нужен редактируемый файл My-Day-test.md из тестового шаблона.");
}