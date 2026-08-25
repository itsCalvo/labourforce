/* ============================================================
   THE LABOUR FORCE — SUPERVISOR PORTAL (standalone, lightweight)
   Open access for now — login will be added later.
   - Workers appear ONLY via search (never listed upfront)
   - Attendance capture, verification, edit, cancel
   - Summary cards show aggregate counts
   ============================================================ */
(function(){
'use strict';

const sb = supabase.createClient(LABOUR_FORCE_SUPABASE_URL, LABOUR_FORCE_SUPABASE_ANON_KEY, {
  auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:false}
});

const state = {
  dayRows: [], searchResults: [], verifying: false, canVerify: true
};

/* ---------- tiny helpers ---------- */
function $(id){return document.getElementById(id);}
function toast(message){const t=$('toast');if(!t)return;t.textContent=message;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2400);}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'\u0026amp;','<':'\u0026lt;','>':'\u0026gt;',"'":'&#39;','"':'\u0026quot;'})[c])}
function todayStr(){return new Date().toISOString().slice(0,10);} /* matches main app convention */
function dateInput(){return $('attendanceDate').value||todayStr();}

/* ---------- data loading ---------- */
const DAY_SELECT='id,worker_id,status,hours_worked,overtime_hours,verification_status,verified_at,department_id,notes';
let daySelectHasVerification=true;

async function loadDay(){
  const date=dateInput();
  let query=sb.from('attendance').select(daySelectHasVerification?DAY_SELECT:DAY_SELECT.split(',verification_status,verified_at').join(''))
    .eq('attendance_date',date)
    .in('status',['present','worked','absent','pending'])
    .order('id',{ascending:true})
    .limit(400);
  let {data,error}=await query;
  if(error&&daySelectHasVerification&&/column|42703/i.test(error.message+' '+(error.code||''))){
    daySelectHasVerification=false;
    return loadDay();
  }
  if(error){toast('Could not load attendance: '+error.message);return;}
  state.dayRows=data||[];
  await renderDay();
  loadHistory();
}

async function expectedCount(){
  let query=sb.from('workers_public').select('id',{count:'exact',head:true}).eq('active',true);
  const {count,error}=await query;
  return error?null:(count||0);
}

async function renderDay(){
  const rows=state.dayRows;
  const present=rows.filter(r=>r.status==='present'||r.status==='worked').length;
  const absent=rows.filter(r=>r.status==='absent').length;
  const verified=rows.filter(r=>r.verification_status==='verified').length;
  const expected=await expectedCount();
  $('summary').innerHTML=
    `<div class="summary-card"><strong>${expected==null?'—':expected}</strong><span>Expected</span></div>`+
    `<div class="summary-card"><strong>${present}</strong><span>Present</span></div>`+
    `<div class="summary-card"><strong>${absent}</strong><span>Absent</span></div>`+
    `<div class="summary-card"><strong>${rows.length}</strong><span>Marked</span></div>`+
    `<div class="summary-card"><strong>${verified}</strong><span>Verified</span></div>`;
  const markedIds=new Set(rows.map(r=>r.worker_id));
  renderSearchResults(markedIds);
  const tbody=$('markedTable');
  if(!rows.length){
    tbody.innerHTML='<tr><td colspan="7"><div class="empty">No attendance yet for this date. Search above to add workers.</div></td></tr>';
    return;
  }
  /* Resolve names with one small batched lookup against the public view. */
  const ids=[...new Set(rows.map(r=>r.worker_id))];
  const nameMap=new Map();
  for(let i=0;i<ids.length;i+=100){
    const chunk=ids.slice(i,i+100);
    const {data:people}=await sb.from('workers_public').select('id,name,id_number,staff_no').in('id',chunk);
    (people||[]).forEach(p=>nameMap.set(p.id,p));
  }
  tbody.innerHTML=rows.map(r=>{
    const p=nameMap.get(r.worker_id)||{};
    const status=r.status==='worked'?'present':r.status;
    const verified=r.verification_status==='verified';
    const verifyBtn=(state.canVerify&&!verified&&(status==='present'))
      ?`<button class="success" onclick="window.__supVerify(${r.id})">Verify</button>`:'';
    const badge=verified?'<span class="status status-approved">Verified</span>':'<span class="status status-pending">Unverified</span>';
    return `<tr><td><strong>${esc(p.name||'Worker #'+r.worker_id)}</strong></td><td>${esc(p.id_number||p.staff_no||'—')}</td><td><span class="status status-${status==='present'?'worked':status==='absent'?'absent':'pending'}">${esc(status)}</span></td><td>${Number(r.hours_worked||0)}</td><td>${Number(r.overtime_hours||0)}</td><td>${badge}</td><td>${verifyBtn} <button class="secondary" onclick="window.__supEdit(${r.id})">Edit</button> <button class="danger" onclick="window.__supCancel(${r.id})">Cancel</button></td></tr>`;
  }).join('');
}

