-- OpenBooks forward migration 0062_recognition_events.
--
-- Milestone and usage recognition methods are selectable in the Company Setup
-- recognition rule picker but have no event subledger. When an obligation
-- carries a milestone or usage rule, buildRecognitionScheduleOn computes a
-- zero-line plan because no events are ever loaded, and runRevenueRecognition
-- permanently reports "no recognition events recorded" — the invoiced amount
-- sits parked in deferred revenue indefinitely.
--
-- This migration adds the recognition_events table: one row per milestone
-- achievement or metered-usage occurrence, keyed to the obligation and
-- accounting period. The engine loads these events when building a
-- milestone/usage schedule, producing one schedule line per event instead of
-- the current zero-line schedule.
--
-- This is an additive-only change: no existing tables are modified and no
-- history is rewritten.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.recognition_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    obligation_id uuid NOT NULL,
    period_month text NOT NULL,
    amount numeric(19,4) NOT NULL,
    description text,
    source_reference text,
    unit_rate numeric(19,4),
    quantity numeric(19,4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE public.recognition_events
    ADD CONSTRAINT recognition_events_pkey PRIMARY KEY (id);

CREATE INDEX rec_events_obligation ON public.recognition_events USING btree (obligation_id);

CREATE INDEX rec_events_period ON public.recognition_events USING btree (period_month);

ALTER TABLE public.recognition_events
    ADD CONSTRAINT recognition_events_obligation_id_fkey
    FOREIGN KEY (obligation_id)
    REFERENCES public.performance_obligations (id)
    ON DELETE CASCADE;

ALTER TABLE public.recognition_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON public.recognition_events
    AS permissive
    FOR all
    TO openbooks_app
    USING ((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))
    WITH CHECK ((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)));

COMMENT ON TABLE public.recognition_events IS
  'openbooks:recognition_events:v1 - milestone and usage recognition event subledger; one row per recognized occurrence, consumed by buildRecognitionScheduleOn for milestone/usage rules';

COMMENT ON COLUMN public.recognition_events.period_month IS 'Accounting month (YYYY-MM-01) the event belongs to; drives which schedule line the event lands on';

COMMENT ON COLUMN public.recognition_events.amount IS 'Amount to recognize in this period; for milestone events this is the milestone value, for usage events this is quantity * unit_rate';
