-- Extensions
create extension if not exists pgcrypto;

-- Shared enum for organization membership roles. Kept as a real enum
-- (rather than a text + check constraint) because it is small, stable,
-- and used directly inside RLS policies across many tables.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'org_role') then
    create type public.org_role as enum ('owner', 'admin', 'member');
  end if;
end
$$;

-- Generic trigger function that keeps `updated_at` current on every UPDATE.
-- Reused by every table below that has an `updated_at` column.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
