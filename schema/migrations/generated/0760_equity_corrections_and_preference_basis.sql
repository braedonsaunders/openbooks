-- Equity corrections: instrument balance attributions, MFN election
-- reversals, financing round amendments and voids, and the basis of a
-- preferred class's liquidation preference.
--
-- Equity journal lines that carry an instrument balance (an early-exercise
-- deposit, accrued note interest) name their security on the line. A tenant
-- copied from another environment received its securities under rebased
-- identities, while lines copied before copies rebased that identity still
-- name the source environment's security. Posted lines are never edited:
-- equity_instrument_line_attributions records, per such line, the security
-- the line belongs to in this tenant, and every instrument balance reads the
-- attribution in preference to the line's own identity.
--
-- An MFN election recorded in error is reversed by a new
-- equity_security_amendments row of kind 'mfn_reversal' that names the
-- election it undoes and the terms the SAFE carries again.
--
-- A financing round's terms are corrected, or the round voided, by
-- equity_round_amendments rows; the round reads with its latest amendment
-- applied and a voided round leaves every figure. A round records why its
-- pre-money valuation is stated on a basis other than its price times the
-- fully diluted shares before it, when it is.
--
-- A preferred class measures its liquidation preference on the amount paid
-- for each certificate (a SAFE or note conversion's converted amount) or on
-- its original issue price. Classes recorded before this choice existed take
-- the amount paid, the standard term for shares a convertible bought.
--
-- The new governed actions (MFN election reversals, round amendments and
-- voids) join the equity action request vocabulary, and a tenant copy's
-- financial-history admission expects each copied equity line to name its
-- security's rebased identity.
--
-- Backfill: attributions for equity journal lines of copied tenants whose
-- identity resolves, through the tenant's copy chain, to one of its
-- securities in the line's legal entity; lines that resolve to none are left
-- as recorded.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.equity_share_classes
 ADD COLUMN liquidation_preference_basis text NOT NULL DEFAULT 'amount_paid',
 ADD CONSTRAINT equity_share_classes_preference_basis CHECK (liquidation_preference_basis IN ('original_issue_price', 'amount_paid'));

ALTER TABLE public.equity_financing_rounds
 ADD COLUMN pre_money_basis_reason text,
 ADD CONSTRAINT equity_financing_rounds_pre_money_basis CHECK (pre_money_basis_reason IS NULL OR length(btrim(pre_money_basis_reason)) BETWEEN 5 AND 2000);

ALTER TABLE public.equity_security_amendments
 ADD COLUMN reverses_amendment_id uuid,
 DROP CONSTRAINT equity_security_amendments_kind,
 DROP CONSTRAINT equity_security_amendments_terms,
 ADD CONSTRAINT equity_security_amendments_kind CHECK (kind IN ('mfn_election', 'mfn_reversal')),
 ADD CONSTRAINT equity_security_amendments_terms CHECK (
  (kind = 'mfn_election' AND reverses_amendment_id IS NULL AND (valuation_cap IS NOT NULL OR discount_percent IS NOT NULL))
  OR (kind = 'mfn_reversal' AND reverses_amendment_id IS NOT NULL AND reverses_amendment_id IS DISTINCT FROM id)),
 ADD CONSTRAINT equity_security_amendments_reverses_fkey FOREIGN KEY (org_id, reverses_amendment_id) REFERENCES public.equity_security_amendments(org_id, id);
CREATE UNIQUE INDEX equity_security_amendments_one_reversal ON public.equity_security_amendments (org_id, reverses_amendment_id) WHERE reverses_amendment_id IS NOT NULL;

ALTER TABLE public.equity_action_requests
 DROP CONSTRAINT equity_action_requests_action,
 ADD CONSTRAINT equity_action_requests_action CHECK (action IN (
  'void', 'reverse', 'repurchase', 'repay', 'cancel_convertible', 'class_amendment', 'split', 'reserve_change',
  'mfn_election', 'mfn_reversal', 'compensation_run', 'interest_run', 'account_policy', 'round_amendment', 'round_void'));

CREATE TABLE public.equity_round_amendments (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 round_id uuid NOT NULL,
 kind text NOT NULL,
 effective_on date NOT NULL,
 name text,
 price_per_share numeric(28,10),
 pre_money_valuation numeric(19,4),
 pre_money_basis_reason text,
 reason text NOT NULL,
 idempotency_key text,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_round_amendments_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_round_amendments_idempotency_unique UNIQUE (org_id, idempotency_key),
 CONSTRAINT equity_round_amendments_kind CHECK (kind IN ('amend', 'void')),
 CONSTRAINT equity_round_amendments_terms CHECK (
  (kind = 'void' AND name IS NULL AND price_per_share IS NULL AND pre_money_valuation IS NULL AND pre_money_basis_reason IS NULL)
  OR (kind = 'amend' AND (name IS NOT NULL OR price_per_share IS NOT NULL OR pre_money_valuation IS NOT NULL))),
 CONSTRAINT equity_round_amendments_name CHECK (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 200),
 CONSTRAINT equity_round_amendments_price CHECK (price_per_share IS NULL OR price_per_share > 0),
 CONSTRAINT equity_round_amendments_pre_money CHECK (pre_money_valuation IS NULL OR pre_money_valuation > 0),
 CONSTRAINT equity_round_amendments_basis CHECK (pre_money_basis_reason IS NULL OR (pre_money_valuation IS NOT NULL AND length(btrim(pre_money_basis_reason)) BETWEEN 5 AND 2000)),
 CONSTRAINT equity_round_amendments_reason CHECK (length(btrim(reason)) BETWEEN 5 AND 2000),
 CONSTRAINT equity_round_amendments_round_fkey FOREIGN KEY (org_id, subsidiary_id, round_id)
  REFERENCES public.equity_financing_rounds(org_id, subsidiary_id, id),
 CONSTRAINT equity_round_amendments_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);
CREATE INDEX equity_round_amendments_round ON public.equity_round_amendments (org_id, round_id, created_at);
CREATE UNIQUE INDEX equity_round_amendments_one_void ON public.equity_round_amendments (org_id, round_id) WHERE kind = 'void';

CREATE TABLE public.equity_instrument_line_attributions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 journal_entry_id uuid NOT NULL,
 journal_line_id uuid NOT NULL,
 security_id uuid NOT NULL,
 role text NOT NULL,
 recorded_identity text NOT NULL,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_instrument_line_attributions_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_instrument_line_attributions_line_unique UNIQUE (org_id, journal_line_id),
 CONSTRAINT equity_instrument_line_attributions_role CHECK (role IN ('deposit', 'interest')),
 CONSTRAINT equity_instrument_line_attributions_reason CHECK (length(btrim(reason)) BETWEEN 5 AND 2000),
 CONSTRAINT equity_instrument_line_attributions_entry_fkey FOREIGN KEY (org_id, journal_entry_id) REFERENCES public.journal_entries(org_id, id),
 CONSTRAINT equity_instrument_line_attributions_line_fkey FOREIGN KEY (org_id, journal_line_id) REFERENCES public.journal_lines(org_id, id),
 CONSTRAINT equity_instrument_line_attributions_security_fkey FOREIGN KEY (org_id, subsidiary_id, security_id)
  REFERENCES public.equity_securities(org_id, subsidiary_id, id),
 CONSTRAINT equity_instrument_line_attributions_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);
