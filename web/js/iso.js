// ---- профиль и сессия ------------------------------------------------------
let editingUserId=null;
let isoImages=[];
async function loadIso(){
  const j=await api('/api/iso');
  if(!j.ok)return;
  isoImages=j.images||[];
  const rows=(j.images||[]).map(img=>{
    const sz=img.size!=null?(img.size>=1073741824?(img.size/1073741824).toFixed(2)+' ГБ':(img.size>=1048576?(img.size/1048576).toFixed(1)+' МБ':(img.size>=1024?(img.size/1024).toFixed(0)+' КБ':img.size+' Б'))):'—';
    const ts=img.ts?new Date(img.ts).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
    return '<tr><td><b>'+esc(img.name)+'</b></td><td>'+sz+'</td><td>'+ts+'</td>'
      +'<td style="white-space:nowrap">'
      +(isAdmin()?'<button class="icon-btn" title="Переименовать" onclick="isoRename(\''+esc(img.id)+'\',\''+esc(String(img.name).replace(/'/g,''))+'\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>':'')
      +(isAdmin()?'<button class="icon-btn" title="Удалить" onclick="isoDelete(\''+esc(img.id)+'\',\''+esc(String(img.name).replace(/'/g,''))+'\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg></button>':'')
      +'</td></tr>';
  }).join('')||'<tr><td colspan="4" class="ov-empty">Образов пока нет</td></tr>';
  $('isoRows').innerHTML=rows;
  $('isoCount').textContent=(j.images||[]).length;
}
async function isoDelete(id,name){
  if(!isAdmin()){snack('Только администратор');return;}
  if(!confirm('Удалить ISO «'+name+'»?'))return;
  const j=await api('/api/iso/'+encodeURIComponent(id),{method:'DELETE'});
  if(j.okResp===false)return;
  snack('Удалено'); loadIso();
}
async function isoRename(id,cur){
  if(!isAdmin()){snack('Только администратор');return;}
  const nn=prompt('Новое имя:',cur); if(!nn||nn===cur)return;
  const j=await api('/api/iso/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({name:nn})});
  if(j.okResp===false)return;
  snack('Переименовано'); loadIso();
}
async function isoUpload(file){
  if(!isAdmin()){snack('Только администратор может загружать ISO');return;}
  if(!file)return;
  const prog=$('isoProgress'), fill=$('isoProgFill'), txt=$('isoProgTxt');
  $('isoProgName').textContent='Загрузка: '+file.name;
  prog.style.display='block';
  fill.style.width='0%';
  txt.textContent='0% · 0 МБ';
  try{
    const data=await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open('POST','/api/iso?name='+encodeURIComponent(file.name),true);
      const h=sessionHeaders({});
      for(const k in h) xhr.setRequestHeader(k,h[k]);
      xhr.upload.onprogress=(e)=>{ if(e.lengthComputable&&e.total){ const p=Math.round(100*e.loaded/e.total); fill.style.width=p+'%'; txt.textContent=p+'% · '+fmtMB(e.loaded)+' / '+fmtMB(e.total); } };
      xhr.onload=()=>{ try{ resolve(JSON.parse(xhr.responseText)); }catch(e){ reject(e); } };
      xhr.onerror=()=>reject(new Error('сеть'));
      xhr.onabort=()=>reject(new Error('отмена'));
      xhr.send(file);
    });
    if(data.status===401)return;
    if(data.ok){ txt.textContent='Загрузка завершена ✓'; addEvent('info','Загружен ISO · '+file.name); await new Promise(r=>setTimeout(r,700)); loadIso(); }
    else { txt.textContent='Ошибка: '+((data.error||'').slice(0,80)); }
  }catch(e){
    txt.textContent='Сбой: '+String(e&&e.message||e);
  }finally{
    setTimeout(()=>{ prog.style.display='none'; },4000);
  }
}
function fmtMB(n){ return (n/1048576).toFixed(1)+' МБ'; }
$('isoFile').onchange=(e)=>{ const f=e.target.files&&e.target.files[0]; if(f)isoUpload(f); e.target.value=''; };
$('isoUploadBtn').onclick=()=>{ if(!isAdmin()){snack('Только администратор');return;} $('isoFile').click(); };
$('isoRefreshBtn').onclick=()=>loadIso();

// === Монтирование ISO в карточке сервера (п.10/10.5) ===
let mountMap={};
async function loadMounts(){
  const j=await api('/api/mounts');
  mountMap={};
  if(j.ok){(j.mounts||[]).forEach(m=>mountMap[m.serverId]=m);}
  if(sel)renderMount(sel);
}
async function renderMount(id){
  const m=mountMap[id];
  if(!m){ $('mountBtn').style.display='none'; } else { $('mountBtn').style.display=''; $('mountBtnLabel').textContent='ISO: '+m.isoName; }
  try{ renderStorage(); }catch{}
}
$('mountBtn').onclick=()=>{
  const m=mountMap[sel];
  if(m){ if(confirm('Отмонтировать ISO «'+m.isoName+'»?')) unmountISO(sel); }
  else openMountPicker(sel);
};
async function unmountISO(id){
  const j=await api('/api/mounts/'+encodeURIComponent(id),{method:'DELETE'});
  if(j.okResp===false)return;
  snack('Отмонтировано'); await loadMounts();
}
async function openMountPicker(id){
  if(!isAdmin()){snack('Только администратор');return;}
  const iso=await api('/api/iso');
  if(!iso.ok||!(iso.images||[]).length){ snack('Нет ISO-образов — загрузите во вкладке ISO'); return; }
  const name=prompt('Выберите ISO (имя одного из образов):\n\n'+iso.images.map(x=>' • '+x.name).join('\n'));
  if(!name)return;
  const found=iso.images.find(x=>x.name===name);
  if(!found){ snack('Образ не найден'); return; }
  const j=await api('/api/mounts',{method:'PUT',body:JSON.stringify({serverId:id,isoId:found.id})});
  if(j.okResp===false)return;
  snack('Примонтирован: '+found.name); addEvent('ok','Примонтирован ISO · '+found.name); await loadMounts();
}

// === Хранилище: состояние монтирования + управление (вкладка сервера) ===
let storageTick=null;
function fmtDur(ms){
  const s=Math.max(0,Math.floor(ms/1000));
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  return (h?h+'ч ':'')+(m?m+'м ':'')+sec+'с';
}
function fmtB(n){ return (n/1048576).toFixed(1)+' МБ'; }
function startStorageMetrics(m){
  const ts=m && m.ts ? new Date(m.ts).getTime() : Date.now();
  const up=$('storageUp'), spd=$('storageSpd'), bytes=$('storageBytes');
  $('storageMetrics').style.display='flex';
  const tick=()=>{ up.textContent=fmtDur(Date.now()-ts); };
  tick();
  if(storageTick){ clearInterval(storageTick); storageTick=null; }
  const poll=async()=>{ try{ const j=await api('/api/mounts/stats'); if(j.ok&&j.stats){
    spd.textContent=(j.stats.bps/1048576).toFixed(2)+' МБ/с';
    bytes.textContent=fmtB(j.stats.bytes||0);
  } }catch{} };
  poll();
  storageTick=setInterval(()=>{ tick(); },1000);
  const pollT=setInterval(()=>poll(),2000);
  storageTick._poll=pollT; // bound, чтобы останавливать вместе
}
function stopStorageMetrics(){
  if(storageTick){ clearInterval(storageTick); clearInterval(storageTick._poll); storageTick=null; }
  $('storageMetrics').style.display='none';
}
async function renderStorage(){
  const id=sel; if(!id)return;
  if(!isoImages.length){ const j=await api('/api/iso'); if(j.ok) isoImages=j.images||[]; }
  const m=mountMap[id];
  const ico=$('storageIco'), st=$('storageState');
  if(m){
    ico.classList.add('mounted');
    $('storageMountBtn').style.display='none';
    $('storageUnmountBtn').style.display='';
    const who=m.by?(' · '+esc(m.by)):'';
    const when=m.ts?(new Date(m.ts).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})):'—';
    st.innerHTML='Примонтирован: <b>'+esc(m.isoName)+'</b><div class="iso-meta">время: '+when+who+'</div>';
    startStorageMetrics(m);
  }else{
    ico.classList.remove('mounted');
    $('storageMountBtn').style.display='';
    $('storageUnmountBtn').style.display='none';
    st.innerHTML='Не примонтировано<div class="iso-meta" id="storageSelTip"></div>';
    stopStorageMetrics();
  }
  const selBox=$('storageIsoSel');
  const cur=selBox.value;
  selBox.innerHTML=isoImages.map(x=>'<option value="'+esc(x.id)+'"'+(x.id===cur?' selected':'')+'>'+esc(x.name)+'</option>').join('')
    ||'<option value="">— образов нет —</option>';
  $('storageMountBtn').disabled=!isoImages.length;
}
$('storageMountBtn').onclick=async()=>{
  if(!isAdmin()){snack('Только администратор');return;}
  const isoId=$('storageIsoSel').value;
  const img=isoImages.find(x=>x.id===isoId);
  if(!img){ snack('Выберите ISO-образ'); return; }
  if(!confirm('Примонтировать «'+img.name+'» к серверу?'))return;
  const j=await api('/api/mounts',{method:'PUT',body:JSON.stringify({serverId:sel,isoId})});
  if(j.okResp===false)return;
  snack('Примонтирован: '+img.name); addEvent('ok','Примонтирован ISO · '+img.name); await loadMounts();
};
$('storageUnmountBtn').onclick=async()=>{
  if(!isAdmin()){snack('Только администратор');return;}
  const m=mountMap[sel]; if(!m)return;
  if(!confirm('Отмонтировать «'+m.isoName+'»?'))return;
  await unmountISO(sel);
};
