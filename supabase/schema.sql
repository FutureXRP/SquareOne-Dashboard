-- SquareOne — Supabase schema (multi-account, roles, audit, OKDHS imports)
-- Review before running. Apply in the Supabase SQL editor (or via the CLI).
-- Secrets (vendor API keys/tokens) do NOT live in user-readable tables — they
-- stay in Vercel env vars; only the token_cache (service-role only) is here.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
do $$ begin
  create type app_role as enum ('admin', 'manager', 'staff');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Locations (multi-site ready)
-- ---------------------------------------------------------------------------
create table if not exists locations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Profiles — one row per auth user (auto-created on signup via trigger below)
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  created_at  timestamptz not null default now()
);

-- A user's role at a given location (multi-location access).
create table if not exists user_locations (
  user_id     uuid not null references auth.users(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  role        app_role not null default 'staff',
  primary key (user_id, location_id)
);

-- ---------------------------------------------------------------------------
-- Non-secret per-location integration config (which providers are enabled,
-- entity mappings, etc.). API keys are NOT stored here.
-- ---------------------------------------------------------------------------
create table if not exists integration_config (
  location_id uuid not null references locations(id) on delete cascade,
  provider    text not null,                  -- 'homeassistant' | 'amilia' | 'hik' | 'procare' | 'okdhs'
  enabled     boolean not null default false,
  config      jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (location_id, provider)
);

-- ---------------------------------------------------------------------------
-- Audit log — who did what (device actions, imports, logins)
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete set null,
  location_id uuid references locations(id) on delete set null,
  action      text not null,                  -- e.g. 'door.lock', 'alarm.disarm', 'okdhs.import'
  target      text,                           -- e.g. 'lock.main_entrance'
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- OKDHS report imports (manual export -> upload -> parsed rows)
-- File itself goes in Supabase Storage; this holds metadata + parsed data.
-- ---------------------------------------------------------------------------
create table if not exists okdhs_imports (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references locations(id) on delete cascade,
  uploaded_by   uuid references auth.users(id) on delete set null,
  storage_path  text not null,                -- path in the 'okdhs' storage bucket
  period_start  date,
  period_end    date,
  parsed        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Token cache for serverless functions (EZVIZ 7-day token, Amilia JWT, etc.)
-- SERVICE-ROLE ONLY. RLS denies all client access.
-- ---------------------------------------------------------------------------
create table if not exists token_cache (
  provider    text not null,
  scope       text not null default 'default', -- e.g. region or org id
  token       text not null,
  meta        jsonb not null default '{}'::jsonb,  -- e.g. areaDomain
  expires_at  timestamptz not null,
  primary key (provider, scope)
);

-- ---------------------------------------------------------------------------
-- Per-user vendor credentials (each person's own Hik ID, Gemini alarm login,
-- GV-Access login) so device actions are attributed to the real operator in
-- the vendor's own logs — not a shared account. The secret is AES-GCM
-- encrypted by the server (CREDENTIAL_KEY); this table is SERVICE-ROLE ONLY,
-- so even the ciphertext is never exposed to the browser. Managed through
-- /api/me/credentials. Pro1 is excluded — it allows only one login (shared).
-- ---------------------------------------------------------------------------
create table if not exists user_credentials (
  user_id       uuid not null references auth.users(id) on delete cascade,
  provider      text not null,                 -- 'napco' | 'hik' | 'geovision'
  username      text,                          -- vendor user id (not secret)
  secret_cipher text,                          -- AES-GCM ciphertext of the password
  updated_at    timestamptz not null default now(),
  primary key (user_id, provider)
);

-- ---------------------------------------------------------------------------
-- Helper: current user's role at a location
-- ---------------------------------------------------------------------------
create or replace function role_at(loc uuid)
returns app_role language sql stable security definer set search_path = public as $$
  select role from user_locations where user_id = auth.uid() and location_id = loc;
$$;

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_locations where user_id = auth.uid() and role = 'admin');
$$;

-- ---------------------------------------------------------------------------
-- Auto-create a profile row when a user signs up
-- ---------------------------------------------------------------------------
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table profiles            enable row level security;
alter table locations           enable row level security;
alter table user_locations      enable row level security;
alter table integration_config  enable row level security;
alter table audit_log           enable row level security;
alter table okdhs_imports       enable row level security;
alter table token_cache         enable row level security;  -- no policies = service-role only
alter table user_credentials    enable row level security;  -- no policies = service-role only

-- Profiles: a user sees/edits their own; admins see all.
create policy profiles_self on profiles
  for select using (id = auth.uid() or is_admin());
create policy profiles_update_self on profiles
  for update using (id = auth.uid());

-- Locations: visible to users assigned to them (admins see all).
create policy locations_member on locations
  for select using (is_admin() or exists (
    select 1 from user_locations ul where ul.location_id = id and ul.user_id = auth.uid()));

-- user_locations: a user sees their own grants; admins manage all.
create policy ul_self on user_locations
  for select using (user_id = auth.uid() or is_admin());
create policy ul_admin_write on user_locations
  for all using (is_admin()) with check (is_admin());

-- integration_config: members can read; managers/admins can write.
create policy cfg_read on integration_config
  for select using (role_at(location_id) is not null);
create policy cfg_write on integration_config
  for all using (role_at(location_id) in ('admin','manager'))
  with check (role_at(location_id) in ('admin','manager'));

-- audit_log: members read their location's log; inserts go through service role.
create policy audit_read on audit_log
  for select using (role_at(location_id) is not null or is_admin());

-- okdhs_imports: members of the location can read; managers/admins write.
create policy okdhs_read on okdhs_imports
  for select using (role_at(location_id) is not null);
create policy okdhs_write on okdhs_imports
  for all using (role_at(location_id) in ('admin','manager'))
  with check (role_at(location_id) in ('admin','manager'));
