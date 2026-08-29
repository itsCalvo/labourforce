// =============================================================
//  LABOUR FORCE — DEPLOYMENT COMPARISON
//  Decision Point 3: Flag mismatches between worker fields and
//  the deployments table so you can resolve manually before
//  deployments becomes the single source of truth.
//
//  HOW TO RUN:
//  1. Open LabourForce in a browser and sign in as super_admin.
//  2. Paste this entire file into the browser console.
//  3. Copy the printed report for manual resolution.
//  4. Run window.lfRunDeploymentComparison() for a re-run.
// =============================================================
(function() {
  var LF_DONE_KEY = 'lf_deployment_comparison_done';

  function done() {
    try { localStorage.setItem(LF_DONE_KEY, 'true'); } catch(e) {}
    console.log('[Labour Force] Deployment comparison complete. See report above.');
    console.log('[Labour Force] To reset the "done" flag, run: localStorage.removeItem("' + LF_DONE_KEY + '")');
  }

  function ls(k, fb) {
    try { var v = JSON.parse(localStorage.getItem(k)); return Array.isArray(v) && v.length ? v : fb; }
    catch (e) { return fb; }
  }

  var R = [];
  R.push('\n================================================================================');
  R.push(' DEPLOYMENT MISMATCH REPORT');
  R.push(' Only in cloud: workers with client_name vs deployments table');
  R.push(' Only in local: workers.client/assignment/deploymentStart vs local deployments');
  R.push('================================================================================\n');

  var localWorkers = ls('labourforce_workers', []);
  var localDeployments = ls('labourforce_deployments', []);

  // Build local maps
  var ldByWid = {};
  localDeployments.forEach(function(d) { if (d.workerId != null) ldByWid[String(d.workerId)] = d; });

  // Local: workers.client/assignment/deploymentStart vs local deployments
  R.push('-- LOCAL: workers vs local deployments --');
  var localMiss = [];
  localWorkers.forEach(function(w) {
    var dep = ldByWid[String(w.id)];
    var hasWClient = Boolean(w.client);
    var hasDep = Boolean(dep);
    if (hasWClient !== hasDep) {
      localMiss.push({ id: w.id, name: w.name || '(unknown)', empNo: w.employeeNo || '(unknown)',
        wClient: w.client || '(none)', wAssign: w.assignment || '(none)',
        wDepStart: w.deploymentStart || '(none)',
        depClientId: dep ? String(dep.clientId || '') : '(none)',
        depAssign: dep ? (dep.assignment || '(none)') : '(none)',
        depStatus: dep ? (dep.status || '(none)') : '(none)' });
    } else if (hasDep && dep.clientId && w.client !== String(dep.clientId)) {
      localMiss.push({ id: w.id, name: w.name || '(unknown)', empNo: w.employeeNo || '(unknown)',
        wClient: w.client, wAssign: w.assignment || '(none)',
        wDepStart: w.deploymentStart || '(none)',
        depClientId: String(dep.clientId), depAssign: dep.assignment || '(none)',
        depStatus: dep.status || '(none)' });
    }
  });

  if (!localMiss.length) {
    R.push('  No mismatches in local data.');
  } else {
    R.push('  MISMATCHES FOUND (' + localMiss.length + '):');
    R.push('');
    localMiss.forEach(function(m) {
      R.push('  Worker: ' + m.name + ' (' + m.empNo + ') ID=' + m.id);
      R.push('    worker.client: ' + m.wClient + '  |  worker.assignment: ' + m.wAssign);
      R.push('    worker.deploymentStart: ' + m.wDepStart);
      R.push('    deployments[].clientId: ' + m.depClientId + '  assignment: ' + m.depAssign + '  status: ' + m.depStatus);
      R.push('');
    });
  }

  // Cloud section — requires async Supabase fetch
  var client = null;
  try { client = window.labourForceSupabase; } catch(e) {}
  if (!client) {
    R.push('-- CLOUD: Supabase not available (run after page load with network) --');
    R.push('  Cloud comparison skipped. Load LabourForce first, then re-run this script.');
    R.push('================================================================================');
    R.push(' Resolve local mismatches above. For cloud mismatches, manually compare');
    R.push(' workers.client_name against the deployments table in the Supabase dashboard.');
    R.push('================================================================================\n');
    console.log(R.join('\n'));
    done();
    return;
  }

  async function fetchAll(table) {
    var from = 0, page = 1000, all = [];
    while (true) {
      var res = await client.from(table).select('*').range(from, from + page - 1);
      if (res.error) throw new Error('fetchAll(' + table + '): ' + res.error.message);
      if (!res.data || !res.data.length) break;
      all = all.concat(res.data);
      if (res.data.length < page) break;
      from += page;
    }
    return all;
  }

  (async function() {
    try {
      console.log('[Labour Force] Fetching cloud data...');
      var cloudWorkers = await fetchAll('workers');
      var cloudDeployments = await fetchAll('deployments');

      var cdByWid = {};
      cloudDeployments.forEach(function(d) { if (d.worker_id != null) cdByWid[String(d.worker_id)] = d; });

      R.push('-- CLOUD: workers vs deployments table --');
      var cloudMiss = [];
      cloudWorkers.forEach(function(w) {
        var dep = cdByWid[String(w.id)];
        var wClient = w.client_name || w.client || '';
        if (dep && wClient && wClient !== String(dep.client_id || '')) {
          cloudMiss.push({ id: w.id, name: w.full_name || w.name || '(unknown)',
            empNo: w.employee_no || '(unknown)',
            wClient: wClient, depClientId: String(dep.client_id || ''),
            depStatus: dep.status, depStart: dep.start_date });
        }
        if (!dep && wClient) {
          cloudMiss.push({ id: w.id, name: w.full_name || w.name || '(unknown)',
            empNo: w.employee_no || '(unknown)',
            wClient: wClient, depClientId: '(no deployment)', depStatus: 'n/a', depStart: 'n/a' });
        }
        if (dep && !wClient) {
          cloudMiss.push({ id: w.id, name: w.full_name || w.name || '(unknown)',
            empNo: w.employee_no || '(unknown)',
            wClient: '(none)', depClientId: String(dep.client_id || ''),
            depStatus: dep.status, depStart: dep.start_date });
        }
      });

      if (!cloudMiss.length) {
        R.push('  No mismatches in cloud.');
      } else {
        R.push('  MISMATCHES FOUND (' + cloudMiss.length + '):');
        R.push('');
        cloudMiss.forEach(function(m) {
          R.push('  Worker: ' + m.name + ' (' + m.empNo + ') ID=' + m.id);
          R.push('    worker.client_name: ' + m.wClient + '  |  deployment.client_id: ' + m.depClientId);
          R.push('    deployment status: ' + m.depStatus + '  start: ' + m.depStart);
          R.push('');
        });
      }
    } catch(e) {
      R.push('-- CLOUD: Error fetching cloud data: ' + e.message + ' --');
      R.push('  Cloud comparison skipped. Check network and Supabase connection.');
    }

    R.push('================================================================================');
    R.push(' RESOLUTION REQUIRED:');
    R.push(' For each mismatch above, decide which is authoritative and update');
    R.push(' accordingly in the Supabase dashboard or via direct DB edit.');
    R.push(' Only after resolving all mismatches should deployments become the');
    R.push(' single source of truth for worker-client assignment data.');
    R.push('================================================================================\n');

    console.log(R.join('\n'));
    done();
  })();
})();