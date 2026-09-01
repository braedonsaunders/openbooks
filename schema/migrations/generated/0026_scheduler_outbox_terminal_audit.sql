-- OpenBooks forward migration 0026_scheduler_outbox_terminal_audit.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- The scheduler outbox stamps terminal_failed_at / terminal_failed_by onto
-- poison rows (0008/0035) but treats the mutable work row itself as the whole
-- durable record: nothing independent proved that a poison occurrence died,
-- crash recovery at the ceiling wrote no evidence of its own, and no authorized
-- replay contract existed — so a reset was either unsafe or unlogged, and the
-- stamps stayed rewritable by any writer that dared. This migration gives
-- every terminal transition independent append-only evidence:
--
--   * scheduler_outbox_terminal_audit — one immutable event row per terminal
--     transition or authorized replay, written by the worker inside the same
--     transaction as the stamp it certifies. System-wide scan kinds carry no
--     tenant; their evidence is kept verbatim with a NULL org so system poison
--     is as well-documented as tenant poison.
--   * exactly-once uniqueness per occurrence/event class — storage refuses a
--     second terminalization or a second replay authorization for one row.
--   * pre-existing stamped rows are backfilled into this channel before any
--     enforcement turns on, with their provenance recorded rather than guessed.
--   * scheduler_outbox_terminal_guard — once stamped, a scheduler_outbox row
--     cannot be rewritten again without the replay pin, and clearing the
--     stamps additionally requires the prior replay_authorized evidence to be
--     visible inside the same transaction: an unevidenced reset commits nothing.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Append-only terminal evidence for scheduler_outbox poison transitions.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scheduler_outbox_terminal_audit (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    outbox_row_id uuid NOT NULL,
    event text NOT NULL,
    org_id uuid,
    kind text NOT NULL,
    subject_id uuid,
    occurrence_key text NOT NULL,
    attempt_count integer NOT NULL,
    reason text,
    marked_by text NOT NULL,
    at timestamp with time zone NOT NULL DEFAULT now(),
    recorded_at timestamp with time zone NOT NULL DEFAULT now(),
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT scheduler_outbox_terminal_audit_pkey PRIMARY KEY (id),
    CONSTRAINT scheduler_outbox_terminal_audit_event CHECK (
      event = ANY (ARRAY[
        'terminal_failure'::text,
        'crash_recovery_terminal_failure'::text,
        'replay_authorized'::text
      ])
    ),
    CONSTRAINT scheduler_outbox_terminal_audit_attempts_nonnegative CHECK ((attempt_count >= 0))
);

ALTER TABLE public.scheduler_outbox_terminal_audit FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'org_isolation'
       AND polrelid = 'public.scheduler_outbox_terminal_audit'::regclass
  ) THEN
    CREATE POLICY org_isolation ON public.scheduler_outbox_terminal_audit
      USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text)
              OR ((org_id)::text = current_setting('app.current_org'::text, true))))
      WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text)
              OR ((org_id)::text = current_setting('app.current_org'::text, true))));
  END IF;
END
$$;

COMMENT ON POLICY org_isolation ON public.scheduler_outbox_terminal_audit IS 'openbooks:org_isolation:v1';

CREATE OR REPLACE FUNCTION public.scheduler_outbox_terminal_audit_append_only_guard()
RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'scheduler_outbox_terminal_audit is append-only';
END $$;

DROP TRIGGER IF EXISTS scheduler_outbox_terminal_audit_append_only
  ON public.scheduler_outbox_terminal_audit;

CREATE TRIGGER scheduler_outbox_terminal_audit_append_only
  BEFORE UPDATE OR DELETE ON public.scheduler_outbox_terminal_audit
  FOR EACH ROW EXECUTE FUNCTION public.scheduler_outbox_terminal_audit_append_only_guard();

-- Exactly one terminal-failure record and one replay authorization may ever
-- exist for one outbox occurrence: the unique indexes turn any regression or
-- repeated recovery that would duplicate them into a loud, rolled-back write
-- instead of silent double-bookkeeping.
CREATE UNIQUE INDEX IF NOT EXISTS scheduler_outbox_terminal_audit_one_failure
  ON public.scheduler_outbox_terminal_audit USING btree (outbox_row_id)
  WHERE event <> 'replay_authorized';
CREATE UNIQUE INDEX IF NOT EXISTS scheduler_outbox_terminal_audit_one_replay
  ON public.scheduler_outbox_terminal_audit USING btree (outbox_row_id)
  WHERE event = 'replay_authorized';

CREATE INDEX IF NOT EXISTS scheduler_outbox_terminal_audit_at
  ON public.scheduler_outbox_terminal_audit USING btree (at);

COMMENT ON TABLE public.scheduler_outbox_terminal_audit IS
  'Append-only audit evidence for scheduler_outbox terminal failures and authorized replays. One terminal-failure row per poisoned occurrence, written transactionally with its terminal stamp.';
COMMENT ON COLUMN public.scheduler_outbox_terminal_audit.outbox_row_id IS
  'The poisoned scheduler_outbox.id this evidence certifies.';
COMMENT ON COLUMN public.scheduler_outbox_terminal_audit.event IS
  'terminal_failure (attempt ceiling), crash_recovery_terminal_failure (stale lease recovered at the ceiling), or replay_authorized.';
