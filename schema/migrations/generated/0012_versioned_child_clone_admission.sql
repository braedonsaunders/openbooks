-- Let a deterministic organization clone copy the targets and components of published versions.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- Allocation rule targets, subscription plan version components, rate
-- adjustment targets and landed-cost voucher targets may change only while
-- their parent version, adjustment or voucher is a draft. A clone copies
-- published and posted history verbatim, so each guard admits inserts made
-- under the clone transaction's authority, as the other posted-history guards
-- do. A sandbox teardown may remove allocation rule targets of published
-- versions, as it already may for the other three. Every other write keeps
-- its checks.

CREATE OR REPLACE FUNCTION public.allocation_rule_target_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_status text;
  v_version uuid;
begin
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;

  v_version := coalesce(new.version_id, old.version_id);
  select status into v_status from public.allocation_rule_versions where id = v_version;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'allocation rule version % is %; its targets are immutable', v_version, v_status;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;


CREATE OR REPLACE FUNCTION public.subscription_version_component_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE parent_version uuid; parent_status text;
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  parent_version := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  SELECT status INTO parent_status FROM subscription_plan_versions WHERE id=parent_version;
  IF parent_status IN ('published','superseded') THEN
    RAISE EXCEPTION 'components of published subscription plan versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;


CREATE OR REPLACE FUNCTION public.rate_adjustment_target_version_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_status text;
  v_org_id uuid;
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;

  SELECT version.status, adjustment.org_id
    INTO v_status, v_org_id
    FROM labor_rate_adjustments adjustment
    JOIN item_rate_versions version
      ON version.id = adjustment.version_id
     AND version.org_id = adjustment.org_id
   WHERE adjustment.id = coalesce(NEW.adjustment_id, OLD.adjustment_id);
  IF v_status IS NULL
     OR v_org_id IS DISTINCT FROM coalesce(NEW.org_id, OLD.org_id) THEN
    RAISE EXCEPTION 'adjustment target must reference a tenant-owned rate version'
      USING ERRCODE = '23514';
  END IF;
  IF v_status <> 'draft' THEN
    IF TG_OP = 'DELETE'
       AND openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'targets of an activated or retired rate version are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;


CREATE OR REPLACE FUNCTION public.landed_cost_voucher_target_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  parent_status text;
  parent_org uuid;
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;

  SELECT status, org_id
    INTO parent_status, parent_org
    FROM landed_cost_vouchers
   WHERE id = coalesce(NEW.voucher_id, OLD.voucher_id);
  IF TG_OP = 'DELETE' AND parent_status IS NULL THEN RETURN OLD; END IF;
  IF parent_status IS NULL
     OR parent_org IS DISTINCT FROM coalesce(NEW.org_id, OLD.org_id) THEN
    RAISE EXCEPTION 'landed-cost target must reference a tenant-owned voucher';
  END IF;
  IF parent_status <> 'draft' THEN
    IF TG_OP = 'DELETE'
       AND openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'targets of a posted landed-cost voucher are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
