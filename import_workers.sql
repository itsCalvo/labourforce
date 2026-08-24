-- ============================================================
-- THE LABOUR FORCE — WORKER IMPORT (initial load + safe re-import)
-- Run after schema_patch_jts_payroll.sql has already been applied.
-- ============================================================


-- ============================================================
-- SECTION A — ONE-TIME SETUP
-- Run this section once, before any attendance capture begins.
-- ============================================================

-- A1. Staging table — a plain landing spot matching the CSV exactly.
-- No foreign keys here; this is intentionally disposable.
create table if not exists public.workers_staging (
  staff_no text,
  id_number text,
  name text,
  designation text,
  department text,
  rate_day numeric,
  active boolean,
  source_sheet text
);

-- A2. Upload workers_import.csv into workers_staging now,
-- via Table Editor -> workers_staging -> Insert -> Import data from CSV.
-- Come back and run the rest of this file once that's done.

-- A3. Populate departments from distinct staging values.
insert into public.departments (name)
select distinct trim(department)
from public.workers_staging
where department is not null and trim(department) <> ''
on conflict (name) do nothing;

-- A4. Populate designations from distinct (designation, department) pairs,
-- carrying the rate across as a default. Where the same designation
-- appears at different rates across rows, this takes the most common one —
-- check the flagged query at the bottom of this section before trusting it blindly.
insert into public.designations (name, department_id, default_daily_rate)
select distinct on (trim(s.designation), d.id)
  trim(s.designation),
  d.id,
  s.rate_day
from public.workers_staging s
join public.departments d on trim(d.name) = trim(s.department)
where s.designation is not null and trim(s.designation) <> ''
order by trim(s.designation), d.id, s.rate_day desc
on conflict (name, department_id) do nothing;

-- Sanity check before trusting the rate on each designation:
-- flags any designation that appears at more than one distinct rate,
-- meaning someone's default_daily_rate above may be wrong for some workers.
select trim(designation) as designation, department,
       count(distinct rate_day) as distinct_rates,
       array_agg(distinct rate_day) as rates_seen
from public.workers_staging
where designation is not null
group by trim(designation), department
having count(distinct rate_day) > 1;

-- A5. Populate workers, resolving department/designation names to IDs.
-- Requires a unique constraint on id_number so future re-imports can upsert safely.
alter table public.workers
  add constraint workers_id_number_key unique (id_number);

insert into public.workers (
  staff_no, id_number, name, department_id, designation_id,
  override_daily_rate, active
)
select
  s.staff_no,
  s.id_number,
  trim(s.name),
  d.id,
  dz.id,
  null,  -- no override at import; workers start on their designation's default rate
  coalesce(s.active, true)
from public.workers_staging s
left join public.departments d on trim(d.name) = trim(s.department)
left join public.designations dz on trim(dz.name) = trim(s.designation) and dz.department_id = d.id
where s.id_number is not null and trim(s.id_number) <> ''
on conflict (id_number) do nothing;   -- first load only; Section B handles updates

-- A6. Anyone with no id_number couldn't be safely imported (can't dedupe
-- them on re-import without one) — check this before going further.
select * from public.workers_staging where id_number is null or trim(id_number) = '';


-- ============================================================
-- SECTION B — SAFE MONTHLY RE-IMPORT
-- Run this each time JTS hands you a fresh worker list (e.g. for August).
-- Matches on id_number, so an existing worker's id (and therefore their
-- attendance/payroll history) never changes — only their current details do.
-- ============================================================

-- B1. Clear staging and re-upload that month's CSV the same way as A2/A3.
truncate table public.workers_staging;
-- (re-upload CSV here, then continue)

-- B2. Add any newly-seen departments/designations (same as A3/A4 — safe to
-- re-run, both use ON CONFLICT DO NOTHING).

-- B3. Update existing workers' current details — department, designation,
-- name spelling, active status — without touching their id or history.
update public.workers w
set
  name = trim(s.name),
  department_id = d.id,
  designation_id = dz.id,
  active = coalesce(s.active, true),
  staff_no = s.staff_no
from public.workers_staging s
left join public.departments d on trim(d.name) = trim(s.department)
left join public.designations dz on trim(dz.name) = trim(s.designation) and dz.department_id = d.id
where w.id_number = s.id_number;

-- B4. Insert anyone genuinely new this month (id_number not seen before).
insert into public.workers (
  staff_no, id_number, name, department_id, designation_id, active
)
select
  s.staff_no, s.id_number, trim(s.name), d.id, dz.id, coalesce(s.active, true)
from public.workers_staging s
left join public.departments d on trim(d.name) = trim(s.department)
left join public.designations dz on trim(dz.name) = trim(s.designation) and dz.department_id = d.id
where s.id_number is not null and trim(s.id_number) <> ''
on conflict (id_number) do nothing;

-- B5. Anyone in the OLD workers table but missing from THIS month's staging
-- likely left — flag them for review rather than silently deactivating.
-- (Silent deactivation would hide someone who was just typo'd out of one sheet.)
select w.id, w.staff_no, w.id_number, w.name
from public.workers w
where w.active = true
and not exists (
  select 1 from public.workers_staging s where s.id_number = w.id_number
);
-- Review this list manually, then deactivate confirmed leavers with:
-- update public.workers set active = false where id in (...);
