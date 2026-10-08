-- Kim Industries - Material Orders: jobs by division, user divisions, and the "field" user type.
-- Run AFTER schema.sql, shop.sql, invoices.sql and catalog.sql: Dashboard > SQL Editor > New query > paste this file > Run. Safe to re-run.
--
-- User types (app_users.role):
--   admin     - company admin: everything, every division.
--   div_admin - division admin: like a regular user in their divisions, and approves / adds price-list items for them.
--   user  - creates orders; reviews invoices / edits shop stock if those are ticked. Sees only their divisions' jobs.
--   field - creates orders and looks at shop stock. Nothing else. Sees only their divisions' jobs.
-- Orders: a user with no divisions assigned is not limited, and until the jobs list has at least one job no one is limited.
-- Invoices: non-admins only see invoices whose job is in their divisions (plus ones they uploaded themselves).
--   No divisions = no invoices. Invoices with no job # yet are admin-only.

-- ---------------------------------------------------------------- jobs
create table if not exists public.jobs (
  job_number  text primary key check (job_number = upper(btrim(job_number)) and job_number <> ''),
  job_name    text,
  division    text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists jobs_division_idx on public.jobs (division);

-- ---------------------------------------------------------------- user type + divisions
alter table public.app_users add column if not exists divisions text[] not null default '{}';
alter table public.app_users add column if not exists phone text;
alter table public.app_users drop constraint if exists app_users_role_check;
alter table public.app_users add constraint app_users_role_check check (role in ('admin', 'div_admin', 'user', 'field'));

-- Invoices remember their job #, so they can be limited by division even without a matched order.
alter table public.invoices add column if not exists job_number text;

create or replace function public.my_divisions() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce((select divisions from app_users where email = current_email()), '{}')
$$;

create or replace function public.job_division(p_job text) returns text
language sql stable security definer set search_path = public as $$
  select division from jobs where job_number = upper(btrim(coalesce(p_job, '')))
$$;

-- Can the signed-in person see / order on this job?
create or replace function public.can_see_job(p_job text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin()
      or coalesce(array_length(my_divisions(), 1), 0) = 0
      or not exists (select 1 from jobs)
      or job_division(p_job) = any(my_divisions())
$$;

-- Field users never edit shop stock or review invoices, even if those boxes were ticked before.
create or replace function public.can_edit_shop() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where email = current_email() and not blocked
                 and (role = 'admin' or (role in ('user', 'div_admin') and can_edit_shop)))
$$;

create or replace function public.can_review_invoices() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where email = current_email() and not blocked
                 and (role = 'admin' or (role in ('user', 'div_admin') and can_review_invoices)))
$$;

