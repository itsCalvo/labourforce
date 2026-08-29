// =============================================================
//  LABOUR FORCE — ROLLBACK SNAPSHOT
//  Run in browser console BEFORE any migration begins.
//  Exports all Supabase tables + all labourforce_* localStorage
//  keys as a downloadable JSON file.
// =============================================================
(function() {
  var client = null;
  try { client = window.labourForceSupabase; } catch(e) {}
  if (!client) { console.error('Supabase not initialised. Load LabourForce and sign in first.'); return; }

  var TABLES = [
    'workers','attendance','attendance_approvals','deployments',
    'clients','departments','labour_requests','labour_request_workers',
    'profiles','audit_logs'
  ];

  var cloud = {};
  var errors = {};

  async function fetchAll(table) {
    var from = 0, page = 1000, all = [], hasMore = true;
    while (hasMore) {
      var r = await client.from(table).select('*').range(from, from + page - 1);
      if (r.error) { errors[table] = r.error.message; return null; }
      if (!r.data || !r.data.length) { hasMore = false; }
      else {
        all = all.concat(r.data);
        if (r.data.length < page) hasMore = false;
        else from += page;
      }
    }
    return all;
  }

  var local = {};
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && k.startsWith('labourforce_')) {
      try { local[k] = JSON.parse(localStorage.getItem(k)); }
      catch (e) { local[k] = localStorage.getItem(k); }
    }
  }

  var counts = { cloud: {}, local: Object.keys(local).length };
  var snapshot = { takenAt: new Date().toISOString(), cloudTables: {}, localStorage: local };

  console.log('[Labour Force] Snapshot: fetching ' + TABLES.length + ' tables...');

  for (var t = 0; t < TABLES.length; t++) {
    var table = TABLES[t];
    console.log('  ' + table + '...');
    var rows = await fetchAll(table);
    snapshot.cloudTables[table] = rows;
    counts.cloud[table] = rows ? rows.length : ('ERROR: ' + (errors[table] || 'unknown'));
  }

  console.log('\n[Labour Force] Snapshot complete.');
  console.table(counts.cloud);
  console.log('Local keys: ' + counts.local);
  console.log('\nSnapshot object:', snapshot);

  var blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'rollback_snapshot_' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.log('[Labour Force] Snapshot downloaded as rollback_snapshot_' + new Date().toISOString().slice(0, 10) + '.json');
  console.log('[Labour Force] Save this file manually as well — it is your rollback safety net.');
  return snapshot;
})();