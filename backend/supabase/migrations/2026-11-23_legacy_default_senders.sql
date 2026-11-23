-- Run once in the Supabase SQL Editor, after 2026-11-21_one_shared_sender_per_user.sql.
-- Safe to run more than once.
--
-- The old sign-in code created each user's default sender with a copy of the
-- server's SMTP settings (host smtp.ethereal.email unless SMTP_HOST was set,
-- and ETHEREAL_USER / ETHEREAL_PASS, which were empty when unset). Those rows
-- mean "use the server's shared account", which the app now stores as no
-- smtp_host. Clearing the copied settings makes them use the current shared
-- account instead of stale or missing credentials.
--
-- If the old server ran with a different SMTP_HOST, put it in old_host below.
--
-- Only a sender with the owner's own address is changed (the shared account
-- may only send as the owner), and only one per user, the oldest, because a
-- user may have at most one shared sender. A user who already has one keeps it.

with settings as (
  select 'smtp.ethereal.email'::text as old_host
),
candidates as (
  select s.id,
         row_number() over (partition by s.user_id order by s.created_at, s.id) as n
  from public.senders s
  join public.users u on u.id = s.user_id
  cross join settings
  where lower(s.smtp_host) = lower(settings.old_host)
    and lower(s.email) = lower(u.email)
    and not exists (
      select 1 from public.senders shared
      where shared.user_id = s.user_id and shared.smtp_host is null
    )
)
update public.senders s
set smtp_host  = null,
    smtp_port  = null,
    smtp_user  = null,
    smtp_pass  = null,
    updated_at = now()
from candidates c
where s.id = c.id and c.n = 1;
