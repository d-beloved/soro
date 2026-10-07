-- DELETE and the 12-month purge erase the user and everything they sent, but leave one bare row per inbound
-- message so usage counts survive. A row holds nothing that identifies the person or what they said: no
-- phone hash, transcript, amounts, names or replies.

create table if not exists erased_interactions (
  id            uuid primary key default gen_random_uuid(),
  erased_user   uuid not null,  -- random per erasure: groups one person's rows and links to nothing else
  ref_source    text,           -- campaign tag only; personal share codes become 'SHARE'
  created_at    timestamptz not null,
  input_type    text not null,
  language      lang_code,
  audio_seconds numeric,
  intent        text,
  latency_ms    integer
);
alter table erased_interactions enable row level security;

create or replace function erase_user(p_user uuid) returns void
language plpgsql as $$
declare
  -- One random id per erasure (not per row), so one person's rows still count as one user.
  tag uuid := gen_random_uuid();
begin
  insert into erased_interactions (erased_user, ref_source, created_at, input_type, language, audio_seconds, intent, latency_ms)
  select tag, case when u.ref_source like 'F-%' then 'SHARE' else u.ref_source end,
         m.created_at, m.type, m.language, m.audio_seconds, m.intent, m.latency_ms
  from messages m
  join users u on u.id = m.user_id
  where m.user_id = p_user and m.direction = 'in';

  -- Cascades to messages, transactions, loan_intakes, tip_deliveries and budgets.
  delete from users where id = p_user;
end
$$;

create or replace function purge_inactive_users() returns integer
language plpgsql as $$
declare
  u uuid;
  n integer := 0;
begin
  for u in select id from users where last_seen_at < now() - interval '12 months' loop
    perform erase_user(u);
    n := n + 1;
  end loop;
  return n;
end
$$;

create or replace view interaction_log as
select * from (
  select
    m.id                      as interaction_id,
    u.id                      as user_id,
    u.ref_source,
    m.created_at at time zone 'Africa/Lagos' as timestamp_wat,
    m.type                    as input_type,
    m.language,
    m.audio_seconds,
    m.transcript,
    m.intent,
    m.payload,
    m.latency_ms,
    t.kind                    as commerce_kind,
    t.amount_ngn              as commerce_amount_ngn,
    td.tip_id                 as tutor_tip_id,
    td.audio_sent             as voice_reply_sent,
    m.error,
    t.category                as commerce_category,
    t.voided_at is not null   as commerce_undone,
    false                     as erased
  from messages m
  join users u on u.id = m.user_id
  left join transactions t   on t.message_id = m.id
  left join tip_deliveries td on td.message_id = m.id
  where m.direction = 'in'
  union all
  select
    e.id, e.erased_user, e.ref_source, e.created_at at time zone 'Africa/Lagos', e.input_type, e.language,
    e.audio_seconds, null, e.intent, null, e.latency_ms, null, null, null, null, null, null, null,
    true
  from erased_interactions e
) log
order by timestamp_wat;

create or replace view usage_stats as
select
  (select count(*) from users where consent_at is not null)        as consented_users,
  (select count(distinct user_id) from messages where direction = 'in')
    + (select count(distinct erased_user) from erased_interactions) as active_users,
  (select count(*) from messages where direction = 'in')
    + (select count(*) from erased_interactions)                    as interactions,
  (select count(*) from messages where direction = 'in' and type = 'audio')
    + (select count(*) from erased_interactions where input_type = 'audio') as voice_interactions,
  (select count(*) from tip_deliveries)                            as tips_delivered;
