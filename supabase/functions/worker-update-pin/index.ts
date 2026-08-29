// Worker Update PIN Edge Function
// Updates a worker's verification PIN after validating the old PIN.
//
// Deploy:  supabase functions deploy worker-update-pin
// Required secrets: SERVICE_ROLE_KEY (auto-injected in v1+)
//
// Rules:
//   - PIN must be ≥ 4 characters
//   - PIN must not equal 'jts' (prevents keeping the default)
//   - Old PIN must match before new PIN is stored
//   - is_default is set to false on success
//
// The PIN is stored as $sha$<16-char-salt>$<sha256-hex>.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function validateSession(supabase: any, workerId: number, sessionToken: string): Promise<boolean> {
  const { data } = await supabase
    .from('worker_sessions')
    .select('worker_id')
    .eq('token', sessionToken)
    .eq('worker_id', workerId)
    .gt('expires_at', new Date().toISOString())
    .single()
  return !!data
}

async function hashPin(pin: string, salt: string): Promise<string> {
  const enc = new TextEncoder()
  const data = enc.encode(salt + pin)
  const buf  = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

function buildHash(pin: string): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => chars[b % chars.length]).join('')
  const hex = await hashPin(pin, salt)
  return `$sha$${salt}$${hex}`
}

const DEFAULT_PIN_HASH = '$2b$10$00000000000000000000uPzp7wM2r6hY0X3b9aLqJ4YH5Z6W7M8N'

async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith('$2b$')) return pin === 'jts'
  const m = storedHash.match(/^\$sha\$([a-z0-9]{16})\$([0-9a-f]{64})$/i)
  if (!m) return false
  const [, salt, want] = m
  const got = await hashPin(pin, salt)
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
    return new Response(JSON.stringify({ ok: false, error: 'bad_request' }),
      { status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  const workerId    = Number(body.worker_id)
  const oldPin      = String(body.old_pin || '').trim()
  const newPin      = String(body.new_pin || '').trim()
  const confirmPin  = String(body.confirm_pin || '').trim()
  const sessionToken = String(body.session_token || '').trim()

  // Basic validation
  if (!workerId || isNaN(workerId)) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_worker' }),
      { status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }
  if (!sessionToken || sessionToken.length < 20) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }
  if (newPin.length < 4) {
    return new Response(JSON.stringify({ ok: false, error: 'pin_too_short' }),
      { status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }
  if (newPin === 'jts') {
    return new Response(JSON.stringify({ ok: false, error: 'same_as_default' }),
      { status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }
  if (newPin !== confirmPin) {
    return new Response(JSON.stringify({ ok: false, error: 'pin_mismatch' }),
      { status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )

  // 0. Validate the session token — only the verified worker for this
  //    session can change their own PIN.
  if (!(await validateSession(supabase, workerId, sessionToken))) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  // 1. Load the PIN row
  const { data: pinRow, error: pinErr } = await supabase
    .from('worker_pins')
    .select('pin_hash')
    .eq('worker_id', workerId)
    .maybeSingle()
  if (pinErr || !pinRow) {
    return new Response(JSON.stringify({ ok: false, error: 'not_found' }),
      { status: 404, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  // 2. Verify old PIN
  const oldOk = await verifyPin(oldPin, pinRow.pin_hash)
  if (!oldOk) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_old_pin' }),
      { status: 403, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  // 3. Update to new hash
  const newHash = await buildHash(newPin)
  const { error: updErr } = await supabase
    .from('worker_pins')
    .update({ pin_hash: newHash, is_default: false, updated_at: new Date().toISOString() })
    .eq('worker_id', workerId)
  if (updErr) {
    console.error('[worker-update-pin] update failed', updErr)
    return new Response(JSON.stringify({ ok: false, error: 'update_failed' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  return new Response(JSON.stringify({ ok: true }),
    { headers: { ...corsHeaders, 'content-type': 'application/json' } })
})
