-- Fixtures for the ViewSpec conformance tenant.
--
-- The harness refuses to compare a page that has no rows: two identical empty
-- states prove nothing about the table path, and that false pass has already
-- happened once. Most pages find real data in the simulated tenant, but a few
-- modules the simulator never exercises (the continuous-close agents, for one)
-- come up empty, so their rows are seeded here rather than typed into psql and
-- forgotten — an undocumented tenant makes the harness unreproducible.
--
-- Idempotent: fixed ids, ON CONFLICT DO NOTHING. Safe to re-run.
--
--   psql "$VIEWSPEC_DB" -f scripts/viewspec-fixtures.sql
--
-- Only ever seeds the SIM org. It is a simulated tenant; nothing here should
-- be able to touch a real one.

set app.bypass_rls = 'on';

\set ON_ERROR_STOP on

do $$
declare
  v_org uuid;
  v_run_accounting uuid := '00000000-0000-7000-9000-000000000001';
  v_run_finance    uuid := '00000000-0000-7000-9000-000000000002';
  v_run_older      uuid := '00000000-0000-7000-9000-000000000003';
  v_item_critical  uuid := '00000000-0000-7000-9000-000000000101';
begin
  select id into v_org from orgs where name like 'SIM · %' order by name limit 1;
  if v_org is null then
    raise notice 'no SIM org present; skipping ViewSpec fixtures';
    return;
  end if;

  -- Completed agent runs carrying a narrative. The reports tab reads the
  -- narrative out of stats->'enrichment'->'narrative' and shows nothing at all
  -- unless that path is a json object.
  insert into ai_agent_runs (id, org_id, agent_key, trigger, status, detector_version, started_at, finished_at, stats)
  values
    (v_run_accounting, v_org, 'accounting', 'scheduler', 'completed', '2026.02',
     now() - interval '9 days', now() - interval '9 days' + interval '4 minutes',
     jsonb_build_object('enrichment', jsonb_build_object('narrative', jsonb_build_object(
       'title', 'February close review',
       'periodLabel', 'February 2026',
       'executiveSummary', 'The ledger ties out. Two bank lines remain unmatched and one accrual looks stale.',
       'highlights', jsonb_build_array('Subledgers tie to the general ledger', 'Bank reconciliation is within tolerance'),
       'risks', jsonb_build_array('Two unmatched bank lines older than 30 days'),
       'recommendations', jsonb_build_array('Clear the unmatched bank activity before the next close')
     )))),
    (v_run_finance, v_org, 'finance', 'scheduler', 'completed', '2026.02',
     now() - interval '4 days', now() - interval '4 days' + interval '6 minutes',
     jsonb_build_object('enrichment', jsonb_build_object('narrative', jsonb_build_object(
       'title', 'Margin and revenue trend',
       'periodLabel', 'Q1 2026',
       'executiveSummary', 'Revenue grew quarter over quarter while gross margin slipped on two project types.',
       'highlights', jsonb_build_array('Revenue up against the prior quarter'),
       'risks', jsonb_build_array('Gross margin down on fixed-price work'),
       'recommendations', jsonb_build_array('Review the fixed-price estimates carrying the margin decline')
     )))),
    (v_run_older, v_org, 'accounting', 'manual', 'completed', '2026.01',
     now() - interval '38 days', now() - interval '38 days' + interval '3 minutes',
     jsonb_build_object('enrichment', jsonb_build_object('narrative', jsonb_build_object(
       'title', 'January close review',
       'periodLabel', 'January 2026',
       'executiveSummary', 'Clean close with no outstanding accounting findings.',
       'highlights', jsonb_build_array('No stale documents'),
       'risks', jsonb_build_array(),
       'recommendations', jsonb_build_array()
     ))))
  on conflict (id) do nothing;

  -- Findings across both agents, all three severities and four statuses, so
  -- the severity/status/agent filter chips each have something to select and
  -- the sort columns have something to reorder.
  insert into ai_work_items
    (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, status,
     confidence, materiality, summary, first_detected_at, last_detected_at, last_detected_run_id)
  values
    (v_item_critical, v_org, 'accounting', 'unmatched_bank_activity', '2026.02', 'viewspec:unmatched-bank',
     'critical', 'open', 0.9200, 48250.0000,
     jsonb_build_object('count', 2, 'accountNumber', '1010', 'accountName', 'Operating account'),
     now() - interval '21 days', now() - interval '2 days', v_run_accounting),
    ('00000000-0000-7000-9000-000000000102', v_org, 'accounting', 'reconciliation_difference', '2026.02', 'viewspec:recon-difference',
     'warning', 'in_review', 0.7500, 1290.5000,
     jsonb_build_object('accountNumber', '1020', 'accountName', 'Payroll clearing'),
     now() - interval '14 days', now() - interval '3 days', v_run_accounting),
    ('00000000-0000-7000-9000-000000000103', v_org, 'accounting', 'stale_accounting_documents', '2026.02', 'viewspec:stale-docs',
     'info', 'open', 0.6000, 0.0000,
     jsonb_build_object('count', 7),
     now() - interval '11 days', now() - interval '5 days', v_run_accounting),
    ('00000000-0000-7000-9000-000000000104', v_org, 'finance', 'gross_margin_decline', '2026.02', 'viewspec:margin-decline',
     'critical', 'open', 0.8100, 126400.0000,
     jsonb_build_object('currentPeriod', '2026-Q1', 'priorPeriod', '2025-Q4'),
     now() - interval '8 days', now() - interval '1 day', v_run_finance),
    ('00000000-0000-7000-9000-000000000105', v_org, 'finance', 'period_revenue_decline', '2026.02', 'viewspec:revenue-decline',
     'warning', 'resolved', 0.6800, 31875.0000,
     jsonb_build_object('currentPeriod', '2026-02', 'priorPeriod', '2026-01'),
     now() - interval '30 days', now() - interval '12 days', v_run_finance),
    ('00000000-0000-7000-9000-000000000106', v_org, 'finance', 'unfavorable_budget_variance', '2026.02', 'viewspec:budget-variance',
     'info', 'dismissed', 0.5500, 4210.2500,
     jsonb_build_object('scenarioName', 'FY26 operating plan'),
     now() - interval '26 days', now() - interval '19 days', v_run_finance)
  on conflict (org_id, agent_key, fingerprint) do nothing;

  -- Evidence for the finding the harness opens in the drawer.
  insert into ai_work_item_evidence (id, org_id, work_item_id, kind, source_type, source_id, data)
  values
    ('00000000-0000-7000-9000-000000000201', v_org, v_item_critical, 'metric', null, null,
     jsonb_build_object('label', 'Unmatched lines', 'value', 2)),
    ('00000000-0000-7000-9000-000000000202', v_org, v_item_critical, 'metric', null, null,
     jsonb_build_object('label', 'Oldest unmatched', 'value', '2026-01-14'))
  on conflict (id) do nothing;

  -- ---- approvals -----------------------------------------------------------
  --
  -- Pending flow gates for the harness user, so the approval hub has rows on
  -- the "mine" and "all" tabs; and three vendor bills reassigned to that user
  -- as their creator, so the "submitted" tab has rows too. Reassigning
  -- `created_by` on simulated documents is safe here — no converted page
  -- renders it — and it is the only way that tab is reachable without
  -- inventing documents that the ledger would then have to explain.
  declare
    v_user uuid;
    v_flow uuid := '00000000-0000-7000-9000-000000000301';
    v_docs uuid[];
  begin
    select id into v_user from users where org_id = v_org and email = 'viewspec@sim.test';
    if v_user is null then
      raise notice 'no viewspec harness user; skipping approvals fixtures';
      return;
    end if;

    select array_agg(id order by document_number)
      into v_docs
      from (
        select id, document_number from documents
         where org_id = v_org and kind = 'vendor_bill'
         order by document_number
         limit 3
      ) picked;
    if v_docs is null then
      raise notice 'no vendor bills to attach approvals to; skipping';
      return;
    end if;

    update documents set created_by = v_user
     where org_id = v_org and id = any(v_docs) and created_by is distinct from v_user;

    insert into flows (id, org_id, name, description, subject_kind, enabled, graph)
    values (v_flow, v_org, 'Vendor bill approval', 'Two-step review for vendor bills',
            'vendor_bill', true, jsonb_build_object('nodes', jsonb_build_array(), 'edges', jsonb_build_array()))
    on conflict (id) do nothing;

    for i in 1..array_length(v_docs, 1) loop
      insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, status, started_at)
      values (('00000000-0000-7000-9000-00000000031' || i)::uuid, v_org, v_flow, 'vendor_bill',
              v_docs[i], 'event', 'waiting', now() - (i || ' days')::interval)
      on conflict (id) do nothing;

      insert into flow_gates
        (id, org_id, flow_id, run_id, node_id, subject_kind, subject_id, title,
         assignee_user_id, group_key, quorum, status, signature_required, created_at)
      values (('00000000-0000-7000-9000-00000000032' || i)::uuid, v_org, v_flow,
              ('00000000-0000-7000-9000-00000000031' || i)::uuid, 'approve', 'vendor_bill',
              v_docs[i], 'Approve vendor bill', v_user, 'approve', 'any', 'pending', false,
              now() - (i || ' days')::interval)
      on conflict (id) do nothing;
    end loop;
  end;
end $$;
