/* THE LABOUR FORCE - STAGE APPROVAL WORKFLOW UI */
let lfStageWorkflow = { stageDefinitions: [], pendingByStage: {}, selectedDate: null };

function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function lfUserCanApproveStage(stageName) {
    const role = String(window.lfCurrentRole || '').toLowerCase();
    const def = lfStageWorkflow.stageDefinitions.find(function(s) { return s.stage_name === stageName; });
    if (!def) return false;
    if (role === 'super_admin') return true;
    if (def.required_role === role) return true;
    if (role === 'administrator' && (def.required_role === 'supervisor' || def.required_role === 'accounts')) return true;
    return false;
}

async function loadStageDefinitions() {
    if (!labourForceSupabase) return;
    const { data, error } = await labourForceSupabase.from('stage_definitions')
        .select('*').eq('is_active', true).order('stage_order');
    if (!error && data) lfStageWorkflow.stageDefinitions = data;
}

function populateBatchFilter(records) {
    const sel = document.getElementById('stageApprovalBatch');
    if (!sel) return;
    const batches = [...new Set((records || []).map(function(r) { return r.batch_name; }).filter(Boolean))].sort();
    const currentValue = sel.value;
    sel.innerHTML = '<option value="">All batches</option>';
    batches.forEach(function(b) {
        const opt = document.createElement('option');
        opt.value = b;
        opt.textContent = b;
        sel.appendChild(opt);
    });
    if (currentValue && batches.indexOf(currentValue) !== -1) sel.value = currentValue;
}

async function loadStageApprovalData() {
    if (!labourForceSupabase || !labourForceSession) return;
    const date = document.getElementById('stageApprovalDate')?.value || new Date().toISOString().split('T')[0];
    lfStageWorkflow.selectedDate = date;
    const { data: records, error } = await labourForceSupabase.from('attendance')
        .select('id, worker_id, attendance_date, regular_hours, overtime_hours, status, workflow_status, current_stage, submitted_at, final_approved_at, batch_name, workers:worker_id (id, full_name, employee_no)')
        .eq('attendance_date', date)
        .in('workflow_status', ['in_progress', 'pending', 'approved', 'rejected']);
    if (error) { console.error('[Stage Approval] load failed:', error); return; }
    populateBatchFilter(records || []);
    const selectedBatch = document.getElementById('stageApprovalBatch')?.value || '';
    const filteredRecords = selectedBatch
        ? (records || []).filter(function(r) { return r.batch_name === selectedBatch; })
        : (records || []);
    lfStageWorkflow.pendingByStage = {};
    filteredRecords.forEach(function(r) {
        const stage = r.current_stage || 'supervisor';
        if (!lfStageWorkflow.pendingByStage[stage]) lfStageWorkflow.pendingByStage[stage] = [];
        lfStageWorkflow.pendingByStage[stage].push(r);
    });
    renderStageApprovalBoard();
    renderStageSummary();
    renderPipelineFlow();
    renderWorkflowTimeline();
}

function renderStageApprovalBoard() {
    const board = document.getElementById('stageApprovalBoard');
    if (!board) return;
    const defs = lfStageWorkflow.stageDefinitions;
    if (!defs.length) { board.innerHTML = '<div class="empty">No stages configured.</div>'; return; }
    const html = defs.map(function(def) {
        const recs = lfStageWorkflow.pendingByStage[def.stage_name] || [];
        const canApprove = lfUserCanApproveStage(def.stage_name);
        return '<div class="stage-column" data-stage="' + esc(def.stage_name) + '">' +
            '<div class="stage-column-header"><h3>' + esc(def.display_name) + '</h3><span class="stage-count">' + recs.length + '</span></div>' +
            '<div class="stage-column-body">' + renderStageRecordList(recs, canApprove) + '</div>' +
        '</div>';
    }).join('');
    board.innerHTML = '<div class="stage-board">' + html + '</div>';
}

