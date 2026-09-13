// ---- выбор сервера -------------------------------------------------------
function select(id){
  sel=id; renderTree();
  try{ localStorage.setItem('ui.sel',id); }catch{}
  showDetail();
  // сразу отрисовать выбранного из кеша (данные/«—») — панель всегда
  // соответствует выбору, не ждём сетевых ответов (недоступный сервер
  // отвечает таймаутом; раньше всё это время висел прежний сервер — BUG-004)
  renderDetail();
  if(typeof resetMetrics==='function')resetMetrics();
  loadInv(id);
  loadSensors(id);
  loadMetrics(id);
  // перечитать активную вкладку (сеть/оборудование/login/etc.) — иначе при
  // переключении сервера на той же вкладке остаются данные ПРЕДЫДУЩЕГО
  loadActiveTab(id);
  showConsole(); // консоль выбранного сервера или заглушка
}

// Перечитывает данные активной вкладки карточки для выбранного сервера.
// Все load*() защищены `if (id!==sel) return`, поэтому гонок нет.
function loadActiveTab(id){
  const t=$('tabs'), cur=document.querySelector('#tabs .tab.active');
  const name=cur?cur.getAttribute('data-tab'):'overview';
  if(name==='network'){ try{ loadNetwork(id); }catch{} }
  else if(name==='health'){ try{ loadSensors(id); }catch{} }
  else if(name==='overview'){ try{ loadMetrics(id); }catch{} }
  else if(name==='hardware'){ try{ loadHardware(id); }catch{} }
  else if(name==='info'){ try{ renderSI(dbgInv[id]||null); }catch{} }
  else if(name==='storage'){ try{ renderStorage(); }catch{} }
}
function hideDetail(){$('detBody').style.display='none';$('emptyHint').style.display='flex';}
function showDetail(){const s=servers.find(x=>x.id===sel);if(!s){hideDetail();return;}$('detBody').style.display='block';$('emptyHint').style.display='none';renderMount(sel);}

function renderDetail(){
  const s=servers.find(x=>x.id===sel); if(!s){hideDetail();return;}
  $('detTitle').textContent=s.name||s.host;
  $('crumbHost').textContent=(s.host||'')+':'+(s.port||80)+(s.secure?' · SSL':'');
  const st=dbgStatus[sel]||'off';
  const pill=$('detPill');
  if(st==='on'){pill.textContent='Онлайн';pill.className='pill on';}
  else if(st==='err'){pill.textContent='Недоступен';pill.className='pill err';}
  else {pill.textContent='Нет данных';pill.className='pill off';}
  const kpiState=$('kpiState');
  kpiState.textContent=st==='on'?'Онлайн':(st==='err'?'Недоступен':'Нет данных');
  kpiState.className='val '+(st==='on'?'okc':(st==='err'?'':''));
  $('kpiIp').textContent=s.host;
  renderKpiNet(dbgNet[sel]||null);
  const inv=dbgInv[sel];
  if(inv){
    const model=valFrom(inv,['system type','model','model name','product name','system model']);
    const mfg=valFrom(inv,['system manufacturer','manufacturer','producer','vendor']);
    $('kpiModel').textContent=model||'—';
    $('kpiSub').textContent=mfg||'';
    const serial=valFrom(inv,['serial','serial number','system serial number']);
    const hostName=valFrom(inv,['system name','host name','hostname']);
    $('kpiSerial').textContent=serial||'—';
    $('kpiSerialSub').textContent=hostName||'Система';
    const ip=valFrom(inv,['system ip','ip','system ip address']);
    if(ip)$('kpiIp').textContent=ip;
    const bmc=valFrom(inv,['bmc','bmc version','ipmi firmware','bmc firmware version','firmware']);
    $('kpiVer').textContent= bmc?('Версия: '+bmc):'';
    $('crumbHost').textContent=(hostName||s.host)+' · '+(ip||s.host);
  } else {
    $('kpiModel').textContent='—';$('kpiSub').textContent='—';
    $('kpiSerial').textContent='—';$('kpiSerialSub').textContent='Система';
    $('kpiVer').textContent='';
  }
  renderSI(inv);
  renderHWTable(dbgHw[sel]||null);
  $('invState').textContent=(st==='on'?'данные получены':(st==='err'?'сервер недоступен':(st==='off'&&dbgLastKnown[sel]?'данные из базы':'проверка…')))+(dbgLastKnown[sel]?(' · снимок от '+fmtDump(dbgLastKnown[sel])):'');;
}

function trustKeys(inv){ return inv; }