-- Invoice visibility (non-admins): its job (stored, or from the matched order) must be in the person's divisions.
-- No divisions = no invoices; invoices with no job yet are admin-only. The uploader keeps seeing their own upload
-- (it has no job while it's being read).
drop policy if exists "invoices read"   on public.invoices;
drop policy if exists "invoices update" on public.invoices;
drop function if exists public.can_see_invoice(text, text);
create or replace function public.can_see_invoice(p_job text, p_order text, p_uploader text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin()
      or coalesce(p_uploader, '') = current_email()
      or job_division(coalesce(nullif(btrim(p_job), ''), (select job_number from orders where id = p_order))) = any(my_divisions())
$$;

-- ---------------------------------------------------------------- division names + price lists by division
create table if not exists public.divisions (
  code  text primary key,
  name  text not null,
  sort  integer not null default 0
);
-- Re-running keeps names an admin has changed in the app.
insert into public.divisions (code, name, sort) values
  ('100', 'Connecticut', 1), ('200', 'Hudson Valley', 2), ('300', 'Albany', 3),
  ('400', 'Buffalo/Rochester', 4), ('600', 'Firestop', 6), ('700', 'Syracuse', 7)
on conflict (code) do nothing;

-- Which divisions may order from each supplier's day-to-day price list. Empty = every division.
create table if not exists public.supplier_divisions (
  supplier    text primary key,
  divisions   text[] not null default '{}',
  updated_at  timestamptz not null default now()
);
insert into public.supplier_divisions (supplier, divisions) values
  ('CT-Homans', '{100,200}'), ('CT-SPI', '{100,200}'), ('CT-DI', '{100,200}'), ('CT-AIT', '{100,200}'), ('GIC', '{}')
on conflict (supplier) do nothing;

-- Shop stock uses the same division list (no more 450). Stock changes are checked against the divisions table
-- instead of a fixed list, so new divisions work in the shop too.
alter table public.shop_stock drop constraint if exists shop_stock_division_check;
update public.app_users set divisions = array_remove(divisions, '450') where '450' = any(divisions);
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
  if not exists (select 1 from divisions where code = p_division) then
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

-- Can this supplier's price list be used on this job? Jobs not on the jobs list, and suppliers with no limits, are allowed.
create or replace function public.supplier_serves_job(p_supplier text, p_job text) returns boolean
language sql stable security definer set search_path = public as $$
  select job_division(p_job) is null or cardinality(x.sd) = 0 or job_division(p_job) = any(x.sd)
  from (select coalesce((select divisions from supplier_divisions where supplier = p_supplier), '{}'::text[]) as sd) x
$$;

alter table public.divisions enable row level security;
alter table public.supplier_divisions enable row level security;
drop policy if exists "divisions read"  on public.divisions;
drop policy if exists "divisions write" on public.divisions;
drop policy if exists "supplier divisions read"  on public.supplier_divisions;
drop policy if exists "supplier divisions write" on public.supplier_divisions;
create policy "divisions read"  on public.divisions for select to authenticated using (not is_blocked());
create policy "divisions write" on public.divisions for all to authenticated using (is_admin()) with check (is_admin());
create policy "supplier divisions read"  on public.supplier_divisions for select to authenticated using (not is_blocked());
create policy "supplier divisions write" on public.supplier_divisions for all to authenticated using (is_admin()) with check (is_admin());

-- Division admins: approve price-list requests and add / edit price-list items for their own divisions.
create or replace function public.is_div_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where email = current_email() and role = 'div_admin' and not blocked
                 and cardinality(divisions) > 0)
$$;
-- A request belongs to the job's division, or else to the requester's divisions.
create or replace function public.request_in_my_divisions(p_job text, p_requester text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(job_division(p_job) = any(my_divisions()), false)
      or (job_division(p_job) is null and exists (select 1 from app_users where email = lower(coalesce(p_requester, '')) and divisions && my_divisions()))
$$;
-- A division admin may write an added item (KIM-…) for their own divisions, or a company-wide one for a shared supplier (e.g. GIC).
create or replace function public.div_admin_can_write_item(p_id text, p_supplier text, p_divisions text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select is_div_admin() and p_id like 'KIM-%' and (
    (cardinality(p_divisions) > 0 and p_divisions <@ my_divisions()
       and p_divisions <@ coalesce(nullif((select divisions from supplier_divisions where supplier = p_supplier), '{}'), p_divisions))
    or (cardinality(p_divisions) = 0 and cardinality(coalesce((select divisions from supplier_divisions where supplier = p_supplier), '{}')) = 0))
$$;

-- Items added to a supplier's price list (approved requests, items added from invoices) belong to divisions:
-- people only get the ones for their divisions. Empty = every division (GIC items, and admin edits of regular items).
alter table public.catalog_items add column if not exists divisions text[] not null default '{}';
drop policy if exists "catalog items read" on public.catalog_items;
create policy "catalog items read" on public.catalog_items for select to authenticated
  using (not is_blocked() and (is_admin() or cardinality(divisions) = 0 or cardinality(my_divisions()) = 0 or divisions && my_divisions()));
drop policy if exists "catalog items write"  on public.catalog_items;
drop policy if exists "catalog items update" on public.catalog_items;
create policy "catalog items write" on public.catalog_items for insert to authenticated
  with check (is_admin() or div_admin_can_write_item(id, supplier, divisions));
create policy "catalog items update" on public.catalog_items for update to authenticated
  using (is_admin() or div_admin_can_write_item(id, supplier, divisions))
  with check (is_admin() or div_admin_can_write_item(id, supplier, divisions));

-- Price-list requests: company admins see all; division admins see their divisions' requests.
drop policy if exists "catalog requests read"   on public.catalog_requests;
drop policy if exists "catalog requests update" on public.catalog_requests;
create policy "catalog requests read" on public.catalog_requests for select to authenticated
  using (is_admin() or (is_div_admin() and request_in_my_divisions(job_number, requested_by)));
create policy "catalog requests update" on public.catalog_requests for update to authenticated
  using (is_admin() or (is_div_admin() and request_in_my_divisions(job_number, requested_by)))
  with check (is_admin() or (is_div_admin() and request_in_my_divisions(job_number, requested_by)));

-- ---------------------------------------------------------------- policies
alter table public.jobs enable row level security;
drop policy if exists "jobs read"   on public.jobs;
drop policy if exists "jobs insert" on public.jobs;
drop policy if exists "jobs update" on public.jobs;
drop policy if exists "jobs delete" on public.jobs;
create policy "jobs read"   on public.jobs for select to authenticated using (not is_blocked());
create policy "jobs insert" on public.jobs for insert to authenticated with check (is_admin());
create policy "jobs update" on public.jobs for update to authenticated using (is_admin()) with check (is_admin());
create policy "jobs delete" on public.jobs for delete to authenticated using (is_admin());

-- Orders: your divisions' jobs, plus any order you created yourself.
drop policy if exists "orders read"   on public.orders;
drop policy if exists "orders insert" on public.orders;
drop policy if exists "orders update" on public.orders;
drop policy if exists "orders delete" on public.orders;
create policy "orders read" on public.orders for select to authenticated
  using (not is_blocked() and (can_see_job(job_number) or created_by_email = current_email() or created_by = auth.uid()));
create policy "orders insert" on public.orders for insert to authenticated
  with check (not is_blocked() and can_see_job(job_number) and supplier_serves_job(supplier, job_number));
create policy "orders update" on public.orders for update to authenticated
  using (not is_blocked() and (can_see_job(job_number) or created_by_email = current_email() or created_by = auth.uid()))
  with check (not is_blocked() and (can_see_job(job_number) or created_by_email = current_email() or created_by = auth.uid()));
create policy "orders delete" on public.orders for delete to authenticated
  using (status = 'draft' and not is_blocked() and (can_see_job(job_number) or created_by_email = current_email() or created_by = auth.uid()));

-- Invoices: reviewers see their divisions' invoices (and ones with no job yet).
drop policy if exists "invoices read"   on public.invoices;
drop policy if exists "invoices insert" on public.invoices;
drop policy if exists "invoices update" on public.invoices;
create policy "invoices read"   on public.invoices for select to authenticated using (can_review_invoices() and can_see_invoice(job_number, order_id, uploaded_by));
create policy "invoices insert" on public.invoices for insert to authenticated with check (can_review_invoices());
create policy "invoices update" on public.invoices for update to authenticated
  using (can_review_invoices() and can_see_invoice(job_number, order_id, uploaded_by)) with check (can_review_invoices());

-- Check: jobs per division, and each person's type and divisions.
select division, count(*) as jobs from public.jobs group by division order by division;
select division, count(*) as stock_rows from public.shop_stock group by division order by division;
select email, role, divisions from public.app_users order by role, email;
select s.supplier, case when cardinality(s.divisions) = 0 then 'all divisions' else array_to_string(s.divisions, ', ') end as divisions from public.supplier_divisions s order by 1;
