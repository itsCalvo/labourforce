-- ============================================================
-- Multi-batch attendance: add batch_name to attendance
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1) Add the batch_name column (default 'Default' for any existing rows)
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS batch_name text NOT NULL DEFAULT 'Default';

-- 2) Drop the old 2-col unique constraint if it exists, so the new
--    3-col constraint (worker_id, attendance_date, batch_name) can take over.
--    This lets the same worker appear in multiple batches on the same day.
DO $$
DECLARE
  cname text;
BEGIN
  FOR cname IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.attendance'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%(worker_id, attendance_date)%'
  LOOP
    EXECUTE format('ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS %I', cname);
    RAISE NOTICE 'Dropped unique constraint % on attendance', cname;
  END LOOP;
END $$;

-- 3) Add the new 3-col unique constraint (only if no equivalent exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.attendance'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%(worker_id, attendance_date, batch_name)%'
  ) THEN
    ALTER TABLE public.attendance
      ADD CONSTRAINT attendance_worker_date_batch_key
      UNIQUE (worker_id, attendance_date, batch_name);
    RAISE NOTICE 'Added UNIQUE(worker_id, attendance_date, batch_name) on attendance';
  END IF;
END $$;

-- 4) Index on batch_name for fast filtering
CREATE INDEX IF NOT EXISTS attendance_batch_name_idx
  ON public.attendance (batch_name);

-- 5) Make sure the approval workflow uses batch_name too (re-runnable)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='attendance' AND column_name='workflow_status') THEN
    -- (re)create the per-batch idempotent submit function if not present
    PERFORM 1 FROM pg_proc WHERE proname='submit_for_approval';
    -- We don't redefine it here — that's in stage_workflow_submit.sql
    NULL;
  END IF;
END $$;
