-- ============================================================
-- LabourForce Phase 2: Cloud-Authoritative Schema
-- Run in Supabase SQL Editor.
-- Non-destructive: all tables use CREATE TABLE IF NOT EXISTS.
-- ============================================================

-- 1. workers_public view: rates-hidden worker list for all authenticated users.
DROP VIEW IF EXISTS public.workers_public;
CREATE OR REPLACE VIEW public.workers_public AS
SELECT
  id, employee_no, full_name, phone, national_id, id_number,
  department_id, classification, designation, join_date, source_sheet,
  active, notes, created_at, updated_at,
  daily_rate, overtime_rate, kra_pin, nssf_number, shif_number, account_number,
  supervisor_id
FROM public.workers;

DROP POLICY IF EXISTS workers_public_read ON public.workers_public;
CREATE POLICY workers_public_read ON public.workers_public FOR SELECT TO authenticated USING (true);

-- 2. Add request_id to deployments if not present
ALTER TABLE public.deployments ADD COLUMN IF NOT EXISTS request_id uuid REFERENCES public.labour_requests(id);

-- 3. Payroll periods
CREATE TABLE IF NOT EXISTS public.payroll_periods (
  id uuid primary key default gen_random_uuid(),
  period_key text not null unique,
  period_start date not null,
  period_end date not null,
  department_id bigint references public.departments(id) on delete set null,
  status text not null default 'draft' check(status in ('draft','calculated','approved','paid')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

ALTER TABLE public.payroll_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_periods_manage ON public.payroll_periods;
CREATE POLICY payroll_periods_manage ON public.payroll_periods FOR ALL TO authenticated
  USING (public.has_permission('payroll.manage')
         OR public.has_permission('accounts')
         OR public.has_permission('super_admin')
         OR public.has_permission('administrator'));

-- 4. Payroll line items (one row per worker per period)
CREATE TABLE IF NOT EXISTS public.payroll_lines (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.payroll_periods(id) on delete cascade,
  worker_id bigint not null references public.workers(id) on delete cascade,
  regular_hours numeric(6,2) not null default 0,
  overtime_hours numeric(6,2) not null default 0,
  regular_pay numeric(12,2) not null default 0,
  overtime_pay numeric(12,2) not null default 0,
  gross_pay numeric(12,2) not null default 0,
  deductions jsonb default '{"nssf":0,"housing":0,"shif":0,"paye":0}'::jsonb,
  net_pay numeric(12,2) not null default 0,
  status text not null default 'pending' check(status in ('pending','approved','paid')),
  created_at timestamptz default now(),
  unique(period_id, worker_id)
);

ALTER TABLE public.payroll_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_lines_read ON public.payroll_lines;
CREATE POLICY payroll_lines_read ON public.payroll_lines FOR SELECT TO authenticated
  USING (public.has_permission('payroll.manage')
         OR public.has_permission('accounts')
         OR public.has_permission('super_admin')
         OR public.has_permission('administrator')
         OR public.has_permission('attendance.approve')
         OR worker_id IN (SELECT worker_id FROM public.profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS payroll_lines_write ON public.payroll_lines;
CREATE POLICY payroll_lines_write ON public.payroll_lines FOR ALL TO authenticated
  USING (public.has_permission('payroll.manage')
         OR public.has_permission('accounts')
         OR public.has_permission('super_admin')
         OR public.has_permission('administrator'));

-- 5. JTS Disputes
CREATE TABLE IF NOT EXISTS public.jts_disputes (
  id uuid primary key default gen_random_uuid(),
  worker_id bigint not null references public.workers(id) on delete cascade,
  dispute_date date not null,
  note text not null,
  status text not null default 'pending' check(status in ('pending','resolved','rejected')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  resolution_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

ALTER TABLE public.jts_disputes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jts_disputes_manage ON public.jts_disputes;
CREATE POLICY jts_disputes_manage ON public.jts_disputes FOR ALL TO authenticated
  USING (public.has_permission('attendance.approve')
         OR public.has_permission('super_admin')
         OR public.has_permission('administrator')
         OR created_by = auth.uid());

-- 6. JTS Corrections (worker master-data correction requests)
CREATE TABLE IF NOT EXISTS public.jts_corrections (
  id uuid primary key default gen_random_uuid(),
  worker_id bigint not null references public.workers(id) on delete cascade,
  issue_type text not null,
  issue_text text not null,
  status text not null default 'open' check(status in ('open','resolved','rejected')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

ALTER TABLE public.jts_corrections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jts_corrections_manage ON public.jts_corrections;
CREATE POLICY jts_corrections_manage ON public.jts_corrections FOR ALL TO authenticated
  USING (public.has_permission('attendance.approve')
         OR public.has_permission('super_admin')
         OR public.has_permission('administrator')
         OR created_by = auth.uid());

-- 7. System settings (deduction rates, app config)
CREATE TABLE IF NOT EXISTS public.system_settings (
  key text primary key,
  value jsonb not null default '{}',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz default now()
);

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_settings_read ON public.system_settings;
CREATE POLICY system_settings_read ON public.system_settings FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS system_settings_write ON public.system_settings;
CREATE POLICY system_settings_write ON public.system_settings FOR ALL TO authenticated
  USING (public.has_permission('super_admin') OR public.has_permission('administrator'));

-- 8. Insert default deduction rates (ON CONFLICT prevents overwriting)
INSERT INTO public.system_settings (key, value) VALUES
  ('jts_deduction_rates', '{"nssf":6,"housing":1.5,"shif":0.5,"paye":10}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 9. Remote ID lookup table (replaces labourforce_remote_map_v2 localStorage)
--    local_id  = application's local numeric/string ID
--    remote_id = Supabase UUID assigned to that row
CREATE TABLE IF NOT EXISTS public.id_mappings (
  entity_type text not null check(entity_type in
    ('worker','client','department','request','deployment','audit',
     'request_worker','request_client')),
  local_id text not null,
  remote_id uuid not null,
  created_at timestamptz default now(),
  primary key (entity_type, local_id)
);

ALTER TABLE public.id_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS id_mappings_read ON public.id_mappings;
CREATE POLICY id_mappings_read ON public.id_mappings FOR SELECT TO authenticated USING (true);

