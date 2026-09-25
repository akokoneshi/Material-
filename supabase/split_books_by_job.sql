-- Kim Industries - Material Orders: give every job its own copy of its price books.
-- A book that covered several jobs (e.g. "3479, 3557, 3375") becomes one book per job, each with all
-- of the original prices; the shared original is then removed.
-- Run once after pricing.sql: Dashboard > SQL Editor > New query > paste this file > Run. Safe to re-run.

begin;

-- Same id recipe the special-pricing/job_*.sql files use, so re-running those later just updates these books.
create or replace function pg_temp.book_id(job text, supplier text, name text) returns uuid
language sql immutable as $$
  select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-a' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
  from (select md5(job || '|' || supplier || '|' || coalesce(name, '')) as h) x
$$;

create temp table split_map on commit drop as
select b.id as old_id, j.job, b.supplier, b.name, b.active, pg_temp.book_id(j.job, b.supplier, b.name) as new_id
from public.price_books b
cross join lateral unnest(b.job_keys) as j(job)
where cardinality(b.job_keys) > 1 and j.job <> '';

insert into public.price_books (id, job_number, supplier, name, active)
select new_id, job, supplier, name, active from split_map
on conflict (id) do nothing;

insert into public.price_book_items (book_id, item_key, item_name, unit, price)
select m.new_id, i.item_key, i.item_name, i.unit, i.price
from split_map m join public.price_book_items i on i.book_id = m.old_id
on conflict (book_id, item_key) do update set price = least(public.price_book_items.price, excluded.price);

delete from public.price_books where id in (select distinct old_id from split_map);

commit;

-- Check: one row per job and supplier book.
select job_number, supplier, name, (select count(*) from public.price_book_items i where i.book_id = b.id) as items
from public.price_books b order by job_number, supplier, name;
