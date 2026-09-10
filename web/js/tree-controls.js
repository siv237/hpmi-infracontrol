// ---- шапка дерева: добавить / фильтр / обновить ---------------------------
$('addBtn').onclick=()=>{ if(!isAdmin()){snack('Только администратор может добавлять серверы');return;} openDlg(null); };
$('refreshBtn').onclick=async()=>{ await load(); if(sel)loadInv(sel); snack('Список обновлён'); };
$('filterBtn').onclick=()=>snack('Фильтр — в разработке');
$('helpBtn').onclick=()=>snack('Справка — в разработке');
$('editBtn').onclick=()=>{$('actionsMenu').classList.remove('show');if(!isAdmin()){snack('Только администратор может изменять серверы');return;}const s=servers.find(x=>x.id===sel);openDlg(s);};
$('delBtn').onclick=()=>{$('actionsMenu').classList.remove('show');if(sel)delServer(sel);};
function openDlg(s,preset){
  // preset: {root, group} — из контекстного меню ветки/группы
  const pre=(preset&&typeof preset==='object')?preset:{group:preset||''};
  $('modalTitle').textContent=s?'Изменить сервер':'Добавить сервер';
  $('d_name').value=s?(s.name||''):''; $('d_host').value=s?(s.host||''):''; $('d_user').value=s?(s.username||'admin'):'admin'; $('d_pass').value='';
  $('d_port').value=s?(s.port||80):80; $('d_secure').checked=s?(!!s.secure):false;
  // корень (организация): существующие корни из ui.json + серверов
  const roots=treeRootsOf();
  $('d_root').innerHTML=roots.map(R=>'<option value="'+esc(R)+'"'+((s?rootKeyOf(s):pre.root||'')===R?' selected':'')+'>'+esc(srvRootName(R))+'</option>').join('');
  // группа: подсказки по группам выбранного корня; пусто = авто-филиал по IP
  const fillGroups=()=>{
    const R=$('d_root').value;
    $('d_groupList').innerHTML=treeGroupsOf(R).map(g=>'<option value="'+esc(g)+'">').join('');
  };
  fillGroups();
  $('d_root').onchange=fillGroups;
  $('d_group').value=s?((s.group===null||s.group===undefined)?'':String(s.group)):(pre.group||'');
  $('dlgCheckOut').innerHTML='';
  $('modalBack').classList.add('show');
  // Быстрая проверка доступности по введённым данным (кнопка до сохранения):
  // триада ping/web/IPMI + веб-диагностика кредов + «что за сервер».
  $('dlgCheck').onclick=async()=>{
    const host=$('d_host').value.trim();
    if(!host){snack('Введите адрес сервера');return;}
    const out=$('dlgCheckOut');
    out.innerHTML='<div class="dc-loading">Проверяю…</div>';
    const r=await api('/api/check',{method:'POST',body:JSON.stringify({
      host,username:$('d_user').value.trim(),password:$('d_pass').value,
      port:Number($('d_port').value)||80,secure:$('d_secure').checked,
    })});
    if(r.okResp===false){out.innerHTML='';return;}
    out.innerHTML=dlgCheckHtml(r);
  };
  $('dlgSave').onclick=async(e)=>{
    e.preventDefault();
    if(!isAdmin()){snack('Только администратор может изменять серверы');return;}
    const host=$('d_host').value.trim(); if(!host)return;
    const gval=$('d_group').value.trim();
    const base={name:$('d_name').value.trim()||host,host,username:$('d_user').value.trim(),port:Number($('d_port').value)||80,secure:$('d_secure').checked,group:gval===''?null:gval,root:$('d_root').value||''};
    try{
      let resp;
      if(s){
        // пароль шлём только если ввели новый; username обновляем всегда
        const cfg={...base};
        if($('d_pass').value)cfg.password=$('d_pass').value;
        resp=await api('/api/servers/'+encodeURIComponent(s.id),{method:'PUT',body:JSON.stringify(cfg)});
      } else {
        resp=await api('/api/servers',{method:'POST',body:JSON.stringify({...base,password:$('d_pass').value})});
      }
      if(resp.okResp===false)return;
      $('modalBack').classList.remove('show');snack('Сохранено');
      await load();
      if(s&&s.id===sel)loadInv(sel);
      addEvent('info',s?'Параметры сервера изменены · '+base.name:'Сервер добавлен · '+base.name);
    }catch{snack('Ошибка сохранения');}
  };
  $('dlgCancel').onclick=()=>$('modalBack').classList.remove('show');
  $('modalBack').onclick=(ev)=>{if(ev.target===$('modalBack'))$('modalBack').classList.remove('show');};
}
// Результат быстрой проверки: триада + вердикт по кредам + что за сервер
function dlgCheckHtml(r){
  const ch=(ok,ms,label,err)=>'<div class="dc-ch'+(ok===null?' na':(ok?' ok':' bad'))+'">'
    +'<span class="dc-ic">'+(ok===null?'—':(ok?'✓':'✕'))+'</span>'
    +'<span class="dc-nm">'+label+'</span>'
    +'<span class="dc-ms">'+(ok&&ms!=null?ms+' мс':'')+(ok===false&&err?' · '+esc(String(err).slice(0,60)):'')+'</span></div>';
  let h='<div class="dc-box">';
  h+=ch(!!(r.ping&&r.ping.ok),r.ping&&r.ping.ms,'Пинг (ICMP)',r.ping&&r.ping.error);
  h+=ch(!!(r.webPort&&r.webPort.ok),r.webPort&&r.webPort.ms,'Веб-порт TCP ('+r.port+')',r.webPort&&r.webPort.error);
  if(r.ipmi)h+=ch(r.ipmi.ok,r.ipmi.ms,'IPMI (RMCP+)',r.ipmi.error);
  h+='</div>';
  // веб: схема авторизации + принимаются ли креды
  if(r.web){
    const wcls=r.web.ok?'ok':(r.web.status===0?'bad':'warn');
    h+='<div class="dc-box web '+wcls+'"><div class="dc-hd">Веб: '
      +esc(r.web.scheme||'схема не определена')
      +(r.web.realm?' · realm «'+esc(r.web.realm)+'»':'')
      +(r.web.status?' · HTTP '+r.web.status:'')+'</div>'
      +'<div class="dc-txt">'+esc(r.web.verdict||'')+'</div></div>';
  }
  // ipmi: креды + что за сервер
  if(r.ipmi){
    if(r.ipmi.auth===true){
      const idt=[r.ipmi.manufacturer,r.ipmi.bmcFirmware?('BMC '+r.ipmi.bmcFirmware):null,r.ipmi.ipmiVersion?('IPMI '+r.ipmi.ipmiVersion):null].filter(Boolean).join(' · ');
      h+='<div class="dc-box ok"><div class="dc-hd">IPMI: логин/пароль верны'+(idt?' · '+esc(idt):'')+'</div>';
      if(r.ipmi.lan&&r.ipmi.lan.mac)h+='<div class="dc-txt">MAC '+esc(r.ipmi.lan.mac)+(r.ipmi.lan.ip?' · IP '+esc(r.ipmi.lan.ip):'')+' · '+(r.ipmi.lan.ipSource==='DHCP'?'DHCP':'static')+'</div>';
      h+='</div>';
    } else if(r.ipmi.auth===false){
      h+='<div class="dc-box bad"><div class="dc-hd">IPMI: логин/пароль НЕВЕРНЫ</div><div class="dc-txt">'+esc(r.ipmi.error||'')+'</div></div>';
    } else if(!r.ipmi.ok){
      h+='<div class="dc-box bad"><div class="dc-hd">IPMI не отвечает</div><div class="dc-txt">'+esc(r.ipmi.error||'таймаут RMCP+ (UDP 623)')+'</div></div>';
    }
  }
  // пробник совместимости: сигнатура BMC -> модуль поддержки
  if(r.compat){
    const c=r.compat;
    const CAPL={ 'ipmi-lan':'IPMI-опрос','web-digest':'веб (Digest)','web-basic':'веб (Basic)',
      'web-form':'веб (форма)','web-inventory':'инвентарь','kvm-avr':'KVM-консоль','kvm-vnc':'KVM (VNC)',
      'iso-m2':'проброс ISO','tls-legacy':'старый TLS' };
    h+='<div class="dc-box '+(c.matched?'ok':'warn')+'">'
      +'<div class="dc-hd">'+(c.matched?'Совместимость: ':'Веб не распознан — работаем как ')
      +esc(c.moduleTitle)+'</div>'
      +'<div class="dc-txt">'+c.caps.map(x=>esc(CAPL[x]||x)).join(' · ')+'</div>'
      +(c.quirks&&c.quirks.length?'<div class="dc-txt" style="margin-top:3px">'+c.quirks.map(q=>'• '+esc(q)).join('<br>')+'</div>':'')
      +'</div>';
  }
  h+='<div class="dc-hint">Проверка лёгкая: без инвентаря/SDR/SEL — фоновый сбор начнётся после сохранения.</div>';
  return h;
}
