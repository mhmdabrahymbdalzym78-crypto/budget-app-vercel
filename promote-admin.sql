-- Run after the owner account has been created and email-confirmed in Supabase Auth.
-- This grants full access to user records through the server-verified admin dashboard.
insert into public.app_admins (user_id)
select id
from auth.users
where lower(email) = lower('amhmdabrahymbdalzym@gmail.com')
on conflict (user_id) do nothing;
