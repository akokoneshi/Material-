-- Kim Industries - Material Orders: phone numbers for people in Users & Permissions.
-- Already included in supabase/divisions.sql. Run this on its own only if you ran divisions.sql before phone numbers were added.
-- Dashboard > SQL Editor > New query > paste this file > Run. Safe to re-run.
alter table public.app_users add column if not exists phone text;
select email, name, phone from public.app_users order by email;
