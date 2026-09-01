// ===== Supervisor Portal =====
(function () {
  'use strict';

  var supSession = null, supProfile = null, supWorkers = [];
  var supSelectedDate = null, supDirty = false;

  // BATCH MODEL: a batch corresponds to a worker designation
  // (e.g. Operator, Loader, Driver, Supervisor). Each worker can only appear
  // in ONE batch per day — their own designation. Batches are auto-derived
  // from the workers table on load, so the supervisor just sees the designations
  // present in today's deployed workforce.
  // supBatches = { [designation]: { workers: {[workerId]: rec}, submittedAt, submitted } }
  var supBatches = {};
  var activeBatch = '';
  // Worker map for fast lookup: workerId → worker object (includes designation)
  var supWorkerMap = {};

  var supDepartments = {}; // { [departmentId]: name }
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
      designation: (row.designation && String(row.designation).trim()) || 'Undesignated',
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

  // Rebuild the workerId → worker map from the current supWorkers array
  function supBuildWorkerMap() {
    supWorkerMap = {};
    supWorkers.forEach(function (w) {
      supWorkerMap[String(w.id)] = w;
    });
  }

  // Recompute supBatches from the workers table: one batch per unique designation.
  // Each worker is placed in their own designation's batch (mark is empty until
  // the supervisor marks them). This is the source of truth for which batches
  // exist — local-only custom batch names are dropped.
  function supBuildBatchesFromDesignations() {
    supBuildWorkerMap();
    var seen = {};
    supWorkers.forEach(function (w) {
      var d = w.designation || 'Undesignated';
      if (seen[d]) return;
      seen[d] = true;
      // Preserve any existing marks (e.g. submitted today) for this batch
      var existing = supBatches[d];
      supBatches[d] = existing || { workers: {}, submittedAt: null, submitted: false };
    });
    // Drop any batches whose designation no longer matches any worker
    Object.keys(supBatches).forEach(function (name) {
      if (!seen[name]) delete supBatches[name];
    });
    // Pick a sensible active batch
    if (!activeBatch || !supBatches[activeBatch]) {
      var keys = Object.keys(supBatches);
      activeBatch = keys[0] || '';
    }
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
          supWorkers = []; supRenderTabs(); supRenderSearch();
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
        activeAttendance()[id] = { status: 'absent', hoursWorked: 0, overtimeHours: 0, remarks: '' };
      });
      supDirty = true; supSaveLocalDraft();
      supUpdateMetrics(); supRenderTabs(); supRenderTable(); supRenderSearch();
    });

    var cancelBtn = document.getElementById('supCancelSelected');
    if (cancelBtn) cancelBtn.addEventListener('click', function () {
      var ids = supSelectedIds();
      if (!ids.length) { supToast('Select workers first.', 'error'); return; }
      ids.forEach(function (id) { delete activeAttendance()[id]; });
      supDirty = true; supSaveLocalDraft();
      supUpdateMetrics(); supRenderTabs(); supRenderTable(); supRenderSearch();
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
    // Render the batch tabs bar once on page load
    supRenderTabs();
  });

  // ---- Worker loading (on portal entry) ----
  // supWorkers holds the *current search result set* (small).
  // supAssignedCount holds the total number of workers assigned to this supervisor
  // (used for the "Expected" stat; we only need a count, not the full list).
  var supAssignedCount = null;
  function supLoadWorkersAndAttendance() {
    supWorkers = [];
    supLoadAssignedCount();
    supLoadDesignations();
    supLoadAttendance();
  }

  // Lightweight count for the "Expected" stat tile.
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

  // Load ALL active workers' id+designation so we can build the batch list.
  // This is small (just two columns) and lets the supervisor see the
  // designations present in their workforce before they search anyone.
  function supLoadDesignations() {
    var client = supInitClient();
    if (!client) return;
    client.from('workers').select('id,designation')
      .then(function (result) {
        if (result.error) { console.warn('[Supervisor] designations read failed:', result.error.message); return; }
        var rows = (result.data || []).map(function (r) {
          return { id: r.id, designation: (r.designation && String(r.designation).trim()) || 'Undesignated' };
        });
        // Build the batch list from these lightweight rows
        var seen = {};
        rows.forEach(function (r) {
          if (seen[r.designation]) return;
          seen[r.designation] = true;
          var existing = supBatches[r.designation];
          supBatches[r.designation] = existing || { workers: {}, submittedAt: null, submitted: false };
        });
        // Add to the worker map (with just id+designation; full worker data
        // is added when the supervisor searches)
        rows.forEach(function (r) { supWorkerMap[String(r.id)] = supWorkerMap[String(r.id)] || { id: r.id, designation: r.designation }; });
        // Drop any batch whose designation is no longer present
        Object.keys(supBatches).forEach(function (name) {
          if (!seen[name] && name !== 'Undesignated') delete supBatches[name];
        });
        if (!activeBatch || !supBatches[activeBatch]) {
          var keys = Object.keys(supBatches);
          activeBatch = keys[0] || '';
        }
        supRenderTabs(); supUpdateMetrics();
      })['catch'](function (e) { console.warn('[Supervisor] designations error:', e); });
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
      // Re-merge designation info from cache into worker map
      supWorkers.forEach(function (w) { supWorkerMap[String(w.id)] = w; });
      supRenderSearch();
      return;
    }
    container.innerHTML = '<div class="sup-hint"><span class="sup-spinner"></span> Searching...</div>';
    var ilike = '%' + q + '%';
    // RLS on the `workers` table returns only rows the current profile may see.
    // Only request the columns we actually use to minimise payload.
    client.from('workers')
      .select('id,employee_no,id_number,full_name,department_id,designation,active')
      .or('full_name.ilike.' + ilike + ',employee_no.ilike.' + ilike + ',id_number.ilike.' + ilike)
      .limit(20)
      .then(function (result) {
        if (myToken !== supSearchToken) return; // stale
        if (result.error) { console.warn('[Supervisor] workers search failed:', result.error.message); container.innerHTML = '<div class="sup-empty">Search failed: ' + supEscape(result.error.message) + '</div>'; return; }
        var rows = (result.data || []).map(mapWorkerRow);
        supSearchCache[cacheKey] = { rows: rows, ts: Date.now() };
        supWorkers = rows;
        // Merge search results into the worker map so we know each worker's
        // designation for batch routing.
        rows.forEach(function (w) { supWorkerMap[String(w.id)] = w; });
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
    // Progressive column sets so this works on old DBs without batch_name column
    var colSets = [
      'worker_id,attendance_date,status,hours_worked,overtime_hours,notes,batch_name',
      'worker_id,attendance_date,status,hours_worked,overtime_hours,notes',
      'worker_id,attendance_date,status,hours_worked,overtime_hours',
      'worker_id,attendance_date,status'
    ];
    var idx = 0;
    function tryNext() {
      if (idx >= colSets.length) {
        // No attendance rows found; build batches from current designations
        supBuildBatchesFromDesignations();
        supMergeLocalDraft();
        supRenderTabs(); supRenderSearch(); supRenderTable(); supUpdateMetrics();
        return;
      }
      client.from('attendance').select(colSets[idx++]).eq('attendance_date', today)
        .then(function (result) {
          if (result.error) {
            if (result.error.code === '42703') return tryNext();
            console.warn('[Supervisor] attendance read failed:', result.error.message);
            return;
          }
          // Build batches from designations, then overlay cloud rows.
          // Route each row to the worker's actual designation; fall back to
          // batch_name column if the worker isn't in supWorkerMap.
          supBatches = {};
          (result.data || []).forEach(function (row) {
            var m = mapAttendanceRow(row);
            if (m.workerId == null) return;
            var wid = String(m.workerId);
            var worker = supWorkerMap[wid];
            var batchName = (worker && worker.designation) ? worker.designation : (row.batch_name || 'Undesignated');
            var b = ensureBatch(batchName);
            b.workers[wid] = m;
            b.submitted = true;
          });
          // Rebuild from designations so the batch list reflects the workforce,
          // then re-apply submitted cloud rows.
          var cloudRows = result.data || [];
          supBuildBatchesFromDesignations();
          cloudRows.forEach(function (row) {
            var m = mapAttendanceRow(row);
            if (m.workerId == null) return;
            var wid = String(m.workerId);
            var worker = supWorkerMap[wid];
            var batchName = (worker && worker.designation) ? worker.designation : (row.batch_name || 'Undesignated');
            var b = supBatches[batchName];
            if (b) { b.workers[wid] = m; b.submitted = true; }
          });
          supMergeLocalDraft();
          supRenderTabs(); supRenderSearch(); supRenderTable(); supUpdateMetrics();
        })['catch'](function (e) {
          console.error('[Supervisor] attendance error:', e);
          supBuildBatchesFromDesignations();
          supMergeLocalDraft();
          supRenderTabs(); supRenderSearch(); supRenderTable(); supUpdateMetrics();
        });
    }
    tryNext();
  }

  // Keep local unsubmitted marks on top of cloud data.
  // Only accept local batches that match actual designations.
  function supMergeLocalDraft() {
    try {
      var lastDate = localStorage.getItem('supDraft:lastDate');
      if (!lastDate || lastDate !== supDate()) return;
      var raw = localStorage.getItem('supDraft:' + lastDate);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.batches) return;
      Object.keys(parsed.batches).forEach(function (batchName) {
        if (!supBatches[batchName]) return; // skip invalid / old custom batches
        var lb = parsed.batches[batchName];
        if (lb.submitted) return;
        Object.keys(lb.workers).forEach(function (wid) {
          var cb = supBatches[batchName].workers;
          if (!cb[wid] || cb[wid].status === 'pending') cb[wid] = lb.workers[wid];
        });
      });
    } catch (e) {}
    if (!activeBatch || !supBatches[activeBatch]) {
      var keys = Object.keys(supBatches);
      activeBatch = keys[0] || '';
    }
  }

  // ---- Batch state helpers ----
  // Each worker can only be in one batch — their own designation.
  function ensureBatch(name) {
    if (!name) return null;
    if (!supBatches[name]) supBatches[name] = { workers: {}, submittedAt: null, submitted: false };
    return supBatches[name];
  }

  // Get the batch this worker belongs to (based on their designation).
  function batchForWorker(workerId) {
    var w = supWorkerMap[String(workerId)];
    return ensureBatch(w && w.designation ? w.designation : 'Undesignated');
  }

  function activeAttendance() {
    if (!activeBatch || !supBatches[activeBatch]) return {};
    return supBatches[activeBatch].workers;
  }

  // Find this worker's mark across ALL batches (worker is only in one).
  // Used by search results to show the current mark regardless of active tab.
  function supRecord(workerId) {
    var wid = String(workerId);
    var keys = Object.keys(supBatches);
    for (var i = 0; i < keys.length; i++) {
      var w = supBatches[keys[i]].workers[wid];
      if (w && w.status !== 'pending') return w;
    }
    return { status: 'pending' };
  }

  // Which batch does this worker currently sit in? (or null)
  function batchNameForWorker(workerId) {
    var wid = String(workerId);
    var keys = Object.keys(supBatches);
    for (var i = 0; i < keys.length; i++) {
      if (supBatches[keys[i]].workers[wid]) return keys[i];
    }
    return null;
  }

  function supMarkPresent(workerId) {
    var wid = String(workerId);
    var w = supWorkerMap[wid];
    var targetBatch = batchForWorker(wid);
    if (!targetBatch) { supToast('Worker has no designation — cannot assign to a batch.', 'error'); return; }
    var targetName = (w && w.designation) ? w.designation : 'Undesignated';
    var existingBatch = batchNameForWorker(wid);
    if (existingBatch && existingBatch !== targetName) {
      var existing = supBatches[existingBatch] && supBatches[existingBatch].workers[wid];
      if (existing && existing.status !== 'pending') {
        supToast(w.name + ' is already marked as ' + existing.status + ' in "' + existingBatch + '". Remove that first.', 'error');
        return;
      }
    }
    targetBatch.workers[wid] = { status: 'present', hoursWorked: 9, overtimeHours: 0, remarks: '' };
    supDirty = true; supSaveLocalDraft();
    supUpdateMetrics(); supRenderTabs(); supRenderSearch(); supRenderTable();
  }

  function supMarkAbsent(workerId) {
    var wid = String(workerId);
    var w = supWorkerMap[wid];
    var targetBatch = batchForWorker(wid);
    if (!targetBatch) { supToast('Worker has no designation — cannot assign to a batch.', 'error'); return; }
    var targetName = (w && w.designation) ? w.designation : 'Undesignated';
    var existingBatch = batchNameForWorker(wid);
    if (existingBatch && existingBatch !== targetName) {
      var existing = supBatches[existingBatch] && supBatches[existingBatch].workers[wid];
      if (existing && existing.status !== 'pending') {
        supToast(w.name + ' is already marked in "' + existingBatch + '". Remove that first.', 'error');
        return;
      }
    }
    targetBatch.workers[wid] = { status: 'absent', hoursWorked: 0, overtimeHours: 0, remarks: '' };
    supDirty = true; supSaveLocalDraft();
    supUpdateMetrics(); supRenderTabs(); supRenderSearch(); supRenderTable();
  }

  function supClear(workerId) {
    var wid = String(workerId);
    var batchName = batchNameForWorker(wid);
    if (batchName && supBatches[batchName]) {
      delete supBatches[batchName].workers[wid];
    }
    supDirty = true; supSaveLocalDraft();
    supUpdateMetrics(); supRenderTabs(); supRenderSearch(); supRenderTable();
  }

  function supSelectedIds() { var ids = []; document.querySelectorAll('.sup-sel:checked').forEach(function (cb) { ids.push(cb.dataset.id); }); return ids; }

  // ---- Local persistence (all batches) ----
  var supDraftTimer = null;
  function supSaveLocalDraft() {
    clearTimeout(supDraftTimer);
    supDraftTimer = setTimeout(function () {
      try {
        var payload = { active: activeBatch, batches: supBatches };
        localStorage.setItem('supDraft:' + supDate(), JSON.stringify(payload));
        localStorage.setItem('supDraft:lastDate', supDate());
      } catch (e) {}
    }, 500);
  }

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
    // First col-set includes batch_name. If the column doesn't exist (old DB
    // schema) we fall back to the original 2-col natural key.
    var colSets = [
      ['worker_id','attendance_date','status','hours_worked','overtime_hours','notes','batch_name','supervisor_id','submitted_by'],
      ['worker_id','attendance_date','status','hours_worked','overtime_hours','notes','batch_name'],
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
      // Use batch_name-aware conflict when this col-set includes it,
      // otherwise fall back to the original 2-col conflict.
      var hasBatch = cols.indexOf('batch_name') >= 0;
      var conflict = hasBatch ? 'worker_id,attendance_date,batch_name' : 'worker_id,attendance_date';
      var q = client.from('attendance').upsert(payload, { onConflict: conflict }).select('id,worker_id');
      return q.then(function (res) {
        if (res && res.error) {
          // If batch_name is the problem (42703 undefined_column), fall through
          // to the next col-set which omits it.
          if (res.error.code === '42703') {
            lastErr = res.error;
            return next();
          }
          throw res.error;
        }
        return res.data || [];
      });
    }
    return next();
  }
  // ---- Render: batch tabs ----
  // Each tab is a worker designation. Click to switch active batch.
  // No delete or add buttons — batches are derived from the workers table.
  function supRenderTabs() {
    var wrap = document.getElementById('supBatchTabs');
    if (!wrap) return;
    var names = Object.keys(supBatches).sort();
    var html = '';
    names.forEach(function (name) {
      var b = supBatches[name];
      var presentCount = 0, otTotal = 0;
      Object.keys(b.workers).forEach(function (wid) {
        var r = b.workers[wid];
        if (r && r.status === 'present') presentCount++;
        if (r && r.overtimeHours) otTotal += Number(r.overtimeHours) || 0;
      });
      var submittedClass = b.submitted ? ' submitted' : '';
      var activeClass = (name === activeBatch) ? ' active' : '';
      var check = b.submitted ? ' <span class="batch-tab-check">&#10003;</span>' : '';
      html += '<div class="batch-tab' + activeClass + submittedClass + '" data-batch="' + supEscape(name) + '">' +
        '<span class="batch-tab-name">' + supEscape(name) + check + '</span>' +
        '<span class="batch-tab-meta">' + presentCount + ' present &middot; ' + otTotal.toFixed(1) + 'h OT</span></div>';
    });
    wrap.innerHTML = html;
    wrap.querySelectorAll('.batch-tab').forEach(function (t) {
      t.addEventListener('click', function () {
        activeBatch = t.dataset.batch;
        supRenderTabs(); supRenderSearch(); supRenderTable(); supUpdateMetrics();
        supSaveLocalDraft();
      });
    });
  }

  // ---- Cloud submit per batch ----
  // Each batch (designation) is submitted independently. After writing attendance
  // rows to the cloud, each row is sent through the approval workflow pipeline
  // (Supervisor Review → Accountant → Final Approval).
  async function supSubmitBatch(batchName) {
    if (!supSession) { supToast("Not signed in", "error"); return; }
    var client = supInitClient();
    if (!client) { supToast("Supabase not configured", "error"); return; }
    var today = supDate();
    var batch = ensureBatch(batchName);
    if (!batch) { supToast('Batch "' + batchName + '" not found', 'error'); return; }
    var records = [];
    Object.keys(batch.workers).forEach(function (wid) {
      var r = batch.workers[wid];
      if (!r || r.status === "pending" || r.status == null || !validStatuses.includes(r.status)) return;
      var safeStatus = STATUS_MAP[r.status] != null ? STATUS_MAP[r.status] : "present";
      records.push({
        worker_id: wid,
        attendance_date: today,
        status: safeStatus,
        hours_worked: r.hoursWorked != null ? r.hoursWorked : 0,
        overtime_hours: r.overtimeHours != null ? r.overtimeHours : 0,
        notes: r.remarks || "",
        batch_name: batchName,
        supervisor_id: supSession.user.id,
        submitted_by: supSession.user.id
      });
    });
    if (!records.length) { supToast('Nothing to submit in "' + batchName + '"', "error"); return; }
    supToast('Submitting ' + records.length + ' record(s) in "' + batchName + '"...', "info");
    try {
      var upsertedRows = await tryWriteRows(client, records);
      // Send each row through the approval pipeline
      if (Array.isArray(upsertedRows) && upsertedRows.length) {
        var submitterId = supSession.user.id;
        var submitterName = (supProfile && supProfile.full_name) || (supSession.user.email) || "Supervisor";
        await Promise.all(upsertedRows.map(function(row) {
          return client.rpc("submit_for_approval", {
            p_attendance_id: row.id,
            p_submitter_id: submitterId,
            p_submitter_name: submitterName
          }).then(function(r) {
            if (r && r.error) console.warn("[Supervisor] submit_for_approval failed for row", row.id, ":", r.error);
          }).catch(function(e) {
            console.warn("[Supervisor] submit_for_approval RPC not available yet:", e.message);
          });
        }));
      }
      batch.submitted = true;
      batch.submittedAt = new Date().toISOString();
      supDirty = false;
      supSaveLocalDraft();
      supToast('Submitted ' + records.length + ' record(s) in "' + batchName + '" → awaiting approval', "success");
      supRenderTabs();
    } catch (e) {
      var msg = e && (e.message || (e.error && e.error.message)) || (typeof e === "string" ? e : "unknown");
      supToast("Submit failed: " + msg, "error");
      console.error("[Supervisor] submit attendance error:", e);
    }
  }
  // Back-compat: submit the active batch when the toolbar button is clicked.
  async function supSubmitAttendance() { return supSubmitBatch(activeBatch); }
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
      var design = w.designation || 'Undesignated';
      var card = document.createElement('div');
      card.className = 'sup-worker-card';
      card.innerHTML =
        '<div class="sup-worker-info">' +
          '<div class="sup-worker-name">' + supEscape(w.name) +
            ' <span class="sup-pill pending" title="Designation / batch">' + supEscape(design) + '</span>' +
          '</div>' +
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
    var att = activeAttendance();
    var rows = [];
    Object.keys(att).forEach(function (wid) {
      var r = att[wid];
      if (!r || r.status === 'pending') return;
      var w = supWorkerMap[wid] || { id: wid, name: '(unknown worker)', employeeNo: '' };
      rows.push({ w: w, r: r });
    });
    rows.sort(function (a, b) { return String(a.w.name).localeCompare(String(b.w.name)); });
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="sup-empty">No attendance marked in this batch. Search a worker above and tap "Mark present".</td></tr>';
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
    var present = 0, absent = 0, otTotal = 0;
    var att = activeAttendance();
    Object.keys(att).forEach(function (wid) {
      var r = att[wid];
      if (!r) return;
      if (r.status === 'present') present++;
      else if (r.status === 'absent') absent++;
      if (r.overtimeHours) otTotal += Number(r.overtimeHours) || 0;
    });
    // Update the batch label chips
    var batchLabel = document.getElementById('supBatchLabel');
    var batchLabel2 = document.getElementById('supBatchLabel2');
    if (batchLabel) batchLabel.textContent = activeBatch || '—';
    if (batchLabel2) batchLabel2.textContent = activeBatch || '—';
    // Update stat tiles
    var exp = document.getElementById('supExpected');
    var pr = document.getElementById('supPresent');
    var ab = document.getElementById('supAbsent');
    var pe = document.getElementById('supPending');
    if (exp) exp.textContent = (supAssignedCount != null ? supAssignedCount : 0);
    if (pr) pr.textContent = present;
    if (ab) ab.textContent = absent;
    if (pe) {
      pe.textContent = otTotal.toFixed(1) + 'h';
      var peSub = pe.parentElement.querySelector('.sup-stat-sub');
      if (peSub) peSub.textContent = 'OT in ' + (activeBatch || 'all');
    }
  }

  function supEditRow(workerId) {
    var wid = String(workerId);
    var batchName = batchNameForWorker(wid);
    if (!batchName) { supToast('Worker is not marked in any batch.', 'error'); return; }
    var att = supBatches[batchName].workers;
    var r = att[wid] || { status: 'pending' };
    var hours = prompt('Hours worked (default 9):', r.hoursWorked != null ? r.hoursWorked : 9);
    if (hours === null) return;
    var ot = prompt('Overtime hours (default 0):', r.overtimeHours != null ? r.overtimeHours : 0);
    if (ot === null) return;
    var remarks = prompt('Remarks:', r.remarks || '');
    if (remarks === null) return;
    att[wid] = {
      status: r.status === 'pending' ? 'present' : (validStatuses.includes(r.status) ? r.status : 'present'),
      hoursWorked: parseFloat(hours) || 0,
      overtimeHours: parseFloat(ot) || 0,
      remarks: remarks
    };
    supDirty = true; supSaveLocalDraft();
    supUpdateMetrics(); supRenderTabs(); supRenderSearch(); supRenderTable();
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
    getAttendance: function () { return activeAttendance(); },
    getBatches: function () { return supBatches; },
    getActiveBatch: function () { return activeBatch; },
    setActiveBatch: function (n) { if (supBatches[n]) { activeBatch = n; supRenderTabs(); supRenderSearch(); supRenderTable(); supUpdateMetrics(); } },
    submit: supSubmitAttendance,
    submitBatch: supSubmitBatch,
    reload: function () { if (typeof supLoadWorkersAndAttendance === 'function') supLoadWorkersAndAttendance(); }
  };
})();

