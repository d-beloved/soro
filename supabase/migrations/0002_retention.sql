-- Retention promised in the privacy notice: erase users 12 months after their last message.
-- Deleting a user cascades to messages, transactions, loan_intakes and tip_deliveries.

create or replace function purge_inactive_users() returns integer
language sql as $$
  with gone as (
    delete from users where last_seen_at < now() - interval '12 months' returning 1
  )
  select count(*)::integer from gone
$$;

-- Daily at 02:00 UTC via pg_cron (available on Supabase, including the free plan).
create extension if not exists pg_cron;
select cron.schedule('purge-inactive-users', '0 2 * * *', 'select purge_inactive_users()');