CREATE INDEX equity_instrument_line_attributions_security ON public.equity_instrument_line_attributions (org_id, security_id, role);

-- A copy rebases the security identity an equity line names, masked or
-- not (the identity holds no personal data), so the financial-history clone
-- admission expects that rebased identity on the copied line. The installed
-- body is patched in place and verified against its published digest before
-- and after.
DO $clone_equity_identities$
DECLARE proc record; replacement text;
BEGIN
 SELECT p.oid,p.prosrc INTO STRICT proc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='financial_history_native_clone_matches' AND p.pronargs=2;
 IF encode(public.digest(proc.prosrc,'sha256'),'hex')='4b6adc81110b7ae52766b73186265a2c0d01a43e0bfc45881d647d1586537bc3' THEN
  RETURN; -- expected on replay: the identity rebasing is already installed
 END IF;
 IF encode(public.digest(proc.prosrc,'sha256'),'hex')<>'3ed67fd21acf0cf5db9fa8c2837e1848a78af5437525ca85cd94a085633fb939' THEN
  RAISE EXCEPTION 'financial_history_native_clone_matches differs from its published definition; reconcile it before applying this migration' USING ERRCODE='55000';
 END IF;
 replacement:=replace(proc.prosrc,$anchor$ IF relation='public.journal_lines'::regclass AND target.masked THEN
  expected:=jsonb_set(expected,'{custom}','{}'::jsonb);
 END IF;$anchor$,$block$ IF relation='public.journal_lines'::regclass AND coalesce(original->'custom'->>'equitySecurityId','') ~ '^[0-9a-fA-F-]{36}$' THEN
  expected:=jsonb_set(expected,'{custom}',(CASE WHEN target.masked THEN '{}'::jsonb ELSE original->'custom' END)
   || jsonb_build_object('equitySecurityId',public.ob_rebase((original->'custom'->>'equitySecurityId')::uuid,target.sandbox_seed)::text,
      'equityRole',original->'custom'->'equityRole'));
 ELSIF relation='public.journal_lines'::regclass AND target.masked THEN
  expected:=jsonb_set(expected,'{custom}','{}'::jsonb);
 END IF;$block$);
 IF encode(public.digest(replacement,'sha256'),'hex')<>'4b6adc81110b7ae52766b73186265a2c0d01a43e0bfc45881d647d1586537bc3' THEN
  RAISE EXCEPTION 'financial_history_native_clone_matches identity rebasing differs from its published body' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(pg_get_functiondef(proc.oid),proc.prosrc,replacement);