COMMENT ON COLUMN public.scheduler_outbox_terminal_audit.reason IS
  'The final error on terminal paths, or the operator-supplied justification on a replay.';
COMMENT ON COLUMN public.scheduler_outbox_terminal_audit.marked_by IS
  'System identity that produced the transition, or the replaying user id.';
COMMENT ON COLUMN public.scheduler_outbox_terminal_audit.detail IS
  'Verbatim before/after envelope: status, attempts, stamps, kind and occurrence identity.';

-- ---------------------------------------------------------------------------
-- Replay authorization gate. Mirrors openbooks_sandbox_wipe_allowed's GUC
-- discipline: the engine''s replay routine pins exactly one organization for
-- the life of its own transaction (set_config(..., is_local => true)), so
-- leaked session state can never authorize another tenant's reset.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.openbooks_scheduler_outbox_replay_allowed(p_org_id uuid)
RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT coalesce(
    p_org_id IS NOT NULL
    AND coalesce(current_setting('openbooks.scheduler_outbox_replay_org', true), '') <> ''
    AND current_setting('openbooks.scheduler_outbox_replay_org', true) = p_org_id::text,
    false
  )
$$;

COMMENT ON FUNCTION public.openbooks_scheduler_outbox_replay_allowed(uuid) IS
  'True only inside a transaction whose replay routine pinned this exact organization.';

-- Once stamped, a scheduler_outbox row's audit-bearing facts freeze: the org,
-- kind, subject, occurrence key, and payload an evidence row certified cannot
-- be rewritten, and the stamps themselves cannot move — the ordinary worker
-- code path has no authority over any of it, and only the pinned replay
-- transaction — after writing its replay_authorized evidence — may clear the
-- stamps. Operational fields (status, error, backoff) stay worker-owned so
-- crash recovery and drained retries never wedge behind the guard.
CREATE OR REPLACE FUNCTION public.scheduler_outbox_terminal_guard()
RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_frozen boolean;
BEGIN
  IF OLD.terminal_failed_at IS NULL THEN
    RETURN NEW;
  END IF;
  v_frozen :=
    NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
    OR NEW.occurrence_key IS DISTINCT FROM OLD.occurrence_key
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.terminal_failed_at IS DISTINCT FROM OLD.terminal_failed_at
    OR NEW.terminal_failed_by IS DISTINCT FROM OLD.terminal_failed_by;
  IF NOT v_frozen THEN
    RETURN NEW;
  END IF;
  IF NEW.terminal_failed_at IS NOT DISTINCT FROM OLD.terminal_failed_at
     AND NEW.terminal_failed_by IS NOT DISTINCT FROM OLD.terminal_failed_by THEN
    -- Only non-stamp frozen facts moved; nothing authorizes those either.
    RAISE EXCEPTION 'scheduler_outbox terminal-failure evidence is immutable; authorize a replay to reset it';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.scheduler_outbox_terminal_audit prior
     WHERE prior.outbox_row_id = OLD.id
       AND prior.event = 'replay_authorized'
  ) THEN
    RAISE EXCEPTION 'a scheduler_outbox replay reset requires its replay_authorized audit evidence first';
  END IF;
  IF public.openbooks_scheduler_outbox_replay_allowed(OLD.org_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'a scheduler_outbox replay reset requires its organization''s authorization pin';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS scheduler_outbox_terminal_guard_trigger
  ON public.scheduler_outbox;

CREATE TRIGGER scheduler_outbox_terminal_guard_trigger
  BEFORE UPDATE ON public.scheduler_outbox
  FOR EACH ROW EXECUTE FUNCTION public.scheduler_outbox_terminal_guard();

COMMENT ON FUNCTION public.scheduler_outbox_terminal_guard() IS
  'Freezes the audit-bearing facts of stamped scheduler_outbox rows; clearing the stamps requires prior replay evidence plus the transaction-scoped authorization pin.';

-- ---------------------------------------------------------------------------
-- Backfill: rows stamped before this migration receive their terminal-failure
-- evidence now, marked as migrated so their provenance stays auditable. The
-- anti-join makes the backfill idempotent; system scan rows (NULL org) are
-- migrated too because poison does not need a tenant to deserve evidence.
-- ---------------------------------------------------------------------------

INSERT INTO public.scheduler_outbox_terminal_audit
  (outbox_row_id, event, org_id, kind, subject_id, occurrence_key,
   attempt_count, reason, marked_by, at, recorded_at, detail)
SELECT o.id,
       'terminal_failure',
       o.org_id,
       o.kind,
       o.subject_id,
       o.occurrence_key,
       o.attempt_count,
       coalesce(o.error, 'terminal failure surfaced by migration'),
       o.terminal_failed_by,
       o.terminal_failed_at,
       now(),
       jsonb_build_object(
         'event', 'scheduler_outbox_terminal_failure',
         'path', 'pre_0026_backfill',
         'status', o.status,
         'attemptCount', o.attempt_count,
         'kind', o.kind,
         'occurrenceKey', o.occurrence_key,
         'terminalFailedAt', o.terminal_failed_at,
         'terminalFailedBy', o.terminal_failed_by
       )
  FROM public.scheduler_outbox o
 WHERE o.terminal_failed_at IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM public.scheduler_outbox_terminal_audit prior
      WHERE prior.outbox_row_id = o.id
        AND prior.event <> 'replay_authorized'
   );
