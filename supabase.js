/* ============================================================
   THE LABOUR FORCE — RESILIENT DATA LAYER
   Local-first + Supabase sync + audit + reconnect recovery.
   ============================================================ */

let labourForceSupabase = null;
let labourForceSession = null;
let syncTimer = null;
let syncBusy = false;
let pendingSync = false;
const REMOTE_MAP_KEY = 'labourforce_remote_map_v2';

function lfMap(){
  try { return JSON.parse(localStorage.getItem(REMOTE_MAP_KEY) || '{}'); }
  catch { return {}; }
}
function saveLfMap(map){ localStorage.setItem(REMOTE_MAP_KEY, JSON.stringify(map)); }
function uuid(){ return crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16)); }
function rid(type, localId){
  const map=lfMap(); map[type] ||= {};
  if(!map[type][String(localId)]){ map[type][String(localId)] = uuid(); saveLfMap(map); }
  return map[type][String(localId)];
}
function setRid(type, localId, remoteId){ const map=lfMap(); map[type] ||= {}; map[type][String(localId)]=remoteId; saveLfMap(map); }
function toastSync(message, ok=false){
  const el=document.getElementById('lfSyncStatus'); if(!el)return;
  el.textContent=message; el.dataset.state=ok?'ok':'warn';
}

function ensureConnectionUI(){
  if(document.getElementById('lfConnectionPanel')) return;
  const panel=document.createElement('div'); panel.id='lfConnectionPanel'; panel.innerHTML=`
    <div class="lf-connection-dot"></div><div class="lf-connection-copy">
      <strong id="lfSyncStatus">Local-first mode</strong><span id="lfSyncDetail">Changes are saved on this device.</span>
    </div><button id="lfLoginBtn" class="lf-connection-btn">Connect</button>`;
  document.body.appendChild(panel);
  document.getElementById('lfLoginBtn').onclick=showLfLogin;
}
function showLfLogin(){
  if(document.getElementById('lfLoginModal')) return;
  const m=document.createElement('div'); m.id='lfLoginModal'; m.className='lf-login-backdrop'; m.innerHTML=`
    <div class="lf-login-card"><div class="lf-login-brand">THE <span>LABOUR FORCE</span></div>
      <h2>Connect to command centre</h2><p>Sign in with a Supabase user that has a Labour Force profile and permissions.</p>
      <label>Email</label><input id="lfEmail" type="email" autocomplete="username">
      <label>Password</label><input id="lfPassword" type="password" autocomplete="current-password">
      <div id="lfLoginError" class="lf-login-error"></div>
      <div class="lf-login-actions"><button class="secondary" onclick="document.getElementById('lfLoginModal').remove()">Cancel</button><button class="primary" id="lfDoLogin">Connect</button></div>
    </div>`;
  document.body.appendChild(m);
  document.getElementById('lfDoLogin').onclick=async()=>{
    const email=document.getElementById('lfEmail').value.trim(), password=document.getElementById('lfPassword').value;
    const out=document.getElementById('lfLoginError'); out.textContent='';
    if(!email||!password){out.textContent='Email and password are required.';return;}
    const {data,error}=await labourForceSupabase.auth.signInWithPassword({email,password});
    if(error){out.textContent=error.message;return;}
    const {data:profile,error:profileError}=await labourForceSupabase.from('profiles').select('id,full_name,active,role_id,roles(name)').eq('id',data.user.id).maybeSingle();
    if(profileError || !profile){ await labourForceSupabase.auth.signOut(); out.textContent=profileError?.message||'This account has not been provisioned in Labour Force yet.'; return; }
    if(profile.active===false){ await labourForceSupabase.auth.signOut(); out.textContent='This Labour Force account is inactive. Contact an administrator.'; return; }
    labourForceSession=data.session; window.lfCurrentRole=profile.roles?.name||''; window.lfCurrentProfile=profile; document.getElementById('lfLoginModal').remove(); updateConnectionUI(); await hydrateFromBackend(); window.dispatchEvent(new CustomEvent('labourforce:ready'));
  };
}
function updateConnectionUI(){
  ensureConnectionUI();
  const btn=document.getElementById('lfLoginBtn');
  if(labourForceSession){
    btn.textContent='Connected'; btn.onclick=()=>labourForceSupabase.auth.signOut();
    toastSync('Cloud connected',true); document.getElementById('lfSyncDetail').textContent='Supabase + local recovery enabled.';
  } else { btn.textContent='Connect'; btn.onclick=showLfLogin; }
}

