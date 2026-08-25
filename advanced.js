/* ============================================================
   THE LABOUR FORCE — ADVANCED OPERATIONS LAYER
   Deployments, availability, exceptions and audit UI.
   Performance-refactored: paginated tables, no global page
   override, targeted re-renders instead of full cascades.
   ============================================================ */

let deployments = JSON.parse(localStorage.getItem('labourforce_deployments')) || [];
let auditLog = JSON.parse(localStorage.getItem('labourforce_audit')) || [];

function saveAdvanced(){
  localStorage.setItem('labourforce_deployments', JSON.stringify(deployments));
  localStorage.setItem('labourforce_audit', JSON.stringify(auditLog));
}

function audit(action, reference, details, oldData=null, newData=null){
  auditLog.unshift({id:crypto.randomUUID?crypto.randomUUID():Date.now()+Math.random(), time:new Date().toISOString(), action, reference, details, oldData, newData, tableName:'operations'});
  auditLog=auditLog.slice(0,500);
  saveAdvanced();
  if(typeof queueBackendSync==='function') queueBackendSync();
}

function activeDeployment(workerId){
  return deployments.find(d=>Number(d.workerId)===Number(workerId) && d.status==='Active');
}
function deploymentById(id){return deployments.find(d=>Number(d.id)===Number(id));}
function workerById(id){return workers.find(w=>Number(w.id)===Number(id));}

function syncWorkerDeployment(workerId){
  const w=workerById(workerId); if(!w)return;
  const d=activeDeployment(workerId);
  if(d){
    w.client=clientById(d.clientId)?.name||'';
    w.assignment=d.assignment||'Deployed';
    w.deploymentStart=d.startDate||'';
    w.department=d.department||w.department;
    w.shift=d.shift||'Day';
    w.deploymentId=d.id;
    w.availability='Deployed';
  }else{
    w.client=''; w.assignment=''; w.deploymentStart=''; w.deploymentId=null; w.availability='Available';
  }
}

/* Existing deployments are upgraded into history records once. */
workers.forEach(w=>{
  if(w.client && !activeDeployment(w.id)){
    deployments.push({id:Date.now()+Number(w.id),workerId:w.id,clientId:(clients.find(c=>c.name===w.client)||{}).id||null,department:w.department,assignment:w.assignment||'Existing assignment',shift:w.shift||'Day',startDate:w.deploymentStart||w.joinDate||today(),endDate:null,status:'Active',requestId:null,reason:'Migrated from existing worker assignment'});
  }
});
deployments.forEach(d=>syncWorkerDeployment(d.workerId));
saveAdvanced();

