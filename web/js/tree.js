// ---- список серверов -----------------------------------------------------
async function load(){
  const j=await api('/api/servers');
  servers=j.servers||[];
  $('servCount').textContent=servers.length;
  renderTree();
  const pg=$('page-groups');
  if(pg&&pg.style.display!=='none')loadGroupsPage();
}
function treeFilter(){return ($('treeSearch').value||'').trim().toLowerCase();}
// Авто-филиал = первые два октета IPv4 (обезличенное имя, реальные данные);
// не-IP адреса попадают в «Филиал прочие»
function branchKey(host){
  const m=/^(\d{1,3})\.(\d{1,3})\./.exec(String(host||'').trim());
  return m?'Филиал '+m[1]+'.'+m[2]:'Филиал прочие';
}
// Явная группа сервера (group=null/'' -> авто по IP); root='' -> корень по умолчанию
function groupKeyOf(s){ return (s.group===null||s.group===undefined||s.group==='')?branchKey(s.host):String(s.group); }
function rootKeyOf(s){ return s.root||''; }
function srvRootName(r){ return r?r:rootName; }
let expanded={};           // 'root' | 'r:<корень>' | 'g:<корень>|<группа>' -> открыто?
let rootName='Все серверы'; // имя корня по умолчанию — из локального data/ui.json (вне git)
let uiRoots=[];             // доп. корни (организации) — data/ui.json
let uiGroups=[];            // объявленные группы (могут быть пустыми) — data/ui.json
async function loadUiConfig(){
  try{
    const j=await api('/api/ui',{_noKick:true});
    if(j&&j.rootName)rootName=j.rootName;
    if(j&&Array.isArray(j.roots))uiRoots=j.roots;
    if(j&&Array.isArray(j.groups))uiGroups=j.groups;
  }catch{}
}
function loadExpanded(){ try{ expanded=JSON.parse(localStorage.getItem('ui.tree.expanded')||'{}')||{}; }catch{ expanded={}; } }
function saveExpanded(){ try{ localStorage.setItem('ui.tree.expanded',JSON.stringify(expanded)); }catch{} }
const CHEV='<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
// Все корни дерева: умолчание + объявленные (ui.json) + уже занятые серверами
function treeRootsOf(){
  const set=new Set(['']);
  uiRoots.forEach(r=>{ if(r)set.add(r); });
  servers.forEach(s=>{ if(s.root)set.add(s.root); });
  return [...set].sort((a,b)=> a===''?-1:(b===''?1:a.localeCompare(b,'ru')));
}
function serversOfRoot(R){ return servers.filter(s=>rootKeyOf(s)===R); }
function isDeclaredGroup(R,k){ return uiGroups.some(g=>g.name===k&&(g.root||'')===R); }
// Группы корня: объявленные (в т.ч. пустые) + фактические по серверам
function treeGroupsOf(R){
  const set=new Set(uiGroups.filter(g=>(g.root||'')===R).map(g=>g.name));
  serversOfRoot(R).forEach(s=>set.add(groupKeyOf(s)));
  return [...set].sort(cmpGroups);
}
const AUTO_RE=/^Филиал (\d+)\.(\d+)$/;
// сортировка: именованные группы по алфавиту, авто-филиалы по IP числом, «прочие» последними
function cmpGroups(a,b){
  const at=AUTO_RE.test(a)?1:(a==='Филиал прочие'?2:0), bt=AUTO_RE.test(b)?1:(b==='Филиал прочие'?2:0);
  if(at!==bt)return at-bt;
  if(at===1){const pa=a.match(/\d+/g).map(Number),pb=b.match(/\d+/g).map(Number);return (pa[0]-pb[0])||(pa[1]-pb[1]);}
  return a.localeCompare(b,'ru');
}
function leafHtml(s){
  const st=dbgStatus[s.id]||'off';
  const stLabel=st==='on'?'Онлайн':st==='err'?'Недоступен':'Нет данных';
  const cls=s.id===sel?' sel':'';
  return '<div class="tnode leaf sub'+cls+'" data-kind="leaf" data-id="'+s.id+'" draggable="'+(isAdmin()?'true':'false')+'">'
    +'<span class="st '+st+'"></span><span class="nm">'+esc(s.name||s.host)+'</span>'
    +'<span class="nst '+st+'">'+stLabel+'</span>'
    +(isAdmin()?'<button class="del" title="Удалить">✕</button>':'')
    +'</div>';
}
function groupNodesHtml(R,matched,searching){
  let h='';
  for(const k of treeGroupsOf(R)){
    const arr=matched.filter(s=>rootKeyOf(s)===R&&groupKeyOf(s)===k);
    const open=searching||expanded['g:'+R+'|'+k]!==false;
    h+='<div class="tnode folder sub grp'+(open?' open':'')+'" data-kind="group" data-grp="'+esc(k)+'" data-root="'+esc(R)+'" data-f="g:'+esc(R)+'|'+esc(k)+'">'
      +CHEV+'<span class="fld">'+esc(k)+'</span><span class="cnt">'+arr.length+'</span></div>';
    if(open){ for(const s of arr)h+=leafHtml(s); }
  }
  return h;
}
function renderTree(){
  const q=treeFilter();
  const tree=$('tree');
  if(!servers.length&&!uiRoots.length&&!uiGroups.length){
    tree.innerHTML='<div class="tree-empty">Серверы не добавлены.'+(isAdmin()?'<br>Нажмите «Добавить» или правую кнопку — новая группа.':'')+'</div>';
    return;
  }
  const matched=servers.filter(s=>!q
    ||(s.name||'').toLowerCase().includes(q)
    ||(s.host||'').toLowerCase().includes(q)
    ||(dbgNet[s.id]&&String(dbgNet[s.id].mac||'').toLowerCase().includes(q)) // поиск по MAC (4a.3)
    ||(s.root||'').toLowerCase().includes(q)
    ||groupKeyOf(s).toLowerCase().includes(q));
  const searching=!!q;
  // Все корни — ровесники ВЕРХНЕГО уровня (умолчание + организации).
  // Раньше доп. корни рендерились вложенными в главный, а его счётчик
  // считал ВСЕ серверы — корень выглядел «подкорнем» и счёт «удваивался».
  let html='';
  for(const R of treeRootsOf()){
    const isDef=R==='';
    const cnt=matched.filter(s=>rootKeyOf(s)===R).length;
    const open=searching||expanded[isDef?'root':'r:'+R]!==false;
    html+='<div class="tnode folder root'+(open?' open':'')+'" data-kind="root" data-root="'+esc(R)+'" data-f="'+(isDef?'root':'r:'+esc(R))+'">'
      +CHEV+'<span class="fld">'+esc(srvRootName(R))+'</span><span class="cnt">'+cnt+'</span></div>';
    if(open)html+=groupNodesHtml(R,matched,searching);
  }
  tree.innerHTML=html;
  tree.querySelectorAll('.tnode.folder').forEach(n=>{
    n.onclick=()=>{
      const k=n.getAttribute('data-f'); if(!k)return;
      expanded[k]=expanded[k]===false?true:false;
      saveExpanded(); renderTree();
    };
  });
  tree.querySelectorAll('.tnode.leaf').forEach(n=>{
    const del=n.querySelector('.del');
    if(del)del.onclick=async(e)=>{e.stopPropagation(); await delServer(n.getAttribute('data-id'));};
    n.onclick=()=>select(n.getAttribute('data-id'));
  });
  attachTreeDnd();
  if(!treeCtxBound){treeCtxBound=true;attachTreeCtxMenu();}
}
let treeCtxBound=false;
// ---- drag & drop: сервер -> группа/корень (8.3) ----------------------------
let dragSrvId=null;
function attachTreeDnd(){
  if(!isAdmin())return;
  const tree=$('tree');
  tree.querySelectorAll('.tnode.leaf').forEach(n=>{
    n.addEventListener('dragstart',e=>{
      dragSrvId=n.getAttribute('data-id');
      e.dataTransfer.setData('text/plain',dragSrvId);
      e.dataTransfer.effectAllowed='move';
      n.classList.add('dragging');
    });
    n.addEventListener('dragend',()=>{dragSrvId=null;n.classList.remove('dragging');clearDropMarks();});
  });
  tree.querySelectorAll('.tnode.folder').forEach(n=>{
    n.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';n.classList.add('droptarget');});
    n.addEventListener('dragleave',()=>n.classList.remove('droptarget'));
    n.addEventListener('drop',async e=>{
      e.preventDefault(); n.classList.remove('droptarget');
      const id=e.dataTransfer.getData('text/plain')||dragSrvId;
      if(!id)return;
      const R=n.getAttribute('data-root')||'';
      const grp=n.getAttribute('data-kind')==='group'?(n.getAttribute('data-grp')||''):null;
      await moveServerToGroup(id,grp,R);
    });
  });
}
function clearDropMarks(){ document.querySelectorAll('.tnode.droptarget').forEach(n=>n.classList.remove('droptarget')); }
async function moveServerToGroup(id,group,root){
  if(!isAdmin()){snack('Только администратор может перемещать серверы');return;}
  const s=servers.find(x=>x.id===id); if(!s)return;
  const body={
    group:group===undefined?((String(s.group||'')==='')?null:String(s.group)):group,
    root:root===undefined?rootKeyOf(s):root,
  };
  const j=await api('/api/servers/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify(body)});
  if(j.okResp===false)return;
  addEvent('info','Сервер перемещён · '+(s.name||s.host)+' → '+srvRootName(body.root)+(body.group===null?' / авто-филиал':' / '+body.group));
  await load();
}
// ---- контекстное меню дерева (8.2): одно живое меню, мгновенное закрытие ----
let treeMenuEl=null,treeMenuAway=null,treeMenuCtx=null,treeMenuEsc=null,treeMenuRaf=0;
function closeTreeMenu(){
  if(treeMenuRaf){cancelAnimationFrame(treeMenuRaf);treeMenuRaf=0;}
  if(treeMenuAway){document.removeEventListener('mousedown',treeMenuAway);treeMenuAway=null;}
  if(treeMenuCtx){document.removeEventListener('contextmenu',treeMenuCtx,true);treeMenuCtx=null;}
  if(treeMenuEsc){document.removeEventListener('keydown',treeMenuEsc);treeMenuEsc=null;}
  if(treeMenuEl){treeMenuEl.remove();treeMenuEl=null;}
}
function showTreeMenu(x,y,items){
  closeTreeMenu();
  const m=document.createElement('div');
  m.className='tree-menu';
  m.innerHTML=items.map((it,i)=>it==='-'?'<div class="sep"></div>'
    :'<button data-i="'+i+'"'+(it.danger?' class="danger"':'')+'>'+(it.icon||'')+esc(it.label)+'</button>').join('');
  document.body.appendChild(m);
  treeMenuEl=m;
  const r=m.getBoundingClientRect();
  m.style.left=Math.max(8,Math.min(x,innerWidth-r.width-8))+'px';
  m.style.top=Math.max(8,Math.min(y,innerHeight-r.height-8))+'px';
  treeMenuRaf=requestAnimationFrame(()=>{treeMenuRaf=0;m.classList.add('show');});
  // закрытие: клик мимо, правый клик мимо, Esc — слушатели снимаются вместе с меню.
  // Подписываем со следующего тика: иначе этот же contextmenu-клик, всплыв
  // до document, мгновенно закрыл бы только что открытое меню.
  treeMenuAway=(ev)=>{ if(!m.contains(ev.target))closeTreeMenu(); };
  treeMenuCtx=(ev)=>{ if(!m.contains(ev.target))closeTreeMenu(); };
  treeMenuEsc=(ev)=>{ if(ev.key==='Escape')closeTreeMenu(); };
  setTimeout(()=>{
    if(treeMenuEl!==m)return; // меню уже закрыто
    document.addEventListener('mousedown',treeMenuAway);
    document.addEventListener('contextmenu',treeMenuCtx,true);
    document.addEventListener('keydown',treeMenuEsc);
  },0);
  m.addEventListener('click',async e=>{
    const b=e.target.closest('button[data-i]'); if(!b)return;
    const it=items[Number(b.getAttribute('data-i'))];
    closeTreeMenu();
    if(it&&it.fn)await it.fn();
  });
}
const ICON_REN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>';
const ICON_ADD='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" style="width:15px;height:15px"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_UNDO='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>';
const ICON_MOV='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const ICON_TRASH='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
const ICON_CTI='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
function attachTreeCtxMenu(){
  const tree=$('tree');
  tree.addEventListener('contextmenu',e=>{
    const node=e.target.closest('.tnode');
    if(!node){
      // правый клик по свободному полю дерева: создание групп/корней (8.1/8.4)
      if(!isAdmin())return; // обычное меню браузера
      e.preventDefault();
      showTreeMenu(e.clientX,e.clientY,[
        {label:'Новая группа…',icon:ICON_ADD,fn:()=>addUiGroup('')},
        {label:'Новый корень…',icon:ICON_ADD,fn:addUiRoot},
        '-',
        {label:'Добавить сервер',icon:ICON_ADD,fn:()=>openDlg(null)},
      ]);
      return;
    }
    const kind=node.getAttribute('data-kind');
    const R=node.getAttribute('data-root')||'';
    if(kind==='leaf'){
      e.preventDefault();
      const id=node.getAttribute('data-id');
      const s=servers.find(x=>x.id===id);
      const items=[
        {label:'Открыть консоль',icon:ICON_CTI,fn:()=>{select(id);setTimeout(()=>connectConsole(id),60);}},
        {label:'Изменить…',icon:ICON_REN,fn:()=>{if(isAdmin())openDlg(s);else snack('Только администратор может изменять серверы');}},
      ];
      if(isAdmin())items.push(
        {label:'Переместить в группу…',icon:ICON_MOV,fn:()=>moveServerAsk(id)},
        '-',
        {label:'Удалить',icon:ICON_TRASH,danger:true,fn:()=>delServer(id)}
      );
      showTreeMenu(e.clientX,e.clientY,items);
    } else if(kind==='group'){
      if(!isAdmin())return;
      e.preventDefault();
      const k=node.getAttribute('data-grp')||'';
      const arr=serversOfRoot(R).filter(s=>groupKeyOf(s)===k);
      const items=[
        {label:'Переименовать группу…',icon:ICON_REN,fn:()=>renameGroup(k,R)},
        {label:'Добавить сервер в группу',icon:ICON_ADD,fn:()=>openDlg(null,{root:R,group:k})},
      ];
      if(isDeclaredGroup(R,k)||arr.length)items.push('-',
        {label:'Сбросить на авто-филиалы',icon:ICON_UNDO,danger:true,fn:()=>resetGroup(k,R)});
      showTreeMenu(e.clientX,e.clientY,items);
    } else if(kind==='root'){
      if(!isAdmin())return;
      e.preventDefault();
      if(R===''){
        showTreeMenu(e.clientX,e.clientY,[
          {label:'Создать группу…',icon:ICON_ADD,fn:()=>addUiGroup('')},
          {label:'Переименовать корень…',icon:ICON_REN,fn:renameRoot},
          '-',
          {label:'Добавить сервер',icon:ICON_ADD,fn:()=>openDlg(null)},
        ]);
      } else {
        showTreeMenu(e.clientX,e.clientY,[
          {label:'Создать группу…',icon:ICON_ADD,fn:()=>addUiGroup(R)},
          {label:'Переименовать корень…',icon:ICON_REN,fn:()=>renameUiRoot(R)},
          '-',
          {label:'Добавить сервер в корень',icon:ICON_ADD,fn:()=>openDlg(null,{root:R})},
          {label:'Удалить корень',icon:ICON_TRASH,danger:true,fn:()=>delUiRoot(R)},
        ]);
      }
    }
  });
}
// ---- модалка простого ввода (имя группы/корня) ----------------------------
function promptDialog(title,value,cb){
  const back=document.createElement('div');
  back.className='modal-back show';
  back.innerHTML='<div class="modal"><div class="ttl">'+esc(title)+'</div>'
    +'<div class="bd"><div class="fields"><div class="field"><label>Название</label>'
    +'<input type="text" id="pdInput" value="'+esc(value)+'"></div></div></div>'
    +'<div class="ft"><button class="tool-btn" id="pdCancel">Отмена</button>'
    +'<button class="tool-btn primary" id="pdOk">Сохранить</button></div></div>';
  document.body.appendChild(back);
  const inp=back.querySelector('#pdInput'); inp.focus(); inp.select();
  const close=()=>back.remove();
  const ok=()=>{const v=inp.value.trim(); close(); if(v)cb(v);};
  back.querySelector('#pdOk').onclick=ok;
  back.querySelector('#pdCancel').onclick=close;
  back.onclick=(ev)=>{if(ev.target===back)close();};
  inp.addEventListener('keydown',ev=>{if(ev.key==='Enter')ok();if(ev.key==='Escape')close();});
}
// ---- операции над структурой (ui.json + серверы) --------------------------
function refreshUiFromResp(j){ if(!j)return; if(j.rootName)rootName=j.rootName; if(Array.isArray(j.roots))uiRoots=j.roots; if(Array.isArray(j.groups))uiGroups=j.groups; }
// Единая точка после ЛЮБОГО изменения структуры (корни/группы/перемещения):
// перерисовать дерево и, если открыта, доску «Группы» — иначе новая группа
// была бы видна только после F5.
function uiStructureChanged(){
  renderTree();
  const pg=$('page-groups');
  if(pg&&pg.style.display!=='none')loadGroupsPage();
}
async function renameRoot(){
  promptDialog('Переименовать корень',rootName,async v=>{
    const j=await api('/api/ui',{method:'PUT',body:JSON.stringify({rootName:v})});
    if(j.okResp===false)return;
    refreshUiFromResp(j);
    addEvent('info','Корень дерева переименован · '+v);
    uiStructureChanged();
  });
}
async function addUiGroup(R){
  promptDialog('Новая группа в «'+srvRootName(R)+'»','',async v=>{
    if(treeGroupsOf(R).includes(v)){snack('Группа «'+v+'» уже есть');return;}
    const j=await api('/api/ui',{method:'PUT',body:JSON.stringify({addGroup:{root:R,name:v}})});
    if(j.okResp===false)return;
    refreshUiFromResp(j);
    addEvent('info','Группа создана · '+srvRootName(R)+' / '+v);
    uiStructureChanged();
  });
}
async function addUiRoot(){
  promptDialog('Новый корень (организация)','',async v=>{
    const j=await api('/api/ui',{method:'PUT',body:JSON.stringify({addRoot:v})});
    if(j.okResp===false)return;
    refreshUiFromResp(j);
    addEvent('info','Корень создан · '+v);
    uiStructureChanged();
  });
}
async function renameUiRoot(R){
  promptDialog('Переименовать корень',R,async v=>{
    const j=await api('/api/ui',{method:'PUT',body:JSON.stringify({renameRoot:{from:R,to:v}})});
    if(j.okResp===false)return;
    refreshUiFromResp(j);
    for(const s of serversOfRoot(R)){
      const r=await api('/api/servers/'+encodeURIComponent(s.id),{method:'PUT',body:JSON.stringify({root:v})});
      if(r.okResp===false)return;
    }
    addEvent('info','Корень переименован · '+R+' → '+v);
    await load(); uiStructureChanged();
  });
}
async function delUiRoot(R){
  const inRoot=serversOfRoot(R);
  if(!confirm('Удалить корень «'+R+'»?'+(inRoot.length?(' Его серверы ('+inRoot.length+') вернутся в «'+rootName+'».'):'')))return;
  for(const s of inRoot){
    const r=await api('/api/servers/'+encodeURIComponent(s.id),{method:'PUT',body:JSON.stringify({root:''})});
    if(r.okResp===false)return;
  }
  const j=await api('/api/ui',{method:'PUT',body:JSON.stringify({delRoot:R})});
  if(j.okResp===false)return;
  refreshUiFromResp(j);
  addEvent('info','Корень удалён · '+R);
  await load(); uiStructureChanged();
}
// Переименование группы: переименование объявления (ui.json) + массовая
// запись group всем серверам ветки (8.1)
async function renameGroup(k,R){
  const arr=serversOfRoot(R).filter(s=>groupKeyOf(s)===k);
  if(!arr.length&&!isDeclaredGroup(R,k)){snack('В группе нет серверов');return;}
  promptDialog('Переименовать группу'+(arr.length?' ('+arr.length+')':''),k,async v=>{
    if(v!==k&&treeGroupsOf(R).includes(v)){snack('Группа «'+v+'» уже есть');return;}
    if(isDeclaredGroup(R,k)){
      const j=await api('/api/ui',{method:'PUT',body:JSON.stringify({renameGroup:{root:R,from:k,to:v}})});
      if(j.okResp===false)return;
      refreshUiFromResp(j);
    }
    for(const s of arr){
      const r=await api('/api/servers/'+encodeURIComponent(s.id),{method:'PUT',body:JSON.stringify({group:v})});
      if(r.okResp===false)return;
    }
    addEvent('info','Группа переименована · '+k+' → '+v+(arr.length?' ('+arr.length+')':''));
    await load(); uiStructureChanged();
  });
}
// Сброс группы: серверы ветки -> авто-филиал по IP, объявление удаляется
async function resetGroup(k,R){
  const arr=serversOfRoot(R).filter(s=>groupKeyOf(s)===k);
  if(!arr.length&&!isDeclaredGroup(R,k))return;
  if(!confirm('Сбросить группу «'+k+'»'+(arr.length?(' ('+arr.length+' серверов → авто-филиалы по IP)'):'')+'?'))return;
  for(const s of arr){
    const r=await api('/api/servers/'+encodeURIComponent(s.id),{method:'PUT',body:JSON.stringify({group:null})});
    if(r.okResp===false)return;
  }
  if(isDeclaredGroup(R,k)){
    const j=await api('/api/ui',{method:'PUT',body:JSON.stringify({delGroup:{root:R,name:k}})});
    if(j.okResp===false)return;
    refreshUiFromResp(j);
  }
  addEvent('info','Группа сброшена на авто-филиалы · '+k);
  await load(); uiStructureChanged();
}
// Перемещение одного сервера: выбор из групп его корня или новое имя
async function moveServerAsk(id){
  const s=servers.find(x=>x.id===id); if(!s)return;
  const R=rootKeyOf(s);
  const cur=groupKeyOf(s);
  const list=treeGroupsOf(R).filter(g=>g!==cur);
  const back=document.createElement('div');
  back.className='modal-back show';
  back.innerHTML='<div class="modal"><div class="ttl">Переместить «'+esc(s.name||s.host)+'»</div>'
    +'<div class="bd"><div class="fields">'
    +'<div class="field"><label>Группа (в «'+esc(srvRootName(R))+'»)</label><input type="text" id="mvInput" list="mvList" value="'+esc(cur)+'">'
    +'<datalist id="mvList">'+list.map(g=>'<option value="'+esc(g)+'">').join('')+'</datalist></div>'
    +'<div style="font-size:12px;color:var(--faint);margin-top:6px">Пусто = авто-филиал по IP; можно и перетаскивать мышью в дереве.</div>'
    +'</div></div>'
    +'<div class="ft"><button class="tool-btn" id="mvCancel">Отмена</button>'
    +'<button class="tool-btn primary" id="mvOk">Переместить</button></div></div>';
  document.body.appendChild(back);
  const inp=back.querySelector('#mvInput'); inp.focus(); inp.select();
  const close=()=>back.remove();
  const ok=async()=>{const v=inp.value.trim();close();await moveServerToGroup(id,v===''?null:v,R);};
  back.querySelector('#mvOk').onclick=ok;
  back.querySelector('#mvCancel').onclick=close;
  back.onclick=(ev)=>{if(ev.target===back)close();};
  inp.addEventListener('keydown',ev=>{if(ev.key==='Enter')ok();if(ev.key==='Escape')close();});
}
// Восстановить выбор сервера и вкладку после F5 (BUG-001): select() сам
// поднимает данные/консоль, затем применяем сохранённую вкладку детали.
function restoreDetail(id){
  select(id);
  saveExpanded();
  const t=localStorage.getItem('ui.tab')||'overview';
  const valid=['overview','hardware','health','network','storage','events','console','files','settings'];
  if(valid.includes(t)&&t!=='overview'){
    const tEl=document.querySelector('#tabs .tab[data-tab="'+t+'"]');
    if(tEl){ switchTab(t); }
  }
}
async function delServer(id){
  if(!isAdmin()){snack('Только администратор может удалять серверы');return;}
  const s=servers.find(x=>x.id===id);
  if(!confirm('Удалить сервер «'+(s?(s.name||s.host):id)+'»?'))return;
  const j=await api('/api/servers/'+encodeURIComponent(id),{method:'DELETE'});
  if(j.okResp===false)return;
  addEvent('info','Сервер удалён'+(s?(' · '+(s.name||s.host)):''));
  if(consoles[id])disconnectConsole(id); // закрыть и консоль удалённого
  if(sel===id){sel=null;hideDetail();}
  await load();
}