function renderStageRecordList(records, canApprove) {
    if (!records.length) return '<div class="stage-empty">No records in this stage.</div>';
    return records.map(function(r) {
        const worker = r.workers || {};
        let h = '<div class="stage-record">';
        h += '<div class="stage-record-header"><strong>' + esc(worker.full_name || '(unknown)') + '</strong><span class="muted-chip">' + esc(worker.employee_no || '') + '</span></div>';
        h += '<div class="stage-record-meta"><span>Hours: ' + (r.regular_hours || 0) + '</span><span>OT: ' + (r.overtime_hours || 0) + '</span><span>Batch: <strong>' + esc(r.batch_name || '---') + '</strong></span></div>';
        if (canApprove) {
            h += '<div class="stage-record-actions">';
            h += '<button class="btn btn-success btn-sm" onclick="approveStage(\'' + r.id + '\', \'' + esc(r.current_stage) + '\')">Approve</button>';
            h += '<button class="btn btn-danger btn-sm" onclick="rejectStage(\'' + r.id + '\', \'' + esc(r.current_stage) + '\')">Reject</button>';
            h += '</div>';
        } else {
            h += '<div class="stage-record-actions muted">Read-only at this stage</div>';
        }
        h += '</div>';
        return h;
    }).join('');
}

function renderPipelineFlow() {
    const el = document.getElementById('pipelineFlow');
    if (!el) return;
    const stages = lfStageWorkflow.stageDefinitions || [];
    const html = '<div class="pipeline-flow"><div class="pipeline-label">Approval Pipeline</div><div class="pipeline-stages">' +
        stages.map(function(s) {
            const count = (lfStageWorkflow.pendingByStage[s.stage_name] || []).length;
            return '<div class="pipeline-stage"><div class="pipeline-stage-num">' + s.stage_order + '</div><div class="pipeline-stage-name">' + esc(s.display_name) + '</div><div class="pipeline-stage-count">' + count + '</div></div>' +
                (s.stage_order < stages.length ? '<div class="pipeline-arrow">&#8594;</div>' : '');
        }).join('') + '</div></div>';
    el.innerHTML = html;
}

function renderStageSummary() {
    const el = document.getElementById('stageApprovalSummary');
    if (!el) return;
    let pending = 0, approved = 0, rejected = 0;
    Object.values(lfStageWorkflow.pendingByStage).flat().forEach(function(r) {
        if (r.workflow_status === 'in_progress' || r.workflow_status === 'pending') pending++;
        else if (r.workflow_status === 'approved') approved++;
        else if (r.workflow_status === 'rejected') rejected++;
    });
    el.innerHTML =
        '<div class="stage-summary-cards">' +
        '<div class="card lift-on-hover"><div class="card-icon">&#9203;</div><div class="card-label">In Progress</div><div class="card-value">' + pending + '</div><div class="card-sub">Across all stages</div></div>' +
        '<div class="card lift-on-hover"><div class="card-icon">&#10003;</div><div class="card-label">Final Approved</div><div class="card-value">' + approved + '</div><div class="card-sub">Ready for payroll</div></div>' +
        '<div class="card lift-on-hover"><div class="card-icon">&#10007;</div><div class="card-label">Rejected</div><div class="card-value">' + rejected + '</div><div class="card-sub">Needs attention</div></div>' +
        '<div class="card lift-on-hover"><div class="card-icon">&#128203;</div><div class="card-label">Stages</div><div class="card-value">' + lfStageWorkflow.stageDefinitions.length + '</div><div class="card-sub">Active approval stages</div></div>' +
        '</div>';
}

