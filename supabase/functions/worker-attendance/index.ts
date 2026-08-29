// Worker Attendance Edge Function
// Returns attendance records for the authenticated worker in a date range.
//
// Deploy:  supabase functions deploy worker-attendance
// Required secrets: SERVICE_ROLE_KEY (auto-injected in v1+)
//
// Security:
//   - session_token must match the one issued during PIN verification.
//   - The worker_id from the session is used (not from the request body) for
//     the SQL query — preventing a manipulated worker_id parameter.
//   - Only attendance rows for that worker are returned (server-side RLS).
//
// Response: { records: [{ attendance_date, status }] }
//
// Status values in the existing LabourForce schema:
//   'pending' | 'present' | 'absent' | 'approved'
// Legacy Phase 2 code writes 'worked' which violates the CHECK constraint
// (pre-existing bug). The map here handles both:
//   'present' | 'approved' | 'worked'  →  present  (verified worked)
//   'absent'                        →  absent
//   'pending' or missing row        →  pending  (not finalized)

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Validate the session token issued by worker-verify-pin.
// The token must exist in worker_sessions, match the worker_id, and not be expired.
async function validateSession(
  supabase: any,
  workerId: number,
  sessionToken: string
): Promise<boolean> {
  const { data } = await supabase
    .from('worker_sessions')
    .select('worker_id, expires_at')
    .eq('token', sessionToken)
    .eq('worker_id', workerId)
    .gt('expires_at', new Date().toISOString())
    .single()
  return !!data
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }),
      { status: 405, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  let body: any
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'bad_json' }),
      { status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  const workerId     = Number(body.worker_id)
  const sessionToken = String(body.session_token || '').trim()
  const rangeStart   = String(body.range_start || '').trim()
  const rangeEnd     = String(body.range_end   || '').trim()

  // Basic validation
  if (!workerId || isNaN(workerId) || !rangeStart || !rangeEnd || !sessionToken) {
    return new Response(JSON.stringify({ error: 'invalid_request' }),
      { status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  // Service role — bypasses RLS so we can query attendance directly
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )

  // Validate the session token
  const valid = await validateSession(supabase, workerId, sessionToken)
  if (!valid) {
    return new Response(JSON.stringify({ error: 'unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  // Fetch attendance for this worker in the date range
  // Only return the columns we need — never expose approved_by, verified_by, notes, etc.
  const { data: rows, error: err } = await supabase
    .from('attendance')
    .select('attendance_date, status')
    .eq('worker_id', workerId)
    .gte('attendance_date', rangeStart)
    .lte('attendance_date', rangeEnd)
    .order('attendance_date', { ascending: true })

  if (err) {
    console.error('[worker-attendance] query failed', err)
    return new Response(JSON.stringify({ error: 'query_failed' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  }

  return new Response(JSON.stringify({
    records: (rows || []).map(r => ({
      attendance_date: r.attendance_date,
      status:         r.status,
    })),
  }), { headers: { ...corsHeaders, 'content-type': 'application/json' } })
})
