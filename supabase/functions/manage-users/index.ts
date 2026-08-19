import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Missing authorization header' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userError } = await callerClient.auth.getUser();
  if (userError || !user) return json({ error: 'Unauthenticated' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: callerProfile, error: callerProfileError } = await admin
    .from('profiles')
    .select('id,full_name,active,role_id,roles(name)')
    .eq('id', user.id)
    .maybeSingle();

  if (callerProfileError || !callerProfile?.active) return json({ error: 'Labour Force profile is inactive or missing' }, 403);
  const callerRole = callerProfile.roles?.name || '';
  const canManage = callerRole === 'super_admin' || callerRole === 'administrator';
  if (!canManage) return json({ error: 'You do not have permission to manage users' }, 403);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const action = payload?.action;
  const targetId = payload?.user_id;

  if (action === 'create') {
    const fullName = String(payload.full_name || '').trim();
    const email = String(payload.email || '').trim().toLowerCase();
    const password = String(payload.password || '');
    const roleId = String(payload.role_id || '');
    const phone = String(payload.phone || '').trim() || null;
    const active = payload.active !== false;

    if (!fullName || !email || !password || password.length < 8 || !roleId) {
      return json({ error: 'Name, email, role and an 8+ character password are required' }, 400);
    }

    const { data: role, error: roleError } = await admin.from('roles').select('id,name').eq('id', roleId).maybeSingle();
    if (roleError || !role) return json({ error: 'Invalid role' }, 400);
    if (role.name === 'super_admin' && callerRole !== 'super_admin') {
      return json({ error: 'Only a super admin can create another super admin' }, 403);
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createError || !created.user) return json({ error: createError?.message || 'Could not create Auth user' }, 400);

    const { error: profileError } = await admin.from('profiles').insert({
      id: created.user.id,
      full_name: fullName,
      email,
      phone,
      role_id: roleId,
      active,
    });

    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);
      return json({ error: profileError.message }, 400);
    }

    await admin.from('audit_logs').insert({
      user_id: user.id,
      action: 'user.created',
      table_name: 'profiles',
      record_id: created.user.id,
      old_data: null,
      new_data: { full_name: fullName, email, role: role.name, active },
      metadata: { source: 'labour-force-user-centre', target_user_id: created.user.id },
    });

    return json({ ok: true, user_id: created.user.id });
  }

  if (action === 'update') {
    if (!targetId) return json({ error: 'user_id is required' }, 400);
    if (targetId === user.id) return json({ error: 'You cannot change your own role or status from User Management' }, 400);

    const { data: target, error: targetError } = await admin
      .from('profiles')
      .select('id,full_name,email,phone,active,role_id,roles(name)')
      .eq('id', targetId)
      .maybeSingle();
    if (targetError || !target) return json({ error: 'Target user not found' }, 404);

    const roleId = String(payload.role_id || target.role_id);
    const { data: role, error: roleError } = await admin.from('roles').select('id,name').eq('id', roleId).maybeSingle();
    if (roleError || !role) return json({ error: 'Invalid role' }, 400);

    const oldRole = target.roles?.name || '';
    if ((oldRole === 'super_admin' || role.name === 'super_admin') && callerRole !== 'super_admin') {
      return json({ error: 'Only a super admin can change access to or from super admin' }, 403);
    }

    const fullName = String(payload.full_name ?? target.full_name).trim();
    const email = String(payload.email ?? target.email ?? '').trim().toLowerCase();
    const phone = String(payload.phone ?? target.phone ?? '').trim() || null;
    const active = payload.active !== false;

    const { error: authUpdateError } = await admin.auth.admin.updateUserById(targetId, {
      email,
      user_metadata: { full_name: fullName },
    });
    if (authUpdateError) return json({ error: authUpdateError.message }, 400);

    const { error: profileUpdateError } = await admin.from('profiles').update({
      full_name: fullName,
      email,
      phone,
      role_id: roleId,
      active,
    }).eq('id', targetId);
    if (profileUpdateError) return json({ error: profileUpdateError.message }, 400);

    await admin.from('audit_logs').insert({
      user_id: user.id,
      action: 'user.access_changed',
      table_name: 'profiles',
      record_id: targetId,
      old_data: { full_name: target.full_name, email: target.email, role: oldRole, active: target.active },
      new_data: { full_name: fullName, email, role: role.name, active },
      metadata: { source: 'labour-force-user-centre', target_user_id: targetId },
    });

    return json({ ok: true, user_id: targetId });
  }

  return json({ error: 'Unknown action' }, 400);
});
