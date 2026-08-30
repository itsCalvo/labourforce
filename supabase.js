/* ============================================================
   THE LABOUR FORCE � RESILIENT DATA LAYER (performance-refactored)
   Local-first + Supabase sync + audit + reconnect recovery.
   - Hydration is single-flight (no duplicate table downloads)
   - Attendance sync pushes only changed dates, not all history
   - Verification fields persist to the cloud attendance table
   ============================================================ */

let labourForceSupabase = null;
let labourForceSession = null;
let syncTimer = null;
let syncBusy = false;
let pendingSync = false;
const REMOTE_MAP_KEY = 'labourforce_remote_map_v2';
/* PHASE 1: read-path. When true, hydrate from Supabase and skip writing to
   localStorage on read. localStorage stays as a write buffer only. */
const LF_PHASE1 = true;
/* PHASE 2: cloud-authoritative write path.
   When true, every business mutation goes directly to Supabase.
   The local arrays still keep an in-memory cache so render functions
   work without waiting on the network, but localStorage is NO LONGER
   the source of truth. Set to false to revert to local-first.
   Run migration/phase2_schema.sql before enabling LF_PHASE2 = true. */
const LF_PHASE2 = true;
/* Bug fix: a sync push that keeps failing (bad network, one bad row, an RLS
   insert rejection, etc.) used to leave 'labourforce_cloud_dirty' stuck at
   '1' forever � and hydrateFromBackend() bailed out before ever reading from
   Supabase whenever that flag was set, so the UI could look permanently
   empty even though the cloud data was fine. After LF_SYNC_FAIL_LIMIT
   consecutive failures we stop blocking reads and show cloud data anyway,
   with a manual "Retry sync" affordance to try pushing local changes again. */
const LF_SYNC_FAIL_LIMIT = 3;
function lfSyncFailCount(){ return Number(localStorage.getItem('labourforce_sync_fail_count')||0); }
function updateRetrySyncVisibility(){
  const btn=document.getElementById('lfRetrySyncBtn'); if(!btn)return;
  btn.style.display = lfSyncFailCount()>=LF_SYNC_FAIL_LIMIT ? 'inline-block' : 'none';
}

/* Returns true when the current profile has workers.view_rates or rates.manage.
   Used to gate the raw `workers` table read that reveals rate/classification data.
   Guards Bug fix #1: without this check the raw workers read always fired (even
   when RLS would block it for non-admin roles), silently returning [] and making
   the workers list empty for every role except rate-permission holders. */
