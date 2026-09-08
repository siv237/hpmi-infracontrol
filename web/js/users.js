async function loadUsers(){
  const j=await api('/api/users');
  users=j.users||[];
  $('userCount').textContent=users.length;
  renderUsers();
}
function renderUserBox(){
  $('personaName').textContent=me?(me.name||me.login):'—';
  $('personaRole').textContent=me?ROLE_LABEL[me.role]:'—';
  $('personaAv').textContent=me?(me.name||me.login||'?').trim().charAt(0).toUpperCase():'?';
}
function renderUsers(){
  const t=$('userTable'); let html='';
  html+='<tr><td class="k" style="width:52%">Пользователь</td><td class="k">Роль</td><td class="k">Состояние</td>'+(isAdmin()?'<td class="k" style="width:1%"></td>':'')+'</tr>';
  if(!users.length)html+='<tr><td colspan="4" style="color:var(--faint)">Нет пользователей.</td></tr>';
  users.forEach(u=>{
    html+='<tr>'
      +'<td><div class="ucell"><span class="uav">'+esc((u.name||u.login||'?').charAt(0).toUpperCase())+'</span><div><div style="font-weight:600">'+esc(u.name||u.login)+'</div><div class="sub">'+esc(u.login)+'</div></div></div></td>'
      +'<td>'+esc(ROLE_LABEL[u.role]||u.role)+'</td>'
      +'<td><span class="chip '+(u.enabled?'':'red')+'" style="display:inline-flex">'+(u.enabled?'Активен':'Отключён')+'</span></td>'
      +(isAdmin()?'<td><div class="row-actions"><button class="tool-btn" data-uedit="'+u.id+'">Изменить</button><button class="tool-btn" data-udel="'+u.id+'">Удалить</button></div></td>':'')
      +'</tr>';
  });
  t.innerHTML=html;
  t.querySelectorAll('[data-uedit]').forEach(b=>b.onclick=()=>openUserDlg(users.find(x=>x.id===b.getAttribute('data-uedit'))));
  t.querySelectorAll('[data-udel]').forEach(b=>b.onclick=()=>delUser(b.getAttribute('data-udel')));
}
function openUserDlg(u){
  editingUserId=u?u.id:null;
  $('userModalTitle').textContent=u?'Изменить пользователя':'Добавить пользователя';
  $('u_name').value=u?(u.name||''):'';
  $('u_login').value=u?(u.login||''):'';
  $('u_pass').value='';
  $('u_passHint').textContent=u?'(оставьте пустым, чтобы не менять)':'';
  $('u_role').value=u?(u.role||'user'):'user';
  $('u_en').checked=u?!!u.enabled:true;
  $('userModalBack').classList.add('show');
}
$('userAddBtn').onclick=()=>openUserDlg(null);
$('uDlgCancel').onclick=()=>$('userModalBack').classList.remove('show');
$('userModalBack').onclick=(ev)=>{if(ev.target===$('userModalBack'))$('userModalBack').classList.remove('show');};
$('uDlgSave').onclick=async(e)=>{
  e.preventDefault();
  const login=$('u_login').value.trim();
  if(!login){snack('Укажите логин');return;}
  const cfg={name:$('u_name').value.trim(),login,role:$('u_role').value,enabled:$('u_en').checked};
  if($('u_pass').value)cfg.password=$('u_pass').value;
  const j=editingUserId
    ?await api('/api/users/'+encodeURIComponent(editingUserId),{method:'PUT',body:JSON.stringify(cfg)})
    :await api('/api/users',{method:'POST',body:JSON.stringify(cfg)});
  if(j.okResp===false)return;
  $('userModalBack').classList.remove('show');
  snack('Сохранено');
  addEvent('info',editingUserId?('Пользователь изменён · '+cfg.name):'Пользователь добавлен · '+cfg.name);
  await loadUsers();
};
async function delUser(id){
  const u=users.find(x=>x.id===id);
  if(!confirm('Удалить пользователя «'+(u?(u.name||u.login):id)+'»?'))return;
  const j=await api('/api/users/'+encodeURIComponent(id),{method:'DELETE'});
  if(j.okResp===false){ snack(j.error||'Не удалось удалить'); return; }
  snack('Пользователь удалён');
  await loadUsers();
}
// меню профиля в шапке: Профиль / Выход
$('userBox').onclick=(e)=>{ if(!e.target.closest('.user-menu'))$('userMenu').classList.toggle('show'); e.stopPropagation(); };
document.addEventListener('click',(e)=>{ if(!e.target.closest('#userBox'))$('userMenu').classList.remove('show'); });
$('miProfile').onclick=()=>{ $('userMenu').classList.remove('show'); renderProfile(); showPage('profile'); document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active')); };
$('miLogout').onclick=async()=>{
  $('userMenu').classList.remove('show');
  try{ await api('/api/logout',{method:'POST',_noKick:true}); }catch{}
  authToken=null; me=null;
  try{ localStorage.removeItem('auth.token'); }catch{}
  showLogin();
};
// доступность действий по роли (админ управляет, пользователь смотрит)
function applyPerms(){
  const admin=isAdmin();
  $('userAddBtn').style.display=admin?'':'none';
  $('addBtn').style.display=admin?'':'none';
  $('editBtn').style.display=admin?'':'none';
  $('delBtn').style.display=admin?'':'none';
  document.body.classList.toggle('as-viewer',!admin);
}
// ---- профиль: сведения и смена своего пароля ------------------------------
function renderProfile(){
  $('profileTable').innerHTML=
    '<tr><td class="k">Имя</td><td class="v">'+esc(me?(me.name||me.login):'—')+'</td></tr>'
    +'<tr><td class="k">Логин</td><td class="v">'+esc(me?me.login:'—')+'</td></tr>'
    +'<tr><td class="k">Роль</td><td class="v">'+esc(me?ROLE_LABEL[me.role]:'—')+'</td></tr>';
  $('pf_curWrap').style.display=(me&&me.hasPassword)?'':'none';
  $('pf_cur').value=''; $('pf_next').value=''; $('pf_next2').value='';
}
$('pf_save').onclick=async()=>{
  const next=$('pf_next').value;
  if(next!==$('pf_next2').value){ snack('Новый пароль не совпадает с повтором'); return; }
  if(!next){ snack('Введите новый пароль'); return; }
  const j=await api('/api/me/password',{method:'POST',body:JSON.stringify({current:$('pf_cur').value,next})});
  if(j.okResp===false)return;
  snack('Пароль изменён');
  addEvent('info','Пароль обновлён · '+(me?me.login:''));
  const m=await api('/api/me',{_noKick:true});
  if(m.ok&&m.user)me=m.user;
  renderProfile();
};
