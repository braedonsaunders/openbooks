-- Preserve wage and billing policy identities once time or financial lines reference them.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE FUNCTION public.time_type_financial_semantics_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
    tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)
  ) THEN RETURN OLD; END IF;

  IF TG_OP = 'UPDATE' AND
    ROW(NEW.id, NEW.org_id, NEW.classification, NEW.cost_multiplier, NEW.bill_multiplier, NEW.exclude_from_wages)
    IS NOT DISTINCT FROM
    ROW(OLD.id, OLD.org_id, OLD.classification, OLD.cost_multiplier, OLD.bill_multiplier, OLD.exclude_from_wages)
  THEN RETURN NEW; END IF;

  IF EXISTS (SELECT 1 FROM public.time_entries WHERE org_id = OLD.org_id AND time_type_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.document_lines WHERE org_id = OLD.org_id AND time_type_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.pay_stub_lines WHERE org_id = OLD.org_id AND time_type_id = OLD.id)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'time_type_historical_policy',
      MESSAGE = 'This time type is already referenced by recorded time or financial lines. Preserve its wage and billing semantics; create a new time type for future work.';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER time_type_financial_semantics_guard
BEFORE UPDATE OR DELETE ON public.time_types
FOR EACH ROW EXECUTE FUNCTION public.time_type_financial_semantics_guard();

-- First use and policy edits serialize on the same definition row. A type cannot
-- change between recording an hour and its later wage or billing interpretation.
CREATE FUNCTION public.time_type_reference_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.time_type_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.org_id, NEW.time_type_id)
    IS NOT DISTINCT FROM ROW(OLD.org_id, OLD.time_type_id) THEN RETURN NEW; END IF;
  PERFORM id FROM public.time_types
    WHERE org_id = NEW.org_id AND id = NEW.time_type_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'The selected time type does not exist in this organization.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER time_entry_type_reference_lock
BEFORE INSERT OR UPDATE OF org_id, time_type_id ON public.time_entries
FOR EACH ROW EXECUTE FUNCTION public.time_type_reference_lock();
CREATE TRIGGER document_line_type_reference_lock
BEFORE INSERT OR UPDATE OF org_id, time_type_id ON public.document_lines
FOR EACH ROW EXECUTE FUNCTION public.time_type_reference_lock();
CREATE TRIGGER pay_stub_line_type_reference_lock
BEFORE INSERT OR UPDATE OF org_id, time_type_id ON public.pay_stub_lines
FOR EACH ROW EXECUTE FUNCTION public.time_type_reference_lock();
