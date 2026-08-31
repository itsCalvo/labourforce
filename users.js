/* ============================================================
   THE LABOUR FORCE — USER & ACCESS CENTRE
   Frontend management for Supabase Auth + profiles + roles.
   Account creation is delegated to the manage-users Edge Function.
   Performance: single-flight data loading (no duplicate queries),
   paginated user table.
   ============================================================ */

let lfUsers = [];
let lfRoles = [];
let lfPermissionsByRole = {};
let lfUserReady = false;
let lfUserLoadInFlight = null;

function lfRoleLabel(name){
  return String(name||'').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
}
function lfCurrentRoleName(){ return window.lfCurrentRole || ''; }
function lfCanManageUsers(){ return lfCurrentRoleName()==='super_admin' || lfCurrentRoleName()==='administrator'; }

async function loadUserAccessData(){
  if(!labourForceSupabase || !labourForceSession){ return false; }
  /* Single-flight: concurrent callers share one request set. */
  if(lfUserLoadInFlight)return lfUserLoadInFlight;
  lfUserLoadInFlight=(async()=>{
    try{
      const [{data:roles,error:roleError},{data:profiles,error:profileError},{data:rp,error:rpError},{data:me,error:meError}] = await Promise.all([
        labourForceSupabase.from('roles').select('id,name,description').order('name'),
        labourForceSupabase.from('profiles').select('id,full_name,email,phone,active,created_at,updated_at,role_id,roles(id,name)').order('full_name'),
        labourForceSupabase.from('role_permissions').select('role_id,permission_id,permissions(id,code,description)'),
        labourForceSupabase.from('profiles').select('id,full_name,active,role_id,roles(name)').eq('id',labourForceSession.user.id).maybeSingle()
      ]);
      if(roleError) throw roleError;
      if(profileError) throw profileError;
      if(rpError) throw rpError;
      if(meError) throw meError;
      lfRoles=roles||[]; lfUsers=profiles||[];
      lfPermissionsByRole={};
      (rp||[]).forEach(x=>{
        lfPermissionsByRole[x.role_id] ||= [];
        if(x.permissions) lfPermissionsByRole[x.role_id].push(x.permissions);
      });
      window.lfCurrentRole=me?.roles?.name||'';
      window.lfCurrentProfile=me||null;
      lfUserReady=true;
      return true;
    }catch(error){
      console.error('[Labour Force] user access load failed',error);
      showToast(`Users could not be loaded: ${error.message||'permission denied'}`);
      return false;
    }finally{
      lfUserLoadInFlight=null;
    }
  })();
  return lfUserLoadInFlight;
}

function renderUserRoleOptions(){
  const select=document.getElementById('userRole');
  const filter=document.getElementById('userRoleFilter');
  if(!select||!filter)return;
  const current=select.value;
  const allowed=lfRoles.filter(r=>lfCurrentRoleName()==='super_admin'||r.name!=='super_admin');
  select.innerHTML=allowed.map(r=>`<option value="${esc(r.id)}">${esc(lfRoleLabel(r.name))}</option>`).join('');
  if(current && [...select.options].some(o=>o.value===current))select.value=current;
  const fc=filter.value;
  filter.innerHTML='<option value="all">All Roles</option>'+allowed.map(r=>`<option value="${esc(r.name)}">${esc(lfRoleLabel(r.name))}</option>`).join('');
  if([...filter.options].some(o=>o.value===fc))filter.value=fc;
  select.onchange=renderUserPermissionPreview;
}

function renderUserPermissionPreview(){
  const roleId=document.getElementById('userRole')?.value;
  const box=document.getElementById('userPermissionPreview');
  if(!box)return;
  const perms=lfPermissionsByRole[roleId]||[];
  box.innerHTML=`<strong>Role permissions · ${esc(lfRoleLabel(lfRoles.find(r=>r.id===roleId)?.name||''))}</strong><div class="permission-grid">${perms.length?perms.map(p=>`<span class="permission-chip">✓ ${esc(p.code)}</span>`).join(''):'<span class="muted">No permissions assigned to this role.</span>'}</div>`;
}

