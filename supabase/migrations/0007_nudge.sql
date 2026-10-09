-- One reminder for people who finish onboarding but never record anything (pilot: 7 of 12 did that).
-- Set when the reminder is sent, so nobody gets it twice.
alter table users add column if not exists nudged_at timestamptz;
