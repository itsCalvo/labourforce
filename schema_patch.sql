-- ============================================================
-- THE LABOUR FORCE — USER MANAGEMENT + AUDIT FIX
-- Run this once in Supabase SQL Editor after the core schema.
-- ============================================================

-- Administrators are allowed to manage Labour Force accounts.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'administrator'
  and p.code in ('users.view','users.manage')
on conflict do nothing;

-- Users with users.manage can update profiles (role, status, phone, name).
drop policy if exists "users manage profiles" on public.profiles;
create policy "users manage profiles"
on public.profiles
for update
to authenticated
using (
    public.has_permission('users.manage')
)
with check (
    public.has_permission('users.manage')
);

-- The frontend writes audit events for the currently signed-in user.
drop policy if exists "users create own audit logs" on public.audit_logs;
create policy "users create own audit logs"
on public.audit_logs
for insert
to authenticated
with check (
    user_id = auth.uid()
);

-- Make sure role/permission lookups are callable by authenticated users.
grant select on public.roles to authenticated;
grant select on public.permissions to authenticated;
grant select on public.role_permissions to authenticated;

-- Profiles need to be readable by administrators who have users.view.
grant select on public.profiles to authenticated;
grant update on public.profiles to authenticated;

-- Audit trail remains read-protected by audit.view.
grant select, insert on public.audit_logs to authenticated;

-- ============================================================
-- OPTIONAL: bootstrap an existing Auth user as super_admin
-- Replace the UUID and name, then run only if you need it.
-- ============================================================
-- insert into public.profiles (id, full_name, email, role_id)
-- select
--     'AUTH-USER-UUID-HERE',
--     'Your Name',
--     'your@email.com',
--     r.id
-- from public.roles r
-- where r.name = 'super_admin'
-- on conflict (id) do update
-- set role_id = excluded.role_id,
--     active = true;
