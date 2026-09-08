// ============================================================
//  КОНСОЛИ — по одной на сервер. Подключения живут фоном (по одному
//  noVNC-iframe на сервер), отключение — только вручную. При выборе
//  сервера показывается его консоль или заглушка «не подключено».
// ============================================================
let _snapTimer=null;
let consoles={};   // serverId -> { token, iframe, connected }

function showMsg(t,ok){ const m=$('msg'); m.innerHTML='<div class="alert '+(ok?'ok':'err')+'"></div>'; m.firstChild.textContent=t; }

function conOf(id){ if(!consoles[id])consoles[id]={token:null,iframe:null,connected:false}; return consoles[id]; }
function curCon(){ return sel?conOf(sel):null; }
function curToken(){ const c=curCon(); return (c&&c.connected)?c.token:null; }

// показать консоль выбранного сервера (или заглушку, если не подключена)
function showConsole(){
  const dst=(tab==='console')? $('cvwrap2') : $('cvwrap');
  if(!dst)return;
  const con=curCon();
  const active=!!(con&&con.connected&&con.iframe);
  // спрятать все чужие iframes
  for(const id in consoles){ const f=consoles[id].iframe; if(f&&f!==con.iframe)f.style.display='none'; }
  if(active){
    const f=con.iframe;
    // перенос в другую площадку перезагружает iframe — noVNC сам переподключится
    if(f.parentElement!==dst) dst.appendChild(f);
    if($('cv').parentElement!==dst) dst.appendChild($('cv'));
    f.style.display='block';
    dst.classList.add('connected');
  } else {
    dst.classList.remove('connected');
  }
  $('kvmStat').classList.toggle('on',active);
  $('kvmStatLabel').textContent=active?'Подключено':'Отключено';
  $('disconnBtn').textContent=active?'Отключиться':'Подключиться';
  document.querySelectorAll('.kvm-tool .kbtn[data-k]').forEach(b=>b.disabled=!active);
  document.querySelectorAll('.kvm-tool .icbtn').forEach(b=>b.disabled=!active);
}

// live view: poll серверный декодированный фреймбуфер выбранного сервера
// и рисуем на canvas — надёжно для статичных/чёрных экранов (запасной канал).
function startSnapshotLoop(){
  if(_snapTimer) clearInterval(_snapTimer);
  const cv=$('cv');
  const grab=async()=>{
    const token=curToken(); if(!token)return;
    try{
      const r=await fetch('/api/snapshot/'+encodeURIComponent(token),{headers:sessionHeaders()});
      const j=await r.json();
      if(j.ok && j.png){ const img=new Image(); img.onload=()=>{ if(cv.width!==j.width){cv.width=j.width;cv.height=j.height;} cv.getContext('2d').drawImage(img,0,0); }; img.src=j.png; }
    }catch{}
  };
  grab();
  _snapTimer=setInterval(grab,2000);
}

$('connBtn').onclick=()=>{ connectConsole(sel,0); };

async function connectConsole(id,attempt){
  if(!id) return;
  const con=conOf(id);
  if(con.connected){ showConsole(); return; } // уже подключён — просто показать
  snack(attempt?('Переподключение '+attempt+'/3…'):'Подключение к AVR…');
  const r=await fetch('/api/connect',{method:'POST',headers:sessionHeaders({'Content-Type':'application/json'}),body:JSON.stringify({serverId:id})});
  const j=await r.json();
  if(j.status===401)return; // сессия истекла — показана страница входа
  if(!j.ok){ if(attempt<3){ snack('Ошибка: '+((j.error||'').slice(0,70))+' — повтор…'); setTimeout(()=>connectConsole(id,attempt+1),1500); } else { snack('Не удалось подключиться: '+(j.error||'')); showMsg(j.error||'Ошибка подключения',false); addEvent('err','Не удалось открыть консоль — '+((j.error||'').slice(0,80))); } return; }
  snack(j.width?('Экран '+j.width+'×'+j.height):'Сессия восстанавливается…');
  con.token=j.token;
  con.connected=true;
  // свой noVNC-iframe на каждый сервер: resize=scale помещает весь экран
  // в контейнер; reconnect=1 возвращает канал после переносов между площадками.
  const s=servers.find(x=>x.id===id);
  const u = '/novnc/vnc.html?host=' + encodeURIComponent(location.hostname||location.host) +
            '&port=' + encodeURIComponent(location.port) +
            '&path=' + encodeURIComponent('vnc?token=' + j.token) +
            '&autoconnect=1&resize=scale&reconnect=1&show_dot=1';
  const f=document.createElement('iframe');
  f.className='novifr';
  f.allow='autoplay; clipboard-write; fullscreen';
  f.title='noVNC · '+(s?(s.name||s.host):id);
  f.style.display='none';
  const dst=(tab==='console')? $('cvwrap2') : $('cvwrap');
  dst.appendChild(f);
  f.src=u;
  con.iframe=f;
  showConsole();
  addEvent('ok','Консоль открыта'+(s?(' · '+(s.name||s.host)):'')+(j.width?(' · экран '+j.width+'×'+j.height):''));
  snack('Консоль открыта в noVNC');
}