async function loadHistory(){
  const from=new Date(Date.now()-6*86400000).toISOString().slice(0,10);
  let query=sb.from('attendance').select(daySelectHasVerification?'attendance_date,worker_id,status,hours_worked,overtime_hours,verification_status':'attendance_date,worker_id,status,hours_worked,overtime_hours')
    .gte('attendance_date',from).lte('attendance_date',todayStr())
    .in('status',['present','worked','absent'])
    .order('attendance_date',{ascending:false})
    .limit(120);
  let {data,error}=await query;
  if(error&&daySelectHasVerification&&/column|42703/i.test(error.message+' '+(error.code||''))){
    daySelectHasVerification=false;
    return loadHistory();
  }
  if(error){$('historyTable').innerHTML='<tr><td colspan="5"><div class="empty">History unavailable.</div></td></tr>';return;}
  const rows=data||[];
  if(!rows.length){$('historyTable').innerHTML='<tr><td colspan="5"><div class="empty">No recent attendance in your scope.</div></td></tr>';return;}
  const ids=[...new Set(rows.map(r=>r.worker_id))];
  const nameMap=new Map();
  for(let i=0;i<ids.length;i+=100){
    const chunk=ids.slice(i,i+100);
    const {data:people}=await sb.from('workers_public').select('id,name').in('id',chunk);
    (people||[]).forEach(p=>nameMap.set(p.id,p.name));
  }
  $('historyTable').innerHTML=rows.map(r=>`<tr><td>${esc(r.attendance_date)}</td><td>${esc(nameMap.get(r.worker_id)||'Worker #'+r.worker_id)}</td><td><span class="status status-${(r.status==='worked'||r.status==='present')?'worked':r.status==='absent'?'absent':'pending'}">${esc(r.status==='worked'?'present':r.status)}</span></td><td>${Number(r.hours_worked||0)}</td><td>${r.verification_status==='verified'?'<span class="status status-approved">Yes</span>':'<span class="status status-pending">No</span>'}</td></tr>`).join('');
}

/* ---------- server-side worker search (LIMIT 10) ----------
   Workers are ONLY discoverable via search — never listed upfront. */
let searchTimer=null,lastQuery='';
function queueSearch(){
  clearTimeout(searchTimer);
  searchTimer=setTimeout(runSearch,300); /* debounce: one query per pause */
}
async function runSearch(){
  const q=$('workerSearch').value.trim();
  lastQuery=q;
  if(q.length<2){renderSearchResults(new Set());return;}
  const like='%'+q.replace(/[%_,()]/g,'')+'%';
  const {data,error}=await sb.from('workers_public')
    .select('id,name,id_number,staff_no,department,designation')
    .eq('active',true)
    .or(`name.ilike.${like},id_number.ilike.${like},staff_no.ilike.${like}`)
    .limit(10);
  if(error){toast('Search failed: '+error.message);return;}
  if(q!==lastQuery)return; /* stale response */
  state.searchResults=data||[];
  renderSearchResults(new Set(state.dayRows.map(r=>r.worker_id)));
}
function renderSearchResults(markedIds){
  const box=$('searchResults');
  const results=state.searchResults||[];
  if(!$('workerSearch').value.trim()||$('workerSearch').value.trim().length<2){box.innerHTML='';return;}
  const visible=results.filter(w=>!markedIds.has(w.id));
  box.innerHTML=visible.length?visible.map(w=>
    `<button class="worker-result" onclick="window.__supAdd(${w.id})"><span><strong>${esc(w.name)}</strong><small>${esc([w.id_number,w.staff_no,w.designation].filter(Boolean).join(' · ')||'—')}</small></span><b>Add to attendance</b></button>`
  ).join(''):'<div class="empty">No matching unmarked worker.</div>';
}

