/* LabourForce worker verification portal. */
(function () {
  'use strict';

  var client = null;
  var worker = null;
  var sessionToken = '';
  var currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  var records = [];
  var loginTimer = null;
  var loginStartedAt = 0;

  function el(id) { return document.getElementById(id); }
  function setVisible(id, visible) {
    var node = el(id);
    if (!node) return;
    node.classList.toggle('show', visible);
    if (id === 'vfLogin') node.style.display = visible ? '' : 'none';
  }
  function text(id, value) { var node = el(id); if (node) node.textContent = value == null ? '' : String(value); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function apiUrl(name) { return LABOUR_FORCE_SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/' + name; }

  function showLoginError(message) {
    var box = el('vfLoginError');
    if (!box) return;
    box.textContent = message;
    box.classList.toggle('show', !!message);
  }

  function setLoginBusy(busy, label) {
    var button = el('vfLoginBtn');
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle('loading', busy);
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    var labelNode = button.querySelector('.vf-btn-text');
    if (labelNode) labelNode.textContent = label || (busy ? 'Checking details...' : 'Sign in');
  }

  function setMainState(state) {
    setVisible('vfLogin', state === 'login');
    setVisible('vfLoading', state === 'loading');
    setVisible('vfStateError', state === 'error');
    setVisible('vfAttendance', state === 'attendance');
    var signOut = el('vfSignOut');
    if (signOut) signOut.style.display = state === 'attendance' ? 'inline-flex' : 'none';
  }

  function invoke(name, body, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, timeoutMs || 12000);
    return fetch(apiUrl(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: LABOUR_FORCE_SUPABASE_ANON_KEY, Authorization: 'Bearer ' + LABOUR_FORCE_SUPABASE_ANON_KEY },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) { var error = new Error(data.error || 'Request failed (' + response.status + ')'); error.status = response.status; throw error; }
        return data;
      });
    }).catch(function (error) {
      if (error && error.name === 'AbortError') throw new Error('The request timed out. Please check your connection and try again.');
      throw error;
    }).finally(function () { clearTimeout(timeout); });
  }

  function showSuccessTransition() {
    var banner = el('vfWelcomeBanner');
    if (banner) { banner.classList.remove('show'); void banner.offsetWidth; banner.classList.add('show'); }
  }

  function monthRange() {
    var year = currentMonth.getFullYear();
    var month = currentMonth.getMonth();
    return { start: year + '-' + String(month + 1).padStart(2, '0') + '-01', end: new Date(year, month + 1, 0).toISOString().slice(0, 10) };
  }

  function loadAttendance() {
    setMainState('loading');
    text('vfLoadingText', 'Loading your attendance...');
    var range = monthRange();
    return invoke('worker-attendance', { worker_id: worker.worker_id, session_token: sessionToken, range_start: range.start, range_end: range.end }, 12000)
      .then(function (data) { records = Array.isArray(data.records) ? data.records : []; renderAttendance(); setMainState('attendance'); showSuccessTransition(); })
      .catch(function (error) { showStateError('Unable to load attendance', error.message || 'Please try again.'); });
  }

  function renderAttendance() {
    var monthName = currentMonth.toLocaleString('en', { month: 'long', year: 'numeric' });
    text('vfMonthLabel', monthName);
    text('vfDaysHeroMonth', monthName);
    text('vfWelcomeName', worker.full_name || 'Worker');
    text('vfWorkerName', worker.full_name || 'Worker');
    text('vfWorkerIdDisplay', worker.employee_no || '');
    text('vfAvatar', (worker.full_name || '?').charAt(0).toUpperCase());
    var worked = records.filter(function (r) { return r.status === 'present' || r.status === 'approved' || r.status === 'worked'; }).length;
    var absent = records.filter(function (r) { return r.status === 'absent'; }).length;
    var days = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
    text('vfDaysHeroNum', worked);
    text('vfWelcomeBadge', worked + ' worked day' + (worked === 1 ? '' : 's'));
    text('vfWorkedCount', worked); text('vfAbsentCount', absent); text('vfPendingCount', Math.max(0, days - worked - absent));
    ['vfWelcomeBanner', 'vfDaysHero', 'vfWorkerBar', 'vfMonthNav', 'vfSplitSummary'].forEach(function (id) {
      var node = el(id); if (node) node.classList.add('show');
    });
    renderCalendar();
  }

  function renderCalendar() {
    var grid = el('vfCalGrid');
    if (!grid) return;
    var year = currentMonth.getFullYear();
    var month = currentMonth.getMonth();
    var firstDay = new Date(year, month, 1).getDay();
    var days = new Date(year, month + 1, 0).getDate();
    var map = {};
    records.forEach(function (r) { map[r.attendance_date] = r.status; });
    var html = '';
    for (var i = 0; i < firstDay; i++) html += '<div class="vf-cal-empty"></div>';
    for (var day = 1; day <= days; day++) {
      var date = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      var status = map[date] || 'pending';
      var worked = status === 'present' || status === 'approved' || status === 'worked';
      var kind = worked ? 'worked' : status === 'absent' ? 'absent' : 'pending';
      html += '<div class="vf-cal-day vf-' + kind + '"><span class="vf-cal-num">' + day + '</span><span class="vf-cal-mark">' + (worked ? '&#10003;' : status === 'absent' ? '&mdash;' : '&middot;') + '</span></div>';
    }
    grid.innerHTML = html;
  }

  function showStateError(title, message) {
    setMainState('error');
    text('vfStateErrorTitle', title);
    text('vfStateErrorMsg', message);
    var detail = el('vfErrDetail');
    if (detail) detail.textContent = message;
  }

  window.vfDoLogin = function () {
    if (loginTimer) return;
    var identifier = (el('vfWorkerId') || {}).value.trim();
    var pin = (el('vfPin') || {}).value || '';
    showLoginError('');
    if (!identifier || !pin) { showLoginError('Enter your National ID and password.'); return; }
    setLoginBusy(true, 'Signing in...');
    loginStartedAt = Date.now();
    loginTimer = setTimeout(function () { loginTimer = null; }, 1000);
    invoke('worker-verify-pin', { employee_no: identifier, pin: pin }, 12000)
      .then(function (data) {
        if (!data.ok || !data.session_token) throw new Error('Login was not completed. Please try again.');
        worker = data; sessionToken = data.session_token;
        sessionStorage.setItem('labourforce_worker_session', JSON.stringify({ worker: worker, token: sessionToken }));
        showLoginError('');
        return loadAttendance();
      })
      .catch(function (error) {
        setMainState('login');
        showLoginError(error.message || 'Login failed. Check your details.');
      })
      .finally(function () {
        clearTimeout(loginTimer); loginTimer = null;
        setLoginBusy(false, 'Sign in');
      });
  };

  window.vfRetry = function () { if (worker && sessionToken) loadAttendance(); else setMainState('login'); };
  window.vfSignOut = function () { worker = null; sessionToken = ''; sessionStorage.removeItem('labourforce_worker_session'); setMainState('login'); showLoginError(''); };
  window.vfChangeMonth = function (offset) { currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + offset, 1); loadAttendance(); };
  window.vfToggleErrDetail = function () { var node = el('vfErrDetail'); if (node) node.classList.toggle('show'); };
  window.vfSwitchDayTab = function () {};
  window.vfOpenChangePin = function () { var modal = el('vfPinModal'); if (modal) modal.classList.add('show'); };
  window.vfCloseChangePin = function () { var modal = el('vfPinModal'); if (modal) modal.classList.remove('show'); };
  window.vfSavePin = function () { var msg = el('vfPinModalMsg'); if (msg) { msg.className = 'vf-modal-msg error'; msg.textContent = 'Password changes are temporarily unavailable. Please contact an administrator.'; } };

  document.addEventListener('DOMContentLoaded', function () {
    client = typeof supabase !== 'undefined' ? supabase.createClient(LABOUR_FORCE_SUPABASE_URL, LABOUR_FORCE_SUPABASE_ANON_KEY) : null;
    var form = el('vfPin');
    if (form) form.addEventListener('keydown', function (event) { if (event.key === 'Enter') window.vfDoLogin(); });
    var saved = sessionStorage.getItem('labourforce_worker_session');
    if (saved) {
      try { var parsed = JSON.parse(saved); worker = parsed.worker; sessionToken = parsed.token; if (worker && sessionToken) loadAttendance(); } catch (e) { sessionStorage.removeItem('labourforce_worker_session'); }
    }
    if (!worker) setMainState('login');
  });
})();
