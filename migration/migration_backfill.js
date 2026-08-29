/ =============================================================
//  LABOUR FORCE — BACKFILL MIGRATION
//  Phase 0: One-time push of localStorage data into Supabase.
//  1. window.lfBuildDiffReport() — see diff
//  2. window.lfRunBackfill()      — push to Supabase
// =============================================================
(function() {
  'use strict';
  var client = null;
  try { client = window.labourForceSupabase; } catch(e) {}
  if (!client) { console.error('Supabase not initialised.'); return; }

  function ls(k, fb) {
    try { var v = JSON.parse(localStorage.getItem(k)); return Array.isArray(v) && v.length ? v : fb; }
    catch (e) { return fb; }
  }
  function lsObj(k, fb) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v != null ? v : fb; }
    catch (e) { return fb; }
  }

  async function fetchAll(table) {
    var from = 0, page = 1000, all = [];
    while (true) {
      var r = await client.from(table).select('*').range(from, from + page - 1);
      if (r.error) throw new Error('fetchAll(' + table + '): ' + r.error.message);
      if (!r.data || !r.data.length) break;
      all = all.concat(r.data);
      if (r.data.length < page) break;
      from += page;
    }
    return all;
  }

  async function getCloud() {
    console.log('Fetching cloud state...');
    var p = await Promise.all([
      fetchAll('workers'), fetchAll('attendance'),
      fetchAll('attendance_approvals'), fetchAll('audit_logs'),
      fetchAll('deployments'), fetchAll('clients'),
      fetchAll('departments'), fetchAll('labour_requests')
    ]);
    return { cw: p[0], ca: p[1], cap: p[2], cal: p[3], cd: p[4], cc: p[5], cdept: p[6], cr: p[7] };
  }

  function buildDiff(ld, cl) {
    var L = [], i, k;
    L.push('\n===========================================================');
    L.push(' BACKFILL DIFF REPORT — Labour Force Migration');
    L.push(' Generated: ' + new Date().toISOString());
    L.push('===========================================================\n');

    var lw = ld.workers, cw = cl.cw, cwIds = {};
    for (i = 0; i < cw.length; i++) cwIds[String(cw[i].id)] = true;
    var onlyLW = lw.filter(function(w) { return !cwIds[String(w.id)]; });
    L.push('-- WORKERS ------------------------------------------');
    L.push('  Local: ' + lw.length + '  /  Cloud: ' + cw.length + '  /  Only local: ' + onlyLW.length + '\n');

    var la = ld.attendance, ca = cl.ca, caKeys = {};
    for (i = 0; i < ca.length; i++) caKeys[ca[i].worker_id + '|' + ca[i].attendance_date] = true;
    var entries = [];
    for (k in la) {
      if (!la[k].records) continue;
      for (var wid in la[k].records) entries.push({date: k, wid: Number(wid), rec: la[k].records[wid]});
    }
    var onlyLA = entries.filter(function(e) { return !caKeys[e.wid + '|' + e.date]; });
    L.push('-- ATTENDANCE ----------------------------------------');
    L.push('  Local days: ' + Object.keys(la).length + '  /  Total entries: ' + entries.length);
    L.push('  Cloud rows: ' + ca.length + '  /  Only local: ' + onlyLA.length + '\n');

    var ap = [];
    for (k in la) {
      if (la[k].submitted || la[k].approved)
        ap.push({date: k, submitted: la[k].submitted, approved: la[k].approved,
                 submittedAt: la[k].submittedAt, approvedAt: la[k].approvedAt});
    }
    L.push('-- ATTENDANCE APPROVALS ------------------------------');
    L.push('  Local submission records: ' + ap.length + '  /  Cloud: ' + cl.cap.length + '\n');

    var la_audit = ld.auditLog, calIds = {};
    for (i = 0; i < cl.cal.length; i++) calIds[String(cl.cal[i].id)] = true;
    var onlyLAudit = la_audit.filter(function(a) { return !calIds[String(a.id)]; });
    L.push('-- AUDIT LOG (full history, no 100-entry cap) --------');
    L.push('  Local: ' + la_audit.length + '  /  Cloud: ' + cl.cal.length + '  /  Only local: ' + onlyLAudit.length + '\n');

    var ld_d = ld.deployments, cd = cl.cd, cdIds = {};
    for (i = 0; i < cd.length; i++) cdIds[String(cd[i].id)] = true;
    var onlyLD = ld_d.filter(function(d) { return !cdIds[String(d.id)]; });
    L.push('-- DEPLOYMENTS ---------------------------------------');
    L.push('  Local: ' + ld_d.length + '  /  Cloud: ' + cd.length + '  /  Only local: ' + onlyLD.length + '\n');

    var lc = ld.clients, cc = cl.cc, ccIds = {};
    for (i = 0; i < cc.length; i++) ccIds[String(cc[i].id)] = true;
    var onlyLC = lc.filter(function(c) { return !ccIds[String(c.id)]; });
    L.push('-- CLIENTS -------------------------------------------');
    L.push('  Local: ' + lc.length + '  /  Cloud: ' + cc.length + '  /  Only local: ' + onlyLC.length + '\n');

    var ldept = ld.departments, cdept = cl.cdept, cdeptIds = {};
    for (i = 0; i < cdept.length; i++) cdeptIds[String(cdept[i].id)] = true;
    var onlyLDept = ldept.filter(function(d) { return !cdeptIds[String(d.id)]; });
    L.push('-- DEPARTMENTS ---------------------------------------');
    L.push('  Local: ' + ldept.length + '  /  Cloud: ' + cdept.length + '  /  Only local: ' + onlyLDept.length + '\n');

    var lr = ld.labourRequests, cr = cl.cr, crIds = {};
    for (i = 0; i < cr.length; i++) crIds[String(cr[i].id)] = true;
    var onlyLR = lr.filter(function(r) { return !crIds[String(r.id)]; });
    L.push('-- LABOUR REQUESTS -----------------------------------');
    L.push('  Local: ' + lr.length + '  /  Cloud: ' + cr.length + '  /  Only local: ' + onlyLR.length + '\n');

    L.push('===========================================================');
    L.push(' Run window.lfRunBackfill() to push union to Supabase.');
    L.push('===========================================================\n');
    return { onlyLW: onlyLW, onlyLA: onlyLA, ap: ap, onlyLAudit: onlyLAudit,
             onlyLD: onlyLD, onlyLC: onlyLC, onlyLDept: onlyLDept, onlyLR: onlyLR, lines: L };
  }

  function getLocal() {
    return {
      workers: ls('labourforce_workers', []),
      departments: ls('labourforce_departments', []),
      clients: ls('labourforce_clients', []),
      labourRequests: ls('labourforce_requests', []),
      attendance: lsObj('labourforce_attendance', {}),
      deployments: lsObj('labourforce_deployments', []),
      auditLog: lsObj('labourforce_audit', [])
    };
  }

  async function runBackfill(d) {
    var r;
    if (d.onlyLW.length) {
      var wRows = d.onlyLW.map(function(w) {
        return { id: w.id, employee_no: w.employeeNo, full_name: w.name, phone: w.phone || null,
                 national_id: w.nationalId || null, id_number: w.idNumber || null,
                 department_id: null, classification: w.classification || 'Unskilled',
                 designation: w.designation || null,
                 daily_rate: Number(w.rate) || 0, overtime_rate: Number(w.otRate) || 0,
                 join_date: w.joinDate || null, active: w.active !== false };
      });
      r = await client.from('workers').upsert(wRows, { onConflict: 'id' });
      if (r.error) console.error('Workers failed:', r.error.message); else console.log('+ Workers: ' + wRows.length);
    }
    if (d.onlyLA.length) {
      var aRows = d.onlyLA.map(function(e) {
        var s = e.rec.status;
        var status = (s === 'present' || s === 'worked' || s === 'approved') ? 'worked'
                   : s === 'pending' ? 'pending' : 'absent';
        return { worker_id: e.wid, attendance_date: e.date, status: status,
                 hours_worked: Number(e.rec.hours || e.rec.hoursWorked) || 0,
                 overtime_hours: Number(e.rec.overtime || e.rec.overtimeHours) || 0,
                 remarks: e.rec.remarks || e.rec.notes || null };
      });
      r = await client.from('attendance').insert(aRows);
      if (r.error) console.error('Attendance failed:', r.error.message); else console.log('+ Attendance: ' + aRows.length);
    }
    if (d.ap.length) {
      var apRows = d.ap.map(function(a) {
        return { attendance_date: a.date, department_id: null,
                 status: a.approved ? 'approved' : 'submitted',
                 submitted_at: a.submittedAt || null, approved_at: a.approvedAt || null };
      });
      r = await client.from('attendance_approvals').upsert(apRows, { onConflict: 'attendance_date,department_id' });
      if (r.error) console.error('Approvals failed:', r.error.message); else console.log('+ Approvals: ' + apRows.length);
    }
    if (d.onlyLAudit.length) {
      var audRows = d.onlyLAudit.map(function(a) {
        return { id: a.id, user_id: null, action: a.action || 'change',
                 table_name: a.tableName || 'operations', record_id: String(a.reference || ''),
                 old_data: a.oldData || null, new_data: a.newData || null,
                 metadata: { details: a.details || null, source: 'labour-force-frontend', time: a.time || null } };
      });
      r = await client.from('audit_logs').upsert(audRows, { onConflict: 'id' });
      if (r.error) console.error('Audit failed:', r.error.message); else console.log('+ Audit logs: ' + audRows.length + ' (full history, migrated from labourforce_audit)');
    }
    if (d.onlyLD.length) {
      var depRows = d.onlyLD.map(function(dd) {
        return { id: dd.id, worker_id: dd.workerId, client_id: dd.clientId || null,
                 request_id: dd.requestId || null, department_id: null,
                 position: dd.assignment || null, location: dd.location || null,
                 start_date: dd.startDate, end_date: dd.endDate || null,
                 shift: dd.shift || 'Day',
                 status: dd.status === 'Active' ? 'active' : dd.status === 'Ended' ? 'completed' : 'active',
                 created_by: null };
      });
      r = await client.from('deployments').upsert(depRows, { onConflict: 'id' });
      if (r.error) console.error('Deployments failed:', r.error.message); else console.log('+ Deployments: ' + depRows.length);
    }
    if (d.onlyLC.length) {
      var cRows = d.onlyLC.map(function(c) {
        return { id: c.id, name: c.name, contact_person: c.contact || null,
                 phone: c.phone || null, active: c.active !== false };
      });
      r = await client.from('clients').upsert(cRows, { onConflict: 'id' });
      if (r.error) console.error('Clients failed:', r.error.message); else console.log('+ Clients: ' + cRows.length);
    }
    if (d.onlyLDept.length) {
      var deptRows = d.onlyLDept.map(function(dd) {
        return { id: dd.id || Date.now() + Math.random(), name: dd.name,
                 active: dd.active !== false, parent_id: null };
      });
      r = await client.from('departments').upsert(deptRows, { onConflict: 'id' });
      if (r.error) console.error('Departments failed:', r.error.message); else console.log('+ Departments: ' + deptRows.length);
    }
    if (d.onlyLR.length) {
      var smap = { 'Pending': 'pending', 'Approved': 'approved',
                   'Allocated': 'partially_fulfilled', 'Completed': 'fulfilled', 'Cancelled': 'cancelled' };
      var reqRows = d.onlyLR.map(function(r) {
        return { id: r.id, request_no: r.requestNo, client_id: r.clientId || null,
                 department_id: null, classification: r.classification || null,
                 workers_required: Number(r.workersRequired) || 1,
                 start_date: r.startDate, end_date: null,
                 shift: r.shift || 'Day', notes: r.notes || null,
                 status: smap[r.status] || 'pending' };
      });
      r = await client.from('labour_requests').upsert(reqRows, { onConflict: 'id' });
      if (r.error) console.error('Labour requests failed:', r.error.message); else console.log('+ Requests: ' + reqRows.length);
    }
    console.log('\nBackfill complete.');
  }

  window.lfBuildDiffReport = (async function() {
    var ld = getLocal(), cl = await getCloud();
    var d = buildDiff(ld, cl);
    console.log(d.lines.join('\n'));
    return d;
  });

  window.lfRunBackfill = (async function() {
    var ld = getLocal(), cl = await getCloud();
    var d = buildDiff(ld, cl);
    console.log(d.lines.join('\n'));
    await runBackfill(d);
    return d;
  });

  console.log('Backfill loaded. Run window.lfBuildDiffReport() then window.lfRunBackfill().');
})();