// закрытие консоли сервера: только вручную; разрывает сессию (iRMC, 0xd8)
async function disconnectConsole(id){
  const con=conOf(id); if(!con)return;
  if(con.token){
    try{ await fetch('/api/disconnect',{method:'POST',headers:sessionHeaders({'Content-Type':'application/json'}),body:JSON.stringify({token:con.token})}); }catch{}
  }
  if(con.iframe){ try{ con.iframe.remove(); }catch{} }
  con.iframe=null; con.token=null; con.connected=false;
  const s=servers.find(x=>x.id===id);
  addEvent('info','Консоль закрыта'+(s?(' · '+(s.name||s.host)):''));
  snack('Консоль закрыта');
  if(id===sel)showConsole();
}

// ---- кнопки KVM-тулбара --------------------------------------------------
// Ctrl/Alt — «залипающие» модификаторы (подсветка), Del/Esc — тап клавиши
// вместе с залипшими модификаторами. Ввод уходит через POST /api/keys в
// живую сессию iRMC (HID-коды, как в RFB-мосте).
const HID={ctrl:224,alt:226,del:76,esc:41};
function sendKeys(steps){
  return fetch('/api/keys',{method:'POST',headers:sessionHeaders({'Content-Type':'application/json'}),body:JSON.stringify({token:curToken(),steps})});
}
async function tapKey(code){
  const stuck=[...document.querySelectorAll('.kvm-tool .kbtn.toggled')].map(b=>HID[b.getAttribute('data-k')]);
  const steps=[];
  for(const c of stuck)steps.push({c,d:true});
  steps.push({c:code,d:true,wait:60},{c:code,d:false});
  for(const c of stuck)steps.push({c,d:false});
  document.querySelectorAll('.kvm-tool .kbtn.toggled').forEach(b=>b.classList.remove('toggled'));
  try{ await sendKeys(steps); }catch{ snack('Не удалось отправить клавиши'); }
}
document.querySelectorAll('.kvm-tool .kbtn[data-k]').forEach(b=>{
  b.onclick=async()=>{
    if(!curToken()){ snack('Консоль не подключена'); return; }
    const k=b.getAttribute('data-k');
    if(k==='ctrl'||k==='alt'){ b.classList.toggle('toggled'); return; }
    await tapKey(HID[k]);
  };
});
$('disconnBtn').onclick=()=>{ const c=curCon(); if(c&&c.connected) disconnectConsole(sel); else if(sel) connectConsole(sel,0); };
$('fsBtn').onclick=()=>{
  const el=(tab==='console')?$('cvwrap2'):$('cvwrap');
  try{ if(document.fullscreenElement)document.exitFullscreen(); else el.requestFullscreen(); }
  catch{ snack('Полный экран недоступен'); }
};
$('shotBtn').onclick=async()=>{
  const token=curToken();
  if(!token){ snack('Нет активной сессии'); return; }
  snack('Снимок…');
  try{
    const r=await fetch('/api/snapshot/'+encodeURIComponent(token),{headers:sessionHeaders()});
    const j=await r.json();
    if(j.ok && j.png){
      const img=new Image(); img.onload=()=>{ const c=$('cv'); if(c.width!==j.width){c.width=j.width;c.height=j.height;} c.getContext('2d').drawImage(img,0,0); };
      img.src=j.png; snack('Снимок '+j.width+'×'+j.height+(j.saved?(' → '+j.saved):''));
    } else snack('Снимок: '+(j.error||'нет кадра'));
  }catch(e){ snack('Ошибка снимка: '+String(e&&e.message||e)); }
};
