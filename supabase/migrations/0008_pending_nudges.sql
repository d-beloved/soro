-- Pending reminders (0007) used to live only in the gateway's memory, so every Render restart dropped them.
-- Sending one needs the phone number, which we otherwise never store: it is kept here encrypted by the gateway
-- (AES-256-GCM, the key exists only in the gateway's environment), and only until the reminder goes out, the
-- person records something or deletes their data, or WhatsApp's 24-hour reply window closes.

create table if not exists pending_nudges (
  user_id    uuid primary key references users(id) on delete cascade,  -- DELETE and the 12-month purge clear it
  phone_enc  text not null,
  language   lang_code not null,
  due_at     timestamptz not null,
  expires_at timestamptz not null
);
create index if not exists pending_nudges_due on pending_nudges (due_at);
alter table pending_nudges enable row level security;
grant all on pending_nudges to service_role;

-- Starts (or restarts) someone's reminder clock, but only for someone who could still get one: never reminded
-- and nothing recorded. Anyone else's pending row is dropped, so no number is kept that won't be used.
create or replace function schedule_nudge(p_user uuid, p_phone_enc text, p_language lang_code, p_due timestamptz, p_expires timestamptz)
returns boolean
language plpgsql as $$
begin
  if exists (select 1 from users where id = p_user and nudged_at is null)
     and not exists (select 1 from transactions where user_id = p_user) then
    insert into pending_nudges (user_id, phone_enc, language, due_at, expires_at)
    values (p_user, p_phone_enc, p_language, p_due, p_expires)
    on conflict (user_id) do update
      set phone_enc = excluded.phone_enc, language = excluded.language, due_at = excluded.due_at, expires_at = excluded.expires_at;
    return true;
  end if;
  delete from pending_nudges where user_id = p_user;
  return false;
end
$$;
grant execute on function schedule_nudge(uuid, text, lang_code, timestamptz, timestamptz) to service_role;
