// ===== Supervisor Portal =====
(function () {
  'use strict';

  var supSession = null, supProfile = null, supWorkers = [], supAttendance = {};
  var supSelectedDate = null, supDirty = false;

  function supInitClient() {
    // Preferred: client already initialized by supabase.js (boots async, may not be ready on first try)
    if (typeof window.labourForceSupabase !== 'undefined' && window.labourForceSupabase) return window.labourForceSupabase;
    if (typeof labourForceSupabase !== 'undefined' && labourForceSupabase) return labourForceSupabase;
    // Fallback: build our own client from config.js
    if (typeof window.supabase !== 'undefined' && typeof window.LABOUR_FORCE_SUPABASE_URL !== 'undefined' && typeof window.LABOUR_FORCE_SUPABASE_ANON_KEY !== 'undefined') {
      try {
        return window.supabase.createClient(window.LABOUR_FORCE_SUPABASE_URL, window.LABOUR_FORCE_SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
      } catch (e) { console.error('[Supervisor] createClient failed:', e); return null; }
    }
    console.warn('[Supervisor] Supabase not configured. labourForceSupabase:', typeof window.labourForceSupabase, 'lib:', typeof window.supabase, 'url:', typeof window.LABOUR_FORCE_SUPABASE_URL);
    return null;
  }

  function supDate() {
    if (supSelectedDate) return supSelectedDate;
    var d = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function mapWorkerRow(row) {
    return {
      id: row.id,
      name: row.full_name || row.name || row.fullname || '(no name)',
      employeeNo: row.employee_no || row.staff_no || row.employeeNumber || '',
      idNumber: row.id_number || row.national_id || row.nationalId || '',
      department: row.department || row.department_name || '',
      _active: row.active
    };
  }

  function finalizeWorkers(rows) {
    var filtered = rows.filter(function (w) {
      if (w._active === undefined || w._active === null) return true;
      return w._active === true || w._active === 't' || w._active === 1 || w._active === '1';
    });
    filtered.sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    return filtered;
  }

  function mapAttendanceRow(row) {
    return {
      id: row.id,
      workerId: row.worker_id || row.workerId,
      status: row.status || 'present',
      hoursWorked: row.hours_worked != null ? row.hours_worked : (row.hours != null ? row.hours : null),
      overtimeHours: row.overtime_hours != null ? row.overtime_hours : (row.overtime != null ? row.overtime : null),
      remarks: row.remarks || row.notes || ''
    };
  }

  function supAuthState() {
    var client = supInitClient();
    if (!client) {
      // The async bootLabourForceCloud() in supabase.js hasn't finished yet.
      // Wait up to 5s for it to set window.labourForceSupabase, then retry.
      var waited = 0;
      var poll = setInterval(function () {
        waited += 100;
        client = supInitClient();
        if (client || waited >= 5000) {
          clearInterval(poll);
          if (!client) { console.warn('[Supervisor] Supabase not available after 5s'); supShowSignIn(); return; }
          doAuth(client);
        }
      }, 100);
      return;
    }
    doAuth(client);
  }

  function doAuth(client) {
    // Sync session from window if supabase.js already finished boot
    if (window.labourForceSession) {
      supSession = window.labourForceSession;
      supLoadProfile();
      return;
    }
    client.auth.getSession().then(function (r) {
      supSession = r.data && r.data.session;
      if (supSession) supLoadProfile();
      else supShowSignIn();
    })['catch'](function (e) { console.error('[Supervisor] getSession error:', e); supShowSignIn(); });
    client.auth.onAuthStateChange(function (_event, session) {
      supSession = session;
      window.labourForceSession = session;
      if (session) supLoadProfile();
      else supShowSignIn();
    });
  }

  function supLoadProfile() {
    var client = supInitClient();
    if (!supSession) { supShowSignIn(); return; }
    client.from('profiles').select('*').eq('id', supSession.user.id).single()
      .then(function (r) {
        if (r.error) console.warn('[Supervisor] profile read failed:', r.error.message);
        supProfile = r.data || { id: supSession.user.id, email: supSession.user.email, roles: { name: 'supervisor' } };
        supShowPortal();
      })['catch'](function (e) {
        console.error('[Supervisor] profile error:', e);
        supProfile = { id: supSession.user.id, email: supSession.user.email, roles: { name: 'supervisor' } };
        supShowPortal();
      });
  }

  function supShowSignIn() {
    var portal = document.getElementById('supPortal');
    var auth = document.getElementById('supAuth');
    if (portal) portal.style.display = 'none';
    if (auth) auth.classList.add('show');
  }

  function supShowPortal() {
    var portal = document.getElementById('supPortal');
    var auth = document.getElementById('supAuth');
    if (portal) portal.style.display = '';
    if (auth) auth.classList.remove('show');
    var role = supProfile && supProfile.roles && supProfile.roles.name || '';
    var displayName = (supProfile && (supProfile.full_name || supProfile.email)) || (supSession && supSession.user && supSession.user.email) || '-';
    var nameEl = document.getElementById('supUserName');
    var metaEl = document.getElementById('supUserMeta');
    var avatarEl = document.getElementById('supAvatar');
    if (nameEl) nameEl.textContent = displayName;
    if (metaEl) metaEl.textContent = role ? role + ' - Supervisor Portal' : 'Supervisor Portal';
    if (avatarEl) avatarEl.textContent = displayName.charAt(0).toUpperCase();
    supLoadWorkersAndAttendance();
  }

﻿

  document.addEventListener('DOMContentLoaded', function () {
    var doLogin = document.getElementById('supDoLogin');
    if (doLogin) doLogin.addEventListener('click', function () {
      var email = ((document.getElementById('supEmail') || {}).value || '').trim();
      var password = (document.getElementById('supPassword') || {}).value || '';
      var client = supInitClient();
      if (!client) { supToast('Supabase not configured', 'error'); return; }
      if (!email || !password) { supToast('Email and password required', 'error'); return; }
      var errEl = document.getElementById('supLoginErr');
      if (errEl) errEl.textContent = '';
      client.auth.signInWithPassword({ email: email, password: password })
        .then(function (r) {
          if (r.error) { if (errEl) errEl.textContent = r.error.message; return; }
          supSession = r.data.session;
          supLoadProfile();
        })['catch'](function (e) { if (errEl) errEl.textContent = String(e && e.message || e); });
    });

    var signOut = document.getElementById('supSignOut');
    if (signOut) signOut.addEventListener('click', function () {
      var client = supInitClient();
      if (client) client.auth.signOut();
      supSession = null; supProfile = null;
      supShowSignIn();
    });

    var dateInput = document.getElementById('supDate');
    if (dateInput) {
      dateInput.value = supDate();
      dateInput.addEventListener('change', function (e) {
        supSelectedDate = e.target.value || null;
        if (supSession) supLoadAttendance();
      });
    }

    var searchInput = document.getElementById('supSearch');
    if (searchInput) {
      // Trigger search on Enter (avoids hitting the DB on every keystroke)
      searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); supSearchWorkers(searchInput.value); }
      });
      // Also re-search after a short idle (debounce) so users get live results
      var debTimer = null;
      searchInput.addEventListener('input', function () {
        if (debTimer) clearTimeout(debTimer);
        var v = searchInput.value.trim();
        if (v.length < 2) {
          supWorkers = []; supRenderSearch();
          return;
        }
        debTimer = setTimeout(function () { supSearchWorkers(v); }, 350);
      });
    }

    var markAbsentBtn = document.getElementById('supMarkAbsentSelected');
    if (markAbsentBtn) markAbsentBtn.addEventListener('click', function () {
      var ids = supSelectedIds();
      if (!ids.length) { supToast('Select workers first.', 'error'); return; }
      ids.forEach(function (id) {
        var r = supRecord(id);
        if (r.status !== 'pending') return;
        supAttendance[id] = { status: 'absent', hoursWorked: 0, overtimeHours: 0, remarks: '' };
      });
      supDirty = true; supSaveLocalDraft();
      supUpdateMetrics(); supRenderTable(); supRenderSearch();
    });

    var cancelBtn = document.getElementById('supCancelSelected');
    if (cancelBtn) cancelBtn.addEventListener('click', function () {
      var ids = supSelectedIds();
      if (!ids.length) { supToast('Select workers first.', 'error'); return; }
      ids.forEach(function (id) { delete supAttendance[id]; });
      supDirty = true; supSaveLocalDraft();
      supUpdateMetrics(); supRenderTable(); supRenderSearch();
    });

    var editBtn = document.getElementById('supEditSelected');
    if (editBtn) editBtn.addEventListener('click', function () {
      var ids = supSelectedIds();
      if (!ids.length) { supToast('Select a worker first.', 'error'); return; }
      supEditRow(ids[0]);
    });

    var selectAll = document.getElementById('supSelectAll');
    if (selectAll) selectAll.addEventListener('change', function (e) {
      document.querySelectorAll('.sup-sel').forEach(function (cb) { cb.checked = e.target.checked; });
    });

    var submitBtn = document.getElementById('supSubmitBtn');
    if (submitBtn) submitBtn.addEventListener('click', supSubmitAttendance);

    supAuthState();
    supLoadLocalDraft();
  });

  // ---- Worker loading (on portal entry) ----
  // supWorkers holds the *current search result set* (small).
  // supAssignedCount holds the total number of workers assigned to this supervisor
  // (used for the "Expected" stat; we only need a count, not the full list).
  var supAssignedCount = null;
  function supLoadWorkersAndAttendance() {
    supWorkers = [];
    supLoadAssignedCount();
    supLoadAttendance();
  }

  function supLoadAssignedCount() {
    var client = supInitClient();
    if (!client) { supAssignedCount = 0; supUpdateMetrics(); return; }
    client.from('workers').select('id', { count: 'exact', head: true }).limit(1)
      .then(function (result) {
        if (result.error) { console.warn('[Supervisor] workers count failed:', result.error.message); supAssignedCount = 0; }
        else supAssignedCount = result.count || 0;
        supUpdateMetrics();
      })['catch'](function (e) { console.warn('[Supervisor] workers count error:', e); supAssignedCount = 0; supUpdateMetrics(); });
  }

  // ---- Lazy worker search (server-side filtered) ----
  var supSearchToken = 0; // debounce/cancel stale searches
  var supSearchCache = {}; // query → { rows, ts } for repeat-query fast path
  var supSearchCacheMs = 60000; // cache entries expire after 60 s

  function supSearchWorkers(query) {
    var container = document.getElementById('supSearchResults');
    if (!container) return;
    var q = (query || '').trim();
    if (q.length < 2) {
      container.innerHTML = '<div class="sup-hint">Type at least 2 characters and press Enter to search for a worker.</div>';
      return;
    }
    var client = supInitClient();
    if (!client) { container.innerHTML = '<div class="sup-empty">Supabase not available</div>'; return; }
    var myToken = ++supSearchToken;
    // Cache: repeat same query (ignoring case) within 60 s hits local memory.
    var cacheKey = q.toLowerCase();
    var cached = supSearchCache[cacheKey];
    if (cached && (Date.now() - cached.ts) < supSearchCacheMs) {
      if (myToken !== supSearchToken) return;
      supWorkers = cached.rows;
      supRenderSearch();
      return;
    }
    container.innerHTML = '<div class="sup-hint"><span class="sup-spinner"></span> Searching...</div>';
    var ilike = '%' + q + '%';
    // RLS on the `workers` table returns only rows the current profile may see.
    // Only request the columns we actually use to minimise payload.
    client.from('workers')
      .select('id,employee_no,id_number,full_name,department,active')
      .or('full_name.ilike.' + ilike + ',employee_no.ilike.' + ilike + ',id_number.ilike.' + ilike)
      .limit(20)
      .then(function (result) {
        if (myToken !== supSearchToken) return; // stale
        if (result.error) { console.warn('[Supervisor] workers search failed:', result.error.message); container.innerHTML = '<div class="sup-empty">Search failed: ' + supEscape(result.error.message) + '</div>'; return; }
        var rows = (result.data || []).map(mapWorkerRow);
        supSearchCache[cacheKey] = { rows: rows, ts: Date.now() };
        supWorkers = rows;
        supRenderSearch();
      })['catch'](function (e) {
        if (myToken !== supSearchToken) return;
        console.error('[Supervisor] search error:', e);
        container.innerHTML = '<div class="sup-empty">Search error: ' + supEscape(e && e.message || String(e)) + '</div>';
      });
  }

  function supLoadAttendance() {
    if (!supSession) { supRenderSearch(); supRenderTable(); return; }
    var client = supInitClient();
    var today = supDate();
    client.from('attendance').select('*').eq('attendance_date', today)
      .then(function (result) {
        if (result.error) { console.warn('[Supervisor] attendance read failed:', result.error.message); supAttendance = {}; }
        else {
          supAttendance = {};
          (result.data || []).forEach(function (row) { var m = mapAttendanceRow(row); if (m.workerId != null) supAttendance[String(m.workerId)] = m; });
        }
        supUpdateMetrics(); supRenderSearch(); supRenderTable();
      })['catch'](function (e) { console.error('[Supervisor] attendance error:', e); supAttendance = {}; supUpdateMetrics(); supRenderSearch(); supRenderTable(); });
  }

  // ---- Mutations ----
  function supRecord(workerId) { return supAttendance[String(workerId)] || { status: 'pending' }; }

  function supMarkPresent(workerId) {
    supAttendance[String(workerId)] = { status: 'present', hoursWorked: 9, overtimeHours: 0, remarks: '' };
    supDirty = true; supSaveLocalDraft();
    supUpdateMetrics(); supRenderSearch(); supRenderTable();
  }

  function supMarkAbsent(workerId) {
    supAttendance[String(workerId)] = { status: 'absent', hoursWorked: 0, overtimeHours: 0, remarks: '' };
    supDirty = true; supSaveLocalDraft();
    supUpdateMetrics(); supRenderSearch(); supRenderTable();
  }

  function supClear(workerId) { delete supAttendance[String(workerId)]; supDirty = true; supSaveLocalDraft(); supUpdateMetrics(); supRenderSearch(); supRenderTable(); }

  function supSelectedIds() { var ids = []; document.querySelectorAll('.sup-sel:checked').forEach(function (cb) { ids.push(cb.dataset.id); }); return ids; }

  // ---- Local persistence ----
  var supDraftTimer = null;
  function supSaveLocalDraft() {
    // Debounce: coalesce rapid marks/absents into one localStorage write per
    // 500 ms instead of paying JSON.stringify + disk on every click.
    clearTimeout(supDraftTimer);
    supDraftTimer = setTimeout(function () {
      try {
        localStorage.setItem('supDraft:' + supDate(), JSON.stringify(supAttendance));
        localStorage.setItem('supDraft:lastDate', supDate());
      } catch (e) {}
    }, 500);
  }
  function supLoadLocalDraft() { try { var lastDate = localStorage.getItem('supDraft:lastDate'); if (!lastDate) return; var raw = localStorage.getItem('supDraft:' + lastDate); if (!raw) return; var parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object' && Object.keys(supAttendance).length === 0) supAttendance = parsed; } catch (e) {} }


  // ---- Cloud submit ----
  function supSubmitAttendance() {
    if (!supSession) { supToast('Not signed in', 'error'); return; }
    var client = supInitClient();
    if (!client) { supToast('Supabase not configured', 'error'); return; }
    var today = supDate();
    var records = [];
    Object.keys(supAttendance).forEach(function (wid) {
      var r = supAttendance[wid];
      if (!r || r.status === 'pending') return;
      records.push({
        worker_id: wid,
        attendance_date: today,
        status: r.status,
        hours_worked: r.hoursWorked != null ? r.hoursWorked : 0,
        overtime_hours: r.overtimeHours != null ? r.overtimeHours : 0,
        remarks: r.remarks || ''
      });
    });
    if (!records.length) { supToast('Nothing to submit', 'error'); return; }
    supToast('Submitting ' + records.length + ' record(s)...', 'info');
    client.from('attendance').upsert(records, { onConflict: 'worker_id,attendance_date' })
      .then(function (r) {
        if (r.error) { supToast('Submit failed: ' + r.error.message, 'error'); return; }
        supDirty = false;
        supToast('Submitted ' + records.length + ' record(s)', 'success');
        supLoadAttendance();
      })['catch'](function (e) { supToast('Submit error: ' + (e && e.message || e), 'error'); });
  }


  // ---- Render: search results (top panel) ----
  // supWorkers is populated by supSearchWorkers() when the user searches.
  // supRenderSearch renders those results with live status pills.
  function supRenderSearch() {
    var container = document.getElementById('supSearchResults');
    if (!container) return;
    if (!supWorkers.length) {
      container.innerHTML = '<div class="sup-hint">Type at least 2 characters and press Enter to search for a worker.</div>';
      return;
    }
    container.innerHTML = '';
    supWorkers.forEach(function (w) {
      var r = supRecord(w.id);
      var already = r.status !== 'pending';
      var statusClass = r.status === 'present' ? 'present' : (r.status === 'absent' ? 'absent' : 'pending');
      var card = document.createElement('div');
      card.className = 'sup-worker-card';
      card.innerHTML =
        '<div class="sup-worker-info">' +
          '<div class="sup-worker-name">' + supEscape(w.name) + '</div>' +
          '<div class="sup-worker-meta">' +
            '<span>' + supEscape(w.employeeNo || '-') + '</span>' +
            '<span>' + supEscape(w.department || '-') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="sup-worker-actions">' +
          (already
            ? '<span class="sup-pill ' + statusClass + '">' + supEscape(r.status) + '</span><button class="btn btn-secondary" data-act="clear" data-id="' + w.id + '">Clear</button>'
            : '<button class="btn btn-primary" data-act="present" data-id="' + w.id + '">Present</button><button class="btn btn-secondary" data-act="absent" data-id="' + w.id + '">Absent</button>'
          ) +
        '</div>';
      container.appendChild(card);
    });
    container.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.id;
        if (b.dataset.act === 'present') supMarkPresent(id);
        else if (b.dataset.act === 'absent') supMarkAbsent(id);
        else if (b.dataset.act === 'clear') supClear(id);
      });
    });
  }
  function supRenderTable() {
    var tbody = document.getElementById('supMarkedTable');
    if (!tbody) return;
    var rows = [];
    Object.keys(supAttendance).forEach(function (wid) {
      var r = supAttendance[wid];
      if (!r || r.status === 'pending') return;
      var w = supWorkers.find(function (x) { return String(x.id) === String(wid); });
      if (!w) w = { id: wid, name: '(unknown worker)', employeeNo: '' };
      rows.push({ w: w, r: r });
    });
    rows.sort(function (a, b) { return String(a.w.name).localeCompare(String(b.w.name)); });
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="sup-empty">No attendance marked yet. Search a worker above and tap "Mark present".</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    rows.forEach(function (entry) {
      var w = entry.w, r = entry.r;
      var statusClass = r.status === 'present' ? 'pill-present' : 'pill-absent';
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td><input type="checkbox" class="sup-sel" data-id="' + w.id + '"></td>' +
        '<td>' + supEscape(w.name) + '</td>' +
        '<td>' + supEscape(w.employeeNo) + '</td>' +
        '<td><span class="sup-pill ' + statusClass + '">' + supEscape(r.status) + '</span></td>' +
        '<td>' + (r.hoursWorked != null ? r.hoursWorked : '-') + '</td>' +
        '<td>' + (r.overtimeHours != null ? r.overtimeHours : '-') + '</td>' +
        '<td><button class="secondary" data-act="edit" data-id="' + w.id + '">Edit</button> <button class="secondary" data-act="clear" data-id="' + w.id + '">Clear</button></td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.id;
        if (b.dataset.act === 'edit') supEditRow(id);
        else if (b.dataset.act === 'clear') supClear(id);
      });
    });
  }

  function supUpdateMetrics() {
    // Count by status from supAttendance (the source of truth for what was marked today)
    var present = 0, absent = 0;
    Object.keys(supAttendance).forEach(function (wid) {
      var r = supAttendance[wid];
      if (r.status === 'present') present++;
      else if (r.status === 'absent') absent++;
    });
    var expected = supAssignedCount != null ? supAssignedCount : 0;
    var pending = Math.max(0, expected - present - absent);
    var exp = document.getElementById('supExpected');
    var pr = document.getElementById('supPresent');
    var ab = document.getElementById('supAbsent');
    var pe = document.getElementById('supPending');
    if (exp) exp.textContent = expected;
    if (pr) pr.textContent = present;
    if (ab) ab.textContent = absent;
    if (pe) pe.textContent = pending;
  }

  function supEditRow(workerId) {
    var r = supRecord(workerId);
    var hours = prompt('Hours worked (default 9):', r.hoursWorked != null ? r.hoursWorked : 9);
    if (hours === null) return;
    var ot = prompt('Overtime hours (default 0):', r.overtimeHours != null ? r.overtimeHours : 0);
    if (ot === null) return;
    var remarks = prompt('Remarks:', r.remarks || '');
    if (remarks === null) return;
    supAttendance[String(workerId)] = {
      status: r.status === 'pending' ? 'present' : r.status,
      hoursWorked: parseFloat(hours) || 0,
      overtimeHours: parseFloat(ot) || 0,
      remarks: remarks
    };
    supDirty = true; supSaveLocalDraft();
    supUpdateMetrics(); supRenderSearch(); supRenderTable();
  }

  function supEscape(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function supToast(msg, type) {
    var el = document.getElementById('supToast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'sup-toast show ' + (type === 'error' ? 'error' : (type === 'success' ? 'success' : ''));
    setTimeout(function () { el.className = 'sup-toast'; }, 3500);
  }

  window.supervisorPortal = {
    getWorkers: function () { return supWorkers; },
    getAttendance: function () { return supAttendance; },
    submit: supSubmitAttendance,
    reload: supLoadWorkersAndAttendance
  };
})();

