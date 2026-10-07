-- Gives the export views product names. On a fresh install 0001 and 0003 already create them under
-- these names, so both statements do nothing.
alter view if exists naic_interactions rename to interaction_log;
alter view if exists pilot_stats rename to usage_stats;
