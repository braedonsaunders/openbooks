-- OpenBooks forward migration 0055_flow_scheduled_occurrence_durability.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- The scheduled-flow runner advanced flows.last_scheduled_run_at in one
-- statement and only THEN created the flow_runs evidence (and enqueued the
-- emails) for that occurrence. A crash inside the gap — after the cursor
-- advanced, before any flow_run_effects row committed — permanently lost the
-- occurrence: the next tick's anchor was already past it, so no email or
-- notification would ever go out, and nothing recorded that it should have.
--
-- This table is the per-occurrence ledger that closes that window: cursor
-- advance and claim insert commit in ONE statement (the same CLAIM contract
-- as the scheduled-script runner), one row per (flow, trigger node,
-- occurrence fire time). A crashed firing leaves its claim open with
-- attempt accounting; the recovery pass re-fires from the ledger — bounded
-- attempts, then a visible terminal loss instead of a silent skip.
--
-- Retry safety is storage-enforced on flow_runs itself: occurrences carry a
-- deterministic `occurrence_key` (unique when present, derived from
-- flow/node/occurrence/subject). A resumed attempt adopts the SAME flow_runs
-- row as the crashed attempt, which makes every downstream identity stable:
-- effect checkpoints are keyed `${flow_id}:action:${node_id}` under that
-- run id and email deferrals collapse onto their scheduler_outbox
-- occurrence key `${run_id}:email:${node_id}` — so a retry can never
-- double-send.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.flow_runs
    ADD COLUMN IF NOT EXISTS occurrence_key text;

CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_occurrence_key_unique
  ON public.flow_runs USING btree (occurrence_key)
 WHERE occurrence_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.flow_scheduled_occurrences (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    flow_id uuid NOT NULL,
    node_id text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    status text NOT NULL DEFAULT 'open',
    attempt_count integer DEFAULT 0 NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.flow_scheduled_occurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.flow_scheduled_occurrences ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'flow_scheduled_occurrences_pkey'
  ) THEN
    ALTER TABLE ONLY public.flow_scheduled_occurrences
      ADD CONSTRAINT flow_scheduled_occurrences_pkey PRIMARY KEY (id);
  END IF;
END
$$;

-- Exactly one claim per (flow, trigger node, occurrence): concurrent tick
-- scanners lose this race cleanly via ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS flow_scheduled_occurrences_once
  ON public.flow_scheduled_occurrences USING btree (flow_id, node_id, occurred_at);
CREATE INDEX IF NOT EXISTS flow_scheduled_occurrences_recovery
  ON public.flow_scheduled_occurrences USING btree (status, updated_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'flow_scheduled_occurrence_org_fk'
  ) THEN
    ALTER TABLE ONLY public.flow_scheduled_occurrences
      ADD CONSTRAINT flow_scheduled_occurrence_org_fk
      FOREIGN KEY (org_id) REFERENCES public.orgs(id) DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'flow_scheduled_occurrence_flow_fk'
  ) THEN
    ALTER TABLE ONLY public.flow_scheduled_occurrences
      ADD CONSTRAINT flow_scheduled_occurrence_flow_fk
      FOREIGN KEY (flow_id) REFERENCES public.flows(id) ON DELETE CASCADE DEFERRABLE;
  END IF;
END
$$;

COMMENT ON TABLE public.flow_scheduled_occurrences IS
  'Per-occurrence durability ledger for scheduled flows. Claimed atomically with the last_scheduled_run_at cursor advance; a crashed firing is re-fired from this ledger by the recovery pass, and flow_runs.occurrence_key makes the resumed attempt adopt the same run (storage-enforced no-double-send).';
