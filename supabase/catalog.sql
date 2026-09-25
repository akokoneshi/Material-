-- Kim Industries - Material Orders: requests to add items to the price list, reviewed by an admin.
-- Run AFTER schema.sql and shop.sql: Dashboard > SQL Editor > New query > paste this file > Run. Safe to re-run.

-- Items an admin approved; the app adds these to the searchable price list for everyone.
create table if not exists public.catalog_items (
  id          text primary key,                 -- e.g. KIM-3F9A2C
  supplier    text not null,
  name        text not null,
  model       text,                             -- part #
  unit        text not null default 'EA',
  category    text not null default 'Added Items',
  price       numeric(12,4) not null default 0, -- 0 = price TBD
  active      boolean not null default true,
  created_by  text default public.current_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Crew requests from the "add it manually" form.
create table if not exists public.catalog_requests (
  id            uuid primary key default gen_random_uuid(),
  supplier      text not null,
  name          text not null,
  model         text,
  unit          text,
  price         numeric(12,4),
  job_number    text,
  order_id      text,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  item_id       text references public.catalog_items(id) on delete set null,
  requested_by  text not null default public.current_email(),
  review_note   text,
  reviewed_by   text,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists catalog_requests_status_idx on public.catalog_requests (status, created_at desc);

alter table public.catalog_items    enable row level security;
alter table public.catalog_requests enable row level security;

drop policy if exists "catalog items read"   on public.catalog_items;
drop policy if exists "catalog items write"  on public.catalog_items;
drop policy if exists "catalog items update" on public.catalog_items;
drop policy if exists "catalog items delete" on public.catalog_items;
create policy "catalog items read"   on public.catalog_items for select to authenticated using (not is_blocked());
create policy "catalog items write"  on public.catalog_items for insert to authenticated with check (is_admin());
create policy "catalog items update" on public.catalog_items for update to authenticated using (is_admin()) with check (is_admin());
create policy "catalog items delete" on public.catalog_items for delete to authenticated using (is_admin());

-- Anyone signed in can ask; only admins can see requests and approve/reject them.
drop policy if exists "catalog requests read"   on public.catalog_requests;
drop policy if exists "catalog requests insert" on public.catalog_requests;
drop policy if exists "catalog requests update" on public.catalog_requests;
drop policy if exists "catalog requests delete" on public.catalog_requests;
create policy "catalog requests read"   on public.catalog_requests for select to authenticated using (is_admin());
create policy "catalog requests insert" on public.catalog_requests for insert to authenticated
  with check (not is_blocked() and requested_by = current_email() and status = 'pending');
create policy "catalog requests update" on public.catalog_requests for update to authenticated using (is_admin()) with check (is_admin());
create policy "catalog requests delete" on public.catalog_requests for delete to authenticated using (is_admin());

-- Check: should return 0 the first time.
select count(*) as pending_requests from public.catalog_requests where status = 'pending';
