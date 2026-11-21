'use strict';
const $=id=>document.getElementById(id);
const config=window.RIVERSIDE_CONFIG||{};
const base=String(config.supabaseUrl||'').replace(/\/$/,'');
const key=String(config.supabaseKey||'');
function isPublicKey(value){
 if(value.startsWith('sb_publishable_'))return true;
 try{
  const payload=JSON.parse(atob(value.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
  return payload.role==='anon';
 }catch{return false;}
}
const configured=isPublicKey(key)&&!!base&&!!key&&(/^https:\/\//.test(base)||/^http:\/\/127\.0\.0\.1/.test(base))&&!key.startsWith('sb_secret_');
const sessionKey='riverside-session:'+base;
let session=null,refreshing=null,units=[],catalog=null,kind='apartment',draft=null,dirty=false,conflict=false,saving=false,tool='select',history=[],pendingMark=null,editingMark=null,currentHash='',pathPoints=null,activePointer=null;
const unitName=u=>(u.kind==='apartment'?'Стан ':'Паркинг ')+u.number;
const occupied=u=>u.status!=='available';
const statusName=s=>({available:'Слободен',reserved:'Резервиран',sold:'Продаден'}[s]);
const floorName=f=>f===0?'Приземје':f<0?'Паркинг':'Кат '+f;
function notify(text,target='globalMessage'){$(target).textContent=text;}
function setSession(value){
 session=value;
 try{if(value)sessionStorage.setItem(sessionKey,JSON.stringify(value));else sessionStorage.removeItem(sessionKey);}catch{}
}
async function authCall(path,body){
 const response=await fetch(base+'/auth/v1/'+path,{method:'POST',headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await response.json();
 if(!response.ok)throw Error(data.msg||data.error_description||data.message||'Неуспешна најава.');
 return data;
}
async function accessToken(){
 if(!session)throw Error('Најавете се повторно.');
 if((session.expires_at||0)*1000<Date.now()+60000){
  if(!refreshing)refreshing=authCall('token?grant_type=refresh_token',{refresh_token:session.refresh_token}).then(value=>{setSession(value);return value.access_token;}).catch(error=>{setSession(null);throw error;}).finally(()=>{refreshing=null;});
  return refreshing;
 }
 return session.access_token;
}
async function api(path,options={}){
 const token=await accessToken();
 const response=await fetch(base+'/rest/v1/'+path,{...options,headers:{apikey:key,Authorization:'Bearer '+token,'Content-Type':'application/json',...(options.headers||{})}});
 const raw=await response.text();let data;
 try{data=raw?JSON.parse(raw):null;}catch{throw Error('Базата врати неочекуван одговор. Обидете се повторно.');}
 if(!response.ok){
  if(response.status===401){setSession(null);throw Error('Сесијата истече. Најавете се повторно.');}
  throw Error(data?.message||'Неуспешно поврзување со базата.');
 }
 return data;
}
async function fetchUnits(){
 const list=await api('units?select=*&order=id');
 if(!Array.isArray(list)||!list.some(u=>u.kind==='apartment'))throw Error('Нема пристап до податоците. Проверете ги двете сметки во portal_members и почетниот увоз.');
 units=list.map(u=>({...u,area:Number(u.area),annotations:u.annotations||[]}));
}
async function openApp(){
 try{
  await fetchUnits();
  if(!catalog)catalog=await (await fetch('catalog.json')).json();
  $('loginView').hidden=true;$('appView').hidden=false;
  $('userLabel').textContent=session.user?.email||'';
  await route();
 }catch(error){notify(error.message,'loginMessage');$('loginView').hidden=false;$('appView').hidden=true;}
}
function renderMap(){
 $('buildingMap').replaceChildren();
 const term=$('search').value.trim().toLocaleLowerCase(),filter=$('statusFilter').value;
 const all=units.filter(u=>u.kind===kind);
 const shown=all.filter(u=>(filter==='all'||(filter==='available'?!occupied(u):occupied(u)))&&[String(u.number),u.owner,u.phone].some(x=>String(x||'').toLocaleLowerCase().includes(term)));
 $('summary').textContent=all.filter(u=>!occupied(u)).length+' слободни · '+all.filter(occupied).length+' продадени / резервирани';
 $('mapTitle').textContent=kind==='apartment'?'Сите станови.':'Паркинг-места.';
 const addTile=(u,root)=>{
  const a=document.createElement('a');a.href='#unit/'+u.id;a.className='unit-tile'+(occupied(u)?' occupied':'');a.setAttribute('aria-label',unitName(u)+', '+statusName(u.status));
  const n=document.createElement('span');n.className='number';n.textContent=String(u.number);
  const area=document.createElement('span');area.className='area';area.textContent=u.area.toLocaleString('mk-MK')+' м²';
  const owner=document.createElement('span');owner.className='owner';owner.textContent=u.owner||u.type;
  const status=document.createElement('span');status.className='status';status.textContent=occupied(u)?'Продаден / резервиран':'';
  a.append(n,area,owner,status);root.append(a);
 };
 if(kind==='apartment'){
  for(let floor=4;floor>=0;floor--){
   const members=shown.filter(u=>u.floor===floor);if(!members.length)continue;
   const group=document.createElement('section');group.className='floor';
   const label=document.createElement('div');label.className='floor-label';
   const name=document.createElement('strong');name.textContent=floor===0?'П':'0'+floor;
   label.append(name,document.createTextNode(floor===0?'Приземје':'Кат'));
   const grid=document.createElement('div');grid.className='floor-units';members.forEach(u=>addTile(u,grid));group.append(label,grid);$('buildingMap').append(group);
  }
 }else{const grid=document.createElement('div');grid.className='parking-grid';shown.forEach(u=>addTile(u,grid));$('buildingMap').append(grid);}
 if(!shown.length){const p=document.createElement('p');p.textContent='Нема резултати за избраниот филтер.';$('buildingMap').append(p);}
}
function setDirty(value=true){dirty=value;$('saveUnit').textContent=dirty?'Зачувај промени':'Зачувано';if(dirty)notify('Имате незачувани промени.','unitMessage');}
function readForm(){
 if(!draft)return;
 draft.status=$('unitStatus').value;draft.owner=$('unitOwner').value;draft.phone=$('unitPhone').value;draft.notes=$('unitNotes').value;
}
function openUnit(unit){
 draft=structuredClone(unit);dirty=false;conflict=false;history=[];tool='select';pathPoints=null;
 $('unitHeading').textContent=unitName(unit);$('unitMeta').textContent=floorName(unit.floor)+' · '+unit.type+' · '+unit.area.toLocaleString('mk-MK')+' м²';
 $('unitForm').querySelector('h2').textContent=unit.kind==='apartment'?'Податоци за станот':'Податоци за паркингот';
 $('unitStatus').value=unit.status;$('unitOwner').value=unit.owner;$('unitPhone').value=unit.phone;$('unitNotes').value=unit.notes;
 $('updatedLabel').textContent='Последна промена · '+new Date(unit.updated_at).toLocaleString('mk-MK');
 const meta=catalog.detail['s'+unit.number];
 $('planImage').src=unit.kind==='apartment'?'assets/plan-'+(meta+1)+'.webp':'assets/page-5.jpg';
 $('planImage').alt='Основа · '+unitName(unit);
 $('drawing').setAttribute('viewBox',unit.kind==='apartment'?'0 0 1000 1105':'0 0 1000 707');
 $('planStage').classList.remove('drawing-mode');
 $('saveUnit').disabled=false;$('saveUnit').textContent='Зачувај промени';$('reloadUnit').hidden=true;
 notify('','unitMessage');setTool('select');renderMarks();
}
async function route(){
 if(!session)return;
 if(saving){if(location.hash!==currentHash)location.hash=currentHash;return;}
 const target=location.hash;
 const match=target.match(/^#unit\/(\d+)$/);
 const targetId=match?Number(match[1]):null;
 if(dirty&&draft&&targetId!==draft.id&&!confirm('Имате незачувани промени. Да го напуштите станот?')){location.hash=currentHash;return;}
 currentHash=target;
 if(targetId){
  const unit=units.find(u=>u.id===targetId);if(!unit){notify('Станот не е пронајден.');location.hash='';return;}
  $('mapView').hidden=true;$('detailView').hidden=false;
  if(!draft||draft.id!==targetId||!dirty)openUnit(unit);
 }else{draft=null;dirty=false;$('mapView').hidden=false;$('detailView').hidden=true;renderMap();}
}
async function refresh(){
 if(saving)return;
 try{
  if(dirty&&!confirm('Да ги отфрлите незачуваните промени и да ја преземете последната верзија?'))return;
  await fetchUnits();dirty=false;if(draft)openUnit(units.find(u=>u.id===draft.id));else renderMap();notify('Податоците се освежени.');
 }catch(error){notify(error.message);}
}
async function saveUnit(event){
 event.preventDefault();if(!draft||saving||conflict)return;
 readForm();saving=true;$('detailView').inert=true;$('saveUnit').disabled=true;notify('Се зачувува…','unitMessage');
 const payload={p_id:draft.id,p_revision:draft.revision,p_status:draft.status,p_owner:draft.owner,p_phone:draft.phone,p_notes:draft.notes,p_annotations:draft.annotations};
 try{
  const result=await api('rpc/save_portal_unit',{method:'POST',body:JSON.stringify(payload)});
  const saved=Array.isArray(result)?result[0]:result;
  if(!saved?.id)throw Error('Нема потврда за зачувувањето. Освежете пред повторно зачувување.');
  units=units.map(u=>u.id===saved.id?{...saved,area:Number(saved.area)}:u);openUnit(units.find(u=>u.id===saved.id));
  notify('Промените се зачувани во заедничката база.','unitMessage');
 }catch(error){
  if(error.message.includes('RIVERSIDE_CONFLICT')){conflict=true;$('reloadUnit').hidden=false;notify('Колегата веќе го изменил овој запис. Вашите внесови се уште се тука. Копирајте го потребниот текст, па преземете ја последната верзија.','unitMessage');}
  else notify('Промените не се зачувани. '+error.message,'unitMessage');
 }finally{saving=false;$('detailView').inert=false;$('saveUnit').disabled=conflict;}
}
function svg(type,attributes){
 const node=document.createElementNS('http://www.w3.org/2000/svg',type);for(const [key,val] of Object.entries(attributes))node.setAttribute(key,String(val));return node;
}
function dimensions(){return draft?.kind==='parking'?[1000,707]:[1000,1105];}
function setTool(value){
 tool=value;document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===value));$('planStage').classList.toggle('drawing-mode',value!=='select');
}
function checkpoint(){history.push(structuredClone(draft.annotations));if(history.length>30)history.shift();}
function renderMarks(){
 const canvas=$('drawing');canvas.replaceChildren();const [width,height]=dimensions();
 (draft?.annotations||[]).forEach((mark,index)=>{
  if(mark.kind==='path'){
   const path=svg('polyline',{points:mark.points.map(p=>p[0]*width+','+p[1]*height).join(' '),class:'path','data-index':index,tabindex:0,role:'button','aria-label':'Цртеж '+(index+1)});
   canvas.append(path);
  }else{
   const point=mark.points[0];const group=svg('g',{'data-index':index,tabindex:0,role:'button','aria-label':'Белешка '+(index+1)});
   group.append(svg('circle',{cx:point[0]*width,cy:point[1]*height,r:18,class:'point'}));const label=svg('text',{x:point[0]*width,y:point[1]*height,class:'point-label'});label.textContent=index+1;group.append(label);canvas.append(group);
  }
 });
 if(pathPoints){canvas.append(svg('polyline',{points:pathPoints.map(p=>p[0]*width+','+p[1]*height).join(' '),class:'path'}));}
 $('annotationsList').replaceChildren();
 (draft?.annotations||[]).forEach((mark,index)=>{
  const row=document.createElement('div');row.className='annotation-row';const label=document.createElement('span');label.textContent=(index+1)+'. '+(mark.text||'Цртеж');
  const edit=document.createElement('button');edit.textContent='Измени';edit.type='button';edit.addEventListener('click',()=>editMark(index));
  const remove=document.createElement('button');remove.textContent='Избриши';remove.type='button';remove.addEventListener('click',()=>removeMark(index));
  row.append(label,edit,remove);$('annotationsList').append(row);
 });
 $('undoMark').disabled=!history.length;
}
function coordinates(event){
 const rect=$('drawing').getBoundingClientRect();return [Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))];
}
function removeMark(index){checkpoint();draft.annotations.splice(index,1);setDirty();renderMarks();}
function editMark(index){editingMark=index;pendingMark=null;$('markText').value=draft.annotations[index].text||'';$('markDialog').showModal();$('markText').focus();}
function newMark(mark){if(draft.annotations.length>=400){notify('Достигнат е лимитот од 400 ознаки.','unitMessage');return;}pendingMark=mark;editingMark=null;$('markText').value='';$('markDialog').showModal();$('markText').focus();}
function markAtEvent(event){
 const node=event.target.closest('[data-index]');
 return node?Number(node.dataset.index):null;
}
$('drawing').addEventListener('pointerdown',event=>{
 if(!draft||event.button!==0||$('markDialog').open)return;
 const index=markAtEvent(event);
 if(tool==='select'){if(index!==null)editMark(index);return;}
 if(tool==='erase'){if(index!==null)removeMark(index);return;}
 if(tool==='point'){newMark({kind:'point',points:[coordinates(event)],text:''});return;}
 activePointer=event.pointerId;pathPoints=[coordinates(event)];$('drawing').setPointerCapture(event.pointerId);event.preventDefault();
});
$('drawing').addEventListener('pointermove',event=>{
 if(!pathPoints||activePointer!==event.pointerId||pathPoints.length>=1500)return;
 const point=coordinates(event),last=pathPoints[pathPoints.length-1];if(Math.hypot(point[0]-last[0],point[1]-last[1])>.002){pathPoints.push(point);renderMarks();}
});
$('drawing').addEventListener('pointerup',event=>{
 if(!pathPoints||activePointer!==event.pointerId)return;
 const points=pathPoints;pathPoints=null;activePointer=null;renderMarks();if(points.length>1)newMark({kind:'path',points,text:''});
});
$('drawing').addEventListener('pointercancel',()=>{pathPoints=null;activePointer=null;renderMarks();});
$('drawing').addEventListener('keydown',event=>{if(event.key==='Enter'){const index=markAtEvent(event);if(index!==null)editMark(index);}});
$('markForm').addEventListener('submit',event=>{
 event.preventDefault();checkpoint();const text=$('markText').value.trim();
 if(editingMark!==null)draft.annotations[editingMark].text=text;
 else if(pendingMark)draft.annotations.push({...pendingMark,text});
 pendingMark=null;editingMark=null;setDirty();$('markDialog').close();renderMarks();
});
$('cancelMark').addEventListener('click',()=>{$('markDialog').close();pendingMark=null;editingMark=null;});
$('undoMark').addEventListener('click',()=>{if(!history.length)return;draft.annotations=history.pop();setDirty();renderMarks();});
document.querySelectorAll('[data-tool]').forEach(button=>button.addEventListener('click',()=>setTool(button.dataset.tool)));
$('unitForm').addEventListener('input',()=>setDirty());
$('unitForm').addEventListener('submit',saveUnit);
$('reloadUnit').addEventListener('click',refresh);
function brochureSelected(key){
 const kind=key[0]==='s'?'apartment':'parking',number=Number(key.slice(1));
 const unit=units.find(u=>u.kind===kind&&u.number===number);return unit&&occupied(unit);
}
function showBrochure(index){
 const p=catalog.pages[index];$('brochureTitle').textContent='Брошура · страница '+(index+1);$('brochureImage').src=p.image;
 const overlay=$('brochureOverlay');overlay.replaceChildren();overlay.setAttribute('viewBox','0 0 '+p.width+' '+p.height);
 for(const mark of p.marks){
  if(!brochureSelected(mark.key))continue;
  const [x,y,x2,y2]=mark.rect;
  overlay.append(mark.style==='box'?svg('rect',{x:x-1.7,y:y-1.7,width:x2-x+3.4,height:y2-y+3.4,fill:'#b1253a10',stroke:'#b1253a','stroke-width':1.1}):svg('line',{x1:x-1,y1:(y+y2)/2,x2:x2+1,y2:(y+y2)/2,stroke:'#b1253a','stroke-width':1.3}));
 }
 $('brochureDialog').showModal();
}
$('openBrochure').addEventListener('click',()=>{if(draft)showBrochure(draft.kind==='apartment'?catalog.detail['s'+draft.number]:4);});
$('closeBrochure').addEventListener('click',()=>$('brochureDialog').close());
$('brochure').addEventListener('click',async()=>{
 if(dirty){notify('Прво зачувајте ги промените на станот.');return;}
 $('brochure').disabled=true;notify('Се подготвува PDF…');
 try{
  await fetchUnits();const pdf=await PDFLib.PDFDocument.create();
  for(const source of catalog.pages){
   const page=pdf.addPage([source.width,source.height]);const image=await pdf.embedJpg(await(await fetch(source.image)).arrayBuffer());page.drawImage(image,{x:0,y:0,width:source.width,height:source.height});
   for(const mark of source.marks){
    if(!brochureSelected(mark.key))continue;
    const [x,y,x2,y2]=mark.rect,color=PDFLib.rgb(.71,.145,.215);
    if(mark.style==='box')page.drawRectangle({x:x-1.7,y:source.height-y2-1.7,width:x2-x+3.4,height:y2-y+3.4,borderWidth:1.1,borderColor:color,color,opacity:.06,borderOpacity:1});
    else page.drawLine({start:{x:x-1,y:source.height-(y+y2)/2},end:{x:x2+1,y:source.height-(y+y2)/2},color,thickness:1.3});
   }
  }
  const bytes=await pdf.save(),url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})),a=document.createElement('a');a.href=url;a.download='Riverside_Brosura.pdf';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);notify('PDF е подготвен.');
 }catch(error){notify('PDF не е создаден. '+error.message);}finally{$('brochure').disabled=false;}
});
$('loginForm').addEventListener('submit',async event=>{
 event.preventDefault();if(!configured)return;
 $('loginButton').disabled=true;notify('Се најавува…','loginMessage');
 try{const result=await authCall('token?grant_type=password',{email:$('email').value.trim(),password:$('password').value});setSession(result);$('password').value='';await openApp();}
 catch(error){notify(error.message,'loginMessage');}finally{$('loginButton').disabled=false;}
});
$('logout').addEventListener('click',async()=>{
 if(saving)return;
 if(dirty&&!confirm('Имате незачувани промени. Сепак да се одјавите?'))return;
 try{const token=await accessToken();await fetch(base+'/auth/v1/logout',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+token}});}catch{}
 setSession(null);units=[];draft=null;dirty=false;$('unitForm').reset();$('buildingMap').replaceChildren();$('annotationsList').replaceChildren();$('drawing').replaceChildren();$('appView').hidden=true;$('loginView').hidden=false;notify('Одјавени сте.','loginMessage');
});
$('refresh').addEventListener('click',refresh);
$('search').addEventListener('input',renderMap);$('statusFilter').addEventListener('change',renderMap);
$('apartmentsTab').addEventListener('click',()=>{kind='apartment';$('apartmentsTab').classList.add('active');$('parkingTab').classList.remove('active');renderMap();});
$('parkingTab').addEventListener('click',()=>{kind='parking';$('parkingTab').classList.add('active');$('apartmentsTab').classList.remove('active');renderMap();});
window.addEventListener('hashchange',route);
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
$('setupNote').hidden=configured;$('loginButton').disabled=!configured;
if(configured){
 try{session=JSON.parse(sessionStorage.getItem(sessionKey)||'null');}catch{}
 if(session)openApp();
}