async function renderWorkflowTimeline() {
    const el = document.getElementById('workflowTimeline');
    if (!el) return;
    const { data: events, error } = await labourForceSupabase.from('workflow_events')
        .select('*').order('created_at', { ascending: false }).limit(50);
    if (error) { console.error('[Timeline] load failed:', error); return; }
    if (!events || !events.length) { el.innerHTML = '<div class="empty">No workflow events yet.</div>'; return; }
    const icons = { 'submitted': '&#128229;', 'stage_approved': '&#10003;', 'stage_rejected': '&#10007;', 'reopened': '&#8634;', 'final_approved': '&#127882;' };
    el.innerHTML = events.map(function(e) {
        const icon = icons[e.event_type] || '&#8226;';
        const time = new Date(e.created_at).toLocaleString();
        return '<div class="timeline-item"><div class="timeline-icon timeline-' + e.event_type + '">' + icon + '</div>' +
            '<div class="timeline-content"><div class="timeline-header"><strong>' + esc(e.actor_name || 'System') + '</strong> <span class="muted">' + esc(e.actor_role || '') + '</span></div>' +
            '<div class="timeline-action">' + esc(e.event_type) + (e.stage_name ? ' at ' + esc(e.stage_name) : '') + '</div>' +
            '<div class="timeline-meta"><span>' + time + '</span>' +
            (e.previous_status ? '<span class="muted">' + esc(e.previous_status) + ' &#8594; ' + esc(e.new_status) + '</span>' : '') + '</div></div></div>';
    }).join('');
}

async function approveStage(attendanceId, stageName) {
    const notes = prompt('Approve at ' + stageName + ' stage? Add notes (optional):') || '';
    if (notes === null) return;
    const { data, error } = await labourForceSupabase.rpc('advance_workflow_stage', {
        p_attendance_id: attendanceId, p_stage_name: stageName,
        p_approver_id: labourForceSession.user.id,
        p_approver_name: window.lfCurrentProfile?.full_name || 'Unknown',
        p_notes: notes
    });
    if (error) { showToast('Approval failed: ' + error.message); return; }
    if (data && data.ok) {
        const msg = data.is_final ? 'Final approval granted! Ready for payroll.' : 'Approved at ' + stageName + '. Now at ' + data.next_stage + ' stage.';
        showToast(msg);
        await loadStageApprovalData();
    } else { showToast('Approval failed: ' + (data?.error || 'Unknown error')); }
}

async function rejectStage(attendanceId, stageName) {
    const reason = prompt('Reject at ' + stageName + ' stage? Enter reason (required):');
    if (!reason || !reason.trim()) { showToast('Rejection reason is required.'); return; }
    const { data, error } = await labourForceSupabase.rpc('reject_workflow_stage', {
        p_attendance_id: attendanceId, p_stage_name: stageName,
        p_approver_id: labourForceSession.user.id,
        p_approver_name: window.lfCurrentProfile?.full_name || 'Unknown',
        p_rejection_reason: reason
    });
    if (error) { showToast('Rejection failed: ' + error.message); return; }
    if (data && data.ok) { showToast('Rejected. Submitter will be notified.'); await loadStageApprovalData(); }
}

async function submitForApproval(attendanceId) {
    const { data, error } = await labourForceSupabase.rpc('submit_for_approval', {
        p_attendance_id: attendanceId,
        p_submitter_id: labourForceSession.user.id,
        p_submitter_name: window.lfCurrentProfile?.full_name || 'Unknown'
    });
    if (error) { showToast('Submission failed: ' + error.message); return; }
    if (data && data.ok) { showToast('Submitted! Now at ' + data.first_stage + ' stage.'); await loadStageApprovalData(); }
    else { showToast('Submission failed: ' + (data?.error || 'Unknown error')); }
}

async function initStageApproval() {
    await loadStageDefinitions();
    await loadStageApprovalData();
    setInterval(loadStageApprovalData, 30000);
}

window.initStageApproval = initStageApproval;
window.loadStageApprovalData = loadStageApprovalData;
window.approveStage = approveStage;
window.rejectStage = rejectStage;
window.submitForApproval = submitForApproval;
window.lfUserCanApproveStage = lfUserCanApproveStage;
window.populateBatchFilter = populateBatchFilter;
