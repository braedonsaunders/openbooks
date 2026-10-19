-- Statutory liabilities use country-pack component accounts as their sole configuration source.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

DO $$
DECLARE
  tenant record;
  mapping record;
  component record;
  configured_account uuid;
  retained_value text;
  after_component jsonb;
  after_payroll jsonb;
  evidence_id uuid;
BEGIN
  FOR tenant IN
    SELECT id, settings->'payroll' AS payroll FROM public.orgs
    WHERE (settings->'payroll') ?| ARRAY[
      'cppPayableAccountId','eiPayableAccountId','taxPayableAccountId','vacationPayableAccountId']
    ORDER BY id FOR UPDATE
  LOOP
    FOR mapping IN SELECT * FROM (VALUES
      ('cppPayableAccountId', ARRAY['cpp','cpp2']::text[]),
      ('eiPayableAccountId', ARRAY['ei','qpip']::text[]),
      ('taxPayableAccountId', ARRAY['income_tax']::text[]),
      ('vacationPayableAccountId', ARRAY['vacation_accrual']::text[])
    ) AS mappings(key, system_keys)
    LOOP
      retained_value := tenant.payroll->>mapping.key;
      IF retained_value IS NULL THEN CONTINUE; END IF;
      FOR component IN
        SELECT p.id, to_jsonb(p) AS before_value FROM public.pay_components p
        WHERE p.org_id=tenant.id AND p.country='CA' AND p.is_active
          AND p.system_key=ANY(mapping.system_keys) AND p.liability_account_id IS NULL
        ORDER BY p.id FOR UPDATE
      LOOP
        SELECT a.id INTO configured_account FROM public.accounts a
        WHERE a.org_id=tenant.id AND a.id::text=lower(retained_value)
          AND a.is_active AND NOT a.is_summary
          AND a.type IN ('liability_payable','liability_current_other')
        FOR SHARE;
        IF configured_account IS NULL THEN
          RAISE EXCEPTION 'Payroll setting % cannot configure its native component for organization %; map the statutory slot in Payroll setup before retrying the native upgrade', mapping.key, tenant.id;
        END IF;
        UPDATE public.pay_components p SET liability_account_id=configured_account,
          updated_at=clock_timestamp(), updated_by=NULL
        WHERE p.org_id=tenant.id AND p.id=component.id AND p.liability_account_id IS NULL
        RETURNING to_jsonb(p) INTO after_component;
        IF after_component IS NULL THEN
          RAISE EXCEPTION 'The native statutory component changed during payroll configuration normalization';
        END IF;
        INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
        VALUES(tenant.id,'pay_components',component.id,'update',jsonb_build_object(
          'before',component.before_value,'after',after_component,
          'reason','Retain the configured statutory liability on its native country-pack component'),NULL)
        RETURNING id INTO evidence_id;
        IF evidence_id IS NULL THEN RAISE EXCEPTION 'The statutory component configuration audit was not saved'; END IF;
      END LOOP;
    END LOOP;
    after_payroll := tenant.payroll - ARRAY[
      'cppPayableAccountId','eiPayableAccountId','taxPayableAccountId','vacationPayableAccountId'];
    UPDATE public.orgs SET settings=jsonb_set(settings,'{payroll}',after_payroll)
    WHERE id=tenant.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'The organization payroll configuration was not saved'; END IF;
    INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
    VALUES(tenant.id,'orgs',tenant.id,'update',jsonb_build_object(
      'before',jsonb_build_object('payroll',tenant.payroll),
      'after',jsonb_build_object('payroll',after_payroll),
      'reason','Use native country-pack component accounts for statutory liabilities'),NULL)
    RETURNING id INTO evidence_id;
    IF evidence_id IS NULL THEN RAISE EXCEPTION 'The organization payroll configuration audit was not saved'; END IF;
  END LOOP;
END $$;