// KPI-строка сети BMC (MAC/прошивка/IPMI-версия) — из последнего сетевого
// снимка опроса (dbgNet заполняет loadSensors из pollCache.net)
function renderKpiNet(net){
  const set=(id,v)=>{const e=$(id);if(e)e.textContent=v;};
  if(net&&(net.mac||net.bmcFirmware)){
    set('kpiMac',net.mac||'—');
    set('kpiBmcFw',net.bmcFirmware||'—');
    set('kpiIpmiVer',net.ipmiVersion||'—');
    set('kpiMacSub',net.ipSource==='dhcp'?'DHCP · сетевой интерфейс iRMC':'static · сетевой интерфейс iRMC');
  } else {
    set('kpiMac','—');set('kpiBmcFw','—');set('kpiIpmiVer','—');
    set('kpiMacSub','нет данных опроса');
  }
}

const SI_ROWS=[
  {k:'Производитель', src:['system manufacturer','manufacturer','producer','vendor']},
  {k:'Модель', src:['system type','model','model name','product name']},
  {k:'Серийный номер', src:['serial','serial number','system serial number']},
  {k:'BIOS', src:['bios version','bios version/date','bios','bios revision']},
  {k:'BMC (IPMI)', src:['bmc','bmc version','ipmi firmware','bmc firmware version','firmware']},
  {k:'UUID', src:['system guid','guid','uuid','system uuid']},
  {k:'Имя системы', src:['system name','host name','hostname']},
  {k:'Описание', src:['system description','description']},
  {k:'ОС', src:['system o/s','os','operating system','os name']},
  {k:'IP системы', src:['system ip','ip','system ip address']},
  {k:'Asset Tag', src:['system asset tag','asset tag','asset']},
  {k:'Power LED', src:['power led']},
  {k:'Error LED', src:['error led']},
];
function valFrom(inv,srcs){if(!inv)return '';const low={};for(const k in inv)low[k.toLowerCase()]=inv[k];for(const s of srcs){if(low[s]!==undefined&&low[s]!=='')return low[s];}return '';}
function renderSI(inv){
  const t=$('siTable');let html='';
  for(const row of SI_ROWS){
    const v=inv?valFrom(inv,row.src):'';
    html+='<tr><td class="k">'+row.k+'</td><td class="v">'+(v||'—')+'</td></tr>';
  }
  // любые оставшиеся поля, которые вернул iRMC (не покрыты выше)
  if(inv){
    const covered=/^(system manufacturer|manufacturer|producer|vendor|system type|model|model name|product name|serial|serial number|system serial number|bios version|bios version\/date|bios|bios revision|bmc|bmc version|ipmi firmware|bmc firmware version|firmware|system guid|guid|uuid|system uuid|system name|host name|hostname|system description|description|system o\/s|os|operating system|os name|system ip|ip|system ip address|system asset tag|asset tag|asset|power led|error led)$/i;
    for(const k in inv){
      if(covered.test(k))continue;
      const v=inv[k];if(!v||v==='')continue;
      html+='<tr><td class="k">'+esc(k)+'</td><td class="v">'+esc(v)+'</td></tr>';
    }
  }
  t.innerHTML=html;
}

