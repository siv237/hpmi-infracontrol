// ============================================================
// Вся рабочая логика перенесена из рабочей версии (git) без
// изменения алгоритмов. Изменены только селекторы DOM-элементов
// под новый макет.
// ============================================================
const $=(id)=>document.getElementById(id);
let servers=[], sel=null, tab='overview';
let users=[], me=null;   // me: текущий пользователь (после входа)
let authToken=null;
try{ authToken=localStorage.getItem('auth.token')||null; }catch{}
const dbgStatus={};   // serverId -> 'on'|'err'
const dbgInv={};      // serverId -> inventory map
const dbgLastKnown={}; // serverId -> ts последнего снимка из базы
const dbgPower={};    // serverId -> 'on'|'off'|'unknown'

const ROLE_LABEL={admin:'Администратор',user:'Пользователь'};

function snack(t){const s=$('snack');s.textContent=t;s.classList.add('show');clearTimeout(s._t);s._t=setTimeout(()=>s.classList.remove('show'),2600);}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

// fetch с сессией; 401 (кроме самой авторизации) — показать страницу входа
function sessionHeaders(extra){
  const h=Object.assign({},extra||{});
  if(authToken)h['Authorization']='Bearer '+authToken;
  return h;
}
async function api(url,opts={}){
  opts.headers=Object.assign({'Content-Type':'application/json'},opts.headers||{});
  if(authToken)opts.headers['Authorization']='Bearer '+authToken;
  const kick=opts._noKick!==true;
  delete opts._noKick;
  const r=await fetch(url,opts);
  if(r.status===401&&kick){ showLogin('Сессия завершена. Войдите снова.'); let j={}; try{j=await r.json();}catch{} return {status:401,okResp:false,...j}; }
  let j={}; try{ j=await r.json(); }catch{}
  if(r.status===403)snack(j.error||'Требуются права администратора');
  return {status:r.status,okResp:r.ok,...j};
}
const isAdmin=()=>!!(me&&me.role==='admin');

// ---- статус --------------------------------------------------------------
function setStatus(t){ if(t) snack(t); }
