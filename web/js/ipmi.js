function hotCls(v){ return v>=45 ? ' class="hot"' : ''; }
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