END $clone_equity_identities$;

DO $tables$
DECLARE target record;
BEGIN
 FOR target IN SELECT * FROM (VALUES
('equity_round_amendments'),
('equity_instrument_line_attributions')
 ) AS expected(table_name) LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true))) WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true)))', target.table_name);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''', target.table_name);
  EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()', target.table_name);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.equity_record_immutable()', target.table_name || '_immutable', target.table_name);
 END LOOP;
END $tables$;

-- The security a copied tenant's equity line identity names: the identity
-- rebased through the tenant's copy chain (its own copy seed, then its
-- source environment's, oldest first), when that names one of the tenant's
-- securities. Null when no step of the chain resolves.
CREATE FUNCTION public.equity_copied_security(p_org uuid, p_identity uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
DECLARE seeds uuid[] := '{}'; current_org uuid := p_org; source_org uuid; seed uuid; depth integer; step integer; candidate uuid;
BEGIN
 FOR depth IN 1..8 LOOP
  SELECT o.sandbox_seed, o.sandbox_of INTO seed, source_org FROM orgs o WHERE o.id = current_org;
  EXIT WHEN seed IS NULL;
  seeds := seeds || seed;
  EXIT WHEN source_org IS NULL;
  current_org := source_org;
 END LOOP;
 FOR depth IN 1..coalesce(array_length(seeds, 1), 0) LOOP
  candidate := p_identity;
  FOR step IN REVERSE depth..1 LOOP
   candidate := public.ob_rebase(candidate, seeds[step]);
  END LOOP;
  IF EXISTS (SELECT 1 FROM equity_securities s WHERE s.org_id = p_org AND s.id = candidate) THEN RETURN candidate; END IF;
 END LOOP;
 RETURN NULL;
END $$;

-- Attribute every equity line of a tenant whose identity names no security
-- of the tenant but resolves through its copy chain to one in the line's
-- legal entity. Returns the attributions recorded.
CREATE FUNCTION public.equity_attribute_copied_instrument_lines(p_org uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE recorded integer;
BEGIN
 INSERT INTO equity_instrument_line_attributions (org_id, subsidiary_id, journal_entry_id, journal_line_id, security_id, role, recorded_identity, reason)
 SELECT resolved.org_id, resolved.subsidiary_id, resolved.entry_id, resolved.line_id, resolved.security_id, resolved.role, resolved.identity,
        'The line was copied from another environment under its source identity; the copy chain resolves it to this security.'
   FROM (
    SELECT l.org_id, e.subsidiary_id, e.id AS entry_id, l.id AS line_id, l.custom->>'equityRole' AS role, l.custom->>'equitySecurityId' AS identity,
           public.equity_copied_security(l.org_id, (l.custom->>'equitySecurityId')::uuid) AS security_id
      FROM journal_entries e
      JOIN journal_lines l ON l.org_id = e.org_id AND l.entry_id = e.id
     WHERE e.org_id = p_org AND e.origin = 'equity'
       AND (l.custom->>'equitySecurityId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND l.custom->>'equityRole' IN ('deposit', 'interest')
       AND NOT EXISTS (SELECT 1 FROM equity_securities own WHERE own.org_id = l.org_id AND own.id = (l.custom->>'equitySecurityId')::uuid)
       AND NOT EXISTS (SELECT 1 FROM equity_instrument_line_attributions a WHERE a.org_id = l.org_id AND a.journal_line_id = l.id)
   ) resolved
   JOIN equity_securities s ON s.org_id = resolved.org_id AND s.id = resolved.security_id AND s.subsidiary_id = resolved.subsidiary_id;
 GET DIAGNOSTICS recorded = ROW_COUNT;
 RETURN recorded;
END $$;

SELECT count(*) FROM (
 SELECT public.equity_attribute_copied_instrument_lines(o.id) FROM public.orgs o
  WHERE o.sandbox_seed IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.journal_entries e WHERE e.org_id = o.id AND e.origin = 'equity')
) attributed;

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in) VALUES
 ('equity_round_amendments', '0760_equity_corrections_and_preference_basis'),
 ('equity_instrument_line_attributions', '0760_equity_corrections_and_preference_basis')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
