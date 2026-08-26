-- OpenBooks forward migration 0054_bank_feed_attempt_watermark.
--
-- bank_feed_connections carried exactly one sync timestamp, last_sync_at.
-- Since the runner fixed the unconditional-advance defect (a failed sync
-- shrinking the next pull window from 90 days to two and silently dropping
-- every transaction older than that gap), last_sync_at is strictly a
-- SUCCESS watermark: it moves only when a sync completes without error.
-- That left failures timestampless — an operator staring at status='error'
-- cannot tell whether the feed last tried minutes ago or days ago, because
-- nothing in the schema records WHEN an attempt happened.
--
-- Add the separate ATTEMPT watermark, last_attempt_at. The runner writes it
-- on every finished attempt (success, empty, or failure) while sinceFor keeps
-- deriving the next pull window from last_sync_at alone:
--
--   - last_sync_at     = success-only cursor. Reading it for anything other
--                        than window derivation must not regress (a failed
--                        sync never advances it; retries re-fetch its window).
--   - last_attempt_at  = attempt-only bookkeeping. It feeds operator surfaces
--                        (connection health panels, assistant tooling); it
--                        must never feed back into the pull window — otherwise
--                        repeated failures would quietly become the cursor and
--                        strand everything imported-into-nothing between the
--                        two cursors.
--
-- Nullable, with no backfill: rows predating this migration have no
-- reconstructable attempt history and null simply means "never attempted here
-- or attempted before this bookkeeping existed". Purely additive — no cursor,
-- no existing read path changes value.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.bank_feed_connections
  ADD COLUMN last_attempt_at timestamp with time zone;

COMMENT ON COLUMN public.bank_feed_connections.last_attempt_at IS
  'openbooks:bank_feed_connections.last_attempt_at:v1 - attempt watermark: when this connection last finished a sync try, whatever the outcome; the success-only pull cursor remains last_sync_at';
