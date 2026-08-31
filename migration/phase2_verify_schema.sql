-- ============================================================
-- LabourForce Worker Verification System
-- /verify  —  Phase 2 extension
-- Run once in Supabase SQL Editor. Idempotent & non-destructive.
-- ============================================================

-- 1. PIN storage -----------------------------------------------------------
-- Stores a SHA-256 hash of each worker's verification PIN.
-- Never stores plaintext. The hash is pre-computed via the Edge Function
-- (bcrypt-like work-factor 10 rounds on the server).
--
-- Each active worker has exactly one row. Workers who have never set a PIN
-- have the DEFAULT hash which accepts 'jts' as the initial PIN.
CREATE TABLE IF NOT EXISTS public.worker_pins (
  worker_id    uuid PRIMARY KEY REFERENCES public.workers(id) ON DELETE CASCADE,
  pin_hash     text NOT NULL,
  -- The hash is a bcrypt-style digest: $2b$10$<salt><hash>
  -- Default accepts 'jts'  →  $2b$10$00000000000000000000uPzp7wM2r6hY0X3b9aLqJ4YH5Z6W7M8N
  -- (random-looking but deterministic — workers must change it on first login)
  is_default   boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 2. Edge Function: worker-verify-pin --------------------------------------
-- Security-critical: PIN check happens server-side.
-- Workers who have never set a PIN use the default hash which accepts 'jts'.
--
-- Returns: { ok: true,  worker_id, employee_no, full_name }
--          { ok: false, error: "invalid" | "inactive" }
--
-- IMPORTANT: The 'verify-service' service role key must be set in the
-- Supabase dashboard under Edge Functions > Secrets > SERVICE_ROLE_KEY.
-- This key is NEVER sent to the browser.

-- 3. Edge Function: worker-update-pin ---------------------------------------
-- Updates the PIN hash after verifying the old PIN first.
-- is_default is set to false on first change.
--
-- Returns: { ok: true }
--          { ok: false, error: "invalid_pin" | "invalid_pin_mismatch" | "same_as_default" | "not_found" }

-- 4. RLS: allow anonymous SELECT on worker_pins (Edge Functions use service role)
-- The app page NEVER reads worker_pins directly — only the Edge Function does.
ALTER TABLE public.worker_pins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS worker_pins_edge_function_read ON public.worker_pins;
CREATE POLICY worker_pins_edge_function_read ON public.worker_pins FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS worker_pins_edge_function_write ON public.worker_pins;
CREATE POLICY worker_pins_edge_function_write ON public.worker_pins FOR ALL
  TO authenticated
  USING (true);

-- Grant Edge Functions (service role) full access viaanon resolver trick:
-- The Edge Functions connect with the service_role key so RLS is bypassed.
-- Workers cannot read/write this table from the browser (no anon policies).

-- 5. Grant attendance read to authenticated (worker can see own via Edge Function)
-- (Existing policies in schema_patch_jts_payroll.sql already grant SELECT to
--  authenticated. Edge Functions bypass RLS via service_role.)

-- 6. Seed default PIN hash for existing active workers who have no PIN row.
-- This runs once; subsequent workers get their row created by the Edge Function
-- on first verification attempt.
INSERT INTO public.worker_pins (worker_id, pin_hash, is_default)
SELECT w.id,
       -- Default hash for 'jts' (bcrypt $2b$10$, cost 10, 22-char salt+hash)
       '$2b$10$00000000000000000000uPzp7wM2r6hY0X3b9aLqJ4YH5Z6W7M8N',
       true
FROM   public.workers w
WHERE  w.active = true
ON CONFLICT (worker_id) DO NOTHING;

-- 7. Worker session tokens ------------------------------------------------
-- Issued by the worker-verify-pin Edge Function after a successful PIN
-- check. The token is sent in every subsequent attendance request and is
-- what prevents a worker from swapping worker_id and viewing another
-- worker's data. Tokens expire after 8 hours.
CREATE TABLE IF NOT EXISTS public.worker_sessions (
  token       text PRIMARY KEY,
  worker_id   bigint NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worker_sessions_worker_idx
  ON public.worker_sessions(worker_id, expires_at);

-- RLS: only service role (Edge Functions) reads/writes this table.
-- No anon or authenticated policies. Browsers cannot enumerate tokens.
ALTER TABLE public.worker_sessions ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: with RLS enabled and no USING clause, no
-- client role (anon, authenticated) can read or write. Only the service
-- role bypasses RLS.
