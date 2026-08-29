# Deploy Edge Functions — One-time setup

The three worker-portal Edge Functions must be deployed to the Supabase project
`xliclazgekuokvpcwiyq` before the /verify portal can authenticate workers.

Run these commands in a terminal (PowerShell or cmd) from the project root:

```powershell
# 1. Install Supabase CLI (if not already installed)
# Option A — via npm (Node.js required):
npm install -g supabase

# Option B — direct binary (no Node needed):
# Download from https://github.com/supabase/cli/releases/latest
# Put the `supabase` binary somewhere in your PATH

# 2. Confirm CLI works
supabase --version

# 3. Login (opens browser to authorize — use your Supabase account)
supabase login

# 4. Link this project
supabase link --project-ref xliclazgekuokvpcwiyq

# 5. Deploy all three functions
cd supabase
supabase functions deploy worker-verify-pin
supabase functions deploy worker-update-pin
supabase functions deploy worker-attendance
cd ..

# 6. Confirm they are live — all three should return 200 (not 404)
# Run this in your browser devtools console:
fetch('https://xliclazgekuokvpcwiyq.supabase.co/functions/v1/worker-verify-pin', {
  method:'OPTIONS',
  headers:{'Origin':'http://localhost:5500','Access-Control-Request-Method':'POST'}
}).then(r => console.log('Status:', r.status, 'Headers:', r.headers.get('access-control-allow-origin')))
```

## What was fixed in the functions

| File | Fix |
|------|-----|
| `worker-verify-pin/index.ts` | Lookup matches `staff_no` OR `id_number` (dropped `employee_no` — that column doesn't exist on the JTS-deployed `workers` table). Select narrowed to `id, staff_no, id_number, name, active`. |
| All three functions | OPTIONS preflight handler returns `Access-Control-Allow-Origin: *` — resolves the CORS block. |

## ⚠️ Database is empty — must be populated before login works

Live probe of the deployed DB on `xliclazgekuokvpcwiyq` showed:

| Object | Status |
|---|---|
| `public.workers` | empty `[]` |
| `public.worker_pins` | **404 — table does not exist** |
| `public.worker_sessions` | **404 — table does not exist** |
| `public.departments` | empty `[]` |
| `public.designations` | **404 — table does not exist** |
| `public.attendance` | empty `[]` |

The login returns `{"ok":false,"error":"invalid"}` because there is no row in `worker_pins` to match the PIN against, and no row in `workers` to match the ID against.

### Apply these SQL files in order (Supabase Dashboard → SQL Editor)

1. **`schema_patch_jts_payroll.sql`** — base tables (workers, attendance, departments, designations, payroll). Creates `workers` with columns `id, staff_no, id_number, name, department_id, designation_id, override_rate_day, override_rate_hour, active, created_at, updated_at`.

2. **`supabase/jts_worker_import.sql`** — adds optional columns (`kra_pin`, `nssf_number`, `shif_number`, `account_number`, `designation`, `source_sheet`, `id_number`) and grants for `authenticated` role.

3. **`import_workers.sql`** — creates `workers_staging` and the resolution queries. Upload your JTS roster CSV to `workers_staging` first, then run this file to populate `public.workers`.

4. **`migration/phase2_verify_schema.sql`** — creates `worker_pins` (with default `jts` hash) and `worker_sessions`. This is what makes the PIN check work.

5. **`migration/phase2_schema.sql`** — creates the `workers_public` view and the role/permission rows for rate-hiding.

### After the SQL is applied, redeploy the verify function

```powershell
supabase functions deploy worker-verify-pin
```

## After deployment — test the login

1. Open `/verify` in the browser
2. Enter National ID: `33499152`
3. Enter PIN: `jts`
4. Should show the attendance calendar (worker "JACOB TAMUN TOM" in the JTS schema)
