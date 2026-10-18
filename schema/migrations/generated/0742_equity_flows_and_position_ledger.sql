-- Equity approvals through optional Flows, and the cap table position ledger.
--
-- Governed equity actions (voids, reversals, repurchases, SAFE and note
-- repayments and cancellations, class amendments, splits, plan reserve
-- changes, MFN elections, stock compensation and note interest runs, and
-- equity account policy versions) are recorded as action requests and
-- submitted to any enabled Equity action Flow. When a Flow raises an
-- approval gate the request waits for its decision and is applied, on the
-- requester's authority, when the gate approves; when no Flow gates it, it is
-- applied at once and records that no approval applied. A request is
-- retained history: it changes only once, from pending to applied or
-- rejected.
--
-- The position ledger records the cap table as append-only movements: one
-- row per change of a certificate's, award's or plan pool's position, with
-- its effective date, its change in outstanding shares (restated through
-- splits) and its change as converted into common. The sum of a position's
-- movements effective on or before a date is its position on that date.
-- Every equity write reconciles the ledger to the replayed history in the
-- same transaction.
--
-- Backfill: equity_position_movements for history recorded before this
-- migration, computed by public.equity_position_backfill from the recorded
-- securities, events, splits, amendments, plans and reserve changes with
-- the cap table's own rules (exact split restatement, conversion ratios and
-- plan recycling).
SET statement_timeout = 0;
SET lock_timeout = '10s';
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.equity_action_requests (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 action text NOT NULL,
 subject_id uuid,
 subject_label text NOT NULL,
 effective_on date NOT NULL,
 reason text,
 payload jsonb NOT NULL,
 summary jsonb NOT NULL DEFAULT '{}'::jsonb,
 status text NOT NULL,
 released_without_approval boolean NOT NULL DEFAULT false,
 requested_by uuid NOT NULL,
 decided_by uuid,
 decided_at timestamptz,
 decision_comment text,
 result jsonb,
 applied_at timestamptz,
 idempotency_key text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT equity_action_requests_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_action_requests_idempotency_unique UNIQUE (org_id, idempotency_key),
 CONSTRAINT equity_action_requests_action CHECK (action IN (
  'void', 'reverse', 'repurchase', 'repay', 'cancel_convertible', 'class_amendment', 'split', 'reserve_change',
  'mfn_election', 'compensation_run', 'interest_run', 'account_policy')),
 CONSTRAINT equity_action_requests_status CHECK (status IN ('pending_approval', 'applied', 'rejected')),
 CONSTRAINT equity_action_requests_label CHECK (length(btrim(subject_label)) BETWEEN 1 AND 200),
 CONSTRAINT equity_action_requests_reason CHECK (reason IS NULL OR length(reason) <= 2000),
 CONSTRAINT equity_action_requests_payload CHECK (jsonb_typeof(payload) = 'object' AND jsonb_typeof(summary) = 'object'),
 CONSTRAINT equity_action_requests_decision CHECK (
  (status = 'pending_approval' AND decided_by IS NULL AND decided_at IS NULL AND applied_at IS NULL AND result IS NULL AND NOT released_without_approval)
  OR (status = 'applied' AND applied_at IS NOT NULL AND result IS NOT NULL
      AND ((released_without_approval AND decided_by IS NULL AND decided_at IS NULL)
        OR (NOT released_without_approval AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decided_by <> requested_by)))
  OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decided_by <> requested_by
      AND length(btrim(decision_comment)) BETWEEN 1 AND 2000 AND applied_at IS NULL AND NOT released_without_approval)),
 CONSTRAINT equity_action_requests_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT equity_action_requests_requested_by_fkey FOREIGN KEY (org_id, requested_by) REFERENCES public.users(org_id, id),
 CONSTRAINT equity_action_requests_decided_by_fkey FOREIGN KEY (org_id, decided_by) REFERENCES public.users(org_id, id)
);
CREATE INDEX equity_action_requests_pending ON public.equity_action_requests (org_id, subsidiary_id, status, created_at);
CREATE INDEX equity_action_requests_subject ON public.equity_action_requests (org_id, subject_id) WHERE subject_id IS NOT NULL;