/* ---------- actions ---------- */
async function addWorker(workerId){
  const date=dateInput();
  const w=(state.searchResults||[]).find(x=>x.id===workerId);
  if(!w)return;
  /* Duplicate guard #1: explicit pre-check. */
  const {data:existing}=await sb.from('attendance').select('id').eq('worker_id',workerId).eq('attendance_date',date).maybeSingle();
  if(existing){toast('Worker already added to attendance.');return;}
  const base={worker_id:workerId,attendance_date:date,status:'present',overtime_hours:0};
  const attempts=[
    {...base,hours_worked:9,notes:null},
    {...base,hours_worked:9},
    base
  ];
  let inserted=false,lastError=null;
  for(const row of attempts){
    const {error}=await sb.from('attendance').insert(row);
    if(!error){inserted=true;break;}
    lastError=error;
    if(error.code==='23505'){toast('Worker already added to attendance.');return;} /* Duplicate guard #2: DB unique index */
    if(!/column|42703/i.test(error.message+' '+(error.code||'')))break; /* real failure — stop */
  }
  if(!inserted){toast(lastError?('Could not add worker: '+lastError.message):'Could not add worker.');return;}
  $('workerSearch').value='';
  $('searchResults').innerHTML='';
  toast(`${w.name} added to attendance.`);
  await loadDay();
}

async function verifyRow(rowId){
  if(state.verifying)return;
  state.verifying=true;
  try{
    const {error}=await sb.from('attendance')
      .update({verification_status:'verified',verified_at:new Date().toISOString()})
      .eq('id',rowId);
    if(error){toast('Verification rejected: '+error.message);return;}
    toast('Attendance verified.');
    await loadDay();
  }finally{state.verifying=false;}
}

async function editRow(rowId){
  const row=state.dayRows.find(r=>r.id===rowId);
  if(!row)return;
  const hours=prompt('Regular hours:',String(row.hours_worked??9));
  if(hours===null)return;
  const ot=prompt('Overtime hours:',String(row.overtime_hours??0));
  if(ot===null)return;
  const {error}=await sb.from('attendance').update({
    status:'present',
    hours_worked:Math.min(24,Math.max(0,Number(hours)||0)),
    overtime_hours:Math.max(0,Number(ot)||0)
  }).eq('id',rowId);
  if(error){toast('Update failed: '+error.message);return;}
  await loadDay();
}

async function cancelRow(rowId){
  const row=state.dayRows.find(r=>r.id===rowId);
  if(!row)return;
  if(!confirm('Cancel this attendance mark?'))return;
  const {error}=await sb.from('attendance').update({status:'pending',hours_worked:0,overtime_hours:0}).eq('id',rowId);
  if(error){toast('Cancel failed: '+error.message);return;}
  await loadDay();
}

/* expose handlers for inline onclick */
window.__supAdd=addWorker;
window.__supVerify=verifyRow;
window.__supEdit=editRow;
window.__supCancel=cancelRow;

/* ---------- boot (open access — no login) ---------- */
(async function boot(){
  $('attendanceDate').value=todayStr();
  $('workerSearch').addEventListener('input',queueSearch);
  $('attendanceDate').addEventListener('change',loadDay);
  await loadDay();
})();
})();