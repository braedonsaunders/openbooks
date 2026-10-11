-- Registered sandbox copies preserve exact recorded financial history and tenant-linked parents.
-- Ordinary writes retain financial validation and all update/delete protections.
-- Backfill: none. Retained financial rows and published migrations are unchanged.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE FUNCTION public.financial_history_clone_scope(source_scope text,seed uuid) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $$
BEGIN
 IF source_scope='all' THEN RETURN source_scope; END IF;
 IF source_scope ~ '^period:[0-9a-f-]{36}$' THEN
  RETURN 'period:'||public.ob_rebase(split_part(source_scope,':',2)::uuid,seed);
 END IF;
 IF source_scope ~ '^year:[0-9a-f-]{36}:[0-9]+$' THEN
  RETURN 'year:'||public.ob_rebase(split_part(source_scope,':',2)::uuid,seed)||':'||split_part(source_scope,':',3);
 END IF;
 RAISE EXCEPTION 'The retained GL audit scope has no native period or fiscal-year identity.' USING ERRCODE='23514';
END $$;

CREATE FUNCTION public.financial_history_native_clone_matches(relation regclass,candidate jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $function$
DECLARE target record; original jsonb; expected jsonb; field record; reference record;
 parent_matches boolean; parent_predicate text; policy_prefix text; relation_name text;
BEGIN
 IF NOT public.openbooks_clone_authority() OR relation NOT IN (
  'public.fx_rate_types'::regclass,'public.account_translation_policies'::regclass,
  'public.subsidiary_accounting_preferences'::regclass,'public.segment_balancing_policies'::regclass,
  'public.gl_audit_number_policies'::regclass,'public.gl_audit_number_assignments'::regclass,
  'public.journal_lines'::regclass,'public.rebate_agreements'::regclass) THEN RETURN false; END IF;
 SELECT destination.id,destination.sandbox_of,destination.sandbox_seed,control.masked INTO target
 FROM public.orgs destination JOIN public.sandboxes control
  ON control.org_id=destination.id AND control.production_org_id=destination.sandbox_of
 JOIN public.orgs source ON source.id=destination.sandbox_of AND source.id<>destination.id
 WHERE destination.id=(candidate->>'org_id')::uuid AND destination.env_kind='sandbox'
  AND destination.sandbox_seed IS NOT NULL AND control.status IN('provisioning','refreshing');
 IF NOT FOUND THEN RETURN false; END IF;
 EXECUTE format('SELECT to_jsonb(source) FROM %s source WHERE source.org_id=$1 AND public.ob_rebase(source.id,$2)=$3',relation)
 INTO original USING target.sandbox_of,target.sandbox_seed,(candidate->>'id')::uuid;
 IF original IS NULL THEN RETURN false; END IF;
 SELECT relname INTO relation_name FROM pg_catalog.pg_class WHERE oid=relation;
 expected:=original;
 FOR field IN SELECT attname,atttypid FROM pg_catalog.pg_attribute
  WHERE attrelid=relation AND attnum>0 AND NOT attisdropped LOOP
  IF field.attname='org_id' THEN
   expected:=jsonb_set(expected,ARRAY[field.attname],to_jsonb(target.id));
  ELSIF field.atttypid='uuid'::regtype AND jsonb_typeof(original->field.attname)='string' THEN
   expected:=jsonb_set(expected,ARRAY[field.attname],to_jsonb(public.ob_rebase((original->>field.attname)::uuid,target.sandbox_seed)));
  END IF;
  IF target.masked AND field.attname IN('name','reason','memo') AND jsonb_typeof(original->field.attname)='string' THEN
   expected:=jsonb_set(expected,ARRAY[field.attname],to_jsonb('REDACTED'::text));
  END IF;
 END LOOP;
 IF relation='public.journal_lines'::regclass AND target.masked THEN
  expected:=jsonb_set(expected,'{custom}','{}'::jsonb);
 END IF;
 IF relation='public.gl_audit_number_assignments'::regclass THEN
  SELECT prefix INTO policy_prefix FROM public.gl_audit_number_policies
   WHERE org_id=target.sandbox_of AND id=(original->>'policy_id')::uuid;
  IF policy_prefix IS NULL THEN RETURN false; END IF;
  expected:=jsonb_set(expected,'{scope_key}',to_jsonb(public.financial_history_clone_scope(original->>'scope_key',target.sandbox_seed)));
  expected:=jsonb_set(expected,'{audit_number}',to_jsonb(policy_prefix||'-'||replace(expected->>'scope_key',':','-')||'-'||
   lpad(original->>'ordinal',greatest(6,length(original->>'ordinal')),'0')));
 END IF;
 IF candidate IS DISTINCT FROM expected THEN RETURN false; END IF;
 -- Validate the complete referenced parent identity, including composite tenant keys,
 -- before admitting a recorded fact under its sandbox counterpart.
 FOR reference IN SELECT con.oid,con.confrelid FROM pg_catalog.pg_constraint con
  WHERE con.conrelid=relation AND con.contype='f' LOOP
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_constraint con
   JOIN pg_catalog.pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=ANY(con.conkey)
   WHERE con.oid=reference.oid AND (candidate->a.attname IS NULL OR candidate->a.attname='null'::jsonb)) THEN CONTINUE; END IF;
  SELECT string_agg(format('parent.%I=($1->>%L)::%s',parent_column.attname,source_column.attname,
    pg_catalog.format_type(source_column.atttypid,source_column.atttypmod)),' AND ' ORDER BY position)
   INTO parent_predicate FROM pg_catalog.pg_constraint con
   CROSS JOIN LATERAL generate_subscripts(con.conkey,1) position
   JOIN pg_catalog.pg_attribute source_column ON source_column.attrelid=con.conrelid AND source_column.attnum=con.conkey[position]
   JOIN pg_catalog.pg_attribute parent_column ON parent_column.attrelid=con.confrelid AND parent_column.attnum=con.confkey[position]
   WHERE con.oid=reference.oid;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=reference.confrelid AND attname='org_id' AND NOT attisdropped) THEN
   parent_predicate:=parent_predicate||' AND parent.org_id=($1->>''org_id'')::uuid';
  END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s parent WHERE %s)',reference.confrelid::regclass,parent_predicate)
   INTO parent_matches USING candidate;
  IF NOT parent_matches THEN RETURN false; END IF;
 END LOOP;
 -- Legacy policy actor columns predate their explicit foreign keys.
 IF relation_name IN('fx_rate_types','account_translation_policies','subsidiary_accounting_preferences','segment_balancing_policies','gl_audit_number_policies') THEN
  IF EXISTS(SELECT 1 FROM unnest(ARRAY[candidate->>'created_by',candidate->>'updated_by']) actor(id)
   WHERE actor.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.users u WHERE u.org_id=target.id AND u.id=actor.id::uuid)) THEN RETURN false; END IF;
 END IF;
 RETURN true;
