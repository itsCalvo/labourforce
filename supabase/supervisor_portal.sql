-- ============================================================
-- SUPERVISOR PORTAL — runs in Supabase SQL Editor
-- Adds supervisor role + worker assignment + RLS policies
-- ============================================================

-- 1. Add supervisor_id to workers
alter table public.workers add column if not exists supervisor_id uuid references public.profiles(id) on delete set null;

-- 2. Insert the supervisor role
insert into public.roles (name, description)
values ('supervisor', 'Site / department supervisor — can mark attendance for assigned workers')
on conflict (name) do update set description = excluded.description;

-- 3. Grant attendance write permission to supervisors
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'supervisor'
  and p.code in ('attendance.take','attendance.view')
on conflict do nothing;

-- 4. Allow supervisors to read workers they supervise
drop policy if exists 'supervisors read their workers' on public.workers;
create policy 'supervisors read their workers'
on public.workers
for select
to authenticated
using (
  public.has_permission('workers.view')
  or (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role_id = (select id from public.roles where name = 'supervisor')
    )
    and supervisor_id = auth.uid()
  )
);

-- 5. Allow supervisors to insert attendance records for their workers
drop policy if exists 'supervisors insert own attendance' on public.attendance;
create policy 'supervisors insert own attendance'
on public.attendance
for insert
to authenticated
with check (
  public.has_permission('attendance.take')
  or (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role_id = (select id from public.roles where name = 'supervisor')
    )
    and exists (
      select 1 from public.workers
      where id = worker_id
        and supervisor_id = auth.uid()
    )
  )
);

-- 6. Allow supervisors to update attendance records for their workers
drop policy if exists 'supervisors update own attendance' on public.attendance;
create policy 'supervisors update own attendance'
on public.attendance
for update
to authenticated
using (
  public.has_permission('attendance.take')
  or (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role_id = (select id from public.roles where name = 'supervisor')
    )
    and exists (
      select 1 from public.workers
      where id = worker_id
        and supervisor_id = auth.uid()
    )
  )
);

-- 7. Give supervisors SELECT on workers
grant select on public.workers to authenticated;