function renderUsers(){
  if(!lfCanManageUsers()){
    const table=document.getElementById('usersTable'); if(table)table.innerHTML='<tr><td colspan="7"><div class="empty">You do not have permission to manage users.</div></td></tr>';
    return;
  }
  renderUserRoleOptions();
  const search=(document.getElementById('userSearch')?.value||'').toLowerCase();
  const role=document.getElementById('userRoleFilter')?.value||'all';
  const rows=lfUsers.filter(u=>{
    const roleName=u.roles?.name||'';
    return (!search || `${u.full_name||''} ${u.email||''} ${roleName}`.toLowerCase().includes(search)) && (role==='all'||roleName===role);
  });
  const active=lfUsers.filter(u=>u.active).length;
  const inactive=lfUsers.length-active;
  const cards=document.getElementById('userSummaryCards');
  if(cards)cards.innerHTML=`<div class="card"><div class="card-label">Total Users</div><div class="card-value">${lfUsers.length}</div><div class="card-sub">Labour Force accounts</div></div><div class="card"><div class="card-label">Active</div><div class="card-value">${active}</div><div class="card-sub">Can access the system</div></div><div class="card"><div class="card-label">Inactive</div><div class="card-value">${inactive}</div><div class="card-sub">Access disabled</div></div>`;
  const table=document.getElementById('usersTable'); if(!table)return;
  const pageRows=lfPaginate('users',rows,25);
  table.innerHTML=pageRows.length?pageRows.map(u=>{
    const roleName=u.roles?.name||'unassigned';
    const perms=(lfPermissionsByRole[u.role_id]||[]).length;
    const self=u.id===labourForceSession?.user?.id;
    return `<tr><td><strong>${esc(u.full_name||'Unnamed')}</strong>${self?'<br><small class="muted">You</small>':''}</td><td>${esc(u.email||'—')}</td><td><span class="role-pill">${esc(lfRoleLabel(roleName))}</span></td><td><span class="status ${u.active?'status-worked':'status-missing'}">${u.active?'Active':'Inactive'}</span></td><td>${perms} permissions</td><td>${esc(formatDateTime(u.updated_at||u.created_at))}</td><td>${self?'—':`<button class="secondary" onclick="editUserAccount('${u.id}')">Manage</button>`}</td></tr>`;
  }).join(''):'<tr><td colspan="7"><div class="empty">No users found.</div></td></tr>';
  lfRenderPager('usersPager','users','users');
}

async function openUserModal(){
  ensureModal('userModal');
  if(!lfCanManageUsers()){showToast('You do not have permission to manage users.');return;}
  /* Ensure the data layer is hydrated so the role <select> is populated
     before the user sees an empty dropdown. */
  if(!lfUserReady){
    const ok=await loadUserAccessData();
    if(!ok){showToast('Could not load roles yet. Please retry.');return;}
  }
  document.getElementById('editingUserId').value='';
  document.getElementById('userModalTitle').textContent='Create Labour Force User';
  document.getElementById('userFullName').value='';
  document.getElementById('userEmail').value='';
  document.getElementById('userPhone').value='';
  document.getElementById('userPassword').value='';
  document.getElementById('userPasswordGroup').style.display='block';
  document.getElementById('userActive').value='true';
  /* Populate the role select NOW that we know we have roles loaded. */
  renderUserRoleOptions();
  const role=document.getElementById('userRole');
  if(role&&role.options.length){role.selectedIndex=0;}
  document.getElementById('saveUserBtn').textContent='Create User';
  document.getElementById('userWarning').textContent='New users receive a temporary password. They can sign in immediately and change it later.';
  renderUserPermissionPreview();
  document.getElementById('userModal').classList.add('show');
}

