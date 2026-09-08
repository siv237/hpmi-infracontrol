// ---- события (реальный журнал сессии) ------------------------------------
let events=[];
const EV_TYPE={ok:'Успешно',info:'Информационное сообщение',warn:'Предупреждение',err:'Ошибка'};
function addEvent(kind,txt){
  events.unshift({kind,txt,when:'Сегодня, '+new Date().toLocaleTimeString('ru-RU')});
  if(events.length>50)events.length=50;
  renderEvents();
}
function renderEvents(){
  const ic={ok:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',warn:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',err:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>'};
  const rows=events.length?events.map(e=>'<div class="ev '+e.kind+'"><span class="ic">'+ic[e.kind]+'</span><span class="txt"><b>'+esc(EV_TYPE[e.kind])+'</b> — '+esc(e.txt)+'</span><span class="when">'+esc(e.when)+'</span></div>').join('')
    :'<div class="tree-empty" style="padding:18px 15px">Событий пока нет. Подключитесь к серверу или откройте консоль.</div>';
  $('evList').innerHTML=rows;
  $('evListFull').innerHTML=rows;
}
