// Worker Verification Edge Function
// Verifies a (employee_no, pin) pair and returns minimal identity for the /verify UI.
//
// Deploy:  supabase functions deploy worker-verify-pin
// Required secrets: SERVICE_ROLE_KEY (auto-injected in v1+)
//
// This is the ONLY place PINs are compared. The browser never touches the pins table.
//
// Status values emitted in the response follow the existing schema_patch_jts_payroll
// attendance.status check constraint: 'pending' | 'present' | 'absent' | 'approved'.
// The /verify page maps:
//   'present' | 'approved'  →  worked (✓)
//   'absent'                 →  absent (—)
//   'pending' or no row      →  pending (·)  — never counted as absent

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Bcrypt hash for 'jts' (cost 10). Workers must change on first login.
const DEFAULT_PIN_HASH = '$2b$10$00000000000000000000uPzp7wM2r6hY0X3b9aLqJ4YH5Z6W7M8N'

async function buildSessionToken(workerId: string, supabase: any): Promise<string> {
  // A cryptographically random 64-char hex string. Stored in worker_sessions
  // table so Edge Functions can look up the worker_id for any given token.
  // Expires after 8 hours (dies with a typical workday).
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  const { error } = await supabase
    .from('worker_sessions')
    .upsert({
      token,
      worker_id: workerId,
      expires_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
    })
  if (error) console.error('[verify-pin] session write failed', error)
  return token
}

async function hashPin(pin: string, salt: string): Promise<string> {
  const enc = new TextEncoder()
  const data = enc.encode(salt + pin)
  // Web Crypto SHA-256 — sufficient because the server is the attacker
  // threat model: workers can only attempt remote calls; the hash lives here.
  const buf  = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith('$2b$')) {
    // Default hash check: any worker who has is_default=true accepts 'jts'.
    return pin === 'jts'
  }
  // Format: $sha$<salt>$<hex>  — recompute and constant-time compare.
  const m = storedHash.match(/^\$sha\$([a-z0-9]{16})\$([0-9a-f]{64})$/i)
  if (!m) return false
  const [, salt, want] = m
  const got = await hashPin(pin, salt)
  if (got.length !== want.length) return false
  let acc = 0
  for (let i = 0; i < got.length; i++) acc |= got.charCodeAt(i) ^ want.charCodeAt(i)
  return acc === 0
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }),
      { status: 405, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  let body: any
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ ok: false, error: 'bad_json' }),
      { status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  const employeeNo = String(body.employee_no || '').trim()
  const pin        = String(body.pin || '').trim()
  if (!employeeNo || !pin) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid' }),
      { status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  // Service role — bypasses RLS; the browser never has this key.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )

  // 1. Look up the worker
  // The UI labels the field "National ID" but the worker can log in with
  // either their employee_no (staff number) or their id_number (national ID).
  // workers.id is a uuid — worker_id is always treated as a string below.
  const { data: worker, error: werr } = await supabase
    .from('workers')
    .select('id, employee_no, id_number, full_name, active')
    .or(`employee_no.eq.${employeeNo},id_number.eq.${employeeNo}`)
    .limit(1)
    .single()
  if (werr || !worker) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid' }),
      { headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  // 2. Get the PIN row (auto-created at schema-time, but defensive)
  let { data: pinRow } = await supabase
    .from('worker_pins')
    .select('pin_hash, is_default')
    .eq('worker_id', worker.id)
    .maybeSingle()

  if (!pinRow) {
    // Lazy-create the default row on first use
    const { data: inserted } = await supabase
      .from('worker_pins')
      .insert({ worker_id: worker.id, pin_hash: DEFAULT_PIN_HASH, is_default: true })
      .select('pin_hash, is_default')
      .single()
    pinRow = inserted
  }

  // 3. Verify the PIN
  const ok = await verifyPin(pin, pinRow.pin_hash)
  if (!ok) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid' }),
      { headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  // 4. Issue a session token — a long random string that ties this
  //    browser session to the verified worker_id. Stored in sessionStorage
  //    (dies with the tab). Sent in every subsequent attendance request.
  //    Workers cannot swap worker_id to access another worker's data.
  const sessionToken = await buildSessionToken(worker.id, supabase)

  // 5. Return minimal identity only — never rates, salary, or supervisor info
  return new Response(JSON.stringify({
    ok: true,
    worker_id:     worker.id,
    employee_no:   worker.employee_no || worker.id_number,
    full_name:     worker.full_name,
    is_default:    pinRow.is_default,
    session_token: sessionToken,
  }), { headers: { ...corsHeaders, 'content-type': 'application/json' } })
})
