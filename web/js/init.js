showConsole();
startSnapshotLoop();
renderEvents();

// ---- запуск ---------------------------------------------------------------
loadExpanded();
(async function boot(){
  await loadUiConfig();
  if(authToken){
    const m=await api('/api/me',{_noKick:true});
    if(m.ok&&m.user){ enterApp(m.user); return; }
    authToken=null;
    try{ localStorage.removeItem('auth.token'); }catch{}
  }
  showLogin();
})();