// Загрузка информации по железу (IPMI) для вкладки «Оборудование».
// Offline-first: сразу показываем последний снимок из БД (с меткой времени),
// затем обновляем онлайн; при недоступности сервера снимок остаётся.
async function loadHardware(id){
  const box=$('hwBox'); if(!box)return;
  const info=$('hwInfo');
  const setInfo=(ts,src)=>{ if(info)info.textContent=ts?((src==='cache'?'снимок от ':'данные от ')+fmtDump(ts)):''; };
  if(dbgHw[id]){ renderHWTable(dbgHw[id]); setInfo(dbgHwTs[id],'cache'); }
  else box.innerHTML='<div class="ov-empty">Загрузка…</div>';
  // 1) мгновенно — последний удачный снимок из базы
  const c=await api('/api/hardware?serverId='+encodeURIComponent(id)+'&cached=1',{_noKick:true});
  if(id!==sel)return;
  if(c&&c.ok&&c.hardware){ dbgHw[id]=c.hardware; dbgHwTs[id]=c.ts; renderHWTable(c.hardware); setInfo(c.ts,'cache'); }
  // 2) онлайн-обновление (результат сохраняется на сервере в БД)
  const j=await api('/api/hardware?serverId='+encodeURIComponent(id),{_noKick:true});
  if(id!==sel)return;
  if(j&&j.ok&&j.hardware){ dbgHw[id]=j.hardware; dbgHwTs[id]=j.ts; renderHWTable(j.hardware); setInfo(j.ts, j.source==='cache'?'cache':'live'); }
  else if(!dbgHw[id])box.innerHTML='<div class="ov-empty">Нет данных по железу'+(j&&j.error?(' — '+esc(String(j.error).slice(0,140))):'')+'</div>';
}
// Секция-аккордеон вкладки «Оборудование».
function hwSection(id,title,brief,bodyHtml){
  const open=hwOpen.has(id);
  return '<div style="margin-bottom:6px">'
    +'<div class="hw-head" data-hwsec="'+id+'" style="display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;border:1px solid var(--line,#e3e7ee);border-radius:8px;background:#fff">'
    +'<span style="width:12px;color:var(--faint)">'+(open?'▾':'▸')+'</span><b style="font-size:13px">'+esc(title)+'</b>'
    +'<span style="flex:1"></span><span style="color:var(--faint);font-size:12px">'+brief+'</span></div>'
    +(open?('<div style="border:1px solid var(--line,#e3e7ee);border-top:none;border-radius:0 0 8px 8px;padding:8px 10px;background:#fafbfd;font-size:12.5px">'+bodyHtml+'</div>'):'')
    +'</div>';
}
// Оборудование (IPMI): CPU / DIMM / RAID / питание / вентиляторы / датчики / FRU.
function renderHWTable(hw){
  const box=$('hwBox'); if(!box)return;
  if(!hw){ box.innerHTML='<div class="ov-empty">Нет данных по железу</div>'; return; }
  const kv=(k,v)=>'<div style="display:flex;gap:8px"><span style="color:var(--faint);min-width:150px">'+esc(k)+'</span><span>'+esc(v==null||v===''?'—':v)+'</span></div>';
  const list=(arr,map)=>arr.length?arr.map(map).join(''):'<span style="color:var(--faint)">нет данных</span>';
  const cpu=hw.cpu||[], mem=hw.memory||[], fans=hw.fans||[],
        temps=hw.temps||[], volts=hw.volts||[], fru=hw.fru||[], st=hw.storage||[];
  const pw=hw.power||{units:[]};
  const raidFru=fru.filter(d=>/raid/i.test(d.name));
  let html='';
  html+=hwSection('cpu','Процессоры', cpu.length?cpu.length+' шт.':'—', list(cpu,r=>kv(r.name,r.state||'—')));
  html+=hwSection('mem','Память (DIMM)', mem.length?mem.length+' модулей':'—', list(mem,r=>kv(r.name,r.temp!=null?r.temp+' °C':'присутствует')));
  html+=hwSection('store','Накопители / RAID', (st.length||raidFru.length)?'есть контроллер':'—',
    (list(st,r=>kv(r.name,r.value||r.status)))+(raidFru.map(d=>kv('FRU: '+d.name,Object.entries(d.fields||{}).map(([a,b])=>a+': '+b).join(', ')||'присутствует')).join('')));
  html+=hwSection('power','Питание', (pw.totalWatts!=null?pw.totalWatts+' Вт':'')+(pw.redundant?' · резерв':''),
    list(pw.units||[],u=>kv(u.name,(u.present?'установлен':'нет')+(u.temp!=null?', '+u.temp+' °C':'')+(u.watts!=null?', '+u.watts+' Вт':'')))
    +(pw.totalWatts!=null?kv('Суммарно',pw.totalWatts+' Вт'):'')+(pw.state?kv('Состояние',pw.state):''));
  html+=hwSection('fans','Вентиляторы', fans.length?fans.length+' шт.':'—', list(fans,r=>kv(r.name,r.rpm!=null?r.rpm+' RPM':'—')));
  html+=hwSection('temps','Температуры', temps.length?temps.length:'—', list(temps,r=>kv(r.name,r.value)));
  html+=hwSection('volts','Напряжения', volts.length?volts.length:'—', list(volts,r=>kv(r.name,r.value)));
  html+=hwSection('fru','FRU-устройства (шасси/плата/БП)', fru.length?fru.length:'—',
    list(fru,d=>'<div style="margin-bottom:6px"><b>'+esc(d.name)+(d.id?(' #'+esc(d.id)):'')+'</b>'+list(Object.entries(d.fields||{}).map(([a,b])=>({a,b})),r=>kv(r.a,r.b))+'</div>'));
  box.innerHTML=html;
}
// делегирование клика по заголовкам секций (раскрытие/сворачивание)
$('hwBox').addEventListener('click',(e)=>{
  const h=e.target.closest('.hw-head'); if(!h)return;
  const id=h.getAttribute('data-hwsec');
  if(hwOpen.has(id))hwOpen.delete(id); else hwOpen.add(id);
  renderHWTable(dbgHw[sel]||null);
});