function populateAdvancedFilters(){
  const cf=document.getElementById('deploymentClientFilter');
  if(cf){const cur=cf.value;cf.innerHTML='<option value="all">All Clients</option>'+clients.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');if([...cf.options].some(o=>o.value===cur))cf.value=cur;}
  const df=document.getElementById('availabilityDeptFilter');
  if(df){const cur=df.value;df.innerHTML='<option value="all">All Departments</option>'+departments.map(d=>`<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('');if([...df.options].some(o=>o.value===cur))df.value=cur;}
}

function renderDeployments(){
  populateAdvancedFilters();
  const cf=document.getElementById('deploymentClientFilter')?.value||'all';
  const sf=document.getElementById('deploymentStatusFilter')?.value||'all';
  const table=document.getElementById('deploymentsTable'); if(!table)return;
  const rows=deployments.filter(d=>(cf==='all'||String(d.clientId)===String(cf))&&(sf==='all'||d.status===sf)).sort((a,b)=>new Date(b.startDate)-new Date(a.startDate));
  const pageRows=lfPaginate('deployments',rows,25);
  table.innerHTML=pageRows.length?pageRows.map(d=>{const w=workerById(d.workerId),c=clientById(d.clientId);return `<tr><td><strong>${esc(w?.employeeNo||'—')}</strong><br><small>${esc(w?.name||'Unknown worker')}</small></td><td>${esc(c?.name||'—')}</td><td>${esc(d.department||'—')}</td><td>${esc(d.assignment||'—')}<br><small>${esc(d.requestId?requestById(d.requestId)?.requestNo||'Request':'Direct')}</small></td><td>${esc(d.shift||'Day')}</td><td>${esc(d.startDate||'—')}</td><td>${esc(d.endDate||'—')}</td><td><span class="status ${d.status==='Active'?'status-worked':'status-missing'}">${d.status}</span></td><td>${d.status==='Active'?`<button class="danger" onclick="openEndDeployment(${d.id})">End</button>`:'—'}</td></tr>`}).join(''):'<tr><td colspan="9"><div class="empty">No deployment history found.</div></td></tr>';
  lfRenderPager('deploymentsPager','deployments','deployments');
}

function openEndDeployment(id){
  ensureModal('endDeploymentModal');
  const d=deploymentById(id);if(!d)return;
  document.getElementById('endingDeploymentId').value=id;
  document.getElementById('deploymentEndDate').value=today();
  document.getElementById('deploymentEndReason').value='';
  document.getElementById('endDeploymentModal').classList.add('show');
}
function endDeployment(){
  const d=deploymentById(Number(document.getElementById('endingDeploymentId').value));if(!d)return;
  const end=document.getElementById('deploymentEndDate').value||today();
  if(end<d.startDate){alert('End date cannot be before the start date.');return;}
  d.endDate=end;d.status='Ended';d.reason=document.getElementById('deploymentEndReason').value.trim()||'Assignment ended';
  syncWorkerDeployment(d.workerId);saveData();saveAdvanced();audit('Deployment ended',workerById(d.workerId)?.employeeNo||'Worker',`${clientById(d.clientId)?.name||'Client'} — ${d.reason}`);
  closeModal('endDeploymentModal');renderDeployments();rerenderIfActive('workers');rerenderIfActive('availability');rerenderIfActive('dashboard');showToast('Deployment ended. Worker is now available.');
}

function renderAvailability(){
  populateAdvancedFilters();
  const cls=document.getElementById('availabilityClassFilter')?.value||'all';
  const dept=document.getElementById('availabilityDeptFilter')?.value||'all';
  const active=workers.filter(w=>w.active);
  const available=active.filter(w=>!activeDeployment(w.id));
  const cards=document.getElementById('availabilityCards');
  if(cards){
    const counts=['Skilled','Unskilled','Supervisor'].map(x=>[x,available.filter(w=>w.classification===x).length]);
    cards.innerHTML=`<div class="card"><div class="card-label">Total Workforce</div><div class="card-value">${active.length}</div><div class="card-sub">Active workers</div></div><div class="card"><div class="card-label">Deployed</div><div class="card-value">${active.length-available.length}</div><div class="card-sub">Currently assigned</div></div><div class="card"><div class="card-label">Available</div><div class="card-value">${available.length}</div><div class="card-sub">Ready for deployment</div></div>${counts.map(x=>`<div class="card"><div class="card-label">${x[0]}</div><div class="card-value">${x[1]}</div><div class="card-sub">Available</div></div>`).join('')}`;
  }
  const table=document.getElementById('availabilityTable');if(!table)return;
  const rows=available.filter(w=>(cls==='all'||w.classification===cls)&&(dept==='all'||w.department===dept));
  const pageRows=lfPaginate('availability',rows,25);
  table.innerHTML=pageRows.length?pageRows.map(w=>{const a=peekAttendance(today(),w.id);return `<tr><td><strong>${esc(w.employeeNo)}</strong></td><td>${esc(w.name)}</td><td>${esc(w.department)}</td><td>${esc(w.classification)}</td><td><span class="status ${a.status==='worked'||a.status==='present'?'status-worked':a.status==='absent'?'status-absent':'status-missing'}">${a.status==='worked'||a.status==='present'?'Worked':a.status==='absent'?'Absent':'Missing'}</span></td><td><span class="status status-worked">Available</span></td><td><button class="primary" onclick="openDeploymentModal(${w.id})">Deploy</button></td></tr>`}).join(''):'<tr><td colspan="7"><div class="empty">No available workers match these filters.</div></td></tr>';
  lfRenderPager('availabilityPager','availability','workers');
}
function openAvailableDeployment(){
  const w=workers.find(x=>x.active&&!activeDeployment(x.id));
  if(!w){alert('No workers are currently available.');return;}
  openDeploymentModal(w.id);
}

function requestShortage(r){return Math.max(0,Number(r.workersRequired||0)-(r.allocatedWorkerIds?.length||0));}
function renderExceptions(){
  const list=[];const date=today();
  const active=workers.filter(w=>w.active);
  const missing=active.filter(w=>peekAttendance(date,w.id).status==='pending');
  if(missing.length)list.push({severity:'High',type:'Missing attendance',details:`${missing.length} active worker(s) have no attendance for ${date}.`,action:`showPage('attendance')`});
  const overtime=active.filter(w=>(Number(peekAttendance(date,w.id).overtime)||0)>4);
  if(overtime.length)list.push({severity:'Medium',type:'Excessive overtime',details:`${overtime.length} worker(s) have more than 4 overtime hours today.`,action:`showPage('attendance')`});
  const overdue=labourRequests.filter(r=>r.status!=='Completed'&&r.status!=='Cancelled'&&requestShortage(r)>0&&r.startDate<date);
  if(overdue.length)list.push({severity:'High',type:'Overdue labour requests',details:`${overdue.length} request(s) started without full allocation.`,action:`showPage('requests')`});
  const unassignedAttendance=active.filter(w=>!activeDeployment(w.id)&&['worked','present'].includes(peekAttendance(date,w.id).status));
  if(unassignedAttendance.length)list.push({severity:'Medium',type:'Worked without deployment',details:`${unassignedAttendance.length} worker(s) are marked worked but have no active client deployment.`,action:`showPage('workers')`});
  const inactiveClients=deployments.filter(d=>d.status==='Active'&&!clientById(d.clientId)?.active);
  if(inactiveClients.length)list.push({severity:'High',type:'Inactive client assignment',details:`${inactiveClients.length} active deployment(s) belong to inactive clients.`,action:`showPage('clients')`});
  const pending=labourRequests.filter(r=>r.status==='Pending');
  if(pending.length)list.push({severity:'Low',type:'Pending labour requests',details:`${pending.length} request(s) are waiting for approval.`,action:`showPage('requests')`});
  const cards=document.getElementById('exceptionCards');if(cards)cards.innerHTML=`<div class="card"><div class="card-label">Open Exceptions</div><div class="card-value">${list.length}</div><div class="card-sub">Needs review</div></div><div class="card"><div class="card-label">High Severity</div><div class="card-value">${list.filter(x=>x.severity==='High').length}</div><div class="card-sub">Priority issues</div></div><div class="card"><div class="card-label">Medium</div><div class="card-value">${list.filter(x=>x.severity==='Medium').length}</div><div class="card-sub">Operational issues</div></div><div class="card"><div class="card-label">Low</div><div class="card-value">${list.filter(x=>x.severity==='Low').length}</div><div class="card-sub">Attention items</div></div>`;
  const table=document.getElementById('exceptionsTable');if(!table)return;
  table.innerHTML=list.length?list.map(x=>`<tr><td><span class="status ${x.severity==='High'?'status-absent':x.severity==='Medium'?'status-missing':'status-submitted'}">${x.severity}</span></td><td><strong>${esc(x.type)}</strong></td><td>${esc(x.details)}</td><td>${formatDateTime(new Date().toISOString())}</td><td><button class="secondary" onclick="${x.action}">Review</button></td></tr>`).join(''):'<tr><td colspan="5"><div class="empty">No operational exceptions detected. Good.</div></td></tr>';
}

function renderAudit(){
  const table=document.getElementById('auditTable');if(!table)return;
  const rows=lfPaginate('audit',auditLog,50);
  table.innerHTML=rows.length?rows.map(x=>`<tr><td>${formatDateTime(x.time)}</td><td><strong>${esc(x.action)}</strong></td><td>${esc(x.reference||'—')}</td><td>${esc(x.details||'—')}</td></tr>`).join(''):'<tr><td colspan="4"><div class="empty">No audit activity recorded yet.</div></td></tr>';
  lfRenderPager('auditPager','audit','entries');
}

/* Override deployment saving so every assignment has history. */
window.saveDeployment=function(){
  const id=Number(document.getElementById('deploymentWorkerId').value),w=workerById(id),clientId=Number(document.getElementById('deploymentClient').value),department=document.getElementById('deploymentDepartment').value,start=document.getElementById('deploymentStartDate').value,assignment=document.getElementById('deploymentAssignment').value.trim(),requestId=Number(document.getElementById('deploymentRequest').value)||null;
  if(!w||!clientId||!department||!start){alert('Select a client, department and start date.');return}
  if(activeDeployment(id)){alert('This worker already has an active deployment. End it before creating another.');return}
  const d={id:Date.now(),workerId:id,clientId,department,assignment:assignment||'Direct deployment',shift:'Day',startDate:start,endDate:null,status:'Active',requestId,reason:'New deployment'};
  deployments.push(d);syncWorkerDeployment(id);
  if(requestId){const r=requestById(requestId);if(r&&!r.allocatedWorkerIds.includes(id))r.allocatedWorkerIds.push(id);if(r&&r.allocatedWorkerIds.length)r.status='Allocated'}
  saveData();saveAdvanced();audit('Worker deployed',w.employeeNo,`${clientById(clientId)?.name||'Client'} — ${d.assignment}`);
  closeModal('deploymentModal');renderWorkers();rerenderIfActive('deployments');rerenderIfActive('availability');rerenderIfActive('dashboard');showToast(`${w.employeeNo} deployed successfully.`);
};

/* Allocation now creates deployment history too. */
window.saveAllocation=function(){
  const r=requestById(Number(document.getElementById('allocationRequestId').value));if(!r)return;
  const ids=[...document.querySelectorAll('#workerPicker input:checked')].map(x=>Number(x.value));
  if(ids.length>r.workersRequired){alert(`This request requires only ${r.workersRequired} worker(s).`);return;}
  const previous=r.allocatedWorkerIds||[];r.allocatedWorkerIds=ids;r.status=ids.length?'Allocated':'Approved';
  ids.forEach(id=>{
    const w=workerById(id);if(!w||activeDeployment(id))return;
    const d={id:Date.now()+id,workerId:id,clientId:r.clientId,department:r.department,assignment:`${r.requestNo} — ${r.department}`,shift:r.shift||'Day',startDate:r.startDate,endDate:null,status:'Active',requestId:r.id,reason:'Allocated from labour request'};
    deployments.push(d);syncWorkerDeployment(id);
  });
  previous.filter(id=>!ids.includes(id)).forEach(id=>{const d=activeDeployment(id);if(d&&d.requestId===r.id){d.status='Ended';d.endDate=today();d.reason='Removed from request allocation';syncWorkerDeployment(id)}});
  saveData();saveAdvanced();audit('Workers allocated',r.requestNo,`${ids.length} worker(s) allocated to ${clientById(r.clientId)?.name||'client'}`);
  closeModal('allocationModal');renderRequests();rerenderIfActive('workers');rerenderIfActive('deployments');rerenderIfActive('availability');rerenderIfActive('dashboard');showToast(`${ids.length} worker(s) allocated to ${r.requestNo}.`);
};

/* Dashboard management strip. */
function renderAdvancedDashboard(){
  const active=workers.filter(w=>w.active),available=active.filter(w=>!activeDeployment(w.id));
  const pending=labourRequests.filter(r=>r.status==='Pending').length;
  const shortage=labourRequests.reduce((n,r)=>n+requestShortage(r),0);
  let box=document.getElementById('advancedDashboard');
  if(!box){
    const dash=document.getElementById('dashboard');if(!dash)return;
    box=document.createElement('div');box.id='advancedDashboard';dash.appendChild(box);
  }
  box.innerHTML=`<div class="section"><div class="section-header"><h2>Operations Snapshot</h2><span class="muted">Live local data</span></div><div class="inner-padding"><div class="cards"><div class="card"><div class="card-label">Available Workforce</div><div class="card-value">${available.length}</div><div class="card-sub">of ${active.length} active workers</div></div><div class="card"><div class="card-label">Active Deployments</div><div class="card-value">${deployments.filter(d=>d.status==='Active').length}</div><div class="card-sub">Current assignments</div></div><div class="card"><div class="card-label">Pending Requests</div><div class="card-value">${pending}</div><div class="card-sub">Awaiting action</div></div><div class="card"><div class="card-label">Labour Shortage</div><div class="card-value">${shortage}</div><div class="card-sub">Workers still required</div></div></div></div></div>`;
}

const originalRenderDashboard=window.renderDashboard;
window.renderDashboard=function(){originalRenderDashboard();renderAdvancedDashboard();};

/* Audit important existing actions without changing their behavior.
   The Audit Trail page re-renders when opened, so no DOM work here. */
function wrapAudit(name,label){
  const original=window[name];if(typeof original!=='function')return;
  window[name]=function(...args){const result=original.apply(this,args);audit(label,'System','Action completed');return result;};
}
['approveRequest','cancelRequest','completeRequest','saveClient','toggleClient','saveWorker','toggleWorker','approveAttendance','calculatePayroll'].forEach((n,i)=>wrapAudit(n,['Labour request approved','Labour request cancelled','Labour request completed','Client saved','Client status changed','Worker saved','Worker status changed','Attendance approved','Payroll calculated'][i]));

LF_PAGER_RERENDER.deployments=()=>renderDeployments();
LF_PAGER_RERENDER.availability=()=>renderAvailability();
LF_PAGER_RERENDER.audit=()=>renderAudit();