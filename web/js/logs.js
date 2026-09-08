// ---- Журналы (IPMI SEL): список, фильтры, детали -------------------------
// Источник — IPMI System Event Log: GET /api/ipmi/sel[?serverId=] (кеш опроса
// 60с). Событие: {id, ts, sensor, detail, category, level}. Уровни
// critical/warning/info мапятся на Критические/Предупреждения/Информационные.
const SEV_LABEL={critical:'Критическое',warning:'Предупреждение',info:'Информационное'};
const CAT_LABEL={temp:'Температура',fan:'Вентиляция',power:'Питание',voltage:'Напряжение',cpu:'Процессор',memory:'Память',watchdog:'Watchdog',critical:'Критические',other:'Прочие'};
const SEV_ICON={
  critical:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  warning:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
};
const SEV_STYLE={critical:'red',warning:'amber',info:'info',default:'gray'};

let logsAll=[], logsSrvMap={}, logSev='', logDate='', logCat='', logSrv='', logPage=1, logPer=10, logSel=null;

// SEL ts приходит «MM/DD/YYYY HH:MM:SS» (англ.) — привести к Date / метке.
function logTs(t){
  const m=/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(t||'');
  if(!m)return {ms:0,label:esc(t||'—')};
  const d=new Date(+m[3],+m[1]-1,+m[2],+m[4],+m[5],+m[6]);
  return {ms:d.getTime(),label:d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})};
}
function logSevChip(sev){
  const c=SEV_STYLE[sev]||SEV_STYLE.default;
  return '<span class="stchip '+c+'"><span class="dot"></span>'+esc(SEV_LABEL[sev]||sev)+'</span>';
}