-- A request is decided once: pending to applied (with or without an
-- approval) or rejected, recording the decision and its result and nothing
-- else. Rows leave only through tenant retirement or an approved sandbox
-- wipe.
CREATE FUNCTION public.equity_action_request_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Equity action requests are retained history.' USING ERRCODE='23514';
 END IF;
 IF OLD.status <> 'pending_approval' OR NEW.status = 'pending_approval'
    OR (to_jsonb(NEW) - ARRAY['status','released_without_approval','decided_by','decided_at','decision_comment','result','applied_at'])
       <> (to_jsonb(OLD) - ARRAY['status','released_without_approval','decided_by','decided_at','decision_comment','result','applied_at']) THEN
  RAISE EXCEPTION 'An equity action request is decided once, from pending approval to applied or rejected.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE TABLE public.equity_position_movements (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 position_kind text NOT NULL,
 security_id uuid,
 plan_id uuid,
 effective_on date NOT NULL,
 shares_delta bigint NOT NULL,
 as_converted_delta bigint NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT equity_position_movements_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_position_movements_kind CHECK (position_kind IN ('share', 'award', 'pool')),
 CONSTRAINT equity_position_movements_subject CHECK (
  (position_kind = 'pool' AND plan_id IS NOT NULL AND security_id IS NULL)
  OR (position_kind <> 'pool' AND security_id IS NOT NULL AND plan_id IS NULL)),
 CONSTRAINT equity_position_movements_delta CHECK (shares_delta <> 0 OR as_converted_delta <> 0),
 CONSTRAINT equity_position_movements_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT equity_position_movements_security_fkey FOREIGN KEY (org_id, subsidiary_id, security_id)
  REFERENCES public.equity_securities(org_id, subsidiary_id, id),
 CONSTRAINT equity_position_movements_plan_fkey FOREIGN KEY (org_id, subsidiary_id, plan_id)
  REFERENCES public.equity_plans(org_id, subsidiary_id, id)
);
CREATE INDEX equity_position_movements_entity ON public.equity_position_movements (org_id, subsidiary_id, effective_on);
CREATE INDEX equity_position_movements_security ON public.equity_position_movements (org_id, security_id) WHERE security_id IS NOT NULL;
CREATE INDEX equity_position_movements_plan ON public.equity_position_movements (org_id, plan_id) WHERE plan_id IS NOT NULL;

DO $tables$
DECLARE target record;
BEGIN
 FOR target IN SELECT * FROM (VALUES
('equity_action_requests', 'equity_action_request_guard'),
('equity_position_movements', 'equity_record_immutable')
 ) AS expected(table_name, guard) LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true))) WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true)))', target.table_name);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''', target.table_name);
  EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()', target.table_name);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()', target.table_name || '_immutable', target.table_name, target.guard);
 END LOOP;
END $tables$;

-- Exact rational arithmetic for the backfill: numerator and denominator are
-- whole numerics, reduced by their greatest common divisor.
CREATE FUNCTION public.equity_position_split_factor(p_org uuid, p_class uuid, p_after date, p_through date, OUT num numeric, OUT den numeric)
LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
DECLARE split record;
BEGIN
 num := 1; den := 1;
 FOR split IN SELECT ratio_numerator, ratio_denominator FROM equity_splits
   WHERE org_id = p_org AND share_class_id = p_class AND effective_on > p_after AND effective_on <= p_through LOOP
  num := num * split.ratio_numerator; den := den * split.ratio_denominator;
 END LOOP;
END $$;

CREATE FUNCTION public.equity_position_floor(p_num numeric, p_den numeric) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path=public,pg_catalog AS $$
 SELECT (CASE WHEN p_num < 0 AND mod(p_num, p_den) <> 0 THEN div(p_num, p_den) - 1 ELSE div(p_num, p_den) END)::bigint
$$;

