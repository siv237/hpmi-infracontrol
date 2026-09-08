// ---- выбор сервера -------------------------------------------------------
function select(id){
  sel=id; renderTree();
  showDetail();
  loadInv(id);
  loadSensors(id);
  showConsole(); // консоль выбранного сервера или заглушка
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
  renderHWTable(inv);
  $('invState').textContent=(st==='on'?'данные получены':(st==='err'?'сервер недоступен':(st==='off'&&dbgLastKnown[sel]?'данные из базы':'проверка…')))+(dbgLastKnown[sel]?(' · снимок от '+fmtDump(dbgLastKnown[sel])):'');;
}

function trustKeys(inv){ return inv; }

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

// Инвентарь в «Оборудование» (полная таблица, как renderSI)
function renderHWTable(inv){
  const t=$('hwTable'); if(!t)return;
  let h='';
  for(const row of SI_ROWS){ const v=inv?valFrom(inv,row.src):''; h+='<tr><td class="k">'+row.k+'</td><td class="v">'+(v||'—')+'</td></tr>'; }
  if(inv){
    const covered=/^(system manufacturer|manufacturer|producer|vendor|system type|model|model name|product name|serial|serial number|system serial number|bios version|bios version\/date|bios|bios revision|bmc|bmc version|ipmi firmware|bmc firmware version|firmware|system guid|guid|uuid|system uuid|system name|host name|hostname|system description|description|system o\/s|os|operating system|os name|system ip|ip|system ip address|system asset tag|asset tag|asset|power led|error led)$/i;
    for(const k in inv){ if(covered.test(k)||!inv[k])continue; h+='<tr><td class="k">'+esc(k)+'</td><td class="v">'+esc(inv[k])+'</td></tr>'; }
  }
  t.innerHTML=h;
}
