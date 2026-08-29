# /verify — Worker Attendance Verification

## Files added

```
verify.html                                       (12 KB)
verify.js                                         (21 KB)
migration/phase2_verify_schema.sql                 (5 KB)
supabase/functions/worker-verify-pin/index.ts      (6 KB)
supabase/functions/worker-update-pin/index.ts      (6 KB)
supabase/functions/worker-attendance/index.ts      (4 KB)
```

## Files modified (minor, non-breaking)

```
index.html        — added "Worker attendance verification" link in auth gate
jtsattendance.html — added "Verify attendance" link in header
styles.css        — focus rings, button transitions, skeleton, status pills
supabase.js       — fixed pre-existing 'worked' → 'present' status mapping bug
```

## Deploy order

1. **Apply schema** (Supabase SQL Editor, non-destructive):
   ```
   migration/phase2_verify_schema.sql
   ```
   Creates `worker_pins` (hashed PIN storage) and `worker_sessions` (8-hour tokens).
   Seeds default `'jts'` PIN for every active worker.

2. **Deploy Edge Functions** (Deno, from project root):
   ```bash
   supabase functions deploy worker-verify-pin
   supabase functions deploy worker-update-pin
   supabase functions deploy worker-attendance
   ```
   The Supabase project must have `SERVICE_ROLE_KEY` set (auto-injected since v1).

3. **Push `verify.html` and `verify.js`** to the GitHub Pages branch.
   Both files are static and work as-is. Routing to `/verify` is automatic on GH Pages.

4. **(Optional) Hard-refresh the browser** so the new auth-gate link and stylesheet
   improvements take effect.

## How it works

```
/verify
  ↓
Worker enters: JTS00123  +  jts (default)
  ↓
POST /functions/v1/worker-verify-pin  { employee_no, pin }
  ↓  (service_role key never leaves the server)
  ↓
server checks worker_pins.hash against pin
  ↓
issues session_token, stored in worker_sessions (8h)
  ↓
browser stores { worker_id, session_token } in sessionStorage
  ↓
POST /functions/v1/worker-attendance  { worker_id, session_token, range_start, range_end }
  ↓  (server validates token, returns ONLY that worker's rows)
  ↓
calendar renders
```

## Security properties

* PINs stored only as `$sha$<salt>$<hex>` — never plaintext.
* Default `jts` PIN is a single sentinel hash that all seeded workers share
  until they change it. Each worker's row flips `is_default=false` on first change.
* `worker_sessions` is RLS-locked: no anon or authenticated policy. Only
  service_role (Edge Functions) reads/writes.
* The browser never sees a `?worker_id=` URL parameter that returns data without
  a valid session_token. The token is a 64-char random hex, unguessable.
* Even if a worker swaps `worker_id` in the request body, the Edge Function
  validates `(token, worker_id)` against `worker_sessions` and rejects
  mismatches. Result: `Worker A` cannot retrieve `Worker B`'s data.
* Only `attendance_date` and `status` columns are returned — no rates,
  no notes, no supervisor info, no payroll.

## Privacy guarantees

* Worker only sees: their name, their ID, their attendance dates/statuses, and
  PIN management.
* Worker NEVER sees: salary, pay rate, gross/net pay, payroll periods,
  supervisor names, other workers, client info, internal notes, audit info,
  permissions, or roles.

## What `/verify` does NOT do

* Does NOT use `localStorage` for attendance data.
* Does NOT create a second attendance system.
* Does NOT use `syncAttendance` or `syncAttendanceWithCloud`.
* Does NOT modify `supervisor.js`, `app.js`, payroll, or the existing
  attendance submission logic.
* Does NOT expose the service_role key to the browser (only anon key).
* Does NOT mark future / unfinalized dates as absent.

## Status mapping (matches existing schema)

| DB `status` | Calendar |
|-------------|----------|
| `present`   | ✓ Worked |
| `approved`  | ✓ Worked |
| `absent`    | — Absent |
| `pending`   | · Pending |
| no row      | · Pending (never auto-absent) |

## Pre-existing bug fixed

Phase 2 code wrote `'worked'` to `attendance.status`, but the CHECK constraint
allows only `'pending' | 'present' | 'absent' | 'approved'`. This caused silent
upsert failures. Fixed in `supabase.js` lines 276, 376, 460 to write `'present'`
while still accepting `'worked'` as an in-app input value.

## Manual test plan

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Worker A logs in with correct PIN | Shows Worker A's calendar |
| 2 | Worker A logs in with wrong PIN | "Worker ID or PIN is incorrect." |
| 3 | Worker A logs in, swaps worker_id in DevTools, refreshes | Backend rejects (token/worker_id mismatch) → 401 |
| 4 | New worker uses `jts` | Forced PIN change screen |
| 5 | Worker changes PIN, logs out, logs in with new PIN | Works |
| 6 | Worker logs in with new PIN then `jts` | Fails (default hash no longer valid) |
| 7 | Supervisor records Worker A as `present` | Calendar shows ✓ |
| 8 | Supervisor records Worker A as `absent` | Calendar shows — |
| 9 | No row for past date | Shows · (not —) |
| 10 | Navigate Jul → Aug → Sep | Each month queries its own range |
| 11 | Inspect Network tab | Only `worker-attendance` requests; no localStorage cache |
| 12 | Inspect response payload | Only `attendance_date` and `status` fields |
