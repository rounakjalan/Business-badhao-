-- Minimal stand-in for the parts of Supabase's `auth` schema our migrations
-- reference. Used ONLY for local validation of migrations/RLS against a
-- plain Postgres instance during development. Never applied to a real
-- Supabase project (Supabase already provides the real `auth` schema).
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid,
  aud text,
  role text,
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  confirmation_token text,
  recovery_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  identity_data jsonb not null default '{}'::jsonb,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_id)
);

-- Supabase's auth.uid() reads the JWT claim; locally we fake it with a
-- session variable so we can simulate "logged in as user X" per session.
create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('request.jwt.uid', true), '')::uuid $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
end
$$;

-- On a real Supabase project, every table in `public` automatically grants
-- table-level privileges to `anon`/`authenticated` (RLS is the actual gate).
-- Plain Postgres has no such default, so replicate it here for local
-- testing only, applied to tables created from this point on.
grant usage on schema public to authenticated, anon;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant select on tables to anon;
