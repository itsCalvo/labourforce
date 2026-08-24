-- Run once in the Supabase SQL Editor before connecting the imported JTS roster.
-- This extends the existing workers table without deleting any existing records.

alter table public.workers add column if not exists kra_pin text;
alter table public.workers add column if not exists nssf_number text;
alter table public.workers add column if not exists shif_number text;
alter table public.workers add column if not exists account_number text;
alter table public.workers add column if not exists designation text;
alter table public.workers add column if not exists source_sheet text;
alter table public.workers add column if not exists id_number text;
alter table public.attendance add column if not exists hours_worked numeric(6,2) not null default 0;
alter table public.departments add column if not exists default_daily_rate numeric(12,2) not null default 0;
alter table public.departments add column if not exists default_overtime_rate numeric(12,2) not null default 0;

create index if not exists workers_designation_idx on public.workers(designation);

grant select, insert, update on public.workers to authenticated;
