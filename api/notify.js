const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');
const { createHash } = require('node:crypto');

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function cairoDate() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
function findAlerts(state) {
  const today = cairoDate();
  const expenses = Array.isArray(state.expenses) ? state.expenses : [];
  const payments = Array.isArray(state.lessonPayments) ? state.lessonPayments : [];
  const total = expenses.reduce((n, x) => n + (Number(x.amount) || 0), 0) + payments.reduce((n, x) => n + (Number(x.amount) || 0), 0);
  const alerts = [];
  const budget = Number(state.budget) || 0;
  if (budget > 0 && total > budget) alerts.push({ key: `budget-over:${today}`, title: 'تنبيه: تجاوز الميزانية', body: `تجاوز إجمالي إنفاقك ميزانيتك المحددة. راجع ملخص الميزانية في الموقع.` });
  else if (budget > 0 && total >= budget * 0.8) alerts.push({ key: `budget-near:${today}`, title: 'تنبيه: اقتربت من حد الميزانية', body: `وصل إنفاقك إلى 80٪ أو أكثر من الميزانية المحددة. راجع الملخص في الموقع.` });
  const limits = state.subBudgets || {};
  for (const category of ['مواصلات', 'أكل', 'مستلزمات', 'دروس', 'أخرى']) {
    const rawLimit = limits[category];
    const limit = Number(rawLimit) || 0;
    const spent = expenses.filter((x) => x.category === category).reduce((n, x) => n + (Number(x.amount) || 0), 0);
    if (limit > 0 && spent >= limit) alerts.push({ key: `category-over:${category}:${today}`, title: `تنبيه: حد «${category}»`, body: `بلغ إنفاقك حد التصنيف أو تجاوزه. راجع التفاصيل في الموقع.` });
    else if (limit > 0 && spent >= limit * 0.8) alerts.push({ key: `category-near:${category}:${today}`, title: `تنبيه: اقترب حد «${category}»`, body: `اقترب إنفاقك من الحد الذي حددته. راجع التفاصيل في الموقع.` });
  }
  for (const note of (Array.isArray(state.notes) ? state.notes : [])) {
    if (note.date && note.date <= today) alerts.push({ key: `note:${note.id}:${note.date}`, title: note.date < today ? 'تذكير متأخر' : 'تذكير اليوم', body: `لديك تذكير مستحق: ${String(note.title || 'مذكرة').slice(0, 120)}.` });
  }
  return alerts.slice(0, 10);
}
function isTrustedPushEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.apple.com');
  } catch (_) { return false; }
}
function emailHtml(title, body, appUrl) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body style="margin:0;background:#f1f5f9;font-family:Arial,Tahoma,sans-serif;direction:rtl;color:#0f172a"><div style="max-width:600px;margin:32px auto;padding:0 14px"><div style="background:linear-gradient(135deg,#064e3b,#312e81);border-radius:20px 20px 0 0;padding:24px;color:#fff"><div style="font-size:13px;opacity:.85">محفظتي والدروس الخصوصية</div><h1 style="font-size:22px;margin:12px 0 0">${escapeHtml(title)}</h1></div><div style="background:#fff;border-radius:0 0 20px 20px;padding:26px;box-shadow:0 8px 24px rgba(15,23,42,.08)"><p style="font-size:16px;line-height:1.9;margin:0 0 22px">${escapeHtml(body)}</p><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:12px">فتح لوحة الميزانية</a><p style="font-size:11px;line-height:1.8;color:#64748b;margin:24px 0 0">أُرسل هذا التنبيه لأنك فعّلت إشعارات البريد في حسابك. لا يتضمن البريد مبالغ أو تفاصيل معاملاتك. يمكنك إيقاف الرسائل من نافذة التنبيهات داخل الموقع.</p></div><div style="text-align:center;color:#94a3b8;font-size:11px;padding:14px">رسالة آلية من تطبيق محفظتي</div></div></body></html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, private');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const bearer = req.headers.authorization || '';
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'يلزم تسجيل الدخول.' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'إعدادات الخادم غير مكتملة.' });
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { data: authData, error: authError } = await db.auth.getUser(token);
    const user = authData?.user;
    if (authError || !user) return res.status(401).json({ error: 'جلسة الدخول غير صالحة.' });
    const { data: row, error: stateError } = await db.from('app_data').select('state').eq('user_id', user.id).maybeSingle();
    if (stateError) throw stateError;
    const state = row?.state || {};
    const alerts = findAlerts(state);
    const emailEnabled = state.notificationSettings?.emailEnabled === true && Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.APP_URL && user.email);
    const pushEnabled = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT && process.env.APP_URL);
    let subscriptions = [];
    if (pushEnabled) {
      const { data, error } = await db.from('push_subscriptions').select('endpoint,subscription').eq('user_id', user.id);
      if (error) throw error;
      subscriptions = (data || []).filter((item) => isTrustedPushEndpoint(item.endpoint));
      webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    }
    if (!alerts.length || (!emailEnabled && (!pushEnabled || !subscriptions.length))) return res.status(200).json({ processed: 0 });

    const appUrl = (process.env.APP_URL || 'https://example.vercel.app').replace(/\/$/, '');
    let emailCount = 0;
    if (emailEnabled) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count, error } = await db.from('app_notification_events').select('event_key', { count: 'exact', head: true }).eq('user_id', user.id).gte('email_sent_at', since);
      if (error) throw error;
      emailCount = count || 0;
    }
    let processed = 0;
    for (const alert of alerts) {
      let { data: event, error: eventError } = await db.from('app_notification_events').select('user_id,event_key,email_sent_at,push_sent_at').eq('user_id', user.id).eq('event_key', alert.key).maybeSingle();
      if (eventError) throw eventError;
      if (!event) {
        const inserted = await db.from('app_notification_events').insert({ user_id: user.id, event_key: alert.key }).select('user_id,event_key,email_sent_at,push_sent_at').maybeSingle();
        if (inserted.error?.code === '23505') continue;
        if (inserted.error) throw inserted.error;
        event = inserted.data;
      }
      let emailSent = Boolean(event.email_sent_at);
      let pushSent = Boolean(event.push_sent_at);
      const errors = [];
      if (emailEnabled && !emailSent && emailCount < 8) {
        try {
          const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': createHash('sha256').update(`${user.id}:${alert.key}`).digest('hex') },
            body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [user.email], subject: alert.title, html: emailHtml(alert.title, alert.body, appUrl) })
          });
          if (!response.ok) throw new Error(`Resend rejected email (${response.status})`);
          emailSent = true;
          emailCount += 1;
        } catch (error) { errors.push(`email: ${error.message}`); }
      }
      let deliveredPushCount = 0;
      if (pushEnabled && !pushSent && subscriptions.length) {
        for (const item of subscriptions) {
          try {
            await webpush.sendNotification(item.subscription, JSON.stringify({ title: alert.title, body: alert.body, url: appUrl, tag: alert.key }));
            deliveredPushCount += 1;
          } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) await db.from('push_subscriptions').delete().eq('user_id', user.id).eq('endpoint', item.endpoint);
            else errors.push(`push: ${error.message}`);
          }
        }
        pushSent = deliveredPushCount > 0 || !errors.some((x) => x.startsWith('push:'));
      }
      const { error: updateError } = await db.from('app_notification_events').update({ email_sent_at: emailSent ? new Date().toISOString() : null, push_sent_at: pushSent ? new Date().toISOString() : null, last_error: errors.join('; ').slice(0, 500) || null }).eq('user_id', user.id).eq('event_key', alert.key);
      if (updateError) throw updateError;
      processed += 1;
    }
    return res.status(200).json({ processed });
  } catch (error) {
    console.error('Notification dispatch failed:', error);
    return res.status(500).json({ error: 'تعذر إرسال التنبيه الآن.' });
  }
};
