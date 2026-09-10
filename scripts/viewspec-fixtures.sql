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
-- Fixed ids are allocated in blocks, and the blocks matter: ON CONFLICT DO
-- NOTHING turns a collision into a SILENT skip, so two fixtures that pick the
-- same id leave one of them quietly unapplied. A purchase-order block landed
-- on ids a banking fixture already held and the page stayed empty with no
-- error at all. Claim a fresh block rather than reusing a plausible-looking
-- one:
--
--   …0001-0099  continuous close (runs, work items, evidence)
--   …0301-0399  approvals (flows, runs, gates)
--   …0401-0499  banking statements, reconciliations and their journal entry
--   …0501-0599  banking transactions (checks, deposits)
--   …0601-0699  sales orders          …0701-0799  quotes
--   …0901-0999  purchase orders
--   …1801-1899  payroll schedules and runs
--   …2801-2899  field tickets
--   …3801-3899  bank matching rules
--   …4801-4899  budget scenarios and lines
--   …5801-5899  file cabinet folders, files, versions
--   …6801-6899  tax return forms and filings
--   …7801-7899  psp settlement batches
--   …1101-1199  installed apps
--   …2001-2099  AP capture documents
--   …8801-8899  labor bill rate books
--   …1901-1999  pay stubs, employee profiles, wage rates
--   …a000-…     CRM opportunities, quotas, snapshots; custom records
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

  -- ---- feature switches -----------------------------------------------------
  --
  -- The simulator leaves most modules off, and a gated page 404s identically
  -- on both render paths — which the harness would happily call a match while
  -- comparing two error pages. Turning on the modules the harness covers is
  -- what makes those comparisons mean anything.
  update orgs
     set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb), '{features}',
           coalesce(settings->'features', '{}'::jsonb) || jsonb_build_object(
             'payroll', true,
             'fieldTickets', true,
             'budgets', true,
             'inventory', true,
             'crm', true,
             'timeTracking', true,
             'banking', true,
             'fixedAssets', true,
             'orders', true,
             'queryConsole', true))
   where id = v_org;

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

  -- ---- banking account detail -------------------------------------------
  -- Statements, lines and reconciliations for the SIM 1010 Operating
  -- Account, so the account page renders both tables, the badge variants,
  -- and the resume-workspace button. Verified counts: 2 statements, 12
  -- lines (3 unmatched), 3 reconciliations (2 signed_off, 1 in_progress).
  declare
    v_acct  uuid := 'a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e'; -- SIM 1010 Operating Account (asset_bank)
    v_stm1  uuid := '00000000-0000-7000-9000-000000000403';
    v_stm2  uuid := '00000000-0000-7000-9000-000000000404';
    v_rec1  uuid := '00000000-0000-7000-9000-000000000405';
    v_rec2  uuid := '00000000-0000-7000-9000-000000000406';
    v_rec3  uuid := '00000000-0000-7000-9000-000000000407';
    v_je    uuid := '00000000-0000-7000-9000-000000000408';
    v_jl    uuid := '00000000-0000-7000-9000-000000000409';
    v_book  uuid;
    v_per   uuid;
    v_sub   uuid;
    v_user  uuid;
  begin
    select id into v_user from users where org_id = v_org and email = 'viewspec@sim.test';
    select id into v_sub from subsidiaries where org_id = v_org order by name limit 1;
    select id into v_book from accounting_books where org_id = v_org and is_primary limit 1;
    select id into v_per from accounting_periods where org_id = v_org order by starts_on desc limit 1;
    if v_user is null or v_sub is null or v_book is null or v_per is null then
      raise notice 'missing banking fixture prerequisites; skipping';
      return;
    end if;
  
    -- The account page 404s on a non-reconcilable account, and the simulator
    -- leaves every bank account with the flag off.
    -- A reconcilable account must name its currency (CHECK constraint), so
    -- the flag and the restriction go on together.
    update accounts
       set reconcilable = true,
           currency_restriction = coalesce(currency_restriction, 'USD')
     where id = v_acct and org_id = v_org and not reconcilable;

    -- Posted entries are immutable (jl_guard), so the balance line goes in
    -- as draft first and the entry is posted afterwards. Two legs: the
    -- balanced-entry guard rejects a one-legged posting.
    --
    -- Guarded by existence rather than ON CONFLICT: once the entry is posted,
    -- the line insert fires jl_guard and RAISEs even when every row would be
    -- a no-op, so a second run of this file would fail. Idempotence has to be
    -- checked before the statement, not by it.
    if not exists (select 1 from journal_entries where id = v_je) then
      insert into journal_entries (id, org_id, book_id, entry_number, posting_date, period_id, status, subsidiary_id)
      values (v_je, v_org, v_book, 'BNK-1', current_date - 6, v_per, 'draft', v_sub);
      insert into journal_lines (id, org_id, entry_id, line_number, account_id, amount, currency, txn_amount, subsidiary_id)
      values (v_jl, v_org, v_je, 1, v_acct, 12500.0000, 'USD', 12500.0000, v_sub),
             ('00000000-0000-7000-9000-000000000413', v_org, v_je, 2,
              (select id from accounts where org_id = v_org and number = '3900' limit 1),
              -12500.0000, 'USD', -12500.0000, v_sub);
      update journal_entries set status = 'posted', posted_at = now(), posted_by = v_user
       where id = v_je and status <> 'posted';
    end if;
  
    insert into bank_statements
      (id, org_id, account_id, source, statement_date, opening_balance, closing_balance, raw_file_ref)
    values (v_stm1, v_org, v_acct, 'ofx', current_date - 20, 10000.0000, 12500.0000, 'fixture-ofx-1'),
           (v_stm2, v_org, v_acct, 'csv', current_date - 6, 12500.0000, 13100.0000, 'fixture-csv-1')
    on conflict (id) do nothing;
  
    -- Statement 1: three lines, one unmatched (the header unmatched stat and
    -- the green-zero vs count pair both need a nonzero case on this page).
    insert into bank_statement_lines
      (id, org_id, statement_id, account_id, line_number, posted_on, amount, currency, description, match_status)
    values ('00000000-0000-7000-9000-000000000410', v_org, v_stm1, v_acct, 1, current_date - 19, 2000.0000, 'USD', 'Client receipt', 'matched'),
           ('00000000-0000-7000-9000-000000000411', v_org, v_stm1, v_acct, 2, current_date - 18, -1500.0000, 'USD', 'Vendor payment', 'matched'),
           ('00000000-0000-7000-9000-000000000412', v_org, v_stm1, v_acct, 3, current_date - 17, 2000.0000, 'USD', 'Unmatched deposit', 'unmatched')
    on conflict (id) do nothing;
  
    -- Statement 2: nine lines, two unmatched — exercises the drawer pager
    -- (default page is large, but the row shapes differ per line).
    insert into bank_statement_lines
      (id, org_id, statement_id, account_id, line_number, posted_on, amount, currency, description, match_status)
    select ('00000000-0000-7000-9000-00000000042' || g)::uuid, v_org, v_stm2, v_acct, g,
           current_date - 5, (100.0000 * g), 'USD', 'Line ' || g,
           case when g in (3, 7) then 'unmatched' else 'matched' end
      from generate_series(1, 9) g
    on conflict (id) do nothing;
  
    -- One open session per account (partial unique index): a single
    -- in_progress row stays open; the second row is signed off as well so
    -- closed statuses still appear. Signed-off rows must carry signoff
    -- evidence (enforced by CHECK); the open one makes the header badge read
    -- "in progress" and the action button "resume".
    insert into reconciliations
      (id, org_id, account_id, through_date, statement_balance, status, currency, signed_off_by, signed_off_at)
    values (v_rec1, v_org, v_acct, current_date - 20, 12500.0000, 'signed_off', 'USD', v_user, now() - interval '2 days'),
           (v_rec2, v_org, v_acct, current_date - 13, 12800.0000, 'signed_off', 'USD', v_user, now() - interval '1 day'),
           (v_rec3, v_org, v_acct, current_date - 6, 13100.0000, 'in_progress', 'USD', null, null)
    on conflict (id) do nothing;
  end;


  -- The simulator seeds the `site_visit` record type with a section shaped
  -- `{key,type,label}`, but the forms-core schema wants `{id,type,label}` and
  -- a section `id` — so `lintRecordFields` rejects it and the module 404s.
  -- Repaired here rather than in the simulator: the harness needs the page to
  -- render, and the invalid shape is the simulator's seed, not the product.
  update custom_record_types
     set fields = jsonb_build_array(jsonb_build_object(
           'id', 'details',
           'title', 'Details',
           'fields', jsonb_build_array(
             jsonb_build_object('id', 'visited_on', 'type', 'date', 'label', 'Visited on'),
             jsonb_build_object('id', 'notes', 'type', 'long_text', 'label', 'Notes')
           )
         ))
   where org_id = v_org and key = 'site_visit'
     and not (fields @> '[{"id": "details"}]'::jsonb);

  -- ---- custom record modules ----------------------------------------------
  --
  -- The simulator publishes a `site_visit` record type but never creates a
  -- record of it, so /records/site_visit would only ever render its empty
  -- state — the harness refuses to compare that and prove nothing about the
  -- table path.
  insert into custom_records
    (id, org_id, type_id, type_key, record_number, data, search_text, status)
  select v.id::uuid, v_org, t.id, 'site_visit', 'SV-00000' || v.n,
         jsonb_build_object('visited_on', '2026-0' || v.n || '-15',
                            'notes', 'Harness visit ' || v.n),
         'sv-00000' || v.n || ' harness visit',
         case when v.n = 1 then 'active' else 'draft' end
    from (values
      ('00000000-0000-7000-a000-000000000001', 1),
      ('00000000-0000-7000-a000-000000000002', 2)) as v(id, n)
    join custom_record_types t on t.org_id = v_org and t.key = 'site_visit'
  on conflict (id) do nothing;

  -- ---- sales forecasts -----------------------------------------------------
  --
  -- Two open opportunities in the current quarter, one overlapping quota and
  -- one snapshot, so the KPI strips, the quota table and the history table all
  -- have something to render. Dates are relative so the fixture keeps working
  -- as the simulated clock moves.
  declare
    v_owner uuid;
    v_proposal uuid;
    v_negot uuid;
    v_qstart date := date_trunc('month', current_date)::date;
    v_qend date := (date_trunc('month', current_date) + interval '3 months' - interval '1 day')::date;
  begin
    select id into v_owner from users where org_id = v_org order by created_at limit 1;
    select id into v_proposal from crm_opportunity_statuses
     where org_id = v_org and not is_closed order by sequence limit 1;
    select id into v_negot from crm_opportunity_statuses
     where org_id = v_org and not is_closed order by sequence desc limit 1;
    if v_owner is null or v_proposal is null then
      raise notice 'no CRM statuses or users; skipping forecast fixtures';
      return;
    end if;

    insert into crm_opportunities
      (id, org_id, opportunity_number, title, owner_user_id, status_id, expected_close_date,
       forecast_category, probability, currency, projected_amount, weighted_amount, is_active)
    values
      ('00000000-0000-7000-a000-000000000001', v_org, 'VS-FC-1', 'ViewSpec forecast conformance A',
       v_owner, v_proposal, current_date + 10, 'most_likely', 50, 'USD', 10000, 5000, true),
      ('00000000-0000-7000-a000-000000000002', v_org, 'VS-FC-2', 'ViewSpec forecast conformance B',
       v_owner, v_negot, current_date + 20, 'upside', 75, 'USD', 20000, 15000, true)
    on conflict (id) do nothing;

    insert into crm_sales_quotas (id, org_id, owner_user_id, period_start, period_end, currency, amount)
    values ('00000000-0000-7000-a000-000000000010', v_org, v_owner, v_qstart, v_qend, 'USD', 50000)
    on conflict (id) do nothing;

    insert into crm_forecast_snapshots
      (id, org_id, owner_user_id, period_start, period_end, as_of, snapshot_kind, currency,
       pipeline_amount, weighted_amount, worst_case_amount, most_likely_amount, upside_amount, closed_amount)
    values ('00000000-0000-7000-a000-000000000020', v_org, v_owner, v_qstart, v_qend, now(),
            'calculated', 'USD', 30000, 20000, 0, 10000, 20000, 0)
    on conflict (id) do nothing;
  end;

  -- ---- orders: quotes, sales orders, purchase orders -----------------------
  --
  -- The simulator never writes any of the three, so all three list pages would
  -- compare two identical empty states. One block rather than three because
  -- the three agents that asked for these each proposed the same fixed ids;
  -- distinct ranges here are the whole reason they can coexist.
  --
  -- Everything stays DRAFT except where a status is the point: a line insert
  -- against a non-draft document is rejected by the line-immutability trigger,
  -- so any non-draft fixture carries no lines.
  declare
    v_customer uuid;
    v_customer2 uuid;
    v_vendor uuid;
    v_vendor2 uuid;
    v_income uuid;
    v_expense uuid;
    v_item uuid;
  begin
    select p.id into v_customer from parties p
      join customer_roles r on r.party_id = p.id and r.org_id = p.org_id and r.is_active
     where p.org_id = v_org and p.is_active order by p.display_name limit 1;
    select p.id into v_customer2 from parties p
      join customer_roles r on r.party_id = p.id and r.org_id = p.org_id and r.is_active
     where p.org_id = v_org and p.is_active and p.id <> v_customer
     order by p.display_name limit 1;
    select p.id into v_vendor from parties p
      join vendor_roles r on r.party_id = p.id and r.org_id = p.org_id and r.is_active
     where p.org_id = v_org and p.is_active order by p.display_name limit 1;
    select p.id into v_vendor2 from parties p
      join vendor_roles r on r.party_id = p.id and r.org_id = p.org_id and r.is_active
     where p.org_id = v_org and p.is_active and p.id <> v_vendor
     order by p.display_name limit 1;
    select id into v_income from accounts
     where org_id = v_org and type in ('income', 'income_other') and is_active and not is_summary
     order by number nulls last limit 1;
    select id into v_expense from accounts
     where org_id = v_org and type in ('expense', 'cogs') and is_active and not is_summary
     order by number nulls last limit 1;
    select id into v_item from items where org_id = v_org and is_active order by name limit 1;

    if v_customer is null or v_vendor is null or v_income is null or v_expense is null then
      raise notice 'missing party or account; skipping order fixtures';
      return;
    end if;

    insert into documents
      (id, org_id, kind, document_number, party_id, document_date, currency,
       status, subtotal, tax_total, total, memo)
    values
      -- quotes
      ('00000000-0000-7000-9000-000000000701', v_org, 'quote', 'EST-VIEWSPEC-1',
       v_customer, current_date - 6, 'USD', 'draft', 5000, 0, 5000, 'ViewSpec harness quote one'),
      ('00000000-0000-7000-9000-000000000702', v_org, 'quote', 'EST-VIEWSPEC-2',
       coalesce(v_customer2, v_customer), current_date - 3, 'USD', 'draft', 12000, 0, 12000,
       'ViewSpec harness quote two'),
      ('00000000-0000-7000-9000-000000000703', v_org, 'quote', 'EST-VIEWSPEC-3',
       v_customer, current_date - 1, 'USD', 'draft', 8000, 0, 8000, 'ViewSpec harness quote three'),
      -- sales orders
      ('00000000-0000-7000-9000-000000000601', v_org, 'sales_order', 'SO-VIEWSPEC-1',
       v_customer, current_date - 9, 'USD', 'draft', 1500, 0, 1500, 'ViewSpec harness sales order one'),
      ('00000000-0000-7000-9000-000000000602', v_org, 'sales_order', 'SO-VIEWSPEC-2',
       coalesce(v_customer2, v_customer), current_date - 4, 'USD', 'draft', 2750, 0, 2750,
       'ViewSpec harness sales order two'),
      -- purchase orders
      ('00000000-0000-7000-9000-000000000901', v_org, 'purchase_order', 'PO-VIEWSPEC-1',
       v_vendor, current_date - 5, 'USD', 'draft', 1500, 0, 1500, 'ViewSpec harness purchase order one'),
      ('00000000-0000-7000-9000-000000000902', v_org, 'purchase_order', 'PO-VIEWSPEC-2',
       coalesce(v_vendor2, v_vendor), current_date - 2, 'USD', 'draft', 750, 0, 750,
       'ViewSpec harness purchase order two')
    on conflict (id) do nothing;

    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit_price, amount)
    values
      ('00000000-0000-7000-9000-000000000711', v_org, '00000000-0000-7000-9000-000000000701', 1,
       v_item, v_income, 'Harness line one', 10, 300, 3000),
      ('00000000-0000-7000-9000-000000000712', v_org, '00000000-0000-7000-9000-000000000701', 2,
       v_item, v_income, 'Harness line two', 4, 500, 2000),
      ('00000000-0000-7000-9000-000000000611', v_org, '00000000-0000-7000-9000-000000000601', 1,
       v_item, v_income, 'Field labor', 10, 150, 1500),
      ('00000000-0000-7000-9000-000000000911', v_org, '00000000-0000-7000-9000-000000000901', 1,
       v_item, v_expense, 'Field labor', 10, 150, 1500),
      ('00000000-0000-7000-9000-000000000912', v_org, '00000000-0000-7000-9000-000000000902', 1,
       v_item, v_expense, 'Field labor', 5, 150, 750)
    on conflict (id) do nothing;
  end;

  -- ---- inventory -----------------------------------------------------------
  --
  -- One stocked item with a receipt layer and an issue, one stock location and
  -- one bill-of-materials row: enough for the on-hand list, the movements
  -- list and both re-homed configuration tabs. FK targets resolve from the
  -- tenant at seed time so the block survives a rebuild; only the seeded rows
  -- carry fixed ids.
  declare
    v_sub uuid;
    v_loc uuid;
    v_acct_asset uuid;
    v_acct_cogs uuid;
  begin
    select id into v_sub from subsidiaries where org_id = v_org order by name limit 1;
    select id into v_loc from locations where org_id = v_org order by code limit 1;
    select id into v_acct_asset from accounts where org_id = v_org and number = '1010' limit 1;
    select id into v_acct_cogs from accounts where org_id = v_org and number = '1020' limit 1;
    if v_loc is null or v_acct_asset is null or v_acct_cogs is null then
      raise notice 'missing location or accounts; skipping inventory fixtures';
      return;
    end if;

    insert into items (id, org_id, kind, code, name, is_active)
    values ('00000000-0000-7000-9000-000000000201', v_org, 'inventory', 'WIDGET-001', 'Conformance widget', true),
           ('00000000-0000-7000-9000-000000000202', v_org, 'inventory', 'GADGET-002', 'Conformance gadget', true)
    on conflict (id) do nothing;

    insert into item_inventory_profiles
      (id, org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id, base_unit)
    values ('00000000-0000-7000-9000-000000000203', v_org, '00000000-0000-7000-9000-000000000201',
            'moving_average', 'none', v_acct_asset, v_acct_cogs, 'ea')
    on conflict (id) do nothing;

    insert into stock_locations (id, org_id, location_id, code, kind, is_active)
    values ('00000000-0000-7000-9000-000000000204', v_org, v_loc, 'MAIN', 'warehouse', true)
    on conflict (id) do nothing;

    insert into inventory_movements
      (id, org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id,
       quantity, unit_cost, total_value, status)
    values ('00000000-0000-7000-9000-000000000205', v_org, v_sub,
            '00000000-0000-7000-9000-000000000201', 'receipt', now() - interval '2 days',
            '00000000-0000-7000-9000-000000000204', 10, 25.50, 255.00, 'posted'),
           ('00000000-0000-7000-9000-000000000206', v_org, v_sub,
            '00000000-0000-7000-9000-000000000201', 'issue', now() - interval '1 day',
            '00000000-0000-7000-9000-000000000204', 2, 25.50, 51.00, 'posted')
    on conflict (id) do nothing;

    insert into cost_layers
      (id, org_id, subsidiary_id, item_id, stock_location_id, source_movement_id,
       received_at, original_quantity, remaining_quantity, unit_cost)
    values ('00000000-0000-7000-9000-000000000207', v_org, v_sub,
            '00000000-0000-7000-9000-000000000201', '00000000-0000-7000-9000-000000000204',
            '00000000-0000-7000-9000-000000000205', now() - interval '2 days', 10, 8, 25.50)
    on conflict (id) do nothing;

    insert into bom_components (id, org_id, assembly_item_id, component_item_id, quantity_per, sort_order)
    values ('00000000-0000-7000-9000-000000000208', v_org,
            '00000000-0000-7000-9000-000000000202', '00000000-0000-7000-9000-000000000201', 2, 0)
    on conflict (id) do nothing;
  end;

  -- The three blocks below were each proposed as `…0801-08xx` by three agents
  -- working in parallel; renumbered here into distinct ranges, which is the
  -- whole reason the allocation table at the top of this file exists.

  -- ---- payroll runs ----------------------------------------------------------
  --
  -- The simulator never runs payroll, so the /payroll/runs list is empty
  -- without these: two schedules (biweekly + monthly) and three runs under
  -- the biweekly one. Header totals equal the line sums. All three stay
  -- DRAFT: a posted document must name its accounting period, and a fixture
  -- has no business inventing one.
  declare
    v_party uuid;
    v_account uuid;
    v_item uuid;
    v_sched_bi uuid := '00000000-0000-7000-9000-000000001801';
    v_sched_mo uuid := '00000000-0000-7000-9000-000000001802';
  begin
    select id into v_party from parties
     where org_id = v_org and display_name = 'Harborview Development LLC';
    select id into v_account from accounts
     where org_id = v_org and type in ('income', 'income_other')
       and is_active and not is_summary
     order by number nulls last limit 1;
    select id into v_item from items
     where org_id = v_org and is_active
     order by name limit 1;
    if v_party is null or v_account is null or v_item is null then
      raise notice 'missing party/account/item; skipping payroll fixtures';
      return;
    end if;

    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_default, is_active)
    values
      (v_sched_bi, v_org, 'Biweekly — ViewSpec', 'biweekly', 26,
       date '2026-01-09', 5, true, true),
      (v_sched_mo, v_org, 'Monthly — ViewSpec', 'monthly', 12,
       date '2026-01-31', 0, false, true)
    on conflict (id) do nothing;

    insert into documents
      (id, org_id, kind, document_number, party_id, document_date, currency,
       status, subtotal, tax_total, total, memo, created_at, updated_at)
    values
      ('00000000-0000-7000-9000-000000001811', v_org, 'pay_run', 'PAY-00001',
       v_party, date '2026-02-06', 'USD', 'draft', 5200.0000, 0.0000, 5200.0000,
       'ViewSpec fixture: calculated run', now(), now()),
      ('00000000-0000-7000-9000-000000001812', v_org, 'pay_run', 'PAY-00002',
       v_party, date '2026-02-20', 'USD', 'draft', 5340.0000, 0.0000, 5340.0000,
       'ViewSpec fixture: calculated run', now(), now()),
      ('00000000-0000-7000-9000-000000001813', v_org, 'pay_run', 'PAY-00003',
       -- Draft, not posted: a posted document must name its accounting
       -- period (documents_posted_period_required), and inventing a period
       -- link for a fixture would fake a posting that never happened.
       v_party, date '2026-03-06', 'USD', 'draft', 5480.0000, 0.0000, 5480.0000,
       'ViewSpec fixture: third run', now(), now())
    on conflict (id) do nothing;

    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit_price, amount)
    values
      ('00000000-0000-7000-9000-000000001821', v_org,
       '00000000-0000-7000-9000-000000001811', 1, v_item, v_account,
       'ViewSpec fixture line', 1, 5200.0000, 5200.0000),
      ('00000000-0000-7000-9000-000000001822', v_org,
       '00000000-0000-7000-9000-000000001812', 1, v_item, v_account,
       'ViewSpec fixture line', 1, 5340.0000, 5340.0000),
      ('00000000-0000-7000-9000-000000001823', v_org,
       '00000000-0000-7000-9000-000000001813', 1, v_item, v_account,
       'ViewSpec fixture line', 1, 5480.0000, 5480.0000)
    on conflict (id) do nothing;

    insert into pay_runs
      (document_id, org_id, pay_schedule_id, period_start, period_end,
       pay_date, tax_year, run_status, run_type, gross_total, net_total,
       employee_count)
    values
      ('00000000-0000-7000-9000-000000001811', v_org, v_sched_bi,
       date '2026-01-24', date '2026-02-06', date '2026-02-11', 2026,
       'calculated', 'regular', 5200.0000, 5200.0000, 1),
      ('00000000-0000-7000-9000-000000001812', v_org, v_sched_bi,
       date '2026-02-07', date '2026-02-20', date '2026-02-25', 2026,
       'calculated', 'regular', 5340.0000, 5340.0000, 1),
      ('00000000-0000-7000-9000-000000001813', v_org, v_sched_bi,
       date '2026-02-21', date '2026-03-06', date '2026-03-11', 2026,
       -- `committed`, not `paid`: the run-status CHECK allows only
       -- draft/calculated/committed/voided.
       'committed', 'regular', 5480.0000, 5480.0000, 1)
    on conflict do nothing;
  end;

  -- ---- field tickets ---------------------------------------------------------
  --
  -- The simulator writes field-ticket documents but no field_tickets extension
  -- rows, so the /field-tickets list (inner join) is empty and the drawer
  -- (inner join) resolves null for every real id. Three tickets with their
  -- extension rows (draft, submitted, approved) on one real sim project, so
  -- the status chips, the project picker, and the draft pickers all render.
  declare
    v_project uuid;
    v_customer uuid;
    v_foreman uuid;
  begin
    select id, customer_id into v_project, v_customer from projects
     where org_id = v_org and is_active
     order by name limit 1;
    select p.id into v_foreman from parties p
     where p.org_id = v_org and p.is_active
       and exists (
         select 1 from employee_roles r
          where r.party_id = p.id and r.org_id = p.org_id and r.is_active
       )
     order by p.display_name limit 1;
    if v_project is null then
      raise notice 'missing project; skipping field-ticket fixtures';
      return;
    end if;

    insert into documents
      (id, org_id, kind, document_number, document_date, currency, status,
       party_id, project_id, subsidiary_id, billing_method,
       subtotal, tax_total, total, custom)
    values
      ('00000000-0000-7000-9000-000000002801', v_org, 'field_ticket', 'FT-VIEWSPEC-1',
       current_date - 2, 'USD', 'draft', v_customer, v_project, null,
       'time_and_materials', 0, 0, 0, '{}'::jsonb),
      ('00000000-0000-7000-9000-000000002802', v_org, 'field_ticket', 'FT-VIEWSPEC-2',
       current_date - 9, 'USD', 'pending_approval', v_customer, v_project, null,
       'time_and_materials', 0, 0, 0, '{}'::jsonb),
      ('00000000-0000-7000-9000-000000002803', v_org, 'field_ticket', 'FT-VIEWSPEC-3',
       current_date - 16, 'USD', 'approved', v_customer, v_project, null,
       'time_and_materials', 0, 0, 0, '{}'::jsonb)
    on conflict (id) do nothing;

    insert into field_tickets
      (document_id, org_id, period, period_start, period_end, foreman_party_id)
    values
      ('00000000-0000-7000-9000-000000002801', v_org, 'weekly',
       current_date - 8, current_date - 2, v_foreman),
      ('00000000-0000-7000-9000-000000002802', v_org, 'weekly',
       current_date - 15, current_date - 9, v_foreman),
      ('00000000-0000-7000-9000-000000002803', v_org, 'weekly',
       current_date - 22, current_date - 16, v_foreman)
    on conflict (document_id, org_id) do nothing;
  end;

  -- ---- bank matching rules --------------------------------------------------
  --
  -- The simulator never writes matching rules, so the list page is empty. Two
  -- rules cover both outcome branches and both sides of the active filter: one
  -- active rule that categorizes against a live account (so the outcome label
  -- resolves to a real name rather than the em-dash fallback), and one
  -- inactive rule that excludes.
  declare
    v_rule_account uuid;
  begin
    select id into v_rule_account from accounts
     where org_id = v_org and is_active and not is_summary
     order by number nulls last limit 1;
    if v_rule_account is null then
      raise notice 'no account for bank rules; skipping';
      return;
    end if;

    insert into bank_match_rules (id, org_id, name, criteria, outcome, priority, is_active)
    values
      ('00000000-0000-7000-9000-000000003801', v_org, 'ViewSpec — categorize utilities',
       jsonb_build_object('version', 2, 'match', jsonb_build_object(
         'combinator', 'and',
         'rules', jsonb_build_array(jsonb_build_object(
           -- `op`, not `operator`: summarizeCondition reads cond.op, and the
           -- wrong key renders "Description undefined" on both sides — agreeing
           -- about nonsense is not a passing test.
           'field', 'description', 'op', 'contains', 'value', 'utility'))))::jsonb,
       -- The outcome shape is CHECK-validated: categorize needs version 2, a
       -- mode, and every line needs an account plus a portion.
       jsonb_build_object(
         'action', 'categorize', 'version', '2', 'mode', 'auto',
         'lines', jsonb_build_array(jsonb_build_object(
           'accountId', v_rule_account::text,
           'portion', jsonb_build_object('kind', 'remainder'))))::jsonb,
       100, true),
      ('00000000-0000-7000-9000-000000003802', v_org, 'ViewSpec — exclude transfers',
       jsonb_build_object('version', 2, 'match', jsonb_build_object(
         'combinator', 'and',
         'rules', jsonb_build_array(jsonb_build_object(
           'field', 'description', 'op', 'contains', 'value', 'transfer'))))::jsonb,
       jsonb_build_object('action', 'exclude')::jsonb,
       200, false)
    on conflict (id) do nothing;
  end;

  -- ---- budgets -------------------------------------------------------------
  -- The simulator never writes budget scenarios, so the list page would
  -- compare two identical empty states. Three scenarios (one draft with
  -- lines, for the drawer variant) in the SIM org, on fiscal year 2026
  -- which has periods in the SIM org.
  insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status, description, revision)
  values
    ('00000000-0000-7000-9000-000000004801', v_org,
     (select id from accounting_books where org_id = v_org and is_active order by is_primary desc, name limit 1),
     2026, 'ViewSpec FY26 operating budget', 'budget', 'draft', 'ViewSpec harness budget one', 1),
    ('00000000-0000-7000-9000-000000004802', v_org,
     (select id from accounting_books where org_id = v_org and is_active order by is_primary desc, name limit 1),
     -- Draft, not pending_approval: a submitted or approved scenario must
     -- carry at least one non-zero line, and only the first scenario has
     -- lines. Faking lines to satisfy a status is how a fixture starts lying.
     2026, 'ViewSpec FY26 stretch budget', 'budget', 'draft', 'ViewSpec harness budget two', 1),
    ('00000000-0000-7000-9000-000000004803', v_org,
     (select id from accounting_books where org_id = v_org and is_active order by is_primary desc, name limit 1),
     2026, 'ViewSpec FY26 forecast', 'forecast', 'draft', 'ViewSpec harness forecast', 1)
  on conflict (id) do nothing;

  insert into budget_lines (org_id, scenario_id, account_id, period_id, amount)
  values
    (v_org, '00000000-0000-7000-9000-000000004801',
     (select id from accounts where org_id = v_org and is_active and not is_summary and type = 'expense' order by number limit 1),
     (select id from accounting_periods where org_id = v_org and fiscal_year = 2026 and not is_adjustment order by period_number limit 1),
     12000),
    (v_org, '00000000-0000-7000-9000-000000004801',
     (select id from accounts where org_id = v_org and is_active and not is_summary and type = 'expense' order by number limit 1 offset 1),
     (select id from accounting_periods where org_id = v_org and fiscal_year = 2026 and not is_adjustment order by period_number limit 1),
     8000)
  on conflict do nothing;

  -- ---- file cabinet ---------------------------------------------------------
  --
  -- The simulator writes no folders and no files, so the cabinet was two empty
  -- states comparing against each other. One folder at the virtual root, one
  -- child folder, and one file inside the child — files never live at the
  -- root, so the default view needs the nesting to show anything at all.
  declare
    v_root uuid := '00000000-0000-7000-9000-000000005801';
    v_child uuid := '00000000-0000-7000-9000-000000005802';
    v_file uuid := '00000000-0000-7000-9000-000000005803';
    v_version uuid := '00000000-0000-7000-9000-000000005804';
  begin
    insert into folders (id, org_id, parent_folder_id, name)
    values (v_root, v_org, null, 'ViewSpec Cabinet'),
           (v_child, v_org, v_root, 'ViewSpec Subfolder')
    on conflict (id) do nothing;

    insert into files (id, org_id, folder_id, name, extension, file_type, content_type, size_bytes)
    values (v_file, v_org, v_child, 'viewspec-fixture.txt', 'txt', 'text', 'text/plain', 42)
    on conflict (id) do nothing;

    insert into file_versions (id, file_id, version_number, size_bytes, content_type)
    values (v_version, v_file, 1, 42, 'text/plain')
    on conflict (id) do nothing;
  end;

  -- Tax return forms + filing history for the /tax conversion. The prepare
  -- tab needs at least one active form (its Select, submission panel and
  -- compute flow); the history tab needs rows across both statuses.
  insert into tax_return_forms
    (id, org_id, code, name, country, submission_channel, government_format,
     submission_url, is_active, official_pdf_file_id)
  values
    ('00000000-0000-7000-9000-000000006801', v_org, 'CA_GST34',
     'GST/HST return', 'CA', 'portal_manual', 'portal_entry',
     'https://www.canada.ca/en/revenue-agency.html', true, null),
    ('00000000-0000-7000-9000-000000006802', v_org, 'US_941',
     'Employer quarterly federal tax return', 'US', 'efile_api', 'api',
     null, true, null)
  on conflict (id) do nothing;

  insert into tax_filings
    (id, org_id, form_code, form_name, country, period_from, period_to,
     version, status, submission_channel, boxes, snapshot_hash,
     filing_reference, filed_at)
  values
    ('00000000-0000-7000-9000-000000006811', v_org, 'CA_GST34',
     'GST/HST return', 'CA', '2026-01-01', '2026-03-31',
     1, 'prepared', 'portal_manual',
     '[{"lineCode": "101", "label": "Sales and other revenue", "value": "48250.00", "computed": false, "editable": true}, {"lineCode": "105", "label": "Total GST/HST collected", "value": "2412.50", "computed": true, "editable": false}]'::jsonb,
     repeat('a', 64), null, null),
    ('00000000-0000-7000-9000-000000006812', v_org, 'CA_GST34',
     'GST/HST return', 'CA', '2025-10-01', '2025-12-31',
     1, 'filed', 'portal_manual',
     '[{"lineCode": "101", "label": "Sales and other revenue", "value": "41100.00", "computed": false, "editable": true}, {"lineCode": "105", "label": "Total GST/HST collected", "value": "2055.00", "computed": true, "editable": false}]'::jsonb,
     repeat('b', 64), 'CRA-CONF-2025-Q4', now() - interval '40 days'),
    ('00000000-0000-7000-9000-000000006813', v_org, 'US_941',
     'Employer quarterly federal tax return', 'US', '2026-01-01', '2026-03-31',
     1, 'prepared', 'efile_api',
     '[{"lineCode": "5a", "label": "Taxable social security wages", "value": "120000.00", "computed": false, "editable": true}, {"lineCode": "5c", "label": "Total income tax withheld", "value": "18000.00", "computed": true, "editable": false}]'::jsonb,
     repeat('c', 64), null, null)
  on conflict (id) do nothing;

  -- ---- psp settlements ------------------------------------------------------
  --
  -- Two DRAFT batches, and only drafts on purpose. A posted or void batch has
  -- to carry a journal entry and, for a void, a full reversal chain — the
  -- lifecycle CHECK enforces it. Inventing those ledger rows to decorate a
  -- fixture is how a fixture starts lying about the product, so the harness
  -- covers the draft row-state and says so rather than faking the other two.
  insert into psp_settlement_batches
    (id, org_id, provider, external_ref, settlement_date, currency,
     gross_amount, fee_amount, refund_amount, dispute_amount, fx_amount,
     net_amount, status, line_count)
  values
    ('00000000-0000-7000-9000-000000007801', v_org, 'stripe', 'po_viewspec_draft_001',
     current_date - 2, 'USD', 12500.00, 362.50, 0, 0, 0, 12137.50, 'draft', 42),
    ('00000000-0000-7000-9000-000000007802', v_org, 'adyen', 'adyen_viewspec_draft_001',
     current_date - 9, 'USD', 9800.00, 284.20, 0, 0, 0, 9515.80, 'draft', 31)
  on conflict (id) do nothing;

  -- ---- labor pricing ------------------------------------------------------
  --
  -- Bill rate books + versions for the /admin/setup/labor-pricing
  -- conversion: two ACTIVE books (one department-scoped, one unscoped) and
  -- one EXPIRED book, so the time and dimension filters each change the
  -- result set (see the INTEGRATION.md for that page). The drawer variant
  -- opens the scoped version with one scope, one adjustment, one term and
  -- one line.
  -- Guarded by existence, not ON CONFLICT. Every child of a rate version is
  -- immutable once the version leaves draft, and this block ACTIVATES its
  -- versions at the end — so a second run would try to insert children under
  -- an activated version and be refused by the engine. Idempotence has to be
  -- checked before the statements, not by them.
  if not exists (
    select 1 from item_rate_versions where id = '00000000-0000-7000-9000-000000008811'
  ) then
    insert into item_rate_books (id, org_id, code, name, currency, is_active)
    values
      ('00000000-0000-7000-9000-000000008801', v_org, 'STD-2025', 'Standard bill rates', 'USD', true),
      ('00000000-0000-7000-9000-000000008802', v_org, 'OT-2025', 'Overtime bill rates', 'USD', true)
    on conflict (id) do nothing;

    -- Versions go in as DRAFT and are activated at the end of this block: the
    -- children of an activated or retired version are immutable, so building
    -- them in their final state first makes the scopes, policies and lines
    -- unwritable. The product enforces the same order.
    insert into item_rate_versions (id, org_id, rate_book_id, effective_from, effective_to, status)
    values
      ('00000000-0000-7000-9000-000000008811', v_org, '00000000-0000-7000-9000-000000008801', '2025-01-01', null, 'draft'),
      ('00000000-0000-7000-9000-000000008812', v_org, '00000000-0000-7000-9000-000000008802', '2024-01-01', null, 'draft'),
      ('00000000-0000-7000-9000-000000008813', v_org, '00000000-0000-7000-9000-000000008801', '2024-01-01', '2024-06-30', 'draft')
    on conflict (id) do nothing;

    insert into labor_rate_version_policies (id, org_id, version_id, derivation_policy)
    values
      ('00000000-0000-7000-9000-000000008821', v_org, '00000000-0000-7000-9000-000000008811', 'explicit'),
      ('00000000-0000-7000-9000-000000008822', v_org, '00000000-0000-7000-9000-000000008812', 'explicit'),
      ('00000000-0000-7000-9000-000000008823', v_org, '00000000-0000-7000-9000-000000008813', 'explicit')
    on conflict (id) do nothing;

    -- One department scope on the drawer version only (makes ?dimension=unscoped
    -- a strict subset of the default). The department is fixture-owned so the
    -- scope-label subselect resolves a name rather than null.
    insert into departments (id, org_id, code, name, is_active)
    values ('00000000-0000-7000-9000-000000008831', v_org, 'FIELD', 'Field operations', true)
    on conflict (id) do nothing;

    insert into labor_rate_version_scopes (id, org_id, version_id, scope_type, scope_value_id, scope_value_text, include_children)
    values ('00000000-0000-7000-9000-000000008841', v_org, '00000000-0000-7000-9000-000000008811', 'department', '00000000-0000-7000-9000-000000008831', null, false)
    on conflict (id) do nothing;

    -- One billable item + one line on the drawer version (the lines aggregate
    -- joins items, so the item must exist; kind/category feed the picker
    -- dimensions).
    insert into items (id, org_id, name, kind, category, is_active)
    values ('00000000-0000-7000-9000-000000008851', v_org, 'Journeyman electrician', 'labor', 'field', true)
    on conflict (id) do nothing;

    insert into item_rate_lines (id, org_id, version_id, item_id, unit_code, unit_name, base_quantity, bill_rate, sort_order)
    values ('00000000-0000-7000-9000-000000008861', v_org, '00000000-0000-7000-9000-000000008811', '00000000-0000-7000-9000-000000008851', 'hour', 'Hour', 1, 95.00, 1)
    on conflict (id) do nothing;

    -- One adjustment with a free-text target (satisfies the one-value check
    -- via target_value_text) plus one term on the drawer version.
    insert into labor_rate_adjustments
      (id, org_id, version_id, code, name, category, calculation, value, unit,
       presentation, sort_order, is_active, applies_regular, applies_overtime,
       applies_double_time, applies_shift)
    values ('00000000-0000-7000-9000-000000008871', v_org, '00000000-0000-7000-9000-000000008811',
      'NIGHT', 'Night premium', 'surcharge', 'percent', 10.00, 'percent',
      'separate', 1, true, true, true, false, false)
    on conflict (id) do nothing;


    insert into labor_rate_adjustment_targets (id, org_id, adjustment_id, target_type, target_value_id, target_value_text, include_children)
    values ('00000000-0000-7000-9000-000000008881', v_org, '00000000-0000-7000-9000-000000008871', 'other', null, 'Night shift', false)
    on conflict (id) do nothing;

    insert into labor_rate_terms (id, org_id, version_id, code, label, content, placement, sort_order)
    values ('00000000-0000-7000-9000-000000008891', v_org, '00000000-0000-7000-9000-000000008811',
      'NET30', 'Payment terms', 'Net 30 days from invoice date.', 'footer', 1)
    on conflict (id) do nothing;

    -- Only NOW can the versions take their real states: adjustments, targets,
    -- terms, scopes and lines are all children, and every one of them is
    -- immutable once its version leaves draft. The product enforces the same
    -- order, so a fixture that ignores it is testing a state the app cannot
    -- reach.
    update item_rate_versions set status = 'active'
     where id in ('00000000-0000-7000-9000-000000008811', '00000000-0000-7000-9000-000000008812')
       and status = 'draft';
    update item_rate_versions set status = 'retired'
     where id = '00000000-0000-7000-9000-000000008813' and status = 'draft';
  end if;

  -- ---- pay-run wizard stubs --------------------------------------------------
  --
  -- The simulator never calculates payroll, so the /payroll/runs/[id] wizard
  -- renders an empty shell without these: two stubs on the existing fixture
  -- run …1811 (PAY-00001, calculated/draft) with their profiles, wage rates
  -- and baseline components. One stub is hourly-paid by EFT, the other is a
  -- salaried cheque payee — both payment rails and both pay bases behind one
  -- run. Each stub carries one BASE-linked earning and one component-free
  -- deduction, so both stub-line join branches render.
  declare
    v_emp_hourly uuid;
    v_emp_salary uuid;
    v_comp_base uuid := '00000000-0000-7000-9000-000000001901';
    v_comp_bonus uuid := '00000000-0000-7000-9000-000000001902';
  begin
    select id into v_emp_hourly from parties
     where org_id = v_org and display_name = 'Harborview Development LLC';
    select id into v_emp_salary from parties
     where org_id = v_org and display_name = 'Ade Balogun (Apprentice)';
    if v_emp_hourly is null or v_emp_salary is null then
      raise notice 'missing fixture parties; skipping pay-run wizard fixtures';
      return;
    end if;

    -- Baseline earning components (the engine's own BASELINE_COMPONENTS
    -- codes: BASE/base_pay + BONUS/bonus — the adjustment picker only lists
    -- active components whose system_key is null or one of
    -- base_pay/overtime/bonus/vacation_payout).
    insert into pay_components
      (id, org_id, code, name, kind, system_key, country, basis, taxable,
       pensionable, insurable, vacationable, non_periodic, sequence, is_active)
    values
      (v_comp_base, v_org, 'BASE', 'Base pay', 'earning', 'base_pay', 'CA',
       'per_hour', true, true, true, true, false, 10, true),
      (v_comp_bonus, v_org, 'BONUS', 'Bonus', 'earning', 'bonus', 'CA',
       'fixed_amount', true, true, true, false, true, 30, true)
    on conflict (id) do nothing;

    -- Profiles on the biweekly fixture schedule (…1801): the Scope roster
    -- lists exactly these two employees.
    insert into employee_payroll_profiles
      (id, org_id, employee_party_id, pay_schedule_id, province, pay_basis,
       country, stub_delivery, payment_method, is_active)
    values
      (gen_random_uuid(), v_org, v_emp_hourly,
       '00000000-0000-7000-9000-000000001801', 'ON', 'hourly',
       'CA', 'email', 'eft', true),
      (gen_random_uuid(), v_org, v_emp_salary,
       '00000000-0000-7000-9000-000000001801', 'ON', 'salary',
       'CA', 'email', 'cheque', true)
    on conflict do nothing;

    -- Wage rates effective before the run's pay date (2026-02-11), so the
    -- roster's has_wage flag is true for both employees.
    -- `gen_random_uuid()` makes the id useless as a conflict target, and the
    -- real uniqueness is (scope, effective_from) — so the guard names THAT.
    insert into labor_cost_rates
      (id, org_id, employee_party_id, rate, basis, effective_from, is_active,
       currency)
    select gen_random_uuid(), v_org, r.party, r.rate, r.basis, date '2026-01-01', true, 'USD'
      from (values (v_emp_hourly, 42.50, 'hour'), (v_emp_salary, 78000.00, 'year'))
             as r(party, rate, basis)
     where not exists (
       select 1 from labor_cost_rates x
        where x.org_id = v_org and x.employee_party_id = r.party
          and x.effective_from = date '2026-01-01'
     );

    -- Two calculated stubs on run …1811. country/filing columns satisfy the
    -- evidence CHECKs with the unknown-source branch (no pack is installed
    -- in the sim tenant, so no calculation evidence exists to cite).
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, federal_claim, provincial_claim,
       currency_code, gross, pensionable_earnings, insurable_earnings,
       net_pay, employer_cost, vacation_accrued, factors,
       country_source, filing_account_source)
    values
      ('00000000-0000-7000-9000-000000001911', v_org,
       '00000000-0000-7000-9000-000000001811', v_emp_hourly, 'ON',
       26, date '2026-02-11', 2026, 0, 0,
       'USD', 3400.00, 3400.00, 3400.00,
       2510.75, 3620.40, 136.00, '{"T": "441.20", "C": "186.85", "EI": "61.20"}',
       'unknown', 'unknown'),
      ('00000000-0000-7000-9000-000000001912', v_org,
       '00000000-0000-7000-9000-000000001811', v_emp_salary, 'ON',
       26, date '2026-02-11', 2026, 0, 0,
       'USD', 3000.00, 3000.00, 3000.00,
       2248.10, 3180.00, 120.00, '{"T": "380.55", "C": "164.80", "EI": "53.90"}',
       'unknown', 'unknown')
    on conflict (id) do nothing;

    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, hours, rate,
       amount, sequence)
    values
      ('00000000-0000-7000-9000-000000001921', v_org,
       '00000000-0000-7000-9000-000000001911', v_comp_base, 'earning',
       'Regular hours', 80, 42.50, 3400.00, 1),
      ('00000000-0000-7000-9000-000000001922', v_org,
       '00000000-0000-7000-9000-000000001911', null, 'deduction',
       'Income tax', null, null, -441.20, 2),
      ('00000000-0000-7000-9000-000000001923', v_org,
       '00000000-0000-7000-9000-000000001912', v_comp_base, 'earning',
       'Salary', null, null, 3000.00, 1),
      ('00000000-0000-7000-9000-000000001924', v_org,
       '00000000-0000-7000-9000-000000001912', null, 'deduction',
       'Income tax', null, null, -380.55, 2)
    on conflict (id) do nothing;
  end;

  -- ---- admin apps ------------------------------------------------------------
  -- The simulator never installs apps, so the list page would compare two
  -- identical empty states. Three apps in the SIM org: two installed (one
  -- with an active version carrying two endpoints, one with NO active
  -- version so the version cell renders the "—" fallback) and one disabled,
  -- so the status chips carry real counts and ?status=disabled selects.
  insert into apps (id, org_id, key, name, description, status, granted_permissions)
  values
    ('00000000-0000-7000-9000-000000001101', v_org, 'viewspec-demo', 'ViewSpec demo app',
     'Harness app with an active version', 'installed', '["records.read"]'),
    ('00000000-0000-7000-9000-000000001102', v_org, 'viewspec-noversion', 'ViewSpec versionless app',
     'Harness app with no active version', 'installed', '[]'),
    ('00000000-0000-7000-9000-000000001103', v_org, 'viewspec-archived', 'ViewSpec archived app',
     'Harness disabled app', 'disabled', '[]')
  on conflict (id) do nothing;

  insert into app_versions (id, org_id, app_id, version, manifest, status)
  values
    ('00000000-0000-7000-9000-000000001111', v_org,
     '00000000-0000-7000-9000-000000001101', '1.2.0',
     '{"endpoints": [{"name": "hello", "file": "backend/hello.js", "method": "GET"}, {"name": "submit", "file": "backend/submit.js", "method": "POST"}]}',
     'active')
  on conflict (id) do nothing;

  -- versions reference their app both ways: link the active version id back.
  -- Deferred FKs (both directions are DEFERRABLE) allow the two inserts in
  -- either order; this update lands after both exist.
  update apps set active_version_id = '00000000-0000-7000-9000-000000001111'
   where id = '00000000-0000-7000-9000-000000001101'
     and active_version_id is null;

  insert into app_files (id, org_id, app_id, version_id, path, kind, content_type, content, is_binary, size)
  values
    ('00000000-0000-7000-9000-000000001121', v_org,
     '00000000-0000-7000-9000-000000001101', '00000000-0000-7000-9000-000000001111',
     'frontend/index.html', 'frontend', 'text/html', '<h1>demo</h1>', false, 15),
    ('00000000-0000-7000-9000-000000001122', v_org,
     '00000000-0000-7000-9000-000000001101', '00000000-0000-7000-9000-000000001111',
     'backend/hello.js', 'backend', 'text/javascript', 'export default async () => ({ ok: true })', false, 44)
  on conflict (id) do nothing;

  insert into app_runs (id, org_id, app_id, version_id, endpoint, status, units, logs, error_message, duration_ms, at)
  values
    ('00000000-0000-7000-9000-000000001131', v_org,
     '00000000-0000-7000-9000-000000001101', '00000000-0000-7000-9000-000000001111',
     'hello', 'ok', 1, '["started"]', null, 12, now() - interval '1 day'),
    ('00000000-0000-7000-9000-000000001132', v_org,
     '00000000-0000-7000-9000-000000001101', '00000000-0000-7000-9000-000000001111',
     'submit', 'error', 2, '["started"]', 'boom', 30, now() - interval '2 hours')
  on conflict (id) do nothing;

  -- ---- AP capture (…2001-2099) ------------------------------------------------
  --
  -- The simulator never uploads vendor documents, so /ap/capture is empty
  -- without these: four items across four statuses (one needs_review doubles
  -- as the drawer target with a run + evidence). All vendor_candidate_id and
  -- purchase_order_id NULL — the subsidiary scope passes them through, and
  -- the search branch is exercised via normalized->>'vendorName'.
  declare
    v_capture_file uuid := '00000000-0000-7000-9000-000000002009';
    v_capture_folder uuid;
  begin
    -- `files.folder_id` is NOT NULL, so a captured document still lives
    -- somewhere in the cabinet. Reuse the cabinet fixture's folder rather
    -- than inventing a second root.
    select id into v_capture_folder from folders
     where org_id = v_org order by created_at limit 1;
    if v_capture_folder is null then
      raise notice 'no folder for AP capture file; skipping capture fixtures';
      return;
    end if;

    insert into files
      (id, org_id, folder_id, name, extension, file_type, content_type,
       size_bytes, storage_kind, content_hash, is_inactive)
    values
      (v_capture_file, v_org, v_capture_folder, 'viewspec-invoice-vs-1001.pdf', 'pdf',
       'document', 'application/pdf', 48210, 'db',
       'viewspec-capture-file-2009', false)
    on conflict (id) do nothing;

    insert into ap_capture_items
      (id, org_id, file_id, status, source, original_filename, content_hash,
       document_kind, normalized, validation_issues, overall_confidence,
       received_at)
    values
      ('00000000-0000-7000-9000-000000002001', v_org, v_capture_file,
       'needs_review', 'upload', 'viewspec-acme-invoice.pdf',
       'viewspec-capture-2001', 'vendor_bill',
       '{"vendorName": "ViewSpec Acme Supplies", "invoiceNumber": "VS-1001",
         "invoiceDate": "2026-08-14", "currency": "USD", "total": "1250.00",
         "subtotal": "1157.41", "taxTotal": "92.59", "memo": null,
         "dueDate": null,
         "lines": [{"description": "ViewSpec fixture line",
                    "productCode": null, "quantity": "1.0000", "unit": null,
                    "unitPrice": "1250.0000", "amount": "1250.0000",
                    "taxAmount": "0.0000", "accountId": null, "itemId": null,
                    "purchaseOrderLineId": null, "confidence": null}]}'::jsonb,
       '[{"code": "vendor_unresolved", "severity": "blocking"}]'::jsonb,
       0.8200, now() - interval '3 hours'),
      ('00000000-0000-7000-9000-000000002002', v_org, v_capture_file,
       'queued', 'upload', 'viewspec-queued-scan.pdf',
       'viewspec-capture-2002', 'vendor_bill',
       '{"vendorName": null, "invoiceNumber": null, "invoiceDate": null,
         "currency": null, "total": null, "lines": []}'::jsonb,
       '[]'::jsonb, null, now() - interval '1 hour'),
      ('00000000-0000-7000-9000-000000002003', v_org, v_capture_file,
       'failed', 'upload', 'viewspec-failed-scan.pdf',
       'viewspec-capture-2003', 'vendor_credit',
       '{"vendorName": "ViewSpec Acme Supplies", "invoiceNumber": "VS-1002",
         "invoiceDate": null, "currency": "USD", "total": null,
         "lines": []}'::jsonb,
       '[{"code": "required_field", "severity": "blocking",
          "field": "invoiceDate"}]'::jsonb,
       0.3100, now() - interval '2 days'),
      ('00000000-0000-7000-9000-000000002004', v_org, v_capture_file,
       'materialized', 'upload', 'viewspec-done-invoice.pdf',
       'viewspec-capture-2004', 'vendor_bill',
       '{"vendorName": "ViewSpec Acme Supplies", "invoiceNumber": "VS-0998",
         "invoiceDate": "2026-07-30", "currency": "USD", "total": "842.10",
         "lines": [{"description": "ViewSpec fixture line",
                    "productCode": null, "quantity": "1.0000", "unit": null,
                    "unitPrice": "842.1000", "amount": "842.1000",
                    "taxAmount": "0.0000", "accountId": null, "itemId": null,
                    "purchaseOrderLineId": null, "confidence": null}]}'::jsonb,
       '[]'::jsonb, 0.9700, now() - interval '3 days')
    on conflict (id) do nothing;

    -- A run that is not `running` must carry a finish time (CHECK), so the
    -- succeeded attempt names one rather than leaving the column null.
    insert into ap_capture_runs
      (id, org_id, capture_item_id, attempt, provider, model, api_version, status,
       finished_at)
    values
      ('00000000-0000-7000-9000-000000002011', v_org,
       '00000000-0000-7000-9000-000000002001', 1,
       'azure_document_intelligence', 'prebuilt-invoice', '2024-02-29-preview',
       'succeeded', now() - interval '1 hour')
    on conflict (id) do nothing;

    insert into ap_capture_fields
      (id, org_id, run_id, field_key, line_index, raw_value,
       normalized_value, confidence, page_number)
    values
      ('00000000-0000-7000-9000-000000002021', v_org,
       '00000000-0000-7000-9000-000000002011', 'invoiceNumber', null,
       'VS-1001', '"VS-1001"'::jsonb, 0.9900, 1),
      ('00000000-0000-7000-9000-000000002022', v_org,
       '00000000-0000-7000-9000-000000002011', 'total', null,
       '1250.00', '"1250.00"'::jsonb, 0.9400, 1)
    on conflict (id) do nothing;
  end;

  -- No overhead rate fixture. The proposed row was rejected by the engine's
  -- own guard — "children of an activated or retired rate version are
  -- immutable" — and forcing one in would mean either deactivating a live
  -- rate version or writing under a retired one. Both misrepresent the
  -- product to make a test row exist, so the rates tab is covered by its
  -- real state instead.
end $$;
