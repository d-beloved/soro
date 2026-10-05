-- SoroEngine core schema.
-- Phone numbers are never stored; only a salted SHA-256 hash.
-- RLS is enabled with no policies: only the service-role key (gateway) can read/write.

create extension if not exists pgcrypto;

create type lang_code as enum ('en', 'yo', 'ha', 'ig');
create type msg_direction as enum ('in', 'out');
create type txn_kind as enum ('sale', 'expense', 'debt_owed_to_me', 'debt_i_owe', 'stock');
create type tip_topic as enum (
  'separate_money', 'record_keeping', 'cash_flow', 'debt_recovery',
  'credit_readiness', 'savings', 'pricing'
);

create table users (
  id           uuid primary key default gen_random_uuid(),
  phone_hash   text not null unique,
  language     lang_code,
  consent_at   timestamptz,
  ref_source   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table messages (
  id             uuid primary key default gen_random_uuid(),
  wa_message_id  text unique,                 -- null for outbound
  user_id        uuid not null references users(id) on delete cascade,
  direction      msg_direction not null,
  type           text not null,               -- audio | text | interactive | ...
  audio_seconds  numeric,
  transcript     text,
  language       lang_code,
  intent         text,
  payload        jsonb,
  latency_ms     integer,
  error          text,
  created_at     timestamptz not null default now()
);
create index messages_user_created on messages (user_id, created_at desc);

create table transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  message_id    uuid references messages(id) on delete set null,
  kind          txn_kind not null,
  item          text,
  qty           numeric,
  unit          text,
  amount_ngn    numeric,
  counterparty  text,
  created_at    timestamptz not null default now()
);
create index transactions_user_created on transactions (user_id, created_at desc);

create table loan_intakes (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  message_id         uuid references messages(id) on delete set null,
  amount_ngn         numeric,
  purpose            text,
  business_type      text,
  monthly_sales_ngn  numeric,
  created_at         timestamptz not null default now()
);

create table tips (
  id        text primary key,                 -- e.g. 'cash_flow_01'
  topic     tip_topic not null,
  text_en   text not null,
  text_yo   text,
  text_ha   text,
  text_ig   text,
  reviewed  jsonb not null default '{}'::jsonb -- {"yo": true, ...} after native-speaker review
);

create table tip_deliveries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  tip_id      text not null references tips(id),
  message_id  uuid references messages(id) on delete set null,
  trigger     text not null check (trigger in ('asked', 'auto')),
  audio_sent  boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table users          enable row level security;
alter table messages       enable row level security;
alter table transactions   enable row level security;
alter table loan_intakes   enable row level security;
alter table tips           enable row level security;
alter table tip_deliveries enable row level security;

-- Totals for "how much I sell today/this week/this month" (WAT = UTC+1).
create or replace function summary_for(p_user uuid, p_since timestamptz)
returns table (kind txn_kind, total numeric, n bigint)
language sql stable as $$
  select kind, coalesce(sum(amount_ngn), 0), count(*)
  from transactions
  where user_id = p_user and created_at >= p_since
  group by kind
$$;

-- NAIC validation export: one row per inbound interaction.
create or replace view naic_interactions as
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
  m.error
from messages m
join users u on u.id = m.user_id
left join transactions t   on t.message_id = m.id
left join tip_deliveries td on td.message_id = m.id
where m.direction = 'in'
order by m.created_at;

-- Daily pilot counter for the dashboard / video.
create or replace view pilot_stats as
select
  (select count(*) from users where consent_at is not null)        as consented_users,
  (select count(distinct user_id) from messages where direction = 'in') as active_users,
  (select count(*) from messages where direction = 'in')           as interactions,
  (select count(*) from messages where direction = 'in' and type = 'audio') as voice_interactions,
  (select count(*) from tip_deliveries)                            as tips_delivered;
