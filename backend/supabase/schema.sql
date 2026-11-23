-- Email Scheduler database schema for Supabase.
-- Run it once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It matches prisma/schema.prisma and the column names the backend uses.
--
-- WARNING: it drops the existing users, senders, emails and email_logs tables
-- (and the old "EmailStatus" type) and recreates them empty.

begin;

drop table if exists public.email_logs cascade;
drop table if exists public.emails cascade;
drop table if exists public.senders cascade;
drop table if exists public.users cascade;
drop type if exists public."EmailStatus" cascade;

-- SCHEDULED: waiting in the queue
-- RETRYING:  a send attempt failed (or the hourly limit was hit) and it will be tried again
-- SENT:      delivered to the SMTP server
-- FAILED:    gave up after all attempts
create type public."EmailStatus" as enum ('SCHEDULED', 'RETRYING', 'SENT', 'FAILED');

-- Users sign in with Google only; no password is stored.
create table public.users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  name       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The "From" identity. Without its own SMTP settings, a sender uses the
-- server's SMTP account and must use the owner's email address.
create table public.senders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  name       text not null,
  email      text not null,
  smtp_host  text,
  smtp_port  integer,
  smtp_user  text,
  smtp_pass  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index senders_user_id_idx on public.senders (user_id);
-- At most one sender per user on the server's shared SMTP account (no smtp_host).
-- Such a sender must use the account's own email, so a second one is never
-- useful; the index also stops parallel sign-ins creating duplicate defaults.
create unique index senders_one_shared_per_user on public.senders (user_id) where smtp_host is null;

create table public.emails (
  id              uuid primary key default gen_random_uuid(),
  -- RESTRICT: a sender with emails can't be deleted by accident. The API deletes
  -- its sent and failed emails first, and refuses while any are unsent.
  sender_id       uuid not null references public.senders (id) on delete restrict,
  recipient_email text not null,
  recipient_name  text,
  subject         text not null,
  body            text not null,
  html_body       text,
  scheduled_at    timestamptz not null,
  sent_at         timestamptz,
  status          public."EmailStatus" not null default 'SCHEDULED',
  attempt_count   integer not null default 0,
  error_message   text,
  -- Stored as "<userId>:<client key>", so keys are unique per user.
  idempotency_key text unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index emails_status_idx on public.emails (status);
create index emails_sender_id_scheduled_at_idx on public.emails (sender_id, scheduled_at);

create table public.email_logs (
  id         uuid primary key default gen_random_uuid(),
  email_id   uuid not null references public.emails (id) on delete cascade,
  status     public."EmailStatus" not null,
  message    text,
  created_at timestamptz not null default now()
);
create index email_logs_email_id_created_at_idx on public.email_logs (email_id, created_at);

-- Only the backend (service role key, which bypasses RLS) may touch these
-- tables. With RLS on and no policies, the public anon key can read nothing.
alter table public.users      enable row level security;
alter table public.senders    enable row level security;
alter table public.emails     enable row level security;
alter table public.email_logs enable row level security;

commit;

-- Make the API see the new tables right away.
notify pgrst, 'reload schema';
