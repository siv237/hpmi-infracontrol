async function loadInv(id){
  const s=servers.find(x=>x.id===id);
  const prev=dbgStatus[id];
  // 1) СРАЗУ показываем последний снимок из базы (offline-first)
  try{
    const lk=await api('/api/last-known/'+encodeURIComponent(id),{_noKick:true});
    if(id!==sel)return;
    if(lk.ok&&lk.inventory&&Object.keys(lk.inventory).length){
      dbgInv[id]=lk.inventory; dbgLastKnown[id]=lk.ts;
      if(!dbgStatus[id]){dbgStatus[id]='off';renderDetail();renderEvents();}
    }
  }catch{}
  if(id!==sel)return;
  // 2) Онлайн-обновление: при успехе перезаписать, иначе оставить базу
  const j=await api('/api/info',{method:'POST',body:JSON.stringify({serverId:id})});
  if(j.status===401)return; // сессия истекла — показывается страница входа
  if(id!==sel)return;
  if(j.ok){
    dbgStatus[id]='on';
    dbgInv[id]=j.inventory||j.inv||{};
    dbgPower[id]=j.powerState||'unknown';
    if(prev!=='on')addEvent('ok','Данные iRMC получены'+(s?(' · '+(s.name||s.host)):''));
    (j.configChanges||[]).forEach(c=>addEvent('warn','Изменение конфигурации · '+c.field+': '+c.from+' → '+c.to));
  } else {
    dbgStatus[id]='err';
    if(!dbgLastKnown[id]){ dbgInv[id]=null; renderDetail(); } // нет снимка — честно «нет данных»
    if(prev!=='err')addEvent('err','iRMC недоступен'+(s?(' · '+(s.name||s.host)):'')+((j.error&&typeof j.error==='string')?(' — '+j.error.slice(0,80)):''));
  }
  renderDetail();
  renderEvents();
}

function fmtDump(iso){
  if(!iso)return '—';
  const d=new Date(iso);
  return d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
}
async function showVersionHistory(id){
  if(!id)return;
  const j=await api('/api/versions?serverId='+encodeURIComponent(id)+'&limit=50');
  if(!j.ok || !(j.versions||[]).length){ snack('История версий пуста'); return; }
  const rows=(j.versions||[]).map(v=>{
    const f=Object.entries(v.versions||{}).map(([k,val])=>'<div class="vh-item"><span class="vh-k">'+esc(k)+'</span><span class="vh-v">'+esc(val)+'</span></div>');
    return '<div class="vh-row"><div class="vh-ts">'+fmtDump(v.ts)+(v.by?(' · '+esc(v.by)):'')+'</div>'+f.join('')+'</div>';
  }).join('');
  try{ alert('История версий:\n\n'+rows.replace(/<[^>]+>/g,'')); }catch{}
  const s=servers.find(x=>x.id===id);
  addEvent('info','Просмотр истории версий'+(s?(' · '+(s.name||s.host)):''));
}
