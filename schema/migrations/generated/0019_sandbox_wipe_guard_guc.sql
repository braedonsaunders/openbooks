-- OpenBooks forward migration 0019_sandbox_wipe_guard_guc.
--
-- Sandbox teardown has always set `openbooks.sandbox_wipe`, but five guards
-- from the prerelease baseline read `app.sandbox_wipe`. Migration 0006 made
-- one of those guards accept both names; existing databases still retain the
-- other four drifted bodies, and a fresh database retains all five historical
-- definitions until it reaches this migration. Replace the complete set here
-- so every wipe-exempt guard reads the one GUC the teardown paths set.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.subscription_amendment_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('openbooks.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF OLD.status='applied' THEN RAISE EXCEPTION 'applied subscription amendments are immutable'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION public.subscription_period_invoice_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('openbooks.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION 'subscription period invoice lineage is immutable';
END $$;

CREATE OR REPLACE FUNCTION public.subscription_plan_version_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('openbooks.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF OLD.status IN ('published','superseded') THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'published subscription plan versions are immutable'; END IF;
    IF ROW(OLD.plan_id,OLD.effective_from,OLD.name,OLD.description,OLD.currency_code,OLD.interval,OLD.interval_count,OLD.billing_timing,OLD.published_at,OLD.published_by)
      IS DISTINCT FROM ROW(NEW.plan_id,NEW.effective_from,NEW.name,NEW.description,NEW.currency_code,NEW.interval,NEW.interval_count,NEW.billing_timing,NEW.published_at,NEW.published_by)
    THEN RAISE EXCEPTION 'published subscription plan commercial terms are immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.subscription_version_component_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE parent_version uuid; parent_status text;
BEGIN
  IF current_setting('openbooks.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  parent_version := CASE WHEN TG_OP='DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  SELECT status INTO parent_status FROM subscription_plan_versions WHERE id=parent_version;
  IF parent_status IN ('published','superseded') THEN RAISE EXCEPTION 'components of published subscription plan versions are immutable'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION public.wip_prebill_event_append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('openbooks.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION 'WIP prebill events are append-only';
END $$;
