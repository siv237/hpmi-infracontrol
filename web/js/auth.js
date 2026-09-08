// ============================================================
//  минимальный RFB 3.8 клиент (как в рабочей версии)
// ============================================================

// ---- авторизация: страница входа -----------------------------------------
function showLogin(msg){
  $('l_err').style.display='none';
  if(msg){ const e=$('l_err'); e.textContent=msg; e.style.display='block'; }
  $('loginView').classList.add('show');
  $('l_login').value=''; $('l_password').value='';
  setTimeout(()=>$('l_login').focus(),50);
}
function hideLogin(){ $('loginView').classList.remove('show'); }
async function enterApp(user){
  me=user; hideLogin();
  await loadUiConfig();
  renderUserBox(); applyPerms();
  // восстановить последнюю открытую вкладку (F5 не сбрасывает на «Серверы»)
  let restorePage='servers';
  try{ const p=localStorage.getItem('ui.page'); if(p&&IMPLEMENTED.has(p))restorePage=p; }catch{}
  const savedSel=localStorage.getItem('ui.sel')||null;
  await load();
  showPage(restorePage);
  await loadUsers();
  if(restorePage==='servers'&&savedSel&&servers.some(s=>s.id===savedSel)){
    restoreDetail(savedSel);
  }
}
$('l_enter').onclick=async()=>{
  const login=$('l_login').value.trim(), password=$('l_password').value;
  if(!login){ const e=$('l_err'); e.textContent='Введите логин'; e.style.display='block'; return; }
  const j=await api('/api/login',{method:'POST',body:JSON.stringify({login,password}),_noKick:true});
  if(!j.ok){ const e=$('l_err'); e.textContent=j.error||'Неверный логин или пароль'; e.style.display='block'; $('l_password').value=''; $('l_password').focus(); return; }
  authToken=j.token;
  try{ localStorage.setItem('auth.token',authToken); }catch{}
  enterApp(j.user);
};
$('l_password').onkeydown=(e)=>{ if(e.key==='Enter')$('l_enter').click(); };
$('l_login').onkeydown=(e)=>{ if(e.key==='Enter')$('l_password').focus(); };
