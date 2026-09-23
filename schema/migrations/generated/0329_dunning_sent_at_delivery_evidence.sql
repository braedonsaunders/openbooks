-- OpenBooks forward migration 0329_dunning_sent_at_delivery_evidence.
--
-- dunning_log.sent_at was timestamptz NOT NULL DEFAULT now(): the runner
-- opens each ladder rung as a 'staged' claim without a sent_at, so the
-- database stamped every claim "sent" at claim time. The later
-- failed/suppressed transitions left that timestamp in place, so a customer
-- with no billing email — or a failed provider delivery — carried status
-- suppressed/failed next to a populated sent_at that reads as delivery
-- evidence. Readers sorting by sent_at (the subscription assistant tool, the
-- dunning history probes) then presented unsent letters as delivered.
--
-- sent_at becomes nullable with no default. The claim INSERT stays without a
-- sent_at (NULL from here on), in-tick failed/suppressed settles never touch
-- it, and only a successful delivery stamps it: the email worker's
-- staged→sent settle (markDunningClaimSent) and the runner's
-- accepted-evidence reconciliation. sent_at IS NULL now means "never
-- delivered". Readers order NULLS LAST, the fired set stays status-based
-- (status = 'sent'), so the cadence counts from the last actual send and a
-- failed attempt simply retries the same rung.
--
-- Backfill: only demonstrably unsent rows are cleared — status in (staged,
-- suppressed, failed) with sent_at still populated AND no delivery evidence
-- in email_log under any occurrence key the claim ever used. That is the same
-- trichotomy the runner reconciles from (dunning.ts readDunningDeliveryVerdict):
-- an accepted delivery (a sent email_log row, a provider message id, a
-- sent_at stamp, or a sent outcome in the append-only attempt lineage) or an
-- UNRESOLVED one (an uncertain row or lineage outcome, or a dangling
-- "started" event whose worker never reported back and may have transmitted
-- before it died) is evidence the letter went out or may have — those rows
-- are not demonstrably unsent and are preserved for the runner's
-- reconciliation. Only rejected-or-absent rows (every recorded delivery
-- definitively failed, or never attempted at all) are cleared. Rows with
-- status sent/skipped are historical delivery evidence and are preserved
-- exactly. Every cleared row gains one audit_log row carrying its before
-- image, the way 0277 records demotions.
--
-- The lifecycle guard (dunning_log_guard) refuses any staged→staged write,
-- including a sent_at-only correction, so the correction runs under the
-- guard's own bypass (SET LOCAL app.bypass_rls) inside this migration's
-- transaction; the setting reverts at COMMIT. Forced RLS under some roles
-- would otherwise match zero rows silently, so the bypass makes the write
-- deterministic too. The UPDATE re-checks status and sent_at (rather than
-- trusting the snapshot alone) so a worker settle landing mid-migration is
-- never overwritten.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.dunning_log ALTER COLUMN sent_at DROP DEFAULT;
ALTER TABLE public.dunning_log ALTER COLUMN sent_at DROP NOT NULL;

SET LOCAL app.bypass_rls = 'on';

-- Replay-safe scratch: a lock_timeout retry replays the whole body in a new
-- transaction after rolling the failed attempt back, so start clean.
DROP TABLE IF EXISTS pg_temp.dunning_sent_at_cleared;

CREATE TEMPORARY TABLE dunning_sent_at_cleared AS
SELECT dl.id, dl.org_id, dl.sent_at AS before_sent_at
  FROM public.dunning_log dl
 WHERE dl.sent_at IS NOT NULL
   AND dl.status IN ('staged', 'suppressed', 'failed')
   AND NOT EXISTS (
     SELECT 1
       FROM public.email_log e
      WHERE e.org_id = dl.org_id
        AND e.meta ->> 'dunningLogId' = dl.id::text
        AND (e.status = 'sent'
             OR e.provider_message_id IS NOT NULL
             OR e.sent_at IS NOT NULL
             -- A sent outcome anywhere in the append-only attempt lineage.
             OR EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.meta -> 'attempts') = 'array' THEN e.meta -> 'attempts' ELSE '[]'::jsonb END) a
                WHERE a ->> 'outcome' = 'sent'
             )
             -- Unresolved acceptance: the letter may already have gone out.
             OR e.status = 'uncertain'
             OR EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.meta -> 'attempts') = 'array' THEN e.meta -> 'attempts' ELSE '[]'::jsonb END) a
                WHERE a ->> 'outcome' = 'uncertain'
             )
             -- A dangling "started" event: the worker was lost mid-flight and
             -- may have transmitted before it died. Decided outcomes
             -- (sent/notSent/uncertain) for the same numeric attempt close
             -- the gap; anything else leaves it unresolved.
             OR EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.meta -> 'attempts') = 'array' THEN e.meta -> 'attempts' ELSE '[]'::jsonb END) s
                WHERE s ->> 'outcome' = 'started'
                  AND (s ->> 'attempt') ~ '^-?[0-9]+$'
                  AND NOT EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.meta -> 'attempts') = 'array' THEN e.meta -> 'attempts' ELSE '[]'::jsonb END) d
                     WHERE (d ->> 'attempt') ~ '^-?[0-9]+$'
                       AND (d ->> 'attempt')::integer = (s ->> 'attempt')::integer
                       AND d ->> 'outcome' IN ('sent', 'notSent', 'uncertain')
                  )
             ))
   );

-- The status/sent_at re-check is the concurrency fence: under READ COMMITTED
-- a worker settle that committed after the snapshot above re-qualifies here,
-- so a genuine delivery stamp is never nulled by this migration.
UPDATE public.dunning_log dl
   SET sent_at = NULL
  FROM dunning_sent_at_cleared c
 WHERE c.id = dl.id
   AND dl.sent_at IS NOT NULL
   AND dl.status IN ('staged', 'suppressed', 'failed');

INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
SELECT c.org_id, 'dunning_log', c.id, 'update',
       jsonb_build_object(
         'before', jsonb_build_object('sent_at', c.before_sent_at),
         'after', jsonb_build_object('sent_at', NULL),
         'reason', 'migration 0329: staged/suppressed/failed claim carried a claim-time sent_at with no delivery evidence in email_log; cleared so sent_at is delivery evidence only'),
       NULL
  FROM dunning_sent_at_cleared c
  JOIN public.dunning_log dl ON dl.id = c.id
 WHERE dl.sent_at IS NULL;

DROP TABLE dunning_sent_at_cleared;
