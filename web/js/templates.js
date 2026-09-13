// Вкладка «Шаблоны»: каталог модулей платформ (server/platforms/*).
// Компактный список с ГРУППИРОВКОЙ ПО ВЕНДОРУ и аккордеоном: детали и
// подключённые серверы показываются по клику. Данные — /api/platforms.
let tplModules=null, tplUnmatched=[], tplLoaded=false;
const tplServersByModule={};   // moduleId -> [servers]
const tplExpanded=new Set();   // раскрытые id шаблонов
let tplQuery='';

function tplStatusBadge(st){
  const c = st==='verified' ? '#1f9d55' : (st==='experimental' ? '#b7791f' : '#8a94a6');
  const bg = st==='verified' ? '#e6f6ec' : (st==='experimental' ? '#fdf3e2' : '#eef1f6');
  return '<span style="font-size:11px;padding:1px 7px;border-radius:10px;background:'+bg+';color:'+c+'">'+esc(st||'—')+'</span>';
}
function tplChips(p){
  const out=[];
  if(p.capabilities&&p.capabilities.kvm)out.push('<span style="font-size:11px;padding:1px 7px;border-radius:10px;background:#eef1f6;color:#4a5568">KVM</span>');
  const vm=(p.capabilities&&p.capabilities.virtualMedia)||[];
  if(vm.length)out.push('<span style="font-size:11px;padding:1px 7px;border-radius:10px;background:#eef1f6;color:#4a5568">'+esc(vm.join('/'))+'</span>');
  if(p.capabilities&&p.capabilities.ipmi)out.push('<span style="font-size:11px;padding:1px 7px;border-radius:10px;background:#eef1f6;color:#4a5568">IPMI</span>');
  return out.join(' ');
}
function tplAccess(p){
  const a=p.access||{};
  const ports=(a.web&&(a.web.ports||[]).map((pt,i)=>(a.web.secure&&a.web.secure[i]?'https':'http')+':'+pt).join(', '))||'—';
  return { web: ports, login: a.login||'—',
           kvm: (a.kvm&&a.kvm.transport)||'—', media: (a.media&&a.media.transport)||'—' };
}
function tplCapList(p){
  const items=[];
  items.push('KVM: '+(p.capabilities&&p.capabilities.kvm?'да':'—'));
  const vm=(p.capabilities&&p.capabilities.virtualMedia)||[];
  items.push('Носители: '+(vm.length?vm.join('/'):'—'));
  const ip=(p.capabilities&&p.capabilities.ipmi)||{};
  const ipOn=Object.keys(ip).filter(k=>ip[k]);
  items.push('IPMI: '+(ipOn.length?ipOn.join('/'):'—'));
  const inv=(p.capabilities&&p.capabilities.inventory)||{};
  const invOn=Object.keys(inv).filter(k=>inv[k]);
  if(invOn.length)items.push('Инвентарь: '+invOn.join('/'));
  return items;
}
function tplEngineBadge(p){
  return p.loaded
    ? '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#e6f0ff;color:#2b6cb0">движок</span>'
    : '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#eef1f6;color:#8a94a6">только проба</span>';
}
function tplRowHtml(p){
  const open=tplExpanded.has(p.id);
  const nSrv=(tplServersByModule[p.id]||[]).length;
  const nSup=(p.supported||[]).length;
  return '<div class="tpl-item" style="margin-bottom:6px">'
    + '<div class="tpl-head" data-tpl="'+esc(p.id)+'" style="display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;border:1px solid var(--line,#e3e7ee);border-radius:8px;background:#fff">'
    +   '<span style="width:10px;color:var(--faint);transform:rotate('+(open?'90':'0')+'deg);transition:transform .15s">▸</span>'
    +   '<b style="font-size:14px">'+esc(p.title)+'</b>'
    +   '<span style="color:var(--faint);font-size:12px">'+esc(p.id)+'</span>'
    +   '<span style="flex:1"></span>'
    +   tplChips(p)
    +   '<span style="color:var(--faint);font-size:12px">моделей: '+nSup+' · серверов: '+nSrv+'</span>'
    +   tplEngineBadge(p)
    + '</div>'
    + (open ? '<div style="border:1px solid var(--line,#e3e7ee);border-top:none;border-radius:0 0 8px 8px;padding:12px;background:#fafbfd">'+tplDetailsHtml(p)+'</div>' : '')
    + '</div>';
}
function tplDetailsHtml(p){
  const acc=tplAccess(p);
  const caps=tplCapList(p);
  const sup=(p.supported||[]).map(s=>'<div style="display:flex;gap:8px;align-items:center;margin:2px 0"><b style="min-width:130px">'+esc(s.model)+'</b><span style="color:var(--faint)">fw '+esc(s.firmware)+'</span>'+tplStatusBadge(s.status)+'</div>').join('')||'<span style="color:var(--faint)">—</span>';
  const srv=(tplServersByModule[p.id]||[]);
  const srvHtml=srv.length
    ? srv.map(s=>'<div>'+esc(s.name)+' <span style="color:var(--faint)">'+esc(s.host)+':'+esc(s.port)+(s.secure?' tls':'')+'</span></div>').join('')
    : '<span style="color:var(--faint)">нет подключённых серверов</span>';
  return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;font-size:12.5px">'
    + '<div><div style="color:var(--faint);margin-bottom:3px">Поддерживаемые модели и прошивки</div>'+sup+'</div>'
    + '<div><div style="color:var(--faint);margin-bottom:3px">Возможности</div>'+caps.map(x=>'<div>'+esc(x)+'</div>').join('')+'</div>'
    + '<div><div style="color:var(--faint);margin-bottom:3px">Доступ</div><div>web: '+esc(acc.web)+'</div><div>вход: '+esc(acc.login)+'</div><div>kvm: '+esc(acc.kvm)+'</div><div>носитель: '+esc(acc.media)+'</div></div>'
    + '<div><div style="color:var(--faint);margin-bottom:3px">Прочее</div><div>sdk '+esc(p.sdk)+' · приоритет '+esc(p.priority)+' · пробы: '+esc((p.probes||[]).join(', ')||'—')+'</div><div style="color:var(--faint);margin-top:4px">Папка: platforms/'+esc(p.dir)+'</div></div>'
    + '<div style="grid-column:1 / -1"><div style="color:var(--faint);margin-bottom:3px">Подключённые серверы</div>'+srvHtml+'</div>'
    + '</div>';
}
function tplGroupByVendor(mods){
  const groups=new Map();
  for(const p of mods){
    const key=p.vendor||'Прочие';
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(p);
  }
  return [...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
}
function renderTplModules(mods){
  const box=$('tplList');
  const q=tplQuery.trim().toLowerCase();
  const filtered=(mods||[]).filter(p=>!q
    || (p.title||'').toLowerCase().includes(q)
    || (p.id||'').toLowerCase().includes(q)
    || (p.vendor||'').toLowerCase().includes(q)
    || (p.family||'').toLowerCase().includes(q)
    || (p.supported||[]).some(s=>String(s.model||'').toLowerCase().includes(q)));
  if(!filtered.length){ box.innerHTML='<div class="ov-empty">'+(q?'Ничего не найдено':'Модулей нет')+'</div>'; return; }
  let html='';
  for(const [vendor,list] of tplGroupByVendor(filtered)){
    html+='<div style="display:flex;align-items:center;gap:10px;margin:14px 2px 6px"><b style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--faint)">'+esc(vendor)+'</b>'
      + '<span class="count-pill">'+list.length+'</span><div style="flex:1;height:1px;background:var(--line,#e3e7ee)"></div></div>';
    html+=list.map(tplRowHtml).join('');
  }
  const un=(tplUnmatched||[]);
  if(un.length && !q){
    const open=tplExpanded.has('__unmatched__');
    html+='<div style="display:flex;align-items:center;gap:10px;margin:14px 2px 6px"><b style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--faint)">Серверы без шаблона</b><div style="flex:1;height:1px;background:var(--line,#e3e7ee)"></div></div>';
    html+='<div><div class="tpl-head" data-tpl="__unmatched__" style="display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;border:1px solid var(--line,#e3e7ee);border-radius:8px;background:#fff"><span style="width:10px;color:var(--faint);transform:rotate('+(open?'90':'0')+'deg)">▸</span><b style="font-size:14px">Не определены</b><span style="flex:1"></span><span style="color:var(--faint);font-size:12px">'+un.length+'</span></div>'
      + (open?'<div style="border:1px solid var(--line,#e3e7ee);border-top:none;border-radius:0 0 8px 8px;padding:12px;background:#fafbfd">'+un.map(s=>'<div>'+esc(s.name)+' <span style="color:var(--faint)">'+esc(s.host)+':'+esc(s.port)+'</span></div>').join('')+'</div>':'')
    + '</div>';
  }
  box.innerHTML=html;
}
async function loadTemplates(force){
  if(tplLoaded&&!force)return;
  const res=await api('/api/platforms',{_noKick:true});
  if(!(res&&res.ok&&Array.isArray(res.modules))){ $('tplList').innerHTML='<div class="ov-empty">Не удалось загрузить модули</div>'; return; }
  tplModules=res.modules; $('tplCount').textContent=res.modules.length;
  const srv=await api('/api/platforms/servers',{_noKick:true});
  Object.keys(tplServersByModule).forEach(k=>delete tplServersByModule[k]);
  const ids=new Set(res.modules.map(m=>m.id));
  tplUnmatched=[];
  if(srv&&srv.ok&&Array.isArray(srv.servers)){
    for(const s of srv.servers){
      if(s.moduleId&&ids.has(s.moduleId)){ (tplServersByModule[s.moduleId]=tplServersByModule[s.moduleId]||[]).push(s); }
      else tplUnmatched.push(s);
    }
  }
  tplLoaded=true;
  renderTplModules(tplModules);
}
// делегирование: клик по строке-заголовку раскрывает/сворачивает шаблон
$('tplList').addEventListener('click',(e)=>{
  const h=e.target.closest('.tpl-head'); if(!h||!tplModules)return;
  const id=h.getAttribute('data-tpl');
  if(tplExpanded.has(id))tplExpanded.delete(id); else tplExpanded.add(id);
  renderTplModules(tplModules);
});
$('tplSearch').oninput=(e)=>{ tplQuery=e.target.value||''; if(tplModules)renderTplModules(tplModules); };
$('tplExpandAll').onclick=()=>{
  if(!tplModules)return;
  const all=(tplModules||[]).map(m=>m.id);
  const expand=all.some(id=>!tplExpanded.has(id));
  all.forEach(id=>expand?tplExpanded.add(id):tplExpanded.delete(id));
  if(expand)tplExpanded.add('__unmatched__'); else tplExpanded.delete('__unmatched__');
  $('tplExpandAll').textContent=expand?'Свернуть всё':'Развернуть всё';
  renderTplModules(tplModules);
};
$('tplRefreshBtn').onclick=()=>{tplLoaded=false;loadTemplates(true);};