async function loadLogs(){
  const r=await api('/api/ipmi/sel',{_noKick:true});
  const srv=await api('/api/servers',{_noKick:true});
  logsSrvMap={};
  (srv.servers||[]).forEach(s=>{logsSrvMap[s.id]={name:s.name||s.host,host:s.host||'',group:s.group||''};});
  // культурно: даже без /api/servers событие покажет сервер по id
  const byId=(r&&r.sel)||{};
  const rows=[];
  for(const serverId of Object.keys(byId)){
    const meta=logsSrvMap[serverId]||{name:serverId,host:'',group:''};
    for(const e of (byId[serverId]||[])){
      const t=logTs(e.ts);
      rows.push({serverId,serverName:meta.name,serverHost:meta.host,serverGroup:meta.group,
        id:e.id,ts:e.ts,ms:t.ms,tsLabel:t.label,sensor:e.sensor||'',detail:e.detail||'',
        category:(''+e.category||'other'),level:e.level||'info',sev:(e.level||'info')});
    }
  }
  rows.sort((a,b)=>b.ms-a.ms);
  // Хост часто пишет в SEL сотни одинаковых записей (одно событие, один ts,
  // одно описание). Схлопываем их в одну строку с счётчиком, чтобы журнал не
  // превращался в простыню дублей.
  const keyed=new Map();
  for(const r of rows){
    const k=r.serverId+'|'+r.ms+'|'+r.sensor+'|'+r.detail+'|'+r.sev;
    const ex=keyed.get(k);
    if(ex){ex.count=(ex.count||1)+1;continue;}
    r.count=1;keyed.set(k,r);
  }
  logsAll=[...keyed.values()];
  renderLogs();
}
function filteredLogs(){
  const now=Date.now(), day=86400000;
  return logsAll.filter(r=>{
    if(logSev && r.sev!==logSev)return false;
    if(logCat && r.category!==logCat)return false;
    if(logSrv && r.serverId!==logSrv)return false;
    if(logDate){const n=+logDate;if(r.ms<now-n*day)return false;}
    return true;
  });
}
function renderLogs(){
  // счётчики по всем данным (без учёта severity-фильтра)
  const all=logsAll.length;
  const nCr=logsAll.filter(r=>r.sev==='critical').length;
  const nWa=logsAll.filter(r=>r.sev==='warning').length;
  const nIn=logsAll.filter(r=>r.sev==='info').length;
  const set=(id,v)=>{const e=$(id);if(e)e.textContent=v;};
  set('logsC_all',all);set('logsC_critical',nCr);set('logsC_warning',nWa);set('logsC_info',nIn);
  set('logsCount',all);
  // серверный фильтр — опции
  buildLogServerFilter();
  const rows=filteredLogs();
  const pages=Math.max(1,Math.ceil(rows.length/logPer));
  if(logPage>pages)logPage=pages;
  const from=(logPage-1)*logPer, to=Math.min(rows.length,from+logPer);
  const slice=rows.slice(from,to);
  $('logsRows').innerHTML=slice.length?slice.map(r=>{
    const selCls=(logSel&&logSel.id===r.id&&logSel.serverId===r.serverId)?' style="background:var(--accent-bg)"':'';
    return '<tr data-d="'+esc(JSON.stringify(r))+'"'+selCls+'>'
      +'<td>'+r.tsLabel+(r.count&&r.count>1?(' <span class="logs-dup" title="Повторяющихся записей: '+r.count+'">×'+r.count+'</span>'):'')+'</td>'
      +'<td>'+esc(r.sensor)+(r.detail?('<div style="color:var(--muted);font-size:11.5px;white-space:normal">'+esc(r.detail)+'</div>'):'')+'</td>'
      +'<td>'+esc(r.serverName)+(r.serverGroup?('<div style="color:var(--muted);font-size:11.5px">'+esc(r.serverGroup)+'</div>'):'')+'</td>'
      +'<td>'+logSevChip(r.sev)+'</td></tr>';
  }).join(''):'<tr><td colspan="4" class="ov-empty">Записей нет</td></tr>';
  $('logsRows').querySelectorAll('tr[data-d]').forEach(tr=>{
    tr.onclick=()=>{const o=JSON.parse(tr.getAttribute('data-d'));selectLog(o);};
  });
  $('logsRange').textContent='Показано '+from+'−'+to+' из '+rows.length;
  const pgs=$('logsPages');
  if(pages<=1){pgs.innerHTML='';}
  else{
    let h='';
    if(logPage>1)h+='<span class="pg" data-p="'+(logPage-1)+'">‹</span>';
    for(let p=1;p<=pages;p++){
      if(pages>7&&p>2&&p<pages-1&&Math.abs(p-logPage)>1){if(!h.endsWith('<span class="pg gap">…</span>'))h+='<span class="pg gap">…</span>';continue;}
      h+='<span class="pg'+(p===logPage?' cur':'')+'" data-p="'+p+'">'+p+'</span>';
    }
    if(logPage<pages)h+='<span class="pg" data-p="'+(logPage+1)+'">›</span>';
    pgs.innerHTML=h;
    pgs.querySelectorAll('.pg[data-p]').forEach(b=>b.onclick=()=>{logPage=Number(b.getAttribute('data-p'));renderLogs();});
  }
}
function buildLogServerFilter(){
  const f=$('logsServer'); if(!f)return;
  const cur=f.value;
  const m={};
  logsAll.forEach(r=>{const k=r.serverId;if(!m[k])m[k]={name:r.serverName,group:r.serverGroup};});
  const keys=Object.keys(m).filter(k=>logsSrvMap[k]||true);
  const uniq=keys.map(k=>({id:k,...m[k]})).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  f.innerHTML='<option value="">Все серверы</option>'+uniq.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name)+(s.group?(' · '+esc(s.group)):'')+'</option>').join('');
  f.value=uniq.some(s=>s.id===cur)?cur:'';
}
function selectLog(o){
  logSel=o;
  $('logsEmpty').style.display='none';
  $('logsDetail').style.display='block';
  $('ldIco').className='logs-lvl '+o.sev;
  $('ldIco').innerHTML=SEV_ICON[o.sev]||SEV_ICON.info;
  $('ldTitle').textContent=o.sensor||'Событие';
  $('ldSub').textContent=o.serverName+(o.serverHost?(' · '+o.serverHost):'');
  $('ldWhen').textContent=o.tsLabel;
  $('ldDesc').textContent=o.detail||'Без описания';
  // Основная информация
  const cat=CAT_LABEL[o.category]||o.category;
  $('ldTable').innerHTML=[
    ['Время',o.tsLabel],
    ['Сервер',o.serverName],
    ['Адрес',o.serverHost],
    ['Группа',o.serverGroup||'—'],
    ['Категория',cat],
    ['Уровень',SEV_LABEL[o.sev]||o.sev],
    ['Источник',o.sensor],
    ['ID записи',o.id],
  ].map(([k,v])=>'<tr><td class="k">'+esc(k)+'</td><td class="v">'+esc(v)+'</td></tr>').join('');
  // События (последние) — то же событие и ближайшие по этому серверу
  const recent=logsAll.filter(r=>r.serverId===o.serverId).slice(0,8);
  $('ldRecent').innerHTML=recent.length?recent.map(r=>'<div class="ev '+r.sev+'"><span class="ic">'+(SEV_ICON[r.sev]||SEV_ICON.info)+'</span><span class="txt"><b>'+esc(SEV_LABEL[r.sev]||r.sev)+'</b> — '+esc(r.sensor)+(r.detail?(' · '+esc(r.detail)):'')+'</span><span class="when">'+esc(r.tsLabel)+'</span></div>').join(''):'<div class="ev">Нет событий по серверу</div>';
  // закомментированный ранее комментарий (в памяти)
  const c=$('ldComment'); if(c&&logCommentCache[o.serverId+':'+o.id]!==undefined)c.value=logCommentCache[o.serverId+':'+o.id];
  renderLogs();
}
// Комментарии — in-memory (не персистятся; в БД нет такого поля). При желании
// можно вынести в storage.addEvent('info', ...) — пока локально на сессию.
const logCommentCache={};
function initLogsUI(){
  document.querySelectorAll('#logsChips .lp-chip').forEach(ch=>{
    ch.onclick=()=>{
      document.querySelectorAll('#logsChips .lp-chip').forEach(x=>x.classList.toggle('active',x===ch));
      logSev=ch.getAttribute('data-sev');logPage=1;renderLogs();
    };
  });
  $('logsDate').onchange=()=>{logDate=$('logsDate').value;logPage=1;renderLogs();};
  $('logsCat').onchange=()=>{logCat=$('logsCat').value;logPage=1;renderLogs();};
  $('logsServer').onchange=()=>{logSrv=$('logsServer').value;logPage=1;renderLogs();};
  $('logsPerPage').onchange=()=>{logPer=+$('logsPerPage').value;logPage=1;renderLogs();};
  $('logsResetBtn').onclick=()=>{logSev='';logDate='';logCat='';logSrv='';$('logsDate').value='';$('logsCat').value='';$('logsServer').value='';logPage=1;document.querySelectorAll('#logsChips .lp-chip').forEach(x=>x.classList.toggle('active',x.getAttribute('data-sev')===''));renderLogs();};
  $('logsRefreshBtn').onclick=()=>loadLogs();
  $('ldCommentBtn').onclick=()=>{
    if(!logSel)return;
    const v=($('ldComment').value||'').trim();
    logCommentCache[logSel.serverId+':'+logSel.id]=v;
    $('ldCommentBtn').disabled=true;
    snack(v?'Комментарий сохранён':'Комментарий удалён');
    setTimeout(()=>{const b=$('ldCommentBtn');if(b)b.disabled=false;},600);
  };
  $('ldComment').oninput=()=>{if(logSel)logCommentCache[logSel.serverId+':'+logSel.id]=$('ldComment').value;};
}
initLogsUI();
