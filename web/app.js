import {appendRecord,recordBlock,validateTestFile} from './core.js';
const CLIENT='327713401108-rdi4uv2duskfvn8d368i2ui56uhqsulo.apps.googleusercontent.com';
const SCOPE='https://www.googleapis.com/auth/drive.file';
const API='https://www.googleapis.com/drive/v3/files/';
const STORAGE='my-day-test-draft-v1';
const $=id=>document.getElementById(id);
let token=null, expires=0, client=null, pickerReady=false, busy=false, choosing=false, selected=null, pending=null;
const status=(s,error=false)=>{$('status').textContent=s;$('status').classList.toggle('error',error)};
function hasToken(){return Boolean(token&&Date.now()<expires)}
function controls(){
  const locked=busy||choosing, authorized=hasToken(), same=!pending||selected?.id===pending.fileId;
  $('connect').disabled=locked||!client;
  $('disconnect').disabled=locked||!token;
  $('pick').disabled=locked||!authorized||!pickerReady;
  $('refresh').disabled=locked||!authorized||!selected;
  $('thought').disabled=locked||!selected||!authorized||Boolean(pending);
  $('save').disabled=locked||!authorized||!selected||!same||(!pending&&!$('thought').value.trim());
  $('discard').disabled=locked||(!pending&&!$('thought').value);
  $('save').textContent=pending?'Повторить / проверить запись':'Добавить в Drive';
  $('draft').textContent=pending?'Черновик сохранён на этом устройстве. '+(same?'Повтори отправку для того же файла.':'Выбери исходный тестовый файл для повтора.'):($('thought').value?'Тестовый текст ещё не отправлен.':'Черновик отсутствует.');
}
function clearSelection(){
  selected=null;$('file').textContent='Файл не выбран';$('drive-link').hidden=true;$('drive-link').removeAttribute('href');$('preview').textContent='Выбери тестовый файл.';$('fresh').textContent='Не прочитано';
}
function keepDraft(){localStorage.setItem(STORAGE,JSON.stringify(pending))}
function clearDraft(){localStorage.removeItem(STORAGE);pending=null;$('thought').value=''}
function fail(e){$('fresh').textContent=selected?'Последнее отображение может быть устаревшим.':'Не прочитано';status((e?.message||'Ошибка операции')+(pending?' Черновик сохранён для повтора.':''),true)}
function restore(){
  try{const saved=JSON.parse(localStorage.getItem(STORAGE)||'null');
    if(saved&&typeof saved.text==='string'&&typeof saved.fileId==='string'&&typeof saved.op==='string'&&saved.text.length<=3000&&/^[0-9a-f-]{36}$/.test(saved.op)){pending=saved;$('thought').value=saved.text}
  }catch{status('Локальное хранилище недоступно. Для записи потребуется разрешить его.',true)}
}
function describeDriveError(status,body,operation){
  const err=body?.error;
  const reasons=[...(Array.isArray(err?.errors)?err.errors.map(x=>x?.reason):[]),...(Array.isArray(err?.details)?err.details.map(x=>x?.reason):[]),err?.status].filter(x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,100}$/.test(x));
  const codes=[...new Set(reasons)];
  let advice="Пришли этот код ошибки. Настройки и ключи пока не меняй.";
  if(codes.some(x=>["SERVICE_DISABLED","accessNotConfigured","apiDisabled"].includes(x)))advice="Проверь, что Google Drive API (drive.googleapis.com) включён в том же Cloud project, что и OAuth Client ID.";
  else if(codes.includes("appNotAuthorizedToFile"))advice="Google не выдал приложению доступ к выбранному файлу. Проверим Picker и номер проекта.";
  else if(codes.some(x=>["ACCESS_TOKEN_SCOPE_INSUFFICIENT","insufficientPermissions"].includes(x)))advice="Google не подтвердил нужный scope. Проверим согласие drive.file.";
  else if(codes.includes("insufficientFilePermissions"))advice="Google не подтвердил право редактирования файла.";
  else if(codes.includes("fileNotDownloadable"))advice="Google не позволяет скачать содержимое как обычный файл.";
  return "Google Drive: HTTP "+status+" · "+operation+"\n"+(codes.length?"Причина Google: "+codes.join(", ")+"\n":"Google не вернул код причины.\n")+advice;
}
async function request(url,options={}){
  if(!hasToken()){token=null;throw new Error('Доступ Google истёк. Нажми «Подключить Google Drive» ещё раз.')}
  const response=await fetch(url,{...options,cache:'no-store',headers:{...options.headers,Authorization:'Bearer '+token}});
  if(response.status===401){token=null;throw new Error('Google отклонил токен. Подключись повторно.')}
  if(!response.ok){
    const operation=options.method==='PATCH'?'запись файла':url.includes('alt=media')?'чтение содержимого':'чтение метаданных';
    const errorBody=await response.json().catch(()=>null);
    throw new Error(describeDriveError(response.status,errorBody,operation));
  }
  return response;
}
async function metadata(id){
  const r=await request(API+encodeURIComponent(id)+'?fields=id,name,mimeType,version,size,trashed,capabilities(canEdit)');
  return r.json();
}
async function snapshot(id){
  const before=await metadata(id);
  if(before.id!==id||before.name!=='My-Day-test.md'||before.mimeType?.startsWith('application/vnd.google-apps.')||Number(before.size)>500000||before.trashed||!before.capabilities?.canEdit)throw new Error('Выбери маленький редактируемый My-Day-test.md, не Google Docs.');
  const r=await request(API+encodeURIComponent(id)+'?alt=media');
  const bytes=await r.arrayBuffer();
  if(bytes.byteLength>500000)throw new Error('Тестовый файл слишком большой.');
  const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  const after=await metadata(id);
  if(before.version!==after.version)throw new Error('Файл изменился во время чтения. Нажми «Обновить».');
  validateTestFile(after,content);return {meta:after,content};
}
function show(s){
  selected=s.meta;
  $('file').textContent=s.meta.name+' · ID: '+s.meta.id;
  $('drive-link').href='https://drive.google.com/open?id='+encodeURIComponent(s.meta.id);$('drive-link').hidden=false;
  $('preview').textContent=s.content;$('fresh').textContent='Прочитано: '+new Date().toLocaleTimeString('ru-RU');
}
async function run(fn){if(busy)return;busy=true;controls();try{await fn()}catch(e){fail(e)}finally{busy=false;controls()}}
function connected(response){
  choosing=false;
  if(response.error||!response.access_token||!google.accounts.oauth2.hasGrantedAllScopes(response,SCOPE)){token=null;clearSelection();status('Google не выдал разрешение drive.file: '+(response.error||'доступ не предоставлен'),true);controls();return}
  token=response.access_token;expires=Date.now()+Number(response.expires_in||3600)*1000-15000;
  clearSelection();status('Google Drive подключён. Выбери тестовый файл.');controls();
}
function init(){
  restore();
  if(!window.google?.accounts?.oauth2||!window.gapi){status('Библиотеки Google не загрузились. Проверь интернет и обнови страницу.',true);controls();return}
  client=google.accounts.oauth2.initTokenClient({client_id:CLIENT,scope:SCOPE,include_granted_scopes:false,callback:connected,error_callback:e=>{choosing=false;status('Вход не завершён: '+(e.type||'ошибка окна'),true);controls()}});
  gapi.load('picker',{callback:()=>{pickerReady=true;status('Готово к подключению. Введи ограниченный ключ Picker.');controls()},onerror:()=>{status('Не удалось загрузить Google Picker. Обнови страницу.',true);controls()},timeout:15000,ontimeout:()=>{status('Google Picker не загрузился. Обнови страницу.',true);controls()}});
  controls();
}
$('connect').onclick=()=>{if(!client||busy||choosing)return;choosing=true;controls();try{client.requestAccessToken({prompt:'select_account'})}catch(e){choosing=false;fail(e);controls()}};
$('disconnect').onclick=()=>{token=null;expires=0;clearSelection();$('key').value='';status('Отключено. Токен удалён из памяти страницы.');controls()};
$('pick').onclick=()=>{
  if(!hasToken()||!pickerReady)return;
  const key=$('key').value.trim(), project=$('project').value.trim();
  if(!key||!/^\d+$/.test(project)){status('Введи API key Picker и числовой номер Cloud project.',true);return}
  try{choosing=true;controls();
    const view=new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setMode(google.picker.DocsViewMode.LIST);
    const picker=new google.picker.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(key).setAppId(project).setOrigin(location.origin).setCallback(data=>{
      const action=data[google.picker.Response.ACTION];
      if(action===google.picker.Action.CANCEL){choosing=false;controls();return}
      if(action!==google.picker.Action.PICKED)return;
      choosing=false;
      const doc=data[google.picker.Response.DOCUMENTS]?.[0],id=doc?.[google.picker.Document.ID];
      if(!id){status('Google не вернул ID файла.',true);controls();return}
      clearSelection();run(async()=>{show(await snapshot(id));status('Тестовый файл прочитан из Drive.');});
    }).build();picker.setVisible(true);
  }catch(e){choosing=false;fail(e);controls()}
};
$('refresh').onclick=()=>run(async()=>{show(await snapshot(selected.id));status('Получено актуальное содержимое Google Drive.')});
$('thought').oninput=controls;
$('discard').onclick=()=>{if(pending&&!confirm('Удалить локальный черновик? Если запись уже была доставлена, она останется в Google Drive.'))return;try{clearDraft();controls();status('Локальный черновик очищен.')}catch(e){fail(e)}};
$('save').onclick=()=>run(async()=>{
  if(!selected||!hasToken())throw new Error('Сначала подключи Drive и выбери файл.');
  if(!pending){
    const text=$('thought').value.trim();if(!text)return;
    pending={fileId:selected.id,op:crypto.randomUUID(),text};
    try{keepDraft()}catch{pending=null;throw new Error('Не удалось сохранить локальный черновик. Запись не отправлена.')}
  }
  if(pending.fileId!==selected.id)throw new Error('Черновик относится к другому файлу.');
  const d=pending, current=await snapshot(d.fileId), next=appendRecord(current.content,d);
  if(!next.already){
    const latest=await metadata(d.fileId);
    if(latest.version!==current.meta.version)throw new Error('Файл изменился перед записью. Повтори попытку.');
    await request('https://www.googleapis.com/upload/drive/v3/files/'+encodeURIComponent(d.fileId)+'?uploadType=media',{method:'PATCH',headers:{'Content-Type':current.meta.mimeType||'text/markdown; charset=UTF-8'},body:new TextEncoder().encode(next.content)});
  }
  const verified=await snapshot(d.fileId);
  if(!verified.content.includes(recordBlock(d))||(!next.already&&!verified.content.startsWith(current.content)))throw new Error('Не удалось подтвердить сохранность исходника и записи. Не удаляй черновик.');
  show(verified);clearDraft();status(next.already?'Запись уже присутствует в Drive. Повтор не создал дубль.':'Записано в Google Drive и подтверждено повторным чтением.');
});
if(document.readyState==='complete')init();else window.addEventListener('load',init,{once:true});
