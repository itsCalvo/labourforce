// ===== Supervisor Portal =====
(function () {
  'use strict';

  var supSession = null, supProfile = null, supWorkers = [], supAttendance = {};
  var supSelectedDate = null, supDirty = false;
  // Local cache: department_id → name. The workers table stores department_id (FK),
  // not a name, so we resolve the name client-side once after sign-in. Safe to keep
  // empty if the departments table is missing — we just display an empty department.
  var supDepartments = {}; // { [departmentId]: name }
  // Canonical attendance statuses matching the database CHECK constraint
  // (attendance_status_check: pending,present,absent,late,half_day,excused,off_day,pending_verification,worked,approved)
  var validStatuses = ['pending','present','absent','late','half_day','excused','off_day','pending_verification','worked','approved'];

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
    // Resolve department_id → name from the local cache (loaded once in supShowPortal).
    // If departments haven't loaded yet, fall back to empty string.
    var deptId = row.department_id != null ? String(row.department_id) : null;
    var deptName = (deptId && supDepartments[deptId]) ? supDepartments[deptId] : '';
    return {
      id: row.id,
      name: row.full_name || row.name || row.fullname || '(no name)',
      employeeNo: row.employee_no || row.staff_no || row.employeeNumber || '',
      idNumber: row.id_number || row.national_id || row.nationalId || '',
      department: deptName,
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
    // Normalise status to a value the live DB CHECK constraint allows.
    // The deployed constraint is unknown (may be just pending/present/absent or
    // a superset).  Map everything to a value we KNOW the DB accepts so we
    // never violate the constraint on re-submit.
    var rawStatus = row.status || 'present';
    var safeStatus = 'present'; // safe default
    if (rawStatus === 'present' || rawStatus === 'worked' || rawStatus === 'approved' ||
        rawStatus === 'pending_verification') {
      safeStatus = 'present';
    } else if (rawStatus === 'absent' || rawStatus === 'late' || rawStatus === 'half_day' ||
               rawStatus === 'excused' || rawStatus === 'off_day') {
      safeStatus = 'absent';
    } else if (rawStatus === 'pending') {
      safeStatus = 'pending';
    }
    return {
      id: row.id,
      workerId: row.worker_id || row.workerId,
      status: safeStatus,
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
    // Load departments (for resolving department_id → name in worker rows).
    // Failure is non-fatal: the worker list still renders, just with empty
    // department cells. This must NOT block attendance from loading.
    supLoadDepartments();
    supLoadWorkersAndAttendance();
  }

  // ---- Department cache (for displaying department names) ----
  function supLoadDepartments() {
    var client = supInitClient();
    if (!client) return;
    // Try a rich select first; if the schema is older and one of these columns
    // is missing, fall back to `*` so a missing column never blocks the search.
    var tryLoad = function (select) {
      return client.from('departments').select(select);
    };
    tryLoad('id,name').then(function (result) {
      if (result && result.error) throw result.error;
      var map = {};
      (result.data || []).forEach(function (d) { if (d && d.id != null) map[String(d.id)] = d.name || ''; });
      supDepartments = map;
    })['catch'](function (e1) {
      tryLoad('*').then(function (result2) {
        if (result2 && result2.error) { console.warn('[Supervisor] departments read failed:', result2.error.message); return; }
        var map2 = {};
        (result2.data || []).forEach(function (d) { if (d && d.id != null) map2[String(d.id)] = d.name || ''; });
        supDepartments = map2;
      })['catch'](function (e2) { console.warn('[Supervisor] departments read error:', e2 && e2.message || e2); });
    });
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
      doLogin.disabled = true; doLogin.classList.add('loading'); doLogin.setAttribute('aria-busy','true');
      /* 12s timeout so users aren't left waiting on a dead connection */
      var timeoutId = setTimeout(function(){ if(errEl) errEl.textContent = 'Connection timed out. Check your internet.'; doLogin.disabled = false; doLogin.classList.remove('loading'); doLogin.removeAttribute('aria-busy'); }, 12000);
      client.auth.signInWithPassword({ email: email, password: password })
        .then(function (r) {
          clearTimeout(timeoutId);
          if (r.error) { if (errEl) errEl.textContent = r.error.message; return; }
          supSession = r.data.session;
          supLoadProfile();
        })['catch'](function (e) { clearTimeout(timeoutId); if (errEl) errEl.textContent = String(e && e.message || e); })
        ['finally'](function(){ doLogin.disabled = false; doLogin.classList.remove('loading'); doLogin.removeAttribute('aria-busy'); });
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
      .select('id,employee_no,id_number,full_name,department_id,active')
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


  // ---- Cloud submit helpers ----
  // Map local statuses to values the live CHECK constraint allows.
  // We do NOT know the exact deployed constraint.  The safest assumption is that
  // only the three universal statuses are guaranteed: pending, present, absent.
  // Any richer status (late, half_day, worked, approved, pending_verification, etc.)
  // is normalised to 'present' (for "good" statuses) or 'absent' (for "bad" ones)
  // so we never violate attendance_status_check (Postgres 23514).
  var STATUS_MAP = {
    'present':'present','absent':'absent','pending':'pending',
    'worked':'present','approved':'present',
    'late':'absent','half_day':'absent','excused':'absent','off_day':'absent',
    'pending_verification':'present'
  };
  // Progressive column-set write: try widest set first, fall back on 42703
  // (missing column), return on any other error.  Supabase never throws —
  // errors are always in result.error.
  function tryWriteRows(client, rows, op) {
    var colSets = [
      ['worker_id','attendance_date','status','hours_worked','overtime_hours','notes'],
      ['worker_id','attendance_date','status','hours_worked','overtime_hours'],
      ['worker_id','attendance_date','status']
    ];
    var lastErr = null, i = 0;
    function next() {
      if (i >= colSets.length) return Promise.reject(lastErr || new Error('no col sets left'));
      var cols = colSets[i++];
      if (!rows.length) return Promise.resolve(true);
      var payload = rows.map(function (r) {
        var out = {};
        cols.forEach(function (c) { if (r[c] !== undefined) out[c] = r[c]; });
        return out;
      });
      var q = op === 'insert'
        ? client.from('attendance').insert(payload)
        : client.from('attendance').upsert(payload, { onConflict: 'id' });
      return q.then(function (res) {
        if (res && res.error) {
          if (res.error.code === '42703') { lastErr = res.error; return next(); }
          throw res.error;  // 23514 (check constraint), 23503 (FK), etc. → propagate
        }
        return true;
      });
    }
    return next();
  }
  // Read existing rows for a date with progressive column sets.  Returns {}
  // on any error so the caller falls back to INSERT-ALL (duplicates are
  // prevented by the unique index, or are benign overwrites).
  function readExistingForDate(client, today) {
    var colSets = ['id,worker_id', 'worker_id,attendance_date,status', 'worker_id,attendance_date'];
    var i = 0;
    function next() {
      if (i >= colSets.length) return Promise.resolve({});
      return client.from('attendance').select(colSets[i++]).eq('attendance_date', today)
        .then(function (res) {
          if (res && res.error) {
            if (res.error.code === '42703') return next();
            return {};  // table missing / RLS → fall through to INSERT-ALL
          }
          var byWorker = {};
          (res.data || []).forEach(function (row) { if (row.worker_id != null) byWorker[String(row.worker_id)] = row.id; });
          return byWorker;
        });
    }
    return next();
  }

  // ---- Cloud submit ----
  // ---- Cloud submit ----
  async function supSubmitAttendance() {
    if (!supSession) { supToast('Not signed in', 'error'); return; }
    var client = supInitClient();
    if (!client) { supToast('Supabase not configured', 'error'); return; }
    var today = supDate();
    var records = [];
    Object.keys(supAttendance).forEach(function (wid) {
      var r = supAttendance[wid];
      if (!r || r.status === 'pending' || r.status == null || !validStatuses.includes(r.status)) return;
      // Normalise status via STATUS_MAP; unknown values fall back to 'present'
      // so we never violate the live attendance_status_check (Postgres 23514).
      var safeStatus = STATUS_MAP[r.status] != null ? STATUS_MAP[r.status] : 'present';
      records.push({
        worker_id: wid,
        attendance_date: today,
        status: safeStatus,
        hours_worked: r.hoursWorked != null ? r.hoursWorked : 0,
        overtime_hours: r.overtimeHours != null ? r.overtimeHours : 0,
        notes: r.remarks || ''
      });
    });
    if (!records.length) { supToast('Nothing to submit', 'error'); return; }
    supToast('Submitting ' + records.length + ' record(s)...', 'info');
    // Live DB: no unique(worker_id, attendance_date) index → manual select-then-insert.
    // Live DB: column-set may be partial → helpers retry on 42703.
    try {
      var existingByWorker = await readExistingForDate(client, today);
      var toInsert = [], toUpdate = [];
      records.forEach(function (rec) {
        var existingId = existingByWorker[String(rec.worker_id)];
        if (existingId) toUpdate.push(Object.assign({ id: existingId }, rec));
        else toInsert.push(rec);
      });
      await tryWriteRows(client, toUpdate, 'upsert-id');
      await tryWriteRows(client, toInsert, 'insert');
      supDirty = false;
      supToast('Submitted ' + records.length + ' record(s)', 'success');
      supLoadAttendance();
    } catch (e) {
      var msg = e && (e.message || (e.error && e.error.message)) || (typeof e === 'string' ? e : 'unknown');
      supToast('Submit failed: ' + msg, 'error');
      console.error('[Supervisor] submit attendance error:', e);
    }
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
      status: r.status === 'pending' ? 'present' : (validStatuses.includes(r.status) ? r.status : 'present'),
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