-- The common class a preferred class converts into on a date (the latest
-- conversion-class amendment, else the class's own term).
CREATE FUNCTION public.equity_position_conversion_class(p_org uuid, p_class uuid, p_on date) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
DECLARE cls record; amendment record; target uuid; stated date;
BEGIN
 SELECT * INTO cls FROM equity_share_classes WHERE org_id = p_org AND id = p_class;
 IF cls.kind <> 'preferred' THEN RETURN NULL; END IF;
 target := cls.conversion_share_class_id; stated := cls.effective_on;
 FOR amendment IN SELECT * FROM equity_class_amendments WHERE org_id = p_org AND share_class_id = p_class
   AND kind = 'conversion_class' AND effective_on <= p_on ORDER BY created_at, id LOOP
  IF amendment.effective_on >= stated THEN target := amendment.conversion_share_class_id; stated := amendment.effective_on; END IF;
 END LOOP;
 RETURN target;
END $$;

-- Common shares one share of a class converts into on a date: the original
-- issue price over the conversion price, both restated through the class's
-- splits, the price also divided by adjusting splits of its conversion class.
CREATE FUNCTION public.equity_position_ratio(p_org uuid, p_class uuid, p_on date, OUT num numeric, OUT den numeric)
LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
DECLARE cls record; amendment record; split record; price numeric; stated date; f_stated record; f_effective record; g numeric;
BEGIN
 SELECT * INTO cls FROM equity_share_classes WHERE org_id = p_org AND id = p_class;
 IF cls.kind = 'common' THEN num := 1; den := 1; RETURN; END IF;
 price := cls.initial_conversion_price; stated := cls.effective_on;
 FOR amendment IN SELECT * FROM equity_class_amendments WHERE org_id = p_org AND share_class_id = p_class
   AND kind = 'conversion_price' AND effective_on <= p_on ORDER BY created_at, id LOOP
  IF amendment.effective_on >= stated THEN price := amendment.conversion_price; stated := amendment.effective_on; END IF;
 END LOOP;
 SELECT * INTO f_stated FROM public.equity_position_split_factor(p_org, p_class, stated, p_on);
 SELECT * INTO f_effective FROM public.equity_position_split_factor(p_org, p_class, cls.effective_on, p_on);
 -- Prices carry ten places: scale them to whole numbers.
 num := (cls.original_issue_price * 10000000000) * f_stated.num * f_effective.den;
 den := (price * 10000000000) * f_stated.den * f_effective.num;
 IF cls.conversion_adjusts_for_splits THEN
  FOR split IN SELECT * FROM equity_splits WHERE org_id = p_org AND share_class_id <> p_class
    AND effective_on > stated AND effective_on <= p_on ORDER BY effective_on, created_at, id LOOP
   IF public.equity_position_conversion_class(p_org, p_class, split.effective_on) = split.share_class_id THEN
    num := num * split.ratio_numerator; den := den * split.ratio_denominator;
   END IF;
  END LOOP;
 END IF;
 g := gcd(num, den); num := num / g; den := den / g;
END $$;

-- Outstanding shares of a certificate or award on a date, restated through
-- its class's splits: the issued quantity less every live consuming event.
CREATE FUNCTION public.equity_position_outstanding(p_org uuid, p_security uuid, p_on date) RETURNS bigint
LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
DECLARE sec record; ev record; f record; num numeric; den numeric; g numeric;
BEGIN
 SELECT * INTO sec FROM equity_securities WHERE org_id = p_org AND id = p_security;
 IF sec.quantity IS NULL OR sec.share_class_id IS NULL OR p_on < sec.issue_date THEN RETURN 0; END IF;
 IF EXISTS (SELECT 1 FROM equity_security_events WHERE org_id = p_org AND security_id = p_security AND kind = 'void' AND effective_on <= p_on) THEN RETURN 0; END IF;
 SELECT * INTO f FROM public.equity_position_split_factor(p_org, sec.share_class_id, sec.issue_date, p_on);
 num := sec.quantity * f.num; den := f.den;
 FOR ev IN SELECT e.* FROM equity_security_events e
   WHERE e.org_id = p_org AND e.security_id = p_security AND e.effective_on <= p_on AND e.quantity IS NOT NULL
     AND e.kind IN ('exercise', 'settle', 'forfeit', 'expire', 'cancel', 'repurchase', 'transfer', 'convert')
     AND NOT EXISTS (SELECT 1 FROM equity_security_events r WHERE r.org_id = p_org AND r.kind = 'reverse'
       AND r.reverses_event_id = e.id AND r.effective_on <= p_on)
     AND NOT (e.resulting_security_id IS NOT NULL AND EXISTS (SELECT 1 FROM equity_security_events v WHERE v.org_id = p_org
       AND v.kind = 'void' AND v.security_id = e.resulting_security_id AND v.effective_on <= p_on)) LOOP
  SELECT * INTO f FROM public.equity_position_split_factor(p_org, sec.share_class_id, ev.effective_on, p_on);
  num := num * f.den - ev.quantity * f.num * den;
  den := den * f.den;
  g := gcd(num, den); IF g > 1 THEN num := num / g; den := den / g; END IF;
 END LOOP;
 RETURN public.equity_position_floor(num, den);
END $$;

-- A plan pool's unallocated shares on a date: the reserve less awards
-- granted, plus units returned under the plan's recycling terms, restated
-- exactly and rounded down once, never below zero.
CREATE FUNCTION public.equity_position_pool(p_org uuid, p_plan uuid, p_on date) RETURNS bigint
LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
DECLARE plan record; item record; f record; num numeric := 0; den numeric := 1; g numeric; available bigint; sign_ integer; returns_ boolean;
BEGIN
 SELECT * INTO plan FROM equity_plans WHERE org_id = p_org AND id = p_plan;
 IF p_on < plan.effective_on THEN RETURN 0; END IF;
 -- Each term: (quantity stated on a date) × splits after it, signed.
 FOR item IN
   SELECT plan.initial_reserved_shares AS quantity, plan.effective_on AS stated_on, 1 AS sign_
   UNION ALL
   SELECT c.share_delta, c.effective_on, 1 FROM equity_plan_reserve_changes c
    WHERE c.org_id = p_org AND c.plan_id = p_plan AND c.effective_on <= p_on
   UNION ALL
   -- Awards granted, unless voided by the date.
   SELECT s.quantity, s.issue_date, -1 FROM equity_securities s
    WHERE s.org_id = p_org AND s.plan_id = p_plan AND s.quantity IS NOT NULL AND s.issue_date <= p_on
      AND NOT EXISTS (SELECT 1 FROM equity_security_events v WHERE v.org_id = p_org AND v.security_id = s.id AND v.kind = 'void' AND v.effective_on <= p_on)
   UNION ALL
   -- Units returned: forfeited, cancelled and expired awards, and repurchased award shares, per the recycling terms.
   SELECT e.quantity, e.effective_on, 1 FROM equity_security_events e
     JOIN equity_securities s ON s.org_id = e.org_id AND s.id = e.security_id
    WHERE e.org_id = p_org AND e.effective_on <= p_on AND e.quantity IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM equity_security_events r WHERE r.org_id = p_org AND r.kind = 'reverse' AND r.reverses_event_id = e.id AND r.effective_on <= p_on)
      AND (
        (s.plan_id = p_plan AND s.quantity IS NOT NULL AND s.issue_date <= p_on
          AND NOT EXISTS (SELECT 1 FROM equity_security_events v WHERE v.org_id = p_org AND v.security_id = s.id AND v.kind = 'void' AND v.effective_on <= p_on)
          AND ((e.kind IN ('forfeit', 'cancel') AND plan.recycle_forfeited) OR (e.kind = 'expire' AND plan.recycle_expired)))
        OR (s.kind = 'share' AND e.kind = 'repurchase' AND plan.recycle_repurchased
          AND NOT (s.plan_id IS NOT DISTINCT FROM p_plan)
          AND EXISTS (SELECT 1 FROM equity_securities a WHERE a.org_id = p_org AND a.id = s.source_security_id
            AND a.plan_id = p_plan AND a.quantity IS NOT NULL AND a.issue_date <= p_on)))
 LOOP
  SELECT * INTO f FROM public.equity_position_split_factor(p_org, plan.share_class_id, item.stated_on, p_on);
  num := num * f.den + item.sign_ * item.quantity * f.num * den;
  den := den * f.den;
  g := gcd(num, den); IF g > 1 THEN num := num / g; den := den / g; END IF;
 END LOOP;
 available := public.equity_position_floor(num, den);
 RETURN greatest(available, 0);