END $function$;

CREATE FUNCTION public.financial_history_seeded_rate_clone_conflict(existing jsonb,candidate jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
BEGIN
 IF candidate->>'key' NOT IN('spot','average','historical') OR
  existing->>'key' IS DISTINCT FROM candidate->>'key' OR existing->>'org_id' IS DISTINCT FROM candidate->>'org_id' OR
  existing->>'is_active'<>'true' OR existing->>'name' IS DISTINCT FROM
   CASE candidate->>'key' WHEN 'spot' THEN 'Spot' WHEN 'average' THEN 'Average' ELSE 'Historical' END OR
  existing->>'created_by' IS NOT NULL OR existing->>'updated_by' IS NOT NULL OR
  NOT public.financial_history_native_clone_matches('public.fx_rate_types'::regclass,candidate) THEN
  RAISE EXCEPTION 'A sandbox rate registry collision is not a native seeded built-in. Preserve the destination definitions and refresh through the native lifecycle.' USING ERRCODE='23514';
 END IF;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.financial_preferences_version_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  IF public.financial_history_native_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Financial history clone admission requires the exact registered source row, seed and destination parents.' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:ledger-setup:'||NEW.org_id,0));
 IF TG_TABLE_NAME='account_translation_policies' THEN
  IF NOT EXISTS(SELECT 1 FROM accounts WHERE org_id=NEW.org_id AND id=NEW.account_id AND is_active AND NOT is_summary AND type<>'statistical') THEN
   RAISE EXCEPTION 'Choose an active monetary posting account for a translation policy.' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.org_id=l.org_id AND e.id=l.entry_id
    WHERE l.org_id=NEW.org_id AND l.account_id=NEW.account_id AND e.status IN('posted','reversed') AND e.posting_date>=NEW.effective_from) THEN
   RAISE EXCEPTION 'A translation policy cannot reinterpret posted activity. Start after the latest posting on this account.' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.fiscal_calendar_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fiscal_calendars WHERE org_id=NEW.org_id AND id=NEW.fiscal_calendar_id AND is_active) THEN
   RAISE EXCEPTION 'Choose an active fiscal calendar of this organization.' USING ERRCODE='23514'; END IF;
  IF coalesce(NEW.fiscal_calendar_id,(SELECT id FROM fiscal_calendars WHERE org_id=NEW.org_id AND is_default AND is_active)) IS DISTINCT FROM public.subsidiary_posting_calendar(NEW.org_id,NEW.subsidiary_id,NEW.effective_from-1) AND (
    NOT EXISTS(SELECT 1 FROM accounting_periods p WHERE p.org_id=NEW.org_id AND p.fiscal_calendar_id=coalesce(NEW.fiscal_calendar_id,(SELECT id FROM fiscal_calendars WHERE org_id=NEW.org_id AND is_default AND is_active)) AND NOT p.is_adjustment AND p.starts_on=NEW.effective_from)
    OR EXISTS(SELECT 1 FROM accounting_periods p WHERE p.org_id=NEW.org_id AND p.fiscal_calendar_id=public.subsidiary_posting_calendar(NEW.org_id,NEW.subsidiary_id,NEW.effective_from-1)
      AND NOT p.is_adjustment AND p.starts_on<NEW.effective_from AND p.ends_on>=NEW.effective_from)) THEN
   RAISE EXCEPTION 'Change fiscal calendars at a shared regular-period boundary. Generate the new calendar periods and choose the first day after the old period ends.' USING ERRCODE='23514'; END IF;
  IF NEW.default_journal_form_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM form_layouts WHERE org_id=NEW.org_id AND id=NEW.default_journal_form_id AND record_type='journal' AND is_active) THEN
   RAISE EXCEPTION 'Choose an active journal form of this organization.' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM fx_rate_types WHERE org_id=NEW.org_id AND key=NEW.posting_rate_type AND is_active) THEN
   RAISE EXCEPTION 'Choose an active posting exchange-rate type.' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.org_id=l.org_id AND e.id=l.entry_id
    WHERE l.org_id=NEW.org_id AND l.subsidiary_id=NEW.subsidiary_id AND e.status IN('posted','reversed') AND e.posting_date>=NEW.effective_from) THEN
   RAISE EXCEPTION 'An entity preference cannot reinterpret posted activity. Start after the latest posting for this entity.' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.segment_balancing_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  IF public.financial_history_native_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Financial history clone admission requires the exact registered source row, seed and destination parents.' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:ledger-setup:'||NEW.org_id,0));
 IF NOT EXISTS(SELECT 1 FROM segment_definitions WHERE org_id=NEW.org_id AND key=NEW.segment_key AND is_active AND is_balancing) THEN
  RAISE EXCEPTION 'Choose an active balancing segment.' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM accounts WHERE org_id=NEW.org_id AND id=NEW.clearing_account_id AND is_active AND NOT is_summary
   AND currency_restriction IS NULL AND type IN('asset_current_other','asset_other','liability_current_other','liability_long_term')) THEN
  RAISE EXCEPTION 'Choose an unrestricted active balance-sheet clearing account.' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM journal_entries WHERE org_id=NEW.org_id AND status IN('posted','reversed') AND posting_date>=NEW.effective_from) THEN
  RAISE EXCEPTION 'Start the balancing policy after the latest posting date; posted entries retain their original balancing policy.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.gl_audit_number_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  IF public.financial_history_native_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Financial history clone admission requires the exact registered source row, seed and destination parents.' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:ledger-setup:'||NEW.org_id,0));
 IF EXISTS(SELECT 1 FROM gl_audit_number_assignments n JOIN accounting_periods p ON p.org_id=n.org_id AND p.id=n.period_id
   WHERE n.org_id=NEW.org_id AND n.subsidiary_id=NEW.subsidiary_id AND p.ends_on>=NEW.effective_from) THEN
  RAISE EXCEPTION 'Audit numbering policy changes start after the latest numbered period.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.gl_audit_number_assignment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE policy gl_audit_number_policies%ROWTYPE; period accounting_periods%ROWTYPE; expected_scope text;
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  IF public.financial_history_native_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Financial history clone admission requires the exact registered source row, seed and destination parents.' USING ERRCODE='23514';
 END IF;
 PERFORM period_posting_fence(NEW.org_id,NEW.period_id,NEW.book_id);
 IF NOT public.period_module_blocks_write(NEW.org_id,NEW.period_id,NEW.book_id,NEW.subsidiary_id,'gl',false) THEN
  RAISE EXCEPTION 'GL audit numbers require a closed entity accounting period.' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT period FROM accounting_periods WHERE org_id=NEW.org_id AND id=NEW.period_id;
 SELECT * INTO policy FROM gl_audit_number_policies WHERE org_id=NEW.org_id AND subsidiary_id=NEW.subsidiary_id AND effective_from<=period.ends_on ORDER BY effective_from DESC LIMIT 1;
 expected_scope:=CASE policy.reset_rule WHEN 'period' THEN 'period:'||period.id WHEN 'fiscal_year' THEN 'year:'||period.fiscal_calendar_id||':'||period.fiscal_year ELSE 'all' END;
 IF policy.id IS NULL OR NEW.policy_id<>policy.id OR NEW.scope_key<>expected_scope OR
    NEW.audit_number<>policy.prefix||'-'||replace(expected_scope,':','-')||'-'||lpad(NEW.ordinal::text,greatest(6,length(NEW.ordinal::text)),'0') THEN
  RAISE EXCEPTION 'GL audit numbers retain the effective entity policy and canonical sequence format.' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('gl-audit:'||NEW.org_id||':'||NEW.book_id||':'||NEW.subsidiary_id||':'||expected_scope,0));
 IF NOT EXISTS(SELECT 1 FROM journal_entries e JOIN journal_lines l ON l.org_id=e.org_id AND l.entry_id=e.id
   WHERE e.org_id=NEW.org_id AND e.id=NEW.entry_id AND e.book_id=NEW.book_id AND e.status IN('posted','reversed')
    AND l.subsidiary_id=NEW.subsidiary_id AND coalesce(l.period_id,e.period_id)=NEW.period_id) THEN
  RAISE EXCEPTION 'An audit number must identify a posted entry in its own entity, period and book.' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM gl_audit_number_assignments WHERE org_id=NEW.org_id AND book_id=NEW.book_id
  AND subsidiary_id=NEW.subsidiary_id AND scope_key=NEW.scope_key AND ordinal>=NEW.ordinal) OR
  NEW.ordinal<>(SELECT coalesce(max(ordinal),0)+1 FROM gl_audit_number_assignments WHERE org_id=NEW.org_id AND book_id=NEW.book_id
   AND subsidiary_id=NEW.subsidiary_id AND scope_key=NEW.scope_key) THEN
  RAISE EXCEPTION 'GL audit numbers are allocated without gaps in their native sequence.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.journal_instruction_line_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE head journal_entries%ROWTYPE; chosen_calendar uuid; chosen_period uuid; currency text; reversal_line journal_lines%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  IF public.financial_history_native_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Financial history clone admission requires the exact registered source row, seed and destination parents.' USING ERRCODE='23514';
 END IF;
 SELECT * INTO STRICT head FROM journal_entries WHERE org_id=NEW.org_id AND id=NEW.entry_id;
 IF public.connector_historical_replay_authorized(NEW.org_id) THEN
  NEW.period_id:=head.period_id;
 ELSE
 chosen_calendar:=public.subsidiary_posting_calendar(NEW.org_id,NEW.subsidiary_id,head.posting_date);
 SELECT id INTO chosen_period FROM accounting_periods WHERE org_id=NEW.org_id AND id=head.period_id AND fiscal_calendar_id=chosen_calendar;
 IF chosen_period IS NULL THEN SELECT id INTO chosen_period FROM accounting_periods WHERE org_id=NEW.org_id AND fiscal_calendar_id=chosen_calendar
  AND NOT is_adjustment AND starts_on<=head.posting_date AND ends_on>=head.posting_date ORDER BY starts_on,ends_on,id LIMIT 1; END IF;
 IF chosen_period IS NULL THEN RAISE EXCEPTION 'Generate the entity accounting period covering this posting date.' USING ERRCODE='23514'; END IF;
 IF NEW.period_id IS NOT NULL AND NEW.period_id<>chosen_period THEN RAISE EXCEPTION 'A journal line must use its entity accounting period.' USING ERRCODE='23514'; END IF;
 NEW.period_id:=chosen_period;
 END IF;
 IF EXISTS(SELECT 1 FROM accounts WHERE org_id=NEW.org_id AND id=NEW.account_id AND type='statistical') THEN
  IF NEW.amount<>0 OR NEW.txn_amount<>0 OR NEW.quantity IS NULL OR NEW.quantity=0 OR coalesce(length(btrim(NEW.unit)),0)=0 OR NEW.is_open_item OR NEW.is_currency_adjustment THEN
   RAISE EXCEPTION 'Statistical accounts carry nonzero quantities with a unit and zero money.' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.is_currency_adjustment THEN
  IF NEW.txn_amount<>0 OR NEW.amount=0 OR NEW.is_open_item OR head.origin<>'currency_adjustment' THEN
   RAISE EXCEPTION 'Typed currency adjustments carry only a base amount and zero foreign transaction value.' USING ERRCODE='23514'; END IF;
  IF head.reverses_entry_id IS NOT NULL THEN
   SELECT * INTO reversal_line FROM journal_lines WHERE org_id=NEW.org_id AND entry_id=head.reverses_entry_id AND line_number=NEW.line_number;
   IF NOT FOUND OR NOT reversal_line.is_currency_adjustment OR reversal_line.account_id<>NEW.account_id OR reversal_line.subsidiary_id<>NEW.subsidiary_id OR reversal_line.amount<>-NEW.amount OR reversal_line.currency<>NEW.currency OR reversal_line.fx_rate<>NEW.fx_rate OR reversal_line.txn_amount<>-NEW.txn_amount THEN
    RAISE EXCEPTION 'A currency adjustment reversal must mirror its original recorded line.' USING ERRCODE='23514'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM documents WHERE org_id=NEW.org_id AND id=head.source_document_id AND kind='journal' AND journal_mode='currency_adjustment') THEN
   RAISE EXCEPTION 'A currency adjustment requires its native governed journal instruction.' USING ERRCODE='23514';
  END IF;
  IF head.reverses_entry_id IS NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:ledger-setup:' || NEW.org_id::text,0));
   currency:=public.accounting_book_currency(NEW.org_id,head.book_id,NEW.subsidiary_id);
   IF NEW.currency=currency OR NOT EXISTS(SELECT 1 FROM journal_lines f JOIN journal_entries e ON e.org_id=f.org_id AND e.id=f.entry_id
      WHERE f.org_id=NEW.org_id AND e.book_id=head.book_id AND e.status IN('posted','reversed') AND e.posting_date<=head.posting_date
      AND f.subsidiary_id=NEW.subsidiary_id AND f.account_id=NEW.account_id AND f.currency=NEW.currency) OR EXISTS(SELECT 1 FROM journal_lines f JOIN journal_entries e ON e.org_id=f.org_id AND e.id=f.entry_id
    WHERE f.org_id=NEW.org_id AND e.book_id=head.book_id AND e.status IN('posted','reversed') AND e.posting_date<=head.posting_date
      AND f.subsidiary_id=NEW.subsidiary_id AND f.account_id=NEW.account_id AND f.currency<>currency
    GROUP BY f.currency HAVING sum(f.txn_amount)<>0) OR
    NEW.amount<>-(SELECT coalesce(sum(f.amount),0) FROM journal_lines f JOIN journal_entries e ON e.org_id=f.org_id AND e.id=f.entry_id
      WHERE f.org_id=NEW.org_id AND e.book_id=head.book_id AND e.status IN('posted','reversed') AND e.posting_date<=head.posting_date
      AND f.subsidiary_id=NEW.subsidiary_id AND f.account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'A currency adjustment clears the exact book residual only after every foreign currency balance is zero.' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.rebate_agreement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tier jsonb; last_threshold numeric; threshold numeric; rate numeric;
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  IF public.financial_history_native_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Financial history clone admission requires the exact registered source row, seed and destination parents.' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Rebate agreements are retained for audit'; END IF;
 IF TG_OP='UPDATE' AND OLD.status='approved' THEN RAISE EXCEPTION 'Approved rebate terms are immutable; create a successor dated agreement'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.org_id,NEW.created_by) IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.created_by) THEN RAISE EXCEPTION 'Rebate agreement identity is immutable'; END IF;
 IF jsonb_array_length(NEW.tiers)>100 OR (NEW.method IN ('percent','per_unit') AND jsonb_array_length(NEW.tiers)=0) THEN RAISE EXCEPTION 'Configure one through one hundred rebate tiers'; END IF;
 FOR tier IN SELECT value FROM jsonb_array_elements(NEW.tiers) LOOP
  IF jsonb_typeof(tier->'threshold') IS DISTINCT FROM 'string' OR jsonb_typeof(tier->'rate') IS DISTINCT FROM 'string'
    OR (tier->>'threshold') !~ '^[0-9]+(\.[0-9]{1,4})?$' OR (tier->>'rate') !~ '^[0-9]+(\.[0-9]{1,4})?$' THEN RAISE EXCEPTION 'Rebate tiers require exact non-negative threshold and rate strings'; END IF;
  threshold:=(tier->>'threshold')::numeric; rate:=(tier->>'rate')::numeric;
  IF (last_threshold IS NOT NULL AND threshold<=last_threshold) OR (NEW.method='percent' AND rate>100) THEN RAISE EXCEPTION 'Rebate thresholds must increase and percentages cannot exceed one hundred'; END IF;
  last_threshold:=threshold;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.org_id=NEW.org_id AND a.id=NEW.accrual_account_id AND a.is_active AND NOT a.is_summary AND a.type=CASE NEW.side WHEN 'customer' THEN 'liability_current_other' ELSE 'asset_current_other' END)
  THEN RAISE EXCEPTION 'Select a postable rebate liability or receivable account for this side'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY[NEW.offset_account_id,NEW.fx_account_id]) target(id) WHERE NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.org_id=NEW.org_id AND a.id=target.id AND a.is_active AND NOT a.is_summary AND a.type IN ('expense','expense_other','cogs','income','income_other')))
  THEN RAISE EXCEPTION 'Select postable income or expense offset and FX accounts'; END IF;
 IF NEW.party_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.parties p WHERE p.org_id=NEW.org_id AND p.id=NEW.party_id AND p.is_active AND (p.subsidiary_id IS NULL OR p.subsidiary_id=NEW.subsidiary_id)
  AND CASE NEW.side WHEN 'customer' THEN EXISTS(SELECT 1 FROM public.customer_roles r WHERE r.org_id=p.org_id AND r.party_id=p.id AND r.is_active) ELSE EXISTS(SELECT 1 FROM public.vendor_roles r WHERE r.org_id=p.org_id AND r.party_id=p.id AND r.is_active) END)
  THEN RAISE EXCEPTION 'Agreement counterparty must hold the active customer or vendor role in this legal entity'; END IF;
 IF NEW.status='approved' AND EXISTS(SELECT 1 FROM public.rebate_agreements a WHERE a.org_id=NEW.org_id AND a.id<>NEW.id AND a.status='approved' AND a.subsidiary_id=NEW.subsidiary_id AND a.side=NEW.side
  AND a.party_id IS NOT DISTINCT FROM NEW.party_id AND a.selection_group=NEW.selection_group AND a.stacking='best' AND NEW.stacking='best'
  AND daterange(a.effective_from,a.effective_to,'[]') && daterange(NEW.effective_from,NEW.effective_to,'[]') AND a.currency<>NEW.currency)
  THEN RAISE EXCEPTION 'Competing best-deal agreements must use the same currency'; END IF;
 RETURN NEW;
END $$;
