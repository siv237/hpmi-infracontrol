function hotCls(v){ return v>=45 ? ' class="hot"' : ''; }
// ---- карточки-метрики с историей (вкладка «Обзор» сервера) ----------------
// Данные: GET /api/ipmi/metrics?serverId= — ряды temps/fans/response_ms из
// SQLite (интервальный опрос 60с) + lastValues. Графики — мини-спарклайны.
async function loadMetrics(id){
  if(!id)return;
  const porig=id;
  const j=await api('/api/ipmi/metrics?serverId='+encodeURIComponent(id)+'&window=86400',{_noKick:true});
  if(id!==sel||!j||!j.ok)return;
  const lv=j.lastValues||{};
  const lvOf=(k)=>{const m=lv[k];return (m&&m.value!==undefined)?m.value:null;};
  // Температура: среднее по CPU-сенсорам из lastValues, история — avgSeries
  const cpuTemps=Object.keys(lv).filter(k=>k.startsWith('temp:')&&/^cpu/i.test(k.slice(5)));
  let tVal=null;
  if(cpuTemps.length){ tVal=cpuTemps.reduce((a,k)=>a+(lv[k].value||0),0)/cpuTemps.length; }
  else { const any=Object.keys(lv).filter(k=>k.startsWith('temp:')); if(any.length)tVal=any.reduce((a,k)=>a+(lv[k].value||0),0)/any.length; }
  const tLast=(j.temps&&j.temps.length)?j.temps[j.temps.length-1][1]:null;
  const temp=tVal!==null?tVal:(tLast!==null?tLast:null);
  setMetric('mTemp',temp!==null?(Math.round(temp*10)/10+'°C'):'—',tempChart(j.temps),'#e23a3a',temp>=45);
  setMetricSub('mTempSub',cpuTemps.length?('CPU ×'+cpuTemps.length+', среднее'):(j.temps&&j.temps.length?'все сенсоры, среднее':'нет данных'));
  // Вентиляция: среднее RPM
  const fanKeys=Object.keys(lv).filter(k=>k.startsWith('fan:'));
  const fVal=fanKeys.length?fanKeys.reduce((a,k)=>a+(lv[k].value||0),0)/fanKeys.length:null;
  const fLast=(j.fans&&j.fans.length)?j.fans[j.fans.length-1][1]:null;
  const fan=fVal!==null?fVal:fLast;
  setMetric('mFan',fan!==null?(Math.round(fan)+' RPM'):'—',fanChart(j.fans),'#2f6bff',false);
  setMetricSub('mFanSub',fanKeys.length?('кулеры ×'+fanKeys.length+', среднее'):(j.fans&&j.fans.length?'среднее':'нет данных'));
  // Отклик IPMI: последний response_ms + ряд
  const rVal=lvOf('response_ms');
  const rLast=(j.response_ms&&j.response_ms.length)?j.response_ms[j.response_ms.length-1][1]:null;
  const resp=rVal!==null?rVal:rLast;
  setMetric('mResp',resp!==null?(Math.round(resp)+' мс'):'—',respChart(j.response_ms),'#e79a2b',false);
  setMetricSub('mRespSub','опрос IPMI-LAN');
  // Доступность: % успешных ping за окно + ряд по точкам
  if(j.availPct!==null&&j.availPct!==undefined){
    const pingRows=(j.ping||[]).map(r=>[r[0],r[1]*100]);
    setMetric('mAvail',j.availPct+'%',avChart(pingRows),'#1aa05a',j.availPct<99);
    setMetricSub('mAvailSub',(j.ping&&j.ping.length)?((j.ping.length)+' опросов, за 24 ч'):'нет данных');
  } else {
    setMetric('mAvail','—',null,'#1aa05a',false);
    setMetricSub('mAvailSub','нет данных');
  }
}
function setMetric(id,txt,draw,color,warn){
  const el=$(id); if(!el)return;
  el.textContent=txt;
  el.className='val'+(warn?' warnhot':'');
  el.style.color=warn?'#e23a3a':'';
  const cv=$(id+'Chart'); if(!cv)return;
  clearChart(cv);
  if(draw)draw(cv,color);
}
function setMetricSub(id,txt){ const el=$(id); if(el)el.textContent=txt; }
// Мини-спарклайн: заливка + линия. rows: [[ts,value],...] | [[ts,value,n]]
function drawSpark(cv,rows,color){
  if(!cv||!rows||rows.length<2)return false;
  // прореживание до ~120 точек (данных за 24ч ~1000, канвас этого не требует)
  if(rows.length>120){
    const step=rows.length/120, out=[];
    for(let i=0;i<120;i++)out.push(rows[Math.floor(i*step)]);
    out.push(rows[rows.length-1]);
    rows=out;
  }
  const dpr=window.devicePixelRatio||1, W=cv.clientWidth||180, H=cv.clientHeight||38;
  cv.width=W*dpr; cv.height=H*dpr;
  const x=cv.getContext('2d'); x.scale(dpr,dpr);
  const vals=rows.map(r=>r[1]);
  let mn=Math.min.apply(null,vals), mx=Math.max.apply(null,vals);
  if(mx===mn){mx=mn+1;}
  const pad=3, iw=W-pad*2, ih=H-pad*2;
  const pts=rows.map((r,i)=>({x:pad+iw*(rows.length===1?0.5:i/(rows.length-1)),y:pad+ih*(1-(r[1]-mn)/(mx-mn))}));
  x.beginPath(); x.moveTo(pts[0].x,pad+ih); pts.forEach(p=>x.lineTo(p.x,p.y));
  x.lineTo(pts[pts.length-1].x,pad+ih); x.closePath();
  const g=x.createLinearGradient(0,pad,0,pad+ih);
  g.addColorStop(0,color+'44'); g.addColorStop(1,color+'05');
  x.fillStyle=g; x.fill();
  x.beginPath(); pts.forEach((p,i)=>i?x.lineTo(p.x,p.y):x.moveTo(p.x,p.y));
  x.strokeStyle=color; x.lineWidth=1.6; x.lineJoin='round'; x.lineCap='round'; x.stroke();
  return true;
}
function clearChart(cv){ if(!cv)return; const dpr=window.devicePixelRatio||1; cv.width=(cv.clientWidth||180)*dpr; cv.height=(cv.clientHeight||38)*dpr; const x=cv.getContext('2d'); x.clearRect(0,0,cv.width,cv.height); cv.classList.add('mempty'); }
function tempChart(rows){ return (cv)=>{ if(drawSpark(cv,rows,'#e23a3a'))cv.classList.remove('mempty'); }; }
function fanChart(rows){ return (cv)=>{ if(drawSpark(cv,rows,'#2f6bff'))cv.classList.remove('mempty'); }; }
function respChart(rows){ return (cv)=>{ if(drawSpark(cv,rows,'#e79a2b'))cv.classList.remove('mempty'); }; }
function avChart(rows){ return (cv)=>{ if(drawSpark(cv,rows.map(r=>[r.ts,r.pct===null?0:r.pct]),'#1aa05a'))cv.classList.remove('mempty'); }; }
// Таблица сенсоров (вкладка «Состояние»); IPMI-LAN (UDP), KVM не трогает.
async function loadSensors(id){
  if(!id)return;
  const porig=id;
  const sn=$('snTable'), snInfo=$('snInfo');
  const j=await api('/api/ipmi/sensors?serverId='+encodeURIComponent(id),{_noKick:true});
  if(id!==sel)return;
  if(!j||!j.ok||!(j.temps||j.fans)){
    const msg='нет данных опроса'+(j&&j.error?(' ('+esc(j.error)+')'):'');
    if(snInfo)snInfo.textContent=msg;
    if(sn)sn.innerHTML='<tr><td class="v">—</td></tr>';
    return;
  }
  const when=j.ts?('· обновлено '+fmtDump(new Date(j.ts).toISOString())):'';
  if(snInfo)snInfo.textContent=when+(j.error?(' · '+esc(j.error)):'');
  if(sn){
    let h='<tr><td class="k">Тип</td><td class="k">Сенсор</td><td class="v">Значение</td></tr>';
    for(const t of j.temps) h+='<tr><td>Темп</td><td>'+esc(t.name)+'</td><td><b'+hotCls(t.value)+'>'+t.value+'</b> °C</td></tr>';
    for(const f of j.fans) h+='<tr><td>Кулер</td><td>'+esc(f.name)+'</td><td>'+f.value+' RPM</td></tr>';
    sn.innerHTML=h;
  }
}
