// ---- список серверов -----------------------------------------------------
async function load(){
  const j=await api('/api/servers');
  servers=j.servers||[];
  $('servCount').textContent=servers.length;
  renderTree();
}
function treeFilter(){return ($('treeSearch').value||'').trim().toLowerCase();}
// филиал = первые два октета IPv4 (обезличенные имена, реальные данные);
// не-IP адреса попадают в «Филиал прочие»
function branchKey(host){
  const m=/^(\d{1,3})\.(\d{1,3})\./.exec(String(host||'').trim());
  return m?m[1]+'.'+m[2]:'other';
}
let expanded={};           // 'root' | 'b:<ключ филиала>' -> открыто?
let rootName='Все серверы'; // имя корня дерева — из локального data/ui.json (вне git)
async function loadUiConfig(){
  try{ const j=await api('/api/ui',{_noKick:true}); if(j&&j.rootName)rootName=j.rootName; }catch{}
}
function loadExpanded(){ try{ expanded=JSON.parse(localStorage.getItem('ui.tree.expanded')||'{}')||{}; }catch{ expanded={}; } }
function saveExpanded(){ try{ localStorage.setItem('ui.tree.expanded',JSON.stringify(expanded)); }catch{} }
const CHEV='<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
function renderTree(){
  const q=treeFilter();
  const tree=$('tree');
  if(!servers.length){tree.innerHTML='<div class="tree-empty">Серверы не добавлены.'+(isAdmin()?'<br>Нажмите «Добавить».':'')+'</div>';return;}
  const matched=servers.filter(s=>!q||(s.name||'').toLowerCase().includes(q)||(s.host||'').toLowerCase().includes(q));
  // корень дерева (имя — локальный конфиг) -> филиалы по двум октетам IP
  const groups=new Map();
  matched.forEach(s=>{const k=branchKey(s.host);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(s);});
  const keys=[...groups.keys()].sort((a,b)=>{
    if(a==='other')return 1; if(b==='other')return -1;
    const A=a.split('.').map(Number),B=b.split('.').map(Number);
    return (A[0]-B[0])||(A[1]-B[1]);
  });
  const searching=!!q;
  let html='';
  const rootOpen=searching||expanded['root']!==false;
  html+='<div class="tnode folder root'+(rootOpen?' open':'')+'" data-f="root">'+CHEV+'<span class="fld">'+esc(rootName)+'</span><span class="cnt">'+matched.length+'</span></div>';
  if(rootOpen){
    for(const k of keys){
      const arr=groups.get(k);
      const name=k==='other'?'Филиал прочие':'Филиал '+k;
      const open=searching||expanded['b:'+k]!==false;
      html+='<div class="tnode folder sub'+(open?' open':'')+'" data-f="b:'+k+'">'+CHEV+'<span class="fld">'+esc(name)+'</span><span class="cnt">'+arr.length+'</span></div>';
      if(open){
        for(const s of arr){
          const st=dbgStatus[s.id]||'off';
          const stLabel=st==='on'?'Онлайн':st==='err'?'Недоступен':'Нет данных';
          const cls=s.id===sel?' sel':'';
          html+='<div class="tnode leaf sub'+cls+'" data-id="'+s.id+'">'
            +'<span class="st '+st+'"></span><span class="nm">'+esc(s.name||s.host)+'</span>'
            +'<span class="nst '+st+'">'+stLabel+'</span>'
            +(isAdmin()?'<button class="del" title="Удалить">✕</button>':'')
            +'</div>';
        }
      }
    }
  }
  tree.innerHTML=html;
  tree.querySelectorAll('.tnode.folder').forEach(n=>{
    n.onclick=()=>{
      const k=n.getAttribute('data-f');
      expanded[k]=expanded[k]===false?true:false;
      saveExpanded(); renderTree();
    };
  });
  tree.querySelectorAll('.tnode.leaf').forEach(n=>{
    const del=n.querySelector('.del');
    if(del)del.onclick=async(e)=>{e.stopPropagation(); await delServer(n.getAttribute('data-id'));};
    n.onclick=()=>select(n.getAttribute('data-id'));
  });
}
async function delServer(id){
  if(!isAdmin()){snack('Только администратор может удалять серверы');return;}
  const s=servers.find(x=>x.id===id);
  if(!confirm('Удалить сервер «'+(s?(s.name||s.host):id)+'»?'))return;
  const j=await api('/api/servers/'+encodeURIComponent(id),{method:'DELETE'});
  if(j.okResp===false)return;
  addEvent('info','Сервер удалён'+(s?(' · '+(s.name||s.host)):''));
  if(consoles[id])disconnectConsole(id); // закрыть и консоль удалённого
  if(sel===id){sel=null;hideDetail();}
  await load();
}
