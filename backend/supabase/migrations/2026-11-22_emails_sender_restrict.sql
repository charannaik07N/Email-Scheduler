-- Stop a sender deletion from silently deleting an email scheduled at the same moment.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to run again. Deletes nothing.
--
-- Before: deleting a sender also deleted all its emails (ON DELETE CASCADE).
-- After:  the delete fails while the sender still has emails. The API deletes
--         the sender's sent and failed emails first and refuses while any are
--         unsent, so an email scheduled during the delete is kept, not lost.

alter table public.emails
  drop constraint if exists emails_sender_id_fkey,
  add constraint emails_sender_id_fkey
    foreign key (sender_id) references public.senders (id) on delete restrict;

notify pgrst, 'reload schema';
