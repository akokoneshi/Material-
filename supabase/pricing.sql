-- Kim Industries - Material Orders: special (job) pricing books.
-- Run AFTER schema.sql and shop.sql: Dashboard > SQL Editor > New query > paste this file > Run. Safe to re-run.

create table if not exists public.price_books (
  id          uuid primary key default gen_random_uuid(),
  job_number  text not null,             -- one or more jobs, comma separated: "3479, 3557, 3375"
  job_keys    text[] generated always as (string_to_array(upper(regexp_replace(job_number, '\s+', '', 'g')), ',')) stored,
  supplier    text not null,
  name        text,
  active      boolean not null default true,
  created_by  text default public.current_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists price_books_jobs_idx on public.price_books using gin (job_keys);

create table if not exists public.price_book_items (
  book_id     uuid not null references public.price_books(id) on delete cascade,
  item_key    text not null,               -- price-list item: supplier|item id
  item_name   text,
  unit        text,
  price       numeric(12,4) not null check (price >= 0),
  updated_at  timestamptz not null default now(),
  primary key (book_id, item_key)
);

-- If one book lists the same item more than once, or a job has several books with the item,
-- the app uses the LOWEST price.

-- Everyone signed in can read (orders need the prices); only admins can change books.
alter table public.price_books      enable row level security;
alter table public.price_book_items enable row level security;

drop policy if exists "books read"   on public.price_books;
drop policy if exists "books write"  on public.price_books;
drop policy if exists "books update" on public.price_books;
drop policy if exists "books delete" on public.price_books;
create policy "books read"   on public.price_books for select to authenticated using (not is_blocked());
create policy "books write"  on public.price_books for insert to authenticated with check (is_admin());
create policy "books update" on public.price_books for update to authenticated using (is_admin()) with check (is_admin());
create policy "books delete" on public.price_books for delete to authenticated using (is_admin());

drop policy if exists "book items read"   on public.price_book_items;
drop policy if exists "book items write"  on public.price_book_items;
drop policy if exists "book items update" on public.price_book_items;
drop policy if exists "book items delete" on public.price_book_items;
create policy "book items read"   on public.price_book_items for select to authenticated using (not is_blocked());
create policy "book items write"  on public.price_book_items for insert to authenticated with check (is_admin());
create policy "book items update" on public.price_book_items for update to authenticated using (is_admin()) with check (is_admin());
create policy "book items delete" on public.price_book_items for delete to authenticated using (is_admin());

-- Check: should return 0 rows the first time (no books yet) without an error.
select count(*) as price_books from public.price_books;