async function editUserAccount(id){
  ensureModal('userModal');
  if(!lfUserReady){
    const ok=await loadUserAccessData();
    if(!ok){showToast('Could not load users yet. Please retry.');return;}
  }
  const u=lfUsers.find(x=>x.id===id); if(!u)return;
  if(u.id===labourForceSession?.user?.id){showToast('You cannot change your own role or status here.');return;}
  /* Repopulate the role select to be safe in case the modal was opened in a
     different page state and the data is stale. */
  renderUserRoleOptions();
  document.getElementById('editingUserId').value=u.id;
  document.getElementById('userModalTitle').textContent='Manage User Access';
  document.getElementById('userFullName').value=u.full_name||'';
  document.getElementById('userEmail').value=u.email||'';
  document.getElementById('userPhone').value=u.phone||'';
  document.getElementById('userPassword').value='';
  document.getElementById('userPasswordGroup').style.display='none';
  document.getElementById('userActive').value=String(u.active!==false);
  document.getElementById('userRole').value=u.role_id||'';
  document.getElementById('saveUserBtn').textContent='Save Access Changes';
  document.getElementById('userWarning').textContent='Changing a role immediately changes what this user can do. Every access change is audited.';
  renderUserPermissionPreview();
  document.getElementById('userModal').classList.add('show');
}