async function tableRows(table, select='*'){ const {data,error}=await labourForceSupabase.from(table).select(select); if(error) throw error; return data||[]; }
async function upsert(table, row){
  const {data,error}=await labourForceSupabase.from(table).upsert(row,{onConflict:'id'}).select('id').single();
  if(error) throw error; return data;
}
function deptRemote(name){ const d=departments.find(x=>x.name===name); return d ? rid('department', d.name) : null; }
function clientRemote(id){ return id==null ? null : rid('client',id); }
function workerRemote(id){ return id==null ? null : rid('worker',id); }
function profileId(){ return labourForceSession?.user?.id || null; }

async function syncClients(){
  for(const c of clients){ await upsert('clients',{id:rid('client',c.id),client_code:c.clientCode||`CL-${String(c.id).padStart(4,'0')}`,name:c.name,contact_person:c.contact||null,phone:c.phone||null,email:c.email||null,address:c.address||null,active:c.active!==false,notes:c.notes||null}); }
}
async function syncDepartments(){
  for(const d of departments){ await upsert('departments',{id:rid('department',d.name),name:d.name,parent_id:d.parent?deptRemote(d.parent):null,active:d.active!==false}); }
}
async function syncWorkers(){
  for(const w of workers){ await upsert('workers',{id:rid('worker',w.id),employee_no:w.employeeNo,full_name:w.name,phone:w.phone||null,national_id:w.nationalId||null,department_id:deptRemote(w.department),classification:w.classification||'Unskilled',daily_rate:Number(w.rate||0),overtime_rate:Number(w.otRate||0),join_date:w.joinDate||null,active:w.active!==false,notes:w.notes||null}); }
}
async function syncRequests(){
  for(const r of labourRequests){
    const end=r.endDate || (r.startDate && r.duration ? new Date(new Date(r.startDate+'T00:00:00').getTime()+(Number(r.duration)-1)*86400000).toISOString().slice(0,10) : null);
    const statusMap={Pending:'pending',Approved:'approved',Allocated:'partially_fulfilled',Completed:'fulfilled',Cancelled:'cancelled',Rejected:'rejected'};
    await upsert('labour_requests',{id:rid('request',r.id),request_no:r.requestNo,client_id:clientRemote(r.clientId),department_id:deptRemote(r.department),classification:r.classification||null,workers_required:Number(r.workersRequired||1),start_date:r.startDate,end_date:end,shift:r.shift||null,location:r.location||null,reason:r.reason||null,notes:r.notes||null,status:statusMap[r.status]||'pending',requested_by:profileId(),approved_by:null,approved_at:null});
    const ids=r.allocatedWorkerIds||[];
    for(const workerId of ids){ await upsert('labour_request_workers',{id:rid('request_worker',`${r.id}:${workerId}`),request_id:rid('request',r.id),worker_id:workerRemote(workerId),allocated_by:profileId(),status:'allocated'}); }
  }
}
async function syncDeployments(){
  if(typeof deployments==='undefined')return;
  for(const d of deployments){ await upsert('deployments',{id:rid('deployment',d.id),worker_id:workerRemote(d.workerId),client_id:clientRemote(d.clientId),request_id:d.requestId?rid('request',d.requestId):null,department_id:deptRemote(d.department),position:d.assignment||null,location:d.location||null,start_date:d.startDate,end_date:d.endDate||null,shift:d.shift||null,status:d.status==='Active'?'active':d.status==='Ended'?'completed':String(d.status||'active').toLowerCase(),created_by:profileId()}); }
}
async function syncAttendance(){
  for(const [date,day] of Object.entries(attendance||{})) for(const [localWorkerId,r] of Object.entries(day.records||{})){
    const status=r.status==='pending'?'pending':r.status;
    const deployment=typeof deployments!=='undefined'?deployments.find(d=>Number(d.workerId)===Number(localWorkerId)&&d.status==='Active'):null;
    await upsert('attendance',{id:rid('attendance',`${date}:${localWorkerId}:${deployment?.id||'none'}`),attendance_date:date,worker_id:workerRemote(localWorkerId),deployment_id:deployment?rid('deployment',deployment.id):null,client_id:deployment?clientRemote(deployment.clientId):null,department_id:deptRemote(workers.find(w=>Number(w.id)===Number(localWorkerId))?.department),status,overtime_hours:Number(r.overtime||0),notes:r.notes||null,created_by:profileId(),updated_by:profileId()});
  }
}
async function syncPayroll(){
  // Payroll remains locally calculated; persisted records can be added later once a period is explicitly created.
}
async function syncAudit(){
  if(typeof auditLog==='undefined')return;
  const recent=auditLog.slice(0,100);
  for(const a of recent){
    const id=rid('audit',a.id);
    const {error}=await labourForceSupabase.from('audit_logs').insert({id,user_id:profileId(),action:a.action||'change',table_name:a.tableName||'operations',record_id:String(a.reference||''),old_data:a.oldData||null,new_data:a.newData||null,metadata:{details:a.details||null,source:'labour-force-frontend'}});
    if(error && error.code!=='23505') throw error;
  }
}