function lfHasRatePermission(){
  const profile=window.lfCurrentProfile;
  if(profile && profile.permissions && Array.isArray(profile.permissions)){
    const codes=profile.permissions.map(p=>p.code||p);
    if(codes.includes('workers.view_rates')||codes.includes('rates.manage')) return true;
  }
  // Role-name fallback mirrors the has_permission() check in the RLS policy:
  // both workers.view_rates and rates.manage are granted to administrator/super_admin
  const role=String(window.lfCurrentRole||'').toLowerCase();
  return role==='super_admin'||role==='administrator';
}

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
    </div><button id="lfLoginBtn" class="lf-connection-btn">Connect</button><button id="lfRetrySyncBtn" class="lf-connection-btn" style="display:none" title="Local changes have failed to sync repeatedly � retry pushing them to Supabase">Retry sync</button>`;
  document.body.appendChild(panel);
  document.getElementById('lfLoginBtn').onclick=showAuthGate;
  document.getElementById('lfRetrySyncBtn').onclick=async()=>{
    localStorage.setItem('labourforce_sync_fail_count','0');
    updateRetrySyncVisibility();
    await syncLocalState();
    await hydrateFromBackend();
  };
  updateRetrySyncVisibility();
}
/* ---------- authentication gate ----------
   A full-screen sign-in is shown until a valid, active Labour Force
   profile authenticates. The app only renders after 'labourforce:ready'. */
function showAuthGate(){
  const g=document.getElementById('authGate'); if(g)g.classList.add('show');
  try{const e=document.getElementById('gateEmail'); if(e)setTimeout(()=>e.focus(),60);}catch(x){}
}
function hideAuthGate(){
  const g=document.getElementById('authGate'); if(g)g.classList.remove('show');
}
function updateUserDisplay(profile){
  const name=profile?.full_name||profile?.email||'Administrator';
  const el=document.getElementById('lfUserName'); if(el)el.textContent=name;
  const av=document.getElementById('lfUserAvatar'); if(av)av.textContent=(String(name).trim().charAt(0)||'A').toUpperCase();
}
/* Central session handler: validates the profile, applies the role, unlocks
   the UI and hydrates cloud data. Runs on boot, on login and on auth-state
   changes, so the login gate is dismissed exactly once. */
async function handleSession(session){
  labourForceSession=session;
  updateConnectionUI();
  if(!session){
    window.lfCurrentRole=''; window.lfCurrentProfile=null;
    showAuthGate();
    return;
  }
  try{
    // Resilient profile read: try rich column set first; if any column is
    // missing (migrations not applied) fall back to id+role_id; if THAT also
    // fails, fall back to bare `*`. A failure here must NEVER sign the user
    // out � that would make the app useless for any user whose profile row
    // exists but is in an older schema. We only sign out when the row is
    // explicitly disabled (`active === false`), not when the query 400s.
    let profile=null;
    try{
      const r=await labourForceSupabase.from('profiles').select('id,full_name,email,active,role_id,roles(name)').eq('id',session.user.id).maybeSingle();
      profile=r.data||null;
    }catch(_e1){
      try{
        const r=await labourForceSupabase.from('profiles').select('id,full_name,email,role_id,roles(name)').eq('id',session.user.id).maybeSingle();
        profile=r.data||null;
      }catch(_e2){
        try{
          const r=await labourForceSupabase.from('profiles').select('*').eq('id',session.user.id).maybeSingle();
          profile=r.data||null;
        }catch(_e3){
          // Last resort: synthesise a profile from the auth session so the
          // user isn't locked out. RLS-allowed reads return the row; only a
          // truly empty `profiles` table (or 500) hits this branch.
          profile={id:session.user.id,email:session.user.email,full_name:session.user.user_metadata?.full_name||session.user.email};
        }
      }
    }
    if(!profile){
      // Profile row genuinely doesn't exist. Let the user in as a guest so
      // they at least see the UI and we can show "complete your profile".
      // Signing them out here would prevent that.
      console.warn('[Labour Force] no profile row found for user; allowing guest access.');
      profile={id:session.user.id,email:session.user.email,full_name:session.user.user_metadata?.full_name||session.user.email};
    }
    if(profile.active===false){
      await labourForceSupabase.auth.signOut();
      window.lfCurrentRole=''; window.lfCurrentProfile=null;
      showAuthGate();
      return;
    }
    window.lfCurrentRole=profile.roles?.name||profile.role||'';
    window.lfCurrentProfile=profile;
    updateUserDisplay(profile);
    hideAuthGate();
    await hydrateFromBackend();
    // Attendance hydration is non-blocking: the dashboard becomes interactive
    // immediately while a bounded 90-day window of attendance refreshes in the
    // background. The full historical attendance is synced via syncLocalState
    // (queueBackendSync), not by re-downloading everything on every login.
    hydrateAttendanceFromBackend().catch(err=>console.warn('[Labour Force] attendance hydration deferred:',err.message));
    window.dispatchEvent(new CustomEvent('labourforce:ready'));
  }catch(error){
    console.error('[Labour Force] profile check failed',error);
    hideAuthGate();
    window.dispatchEvent(new CustomEvent('labourforce:ready'));
  }
}
function bindAuthGate(){
  const btn=document.getElementById('gateDoLogin');
  if(!btn||btn.__lfBound)return;
  btn.__lfBound=true;
  const doLogin=async()=>{
    const email=document.getElementById('gateEmail').value.trim();
    const password=document.getElementById('gatePassword').value;
    const out=document.getElementById('gateError'); if(out)out.textContent='';
    if(!email||!password){if(out)out.textContent='Email and password are required.';return;}
    btn.disabled=true; btn.classList.add('loading'); btn.setAttribute('aria-busy','true');
    /* 12s timeout so users aren't left waiting on a dead connection */
    const timeoutId=setTimeout(()=>{ if(out)out.textContent='Connection timed out. Check your internet.'; btn.disabled=false; btn.classList.remove('loading'); btn.removeAttribute('aria-busy'); },12000);
    try{
      const {error}=await labourForceSupabase.auth.signInWithPassword({email,password});
      clearTimeout(timeoutId);
      if(error&&out)out.textContent=error.message;
      /* On success the auth-state listener -> handleSession unlocks the app. */
    }catch(err){ clearTimeout(timeoutId); if(out)out.textContent=(err&&err.message)||'Sign in failed.'; }
    finally{ btn.disabled=false; btn.classList.remove('loading'); btn.removeAttribute('aria-busy'); }
  };
  btn.onclick=doLogin;
  const pwd=document.getElementById('gatePassword');
  if(pwd)pwd.addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
}
async function lfSignOut(){
  try{ if(labourForceSupabase) await labourForceSupabase.auth.signOut(); }catch(e){}
  location.reload();
}
function updateConnectionUI(){
  ensureConnectionUI();
  const btn=document.getElementById('lfLoginBtn');
  if(labourForceSession){
    btn.textContent='Connected'; btn.onclick=()=>labourForceSupabase.auth.signOut();
    toastSync('Cloud connected',true); document.getElementById('lfSyncDetail').textContent='Supabase + local recovery enabled.';
  } else { btn.textContent='Sign in'; btn.onclick=showAuthGate; }
}

function withCloudTimeout(promise, label){ return Promise.race([promise, new Promise((_,reject)=>setTimeout(()=>reject(new Error(`Supabase request timed out: ${label}`)),15000))]); }
async function tableRows(table, select='*'){ const {data,error}=await withCloudTimeout(labourForceSupabase.from(table).select(select),`read ${table}`); if(error) throw error; return data||[]; }
/* Resilient master-data reader. Tries a rich, app-specific column list first;
   if the deployed schema is missing any column (migrations not applied),
   falls back to `*` so a single schema mismatch never blocks hydration of
   the other tables. Returns [] on failure so callers stay responsive.

   Missing-table cache: if a table has been observed missing (404 / "Could not
   find the table") we record the failure in localStorage for an hour and skip
   the network call on subsequent loads. The `?refresh=1` URL param clears it. */
const LF_MISSING_TABLES_KEY='labourforce_missing_tables_v1';
const LF_MISSING_TABLES_TTL=60*60*1000; // 1 hour
function lfGetMissingTables(){
  try{
    const cached=JSON.parse(localStorage.getItem(LF_MISSING_TABLES_KEY)||'null');
    if(cached && Date.now()-(cached.ts||0)<LF_MISSING_TABLES_TTL) return cached.tables||{};
  }catch(_){}
  return {};
}
function lfMarkTableMissing(table,err){
  try{
    const cur=lfGetMissingTables();
    cur[table]=Date.now();
    localStorage.setItem(LF_MISSING_TABLES_KEY, JSON.stringify({ts:Date.now(),tables:cur}));
  }catch(_){}
}
function lfClearMissingTables(){ try{ localStorage.removeItem(LF_MISSING_TABLES_KEY); }catch(_){} }
async function safeTableRows(table, trySelect){
  // Short-circuit: known-missing table ? return [] without a network call.
  if(lfGetMissingTables()[table]) return [];
  try{ return await tableRows(table, trySelect); }
  catch(e1){
    // Cache the miss and try a bare `*` once. If that also 404s, the cache
    // entry suppresses further noise for the rest of the hour.
    try{ return await tableRows(table, '*'); }
    catch(e2){
      const msg=String(e2?.message||e1?.message||'');
      if(/Could not find the table|schema cache|does not exist/i.test(msg)){
        lfMarkTableMissing(table, e2);
      } else {
        console.warn(`[Labour Force] could not read ${table}:`, e2?.message||e1);
      }
      return [];
    }
  }
}
async function upsert(table, row){
  const {data,error}=await withCloudTimeout(labourForceSupabase.from(table).upsert(row,{onConflict:'id'}).select('id').single(),`write ${table}`);
  if(error) throw error; return data;
}
async function upsertBatch(table, rows){
  if(!rows.length)return;
  const {error}=await withCloudTimeout(labourForceSupabase.from(table).upsert(rows,{onConflict:'id'}),`batch write ${table}`);
  /* Bug fix 23514: skip 23505 silently � row already in DB.
     Re-running sync after a partial push was crashing on this. */
  if(error && error.code==='23505') return;
  if(error) throw error;
}
function deptRemote(name){ const d=departments.find(x=>x.name===name); return d ? rid('department', d.name) : null; }
function clientRemote(id){ return id==null ? null : rid('client',id); }
function workerRemote(id){ return id==null ? null : rid('worker',id); }
function profileId(){ return labourForceSession?.user?.id || null; }

/* PHASE 2: Cloud-authoritative direct-write functions */
async function lfSaveWorkers(){if(typeof workers=="undefined")return;const{data:ed}=await labourForceSupabase.from("workers").select("id,employee_no").catch(()=>({data:[]}));const byId=new Map((ed||[]).map(w=>[w.id,w]));const rows=workers.map(w=>({id:byId.get(w.id)?.id||w.id,employee_no:w.employeeNo,full_name:w.name,phone:w.phone||null,national_id:w.nationalId||w.idNumber||null,id_number:w.idNumber||w.nationalId||null,kra_pin:w.kraPin||null,nssf_number:w.nssfNumber||null,shif_number:w.shifNumber||null,account_number:w.accountNumber||null,department_id:deptRemote(w.department),classification:w.classification||"Unskilled",designation:w.designation||null,daily_rate:Number(w.rate||0),overtime_rate:Number(w.otRate||0),join_date:w.joinDate||null,source_sheet:w.workbookSource||null,active:w.active!==false,notes:w.notes||null}));for(let i=0;i<rows.length;i+=100)await upsertBatch("workers",rows.slice(i,i+100));}
async function lfSaveClients(){if(typeof clients=="undefined")return;const{data:ed}=await labourForceSupabase.from("clients").select("id,client_code").catch(()=>({data:[]}));const byC=new Map((ed||[]).map(c=>[c.client_code,c.id]));const rows=clients.map(c=>{const cc=c.clientCode||"CL-"+String(c.id).padStart(4,"0");return{id:byC.get(cc)||c.id,client_code:cc,name:c.name,contact_person:c.contact||null,phone:c.phone||null,email:c.email||null,address:c.address||null,active:c.active!==false,notes:c.notes||null}});await upsertBatch("clients",rows);}
async function lfSaveDepartments(){if(typeof departments=="undefined")return;const{data:ed}=await labourForceSupabase.from("departments").select("id,name").catch(()=>({data:[]}));const byN=new Map((ed||[]).map(d=>[String(d.name||"").toLowerCase(),d.id]));const rows=departments.map(d=>{const k=String(d.name||"").toLowerCase();return{id:byN.get(k)||rid("department",d.name),name:d.name,parent_id:d.parent?deptRemote(d.parent):null,default_daily_rate:Number(d.rate||0),default_overtime_rate:Number(d.otRate||0),active:d.active!==false}});await upsertBatch("departments",rows);}
async function lfSaveRequests(){if(typeof labourRequests=="undefined")return;const{data:ed}=await labourForceSupabase.from("labour_requests").select("id,request_no").catch(()=>({data:[]}));const byN=new Map((ed||[]).map(r=>[String(r.request_no||"").toLowerCase(),r.id]));const sm={Pending:"pending",Approved:"approved",Allocated:"partially_fulfilled",Completed:"fulfilled",Cancelled:"cancelled",Rejected:"rejected"};for(const r of labourRequests){if(!clientRemote(r.clientId))continue;const rn=r.requestNo||"LR-"+String(r.id).padStart(4,"0");const ed=r.endDate||(r.startDate&&r.duration?new Date(new Date(r.startDate+"T00:00:00").getTime()+(Number(r.duration)-1)*86400000).toISOString().slice(0,10):null);const row={id:byN.get(rn.toLowerCase())||rid("request",r.id),request_no:rn,client_id:clientRemote(r.clientId),department_id:deptRemote(r.department),classification:r.classification||null,workers_required:Number(r.workersRequired||1),start_date:r.startDate,end_date:ed,shift:r.shift||null,location:r.location||null,reason:r.reason||null,notes:r.notes||null,status:sm[r.status]||"pending",requested_by:profileId()};await upsert("labour_requests",row).catch(e=>console.warn("[LF] lfSaveRequests:",e.message));const reqId=rid("request",r.id);for(const wid of(r.allocatedWorkerIds||[])){const wr=workerRemote(wid);if(!wr)continue;await upsert("labour_request_workers",{id:rid("request_worker",r.id+":"+wid),request_id:reqId,worker_id:wr,allocated_by:profileId(),status:"allocated"}).catch(()=>{});}}}
async function lfSaveDeployments(){if(typeof deployments=="undefined")return;for(const d of deployments){await upsert("deployments",{id:rid("deployment",d.id),worker_id:workerRemote(d.workerId),client_id:clientRemote(d.clientId),request_id:d.requestId?rid("request",d.requestId):null,department_id:deptRemote(d.department),position:d.assignment||null,location:d.location||null,start_date:d.startDate,end_date:d.endDate||null,shift:d.shift||null,status:d.status==="Active"?"active":d.status==="Ended"?"completed":String(d.status||"active").toLowerCase(),created_by:profileId()}).catch(e=>console.warn("[LF] lfSaveDeployments:",e.message));}}
async function lfSaveAudit(){if(typeof auditLog=="undefined")return;const rec=auditLog.slice(0,100);for(const a of rec){const aid=rid("audit",a.id);await labourForceSupabase.from("audit_logs").insert({id:aid,user_id:profileId(),action:a.action||"change",table_name:a.tableName||"operations",record_id:String(a.reference||""),old_data:a.oldData||null,new_data:a.newData||null,metadata:{details:a.details||null,source:"labour-force-frontend"}}).then(({error})=>{if(error&&error.code!=="23505")console.warn("[LF] audit insert:",error.message);});}}
async function lfSaveAttendanceDate(date){if(!date||!attendance[date])return;const day=attendance[date];if(!day||!day.records)return;for(const[localWorkerId,r]of Object.entries(day.records||{})){const w=workers.find(wk=>Number(wk.id)===Number(localWorkerId));if(!w)continue;const wRemote=workerRemote(localWorkerId);if(!wRemote)continue;const status=r.status==="present"||r.status==="worked"||r.status==="approved"?"present":r.status==="pending"?"pending":"absent";const dep=typeof deployments!=="undefined"?deployments.find(d=>Number(d.workerId)===Number(localWorkerId)&&d.status==="Active"):null;const row={attendance_date:date,worker_id:wRemote,deployment_id:dep?rid("deployment",dep.id):null,client_id:dep?clientRemote(dep.clientId):null,department_id:deptRemote(w.department),status,overtime_hours:Number(r.overtime||0),regular_hours:Number(r.hours||0),remarks:r.remarks||r.notes||null,verification_status:r.verification_status==="verified"?"verified":"unverified",verified_by:r.verified_by_id||null,verified_at:r.verified_at||null,created_by:profileId(),updated_by:profileId()};try{const res=await labourForceSupabase.from("attendance").upsert(row,{onConflict:"worker_id,attendance_date"}).select("id").single();if(res.data?.id){const map=lfMap();map.attendance=map.attendance||{};map.attendance[date+":"+localWorkerId]=res.data.id;saveLfMap(map);}}catch(e){if(e.code==="42703"){const leg={...row};delete leg.verification_status;delete leg.verified_by;delete leg.verified_at;delete leg.remarks;await labourForceSupabase.from("attendance").upsert(leg,{onConflict:"worker_id,attendance_date"}).catch(()=>{});}else{console.warn("[LF] lfSaveAttendanceDate:",e.message);}}}}
async function lfSaveAttendanceApproval(date,mode){if(!date)return;const day=attendance[date]||{};const payload={attendance_date:date,department_id:deptRemote(workers.find(w=>w.active)?.department||"Operations")};if(mode==="submit"){payload.status="submitted";payload.submitted_by=profileId();payload.submitted_at=day.submittedAt||new Date().toISOString();}else if(mode==="approve"){payload.status="approved";payload.approved_by=profileId();payload.approved_at=day.approvedAt||new Date().toISOString();}await labourForceSupabase.from("attendance_approvals").upsert(payload,{onConflict:"attendance_date"}).catch(()=>{});}


async function syncClients(){
  const {data:existing,error}=await labourForceSupabase.from('clients').select('id,client_code');
  if(error) throw error;
  const remoteByCode=new Map((existing||[]).map(client=>[client.client_code,client.id]));
  const rows=[];
  for(const c of clients){
    const clientCode=c.clientCode||`CL-${String(c.id).padStart(4,'0')}`;
    const existingId=remoteByCode.get(clientCode);
    if(existingId) setRid('client',c.id,existingId);
    rows.push({id:existingId||rid('client',c.id),client_code:clientCode,name:c.name,contact_person:c.contact||null,phone:c.phone||null,email:c.email||null,address:c.address||null,active:c.active!==false,notes:c.notes||null});
  }
  /* Defensive: deployed clients table may not have all columns (older schema).
     Iteratively drop any column the server reports as missing (42703). */
  let clientDropCols=new Set();
  for(let attempt=0;attempt<5;attempt++){
    try{ await upsertBatch('clients',rows.map(r=>{ const o={...r}; clientDropCols.forEach(c=>delete o[c]); return o; })); break; }
    catch(error){
      if(error.code!=='42703') throw error;
      const match=(error.message||'').match(/'([a-z_]+)'/);
      if(!match) throw error;
      clientDropCols.add(match[1]);
    }
  }
}
async function syncDepartments(){
  const {data:existing,error}=await labourForceSupabase.from('departments').select('id,name');
  if(error) throw error;
  const remoteByName=new Map((existing||[]).map(department=>[String(department.name||'').trim().toLowerCase(),department.id]));
  const uniqueDepartments=[];
  const seen=new Set();
  for(const department of departments){
    const name=String(department.name||'').replace(/\s+/g,' ').trim();
    const key=name.toLowerCase();
    if(!name||seen.has(key)) continue;
    seen.add(key);
    const existingId=remoteByName.get(key);
    if(existingId) setRid('department',name,existingId);
    uniqueDepartments.push({...department,name});
  }
  departments=uniqueDepartments;
  const rows=departments.map(d=>({id:rid('department',d.name),name:d.name,parent_id:d.parent?deptRemote(d.parent):null,default_daily_rate:Number(d.rate||0),default_overtime_rate:Number(d.otRate||0),active:d.active!==false}));
  /* The deployed `departments` table may not have the rate/parent/active columns
     (older schema). Strip any column that the server reports as missing � but
     do it iteratively so a schema with only some of the columns doesn't still
     trip the upsert. Each retry drops one more column from the row. */
  let dropCols=new Set();
  for(let attempt=0;attempt<5;attempt++){
    try{ await upsertBatch('departments',rows.map(r=>{ const o={...r}; dropCols.forEach(c=>delete o[c]); return o; })); break; }
    catch(error){
      if(error.code!=='42703') throw error;
      const match=(error.message||'').match(/'([a-z_]+)'/);
      if(!match) throw error;
      dropCols.add(match[1]);
    }
  }
}
async function syncWorkers(){
  const {data:existing,error}=await labourForceSupabase.from('workers').select('id,employee_no,id_number');
  if(error) throw error;
  const remoteByIdentity=new Map();
  (existing||[]).forEach(worker=>{if(worker.id_number)remoteByIdentity.set(`id:${String(worker.id_number).trim().toLowerCase()}`,worker.id);if(worker.employee_no)remoteByIdentity.set(`staff:${String(worker.employee_no).trim().toLowerCase()}`,worker.id);});
  const uniqueWorkers=[],seen=new Set();
  for(const worker of workers){
    const key=String(worker.idNumber||`${worker.employeeNo}|${worker.name}`).replace(/\s+/g,' ').trim().toLowerCase();
    if(!key||seen.has(key))continue;
    seen.add(key); uniqueWorkers.push(worker);
  }
  workers=uniqueWorkers;
  const rows=[];
  for(const w of workers){const existingId=remoteByIdentity.get(`id:${String(w.idNumber||'').trim().toLowerCase()}`)||remoteByIdentity.get(`staff:${String(w.employeeNo||'').trim().toLowerCase()}`);if(existingId)setRid('worker',w.id,existingId);rows.push({id:existingId||rid('worker',w.id),employee_no:w.employeeNo,full_name:w.name,phone:w.phone||null,national_id:w.nationalId||w.idNumber||null,id_number:w.idNumber||w.nationalId||null,kra_pin:w.kraPin||null,nssf_number:w.nssfNumber||null,account_number:w.accountNumber||null,shif_number:w.shifNumber||null,department_id:deptRemote(w.department),classification:w.classification||'Unskilled',designation:w.designation||null,daily_rate:Number(w.rate||0),overtime_rate:Number(w.otRate||0),join_date:w.joinDate||null,source_sheet:w.workbookSource||null,active:w.active!==false,notes:w.notes||null}); }
  for(let index=0;index<rows.length;index+=100)await upsertBatch('workers',rows.slice(index,index+100));
}
async function syncRequests(){
  const {data:existing,error}=await labourForceSupabase.from('labour_requests').select('id,request_no');
  if(error) throw error;
  const remoteByNumber=new Map((existing||[]).map(request=>[String(request.request_no||'').trim().toLowerCase(),request.id]));
  for(const r of labourRequests){
    const end=r.endDate || (r.startDate && r.duration ? new Date(new Date(r.startDate+'T00:00:00').getTime()+(Number(r.duration)-1)*86400000).toISOString().slice(0,10) : null);
    const statusMap={Pending:'pending',Approved:'approved',Allocated:'partially_fulfilled',Completed:'fulfilled',Cancelled:'cancelled',Rejected:'rejected'};
    if(!clientRemote(r.clientId))continue;
    const existingId=remoteByNumber.get(String(r.requestNo||'').trim().toLowerCase());
    if(existingId)setRid('request',r.id,existingId);
    await upsert('labour_requests',{id:existingId||rid('request',r.id),request_no:r.requestNo,client_id:clientRemote(r.clientId),department_id:deptRemote(r.department),classification:r.classification||null,workers_required:Number(r.workersRequired||1),start_date:r.startDate,end_date:end,shift:r.shift||null,location:r.location||null,reason:r.reason||null,notes:r.notes||null,status:statusMap[r.status]||'pending',requested_by:profileId(),approved_by:null,approved_at:null});
    const ids=r.allocatedWorkerIds||[];
    for(const workerId of ids){ await upsert('labour_request_workers',{id:rid('request_worker',`${r.id}:${workerId}`),request_id:rid('request',r.id),worker_id:workerRemote(workerId),allocated_by:profileId(),status:'allocated'}); }
  }
}
async function syncDeployments(){
  if(typeof deployments==='undefined')return;
  for(const d of deployments){ await upsert('deployments',{id:rid('deployment',d.id),worker_id:workerRemote(d.workerId),client_id:clientRemote(d.clientId),request_id:d.requestId?rid('request',d.requestId):null,department_id:deptRemote(d.department),position:d.assignment||null,location:d.location||null,start_date:d.startDate,end_date:d.endDate||null,shift:d.shift||null,status:d.status==='Active'?'active':d.status==='Ended'?'completed':String(d.status||'active').toLowerCase(),created_by:profileId()}); }
}

/* Attendance rows include verification state. The verification columns are
   added by schema_patch_verification_supervisor.sql; older databases fall
   back gracefully (error 42703 = undefined column). */
function attendanceRowFor(date, localWorkerId, r, deployment){
  const status=r.status==='present'||r.status==='worked'||r.status==='approved'?'present':r.status==='pending'?'pending':'absent';
  return {id:rid('attendance',`${date}:${localWorkerId}:${deployment?.id||'none'}`),attendance_date:date,worker_id:workerRemote(localWorkerId),deployment_id:deployment?rid('deployment',deployment.id):null,client_id:deployment?clientRemote(deployment.clientId):null,department_id:deptRemote(departments.find(x=>x.name===(workers.find(w=>Number(w.id)===Number(localWorkerId))||{}).department)?.name)||deptRemote((workers.find(w=>Number(w.id)===Number(localWorkerId))||{}).department),status,overtime_hours:Number(r.overtime||0),notes:r.notes||null,verification_status:r.verification_status==='verified'?'verified':'unverified',verified_by:r.verified_by_id||null,verified_at:r.verified_at||null,created_by:profileId(),updated_by:profileId()};
}
async function pushAttendanceRows(rows){
  if(!rows.length)return;
  try{
    for(let index=0;index<rows.length;index+=1000)await upsertBatch('attendance',rows.slice(index,index+1000));
  }catch(error){
    if(error.code!=='42703')throw error;
    /* Database not migrated yet: retry without the verification columns. */
    const legacy=rows.map(({verification_status,verified_by,verified_at,...row})=>row);
    for(let index=0;index<legacy.length;index+=1000)await upsertBatch('attendance',legacy.slice(index,index+1000));
  }
}
/* Pushes ONLY the dates marked dirty (or everything after a full-sync flag).
   Previously this re-uploaded every attendance row on every sync. */
async function syncAttendance(){
  const dirtyDates=typeof takeAttendanceDirtyDates==='function'?takeAttendanceDirtyDates():[];
  const fullSync=localStorage.getItem('labourforce_attendance_dirty')==='1';
  let targetDates;
  if(fullSync){ targetDates=Object.keys(attendance||{}); localStorage.removeItem('labourforce_cloud_dirty'); localStorage.removeItem('labourforce_attendance_dirty'); }
  else if(dirtyDates.length){ targetDates=dirtyDates.filter(date=>attendance[date]); }
  else return;
  if(!targetDates.length)return;
  /* Validate only the worker ids actually referenced by these dates. */
  const referenced=new Set();
  for(const date of targetDates)for(const localWorkerId of Object.keys(attendance[date].records||{})){
    const remoteId=workerRemote(localWorkerId);
    if(remoteId)referenced.add(remoteId);
  }
  if(!referenced.size)return;
  const ids=[...referenced];
  const validIds=new Set();
  for(let index=0;index<ids.length;index+=200){
    const chunk=ids.slice(index,index+200);
    const {data,error}=await labourForceSupabase.from('workers').select('id').in('id',chunk);
    if(error)throw error;
    (data||[]).forEach(row=>validIds.add(String(row.id)));
  }
  const rows=[];
  for(const date of targetDates){
    const day=attendance[date];if(!day)continue;
    for(const [localWorkerId,r] of Object.entries(day.records||{})){
      const localWorker=workers.find(worker=>Number(worker.id)===Number(localWorkerId));
      if(!localWorker)continue;
      const remoteWorkerId=workerRemote(localWorkerId);
      if(!remoteWorkerId||!validIds.has(String(remoteWorkerId)))continue;
      const deployment=typeof deployments!=='undefined'?deployments.find(d=>Number(d.workerId)===Number(localWorkerId)&&d.status==='Active'):null;
      rows.push(attendanceRowFor(date,localWorkerId,r,deployment));
    }
  }
  await pushAttendanceRows(rows);
}
/* Attendance-only sync: pushes attendance changes WITHOUT re-uploading
   workers/departments/clients/requests. Used for ATT_MUTATORS in
   installSaveHook so that marking one worker present/absent does not
   trigger a full master-data push. */
async function syncAttendanceOnly(){
  if(!labourForceSession)return;
  if(syncBusy)return;
  if(typeof attendance==='undefined')return;
  syncBusy=true;
  try{
    await syncAttendance();
  }catch(error){
    console.warn('[Labour Force] attendance-only sync failed:',error.message);
  }finally{
    syncBusy=false;
  }
}
async function syncPayroll(){
  // Payroll remains locally calculated; persisted records can be added later once a period is explicitly created.
}

/* ---------- attendance hydration (read FROM cloud) ----------
   The original sync layer pushed attendance TO Supabase but never pulled
   it back, so a fresh device that had never opened the app would show
   an empty Daily Attendance screen even though the data was on the
   server. This function rebuilds the local `attendance` map from
   `public.attendance` + `public.attendance_approvals` so the UI is
   fully populated immediately after login. */
function mapRemoteStatus(s){
  if(!s) return 'pending';
  const v=String(s).toLowerCase();
  if(v==='present' || v==='worked' || v==='approved') return 'present';
  if(v==='absent' || v==='late' || v==='half_day' || v==='excused' || v==='off_day') return 'absent';
  return 'pending';
}

async function hydrateAttendanceFromBackend(){
  if(!labourForceSession)return;
  if(typeof attendance==='undefined')return;
  try{
    const remoteRows=[];
    let from=0, pageSize=1000, hasMore=true;
    // Fetch only the last 90 days. Full historical attendance is synced
    // separately via syncLocalState. Previously this ran a paged while-loop
    // fetching ALL attendance rows on every page load, blocking for many seconds.
    const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-90);
    const since=cutoff.toISOString().split('T')[0];
    const RICH='attendance_date,worker_id,status,overtime_hours,time_in,time_out,submitted_at,remarks,supervisor_id';
    while(hasMore){
      let data=null, err=null;
      try{
        const a=await labourForceSupabase.from('attendance').select(RICH)
          .gte('attendance_date',since).order('attendance_date',{ascending:false}).range(from,from+pageSize-1);
        if(a.error){
          /* 42703 = column does not exist. The deployed schema may not have
             time_in/time_out/remarks/supervisor_id etc., so fall back to a
             narrower safe set, then to `*`. Crucially the fallback must NOT
             keep selecting the missing column or it re-fails with 42703. */
          if(a.error.code!=='42703') throw a.error;
          const b=await labourForceSupabase.from('attendance').select('attendance_date,worker_id,status,overtime_hours')
            .gte('attendance_date',since).order('attendance_date',{ascending:false}).range(from,from+pageSize-1);
          if(b.error){
            if(b.error.code!=='42703') throw b.error;
            const c=await labourForceSupabase.from('attendance').select('*')
              .gte('attendance_date',since).order('attendance_date',{ascending:false}).range(from,from+pageSize-1);
            if(c.error) throw c.error;
            data=c.data;
          } else { data=b.data; }
        } else { data=a.data; }
      }catch(e){ err=e; }
      if(err) throw err;
      if(data) remoteRows.push(...data);
      hasMore = (data||[]).length === pageSize;
      from += pageSize;
    }
    if(!remoteRows.length) return;

    let approvalRows=[];
    try{
      const {data:apps,error:appErr}=await labourForceSupabase
        .from('attendance_approvals')
        .select('attendance_date,status,submitted_at,approved_at,remarks');
      if(!appErr && apps) approvalRows=apps;
    }catch(_){ /* optional table, ignore */ }

    const map=lfMap();
    const remoteByLocalWorker=new Map();
    for(const w of (typeof workers!=='undefined'?workers:[])){
      const remoteId=map.worker?.[String(w.id)];
      if(remoteId) remoteByLocalWorker.set(String(remoteId), String(w.id));
    }

    const fresh={};
    for(const row of remoteRows){
      const date=row.attendance_date;
      if(!date) continue;
      const localWorkerId=remoteByLocalWorker.get(String(row.worker_id));
      if(!localWorkerId) continue;
      if(!fresh[date]) fresh[date]={status:'draft',submitted:false,submittedAt:null,approved:false,approvedAt:null,records:{}};
      fresh[date].records[localWorkerId]={
        status: mapRemoteStatus(row.status),
        hours: Number(row.regular_hours ?? row.hours_worked ?? row.hours ?? 0),
        overtime: Number(row.overtime_hours ?? row.overtime ?? 0),
        timeIn: row.time_in||null,
        timeOut: row.time_out||null,
        submittedAt: row.submitted_at||null,
        notes: row.remarks||'',
        verification_status:'verified',
        verified_by_id: row.supervisor_id||null,
        verified_at: row.submitted_at||null
      };
    }

    for(const a of approvalRows){
      if(!a.attendance_date) continue;
      if(!fresh[a.attendance_date]) fresh[a.attendance_date]={status:'draft',submitted:false,submittedAt:null,approved:false,approvedAt:null,records:{}};
      const day=fresh[a.attendance_date];
      if(a.status==='submitted'){ day.submitted=true; day.submittedAt=a.submitted_at||day.submittedAt; }
      if(a.status==='approved'){ day.submitted=true; day.approved=true; day.approvedAt=a.approved_at||day.approvedAt; day.submittedAt=day.submittedAt||a.submitted_at; }
    }

    attendance = Object.assign({}, fresh, attendance||{});
    localStorage.setItem('labourforce_attendance', JSON.stringify(attendance));
    if(typeof lfDataVersion==='number') lfDataVersion++;
    console.log('[Labour Force] attendance hydrated:', Object.keys(fresh).length, 'day(s),', Object.values(fresh).reduce((n,d)=>n+Object.keys(d.records||{}).length,0), 'record(s) from cloud');
    /* Re-render any live view so pulled cloud attendance shows immediately. */
    if(typeof renderAttendance==='function'){ try{ renderAttendance(); }catch(_e){} }
    if(typeof renderApproval==='function'){ try{ renderApproval(); }catch(_e){} }
    if(typeof renderDashboard==='function'){ try{ renderDashboard(); }catch(_e){} }
    if(typeof renderJtsAttendance==='function'){ try{ renderJtsAttendance(); }catch(_e){} }
  }catch(error){
    console.error('[Labour Force] attendance hydration failed', error);
    const msg=error?.message||'request failed';
    const dt=document.getElementById('lfSyncDetail'); if(dt) dt.textContent='Attendance sync: '+msg;
  }
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
  syncBusy=true; pendingSync=false; toastSync('Syncing changes�');
  try{
    await syncClients(); await syncDepartments(); await syncWorkers(); await syncRequests(); await syncDeployments(); await syncAttendance(); await syncPayroll(); await syncAudit();
    /* Pull cloud attendance back so updates made on other devices (or by a
       supervisor/manager) flow into this cache instead of being only pushed. */
    await hydrateAttendanceFromBackend();
    localStorage.removeItem('labourforce_cloud_dirty');
    localStorage.removeItem('labourforce_sync_fail_count');
    localStorage.removeItem('labourforce_last_sync_error');
    updateRetrySyncVisibility();
    toastSync('All changes saved to Supabase',true);
  }catch(error){
    console.error('[Labour Force] sync failed',error);
    pendingSync=false;
    clearTimeout(syncTimer);
    const failCount=lfSyncFailCount()+1;
    localStorage.setItem('labourforce_sync_fail_count',String(failCount));
    localStorage.setItem('labourforce_last_sync_error',error.message||'request failed');
    updateRetrySyncVisibility();
    toastSync('Cloud sync paused');
    const detail=document.getElementById('lfSyncDetail'); if(detail) detail.textContent=`Sync error (attempt ${failCount}): ${error.message||'request failed'}`;
  }finally{ syncBusy=false; }
}
function queueBackendSync(){ clearTimeout(syncTimer); syncTimer=setTimeout(syncLocalState,450); }
/* Like queueBackendSync but only flushes the attendance table.
   Saves 3-5 MB of unchanged rows on every attendance click. */
function queueAttendanceSync(){ clearTimeout(syncTimer); syncTimer=setTimeout(syncAttendanceOnly,250); }

/* Single-flight hydration: concurrent callers share one promise so the
   whole master-data download can never run twice at once. */
let lfHydrateInFlight=null;
async function hydrateFromBackend(){
  if(!labourForceSession)return;
  if(lfHydrateInFlight)return lfHydrateInFlight;
  lfHydrateInFlight=(async()=>{
    let stuckAfterRepeatedFailures=false;
    if(localStorage.getItem('labourforce_cloud_dirty')==='1'){
      if(lfSyncFailCount()<LF_SYNC_FAIL_LIMIT){
        await syncLocalState();
        if(localStorage.getItem('labourforce_cloud_dirty')==='1' && lfSyncFailCount()<LF_SYNC_FAIL_LIMIT) return;
      }
      /* Bug fix: previously we returned here unconditionally whenever the
         dirty flag was still set, so a push that failed even once could
         block cloud reads forever. Once we've retried LF_SYNC_FAIL_LIMIT
         times, stop blocking and read cloud data anyway � an out-of-date
         "can't sync my edits" warning is far less confusing than an app
         that silently looks empty. */
      if(localStorage.getItem('labourforce_cloud_dirty')==='1'){
        stuckAfterRepeatedFailures=true;
        console.warn('[Labour Force] local changes have not synced after repeated failures � reading cloud data anyway instead of staying blocked.');
      }
    }
    try{
      /* Phase 1: read the general-access tables. workers_public is the rates-hidden
         view (policy using(true)) so every authenticated user can see the worker list.
         The raw `workers` table's SELECT policy only lets rows through for profiles
         with workers.view_rates or rates.manage � so we must NOT read it unconditionally:
         a non-rate role would get a silent empty array back, making the UI look empty.
         Instead we gate the second read on the client-side permission check. */
      const [rc,rd,rwPublic,rr]=await Promise.all([
        safeTableRows('clients','id,client_code,name,contact_person,phone,active'),
        safeTableRows('departments','id,name,active'),
        safeTableRows('workers_public','id,staff_no,id_number,name,department,designation,active,created_at,updated_at'),
        safeTableRows('labour_requests','id,request_no,client_id,department_id,classification,workers_required,start_date,end_date,shift,notes,status')]);
      /* Phase 2: only attempt the raw `workers` read (which exposes rate/classification
         and other admin-only fields) when the signed-in profile is permitted to see
         them. This second read is allowed to come back empty (RLS-filtered) without
         blocking anything else. */
      let rwRates=[]; let ratesLoaded=false;
      if(lfHasRatePermission()){
        rwRates=await safeTableRows('workers','id,employee_no,full_name,phone,national_id,id_number,kra_pin,nssf_number,shif_number,account_number,department_id,classification,designation,daily_rate,overtime_rate,join_date,source_sheet,active,notes');
        ratesLoaded=true;
      }
      /* Safety net: if workers_public returned 0 rows, the view may not be deployed
         on this instance (older schema). In that case, try the raw `workers` table
         as a best-effort fallback even for non-rate roles � RLS will still filter
         out rate/classification fields for users without permission, but at least
         the worker list won't be empty. This preserves the rate-hiding design
         intent (RLS enforces it server-side) while preventing a permanently empty
         workers list when the view is missing. */
      if(!rwPublic.length && !rwRates.length){
        const fallback=await safeTableRows('workers','id,employee_no,full_name,phone,national_id,id_number,department_id,active');
        if(fallback.length){ rwRates=fallback; ratesLoaded=true; }
      }
      const map=lfMap();
      /* Merge: workers_public supplies the rows every authenticated user can
         see; the raw `workers` read (rwRates) overlays rate/extended fields
         when the signed-in profile is permitted to see them. If
         workers_public itself isn't deployed/readable (older schema), fall
         back to whatever the raw table returned so this still degrades to
         the old behaviour instead of losing data outright. */
      const rateById=new Map(rwRates.map(w=>[String(w.id),w]));
      const rw = rwPublic.length ? rwPublic.map(pub=>{
        const rate=rateById.get(String(pub.id))||{};
        return {
          id:pub.id, employee_no:rate.employee_no||pub.staff_no, staff_no:pub.staff_no,
          full_name:rate.full_name||pub.name, name:pub.name, phone:rate.phone||null,
          national_id:rate.national_id||pub.id_number||null, id_number:pub.id_number||rate.id_number||null,
          kra_pin:rate.kra_pin||null, nssf_number:rate.nssf_number||null, shif_number:rate.shif_number||null,
          account_number:rate.account_number||null, department_id:rate.department_id||null, department:pub.department||null,
          classification:rate.classification||null, designation:rate.designation||pub.designation||null,
          daily_rate:rate.daily_rate, overtime_rate:rate.overtime_rate, join_date:rate.join_date||null,
          source_sheet:rate.source_sheet||null, active:pub.active, notes:rate.notes||null
        };
      }) : rwRates;
      /* Diagnostics: surface exactly what the cloud returned for each master
         table. This makes the difference visible between (a) an empty cloud,
         (b) reads silently blocked by RLS/grants (safeTableRows -> []), or
         (c) real data replacing the local cache. Works regardless of whether
         the arrays were big enough to be applied. `workersRatesLoaded`
         reports whether the rate-enriched raw `workers` read was even
         attempted � useful future debugging to confirm a non-rate role
         was correctly excluded from the rate path. */
      window.__lfCloudCounts={clients:rc.length,departments:rd.length,workers:rw.length,workersPublic:rwPublic.length,workersRatesLoaded:ratesLoaded,requests:rr.length};
      console.log('[Labour Force] cloud read counts (clients/departments/workers/workersPublic/workersRatesLoaded/requests):',
        rc.length, rd.length, rw.length, rwPublic.length, ratesLoaded, rr.length);
      /* Defensive guards: supervisor.html only loads data needed for attendance
         (workers + attendance) � clients/departments/requests arrays are not
         defined there. Each block only runs if the corresponding global exists
         AND the local array exists, so a reference error never blocks hydration
         on the supervisor page. */
      if(rc.length && typeof clients!=='undefined' && Array.isArray(clients)){ clients=rc.map(c=>{ let local=clients.find(x=>map.client?.[String(x.id)]===c.id); if(!local) local={id:Date.now()+Math.random()}; setRid('client',local.id,c.id); return {...local,name:c.name,contact:c.contact_person||'',phone:c.phone||'',active:c.active,clientCode:c.client_code}; }); }
      if(rd.length && typeof departments!=='undefined' && Array.isArray(departments)){ departments=rd.map(d=>{ let local=departments.find(x=>map.department?.[String(x.name)]===d.id)||departments.find(x=>x.name===d.name)||{name:d.name}; setRid('department',local.name,d.id); return {...local,name:d.name,parent:rd.find(p=>p.id===d.parent_id)?.name||'',rate:Number(d.default_daily_rate||local.rate||0),otRate:Number(d.default_overtime_rate||local.otRate||0),active:d.active}; }); }
      if(rw.length && typeof workers!=='undefined' && Array.isArray(workers)){ workers=rw.map(w=>{ let local=workers.find(x=>map.worker?.[String(x.id)]===w.id)||workers.find(x=>x.id===w.id)||workers.find(x=>x.employeeNo===w.employee_no)||{id:Date.now()+Math.random()}; setRid('worker',local.id,w.id); return {...local,employeeNo:w.employee_no||w.staff_no||local.employeeNo,name:w.full_name||w.name||local.name,phone:w.phone||local.phone||'',nationalId:w.national_id||w.id_number||'',idNumber:w.id_number||w.national_id||'',kraPin:w.kra_pin||'',nssfNumber:w.nssf_number||'',shifNumber:w.shif_number||'',accountNumber:w.account_number||'',department:w.department||rd.find(d=>d.id===w.department_id)?.name||local.department||'Operations',classification:w.classification||local.classification||'Unskilled',designation:w.designation||'',rate:Number(w.daily_rate||w.override_rate_day||local.rate||0),otRate:Number(w.overtime_rate||w.override_rate_hour||local.otRate||0),joinDate:w.join_date||local.joinDate||'',workbookSource:w.source_sheet||'',active:w.active!==false,notes:w.notes||local.notes||''}; }); }
      if(rr.length && typeof labourRequests!=='undefined' && Array.isArray(labourRequests)){ const statusMap={pending:'Pending',approved:'Approved',rejected:'Rejected',partially_fulfilled:'Allocated',fulfilled:'Completed',cancelled:'Cancelled'}; labourRequests=rr.map(r=>{let local=labourRequests.find(x=>map.request?.[String(x.id)]===r.id)||labourRequests.find(x=>x.requestNo===r.request_no)||{id:Date.now()+Math.random(),allocatedWorkerIds:[]}; setRid('request',local.id,r.id); return {...local,requestNo:r.request_no,clientId:rc.find(c=>String(c.id)===String(r.client_id))?.id||local.clientId,department:rd.find(d=>d.id===r.department_id)?.name||local.department||'',classification:r.classification||'',workersRequired:r.workers_required,startDate:r.start_date,duration:r.end_date?Math.max(1,Math.round((new Date(r.end_date)-new Date(r.start_date))/86400000)+1):1,shift:r.shift||'Day',notes:r.notes||'',status:statusMap[r.status]||'Pending'}; }); }
      /* Only persist arrays that exist on this page (supervisor.html only
         has workers + attendance; the others aren't declared there). */
      if(typeof workers!=='undefined')try{localStorage.setItem('labourforce_workers',JSON.stringify(workers));}catch(_){}
      if(typeof departments!=='undefined')try{localStorage.setItem('labourforce_departments',JSON.stringify(departments));}catch(_){}
      if(typeof clients!=='undefined')try{localStorage.setItem('labourforce_clients',JSON.stringify(clients));}catch(_){}
      if(typeof labourRequests!=='undefined')try{localStorage.setItem('labourforce_requests',JSON.stringify(labourRequests));}catch(_){}
      if(typeof lfDataVersion==='number')lfDataVersion++;
      /* Renders run in their own try/catch: a UI bug must never be reported as a
         "cloud read failure" and must never prevent the cloud cache from saving. */
      try{
        if(typeof populateFilters==='function')populateFilters(); if(typeof populateClientSelects==='function')populateClientSelects();
        if(typeof renderDashboard==='function')renderDashboard(); if(typeof renderWorkers==='function'&&document.getElementById('workersTable'))renderWorkers(); if(typeof renderClients==='function'&&document.getElementById('clientsTable'))renderClients(); if(typeof renderDepartments==='function'&&document.getElementById('departmentsTable'))renderDepartments(); if(typeof renderRequests==='function'&&document.getElementById('requestsTable'))renderRequests();
      }catch(renderError){ console.error('[Labour Force] render after hydrate failed (data was still saved locally ok)', renderError); }
      syncBusy=false;
      const counts=window.__lfCloudCounts||{};
      updateRetrySyncVisibility();
      const detailEl=document.getElementById('lfSyncDetail');
      if(stuckAfterRepeatedFailures){
        toastSync('Cloud read OK � local edits not syncing');
        if(detailEl) detailEl.textContent=`Local changes failed to sync (${lfSyncFailCount()} attempts) � last error: ${localStorage.getItem('labourforce_last_sync_error')||'unknown'}. Showing latest cloud data. Click Retry sync to try again. Cloud rows ? clients:${counts.clients} depts:${counts.departments} workers:${counts.workers}${counts.workersRatesLoaded?'':' (rates hidden)'} requests:${counts.requests}`;
      } else {
        localStorage.removeItem('labourforce_cloud_dirty');
        toastSync('Cloud read OK',true);
        if(detailEl) detailEl.textContent=`Cloud rows ? clients:${counts.clients} depts:${counts.departments} workers:${counts.workers}${counts.workersRatesLoaded?'':' (rates hidden)'} requests:${counts.requests}`;
      }
    }catch(error){ console.error('[Labour Force] hydrate failed',error); const msg=error?.message||'request failed'; toastSync('Cloud read failed: '+msg); const detail=document.getElementById('lfSyncDetail'); if(detail)detail.textContent='Hydrate error: '+msg; }
  })();
  try{ return await lfHydrateInFlight; } finally{ lfHydrateInFlight=null; }
}

function installSaveHook(){
  // The existing app deliberately saves synchronously to localStorage. We keep that behaviour,
  // then schedule a cloud write so a browser crash/power cut never loses the current form state.
  // Attendance mutations already record their exact dates via markAttendanceDirtyDate(), so they
  // do NOT need the expensive full-history flag.
  const original=window.saveData;
  if(!original || original.__lfWrapped)return;
  const ATT_MUTATORS=/changeAttendanceStatus|changeOvertime|markAllWorked|submitAttendance|approveAttendance|verifyAttendanceRecord|verifyAllWorked|setJtsStatus|changeJtsHours|changeJtsOt|editSupervisorRecord|cancelSupervisorRecord|markSupervisorPresent|generateJtsRoster|ensureJtsRosterForDate/;
  // ATT_MUTATORS now use queueAttendanceSync() instead of queueBackendSync(),
  // which only syncs the attendance table � workers/departments/clients/requests
  // are NOT re-uploaded on every attendance click. This saves 3-5 MB of
  // unchanged master data per attendance write.
  const wrapped=function(){
    const stack=new Error().stack||'';
    const isRenderCall=/renderDashboard|renderAttendance|renderApproval|renderJtsAttendance|renderJtsHistory|renderJtsPayroll|renderWorkers/.test(stack);
    original();
    if(isRenderCall)return;
    if(typeof LF_PHASE2!='undefined'&&LF_PHASE2===true){
      if(/submitAttendance|approveAttendance/.test(stack)){
        const dEl=document.getElementById('approvalDate')||document.getElementById('attendanceDate');
        const date=dEl?.value||new Date().toISOString().slice(0,10);
        const mode=stack.includes('approveAttendance')?'approve':'submit';
        lfSaveAttendanceApproval(date,mode).catch(e=>console.warn('[LF] lfSaveAttendanceApproval:',e.message));
        lfSaveAttendanceDate(date).catch(e=>console.warn('[LF] lfSaveAttendanceDate:',e.message));
        return;
      }
      if(ATT_MUTATORS.test(stack)){
        const dEl=document.getElementById('attendanceDate')||document.getElementById('supervisorDate')||document.getElementById('jtsDate');
        const date=dEl?.value||new Date().toISOString().slice(0,10);
        lfSaveAttendanceDate(date).catch(e=>console.warn('[LF] lfSaveAttendanceDate:',e.message));
        return;
      }
      lfSaveWorkers().catch(e=>console.warn('[LF] lfSaveWorkers:',e.message));
      lfSaveClients().catch(e=>console.warn('[LF] lfSaveClients:',e.message));
      lfSaveDepartments().catch(e=>console.warn('[LF] lfSaveDepartments:',e.message));
      lfSaveRequests().catch(e=>console.warn('[LF] lfSaveRequests:',e.message));
      lfSaveDeployments().catch(e=>console.warn('[LF] lfSaveDeployments:',e.message));
      lfSaveAudit().catch(e=>console.warn('[LF] lfSaveAudit:',e.message));
      return;
    }
    if(syncBusy)return;
    if(ATT_MUTATORS.test(stack)){ queueAttendanceSync(); return; }
    localStorage.setItem('labourforce_cloud_dirty','1');
    queueBackendSync();
  };
  wrapped.__lfWrapped=true; window.saveData=wrapped;
}

(async function bootLabourForceCloud(){
  // Honour ?refresh=1 by clearing caches so newly-applied migrations that
  // create views/tables (e.g. workers_public) are picked up without error noise.
  try{ const u=new URLSearchParams(location.search); if(u.get('refresh')==='1'){ lfClearMissingTables(); localStorage.removeItem('labourforce_cloud_dirty'); } }catch(_){}
  ensureConnectionUI();
  bindAuthGate();
  if(typeof supabase==='undefined'){
    toastSync('Supabase library unavailable');
    showAuthGate();
    const out=document.getElementById('gateError'); if(out)out.textContent='Supabase could not be loaded. Check your connection and refresh the page.';
    return;
  }
  labourForceSupabase=supabase.createClient(LABOUR_FORCE_SUPABASE_URL,LABOUR_FORCE_SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  window.labourForceSupabase = labourForceSupabase;
  installSaveHook();
  localStorage.removeItem('labourforce_cloud_dirty');
  labourForceSupabase.auth.onAuthStateChange((_event,session)=>{ labourForceSession=session; handleSession(session); });
  const {data}=await labourForceSupabase.auth.getSession();
  window.labourForceSession = data.session;
  await handleSession(data.session);
  window.addEventListener('online',()=>{
    if(!labourForceSession)return;
    if(typeof LF_PHASE2!='undefined'&&LF_PHASE2===true){
      hydrateFromBackend().catch(()=>{});
      hydrateAttendanceFromBackend().catch(()=>{});
    } else {
      syncLocalState();
    }
  });
  if(!(typeof LF_PHASE2!='undefined'&&LF_PHASE2===true)){
    window.addEventListener('beforeunload',()=>{
      if(labourForceSession && typeof takeAttendanceDirtyDates==='function'){
        const remaining=takeAttendanceDirtyDates();
        if(remaining.length)localStorage.setItem('labourforce_attendance_dirty_dates',JSON.stringify(remaining));
      }
      if(labourForceSession)localStorage.setItem('labourforce_cloud_dirty','1');
    });
  }
})();

window.queueBackendSync=queueBackendSync;
window.queueAttendanceSync=queueAttendanceSync;
window.syncAttendanceOnly=syncAttendanceOnly;
window.syncLocalState=syncLocalState;
window.lfSignOut=lfSignOut;
window.handleSession=handleSession;
window.hydrateAttendanceFromBackend=hydrateAttendanceFromBackend;
window.lfSaveWorkers=lfSaveWorkers;
window.lfSaveClients=lfSaveClients;
window.lfSaveDepartments=lfSaveDepartments;
window.lfSaveRequests=lfSaveRequests;
window.lfSaveDeployments=lfSaveDeployments;
window.lfSaveAudit=lfSaveAudit;
window.lfSaveAttendanceDate=lfSaveAttendanceDate;
window.lfSaveAttendanceApproval=lfSaveAttendanceApproval;


/* Bug-fix diagnostics: expose helpers so operators can verify the state from
   the browser console without a source-file read. */
window.lfSyncFailCount=lfSyncFailCount;
window.lfHasRatePermission=lfHasRatePermission;
window.lfClearMissingTables=lfClearMissingTables;
