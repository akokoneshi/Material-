-- Kim Industries - Material Orders: jobs by division, user divisions, and the "field" user type.
-- Run AFTER schema.sql, shop.sql and invoices.sql: Dashboard > SQL Editor > New query > paste this file > Run. Safe to re-run.
--
-- User types (app_users.role):
--   admin - everything, every division.
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
alter table public.app_users drop constraint if exists app_users_role_check;
alter table public.app_users add constraint app_users_role_check check (role in ('admin', 'user', 'field'));

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
                 and (role = 'admin' or (role = 'user' and can_edit_shop)))
$$;

create or replace function public.can_review_invoices() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where email = current_email() and not blocked
                 and (role = 'admin' or (role = 'user' and can_review_invoices)))
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
  with check (not is_blocked() and can_see_job(job_number));
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
select email, role, divisions from public.app_users order by role, email;
