-- CasualPay attendance foundation. Non-destructive migration.
-- Review existing table definitions before running in production.

alter table public.attendance add column if not exists time_in timestamptz;
alter table public.attendance add column if not exists time_out timestamptz;
alter table public.attendance add column if not exists regular_hours numeric(6,2) not null default 0;
alter table public.attendance add column if not exists remarks text;
alter table public.attendance add column if not exists supervisor_id uuid references auth.users(id);
alter table public.attendance add column if not exists submitted_at timestamptz;
alter table public.attendance add column if not exists updated_by uuid references auth.users(id);
alter table public.profiles add column if not exists worker_id bigint references public.workers(id);
alter table public.attendance drop constraint if exists attendance_status_check;
alter table public.attendance add constraint attendance_status_check check (status in ('pending','present','absent','late','half_day','excused','off_day','pending_verification','worked','approved'));

create unique index if not exists attendance_worker_date_unique on public.attendance(worker_id, attendance_date);

create table if not exists public.attendance_audit_logs (
 id uuid primary key default gen_random_uuid(), attendance_id bigint not null references public.attendance(id) on delete cascade,
 worker_id bigint not null references public.workers(id) on delete cascade, previous_status text, new_status text,
 previous_hours numeric(6,2), new_hours numeric(6,2), previous_time_in timestamptz, new_time_in timestamptz,
 previous_time_out timestamptz, new_time_out timestamptz, reason text, changed_by uuid not null references auth.users(id), changed_at timestamptz not null default now()
);

create table if not exists public.attendance_approvals (
 id uuid primary key default gen_random_uuid(), attendance_date date not null, department_id bigint references public.departments(id),
 status text not null default 'submitted' check(status in ('submitted','approved','rejected','returned')),
 submitted_by uuid references auth.users(id), submitted_at timestamptz default now(), approved_by uuid references auth.users(id), approved_at timestamptz, remarks text
);

create table if not exists public.supervisor_assignments (
 id uuid primary key default gen_random_uuid(), supervisor_id uuid not null references auth.users(id) on delete cascade,
 department_id bigint references public.departments(id), designation text, active boolean not null default true,
 unique(supervisor_id, department_id, designation)
);

create or replace function public.can_manage_attendance(target_worker bigint)
returns boolean language sql stable security definer set search_path=public as $$
 select public.has_permission('attendance.capture') or public.has_permission('attendance.approve')
 or exists(select 1 from public.supervisor_assignments sa join public.workers w on w.department_id=sa.department_id
           where sa.supervisor_id=auth.uid() and sa.active and w.id=target_worker);
$$;

alter table public.attendance enable row level security;
alter table public.attendance_audit_logs enable row level security;
alter table public.attendance_approvals enable row level security;

drop policy if exists attendance_scope_select on public.attendance;
create policy attendance_scope_select on public.attendance for select to authenticated using (
 public.has_permission('attendance.approve') or public.can_manage_attendance(worker_id)
 or exists(select 1 from public.profiles p where p.id=auth.uid() and p.worker_id=attendance.worker_id)
);
drop policy if exists attendance_scope_write on public.attendance;
create policy attendance_scope_write on public.attendance for all to authenticated using(public.can_manage_attendance(worker_id)) with check(public.can_manage_attendance(worker_id));
create policy attendance_audit_read on public.attendance_audit_logs for select to authenticated using(public.has_permission('attendance.approve') or changed_by=auth.uid());
create policy attendance_audit_insert on public.attendance_audit_logs for insert to authenticated with check(changed_by=auth.uid());
create policy attendance_approval_read on public.attendance_approvals for select to authenticated using(public.has_permission('attendance.approve') or submitted_by=auth.uid());
create policy attendance_approval_write on public.attendance_approvals for all to authenticated using(public.has_permission('attendance.approve') or submitted_by=auth.uid()) with check(public.has_permission('attendance.approve') or submitted_by=auth.uid());

grant select,insert,update on public.attendance to authenticated;
grant select,insert on public.attendance_audit_logs to authenticated;
grant select,insert,update on public.attendance_approvals to authenticated;
grant select on public.supervisor_assignments to authenticated;