END $$;

-- The movements that reproduce a legal entity's positions on every dated
-- record, as the position ledger stores them. p_apply records them; the
-- entity must not yet carry movements.
CREATE FUNCTION public.equity_position_backfill(p_org uuid, p_subsidiary uuid, p_apply boolean)
RETURNS TABLE (position_kind text, security_id uuid, plan_id uuid, effective_on date, shares_delta bigint, as_converted_delta bigint)
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE pos record; d date; shares bigint; converted bigint; prev_shares bigint; prev_converted bigint; r record; class_id uuid;
BEGIN
 IF p_apply AND EXISTS (SELECT 1 FROM equity_position_movements m WHERE m.org_id = p_org AND m.subsidiary_id = p_subsidiary) THEN
  RAISE EXCEPTION 'The position ledger of this legal entity already carries movements.' USING ERRCODE='23514';
 END IF;
 FOR pos IN
   SELECT CASE WHEN s.kind = 'share' THEN 'share' ELSE 'award' END AS kind, s.id AS sec, NULL::uuid AS plan, s.share_class_id AS cls, s.issue_date AS start_on
     FROM equity_securities s WHERE s.org_id = p_org AND s.subsidiary_id = p_subsidiary AND s.quantity IS NOT NULL AND s.share_class_id IS NOT NULL
   UNION ALL
   SELECT 'pool', NULL::uuid, p.id, p.share_class_id, p.effective_on
     FROM equity_plans p WHERE p.org_id = p_org AND p.subsidiary_id = p_subsidiary
   ORDER BY 5, 2, 3
 LOOP
  prev_shares := 0; prev_converted := 0;
  FOR d IN
    SELECT x.on_date FROM (
      SELECT issue_date AS on_date FROM equity_securities WHERE org_id = p_org AND subsidiary_id = p_subsidiary
      UNION SELECT e.effective_on FROM equity_security_events e WHERE e.org_id = p_org AND e.subsidiary_id = p_subsidiary
      UNION SELECT sp.effective_on FROM equity_splits sp WHERE sp.org_id = p_org AND sp.subsidiary_id = p_subsidiary
      UNION SELECT a.effective_on FROM equity_class_amendments a WHERE a.org_id = p_org AND a.subsidiary_id = p_subsidiary
      UNION SELECT c.effective_on FROM equity_plan_reserve_changes c WHERE c.org_id = p_org AND c.subsidiary_id = p_subsidiary
      UNION SELECT pl.effective_on FROM equity_plans pl WHERE pl.org_id = p_org AND pl.subsidiary_id = p_subsidiary
      UNION SELECT cl.effective_on FROM equity_share_classes cl WHERE cl.org_id = p_org AND cl.subsidiary_id = p_subsidiary
    ) x WHERE x.on_date >= pos.start_on ORDER BY 1
  LOOP
   IF pos.kind = 'pool' THEN shares := public.equity_position_pool(p_org, pos.plan, d);
   ELSE shares := public.equity_position_outstanding(p_org, pos.sec, d);
   END IF;
   IF shares = 0 THEN converted := 0;
   ELSE
    SELECT * INTO r FROM public.equity_position_ratio(p_org, pos.cls, d);
    converted := public.equity_position_floor(shares * r.num, r.den);
   END IF;
   IF shares <> prev_shares OR converted <> prev_converted THEN
    position_kind := pos.kind; security_id := pos.sec; plan_id := pos.plan; effective_on := d;
    shares_delta := shares - prev_shares; as_converted_delta := converted - prev_converted;
    IF p_apply THEN
     INSERT INTO equity_position_movements (org_id, subsidiary_id, position_kind, security_id, plan_id, effective_on, shares_delta, as_converted_delta)
     VALUES (p_org, p_subsidiary, pos.kind, pos.sec, pos.plan, d, shares - prev_shares, converted - prev_converted);
    END IF;
    RETURN NEXT;
    prev_shares := shares; prev_converted := converted;
   END IF;
  END LOOP;
 END LOOP;
END $$;

SELECT count(*) FROM (
 SELECT entity.org_id, entity.subsidiary_id
   FROM (SELECT DISTINCT org_id, subsidiary_id FROM public.equity_securities
         UNION SELECT DISTINCT org_id, subsidiary_id FROM public.equity_plans) entity
) entities, LATERAL public.equity_position_backfill(entities.org_id, entities.subsidiary_id, true);

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in) VALUES
 ('equity_action_requests', '0742_equity_flows_and_position_ledger'),
 ('equity_position_movements', '0742_equity_flows_and_position_ledger')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
