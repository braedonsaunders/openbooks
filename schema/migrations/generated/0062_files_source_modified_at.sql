-- Incremental attachment sync: the upstream file's last-modified instant
-- (source wall clock, stored as UTC by convention). Purely an equality token
-- — the sync re-downloads only when the source instant differs. Nullable:
-- rows imported before this marker are backfilled lazily (see the importer's
-- safe backfill rule) or populated on the next download.
alter table files add column if not exists source_modified_at timestamptz;
