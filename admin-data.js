const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Vary', 'Authorization');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'يلزم تسجيل الدخول.' });

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return res.status(500).json({ error: 'إعدادات الخادم غير مكتملة.' });
  const adminClient = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);
    const user = authData && authData.user;
    if (authError || !user) return res.status(401).json({ error: 'جلسة الدخول غير صالحة.' });

    const { data: adminRole, error: roleError } = await adminClient.from('app_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (roleError) throw roleError;
    if (req.query?.mode === 'status') return res.status(200).json({ isAdmin: Boolean(adminRole) });
    if (!adminRole) return res.status(403).json({ error: 'هذا الحساب لا يملك صلاحية المتحكم.' });

    // Record every authorized data-access request before reading the records.
    const { error: auditError } = await adminClient.from('admin_access_logs').insert({
      actor_user_id: user.id,
      actor_email: user.email || null,
      action: 'view_all_user_records',
      ip_address: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null,
      user_agent: req.headers['user-agent'] || null
    });
    if (auditError) throw auditError; // Fail closed: no data is returned if auditing fails.

    const users = [];
    const pageSize = 500;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await adminClient.from('app_users').select('user_id,email,created_at').order('created_at', { ascending: false }).range(from, from + pageSize - 1);
      if (error) throw error;
      users.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    const appData = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await adminClient.from('app_data').select('user_id,state,updated_at').order('updated_at', { ascending: false }).range(from, from + pageSize - 1);
      if (error) throw error;
      appData.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    const byUser = new Map(appData.map((row) => [row.user_id, row]));
    return res.status(200).json({
      users: users.map((profile) => {
        const row = byUser.get(profile.user_id);
        return { user_id: profile.user_id, email: profile.email, created_at: profile.created_at, updated_at: row?.updated_at || null, state: row?.state || null };
      })
    });
  } catch (error) {
    console.error('Admin data request failed:', error);
    return res.status(500).json({ error: 'تعذر تحميل البيانات أو تسجيل عملية الاطلاع.' });
  }
};
