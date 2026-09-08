// ---- вкладки -------------------------------------------------------------
function switchTab(name){
  const t=document.querySelector('#tabs .tab[data-tab="'+name+'"]'); if(!t)return;
  tab=name;
  try{ localStorage.setItem('ui.tab',name); }catch{}
  document.querySelectorAll('#tabs .tab').forEach(x=>x.classList.toggle('active',x===t));
  document.querySelectorAll('.tabpane').forEach(x=>x.style.display='none');
  $('pane-'+tab).style.display='block';
  showConsole();
  if(tab==='storage') renderStorage();
  if(tab==='health'){ try{ loadSensors(sel); }catch{} }
  if(tab==='overview'){try{$('cvwrap').parentElement.scrollIntoView({block:'nearest'});}catch{}}
}
$('tabs').addEventListener('click',(e)=>{
  const t=e.target.closest('.tab'); if(!t)return;
  switchTab(t.getAttribute('data-tab'));
});
$('allEventsLink').onclick=()=>switchTab('events');

// ---- меню «Действия» ------------------------------------------------------
$('actionsBtn').onclick=(e)=>{e.stopPropagation();$('actionsMenu').classList.toggle('show');};
document.addEventListener('click',(e)=>{ if(!e.target.closest('.menu-wrap'))$('actionsMenu').classList.remove('show'); });
$('refreshInfoBtn').onclick=()=>{ $('actionsMenu').classList.remove('show'); if(sel)loadInv(sel); };
