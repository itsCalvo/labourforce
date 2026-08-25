-- ============================================================
-- THE LABOUR FORCE — ATTENDANCE VERIFICATION + SUPERVISOR PORTAL
-- Run once in the Supabase SQL Editor.
-- Idempotent: safe to re-run. Non-destructive: adds only.
--
-- Adds to public.attendance:
--   verification_status  'unverified' | 'verified'
--   verified_by          auth user who verified
--   verified_at          when it was verified
-- and enforces at the DATABASE level that only authorised roles
-- (attendance.approve permission, or super_admin / administrator /
-- accounts) may change verification state — even if a modified
-- browser client tries to bypass the UI.
-- ============================================================

-- 1) Verification columns -------------------------------------------------
alter table public.attendance
  add column if not exists verification_status text not null default 'unverified';

alter table public.attendance
  add column if not exists verified_by uuid references auth.users(id);

alter table public.attendance
  add column if not exists verified_at timestamptz;

create index if not exists attendance_verification_idx
  on public.attendance(verification_status);

create index if not exists attendance_date_worker_idx
  on public.attendance(attendance_date desc, worker_id);

-- 2) Who may verify? -------------------------------------------------------
create or replace function public.can_verify_attendance()
returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_permission('attendance.approve')
    or exists (
      select 1
      from public.profiles p
      join public.roles r on r.id = p.role_id
      where p.id = auth.uid()
        and p.active
        and r.name in ('super_admin','administrator','accounts')
    );
$$;

grant execute on function public.can_verify_attendance() to authenticated;

-- 3) Trigger guard ---------------------------------------------------------
-- Blocks ANY change to the verification columns by callers without the
-- verify permission (RLS alone cannot do column-level checks). Also fills
-- verified_by / verified_at automatically when a record is marked verified.
create or replace function public.guard_attendance_verification()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.verification_status is distinct from old.verification_status)
     or (new.verified_by is distinct from old.verified_by)
     or (new.verified_at is distinct from old.verified_at) then
    if not public.can_verify_attendance() then
      raise exception 'Not authorized to change attendance verification';
    end if;
    if new.verification_status = 'verified' then
      new.verified_by := coalesce(new.verified_by, auth.uid());
      new.verified_at := coalesce(new.verified_at, now());
    else
      -- reverting to unverified clears the audit trail fields
      new.verified_by := null;
      new.verified_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_verification_guard on public.attendance;
create trigger attendance_verification_guard
before update on public.attendance
for each row execute function public.guard_attendance_verification();

-- 4) Supervisor portal support --------------------------------------------
-- The portal reads workers through workers_public (no rates exposed).
-- Ensure it is readable and that supervisors can read their assignments.
grant select on public.workers_public to authenticated;
grant select on public.supervisor_assignments to authenticated;

-- Attendance RLS already allows capture-capable users to read/write rows in
-- their scope (see casualpay_attendance.sql policies). No policy changes are
-- required here; the trigger above is the additional verification boundary.

-- 5) OPTIONAL: fast worker name search -------------------------------------
-- With a few thousand workers the LIMIT-10 ilike search is fine without
-- indexes. For very large rosters enable pg_trgm:
--
-- create extension if not exists pg_trgm;
-- create index if not exists workers_name_trgm_idx
--   on public.workers using gin (full_name gin_trgm_ops);
-- create index if not exists workers_id_number_trgm_idx
--   on public.workers using gin (id_number gin_trgm_ops);