async function syncLocalState(){
  if(!labourForceSession || syncBusy){ pendingSync=true; return; }
  syncBusy=true; pendingSync=false; toastSync('Syncing changes…');
  try{
    await syncClients(); await syncDepartments(); await syncWorkers(); await syncRequests(); await syncDeployments(); await syncAttendance(); await syncPayroll(); await syncAudit();
    localStorage.removeItem('labourforce_cloud_dirty');
    toastSync('All changes saved to Supabase',true);
  }catch(error){
    console.error('[Labour Force] sync failed',error);
    toastSync('Saved locally — cloud retry pending');
    const detail=document.getElementById('lfSyncDetail'); if(detail) detail.textContent=`Cloud sync paused: ${error.message||'request failed'}`;
  }finally{ syncBusy=false; if(pendingSync) queueBackendSync(); }
}
function queueBackendSync(){ clearTimeout(syncTimer); syncTimer=setTimeout(syncLocalState,450); }

async function hydrateFromBackend(){
  if(!labourForceSession)return;
  if(localStorage.getItem('labourforce_cloud_dirty')==='1'){
    await syncLocalState();
    if(localStorage.getItem('labourforce_cloud_dirty')==='1') return;
  }
  try{
    const [rc,rd,rw,rr]=await Promise.all([tableRows('clients'),tableRows('departments'),tableRows('workers'),tableRows('labour_requests')]);
    const map=lfMap();
    if(rc.length){ clients=rc.map(c=>{ let local=clients.find(x=>map.client?.[String(x.id)]===c.id); if(!local) local={id:Date.now()+Math.random()}; setRid('client',local.id,c.id); return {...local,name:c.name,contact:c.contact_person||'',phone:c.phone||'',active:c.active,clientCode:c.client_code}; }); }
    if(rd.length){ departments=rd.map(d=>{ let local=departments.find(x=>map.department?.[String(x.name)]===d.id)||departments.find(x=>x.name===d.name)||{name:d.name}; setRid('department',local.name,d.id); return {...local,name:d.name,parent:rd.find(p=>p.id===d.parent_id)?.name||'',active:d.active}; }); }
    if(rw.length){ workers=rw.map(w=>{ let local=workers.find(x=>map.worker?.[String(x.id)]===w.id)||workers.find(x=>x.employeeNo===w.employee_no)||{id:Date.now()+Math.random()}; setRid('worker',local.id,w.id); return {...local,employeeNo:w.employee_no,name:w.full_name,phone:w.phone||'',nationalId:w.national_id||'',department:rd.find(d=>d.id===w.department_id)?.name||'',classification:w.classification,rate:Number(w.daily_rate||0),otRate:Number(w.overtime_rate||0),joinDate:w.join_date||'',active:w.active,notes:w.notes||''}; }); }
    if(rr.length){ const statusMap={pending:'Pending',approved:'Approved',rejected:'Rejected',partially_fulfilled:'Allocated',fulfilled:'Completed',cancelled:'Cancelled'}; labourRequests=rr.map(r=>{let local=labourRequests.find(x=>map.request?.[String(x.id)]===r.id)||labourRequests.find(x=>x.requestNo===r.request_no)||{id:Date.now()+Math.random(),allocatedWorkerIds:[]}; setRid('request',local.id,r.id); return {...local,requestNo:r.request_no,clientId:clients.find(c=>map.client?.[String(c.id)]===r.client_id)?.id||local.clientId,department:rd.find(d=>d.id===r.department_id)?.name||'',classification:r.classification||'',workersRequired:r.workers_required,startDate:r.start_date,duration:r.end_date?Math.max(1,Math.round((new Date(r.end_date)-new Date(r.start_date))/86400000)+1):1,shift:r.shift||'Day',notes:r.notes||'',status:statusMap[r.status]||'Pending'}; }); }
    localStorage.setItem('labourforce_workers',JSON.stringify(workers)); localStorage.setItem('labourforce_departments',JSON.stringify(departments)); localStorage.setItem('labourforce_clients',JSON.stringify(clients)); localStorage.setItem('labourforce_requests',JSON.stringify(labourRequests));
    if(typeof populateFilters==='function')populateFilters(); if(typeof populateClientSelects==='function')populateClientSelects();
    if(typeof renderDashboard==='function')renderDashboard(); if(typeof renderWorkers==='function')renderWorkers(); if(typeof renderClients==='function')renderClients(); if(typeof renderDepartments==='function')renderDepartments(); if(typeof renderRequests==='function')renderRequests();
    toastSync('Cloud data loaded',true); document.getElementById('lfSyncDetail').textContent='Backend is the source of truth; local cache is the recovery layer.';
    queueBackendSync();
  }catch(error){ console.error('[Labour Force] hydrate failed',error); toastSync('Cloud read failed — local data retained'); }
}

