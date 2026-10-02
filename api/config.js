module.exports = async function handler(_req, res) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const config = {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
    emailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.APP_URL),
    notificationApiConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    pushConfigured: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT && process.env.APP_URL)
  };
  res.status(200).send(`window.APP_CONFIG = ${JSON.stringify(config)};`);
};
