-- Undo/fix, debt repayments, personal money (income, spending categories, budgets) and share links.
-- Run after 0002_retention.sql. New enum values are not used as literals below, so this runs in one transaction.

alter type txn_kind add value if not exists 'income';
alter type txn_kind add value if not exists 'debt_paid_to_me';
alter type txn_kind add value if not exists 'debt_i_paid';

-- Spending category ('goods' and 'business_costs' are business; the rest are personal).
alter table transactions add column if not exists category text;
-- Set by UNDO. Voided rows stay for the NAIC log but drop out of every total.
alter table transactions add column if not exists voided_at timestamptz;

create table if not exists budgets (
  user_id     uuid not null references users(id) on delete cascade,
  category    text not null,
  amount_ngn  numeric not null check (amount_ngn > 0),
  updated_at  timestamptz not null default now(),
  primary key (user_id, category)
);
alter table budgets enable row level security;

-- Share links pre-fill "Hi SoroEngine [F-XXXXXX]"; counting them needs this.
create index if not exists users_ref_source on users (ref_source);

drop function if exists summary_for(uuid, timestamptz);
create function summary_for(p_user uuid, p_since timestamptz)
returns table (kind txn_kind, category text, total numeric, n bigint)
language sql stable as $$
  select kind, category, coalesce(sum(amount_ngn), 0), count(*)
  from transactions
  where user_id = p_user and created_at >= p_since and voided_at is null
  group by kind, category
$$;

-- All-time debt totals per person, for balances ("Emeka still owes you 2k").
create or replace function debts_for(p_user uuid)
returns table (counterparty text, kind txn_kind, total numeric)
language sql stable as $$
  select max(trim(counterparty)), kind, coalesce(sum(amount_ngn), 0)
  from transactions
  where user_id = p_user and voided_at is null and kind::text like 'debt%'
  group by lower(trim(counterparty)), kind
$$;

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
  m.error,
  t.category                as commerce_category,
  t.voided_at is not null   as commerce_undone
from messages m
join users u on u.id = m.user_id
left join transactions t   on t.message_id = m.id
left join tip_deliveries td on td.message_id = m.id
where m.direction = 'in'
order by m.created_at;