function installSaveHook(){
  // The existing app deliberately saves synchronously to localStorage. We keep that behaviour,
  // then schedule a cloud write so a browser crash/power cut never loses the current form state.
  const original=window.saveData;
  if(!original || original.__lfWrapped)return;
  const wrapped=function(){ original(); localStorage.setItem('labourforce_cloud_dirty','1'); queueBackendSync(); };
  wrapped.__lfWrapped=true; window.saveData=wrapped;
}

(async function bootLabourForceCloud(){
  ensureConnectionUI();
  if(typeof supabase==='undefined'){
    toastSync('Supabase library unavailable'); return;
  }
  labourForceSupabase=supabase.createClient(LABOUR_FORCE_SUPABASE_URL,LABOUR_FORCE_SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  const {data}=await labourForceSupabase.auth.getSession(); labourForceSession=data.session;
  updateConnectionUI(); installSaveHook();
  labourForceSupabase.auth.onAuthStateChange((_event,session)=>{ labourForceSession=session; updateConnectionUI(); if(session) hydrateFromBackend().then(()=>window.dispatchEvent(new CustomEvent('labourforce:ready'))); });
  if(labourForceSession){
    const {data:profile}=await labourForceSupabase.from('profiles').select('id,full_name,active,role_id,roles(name)').eq('id',labourForceSession.user.id).maybeSingle();
    if(!profile || profile.active===false){ await labourForceSupabase.auth.signOut(); labourForceSession=null; updateConnectionUI(); }
    else { window.lfCurrentRole=profile.roles?.name||''; window.lfCurrentProfile=profile; await hydrateFromBackend(); window.dispatchEvent(new CustomEvent('labourforce:ready')); }
  }
  window.addEventListener('online',()=>{ if(labourForceSession) syncLocalState(); });
  window.addEventListener('beforeunload',()=>{ if(labourForceSession) localStorage.setItem('labourforce_cloud_dirty','1'); });
})();

window.queueBackendSync=queueBackendSync;
window.syncLocalState=syncLocalState;
window.showLfLogin=showLfLogin;
