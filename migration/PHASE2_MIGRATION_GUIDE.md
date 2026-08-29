# LabourForce Phase 2 Migration: localStorage → Supabase-authoritative

## Architecture Target
```
UI → Supabase (direct write) → PostgreSQL
UI ← Supabase (hydrate on load) ← PostgreSQL
```

NOT: `UI → localStorage → background sync → Supabase`

## localStorage Keys — Classification

| Key | Type | Classification |
|---|---|---|
| `labourforce_workers` | Array | NEEDS MIGRATION → `workers` table |
| `labourforce_departments` | Array | NEEDS MIGRATION → `departments` table |
| `labourforce_clients` | Array | NEEDS MIGRATION → `clients` table |
| `labourforce_requests` | Array | NEEDS MIGRATION → `labour_requests` |
| `labourforce_attendance` | Object | NEEDS MIGRATION → `attendance` + `attendance_approvals` |
| `labourforce_payroll` | Object | NEEDS SCHEMA → new `payroll_periods` + `payroll_lines` |
| `labourforce_jts_state` | Object | NEEDS SCHEMA → new `jts_disputes` + `jts_corrections` |
| `labourforce_jts_deduction_rates` | Object | NEEDS SCHEMA → `system_settings` table |
| `labourforce_deployments` | Array | NEEDS MIGRATION → `deployments` table |
| `labourforce_audit` | Array | NEEDS MIGRATION → `audit_logs` table |
| `labourforce_jts_workbook_imported` | Boolean | REMOVE (dead flag) |
| `labourforce_remote_map_v2` | Object | REMOVE (replaced by Supabase UUIDs) |
| `labourforce_cloud_dirty` | String | REMOVE (sync infrastructure) |
| `labourforce_sync_fail_count` | String | REMOVE |
| `labourforce_last_sync_error` | String | REMOVE |
| `labourforce_attendance_dirty_dates` | Array | REMOVE |
| `labourforce_attendance_dirty` | String | REMOVE |
| `lf_missing_tables` | Object | REMOVE |
| `labourforce_nav_collapsed` | Object | ✅ KEEP (UI state only) |
| `labourforce_compact_view` | String | ✅ KEEP (UI state only) |

## Confirmed Findings

1. `attendance_audit_logs` is DEAD — defined in `casualpay_attendance.sql` but never written or read by any frontend code. `syncAudit()` and `manage-users` Edge Function both write to `audit_logs`. Do NOT create `attendance_audit_logs`.

2. `workers_public` view does NOT exist in any SQL file. `hydrateFromBackend()` reads it (line 631) but it falls back to raw `workers` table on un-migrated DBs. Needs creation.

3. `attendance_approvals` is NEVER written to. Only `hydrateAttendanceFromBackend()` reads it. `submitAttendance()` and `approveAttendance()` must write to it.

4. `deployments` table may be missing `request_id` column on older schema. No migration SQL creates it.

5. `supervisor.html` does NOT load `data.js`. `saveData()` is undefined there. `installSaveHook()` is guarded but the JTS write path calls `saveData()` anyway.

6. Bug 23514: `upsertBatch()` throws on all errors, but `syncAudit()` already handles 23505 (duplicate key) inline. `upsertBatch()` should skip 23505 silently.

## Phase Order

### Phase 2.1: Supabase Schema (new tables/views)
Run `migration/phase2_schema.sql` in Supabase SQL Editor.

### Phase 2.2: Write Functions (supabase.js)
Add direct-write functions. Remove sync infrastructure. Flip `LF_PHASE1 = false` and set `LF_PHASE2 = true`.

### Phase 2.3: Fix supervisor.html
Add `data.js` to script list.

### Phase 2.4: Write Paths (app.js, advanced.js, jtsattendance.js)
Replace `saveData()` calls with direct Supabase write calls.

### Phase 2.5: Remove Dead localStorage Keys
After successful deployment, clear the sync infra keys.
