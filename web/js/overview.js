// ---- дашборд «Обзор» (п.1): по макету InfraControl -----------------------
let ovTimer=null, ovList=[];
function stChip(st){
  const cls=st==='on'?'on':(st==='off'?'bad':'gray');
  const txt=st==='on'?'Онлайн':(st==='off'?'Оффлайн':'Нет данных');
  return '<span class="stchip '+cls+'"><span class="dot"></span>'+txt+'</span>';
}
// График доступности за окно — area-кривая (почасовые бакеты) на canvas
function drawAvailabilityChart(av){
  const c=$('ovAvail'); if(!c)return;
  const badge=$('ovAvailBadge'), axis=$('ovAvailAxis');
  const dpr=window.devicePixelRatio||1, W=c.clientWidth||600, H=150;
  c.width=W*dpr; c.height=H*dpr; c.style.height=H+'px';
  const x=c.getContext('2d'); x.scale(dpr,dpr); x.clearRect(0,0,W,H);
  const blank=()=>{ if(badge)badge.textContent='н/д'; if(axis)axis.innerHTML='';
    x.fillStyle='#9aa3b2'; x.font='12px system-ui'; x.textAlign='center'; x.textAlign='center'; x.fillText('Нет данных мониторинга доступности',W/2,H/2); };
  if(!av||!av.buckets||!av.buckets.length){ blank(); return; }
  const avg=av.avgPct;
  if(badge){ badge.textContent=(avg===null?'н/д':avg+'%'); badge.classList.toggle('low',avg!==null&&avg<99); }
  const pad={l:34,r:10,t:8,b:16};
  const iw=W-pad.l-pad.r, ih=H-pad.t-pad.b;
  const b=av.buckets;
  const pts=b.map((bk,i)=>({ x:pad.l+iw*(b.length===1?0.5:i/(b.length-1)), y:pad.t+ih*(1-(bk.pct===null?0:Math.max(0,Math.min(100,bk.pct))/100)) }));
  // сетка 0/50/100
  x.strokeStyle='#e8ebf2'; x.fillStyle='#9aa3b2'; x.font='10px system-ui'; x.textAlign='right';
  [0,50,100].forEach(p=>{ const y=pad.t+ih*(1-p/100); x.beginPath(); x.moveTo(pad.l,y); x.lineTo(W-pad.r,y); x.stroke(); x.fillText(p+'%',pad.l-5,y+3); });
  // заливка под кривой
  x.beginPath(); x.moveTo(pts[0].x, pad.t+ih);
  pts.forEach(p=>x.lineTo(p.x,p.y));
  x.lineTo(pts[pts.length-1].x, pad.t+ih); x.closePath();
  const g=x.createLinearGradient(0,pad.t,0,pad.t+ih);
  g.addColorStop(0,'rgba(46,165,109,.30)'); g.addColorStop(1,'rgba(46,165,109,.03)');
  x.fillStyle=g; x.fill();
  // линия
  x.beginPath(); pts.forEach((p,i)=> i?x.lineTo(p.x,p.y):x.moveTo(p.x,p.y));
  x.strokeStyle='#2ea56d'; x.lineWidth=2; x.lineJoin='round'; x.lineCap='round'; x.stroke();
  const first=new Date(b[0].ts), last=new Date(b[b.length-1].ts);
  if(axis)axis.innerHTML='<span>'+first.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+'</span><span>сейчас</span>';
}
async function loadOverview(){
  const j=await api('/api/overview',{_noKick:true});
  const s=j&&j.ok&&j.summary?j.summary:{};
  const total=s.total||0, on=s.on||0, off=s.off||0, none=s.none||0;
  const warn=none; // «требуют внимания» = снимков нет (статус неизвестен)
  $('ovTotal').textContent=total;
  $('ovUp').textContent=on;
  $('ovUpPct').textContent=total?Math.round(on/total*100)+'%':'—';
  $('ovUpBar').style.width=(total?on/total*100:0)+'%';
  $('ovWarn').textContent=warn;
  $('ovWarnPct').textContent=total?'1 из '+total:'—';
  $('ovWarnBar').style.width=(total?warn/total*100:0)+'%';
  $('ovDown').textContent=off;
  $('ovDownPct').textContent=total?'1 из '+total:'—';
  $('ovDownBar').style.width=(total?off/total*100:0)+'%';
  const pOn=total?on/total*100:0, pWa=total?warn/total*100:0;
  $('ovDonut').style.setProperty('--p-on',pOn+'%');
  $('ovDonut').style.setProperty('--p-wa',(pOn+pWa)+'%');
  $('ovDonutN').textContent=total;
  $('ovLegend').innerHTML=[
    ['#188a4c','Онлайн',on,total?Math.round(on/total*100)+'%':'—'],
    ['var(--amber)','Предупреждения',warn,total?Math.round(warn/total*100)+'%':'—'],
    ['#e23a3a','Оффлайн',off,total?Math.round(off/total*100)+'%':'—'],
  ].map(x=>'<div class="li"><span class="dot" style="background:'+x[0]+'"></span><span>'+x[1]+'</span><span class="p">'+x[3]+'</span><span class="n">'+x[2]+'</span></div>').join('');
  drawAvailabilityChart(j.availability||null);
  // CSV температуры по серверам — берём из сенсоров
  const sres=await api('/api/ipmi/sensors',{_noKick:true});
  const sensors=(sres&&sres.sensors)||{};
  const list=(j.servers||[]).map(r=>{
    const sen=sensors[r.id];
    let temp='—', maxT=null;
    if(sen&&!sen.error&&(sen.temps||[]).length){
      const cpu=(sen.temps||[]).filter(t=>/^CPU/i.test(t.name));
      const group=cpu.length?cpu:(sen.temps||[]);
      maxT=Math.max.apply(null,group.map(t=>t.value));
      temp=group.length?group.map(t=>esc(t.name)+'='+t.value+'°C').join(', '):'—';
    }
    return {...r,_temp:temp,_maxT:maxT};
  });
  ovList=list;
  renderOverviewRows(list);
  // последние проверки: серверы отсортированы по времени снимка/опроса
  const checks=list.slice().sort((a,b)=>new Date(b.lastCheck||0)-new Date(a.lastCheck||0)).slice(0,12);
  $('ovChecks').innerHTML=checks.length?checks.map(r=>{
    const st=r.status==='on'?'#188a4c':(r.status==='off'?'#e23a3a':'#98a1b0');
    return '<div class="chk"><span class="st" style="background:'+st+'"></span><span class="nm">'+esc(r.name||r.host)+'</span><span class="ip">'+esc(r.host)+'</span><span class="t">'+(r.lastCheck?fmtDump(new Date(r.lastCheck)):'—')+'</span></div>';
  }).join(''):'<div class="ov-empty">Серверы не добавлены</div>';
  // статистика по группам
  const gmap={};
  list.forEach(r=>{const g=r.group||'Без группы';const o=gmap[g]=gmap[g]||{t:0,on:0};o.t++;if(r.status==='on')o.on++;});
  const gm=Object.entries(gmap).sort((a,b)=>b[1].t-a[1].t);
  $('ovGroups').innerHTML=gm.length?gm.map(([g,o])=>{
    const pct=o.t?Math.round(o.on/o.t*100):0;
    const col=o.on===o.t?'#188a4c':(o.on?'#2ea56d':(o.on===0?'#e23a3a':'#e2a13c'));
    return '<div class="g"><span class="nm">'+esc(g)+'</span><span class="bar"><i style="width:'+pct+'%;background:'+col+'"></i></span><span class="v">'+o.on+'/'+o.t+'</span></div>';
  }).join(''):'<div class="ov-empty">Нет групп</div>';
  buildGroupFilter(list);
}
let ovPage=1; const OV_PAGE=10;
function renderOverviewRows(list){
  const q=($('ovSearch')&&$('ovSearch').value||'').toLowerCase().trim();
  const gf=$('ovGroupF')&&$('ovGroupF').value||'';
  const sf=$('ovStatusF')&&$('ovStatusF').value||'';
  const rows=list.filter(r=>{
    if(gf && (r.group||'Без группы')!==gf)return false;
    if(sf && (r.status||'none')!==sf)return false;
    if(q && !((r.name||r.host||'').toLowerCase().includes(q)||(r.host||'').toLowerCase().includes(q)||(r.group||'').toLowerCase().includes(q)))return false;
    return true;
  });
  const pages=Math.max(1,Math.ceil(rows.length/OV_PAGE));
  if(ovPage>pages)ovPage=pages;
  const from=(ovPage-1)*OV_PAGE, to=Math.min(rows.length,from+OV_PAGE);
  const slice=rows.slice(from,to);
  $('ovRows').innerHTML=slice.length?slice.map(r=>{
    let state='—';
    if(r._maxT!==null)state='<span class="bar-t"><i style="width:'+Math.min(100,(r._maxT-20)*2)+'%"></i></span> '+(r._maxT>=45?'<b style="color:var(--red)">'+r._maxT+'°C</b>':'<b>'+r._maxT+'°C</b>');
    return '<tr><td><input type="checkbox" class="ck"></td>'
      +'<td><span class="srv-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></svg></span><span class="nm">'+esc(r.name||r.host)+'</span></td>'
      +'<td>'+esc(r.host)+'</td>'
      +'<td>'+stChip(r.status)+'</td>'
      +'<td>'+state+'</td>'
      +'<td>'+(r._temp!=='—'?r._temp:'—')+'</td>'
      +'<td class="hostcell">'+esc(r.group||'Без группы')+'</td>'
      +'<td>'+(r.lastCheck?fmtDump(new Date(r.lastCheck)):'—')+'</td></tr>';
  }).join(''):'<tr><td colspan="8" class="ov-empty">Серверы не добавлены</td></tr>';
  // пагинация
  const rng=$('ovRange'), pgs=$('ovPages');
  if(rng)rng.textContent='Показано '+from+'−'+to+' из '+rows.length;
  if(pgs){
    if(pages<=1){ pgs.innerHTML=''; }
    else {
      let html='';
      if(ovPage>1)html+='<span class="pg" data-p="'+(ovPage-1)+'">‹</span>';
      for(let p=1;p<=pages;p++){
        if(pages>7 && p>2 && p<pages-1 && Math.abs(p-ovPage)>1){ if(!html.endsWith('<span class="pg gap">…</span>'))html+='<span class="pg gap">…</span>'; continue; }
        html+='<span class="pg'+(p===ovPage?' cur':'')+'" data-p="'+p+'">'+p+'</span>';
      }
      if(ovPage<pages)html+='<span class="pg" data-p="'+(ovPage+1)+'">›</span>';
      pgs.innerHTML=html;
      pgs.querySelectorAll('.pg[data-p]').forEach(b=>b.onclick=()=>{ovPage=Number(b.getAttribute('data-p'));renderOverviewRows(ovList);});
    }
  }
}
function buildGroupFilter(list){
  const f=$('ovGroupF'); if(!f)return;
  const cur=f.value;
  const gs=[...new Set(list.map(r=>r.group||'Без группы'))];
  f.innerHTML='<option value="">Все группы</option>'+gs.map(g=>'<option value="'+esc(g)+'">'+esc(g)+'</option>').join('');
  f.value=gs.includes(cur)?cur:'';
}
function startOverview(){
  if(ovTimer)clearInterval(ovTimer);
  loadOverview();
  ovTimer=setInterval(loadOverview,30000);
}
// быстрые действия
document.querySelectorAll('#ovQA a').forEach(a=>{
  a.onclick=()=>{
    const act=a.getAttribute('data-action');
    if(act==='users'){ showPage('users'); document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.getAttribute('data-id')==='users')); }
    else snack('Раздел в разработке');
  };
});
$('ovSearch').oninput=()=>{ovPage=1;renderOverviewRows(ovList);};
$('ovGroupF').onchange=()=>{ovPage=1;renderOverviewRows(ovList);};
$('ovStatusF').onchange=()=>{ovPage=1;renderOverviewRows(ovList);};
