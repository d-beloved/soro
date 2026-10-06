-- The gateway talks to Postgres as service_role. Newer Supabase projects don't grant it privileges on tables
-- created in SQL, so every request failed with "permission denied for table ...". anon and authenticated get
-- nothing: only the gateway reads or writes this data, and RLS stays on.

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Tables and functions added by later migrations.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;
