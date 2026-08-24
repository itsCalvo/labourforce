-- ============================================================
-- THE LABOUR FORCE — JTS PAYROLL & ATTENDANCE EXTENSION
-- Runs against the existing Labour Force schema described in the
-- current project. Intended to be applied after the base schema and
-- RBAC tables already exist.
-- ============================================================

-- 1) Dimension tables
create table if not exists public.departments (
  id bigserial primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.designations (
  id bigserial primary key,
  department_id bigint not null references public.departments(id) on delete restrict,
  name text not null,
  rate_day numeric(12,2) not null default 0,
  rate_hour numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (department_id, name)
);

create table if not exists public.workers (
  id bigserial primary key,
  staff_no text,
  id_number text not null unique,
  name text not null,
  department_id bigint references public.departments(id) on delete restrict,
  designation_id bigint references public.designations(id) on delete restrict,
  override_rate_day numeric(12,2),
  override_rate_hour numeric(12,2),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workers_department_idx on public.workers(department_id);
create index if not exists workers_designation_idx on public.workers(designation_id);

-- 2) Daily attendance & review
create table if not exists public.attendance (
  id bigserial primary key,
  worker_id bigint not null references public.workers(id) on delete cascade,
  attendance_date date not null,
  status text not null default 'pending' check (status in ('pending','present','absent','approved')),
  hours_worked numeric(6,2) not null default 0,
  overtime_hours numeric(6,2) not null default 0,
  notes text,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(worker_id, attendance_date)
);

create table if not exists public.corrections (
  id bigserial primary key,
  worker_id bigint not null references public.workers(id) on delete cascade,
  issue_type text not null,
  issue_text text not null,
  status text not null default 'open' check (status in ('open','in_review','resolved','rejected')),
  raised_by uuid references auth.users(id),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.disputes (
  id bigserial primary key,
  worker_id bigint not null references public.workers(id) on delete cascade,
  attendance_id bigint references public.attendance(id) on delete cascade,
  dispute_date date not null,
  note text not null,
  status text not null default 'pending' check (status in ('pending','reviewed','resolved')),
  raised_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.deductions (
  id bigserial primary key,
  worker_id bigint not null references public.workers(id) on delete cascade,
  deduction_type text not null check (deduction_type in ('advance','ppe','medical','disciplinary','other')),
  description text not null,
  amount numeric(12,2) not null default 0,
  installments integer not null default 1,
  installment_amount numeric(12,2) not null default 0,
  remaining_balance numeric(12,2) not null default 0,
  status text not null default 'active' check (status in ('active','paid','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3) Payroll and payouts
create table if not exists public.payroll_periods (
  id bigserial primary key,
  label text not null,
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft','open','approved','closed')),
  created_at timestamptz not null default now(),
  unique(period_start, period_end)
);

create table if not exists public.payroll_lines (
  id bigserial primary key,
  payroll_period_id bigint not null references public.payroll_periods(id) on delete cascade,
  worker_id bigint not null references public.workers(id) on delete cascade,
  designation_id bigint references public.designations(id) on delete restrict,
  days_worked integer not null default 0,
  normal_hours numeric(6,2) not null default 0,
  overtime_hours numeric(6,2) not null default 0,
  normal_pay numeric(12,2) not null default 0,
  overtime_pay numeric(12,2) not null default 0,
  gross_pay numeric(12,2) not null default 0,
  nssf numeric(12,2) not null default 0,
  housing_levy numeric(12,2) not null default 0,
  shif numeric(12,2) not null default 0,
  paye numeric(12,2) not null default 0,
  deductions_total numeric(12,2) not null default 0,
  net_pay numeric(12,2) not null default 0,
  to_pay numeric(12,2) not null default 0,
  review_flag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(payroll_period_id, worker_id)
);

create table if not exists public.bankfile_exports (
  id bigserial primary key,
  payroll_period_id bigint not null references public.payroll_periods(id) on delete restrict,
  export_name text not null,
  total_amount numeric(12,2) not null default 0,
  status text not null default 'generated' check (status in ('generated','approved','sent')),
  generated_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.bankfile_lines (
  id bigserial primary key,
  bankfile_export_id bigint not null references public.bankfile_exports(id) on delete cascade,
  worker_id bigint not null references public.workers(id) on delete restrict,
  account_no text,
  account_name text,
  id_number text,
  phone text,
  amount numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

-- 4) Public-facing worker view: hide rate data from field users
create or replace view public.workers_public as
select
  w.id,
  w.staff_no,
  w.id_number,
  w.name,
  d.name as department,
  deg.name as designation,
  w.active,
  w.created_at,
  w.updated_at
from public.workers w
left join public.departments d on d.id = w.department_id
left join public.designations deg on deg.id = w.designation_id;

-- 5) RBAC permissions needed by JTS payroll operations
insert into public.roles (name, description)
values
  ('team_leader', 'Daily attendance capture and roll-call confirmation'),
  ('accounts', 'Attendance approval and deduction / dispute review'),
  ('rates_admin', 'Administrative access to worker rates and designation rates')
on conflict (name) do nothing;

insert into public.permissions (code, description)
values
  ('attendance.capture', 'Capture daily worker attendance roll-call'),
  ('attendance.approve', 'Approve attendance before payroll processing'),
  ('corrections.manage', 'Resolve worker corrections and master-data updates'),
  ('disputes.manage', 'Manage disputed attendance days and review notes'),
  ('workers.view_rates', 'View worker and designation rate data'),
  ('rates.manage', 'Manage designation and override rate master data'),
  ('payroll.calculate', 'Calculate payroll for an approved payroll period'),
  ('payroll.approve', 'Approve payroll calculation and release pay summary'),
  ('bankfile.generate', 'Generate bank file export snapshots'),
  ('workers.view', 'View worker master list')
on conflict (code) do nothing;

-- Administrator / super_admin already exist in the base schema; grant the
-- JTS-specific permissions to them as the smallest tightly-held group.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'attendance.capture',
  'attendance.approve',
  'corrections.manage',
  'disputes.manage',
  'workers.view_rates',
  'rates.manage',
  'payroll.calculate',
  'payroll.approve',
  'bankfile.generate',
  'workers.view'
)
where r.name in ('administrator', 'super_admin')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'attendance.capture'
)
where r.name = 'team_leader'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'attendance.capture',
  'attendance.approve',
  'corrections.manage',
  'disputes.manage'
)
where r.name = 'accounts'
on conflict do nothing;

-- 6) Permissions for data access
grant select on public.workers_public to authenticated;
grant select on public.departments to authenticated;
grant select on public.designations to authenticated;
grant select on public.attendance to authenticated;
grant select on public.disputes to authenticated;
grant select on public.corrections to authenticated;
grant select on public.deductions to authenticated;
grant select on public.payroll_periods to authenticated;
grant select on public.payroll_lines to authenticated;
grant select on public.bankfile_exports to authenticated;
grant select on public.bankfile_lines to authenticated;

-- 7) RLS setup
alter table public.workers enable row level security;
alter table public.attendance enable row level security;
alter table public.corrections enable row level security;
alter table public.disputes enable row level security;
alter table public.deductions enable row level security;
alter table public.payroll_periods enable row level security;
alter table public.payroll_lines enable row level security;
alter table public.bankfile_exports enable row level security;
alter table public.bankfile_lines enable row level security;

-- Public worker list is intentionally read-only and excludes rates
create policy if not exists "workers_public select" 
on public.workers_public
for select to authenticated
using (true);

create policy if not exists "workers admin read rates" 
on public.workers
for select to authenticated
using (public.has_permission('workers.view_rates') or public.has_permission('rates.manage'));

create policy if not exists "workers admin write rates" 
on public.workers
for insert to authenticated
with check (public.has_permission('workers.view_rates') or public.has_permission('rates.manage'));

create policy if not exists "workers admin update rates" 
on public.workers
for update to authenticated
using (public.has_permission('workers.view_rates') or public.has_permission('rates.manage'))
with check (public.has_permission('workers.view_rates') or public.has_permission('rates.manage'));

create policy if not exists "workers admin delete rates" 
on public.workers
for delete to authenticated
using (public.has_permission('workers.view_rates') or public.has_permission('rates.manage'));

create policy if not exists "attendance capture or approve" 
on public.attendance
for select to authenticated
using (
  public.has_permission('attendance.capture')
  or public.has_permission('attendance.approve')
);

create policy if not exists "attendance insert capture" 
on public.attendance
for insert to authenticated
with check (public.has_permission('attendance.capture'));

create policy if not exists "attendance update capture or approve" 
on public.attendance
for update to authenticated
using (
  public.has_permission('attendance.capture')
  or public.has_permission('attendance.approve')
)
with check (
  public.has_permission('attendance.capture')
  or public.has_permission('attendance.approve')
);

create policy if not exists "corrections manage" 
on public.corrections
for all to authenticated
using (
  public.has_permission('corrections.manage')
)
with check (
  public.has_permission('corrections.manage')
);

create policy if not exists "disputes manage" 
on public.disputes
for all to authenticated
using (
  public.has_permission('disputes.manage')
)
with check (
  public.has_permission('disputes.manage')
);

create policy if not exists "deductions manage" 
on public.deductions
for all to authenticated
using (
  public.has_permission('attendance.approve')
  or public.has_permission('payroll.calculate')
)
with check (
  public.has_permission('attendance.approve')
  or public.has_permission('payroll.calculate')
);

create policy if not exists "payroll periods manage" 
on public.payroll_periods
for all to authenticated
using (
  public.has_permission('payroll.calculate')
  or public.has_permission('payroll.approve')
)
with check (
  public.has_permission('payroll.calculate')
  or public.has_permission('payroll.approve')
);

create policy if not exists "payroll lines manage" 
on public.payroll_lines
for all to authenticated
using (
  public.has_permission('payroll.calculate')
  or public.has_permission('payroll.approve')
)
with check (
  public.has_permission('payroll.calculate')
  or public.has_permission('payroll.approve')
);

create policy if not exists "bankfile exports manage" 
on public.bankfile_exports
for all to authenticated
using (public.has_permission('bankfile.generate'))
with check (public.has_permission('bankfile.generate'));

create policy if not exists "bankfile lines manage" 
on public.bankfile_lines
for all to authenticated
using (public.has_permission('bankfile.generate'))
with check (public.has_permission('bankfile.generate'));

-- 8) Helpful review views and guards
create or replace view public.attendance_summary as
select
  a.worker_id,
  a.attendance_date,
  w.name as worker_name,
  w.id_number,
  a.status,
  a.hours_worked,
  a.overtime_hours,
  case when d.id is not null then d.description else null end as deduction_note
from public.attendance a
join public.workers w on w.id = a.worker_id
left join public.deductions d on d.worker_id = a.worker_id and d.status = 'active';

-- 9) Safe monthly re-import expectation
-- Match on id_number so a worker's historical attendance/payroll rows never
-- detach when their details change. The worker import routine is intentionally
-- idempotent and review-driven for missing workers rather than silently
-- deactivating them.

-- These indexes give the worker-lookup re-importer and payroll calculator a
-- clean path when dealing with a 468-worker roster.
create index if not exists attendance_date_idx on public.attendance(attendance_date);
create index if not exists attendance_status_idx on public.attendance(status);
create index if not exists disputes_worker_date_idx on public.disputes(worker_id, dispute_date);
create index if not exists deductions_worker_idx on public.deductions(worker_id, status);
create index if not exists payroll_period_worker_idx on public.payroll_lines(payroll_period_id, worker_id);
