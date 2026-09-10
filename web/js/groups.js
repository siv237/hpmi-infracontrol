// ---- страница «Группы»: управление структурой дерева ----------------------
// Корни-организации + группы (объявленные в data/ui.json) и фактические по
// серверам. Операции через PUT /api/ui (admin) и PUT /api/servers/:id.
// У группы может быть «паспорт» (п.13-подобная идея): адрес, ответственный,
// контакты, заметки — хранится в объявлении группы (data/ui.json).
function grpMetaOf(R,k){ const g=uiGroups.find(x=>(x.root||'')===R&&x.name===k); return g||null; }
function grpHasMeta(g){ return g&&(g.desc||g.loc||g.owner||g.contact||g.notes); }
function grpBadge(n){ return '<span class="cnt">'+n+'</span>'; }
function grpBoardHtml(){
  const roots=treeRootsOf();
  let h='';
  for(const R of roots){
    const inRoot=serversOfRoot(R);
    const groups=treeGroupsOf(R);
    const autoG=groups.filter(g=>AUTO_RE.test(g)||g==='Филиал прочие');
    const namedG=groups.filter(g=>!AUTO_RE.test(g)&&g!=='Филиал прочие');
    const rootBtns=R===''?'':(isAdmin()
      ?'<button class="grp-mini" data-op="r-ren" data-root="'+esc(R)+'">Переименовать</button>'
        +'<button class="grp-mini danger" data-op="r-del" data-root="'+esc(R)+'">Удалить</button>':'');
    h+='<div class="grp-root" data-root="'+esc(R)+'">'
      +'<div class="grp-root-hd">'
        +'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;flex:none;color:var(--accent)"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
        +'<span class="grp-root-nm">'+esc(srvRootName(R))+'</span>'
        +grpBadge(inRoot.length)
        +(isAdmin()?'<button class="grp-mini add" data-op="g-add" data-root="'+esc(R)+'">+ группа</button>':'')
        +'<span style="margin-left:auto"></span>'+rootBtns
      +'</div>'
      +'<div class="grp-root-bd">';
    const gRow=(k)=>{
      const srvs=inRoot.filter(s=>groupKeyOf(s)===k);
      const meta=grpMetaOf(R,k);
      const isAuto=AUTO_RE.test(k)||k==='Филиал прочие';
      const metaBtn=(isAdmin()||grpHasMeta(meta))
        ?'<button class="grp-mini" data-op="g-meta" data-root="'+esc(R)+'" data-grp="'+esc(k)+'">'+(grpHasMeta(meta)?'Паспорт':'Описать')+'</button>':'';
      return '<div class="grp-row'+(isAuto?' auto':'')+'" data-root="'+esc(R)+'" data-grp="'+esc(k)+'">'
        +'<span class="grp-dot"></span><span class="grp-nm">'+esc(k)+'</span>'
        +(grpHasMeta(meta)?'<button class="grp-tags" data-op="g-meta" data-root="'+esc(R)+'" data-grp="'+esc(k)+'" title="Описание группы">'
          +[meta.desc,meta.loc,meta.owner].filter(Boolean).map(x=>esc(x.length>18?x.slice(0,17)+'…':x)).map(t=>'<span>'+t+'</span>').join('')+'</button>':'')
        +'<span class="cnt">'+srvs.length+'</span>'
        +(isAuto?'<span class="grp-auto">авто по IP</span>':'')
        +metaBtn
        +'<span style="margin-left:auto"></span>'
        +(isAdmin()
          ?'<button class="grp-mini" data-op="g-ren" data-root="'+esc(R)+'" data-grp="'+esc(k)+'">Переименовать</button>'
            +(isAuto?'':'<button class="grp-mini danger" data-op="g-del" data-root="'+esc(R)+'" data-grp="'+esc(k)+'">Удалить</button>')
          :'')
        +'</div>';
    };
    if(namedG.length)h+=namedG.map(gRow).join('');
    if(autoG.length)h+='<div class="grp-autos">'+autoG.map(gRow).join('')+'</div>';
    if(!namedG.length&&!autoG.length)h+='<div class="grp-row" style="color:var(--faint)">Пусто — серверы не добавлены</div>';
    h+='</div></div>';
  }
  return h;
}
function loadGroupsPage(){
  const total=treeRootsOf().reduce((n,R)=>n+treeGroupsOf(R).length,0);
  $('grpStatTotal').textContent=total;
  $('grpBoard').innerHTML=grpBoardHtml()||'<div class="ov-empty" style="padding:30px">Корней нет</div>';
  if(!isAdmin())$('grpNewRootBtn').style.display=$('grpNewGroupBtn').style.display='none';
  else $('grpNewRootBtn').style.display=$('grpNewGroupBtn').style.display='';
}
function grpRefresh(){ uiStructureChanged(); }
$('grpNewRootBtn').onclick=()=>addUiRoot();
$('grpNewGroupBtn').onclick=()=>{
  const roots=treeRootsOf();
  if(roots.length===1){addUiGroup(roots[0]);return;}
  grpPickRoot('Новая группа','Выберите корень',R=>addUiGroup(R));
};
function grpPickRoot(title,sub,cb){
  const roots=treeRootsOf();
  const back=document.createElement('div');
  back.className='modal-back show';
  back.innerHTML='<div class="modal"><div class="ttl">'+esc(title)+'</div>'
    +'<div class="bd"><div style="font-size:13px;color:var(--muted);margin-bottom:10px">'+esc(sub)+'</div>'
    +roots.map(R=>'<button class="grp-pick" data-root="'+esc(R)+'">'+esc(srvRootName(R))+'</button>').join('')
    +'</div><div class="ft"><button class="tool-btn" id="grpPickCancel">Отмена</button></div></div>';
  document.body.appendChild(back);
  back.querySelectorAll('.grp-pick').forEach(b=>b.onclick=()=>{const R=b.getAttribute('data-root');back.remove();cb(R);});
  back.querySelector('#grpPickCancel').onclick=()=>back.remove();
  back.onclick=(ev)=>{if(ev.target===back)back.remove();};
}
// ---- «Паспорт группы»: модал с описанием -------------------------------
// Поля: назначение (desc), адрес/кабинет (loc), ответственный (owner),
// контакты (contact), заметки (notes). Если группа — авто-филиал по IP,
// описание создаётся как объявление (в ui.json), имя сохраняется.
function grpMetaDlg(R,k){
  const m=grpMetaOf(R,k)||{};
  const back=document.createElement('div');
  back.className='modal-back show';
  const f=(id,label,ph)=>'<div class="field"><label>'+label+'</label><input type="text" id="'+id+'" placeholder="'+esc(ph)+'" value="'+esc(m[id]||'')+'"></div>';
  back.innerHTML='<div class="modal" style="width:520px"><div class="ttl">Паспорт группы · '+esc(k)+'</div>'
    +'<div class="bd"><div class="fields">'
    +f('desc','Назначение (что это)','Например: серверная филиала, тестовый стенд')
    +f('loc','Адрес / расположение','Город, улица, этаж, кабинет')
    +f('owner','Ответственный','ФИО или команда')
    +f('contact','Контакты','Телефон, e-mail, мессенджер')
    +'<div class="field"><label>Заметки</label><textarea id="gm_notes" rows="3" style="width:100%;border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:13px;font-family:inherit;outline:none" placeholder="Произвольные заметки">'+esc(m.notes||'')+'</textarea></div>'
    +'</div></div>'
    +'<div class="ft"><button class="tool-btn" id="gmCancel">Отмена</button>'
    +(isAdmin()?'<button class="tool-btn primary" id="gmOk">Сохранить</button>':'')+'</div></div>';
  document.body.appendChild(back);
  back.querySelector('#gmCancel').onclick=()=>back.remove();
  back.onclick=(ev)=>{if(ev.target===back)back.remove();};
  const okBtn=back.querySelector('#gmOk');
  if(okBtn)okBtn.onclick=async()=>{
    const meta={
      desc:back.querySelector('#gm_desc').value,
      loc:back.querySelector('#gm_loc').value,
      owner:back.querySelector('#gm_owner').value,
      contact:back.querySelector('#gm_contact').value,
      notes:back.querySelector('#gm_notes').value,
    };
    if(!meta.desc&&!meta.loc&&!meta.owner&&!meta.contact&&!meta.notes){
      if(!confirm('Все поля пусты — удалить паспорт группы?'))return;
    }
    const j=await api('/api/ui',{method:'PUT',body:JSON.stringify({setGroupMeta:{root:R,name:k,meta}})});
    if(j.okResp===false)return;
    refreshUiFromResp(j);
    addEvent('info','Паспорт группы сохранён · '+k);
    back.remove(); grpRefresh();
  };
}
function grpDelete(R,k){
  const arr=serversOfRoot(R).filter(s=>groupKeyOf(s)===k);
  if(arr.length){resetGroup(k,R);return;} // со серверами — сброс на авто
  if(!confirm('Удалить группу «'+k+'»?'))return;
  api('/api/ui',{method:'PUT',body:JSON.stringify({delGroup:{root:R,name:k}})}).then(j=>{
    if(j.okResp===false)return;
    refreshUiFromResp(j);
    addEvent('info','Группа удалена · '+srvRootName(R)+' / '+k);
    grpRefresh();
  });
}
function grpBoardClick(e){
  const row=e.target.closest('.grp-row'); 
  const b=e.target.closest('.grp-mini,.grp-tags'); 
  if(b){
    e.stopPropagation();
    if(!isAdmin())return;
    const op=b.getAttribute('data-op'), R=b.getAttribute('data-root')||'', k=b.getAttribute('data-grp')||'';
    if(op==='g-add')addUiGroup(R);
    else if(op==='g-ren')renameGroup(k,R);
    else if(op==='g-del')grpDelete(R,k);
    else if(op==='g-meta')grpMetaDlg(R,k);
    else if(op==='r-ren')R===''?renameRoot():renameUiRoot(R);
    else if(op==='r-del')delUiRoot(R);
    return;
  }
  // клик по строке группы — свернуть/развернуть список серверов (переход)
  if(row){
    const R=row.getAttribute('data-root')||'', k=row.getAttribute('data-grp')||'';
    grpExpandToggle(R,k,row);
  }
}
// Раскрытие: под группой — её серверы (клик по серверу = выбрать в «Серверах»)
function grpExpandToggle(R,k,row){
  const next=row.nextElementSibling;
  if(next&&next.classList.contains('grp-srvs')){next.remove();return;}
  document.querySelectorAll('.grp-srvs').forEach(n=>n.remove());
  const srvs=serversOfRoot(R).filter(s=>groupKeyOf(s)===k);
  const div=document.createElement('div');
  div.className='grp-srvs';
  if(!srvs.length)div.innerHTML='<div class="grp-srv-empty">Серверов нет</div>';
  else div.innerHTML=srvs.map(s=>{
    const st=dbgStatus[s.id]||'off';
    return '<div class="grp-srv" data-id="'+s.id+'"><span class="st '+st+'"></span>'+esc(s.name||s.host)+'<span class="srv-ip">'+esc(s.host||'')+'</span></div>';
  }).join('');
  row.after(div);
  div.querySelectorAll('.grp-srv').forEach(el=>el.onclick=()=>{
    showPage('servers');
    select(el.getAttribute('data-id'));
  });
}
function initGroupsPage(){
  const board=$('grpBoard');
  if(board&&!board._bound){board._bound=true;board.addEventListener('click',grpBoardClick);}
}
