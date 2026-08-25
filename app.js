/* ============================================================
   THE LABOUR FORCE — CORE APP (performance-refactored)
   - Pages render on demand and unmount when left
   - Large tables are paginated
   - Searches are debounced
   - Expensive calculations are memoized
   All existing features and function names are preserved.
   ============================================================ */

function today(){return new Date().toISOString().split("T")[0]}
function money(value){return `KSh ${Number(value||0).toLocaleString()}`}
function toggleCompactView(){document.body.classList.toggle('compact-view');localStorage.setItem('labourforce_compact_view',document.body.classList.contains('compact-view')?'1':'0')}
if(localStorage.getItem('labourforce_compact_view')==='1')document.body.classList.add('compact-view');
function esc(value){return String(value??"").replace(/[&<>'"]/g,c=>({'&':'\u0026amp;','<':'\u0026lt;','>':'\u0026gt;',"'":'&#39;','"':'\u0026quot;'})[c])}
function showToast(message){const t=document.getElementById("toast");t.textContent=message;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2500)}
function formatDateTime(value){if(!value)return "—";return new Date(value).toLocaleString("en-KE",{dateStyle:"medium",timeStyle:"short"})}
function clientById(id){return clients.find(c=>Number(c.id)===Number(id))}
function requestById(id){return labourRequests.find(r=>Number(r.id)===Number(id))}
function requestNo(){let max=0;labourRequests.forEach(r=>{const m=String(r.requestNo||"").match(/^LR-(\d+)$/);if(m)max=Math.max(max,Number(m[1]))});return `LR-${String(max+1).padStart(4,"0")}`}
function employeeNo(){let max=0;workers.forEach(w=>{const m=String(w.employeeNo||"").match(/^WK(\d+)$/i);if(m)max=Math.max(max,Number(m[1]))});return `WK${String(max+1).padStart(3,"0")}`}
function currentRoleName(){return String(window.lfCurrentRole||'').toLowerCase();}
function canManageWorkerMasterData(){const role=currentRoleName();return ['super_admin','administrator','accounts','hr','human_resources'].includes(role);}
function canCaptureAttendance(){const role=currentRoleName();return ['super_admin','administrator','accounts','team_leader'].includes(role) || !role;}

/* ---------- verification permission model ----------
   Capture (team_leader and above) marks attendance.
   Verify requires accounts / administrator / super_admin,
   mirroring the attendance.approve permission holders. */
function canVerifyAttendance(){const role=currentRoleName();return ['super_admin','administrator','accounts'].includes(role)||!role;}
function verifierIdentity(){const p=window.lfCurrentProfile;if(p&&(p.full_name||p.email))return{name:p.full_name||p.email,id:p.id||null};return{name:'Local administrator',id:null};}
function workerNameOf(id){const w=workers.find(x=>Number(x.id)===Number(id));return w?`${w.employeeNo||''} ${w.name}`.trim():`Worker #${id}`;}

/* ---------- tiny utilities ---------- */
function debounce(fn,wait){let t=null;return function(...args){clearTimeout(t);t=setTimeout(()=>fn.apply(this,args),wait||300);};}

/* Read-only attendance lookup: never mutates state during render. */
const LF_EMPTY_RECORD={status:'pending',hours:0,overtime:0,overtimeHours:0};
function peekAttendance(date,id){const day=attendance[date];const r=day&&day.records?day.records[id]:null;return r||LF_EMPTY_RECORD;}

/* ---------- pagination ---------- */
const lfPagerState={};
const LF_PAGER_RERENDER={};
function lfPaginate(key,rows,size){const st=lfPagerState[key]||(lfPagerState[key]={page:1});const pages=Math.max(1,Math.ceil(rows.length/size));st.pages=pages;st.total=rows.length;if(st.page>pages)st.page=pages;return rows.slice((st.page-1)*size,st.page*size);}
function lfRenderPager(pagerId,key,label){const el=document.getElementById(pagerId);if(!el)return;const st=lfPagerState[key];if(!st||!st.total){el.innerHTML='';return;}el.innerHTML=`<span class="lf-pager-info">${st.total} ${label||'rows'} · page ${st.page} of ${st.pages}</span><button class="secondary" ${st.page<=1?'disabled':''} onclick="lfGotoPage('${key}',${st.page-1})">‹ Prev</button><button class="secondary" ${st.page>=st.pages?'disabled':''} onclick="lfGotoPage('${key}',${st.page+1})">Next ›</button>`;}
function lfGotoPage(key,page){const st=lfPagerState[key];if(!st)return;st.page=Math.min(Math.max(1,page),st.pages||1);const fn=LF_PAGER_RERENDER[key];if(typeof fn==='function')fn();}

/* Re-render a page only if the user is currently looking at it.
   Every page re-renders anyway when navigated to, so cross-page
   render cascades after each action were pure wasted CPU. */
function rerenderIfActive(pageId){if(lfCurrentPage===pageId){const r=LF_PAGE_RENDER[pageId];if(typeof r==='function')r();}}

/* ---------- lazy modal factory ----------
   Modals live in <template> tags (zero render cost). The first time
   a modal is opened its markup is instantiated into the DOM once. */
function ensureModal(id){if(document.getElementById(id))return;const tpl=document.getElementById('tpl-'+id);if(!tpl)return;document.body.appendChild(tpl.content.firstElementChild.cloneNode(true));}
function closeModal(id){const el=document.getElementById(id);if(el)el.classList.remove("show")}
/* Backdrop click-to-close, delegated so lazily-created modals work too. */
document.addEventListener('click',e=>{if(e.target&&e.target.classList&&e.target.classList.contains('modal-overlay'))e.target.classList.remove('show');});

/* ---------- attendance data model (unchanged) ---------- */
function getDayRecord(date){if(!attendance[date])attendance[date]={status:"draft",submitted:false,submittedAt:null,approved:false,approvedAt:null,records:{}};if(!attendance[date].records)attendance[date].records={};return attendance[date]}
function getAttendance(date,id){const day=getDayRecord(date);if(!day.records[id])day.records[id]={status:"pending",hours:0,overtime:0};return day.records[id]}
function ensureJtsRosterForDate(date){const active=workers.filter(w=>w.active);if(!active.length)return;active.forEach(w=>{const record=getAttendance(date,w.id);if(!record.status)record.status="pending";record.hours=Number(record.hours||0);record.overtime=Number(record.overtime||0);});}

/* ---------- navigation: render on demand, unmount on leave ---------- */
const LF_PAGE_TITLES={dashboard:'Executive Dashboard',requests:'Labour Requests',deployments:'Worker Deployments',availability:'Workforce Availability',exceptions:'Exception Centre',attendance:'Daily Attendance','jts':'JTS Daily Roll Call','jts-history':'JTS History & Disputes','jts-payroll':'JTS Payroll Review',approval:'Supervisor Approval',workers:'Workers',clients:'Clients / Mother Companies',departments:'Departments',payroll:'Payroll',users:'Users & Access',reports:'Reports',audit:'Audit Trail','worker-portal':'My Attendance',supervisor:'Supervisor Portal'};
const LF_PAGE_RENDER={
 dashboard:()=>renderDashboard(),
 requests:()=>renderRequests(),
 deployments:()=>renderDeployments(),
 availability:()=>renderAvailability(),
 exceptions:()=>renderExceptions(),
 attendance:()=>renderAttendance(),
 'jts':()=>renderJtsAttendance(),
 'jts-history':()=>renderJtsHistory(),
 'jts-payroll':()=>renderJtsPayroll(),
 approval:()=>renderApproval(),
 workers:()=>renderWorkers(),
 clients:()=>renderClients(),
 departments:()=>renderDepartments(),
 payroll:()=>renderPayroll(),
 users:()=>{if(typeof renderUsers==='function')renderUsers();},
 reports:()=>renderReports(),
 audit:()=>renderAudit(),
 'worker-portal':()=>renderWorkerPortal(),
 supervisor:()=>renderSupervisorPortal()
};
/* Heavy containers cleared when leaving a page so hidden pages cost nothing. */
const LF_PAGE_CLEAR={
 dashboard:['dashboardDesignationGroups','dashboardAttendance','dashboardRequestsTable','dashboardAttendancePager'],
 requests:['requestsTable','requestsPager'],
 attendance:['attendanceTable','attendancePager'],
 approval:['approvalTable','approvalPager'],
 'jts':['jtsSummary','jtsAttendanceTable','jtsAttendancePager'],
 'jts-history':['jtsRollup','jtsHistoryTable','jtsHistoryPager'],
 'jts-payroll':['jtsPayrollSummary','jtsPayrollTable','jtsPayrollPager'],
 supervisor:['supervisorSummary','supervisorSearchResults','supervisorTable','supervisorPager'],
 'worker-portal':['workerPortalSummary','workerPortalTable','workerPortalPager'],
 workers:['workersTable','workersPager'],
 clients:['clientsTable'],
 departments:['departmentsTable'],
 payroll:['payrollTable','payrollPager'],
 deployments:['deploymentsTable','deploymentsPager'],
 availability:['availabilityCards','availabilityTable','availabilityPager'],
 exceptions:['exceptionCards','exceptionsTable'],
 audit:['auditTable','auditPager'],
 users:['userSummaryCards','usersTable','usersPager']
};
let lfCurrentPage=null;
function showPage(id,button){
 const page=document.getElementById(id);if(!page)return;
 if(lfCurrentPage&&lfCurrentPage!==id){(LF_PAGE_CLEAR[lfCurrentPage]||[]).forEach(cid=>{const el=document.getElementById(cid);if(el)el.innerHTML='';});}
 document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
 page.classList.add('active');
 document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('active'));
 if(button)button.classList.add('active');
 else{const nav=[...document.querySelectorAll('.nav button')].find(b=>(b.getAttribute('onclick')||'').includes(`'${id}'`));if(nav)nav.classList.add('active');}
 document.getElementById('pageTitle').textContent=LF_PAGE_TITLES[id]||id;
 lfCurrentPage=id;
 try{const r=LF_PAGE_RENDER[id];if(typeof r==='function')r();}catch(error){console.error('[Labour Force] render failed for '+id,error);}
}
window.showPage=showPage;

/* ---------- filter population ---------- */
function populateFilters(){const ids=["departmentFilter","workerDepartmentFilter","approvalDepartment","requestDepartment","deploymentDepartment"];ids.forEach(id=>{const el=document.getElementById(id);if(!el)return;const current=el.value;el.innerHTML=(id.includes("Filter")||id==="approvalDepartment")?'<option value="all">All Departments</option>':'';if(id==="requestDepartment"||id==="deploymentDepartment")el.innerHTML="";departments.forEach(d=>el.innerHTML+=`<option value="${esc(d.name)}">${esc(d.name)}</option>`);if([...el.options].some(o=>o.value===current))el.value=current});const wd=document.getElementById("workerDepartment");if(wd){const current=wd.value;wd.innerHTML="";departments.forEach(d=>wd.innerHTML+=`<option value="${esc(d.name)}">${esc(d.name)}</option>`);if([...wd.options].some(o=>o.value===current))wd.value=current}const parent=document.getElementById("departmentParent");if(parent){parent.innerHTML='<option value="">None</option>';departments.forEach(d=>parent.innerHTML+=`<option value="${esc(d.name)}">${esc(d.name)}</option>`)}populateClientSelects()}
function populateClientSelects(){const ids=["requestClient","deploymentClient"];ids.forEach(id=>{const el=document.getElementById(id);if(!el)return;const current=el.value;el.innerHTML="<option value=''>Select client</option>";clients.filter(c=>c.active).forEach(c=>el.innerHTML+=`<option value="${c.id}">${esc(c.name)}</option>`);if([...el.options].some(o=>o.value===current))el.value=current});const req=document.getElementById("deploymentRequest");if(req){const current=req.value;req.innerHTML='<option value="">Direct deployment — no request</option>';labourRequests.filter(r=>!["Cancelled","Completed"].includes(r.status)).forEach(r=>{const c=clientById(r.clientId);req.innerHTML+=`<option value="${r.id}">${esc(r.requestNo)} — ${esc(c?.name||"Unknown client")}</option>`});if([...req.options].some(o=>o.value===current))req.value=current}}

/* ---------- dashboard (memoized) ---------- */
let lfDashCache={key:'',present:[],activeCount:0,pendingCount:0,groupsHtml:'',designations:[],departmentsArr:[]};
function renderFuturisticDashboard(){
 const dateEl=document.getElementById('dashboardDate');const date=dateEl?.value||today();
 const search=(document.getElementById('dashboardWorkerSearch')?.value||'').toLowerCase().trim();
 const designation=document.getElementById('dashboardDesignationFilter')?.value||'all';
 const department=document.getElementById('dashboardDepartmentFilter')?.value||'all';
 const cacheKey=date+'|'+lfDataVersion;
 if(lfDashCache.key!==cacheKey){
   const active=workers.filter(w=>w.active);
   const present=active.map(w=>({w,r:peekAttendance(date,w.id)})).filter(x=>x.r.status==='present'||x.r.status==='worked');
   const pendingCount=active.reduce((n,w)=>n+(peekAttendance(date,w.id).status==='pending'?1:0),0);
   const groupMap={};present.forEach(({w})=>{const k=w.designation||'Unassigned';groupMap[k]=(groupMap[k]||0)+1;});
   const groupsHtml=Object.entries(groupMap).sort((a,b)=>b[1]-a[1]).map(([name,count])=>`<button class="designation-pulse" onclick="document.getElementById('dashboardDesignationFilter').value=${JSON.stringify(name).replace(/"/g,'"')};renderFuturisticDashboard()"><span>${esc(name)}</span><strong>${count}</strong><small>present</small></button>`).join('');
   lfDashCache={key:cacheKey,present,activeCount:active.length,pendingCount,groupsHtml,
     designations:[...new Set(active.map(w=>w.designation).filter(Boolean))].sort(),
     departmentsArr:[...new Set(active.map(w=>w.department).filter(Boolean))].sort()};
 }
 document.getElementById('dashboardWorkers').textContent=lfDashCache.activeCount;
 document.getElementById('dashboardRequests').textContent=labourRequests.filter(r=>r.status==='Pending').length;
 document.getElementById('dashboardWorked').textContent=lfDashCache.present.length;
 document.getElementById('dashboardMissing').textContent=lfDashCache.pendingCount;
 /* Designation chips + filter options only rebuild when data changes, not per keystroke. */
 const groups=document.getElementById('dashboardDesignationGroups');
 if(groups)groups.innerHTML=lfDashCache.groupsHtml||'<div class="empty">No present workers recorded for this date.</div>';
 const fill=(id,values,label)=>{const select=document.getElementById(id);if(!select)return;const current=select.value;select.innerHTML=`<option value="all">All ${label}</option>`+values.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');if(values.includes(current))select.value=current};
 fill('dashboardDesignationFilter',lfDashCache.designations,'designations');
 fill('dashboardDepartmentFilter',lfDashCache.departmentsArr,'departments');
 const filtered=lfDashCache.present.filter(x=>(designation==='all'||x.w.designation===designation)&&(department==='all'||x.w.department===department)&&(!search||[x.w.name,x.w.idNumber,x.w.employeeNo,x.w.designation,x.w.department].some(v=>String(v||'').toLowerCase().includes(search))));
 const pageRows=lfPaginate('dashAtt',filtered,25);
 const table=document.getElementById('dashboardAttendance');
 if(table)table.innerHTML=pageRows.length?pageRows.map(({w,r})=>`<tr><td><strong>${esc(w.name)}</strong></td><td>${esc(w.idNumber||w.employeeNo||'—')}</td><td>${esc(w.designation||'Unassigned')}</td><td>${esc(w.department||'—')}</td><td>${Number(r.hours||0)}</td><td>${Number(r.overtime||0)}</td><td><span class="status status-worked">Present</span></td></tr>`).join(''):`<tr><td colspan="7"><div class="empty">No present workers match the current view.</div></td></tr>`;
 lfRenderPager('dashboardAttendancePager','dashAtt','present workers');
 const rt=document.getElementById('dashboardRequestsTable');
 if(rt&&!rt.childElementCount){rt.innerHTML='';labourRequests.slice(-5).reverse().forEach(r=>{const c=clientById(r.clientId);rt.innerHTML+=`<tr><td><strong>${esc(r.requestNo)}</strong></td><td>${esc(c?.name||'—')}</td><td>${esc(r.department)}</td><td>${r.workersRequired}</td><td>${esc(r.startDate)}</td><td><span class="status ${statusClass(r.status)}">${esc(r.status)}</span></td></tr>`});}
}
function renderDashboard(){renderFuturisticDashboard();}

/* ---------- labour requests ---------- */
function statusClass(s){return s==="Pending"?"status-pending":s==="Approved"?"status-approved":s==="Allocated"?"status-allocated":s==="Cancelled"?"status-cancelled":s==="Completed"?"status-approved":"status-submitted"}
function renderRequests(){
 const filterEl=document.getElementById("requestStatusFilter");if(!filterEl)return;
 const filter=filterEl.value;const table=document.getElementById("requestsTable");if(!table)return;
 const rows=labourRequests.filter(r=>filter==="all"||r.status===filter);
 const pageRows=lfPaginate('requests',rows,20);
 table.innerHTML=pageRows.length?pageRows.map(r=>{
   const c=clientById(r.clientId);const allocated=r.allocatedWorkerIds?.length||0;
   let actions=`<button class="secondary" onclick="editRequest(${r.id})">Edit</button>`;
   if(r.status==="Pending")actions+=` <button class="success" onclick="approveRequest(${r.id})">Approve</button>`;
   if(["Approved","Allocated"].includes(r.status))actions+=` <button class="primary" onclick="openAllocationModal(${r.id})">Allocate</button>`;
   if(!["Completed","Cancelled"].includes(r.status))actions+=` <button class="danger" onclick="cancelRequest(${r.id})">Cancel</button>`;
   if(r.status==="Allocated")actions+=` <button class="success" onclick="completeRequest(${r.id})">Complete</button>`;
   return `<tr><td><strong>${esc(r.requestNo)}</strong><br><small class="muted">${formatDateTime(r.createdAt)}</small></td><td>${esc(c?.name||"—")}</td><td>${esc(r.department)}</td><td>${esc(r.classification)}</td><td>${r.workersRequired}<br><small class="muted">${allocated} allocated</small></td><td>${esc(r.startDate)}</td><td>${r.duration} day(s)</td><td><span class="status ${statusClass(r.status)}">${esc(r.status)}</span></td><td>${actions}</td></tr>`;
 }).join(''):'<tr><td colspan="9"><div class="empty">No labour requests found.</div></td></tr>';
 lfRenderPager('requestsPager','requests','requests');
}
function openRequestModal(){ensureModal('requestModal');document.getElementById("editingRequestId").value="";document.getElementById("requestModalTitle").textContent="New Labour Request";populateFilters();document.getElementById("requestClient").value=clients.find(c=>c.active)?.id||"";document.getElementById("requestWorkers").value=1;document.getElementById("requestClassification").value="Skilled";document.getElementById("requestStartDate").value=today();document.getElementById("requestDuration").value=1;document.getElementById("requestShift").value="Day";document.getElementById("requestNotes").value="";document.getElementById("requestModal").classList.add("show")}
function editRequest(id){const r=requestById(id);if(!r)return;openRequestModal();document.getElementById("editingRequestId").value=id;document.getElementById("requestModalTitle").textContent=`Edit ${r.requestNo}`;document.getElementById("requestClient").value=r.clientId;document.getElementById("requestDepartment").value=r.department;document.getElementById("requestWorkers").value=r.workersRequired;document.getElementById("requestClassification").value=r.classification;document.getElementById("requestStartDate").value=r.startDate;document.getElementById("requestDuration").value=r.duration;document.getElementById("requestShift").value=r.shift;document.getElementById("requestNotes").value=r.notes||""}
function saveRequest(){const id=document.getElementById("editingRequestId").value;const clientId=Number(document.getElementById("requestClient").value);const department=document.getElementById("requestDepartment").value;const workersRequired=Number(document.getElementById("requestWorkers").value);const classification=document.getElementById("requestClassification").value;const startDate=document.getElementById("requestStartDate").value;const duration=Number(document.getElementById("requestDuration").value);const shift=document.getElementById("requestShift").value;const notes=document.getElementById("requestNotes").value.trim();if(!clientId||!department||workersRequired<1||!startDate||duration<1){alert("Complete the required request details.");return}if(id){const r=requestById(id);if(r){r.clientId=clientId;r.department=department;r.workersRequired=workersRequired;r.classification=classification;r.startDate=startDate;r.duration=duration;r.shift=shift;r.notes=notes;showToast(`${r.requestNo} updated.`)}}else{const r={id:Date.now(),requestNo:requestNo(),clientId,department,workersRequired,classification,startDate,duration,shift,notes,status:"Pending",allocatedWorkerIds:[],createdAt:new Date().toISOString()};labourRequests.push(r);showToast(`${r.requestNo} created.`)}saveData();closeModal("requestModal");renderRequests()}
function approveRequest(id){const r=requestById(id);if(!r)return;r.status="Approved";saveData();renderRequests();showToast(`${r.requestNo} approved.`)}
function cancelRequest(id){const r=requestById(id);if(!r)return;if(!confirm(`Cancel ${r.requestNo}?`))return;r.status="Cancelled";saveData();renderRequests();showToast(`${r.requestNo} cancelled.`)}
function completeRequest(id){const r=requestById(id);if(!r)return;r.status="Completed";saveData();renderRequests();showToast(`${r.requestNo} completed.`)}
function openAllocationModal(id){ensureModal('allocationModal');const r=requestById(id);if(!r)return;if(r.status!=="Approved"&&r.status!=="Allocated"){alert("Approve the request before allocation.");return}document.getElementById("allocationRequestId").value=id;const c=clientById(r.clientId);document.getElementById("allocationSummary").innerHTML=`<strong>${esc(r.requestNo)}</strong> — ${esc(c?.name||"Unknown client")} · ${esc(r.department)} · ${r.workersRequired} required · ${r.allocatedWorkerIds?.length||0} currently allocated`;const picker=document.getElementById("workerPicker");picker.innerHTML="";const eligible=workers.filter(w=>w.active&&(r.classification==="Any"||w.classification===r.classification));if(!eligible.length){picker.innerHTML='<div class="empty">No eligible active workers found.</div>'}else picker.innerHTML=eligible.map(w=>{const checked=(r.allocatedWorkerIds||[]).includes(w.id);return `<label class="worker-option"><input type="checkbox" value="${w.id}" ${checked?"checked":""}><span><strong>${esc(w.employeeNo)} — ${esc(w.name)}</strong><small>${esc(w.department)} · ${esc(w.classification)}</small></span></label>`}).join('');document.getElementById("allocationModal").classList.add("show")}
function saveAllocation(){const r=requestById(Number(document.getElementById("allocationRequestId").value));if(!r)return;const ids=[...document.querySelectorAll("#workerPicker input:checked")].map(x=>Number(x.value));if(ids.length>r.workersRequired){alert(`This request requires only ${r.workersRequired} worker(s).`);return}r.allocatedWorkerIds=ids;r.status=ids.length?"Allocated":"Approved";ids.forEach(id=>{const w=workers.find(x=>x.id===id);if(w){w.client=clientById(r.clientId)?.name||"";w.assignment=`${r.requestNo} — ${r.department}`;w.deploymentStart=r.startDate;w.department=r.department}});saveData();closeModal("allocationModal");renderRequests();showToast(`${ids.length} worker(s) allocated to ${r.requestNo}.`)}

/* ---------- daily attendance + VERIFICATION ---------- */
function verificationBadge(r){return r.verification_status==='verified'
 ?`<span class="status status-approved" title="Verified ${esc(formatDateTime(r.verified_at))} by ${esc(r.verified_by_name||'')}">Verified</span>`
 :`<span class="status status-pending">Unverified</span>`;}
function renderAttendance(){
 const dateEl=document.getElementById("attendanceDate");if(!dateEl)return;
 const date=dateEl.value||today(),filter=document.getElementById("departmentFilter")?.value||'all';
 const day=getDayRecord(date),table=document.getElementById("attendanceTable");if(!table)return;
 let worked=0,absent=0,missing=0,overtime=0,unverified=0;
 const rows=workers.filter(w=>w.active).filter(w=>filter==="all"||w.department===filter).map(w=>{
   const r=peekAttendance(date,w.id);
   if(r.status==="worked"){worked++;if(r.verification_status!=='verified')unverified++;}
   else if(r.status==="absent")absent++;
   else missing++;
   overtime+=Number(r.overtime)||0;
   return {w,r};
 });
 const locked=day.submitted||day.approved;
 const pageRows=lfPaginate('attendance',rows,25);
 table.innerHTML=pageRows.length?pageRows.map(({w,r})=>{
   const regular=r.status==="worked"?w.rate:0,ot=Number(r.overtime||0)*w.otRate,total=regular+ot;
   const canVerify=canVerifyAttendance()&&!locked&&(r.status==="worked"||r.status==="present")&&r.verification_status!=='verified';
   const verifyCell=verificationBadge(r)+(canVerify?` <button class="success" onclick="verifyAttendanceRecord('${date}',${w.id})">Verify</button>`:'');
   return `<tr><td><strong>${esc(w.name)}</strong><br><small class="muted">${esc(w.employeeNo)}</small></td><td>${esc(w.department)}</td><td>${esc(w.classification)}</td><td>${money(w.rate)}</td><td><select ${locked?"disabled":""} onchange="changeAttendanceStatus('${date}',${w.id},this.value)"><option value="pending" ${r.status==="pending"?"selected":""}>Missing</option><option value="worked" ${r.status==="worked"?"selected":""}>Worked</option><option value="absent" ${r.status==="absent"?"selected":""}>Absent</option></select></td><td><input type="number" min="0" step="0.5" value="${r.overtime}" ${locked?"disabled":""} onchange="changeOvertime('${date}',${w.id},this.value)"></td><td>${money(ot)}</td><td><strong>${money(total)}</strong></td><td>${verifyCell}</td></tr>`;
 }).join(''):'<tr><td colspan="9"><div class="empty">No workers match this view.</div></td></tr>';
 document.getElementById("workedCount").textContent=worked;
 document.getElementById("absentCount").textContent=absent;
 document.getElementById("missingCount").textContent=missing;
 document.getElementById("overtimeCount").textContent=overtime;
 const uv=document.getElementById("unverifiedCount");if(uv)uv.textContent=unverified;
 lfRenderPager('attendancePager','attendance','workers');
}
function changeAttendanceStatus(date,id,status){const day=getDayRecord(date);if(day.submitted||day.approved)return;const r=getAttendance(date,id);r.status=status;if(status!=='worked'&&status!=='present'){r.verification_status='unverified';r.verified_by_name=null;r.verified_at=null;}markAttendanceDirtyDate(date);saveData();renderAttendance()}
function changeOvertime(date,id,hours){const day=getDayRecord(date);if(day.submitted||day.approved)return;getAttendance(date,id).overtime=Math.max(0,Number(hours)||0);markAttendanceDirtyDate(date);saveData();renderAttendance()}
function markAllWorked(){const date=document.getElementById("attendanceDate").value||today(),day=getDayRecord(date);if(day.submitted||day.approved){alert("This attendance has already been submitted or approved.");return}workers.filter(w=>w.active).forEach(w=>getAttendance(date,w.id).status="worked");markAttendanceDirtyDate(date);saveData();renderAttendance();showToast("All active workers marked as worked.")}
function submitAttendance(){const date=document.getElementById("attendanceDate").value||today(),day=getDayRecord(date);const missing=workers.filter(w=>w.active).filter(w=>peekAttendance(date,w.id).status==="pending");if(missing.length){alert(`${missing.length} worker(s) still have missing attendance.`);return}if(day.submitted){alert("Attendance has already been submitted.");return}day.submitted=true;day.status="submitted";day.submittedAt=new Date().toISOString();markAttendanceDirtyDate(date);saveData();renderAttendance();rerenderIfActive('approval');showToast("Attendance submitted for supervisor approval.")}

/* Verify a single attendance record. Records who verified and when,
   writes an audit entry, and flags the date for cloud sync. */
function verifyAttendanceRecord(date,workerId){
 if(!canVerifyAttendance()){showToast('You do not have permission to verify attendance.');return;}
 const day=getDayRecord(date);const r=day.records[workerId];
 if(!r||(r.status!=="worked"&&r.status!=="present")){showToast('Only worked records can be verified.');return;}
 if(day.approved){showToast('This attendance day is already approved.');return;}
 if(r.verification_status==='verified'){showToast('Record already verified.');return;}
 const who=verifierIdentity();
 r.verification_status='verified';r.verified_by_name=who.name;r.verified_by_id=who.id;r.verified_at=new Date().toISOString();
 markAttendanceDirtyDate(date);saveData();
 audit('Attendance verified',date,`${workerNameOf(workerId)} verified by ${who.name}`);
 renderAttendance();rerenderIfActive('approval');showToast('Attendance record verified.');
}
/* Verify every worked record for a date in one pass. */
function verifyAllWorked(dateOverride){
 const date=dateOverride||document.getElementById("attendanceDate")?.value||today();
 if(!canVerifyAttendance()){showToast('You do not have permission to verify attendance.');return;}
 const day=getDayRecord(date);
 if(day.approved){showToast('This attendance day is already approved.');return;}
 let count=0;const who=verifierIdentity();
 workers.filter(w=>w.active).forEach(w=>{const r=day.records[w.id];if(r&&(r.status==='worked'||r.status==='present')&&r.verification_status!=='verified'){r.verification_status='verified';r.verified_by_name=who.name;r.verified_by_id=who.id;r.verified_at=new Date().toISOString();count++;}});
 if(!count){showToast('No unverified worked records for this date.');return;}
 markAttendanceDirtyDate(date);saveData();
 audit('Attendance bulk verified',date,`${count} record(s) verified by ${who.name}`);
 renderAttendance();rerenderIfActive('approval');showToast(`${count} attendance record(s) verified.`);
}
function verifyRemainingApproval(){const date=document.getElementById("approvalDate")?.value||today();verifyAllWorked(date);}

/* ---------- approval ---------- */
function renderApproval(){
 const dateEl=document.getElementById("approvalDate");if(!dateEl)return;
 const date=dateEl.value||today(),department=document.getElementById("approvalDepartment")?.value||'all';
 const day=getDayRecord(date),table=document.getElementById("approvalTable");if(!table)return;
 let unverified=0;
 const rows=workers.filter(w=>w.active).filter(w=>department==="all"||w.department===department).map(w=>{
   const r=peekAttendance(date,w.id);
   if((r.status==="worked"||r.status==="present")&&r.verification_status!=='verified')unverified++;
   const regular=r.status==="worked"?w.rate:0,ot=Number(r.overtime||0)*w.otRate,total=regular+ot;
   const a=day.approved?"Approved":day.submitted?"Pending":"Not Submitted";
   return {w,r,total,a};
 });
 const pageRows=lfPaginate('approval',rows,25);
 table.innerHTML=pageRows.length?pageRows.map(({w,r,total,a})=>`<tr><td><strong>${esc(w.name)}</strong><br><small class="muted">${esc(w.employeeNo)}</small></td><td>${esc(w.department)}</td><td><span class="status ${r.status==="worked"||r.status==="present"?"status-worked":r.status==="absent"?"status-absent":"status-missing"}">${r.status==="worked"||r.status==="present"?"Worked":r.status==="absent"?"Absent":"Missing"}</span></td><td>${r.overtime||0}</td><td>${money(total)}</td><td>${verificationBadge(r)}</td><td><span class="status ${day.approved?"status-approved":day.submitted?"status-submitted":"status-missing"}">${a}</span></td></tr>`).join(''):'<tr><td colspan="7"><div class="empty">No workers match this view.</div></td></tr>';
 lfRenderPager('approvalPager','approval','workers');
 document.getElementById("approvalTitle").textContent=day.approved?"Attendance Approved":day.submitted?"Attendance Awaiting Approval":"Attendance Not Submitted";
 document.getElementById("approvalDescription").textContent=day.approved?`Approved on ${formatDateTime(day.approvedAt)}`:day.submitted?(unverified?`Submitted on ${formatDateTime(day.submittedAt)} · ${unverified} record(s) still unverified`:`Submitted on ${formatDateTime(day.submittedAt)}`):"Attendance must be recorded and verified before it can be approved.";
}
function approveAttendance(){
 const date=document.getElementById("approvalDate").value||today(),day=getDayRecord(date);
 if(!day.submitted){alert("Attendance must be submitted before approval.");return}
 if(day.approved){alert("Attendance is already approved.");return}
 const missing=workers.filter(w=>w.active).filter(w=>peekAttendance(date,w.id).status==="pending");
 if(missing.length){alert("Attendance contains missing records.");return}
 const unverified=workers.filter(w=>w.active).filter(w=>{const r=day.records[w.id];return r&&(r.status==='worked'||r.status==='present')&&r.verification_status!=='verified'});
 if(unverified.length){alert(`${unverified.length} worked record(s) are not verified yet.

Verified attendance is required before approval. Use "Verify Remaining" to verify them first.`);return}
 day.approved=true;day.status="approved";day.approvedAt=new Date().toISOString();
 markAttendanceDirtyDate(date);saveData();
 audit('Attendance approved',date,'Attendance approved after verification');
 renderApproval();rerenderIfActive('attendance');rerenderIfActive('dashboard');showToast("Attendance approved successfully.")
}

/* ---------- workers (paginated bulk view) ---------- */
function renderWorkers(){renderWorkersBulk();}
function visibleWorkers(){const search=(document.getElementById("workerSearch")?.value||"").toLowerCase(),department=document.getElementById("workerDepartmentFilter")?.value||"all";return workers.filter(w=>(w.name||"").toLowerCase().includes(search)||(w.employeeNo||"").toLowerCase().includes(search)||(w.idNumber||"").toLowerCase().includes(search)).filter(w=>department==="all"||w.department===department)}
function renderWorkersBulk(){
 const table=document.getElementById("workersTable");if(!table)return;
 const rows=visibleWorkers();
 const pageRows=lfPaginate('workers',rows,25);
 const selected=new Set([...document.querySelectorAll(".worker-select:checked")].map(input=>Number(input.value)));
 table.innerHTML=pageRows.length?pageRows.map(w=>{
   const deployment=w.client?`${esc(w.client)}<br><small class="muted">${esc(w.assignment||"")}</small>`:'<span class="muted">Unassigned</span>';
   const editBtn=canManageWorkerMasterData()?`<button class="secondary" onclick="editWorker(${w.id})">Edit</button>`:`<button class="secondary" onclick="reportJtsCorrection(${w.id})">Request change</button>`;
   return `<tr><td><input class="worker-select" type="checkbox" value="${w.id}" ${selected.has(Number(w.id))?"checked":""} onchange="updateWorkerSelection()"></td><td><strong>${esc(w.employeeNo)}</strong></td><td><strong>${esc(w.name)}</strong><br><small class="muted">${esc(w.idNumber||"ID not set")} · ${esc(w.joinDate||"—")}</small></td><td>${esc(w.department)}</td><td>${esc(w.designation||w.classification||"")}</td><td>${money(w.rate)}</td><td>${money(w.otRate)}</td><td>${deployment}</td><td><span class="status ${w.active?"status-worked":"status-absent"}">${w.active?"Active":"Inactive"}</span></td><td>${editBtn} <button class="primary" onclick="openDeploymentModal(${w.id})">Move</button></td></tr>`;
 }).join(''):'<tr><td colspan="10"><div class="empty">No workers found.</div></td></tr>';
 lfRenderPager('workersPager','workers','workers');
 updateWorkerSelection();
}
function updateWorkerSelection(){const selected=document.querySelectorAll(".worker-select:checked").length,count=document.getElementById("workerSelectionCount");if(count)count.textContent=`${selected} selected`;}
function toggleAllWorkers(checked){document.querySelectorAll(".worker-select").forEach(input=>input.checked=checked);updateWorkerSelection();}
function applyWorkerBulkAction(){if(!canManageWorkerMasterData()){showToast("Only accountant / HR can apply worker changes.");return;}const ids=[...document.querySelectorAll(".worker-select:checked")].map(input=>Number(input.value)),action=document.getElementById("workerBulkAction")?.value;if(!ids.length){showToast("Select at least one worker.");return;}if(!action){showToast("Choose a bulk action first.");return;}let value;if(action==='department'){value=prompt(`Move ${ids.length} worker(s) to which department?`,departments[0]?.name||'');if(value===null)return;value=value.trim();if(!departments.some(d=>d.name.toLowerCase()===value.toLowerCase())){showToast("Department not found. Add it first.");return;}ids.forEach(id=>{const w=workers.find(worker=>Number(worker.id)===id);if(w)w.department=value;});}else if(action==='designation'){value=prompt(`Assign which designation to ${ids.length} worker(s)?`,"");if(value===null||!value.trim())return;ids.forEach(id=>{const w=workers.find(worker=>Number(worker.id)===id);if(w)w.designation=value.trim();});}else if(action==='rates'){const rate=prompt('Daily rate (KSh):','');if(rate===null)return;const otRate=prompt('OT hourly rate (KSh):','');if(otRate===null)return;if(Number(rate)<=0||Number(otRate)<=0){showToast('Rates must be greater than zero.');return;}ids.forEach(id=>{const w=workers.find(worker=>Number(worker.id)===id);if(w){w.rate=Number(rate);w.otRate=Number(otRate);}});}else ids.forEach(id=>{const w=workers.find(worker=>Number(worker.id)===id);if(w)w.active=action==='activate';});saveData();renderWorkers();showToast(`Updated ${ids.length} worker(s).`);}
function openWorkerModal(){ensureModal('workerModal');if(!canManageWorkerMasterData()){showToast("Only accountant / HR can edit worker master data.");return;}document.getElementById("editingWorkerId").value="";document.getElementById("workerModalTitle").textContent="Add Worker";populateFilters();document.getElementById("workerNo").value=employeeNo();document.getElementById("workerName").value="";document.getElementById("workerIdNumber").value="";document.getElementById("workerDesignation").value="";document.getElementById("workerPhone").value="";document.getElementById("workerRate").value="";document.getElementById("workerOtRate").value="";document.getElementById("workerJoinDate").value=today();document.getElementById("workerModal").classList.add("show")}
function editWorker(id){ensureModal('workerModal');if(!canManageWorkerMasterData()){showToast("Only accountant / HR can edit worker master data.");return;}const w=workers.find(x=>x.id===id);if(!w)return;openWorkerModal();document.getElementById("editingWorkerId").value=id;document.getElementById("workerModalTitle").textContent="Edit Worker";document.getElementById("workerNo").value=w.employeeNo;document.getElementById("workerName").value=w.name;document.getElementById("workerIdNumber").value=w.idNumber||"";document.getElementById("workerDesignation").value=w.designation||"";document.getElementById("workerPhone").value=w.phone||"";document.getElementById("workerDepartment").value=w.department;document.getElementById("workerClassification").value=w.classification;document.getElementById("workerRate").value=w.rate;document.getElementById("workerOtRate").value=w.otRate;document.getElementById("workerJoinDate").value=w.joinDate||today()}
function saveWorker(){if(!canManageWorkerMasterData()){showToast("Only accountant / HR can edit worker master data.");return;}const id=document.getElementById("editingWorkerId").value,name=document.getElementById("workerName").value.trim(),department=document.getElementById("workerDepartment").value,designation=document.getElementById("workerDesignation").value.trim(),idNumber=document.getElementById("workerIdNumber").value.trim(),phone=document.getElementById("workerPhone").value.trim(),classification=document.getElementById("workerClassification").value,rate=Number(document.getElementById("workerRate").value),otRate=Number(document.getElementById("workerOtRate").value),joinDate=document.getElementById("workerJoinDate").value;if(!name||!department||!classification||rate<=0||otRate<=0){alert("Complete all worker details.");return}if(id){const w=workers.find(x=>x.id===Number(id));if(!w)return;Object.assign(w,{name,department,designation,idNumber,phone,classification,rate,otRate,joinDate});showToast("Worker updated successfully.")}else{const employeeNo=document.getElementById("workerNo").value;workers.push({id:Date.now(),employeeNo,idNumber,designation,phone,name,department,classification,rate,otRate,joinDate,active:true,client:"",assignment:"",deploymentStart:""});showToast(`${employeeNo} created successfully.`)}saveData();closeModal("workerModal");renderWorkers()}
function toggleWorker(id){if(!canManageWorkerMasterData()){showToast("Only accountant / HR can change worker activation state.");return;}const w=workers.find(x=>x.id===id);if(!w)return;w.active=!w.active;saveData();renderWorkers();showToast(w.active?`${w.employeeNo} activated.`:`${w.employeeNo} deactivated.`)}
function openDeploymentModal(id){ensureModal('deploymentModal');const w=workers.find(x=>x.id===id);if(!w)return;populateFilters();document.getElementById("deploymentWorkerId").value=id;document.getElementById("deploymentWorkerName").value=`${w.employeeNo} — ${w.name}`;document.getElementById("deploymentClient").value="";document.getElementById("deploymentDepartment").value=w.department;document.getElementById("deploymentStartDate").value=today();document.getElementById("deploymentAssignment").value="";document.getElementById("deploymentRequest").value="";document.getElementById("deploymentModal").classList.add("show")}
function saveDeployment(){const id=Number(document.getElementById("deploymentWorkerId").value),w=workers.find(x=>x.id===id),clientId=Number(document.getElementById("deploymentClient").value),department=document.getElementById("deploymentDepartment").value,start=document.getElementById("deploymentStartDate").value,assignment=document.getElementById("deploymentAssignment").value.trim(),requestId=Number(document.getElementById("deploymentRequest").value)||null;if(!w||!clientId||!department||!start){alert("Select a client, department and start date.");return}w.client=clientById(clientId)?.name||"";w.department=department;w.assignment=assignment||"Direct deployment";w.deploymentStart=start;if(requestId){const r=requestById(requestId);if(r&&!r.allocatedWorkerIds.includes(w.id))r.allocatedWorkerIds.push(w.id);if(r&&r.allocatedWorkerIds.length)r.status="Allocated"}saveData();closeModal("deploymentModal");renderWorkers();showToast(`${w.employeeNo} deployed successfully.`)}

/* ---------- clients / departments ---------- */
function renderClients(){const table=document.getElementById("clientsTable");if(!table)return;table.innerHTML=clients.map(c=>{const reqs=labourRequests.filter(r=>r.clientId===c.id&&!['Completed','Cancelled'].includes(r.status));const allocated=new Set(reqs.flatMap(r=>r.allocatedWorkerIds||[])).size;return `<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.contact||"—")}</td><td>${esc(c.phone||"—")}</td><td>${reqs.length}</td><td>${allocated}</td><td><span class="status ${c.active?"status-worked":"status-absent"}">${c.active?"Active":"Inactive"}</span></td><td><button class="secondary" onclick="editClient(${c.id})">Edit</button> <button class="${c.active?"danger":"success"}" onclick="toggleClient(${c.id})">${c.active?"Deactivate":"Activate"}</button></td></tr>`}).join('')||'<tr><td colspan="7"><div class="empty">No clients yet.</div></td></tr>'}
function openClientModal(){ensureModal('clientModal');document.getElementById("editingClientId").value="";document.getElementById("clientModalTitle").textContent="Add Client";document.getElementById("clientName").value="";document.getElementById("clientContact").value="";document.getElementById("clientPhone").value="";document.getElementById("clientModal").classList.add("show")}
function editClient(id){ensureModal('clientModal');const c=clientById(id);if(!c)return;openClientModal();document.getElementById("editingClientId").value=id;document.getElementById("clientModalTitle").textContent="Edit Client";document.getElementById("clientName").value=c.name;document.getElementById("clientContact").value=c.contact||"";document.getElementById("clientPhone").value=c.phone||""}
function saveClient(){const id=document.getElementById("editingClientId").value,name=document.getElementById("clientName").value.trim(),contact=document.getElementById("clientContact").value.trim(),phone=document.getElementById("clientPhone").value.trim();if(!name){alert("Enter the company name.");return}if(id){const c=clientById(id);Object.assign(c,{name,contact,phone});showToast("Client updated.")}else{clients.push({id:Date.now(),name,contact,phone,active:true});showToast("Client added.")}saveData();closeModal("clientModal");populateClientSelects();renderClients()}
function toggleClient(id){const c=clientById(id);if(!c)return;c.active=!c.active;saveData();populateClientSelects();renderClients();showToast(c.active?`${c.name} activated.`:`${c.name} deactivated.`)}
function renderDepartments(){const table=document.getElementById("departmentsTable");if(!table)return;table.innerHTML=departments.map(d=>{const count=workers.filter(w=>w.active&&w.department===d.name).length;return `<tr><td><strong>${esc(d.name)}</strong></td><td>${esc(d.parent||"—")}</td><td>${count}</td><td>${d.rate?money(d.rate):'Worker rate'}</td><td>${d.otRate?money(d.otRate):'Worker rate'}</td></tr>`}).join('')||'<tr><td colspan="5"><div class="empty">No departments yet.</div></td></tr>'}
function openDepartmentModal(){ensureModal('departmentModal');populateFilters();document.getElementById("departmentName").value="";document.getElementById("departmentRate").value="";document.getElementById("departmentOtRate").value="";document.getElementById("departmentModal").classList.add("show")}
function saveDepartment(){const name=document.getElementById("departmentName").value.trim(),parent=document.getElementById("departmentParent").value,rate=Number(document.getElementById("departmentRate").value)||0,otRate=Number(document.getElementById("departmentOtRate").value)||0;if(!name){alert("Enter a department name.");return}const existing=departments.find(d=>d.name.toLowerCase()===name.toLowerCase());if(existing){existing.rate=rate;existing.otRate=otRate;showToast("Department wage defaults updated.");}else departments.push({name,parent,rate,otRate});saveData();closeModal("departmentModal");populateFilters();renderDepartments();showToast(existing?"Department wage defaults updated.":"Department added.")}

/* ---------- payroll (memoized + paginated) ---------- */
let lfPayrollCache={key:'',result:null};
function computePayroll(period){
 const rows=[];let regular=0,overtime=0,workersPaid=0;
 workers.filter(w=>w.active).forEach(w=>{
   let days=0,otHours=0;
   Object.entries(attendance).forEach(([date,day])=>{
     if(!day.approved)return;
     const n=Number(date.split("-")[2]);
     const include=period==="first"?n>=1&&n<=15:n>=16;
     if(!include)return;
     const r=day.records?.[w.id];
     if(r?.status==="worked"){days++;otHours+=Number(r.overtime)||0}
   });
   const reg=days*w.rate,ot=otHours*w.otRate,gross=reg+ot;
   if(days)workersPaid++;regular+=reg;overtime+=ot;
   rows.push({w,days,reg,otHours,gross});
 });
 return {rows,regular,overtime,workersPaid};
}
function renderPayroll(){
 const periodEl=document.getElementById("payrollPeriod");if(!periodEl)return;
 const period=periodEl.value;
 const key=period+'|'+lfDataVersion;
 if(lfPayrollCache.key!==key)lfPayrollCache={key,result:computePayroll(period)};
 const {rows,regular,overtime,workersPaid}=lfPayrollCache.result;
 const table=document.getElementById("payrollTable");if(!table)return;
 const pageRows=lfPaginate('payroll',rows,25);
 table.innerHTML=pageRows.length?pageRows.map(r=>`<tr><td>${esc(r.w.name)}</td><td>${r.days}</td><td>${money(r.w.rate)}</td><td>${money(r.reg)}</td><td>${r.otHours}</td><td>${money(r.ot)}</td><td><strong>${money(r.gross)}</strong></td></tr>`).join(''):'<tr><td colspan="7"><div class="empty">No payroll rows for this period.</div></td></tr>';
 lfRenderPager('payrollPager','payroll','workers');
 document.getElementById("payrollWorkers").textContent=workersPaid;
 document.getElementById("payrollRegular").textContent=money(regular);
 document.getElementById("payrollOvertime").textContent=money(overtime);
 document.getElementById("payrollGross").textContent=money(regular+overtime);
}
function calculatePayroll(){renderPayroll();payroll.lastCalculated=new Date().toISOString();saveData();showToast("Payroll calculated from approved attendance.")}

/* ---------- reports ---------- */
function renderReports(){
 const rw=document.getElementById("reportWorkers");if(rw)rw.textContent=workers.filter(w=>w.active).length;
 const rc=document.getElementById("reportClients");if(rc)rc.textContent=clients.filter(c=>c.active).length;
 const rd=document.getElementById("reportDepartments");if(rd)rd.textContent=departments.length;
 const d=attendance[today()];
 const ra=document.getElementById("reportAttendance");if(ra)ra.textContent=d?.approved?"Approved":d?.submitted?"Submitted":"Pending";
}

/* ---------- JTS roll call (read-only render, explicit roster) ---------- */
function JtsWorkerById(id){return workers.find(w=>Number(w.id)===Number(id))||null}
function ensureJtsWorkerSelect(){const sel=document.getElementById("jtsHistoryWorker");if(!sel)return;sel.innerHTML="";workers.filter(w=>w.active).forEach(w=>{const label=`${w.name} (${w.idNumber||w.employeeNo||w.id})`;const opt=document.createElement("option");opt.value=String(w.id);opt.textContent=label;sel.appendChild(opt)});if(!sel.value && workers.length){sel.value=String(workers[0].id)}}
function getJtsRecordFor(date,workerId){const day=getDayRecord(date);if(!day.records[workerId])day.records[workerId]={status:"pending",hours:0,overtime:0};return day.records[workerId]}
function normalizeText(value){return String(value ?? "").replace(/\s+/g," ").trim()}
function numberFromCell(value){const n = Number(String(value ?? '').replace(/[^0-9.\-]/g, ''));return Number.isFinite(n) ? n : 0;}
/* xlsx (~900KB) is loaded on demand the first time a workbook import starts. */
let lfXlsxPromise=null;
function loadXlsx(){
 if(window.XLSX)return Promise.resolve();
 if(!lfXlsxPromise)lfXlsxPromise=new Promise((resolve,reject)=>{
   const s=document.createElement('script');
   s.src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
   s.onload=resolve;
   s.onerror=()=>{lfXlsxPromise=null;reject(new Error('Could not load the Excel library. Check your connection.'));};
   document.head.appendChild(s);
 });
 return lfXlsxPromise;
}
async function parseJtsWorkbook(file){
 if(!file){showToast('Please choose the JTS Excel workbook first.');return;}
 showToast('Loading Excel library…');
 try{await loadXlsx();}catch(err){alert(err.message);return;}
 const reader=new FileReader();
 reader.onload=function(e){
   try{
     const workbook=XLSX.read(new Uint8Array(e.target.result),{type:'array'}), importedWorkers=[], seen=new Set();
     workbook.SheetNames.forEach(sheetName=>{
       const rows=XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{header:1,blankrows:false,defval:''});
       const headerIndex=rows.findIndex(row=>row.some(cell=>/STAFF NO|Payroll No\.|ID NO/i.test(normalizeText(cell))));
       if(headerIndex<0)return;
       const headers=rows[headerIndex].map(cell=>normalizeText(cell).toLowerCase());
       const col=(...names)=>{const index=headers.findIndex(header=>names.some(name=>header===name||header.includes(name)));return index<0?null:index;};
       const staffCol=col('staff no','payroll no'),kraCol=col('kra pin'),nssfCol=col('nssf'),shifCol=col('shif/nhif','nhif/shif'),accountCol=col('acc. no','account'),idCol=col('id no'),phoneCol=col('phone'),deptCol=col('department'),designationCol=col('designation','position'),nameCol=col('name','site staff'),dailyCol=col('daily rate','basic pay'),hourlyCol=col('hourly rate');
       const dayCols=[]; headers.forEach((header,index)=>{const day=Number(header);if(day>=1&&day<=31)dayCols.push({index,day});});
       for(let rowIndex=headerIndex+1;rowIndex<rows.length;rowIndex++){
         const row=rows[rowIndex]||[], name=normalizeText(row[nameCol]);
         if(!name||name.toLowerCase().includes('total'))continue;
         const department=normalizeText(row[deptCol])||sheetName.split(',')[0].trim()||'Operations', designation=normalizeText(row[designationCol])||'Casual', employeeNo=normalizeText(row[staffCol])||`WK${String(importedWorkers.length+1).padStart(3,'0')}`, idNumber=normalizeText(row[idCol]), key=`${employeeNo}|${name}|${idNumber}`;
         if(seen.has(key))continue; seen.add(key);
         const worker={id:Date.now()+importedWorkers.length+1,employeeNo,kraPin:normalizeText(row[kraCol]),nssfNumber:normalizeText(row[nssfCol]),shifNumber:normalizeText(row[shifCol]),accountNumber:normalizeText(row[accountCol]),idNumber,phone:normalizeText(row[phoneCol]),name,department,designation,classification:/bagging|casual|kilifi/i.test(sheetName)?'Casual':'Staff',rate:numberFromCell(row[dailyCol]),otRate:numberFromCell(row[hourlyCol]),joinDate:'2026-07-01',active:true,client:'',assignment:'',deploymentStart:'',workbookSource:sheetName};
         importedWorkers.push(worker);
         dayCols.forEach(({index,day})=>{const hours=numberFromCell(row[index]);if(hours<=0)return;const date=`2026-07-${String(day).padStart(2,'0')}`,record=getAttendance(date,worker.id);record.status='present';record.hours=Math.min(hours,9);record.overtime=Math.max(0,hours-9);markAttendanceDirtyDate(date);});
       }
     });
     if(!importedWorkers.length){alert('No worker records were detected in the workbook.');return;}
     workers=importedWorkers;
     departments=[...new Map(workers.map(worker=>[worker.department,{name:worker.department,parent:''}])).values()];
     localStorage.setItem('labourforce_jts_workbook_imported','true');saveData();populateFilters();
     showToast(`Imported ${workers.length} workers and July attendance from ${workbook.SheetNames.length} sheets.`);
   }catch(err){console.error(err);alert('The JTS workbook could not be imported. Please check that it is a valid Excel workbook.');}
 };
 reader.readAsArrayBuffer(file);
}
function importJtsWorkbookFromInput(file){parseJtsWorkbook(file)}
function generateJtsRoster(){const date=document.getElementById("jtsDate").value||today();const active=workers.filter(w=>w.active);if(!active.length){showToast("No active workers to roster.");return;}active.forEach(w=>{const record=getJtsRecordFor(date,w.id);record.status=record.status||"pending";record.hours=Number(record.hours||0);record.overtime=Number(record.overtime||0);});markAttendanceDirtyDate(date);saveData();renderJtsAttendance();showToast(`${active.length} workers added to the ${date} roster.`)}
function setJtsStatus(date,workerId,status){const record=getJtsRecordFor(date,workerId);record.status=status;if(status==="present"){record.hours=Number(record.hours||9)||9;}if(status==="absent"){record.hours=0;record.overtime=0;}markAttendanceDirtyDate(date);saveData();renderJtsAttendance();}
function changeJtsHours(date,workerId,hours){const record=getJtsRecordFor(date,workerId);record.status=record.status==="present"?"present":record.status==="pending"?"pending":record.status;record.hours=Math.max(0,Number(hours)||0);markAttendanceDirtyDate(date);saveData();renderJtsAttendance();}
function changeJtsOt(date,workerId,hours){const record=getJtsRecordFor(date,workerId);record.overtime=Math.max(0,Number(hours)||0);markAttendanceDirtyDate(date);saveData();renderJtsAttendance();}
function reportJtsCorrection(workerId){const w=JtsWorkerById(workerId);if(!w)return;const note=prompt(`Describe the master-data problem for ${w.name}:`, "");if(note===null)return;const msg=note.trim();if(!msg){showToast("A correction note is required.");return;}jtsState.corrections.push({id:Date.now(),workerId:Number(workerId),issueType:"worker_details",issueText:msg,status:"open",createdAt:new Date().toISOString()});saveData();showToast("Correction sent to admin for resolution.")}
function raiseJtsDispute(workerId,date){const w=JtsWorkerById(workerId);if(!w)return;const note=prompt(`Dispute details for ${w.name} on ${date}:`, "");if(note===null)return;const msg=note.trim();if(!msg){showToast("A dispute note is required.");return;}jtsState.disputes.push({id:Date.now(),workerId:Number(workerId),date, note:msg, status:"pending", createdAt:new Date().toISOString()});saveData();rerenderIfActive('jts-history');showToast("Dispute flagged for review.")}
function renderJtsAttendance(){
 const dateEl=document.getElementById("jtsDate");if(!dateEl)return;
 const date=dateEl.value||today();
 const table=document.getElementById("jtsAttendanceTable");if(!table)return;
 const rows=workers.filter(w=>w.active).map(w=>({w,record:peekAttendance(date,w.id)}));
 const present=rows.filter(r=>r.record.status==="present").length;
 const absent=rows.filter(r=>r.record.status==="absent").length;
 const pending=rows.filter(r=>r.record.status==="pending").length;
 const summary=document.getElementById("jtsSummary");
 if(summary)summary.innerHTML=`<div class="summary-card"><strong>${rows.length}</strong><span>Active workers</span></div><div class="summary-card"><strong>${present}</strong><span>Present</span></div><div class="summary-card"><strong>${absent}</strong><span>Absent</span></div><div class="summary-card"><strong>${pending}</strong><span>Pending</span></div>`;
 if(!rows.length){table.innerHTML='<tr><td colspan="7"><div class="empty">No active workers on the roster.</div></td></tr>';return}
 const pageRows=lfPaginate('jtsAtt',rows,25);
 table.innerHTML=pageRows.map(({w,record})=>{
   const hours=Number(record.hours||0);const ot=Number(record.overtime||0);
   return `<tr><td><strong>${esc(w.name)}</strong><br><small class="muted">${esc(w.idNumber||w.employeeNo||w.id)}</small></td><td>${esc(w.idNumber||w.employeeNo||w.id)}</td><td>${esc(w.department)}</td><td><select onchange="setJtsStatus('${date}', ${w.id}, this.value)" ${canCaptureAttendance()?'':'disabled'}><option value="pending" ${record.status==="pending"?"selected":""}>Pending</option><option value="present" ${record.status==="present"?"selected":""}>Present</option><option value="absent" ${record.status==="absent"?"selected":""}>Absent</option></select></td><td><input type="number" min="0" step="0.5" value="${hours}" onchange="changeJtsHours('${date}', ${w.id}, this.value)" ${canCaptureAttendance() && record.status==="present"?"":"disabled"}></td><td><input type="number" min="0" step="0.5" value="${ot}" onchange="changeJtsOt('${date}', ${w.id}, this.value)" ${canCaptureAttendance() && record.status==="present"?"":"disabled"}></td><td>${canCaptureAttendance()?`<button class="secondary" onclick="reportJtsCorrection(${w.id})">Inform admin</button>`:'<span class="muted">Read-only</span>'}</td></tr>`;
 }).join('');
 lfRenderPager('jtsAttendancePager','jtsAtt','workers');
}
function renderJtsHistory(){
 ensureJtsWorkerSelect();
 const workerId=Number(document.getElementById("jtsHistoryWorker")?.value)||workers[0]?.id;
 const table=document.getElementById("jtsHistoryTable");if(!table)return;
 const history=Object.entries(attendance).map(([date,day])=>{const rec=day.records&&day.records[workerId]?day.records[workerId]:null;return rec?{date,status:rec.status,hours:Number(rec.hours||0),overtime:Number(rec.overtime||0),verification_status:rec.verification_status}:null}).filter(Boolean).sort((a,b)=>b.date.localeCompare(a.date));
 const disputes=jtsState.disputes.filter(d=>Number(d.workerId)===Number(workerId));
 const totalHours=history.reduce((sum,item)=>sum+Number(item.hours||0),0);
 const worked=history.filter(h=>h.status==="present"||h.status==="worked").length;
 const summary=document.getElementById("jtsRollup");
 if(summary)summary.innerHTML=`<div class="summary-card"><strong>${worked}</strong><span>Days worked</span></div><div class="summary-card"><strong>${totalHours}</strong><span>Total hours</span></div><div class="summary-card"><strong>${disputes.filter(d=>d.status==='pending').length}</strong><span>Disputes pending</span></div>`;
 if(!history.length){table.innerHTML='<tr><td colspan="6"><div class="empty">No attendance history for this worker yet.</div></td></tr>';lfRenderPager('jtsHistoryPager','jtsHist','days');return;}
 const pageRows=lfPaginate('jtsHist',history,50);
 table.innerHTML=pageRows.map(item=>{
   const disputeExists = disputes.some(d => d.date === item.date);
   return `<tr><td>${esc(item.date)}</td><td><span class="status ${item.status==="present"||item.status==="worked"?"status-worked":"status-absent"}">${item.status==="present"||item.status==="worked"?"Worked":"Absent"}</span></td><td>${Number(item.hours||0)}</td><td>${Number(item.overtime||0)}</td><td>${item.verification_status==='verified'?'<span class="status status-approved">Verified</span>':'<span class="status status-pending">Unverified</span>'}</td><td>${disputeExists?'<span class="status status-pending">Flagged</span>':`<button class="secondary" onclick="raiseJtsDispute(${workerId},'${item.date}')">Dispute</button>`}</td></tr>`;
 }).join('');
 lfRenderPager('jtsHistoryPager','jtsHist','days');
}

/* ---------- JTS payroll review (memoized + paginated) ---------- */
let lfJtsPayrollCache={key:'',summaryHtml:'',rowsHtml:''};
function getJtsPayrollWorkers(){const search=(document.getElementById('jtsPayrollSearch')?.value||'').toLowerCase().trim(),designation=document.getElementById('jtsPayrollDesignation')?.value||'all';return workers.filter(w=>w.active).filter(w=>designation==='all'||w.designation===designation).filter(w=>!search||[w.name,w.employeeNo,w.idNumber,w.nssfNumber,w.department,w.designation].some(value=>String(value||'').toLowerCase().includes(search)))}
function calculateJtsPayrollFiltered(){
 const search=(document.getElementById('jtsPayrollSearch')?.value||'').toLowerCase().trim();
 const designation=document.getElementById('jtsPayrollDesignation')?.value||'all';
 const key=[lfDataVersion,search,designation,jtsDeductionRates.nssf,jtsDeductionRates.housing,jtsDeductionRates.shif,jtsDeductionRates.paye].join('|');
 if(lfJtsPayrollCache.key===key){const s=document.getElementById('jtsPayrollSummary');if(s)s.innerHTML=lfJtsPayrollCache.summaryHtml;const t=document.getElementById('jtsPayrollTable');if(t)t.innerHTML=lfJtsPayrollCache.rowsHtml;lfRenderPager('jtsPayrollPager','jtsPay','workers');return;}
 const rows=getJtsPayrollWorkers().map(w=>{
   let days=0,otHours=0;
   Object.entries(attendance).forEach(([date,day])=>{const rec=day.records?.[w.id];if(date.startsWith('2026-07-')&&rec?.status==='present'){days++;otHours+=Number(rec.overtime)||0;}});
   const department=departments.find(d=>d.name===w.department),dailyRate=Number(w.rate)||Number(department?.rate)||0,otRate=Number(w.otRate)||Number(department?.otRate)||0,normal=days*dailyRate,ot=otHours*otRate,gross=normal+ot,nssf=gross*(jtsDeductionRates.nssf/100),housing=gross*(jtsDeductionRates.housing/100),shif=gross*(jtsDeductionRates.shif/100),paye=gross*(jtsDeductionRates.paye/100),deductions=nssf+housing+shif+paye;
   return {w,days,normal,ot,gross,deductions,net:gross-deductions};
 });
 const gross=rows.reduce((sum,row)=>sum+row.gross,0),deductions=rows.reduce((sum,row)=>sum+row.deductions,0);
 const summary=document.getElementById('jtsPayrollSummary');
 const summaryHtml=`<div class="summary-card"><strong>${money(gross)}</strong><span>Gross</span></div><div class="summary-card"><strong>${money(deductions)}</strong><span>Statutory deductions</span></div><div class="summary-card"><strong>${money(gross-deductions)}</strong><span>Net pay</span></div>`;
 if(summary)summary.innerHTML=summaryHtml;
 const pageRows=lfPaginate('jtsPay',rows,25);
 const table=document.getElementById('jtsPayrollTable');
 const rowsHtml=pageRows.length?pageRows.map(row=>`<tr><td><strong>${esc(row.w.name)}</strong><br><small class="muted">${esc(row.w.idNumber||row.w.employeeNo||row.w.id)} · ${esc(row.w.designation||'')}</small></td><td>${row.days}</td><td>${money(row.normal)}</td><td>${money(row.ot)}</td><td>${money(row.gross)}</td><td>${money(row.deductions)}</td><td>${money(row.net)}</td><td><span class="status status-worked">OK</span></td></tr>`).join(''):'<tr><td colspan="8"><div class="empty">No payroll rows for the selected period.</div></td></tr>';
 if(table)table.innerHTML=rowsHtml;
 lfRenderPager('jtsPayrollPager','jtsPay','workers');
 lfJtsPayrollCache={key,summaryHtml,rowsHtml};
}
function populateJtsPayrollFilters(){const select=document.getElementById('jtsPayrollDesignation');if(!select)return;const current=select.value,designations=[...new Set(workers.filter(w=>w.active).map(w=>w.designation).filter(Boolean))].sort();select.innerHTML='<option value="all">All designations</option>'+designations.map(value=>`<option value="${esc(value)}">${esc(value)}</option>`).join('');if(designations.includes(current))select.value=current}
function applyJtsDeductionRates(){jtsDeductionRates={nssf:Number(document.getElementById('jtsNssfRate').value)||0,housing:Number(document.getElementById('jtsHousingRate').value)||0,shif:Number(document.getElementById('jtsShifRate').value)||0,paye:Number(document.getElementById('jtsPayeRate').value)||0};saveData();renderJtsPayroll();showToast('Shared deduction percentages applied.');}
function loadJtsDeductionRates(){Object.entries({jtsNssfRate:jtsDeductionRates.nssf,jtsHousingRate:jtsDeductionRates.housing,jtsShifRate:jtsDeductionRates.shif,jtsPayeRate:jtsDeductionRates.paye}).forEach(([id,value])=>{const input=document.getElementById(id);if(input)input.value=value;});}
function renderJtsPayroll(){loadJtsDeductionRates();populateJtsPayrollFilters();calculateJtsPayrollFiltered();}

/* ---------- in-app supervisor portal (attendance-only, paginated) ---------- */
function portalStatus(record){return record.status==='worked'?'present':record.status||'pending'}
function supervisorSelectedIds(){return [...document.querySelectorAll('.supervisor-select:checked')].map(input=>Number(input.value));}
function renderSupervisorPortal(){
 const dateEl=document.getElementById('supervisorDate');if(!dateEl)return;
 const date=dateEl.value||today();
 const query=(document.getElementById('supervisorSearch')?.value||'').trim().toLowerCase();
 const day=getDayRecord(date);
 const marked=workers.filter(w=>w.active&&['present','worked','absent'].includes(day.records?.[w.id]?.status));
 const markedIds=new Set(marked.map(w=>w.id));
 const results=query.length<2?[]:workers.filter(w=>w.active&&!markedIds.has(w.id)&&[w.name,w.idNumber,w.employeeNo].some(value=>String(value||'').toLowerCase().includes(query))).slice(0,15);
 const present=marked.filter(w=>['present','worked'].includes(day.records[w.id]?.status)).length;
 const absent=marked.filter(w=>day.records[w.id]?.status==='absent').length;
 const summary=document.getElementById('supervisorSummary');
 if(summary)summary.innerHTML=`<div class="summary-card"><strong>${workers.filter(w=>w.active).length}</strong><span>Expected</span></div><div class="summary-card"><strong>${present}</strong><span>Marked present</span></div><div class="summary-card"><strong>${absent}</strong><span>Marked absent</span></div><div class="summary-card"><strong>${marked.length}</strong><span>Marked total</span></div>`;
 const searchBox=document.getElementById('supervisorSearchResults');
 if(searchBox)searchBox.innerHTML=query.length<2?'':results.map(w=>`<button class="worker-search-result" onclick="markSupervisorPresent(${w.id})"><span><strong>${esc(w.name)}</strong><small>${esc(w.idNumber||w.employeeNo||'')}</small></span><b>Mark present</b></button>`).join('')||'<div class="empty">No matching unmarked worker.</div>';
 const table=document.getElementById('supervisorTable');
 if(table){
   const pageRows=lfPaginate('supAtt',marked,25);
   table.innerHTML=pageRows.length?pageRows.map(w=>{
     const r=day.records[w.id],state=portalStatus(r);
     return `<tr><td><input class="supervisor-select" type="checkbox" value="${w.id}"></td><td><strong>${esc(w.name)}</strong></td><td>${esc(w.idNumber||w.employeeNo||'')}</td><td><span class="status status-${state==='present'||state==='worked'?'worked':state==='absent'?'absent':'pending'}">${esc(state)}</span></td><td>${Number(r.hours||0)}</td><td>${Number(r.overtime||0)}</td><td><button class="secondary" onclick="editSupervisorRecord(${w.id},'${date}')">Edit</button> <button class="danger" onclick="cancelSupervisorRecord(${w.id},'${date}')">Cancel</button></td></tr>`;
   }).join(''):'<tr><td colspan="7"><div class="empty">Search for a worker above to begin marking attendance.</div></td></tr>';
 }
 lfRenderPager('supervisorPager','supAtt','marked workers');
}
function bulkSupervisorStatus(status){const date=document.getElementById('supervisorDate')?.value||today(),ids=supervisorSelectedIds();if(!canCaptureAttendance()){showToast('You do not have attendance permission.');return;}if(!ids.length){showToast('Select workers first.');return;}ids.forEach(id=>setJtsStatus(date,id,status==='present'?'present':'absent'));renderSupervisorPortal();showToast(`Marked ${ids.length} worker(s) ${status}.`);}
function editSupervisorRecord(workerId,date){if(!canCaptureAttendance())return;const record=getAttendance(date,workerId),hours=prompt('Regular hours:',String(record.hours||9));if(hours===null)return;const overtime=prompt('Overtime hours:',String(record.overtime||0));if(overtime===null)return;record.status='present';record.hours=Math.min(24,Math.max(0,Number(hours)||0));record.overtime=Math.max(0,Number(overtime)||0);record.remarks=prompt('Remarks (optional):',record.remarks||'')||'';markAttendanceDirtyDate(date);saveData();renderSupervisorPortal();}
function submitSupervisorAttendance(){const date=document.getElementById('supervisorDate')?.value||today(),day=getDayRecord(date);if(day.submitted||day.approved){showToast('This attendance copy is already final.');return;}const marked=workers.filter(w=>w.active).filter(w=>{const r=day.records?.[w.id];return r&&(r.status==='present'||r.status==='worked'||r.status==='absent')});if(!marked.length){showToast('Mark at least one worker before submitting.');return;}if(!confirm(`Submit ${marked.length} marked worker(s) as the final copy for ${date}?`))return;day.submitted=true;day.status='submitted';day.submittedAt=new Date().toISOString();markAttendanceDirtyDate(date);saveData();renderSupervisorPortal();showToast('Final attendance copy submitted.');}
function editSelectedSupervisor(){const date=document.getElementById('supervisorDate')?.value||today(),ids=supervisorSelectedIds();if(ids.length!==1){showToast('Select one marked worker to edit.');return;}editSupervisorRecord(ids[0],date);}
function cancelSelectedSupervisor(){const date=document.getElementById('supervisorDate')?.value||today(),ids=supervisorSelectedIds(),day=getDayRecord(date);if(day.submitted||day.approved){showToast('Final attendance cannot be cancelled.');return;}if(!ids.length){showToast('Select marked workers first.');return;}ids.forEach(id=>{const record=day.records?.[id];if(record){record.status='pending';record.hours=0;record.overtime=0;record.remarks='';}});markAttendanceDirtyDate(date);saveData();renderSupervisorPortal();showToast(`Cancelled ${ids.length} marked worker(s).`);}
function markSupervisorPresent(workerId){const date=document.getElementById('supervisorDate')?.value||today(),day=getDayRecord(date);if(day.submitted||day.approved){showToast('This attendance copy is final.');return;}const record=getAttendance(date,workerId);record.status='present';record.hours=9;record.overtime=0;markAttendanceDirtyDate(date);saveData();document.getElementById('supervisorSearch').value='';renderSupervisorPortal();showToast('Worker marked present.');}
function cancelSupervisorRecord(workerId,date){const day=getDayRecord(date);if(day.submitted||day.approved){showToast('Final attendance cannot be cancelled.');return;}const record=day.records?.[workerId];if(record){record.status='pending';record.hours=0;record.overtime=0;record.remarks='';markAttendanceDirtyDate(date);saveData();renderSupervisorPortal();}}

/* ---------- worker self-service portal ---------- */
function renderWorkerPortal(){
 const profile=window.lfCurrentProfile||{},workerId=profile.worker_id||profile.workerId;
 const worker=workers.find(w=>Number(w.id)===Number(workerId))||workers.find(w=>w.id===Number(document.body.dataset.workerId));
 const from=document.getElementById('workerPortalFrom')?.value||'0000-01-01',to=document.getElementById('workerPortalTo')?.value||'9999-12-31',status=document.getElementById('workerPortalStatus')?.value||'all';
 const records=worker?Object.entries(attendance).flatMap(([date,day])=>{const r=day.records?.[worker.id];return r?[{date,r}]:[]}).filter(x=>x.date>=from&&x.date<=to&& (status==='all'||portalStatus(x.r)===status)).sort((a,b)=>b.date.localeCompare(a.date)):[];
 const present=records.filter(x=>portalStatus(x.r)==='present').length,hours=records.reduce((n,x)=>n+Number(x.r.hours||0),0),ot=records.reduce((n,x)=>n+Number(x.r.overtime||0),0);
 const summary=document.getElementById('workerPortalSummary');
 if(summary)summary.innerHTML=`<div class="summary-card"><strong>${present}</strong><span>Present days</span></div><div class="summary-card"><strong>${records.filter(x=>portalStatus(x.r)==='absent').length}</strong><span>Absent days</span></div><div class="summary-card"><strong>${hours}</strong><span>Hours worked</span></div><div class="summary-card"><strong>${ot}</strong><span>Overtime</span></div>`;
 const table=document.getElementById('workerPortalTable');
 if(table){
   const pageRows=lfPaginate('wkPortal',records,50);
   table.innerHTML=worker?(pageRows.length?pageRows.map(x=>`<tr><td>${x.date}</td><td>${esc(worker.department)}</td><td>${esc(worker.designation||'—')}</td><td>${esc(portalStatus(x.r))}</td><td>${Number(x.r.hours||0)}</td><td>${Number(x.r.overtime||0)}</td><td><button class="secondary" onclick="raiseJtsDispute(${worker.id},'${x.date}')">Dispute</button></td></tr>`).join(''):'<tr><td colspan="7"><div class="empty">No attendance records found.</div></td></tr>'):'<tr><td colspan="7"><div class="empty">Your worker profile is not linked yet.</div></td></tr>';
 }
 lfRenderPager('workerPortalPager','wkPortal','days');
}

/* ---------- CSV export ---------- */
function downloadCSV(filename,rows){const csv=rows.map(row=>row.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url)}
function exportAttendance(){const date=document.getElementById("attendanceDate").value||today(),rows=[["Employee No.","Worker","Department","Classification","Daily Rate","OT Rate","Status","OT Hours","OT Pay","Total Pay","Verification"]];workers.filter(w=>w.active).forEach(w=>{const r=peekAttendance(date,w.id),reg=r.status==="worked"?w.rate:0,ot=Number(r.overtime||0)*w.otRate;rows.push([w.employeeNo,w.name,w.department,w.classification,w.rate,w.otRate,r.status,r.overtime,ot,reg+ot,r.verification_status||'unverified'])});downloadCSV(`attendance-${date}.csv`,rows)}
function exportPayroll(){const rows=[["Worker","Days Worked","Daily Rate","Regular Pay","OT Hours","OT Pay","Gross"]];document.querySelectorAll("#payrollTable tr").forEach(row=>{const cells=[...row.querySelectorAll("td")].map(c=>c.innerText.trim());if(cells.length)rows.push(cells)});downloadCSV("payroll.csv",rows);showToast("Payroll CSV exported.")}

/* ---------- pager rerender registry ---------- */
LF_PAGER_RERENDER.dashAtt=()=>renderFuturisticDashboard();
LF_PAGER_RERENDER.requests=()=>renderRequests();
LF_PAGER_RERENDER.attendance=()=>renderAttendance();
LF_PAGER_RERENDER.approval=()=>renderApproval();
LF_PAGER_RERENDER.jtsAtt=()=>renderJtsAttendance();
LF_PAGER_RERENDER.jtsHist=()=>renderJtsHistory();
LF_PAGER_RERENDER.jtsPay=()=>calculateJtsPayrollFiltered();
LF_PAGER_RERENDER.supAtt=()=>renderSupervisorPortal();
LF_PAGER_RERENDER.wkPortal=()=>renderWorkerPortal();
LF_PAGER_RERENDER.workers=()=>renderWorkers();
LF_PAGER_RERENDER.payroll=()=>renderPayroll();

/* ---------- application shell bootstrap ----------
   Only the shell + dashboard initialise. Every other module renders
   the first time the user navigates to it. */
(function initShell(){
 const setVal=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v;};
 setVal('dashboardDate',today());setVal('attendanceDate',today());setVal('approvalDate',today());
 setVal('jtsDate',today());setVal('supervisorDate',today());
 setVal('workerPortalFrom','2026-08-01');setVal('workerPortalTo',today());
 populateFilters();
 /* Debounced searches: typing fires one query/render per pause, not per keystroke. */
 const wire=(id,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener('input',debounce(fn,300));};
 wire('workerSearch',()=>renderWorkers());
 wire('dashboardWorkerSearch',()=>renderFuturisticDashboard());
 wire('supervisorSearch',()=>renderSupervisorPortal());
 wire('jtsPayrollSearch',()=>renderJtsPayroll());
 wire('userSearch',()=>{if(typeof renderUsers==='function')renderUsers();});
 setTimeout(()=>{renderDashboard();const hash=(location.hash||'').replace('#','');if(hash&&hash!=='dashboard'&&document.getElementById(hash))showPage(hash);},0);
})();