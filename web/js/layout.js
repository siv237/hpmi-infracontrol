// ---- сворачивание сайдбара (с запоминанием) -------------------------------
const appEl=document.querySelector('.app');
function setFold(c){
  appEl.classList.toggle('collapsed',c);
  const lbl=document.querySelector('#foldBtn .lbl');
  if(lbl)lbl.textContent=c?'Развернуть меню':'Свернуть меню';
  $('foldBtn').title=c?'Развернуть меню':'Свернуть меню';
  try{localStorage.setItem('ui.folded',c?'1':'0');}catch{}
}
$('foldBtn').onclick=()=>setFold(!appEl.classList.contains('collapsed'));
try{ if(localStorage.getItem('ui.folded')==='1')setFold(true); }catch{}
// ---- страницы (разделы) ---------------------------------------------------
function showPage(id){
  document.querySelectorAll('.page').forEach(p=>p.style.display='none');
  const p=$('page-'+id); if(p)p.style.display='block';
  document.querySelector('.search').style.display=(id==='servers')?'':'none';
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.getAttribute('data-id')===id));
  try{ localStorage.setItem('ui.page',id); }catch{}
  if(id==='users')loadUsers();
  if(id==='iso')loadIso();
  if(id==='overview')startOverview();
  if(id==='logs')loadLogs();
}
const IMPLEMENTED=new Set(['servers','users','iso','overview','logs']);
document.querySelectorAll('.nav-item').forEach(n=>{
  n.onclick=()=>{
    const id=n.getAttribute('data-id');
    if(IMPLEMENTED.has(id)){
      document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x===n));
      showPage(id);
    } else {
      snack('Раздел в разработке');
    }
  };
});
$('globalSearch').oninput=(e)=>{$('treeSearch').value=e.target.value;renderTree();};
$('treeSearch').oninput=()=>renderTree();
