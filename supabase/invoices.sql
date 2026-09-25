-- Kim Industries - Material Orders: vendor invoices + invoice approval.
-- Run AFTER schema.sql and shop.sql: Dashboard > SQL Editor > New query > paste this file > Run. Safe to re-run.

-- Who can see and review invoices: admins, plus people given this permission.
alter table public.app_users add column if not exists can_review_invoices boolean not null default false;

create or replace function public.can_review_invoices() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where email = current_email() and (role = 'admin' or can_review_invoices) and not blocked)
$$;

create table if not exists public.invoices (
  id              uuid primary key default gen_random_uuid(),
  file_path       text not null,                 -- in storage bucket "invoices"
  file_name       text,
  file_type       text,
  status          text not null default 'processing'
                  check (status in ('processing', 'matched', 'mismatch', 'no_order', 'error', 'approved', 'sent_back')),
  supplier        text,                          -- our supplier code, e.g. CT-DI
  vendor_name     text,                          -- as printed on the invoice
  invoice_number  text,
  invoice_date    text,
  total           numeric(14,2),
  order_id        text references public.orders(id) on delete set null,
  order_number    text,
  match_method    text,                          -- order_number | products | manual
  extracted       jsonb,                         -- what the agent read from the invoice
  comparison      jsonb,                         -- line-by-line comparison with the order
  mismatch_count  integer not null default 0,
  error           text,
  notes           text,
  uploaded_by     text default public.current_email(),
  reviewed_by     text,
  reviewed_at     timestamptz,
  sent_back_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists invoices_status_idx on public.invoices (status, created_at desc);
create index if not exists invoices_order_idx on public.invoices (order_id);

alter table public.invoices enable row level security;
drop policy if exists "invoices read"   on public.invoices;
drop policy if exists "invoices insert" on public.invoices;
drop policy if exists "invoices update" on public.invoices;
drop policy if exists "invoices delete" on public.invoices;
create policy "invoices read"   on public.invoices for select to authenticated using (can_review_invoices());
create policy "invoices insert" on public.invoices for insert to authenticated with check (can_review_invoices());
create policy "invoices update" on public.invoices for update to authenticated using (can_review_invoices()) with check (can_review_invoices());
create policy "invoices delete" on public.invoices for delete to authenticated using (is_admin());

-- Private storage bucket for the invoice files.
insert into storage.buckets (id, name, public) values ('invoices', 'invoices', false)
on conflict (id) do nothing;

drop policy if exists "invoice files read"   on storage.objects;
drop policy if exists "invoice files upload" on storage.objects;
drop policy if exists "invoice files delete" on storage.objects;
create policy "invoice files read"   on storage.objects for select to authenticated using (bucket_id = 'invoices' and public.can_review_invoices());
create policy "invoice files upload" on storage.objects for insert to authenticated with check (bucket_id = 'invoices' and public.can_review_invoices());
create policy "invoice files delete" on storage.objects for delete to authenticated using (bucket_id = 'invoices' and public.is_admin());

-- Check: should return 0 the first time.
select count(*) as invoices from public.invoices;
