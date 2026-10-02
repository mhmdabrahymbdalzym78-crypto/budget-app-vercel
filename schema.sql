-- Run once in Supabase SQL Editor.
create table if not exists public.app_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists public.app_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Only the service-role-backed Vercel function and the project owner manage admins.
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_access_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  action text not null,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, endpoint)
);

create table if not exists public.app_notification_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null,
  email_sent_at timestamptz,
  push_sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  primary key (user_id, event_key)
);

create or replace function public.sync_app_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.app_users (user_id, email, created_at)
  values (new.id, new.email, coalesce(new.created_at, now()))
  on conflict (user_id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_sync_profile on auth.users;
create trigger on_auth_user_created_sync_profile
after insert or update of email on auth.users
for each row execute procedure public.sync_app_user_profile();

-- Backfill existing accounts if this schema is added after users already registered.
insert into public.app_users (user_id, email, created_at)
select id, email, created_at from auth.users
on conflict (user_id) do update set email = excluded.email;

alter table public.app_users enable row level security;
alter table public.app_data enable row level security;
alter table public.app_admins enable row level security;
alter table public.admin_access_logs enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.app_notification_events enable row level security;

-- A signed-in user may read only their own profile and personal app data.
drop policy if exists "users read own profile" on public.app_users;
create policy "users read own profile" on public.app_users
for select to authenticated using (auth.uid() = user_id);

drop policy if exists "users read own app data" on public.app_data;
create policy "users read own app data" on public.app_data
for select to authenticated using (auth.uid() = user_id);

drop policy if exists "users insert own app data" on public.app_data;
create policy "users insert own app data" on public.app_data
for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "users update own app data" on public.app_data;
create policy "users update own app data" on public.app_data
for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Users may manage only their own browser push endpoints. The server sends pushes via service_role.
drop policy if exists "users manage own push subscriptions" on public.push_subscriptions;
create policy "users manage own push subscriptions" on public.push_subscriptions
for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- No policies are granted to normal users on admin roles, audit logs, or dispatch deduplication records.
revoke all on public.app_admins from anon, authenticated;
revoke all on public.admin_access_logs from anon, authenticated;
revoke all on public.app_notification_events from anon, authenticated;
revoke all on public.app_users from anon;
revoke all on public.app_data from anon;
revoke all on public.push_subscriptions from anon;

grant select on public.app_users to authenticated;
grant select, insert, update on public.app_data to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant all on public.app_users, public.app_data, public.app_admins, public.admin_access_logs, public.push_subscriptions, public.app_notification_events to service_role;
grant usage, select on sequence public.admin_access_logs_id_seq to service_role;