async function callManageUsers(payload){
  if(!labourForceSession)throw new Error('Connect to Supabase first.');
  const response=await fetch(`${LABOUR_FORCE_SUPABASE_URL}/functions/v1/manage-users`,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${labourForceSession.access_token}`},body:JSON.stringify(payload)
  });
  let body={}; try{body=await response.json();}catch{}
  if(!response.ok)throw new Error(body.error||body.message||`Request failed (${response.status})`);
  return body;
}

async function saveUserAccount(){
  if(!lfCanManageUsers()){showToast('You do not have permission to manage users.');return;}
  const id=document.getElementById('editingUserId').value;
  const full_name=document.getElementById('userFullName').value.trim();
  const email=document.getElementById('userEmail').value.trim();
  const phone=document.getElementById('userPhone').value.trim();
  const role_id=document.getElementById('userRole').value;
  const active=document.getElementById('userActive').value==='true';
  const password=document.getElementById('userPassword').value;
  if(!full_name||!email||!role_id){showToast('Name, email and role are required.');return;}
  if(!id && password.length<8){showToast('Temporary password must be at least 8 characters.');return;}
  const selectedRole=lfRoles.find(r=>r.id===role_id);
  if(selectedRole?.name==='super_admin' && lfCurrentRoleName()!=='super_admin'){showToast('Only a super admin can assign the super admin role.');return;}
  const btn=document.getElementById('saveUserBtn'); btn.disabled=true; btn.textContent='Saving…';
  try{
    await callManageUsers(id?{action:'update',user_id:id,full_name,email,phone,role_id,active}:{action:'create',full_name,email,phone,role_id,password,active});
    localStorage.setItem('labourforce_cloud_dirty','1');
    closeModal('userModal');
    await loadUserAccessData(); renderUsers();
    showToast(id?'User access updated.':'User account created successfully.');
  }catch(error){
    console.error('[Labour Force] user save failed',error);
    showToast(error.message||'Unable to save user.');
  }finally{btn.disabled=false;btn.textContent=id?'Save Access Changes':'Create User';}
}

async function initUsers(){
  if(!labourForceSession||!labourForceSupabase)return;
  /* Show a lightweight skeleton while the data layer hydrates so the page
     never appears empty or half-populated. */
  renderUsersLoadingState();
  const ok=await loadUserAccessData();
  if(ok){
    renderRolesOverview();
    if(lfCurrentPage==='users')renderUsers();
  }else if(lfCurrentPage==='users'){
    renderUsersErrorState();
  }
}

function renderUsersLoadingState(){
  const table=document.getElementById('usersTable');
  if(table&&!table.innerHTML.trim()){
    table.innerHTML='<tr><td colspan="7"><div class="empty"><div class="lf-skel" style="height:14px;width:60%;margin:6px auto"></div><div class="lf-skel" style="height:14px;width:45%;margin:6px auto"></div><div class="lf-skel" style="height:14px;width:55%;margin:6px auto"></div></div></td></tr>';
  }
  const cards=document.getElementById('userSummaryCards');
  if(cards&&!cards.innerHTML.trim()){
    cards.innerHTML='<div class="card"><div class="card-label">Total Users</div><div class="card-value lf-skel" style="height:30px;width:40px"></div><div class="card-sub">Loading…</div></div><div class="card"><div class="card-label">Active</div><div class="card-value lf-skel" style="height:30px;width:40px"></div><div class="card-sub">Loading…</div></div><div class="card"><div class="card-label">Inactive</div><div class="card-value lf-skel" style="height:30px;width:40px"></div><div class="card-sub">Loading…</div></div>';
  }
  const rolesBox=document.getElementById('rolesOverview');
  if(rolesBox&&!rolesBox.innerHTML.trim()){
    rolesBox.innerHTML='<div class="lf-skel" style="height:18px;width:50%;margin:8px 0"></div><div class="lf-skel" style="height:18px;width:60%;margin:8px 0"></div><div class="lf-skel" style="height:18px;width:45%;margin:8px 0"></div>';
  }
}

function renderUsersErrorState(){
  const table=document.getElementById('usersTable');
  if(table)table.innerHTML='<tr><td colspan="7"><div class="empty">Could not load users. <button class="secondary" style="margin-left:10px" onclick="initUsers()">Retry</button></div></td></tr>';
  const cards=document.getElementById('userSummaryCards');
  if(cards)cards.innerHTML='<div class="card"><div class="card-label">Total Users</div><div class="card-value">—</div><div class="card-sub">Unable to load</div></div><div class="card"><div class="card-label">Active</div><div class="card-value">—</div><div class="card-sub">Unable to load</div></div><div class="card"><div class="card-label">Inactive</div><div class="card-value">—</div><div class="card-sub">Unable to load</div></div>';
  const rolesBox=document.getElementById('rolesOverview');
  if(rolesBox)rolesBox.innerHTML='<div class="empty">Could not load roles. <button class="secondary" style="margin-left:10px" onclick="initUsers()">Retry</button></div>';
}

function renderRolesOverview(){
  const box=document.getElementById('rolesOverview');
  if(!box)return;
  if(!lfRoles||!lfRoles.length){
    box.innerHTML='<div class="empty">No roles configured yet.</div>';
    return;
  }
  const visibleRoles=lfRoles.filter(r=>lfCurrentRoleName()==='super_admin'||r.name!=='super_admin');
  const userCountByRole={};
  lfUsers.forEach(u=>{if(u.role_id)userCountByRole[u.role_id]=(userCountByRole[u.role_id]||0)+1;});
  box.innerHTML=visibleRoles.map(r=>{
    const perms=lfPermissionsByRole[r.id]||[];
    const count=userCountByRole[r.id]||0;
    const permChips=perms.length?perms.slice(0,8).map(p=>`<span class="permission-chip">${esc(p.code)}</span>`).join('')+(perms.length>8?`<span class="permission-chip muted-chip">+${perms.length-8} more</span>`:''):'<span class="muted" style="font-size:12px">No permissions assigned</span>';
    return `<div class="role-card" data-role-id="${esc(r.id)}"><div class="role-card-head"><div><span class="role-pill">${esc(lfRoleLabel(r.name))}</span> <small class="muted">${count} user${count===1?'':'s'}</small></div><strong>${perms.length} permission${perms.length===1?'':'s'}</strong></div><div class="permission-grid" style="margin-top:8px">${permChips}</div></div>`;
  }).join('')||'<div class="empty">No roles available.</div>';
}

window.renderUsers=renderUsers;
window.openUserModal=openUserModal;
window.editUserAccount=editUserAccount;
window.saveUserAccount=saveUserAccount;
window.initUsers=initUsers;
window.renderRolesOverview=renderRolesOverview;
window.addEventListener('labourforce:ready',initUsers);
/* Fallback timer kept for robustness; single-flight prevents double loads. */
setTimeout(()=>{if(labourForceSession)initUsers();},1200);
LF_PAGER_RERENDER.users=()=>{if(lfUserReady&&typeof renderUsers==='function')renderUsers();};
