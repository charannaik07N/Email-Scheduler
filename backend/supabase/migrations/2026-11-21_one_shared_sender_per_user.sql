-- Run once in the Supabase SQL Editor on a database created from an earlier
-- schema.sql. Safe to run more than once.
--
-- Stops parallel first sign-ins from creating two default senders: at most one
-- sender per user may use the server's shared SMTP account (no smtp_host).

-- Remove duplicates first, keeping each user's oldest shared sender. Emails of
-- a removed duplicate are moved to the kept sender, not deleted.
with ranked as (
  select id, user_id,
         first_value(id) over (partition by user_id order by created_at, id) as keep_id
  from public.senders
  where smtp_host is null
)
update public.emails e
set sender_id = r.keep_id
from ranked r
where e.sender_id = r.id and r.id <> r.keep_id;

with ranked as (
  select id,
         row_number() over (partition by user_id order by created_at, id) as n
  from public.senders
  where smtp_host is null
)
delete from public.senders s
using ranked r
where s.id = r.id and r.n > 1;

create unique index if not exists senders_one_shared_per_user
  on public.senders (user_id)
  where smtp_host is null;
