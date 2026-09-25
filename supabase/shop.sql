-- Kim Industries - Material Orders: shop stock, users & permissions.
-- Run AFTER schema.sql: Dashboard > SQL Editor > New query > paste this file > Run. Safe to re-run.

-- ---------------------------------------------------------------- users & permissions
create table if not exists public.app_users (
  email          text primary key check (email = lower(email)),
  name           text,
  role           text not null default 'user' check (role in ('admin', 'user')),
  can_edit_shop  boolean not null default false,
  blocked        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

insert into public.app_users (email, name, role, can_edit_shop)
values ('amandak@kimindustries.com', 'Amanda K', 'admin', true)
on conflict (email) do update set role = 'admin', can_edit_shop = true, blocked = false;

create or replace function public.current_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where email = current_email() and role = 'admin' and not blocked)
$$;

create or replace function public.can_edit_shop() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where email = current_email() and (role = 'admin' or can_edit_shop) and not blocked)
$$;

-- Users not listed in app_users are regular crew members; only a "blocked" row locks someone out.
create or replace function public.is_blocked() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where email = current_email() and blocked)
$$;

-- Keep at least one admin.
create or replace function public.protect_last_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'DELETE' or new.role <> 'admin' or new.blocked) and old.role = 'admin'
     and not exists (select 1 from app_users where role = 'admin' and not blocked and email <> old.email) then
    raise exception 'There must be at least one admin';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists app_users_last_admin on public.app_users;
create trigger app_users_last_admin before update or delete on public.app_users
  for each row execute function public.protect_last_admin();

alter table public.app_users enable row level security;
drop policy if exists "users read"   on public.app_users;
drop policy if exists "users insert" on public.app_users;
drop policy if exists "users update" on public.app_users;
drop policy if exists "users delete" on public.app_users;
create policy "users read"   on public.app_users for select to authenticated using (true);
create policy "users insert" on public.app_users for insert to authenticated with check (is_admin());
create policy "users update" on public.app_users for update to authenticated using (is_admin()) with check (is_admin());
create policy "users delete" on public.app_users for delete to authenticated using (is_admin());

-- Blocked users lose access to orders too.
drop policy if exists "orders read"   on public.orders;
drop policy if exists "orders insert" on public.orders;
drop policy if exists "orders update" on public.orders;
drop policy if exists "orders delete" on public.orders;
create policy "orders read"   on public.orders for select to authenticated using (not is_blocked());
create policy "orders insert" on public.orders for insert to authenticated with check (not is_blocked());
create policy "orders update" on public.orders for update to authenticated using (not is_blocked()) with check (not is_blocked());
create policy "orders delete" on public.orders for delete to authenticated using (status = 'draft' and not is_blocked());

-- ---------------------------------------------------------------- shop stock
create table if not exists public.shop_stock (
  id          uuid primary key default gen_random_uuid(),
  item_key    text not null,            -- price-list item (supplier|item id)
  item_name   text not null,
  unit        text,
  category    text,
  model       text,
  division    text not null check (division in ('100','200','300','400','450','600','700')),
  qty         numeric(12,3) not null default 0 check (qty >= 0),
  updated_by  text,
  updated_at  timestamptz not null default now(),
  unique (item_key, division)
);

create table if not exists public.shop_log (
  id          bigserial primary key,
  item_key    text not null,
  item_name   text,
  unit        text,
  division    text not null,
  delta       numeric(12,3) not null,
  qty_after   numeric(12,3) not null,
  reason      text,
  job_number  text,
  order_id    text,
  by_email    text,
  at          timestamptz not null default now()
);
create index if not exists shop_log_item_idx on public.shop_log (item_key, division, at desc);

-- All stock changes go through this function so they are checked and logged.
-- p_delta adds/removes; p_set (when not null) sets the quantity outright.
create or replace function public.adjust_stock(
  p_item_key text, p_item_name text, p_unit text, p_category text, p_model text,
  p_division text, p_delta numeric, p_set numeric default null,
  p_reason text default null, p_job text default null, p_order text default null
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  cur numeric := 0;
  nxt numeric;
begin
  if not can_edit_shop() then
    raise exception 'You do not have permission to change shop stock';
  end if;
  if p_division not in ('100','200','300','400','450','600','700') then
    raise exception 'Unknown division %', p_division;
  end if;
  select qty into cur from shop_stock where item_key = p_item_key and division = p_division for update;
  cur := coalesce(cur, 0);
  nxt := case when p_set is not null then p_set else cur + coalesce(p_delta, 0) end;
  if nxt < 0 then
    raise exception 'Only % on hand in Div %', trim_scale(cur), p_division;
  end if;
  if nxt = 0 then
    delete from shop_stock where item_key = p_item_key and division = p_division;
  else
    insert into shop_stock (item_key, item_name, unit, category, model, division, qty, updated_by, updated_at)
    values (p_item_key, p_item_name, p_unit, p_category, p_model, p_division, nxt, current_email(), now())
    on conflict (item_key, division) do update
      set qty = excluded.qty, item_name = excluded.item_name, unit = excluded.unit, category = excluded.category,
          model = excluded.model, updated_by = excluded.updated_by, updated_at = now();
  end if;
  if nxt <> cur then
    insert into shop_log (item_key, item_name, unit, division, delta, qty_after, reason, job_number, order_id, by_email)
    values (p_item_key, p_item_name, p_unit, p_division, nxt - cur, nxt, p_reason, p_job, p_order, current_email());
  end if;
  return nxt;
end $$;
revoke all on function public.adjust_stock(text,text,text,text,text,text,numeric,numeric,text,text,text) from public, anon;
grant execute on function public.adjust_stock(text,text,text,text,text,text,numeric,numeric,text,text,text) to authenticated;

alter table public.shop_stock enable row level security;
alter table public.shop_log   enable row level security;
drop policy if exists "stock read" on public.shop_stock;
drop policy if exists "log read"   on public.shop_log;
create policy "stock read" on public.shop_stock for select to authenticated using (not is_blocked());
create policy "log read"   on public.shop_log   for select to authenticated using (not is_blocked());
-- No insert/update/delete policies: changes only through adjust_stock().
