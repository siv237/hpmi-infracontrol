// ---- шапка дерева: добавить / фильтр / обновить ---------------------------
$('addBtn').onclick=()=>{ if(!isAdmin()){snack('Только администратор может добавлять серверы');return;} openDlg(null); };
$('refreshBtn').onclick=async()=>{ await load(); if(sel)loadInv(sel); snack('Список обновлён'); };
$('filterBtn').onclick=()=>snack('Фильтр — в разработке');
$('helpBtn').onclick=()=>snack('Справка — в разработке');
$('editBtn').onclick=()=>{$('actionsMenu').classList.remove('show');if(!isAdmin()){snack('Только администратор может изменять серверы');return;}const s=servers.find(x=>x.id===sel);openDlg(s);};
$('delBtn').onclick=()=>{$('actionsMenu').classList.remove('show');if(sel)delServer(sel);};
function openDlg(s){
  $('modalTitle').textContent=s?'Изменить сервер':'Добавить сервер';
  $('d_name').value=s?(s.name||''):''; $('d_host').value=s?(s.host||''):''; $('d_user').value=s?(s.username||'admin'):'admin'; $('d_pass').value='';
  $('d_port').value=s?(s.port||80):80; $('d_secure').checked=s?(!!s.secure):false;
  $('modalBack').classList.add('show');
  $('dlgSave').onclick=async(e)=>{
    e.preventDefault();
    if(!isAdmin()){snack('Только администратор может изменять серверы');return;}
    const host=$('d_host').value.trim(); if(!host)return;
    const base={name:$('d_name').value.trim()||host,host,username:$('d_user').value.trim(),port:Number($('d_port').value)||80,secure:$('d_secure').checked};
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
