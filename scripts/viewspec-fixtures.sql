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
--   …0001-0099  continuous close (runs, work items, evidence);
--                 …0014-0017 tax jurisdictions and nexus registrations
--   …0301-0399  approvals (flows, runs, gates)
--   …0401-0499  banking statements, reconciliations and their journal entry
--   …0501-0599  banking transactions (checks, deposits)
--   …0601-0699  sales orders          …0701-0799  quotes
--   …0801-0899  subcontracts and their schedule-of-values lines
--   …0901-0999  purchase orders
--   …1801-1899  payroll schedules and runs (…1840 remittances, …1850
--                 year-end, …1860 separations, …1870 opening balances)
--   …2101-2199  WIP prebilling worksheets, lines, events
--   …2801-2899  field tickets
--   …2901-2999  revenue contracts, obligations, recognition schedules
--   …3101-3199  org-authored PDF templates
--   …3801-3899  bank matching rules
--   …4001-4099  book depreciation methods and policies
--   …4801-4899  budget scenarios and lines
--   …5801-5899  file cabinet folders, files, versions
--   …6801-6899  tax return forms and filings
--   …6901-6999  income-tax provision runs and temporary differences
--   …7801-7899  psp settlement batches
--   …1101-1199  installed apps
--   …2001-2099  AP capture documents
--   …1001-1099  backup policy and runs
--   …8801-8899  labor bill rate books
--   …1901-1999  pay stubs, employee profiles, wage rates
--   …9801-9810  app marketplace listings
--   …9821-9899  platform sync connections, runs, QBD sessions/captures
--   …9901-9999  tax depreciation regimes, pool classes, asset categories
--   …1201-1299  bank feed connections
--   …1301-1399  CRM prospect parties and account profiles
--   …1501-1599  sandboxes
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
             'queryConsole', true,
             'propertyManagement', true,
             'bankFeeds', true,
             'subcontracts', true,
             'wipBilling', true))
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

  -- ---- admin backups ----------------------------------------------------------
  -- The simulator never runs backups, so the page would compare two
  -- identical empty states. One policy (enabled, weekly) plus two runs:
  -- one completed (downloadable: archive/manifest/delete actions) and one
  -- running (exercises the in-progress cell + the live-polling branch).
  -- Guarded all-or-nothing: backup_policies is one-row-per-org (PK on
  -- org_id), so skip the block if the SIM org already has a policy.
  begin
    if not exists (select 1 from backup_policies where org_id = v_org) then
      insert into backup_policies
        (org_id, enabled, frequency, hour_utc, day_of_week, day_of_month,
         max_keep, last_run_at, next_run_at)
      values
        (v_org, true, 'weekly', 2, 1, 1,
         7, timestamptz '2026-08-24 02:00:00+00', timestamptz '2026-08-31 02:00:00+00');

      insert into backup_runs
        (id, org_id, kind, status, file_name, byte_size, table_count,
         row_count, sha256, error, purged_at, purge_reason, created_at,
         completed_at)
      values
        ('00000000-0000-7000-9000-000000001001', v_org, 'scheduled', 'completed',
         'openbooks-2026-08-24.tar.zst', 1048576, 42,
         123456, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
         null, null, null, timestamptz '2026-08-24 02:00:00+00',
         timestamptz '2026-08-24 02:04:11+00'),
        ('00000000-0000-7000-9000-000000001002', v_org, 'manual', 'running',
         null, null, null,
         null, null, null, null, null, timestamptz '2026-08-30 01:00:00+00',
         null)
      on conflict (id) do nothing;
    end if;
  end;

  -- ---- app launcher (/apps): no-description fallback -------------------------
  -- Same SIM-org apps the admin-apps block seeds, plus one installed app
  -- WITH an active version but a NULL description, so the launcher's
  -- `description || t('noDescription')` fallback renders real copy instead
  -- of coinciding with the demo app's description. GUARD before insert:
  -- the apps table has no trigger or CHECK to defeat, but the unique key
  -- is (org_id, key), not the id — ON CONFLICT (id) alone would raise on a
  -- re-run with a changed id, so the guard owns idempotence.
  insert into apps (id, org_id, key, name, description, status, granted_permissions)
  select '00000000-0000-7000-9000-000000001104', v_org, 'viewspec-nodesc', 'ViewSpec nodesc app',
         null, 'installed', '[]'
   where not exists (select 1 from apps where org_id = v_org and key = 'viewspec-nodesc');

  insert into app_versions (id, org_id, app_id, version, manifest, status)
  select '00000000-0000-7000-9000-000000001112', v_org,
         (select id from apps where org_id = v_org and key = 'viewspec-nodesc'), '0.1.0',
         '{"endpoints": []}', 'active'
   where not exists (select 1 from app_versions where id = '00000000-0000-7000-9000-000000001112');

  update apps set active_version_id = '00000000-0000-7000-9000-000000001112'
   where org_id = v_org and key = 'viewspec-nodesc'
     and active_version_id is null;

  -- The /admin/setup/crm agent applied these directly to the tenant and never
  -- folded them into this file, so the harness was passing on rows nothing
  -- could recreate. A fixture that only exists in one database is not a
  -- fixture.
  declare
    v_crm_owner uuid;
  begin
    select id into v_crm_owner from users where org_id = v_org order by created_at limit 1;
    if v_crm_owner is null then
      raise notice 'no user for CRM setup fixtures; skipping';
      return;
    end if;
    -- ---- crm setup ----------------------------------------------------------------
    --
    -- Lead sources, one territory and one team for the /admin/setup/crm
    -- conversion. The simulator seeds account statuses (9), opportunity
    -- statuses (6) and one quota for the SIM org but no sources, territories
    -- or teams, so three of the six tabs would compare two identical empty
    -- states. Two sources, one territory and one team (with one active member
    -- so member_count renders 1) close that gap; the account-statuses default
    -- already carries 9 rows and the drawer variant opens the fixture quota
    -- ...a000-...010 from the forecasts block above.
    insert into crm_lead_sources (id, org_id, key, name, description, is_active)
    values
      ('00000000-0000-7000-a000-000000000101', v_org, 'vs-web', 'ViewSpec Web', 'Seeded for the CRM setup conformance tab', true),
      ('00000000-0000-7000-a000-000000000102', v_org, 'vs-referral', 'ViewSpec Referral', 'Seeded for the CRM setup conformance tab', true)
    on conflict (id) do nothing;

    insert into crm_sales_teams (id, org_id, key, name, manager_user_id, is_active)
    values ('00000000-0000-7000-a000-000000000103', v_org, 'vs-team', 'ViewSpec Sales', v_crm_owner, true)
    on conflict (id) do nothing;

    insert into crm_sales_team_members (org_id, team_id, user_id, role, is_active)
    values (v_org, '00000000-0000-7000-a000-000000000103', v_crm_owner, 'manager', true)
    on conflict do nothing;

    insert into crm_sales_territories
      (id, org_id, key, name, description, priority, manager_user_id, default_owner_user_id, match_mode, rules, is_active)
    values ('00000000-0000-7000-a000-000000000104', v_org, 'vs-west', 'ViewSpec West',
      'Seeded for the CRM setup conformance tab', 100, v_crm_owner, v_crm_owner, 'all', '[]'::jsonb, true)
    on conflict (id) do nothing;
  end;

  -- ---- crm activities -------------------------------------------------------
  --
  -- The simulator never writes activities, so the list page would come up
  -- empty. Two UNLINKED activities (no crm_activity_links rows, no contact
  -- participants): crmActivityScope passes unlinked rows for any grant set,
  -- and the Default `activity` list view in both sim orgs has no filters, so
  -- both fixtures render. Dates are relative so the fixture keeps working as
  -- the simulated clock moves.
  declare
    v_act_owner uuid;
  begin
    select id into v_act_owner from users where org_id = v_org order by created_at limit 1;
    if v_act_owner is null then
      raise notice 'no users; skipping activity fixtures';
      return;
    end if;

    insert into crm_activities
      (id, org_id, kind, status, subject, body, priority,
       owner_user_id, assigned_user_id, starts_at, due_at)
    values
      ('00000000-0000-7000-a000-000000000101', v_org, 'task', 'planned',
       'ViewSpec activity conformance A', 'Harness activity A', 'normal',
       v_act_owner, v_act_owner, current_timestamp + interval '1 day', current_timestamp + interval '2 days'),
      ('00000000-0000-7000-a000-000000000102', v_org, 'call', 'in_progress',
       'ViewSpec activity conformance B', 'Harness activity B', 'high',
       v_act_owner, v_act_owner, current_timestamp + interval '3 days', current_timestamp + interval '4 days')
    on conflict (id) do nothing;
  end;

  -- ---- bank feeds -----------------------------------------------------------
  --
  -- The simulator never connects a bank feed, so /admin/setup/bank-feeds
  -- renders its empty state on both paths. One live-cadence GoCardless
  -- connection on the SIM org's reconcilable operating account, so the
  -- connection list has a row. No SFTP server is seeded: the SFTP cards
  -- and the shared endpoint card stay in their guarded-empty branch.
  -- Claims fresh block …1201-1299 (verified unused).
  insert into bank_feed_connections
    (id, org_id, name, provider, account_id, status, sync_cadence,
     last_sync_at, is_active)
  values
    ('00000000-0000-7000-9000-000000001201', v_org,
     'ViewSpec operating feed', 'gocardless',
     (select id from accounts
       where org_id = v_org and reconcilable and not is_summary and is_active
       order by number nulls last limit 1),
     'connected', 'daily', now() - interval '1 day', true)
  on conflict (id) do nothing;

  -- ---- tax depreciation overview (/admin/setup/tax-depreciation) ------------
  --
  -- One pool regime + one class + one asset category assigned to that class,
  -- so the overview renders the assignments table (1 regime column) and the
  -- regimes/classes entity tabs each list one row. Fresh 99xx block (no
  -- existing fixture uses it). GUARD before insert: the natural keys are
  -- (org_id, code) / (org_id, regime, class_code) / (org_id, name), not the
  -- ids — ON CONFLICT (id) alone would raise on a re-run with changed keys,
  -- so each guard owns its idempotence. Category accounts resolve live from
  -- the sim org (the org-guard trigger requires active postable in-tenant
  -- accounts); the run is skipped if none exist.
  insert into tax_regimes (id, org_id, code, name, country_code, calculation_model, class_attribute, is_active)
  select '00000000-0000-7000-9000-000000009901', v_org, 'VS_POOL',
         'ViewSpec pool regime', 'CA', 'pool', 'vs_pool_class', true
   where not exists (select 1 from tax_regimes where org_id = v_org and code = 'VS_POOL');

  insert into tax_pool_classes (id, org_id, regime, class_code, name, rate, method, first_year_fraction, is_active)
  select '00000000-0000-7000-9000-000000009902', v_org, 'VS_POOL', 'VS_8',
         'ViewSpec class 8', 0.20, 'declining', 1, true
   where not exists (select 1 from tax_pool_classes where org_id = v_org and regime = 'VS_POOL' and class_code = 'VS_8');

  insert into asset_categories (id, org_id, name, asset_account_id,
         accumulated_depreciation_account_id, depreciation_expense_account_id,
         tax_attributes, is_active)
  select '00000000-0000-7000-9000-000000009903', v_org, 'ViewSpec machinery',
         a.asset_id, a.accum_id, a.exp_id,
         '{"vs_pool_class": "VS_8"}'::jsonb, true
    from (select
            (select id from accounts where org_id = v_org and is_active and not is_summary order by number limit 1) as asset_id,
            (select id from accounts where org_id = v_org and is_active and not is_summary order by number limit 1 offset 1) as accum_id,
            (select id from accounts where org_id = v_org and is_active and not is_summary order by number limit 1 offset 2) as exp_id) a
   where a.asset_id is not null and a.accum_id is not null and a.exp_id is not null
     and not exists (select 1 from asset_categories where org_id = v_org and name = 'ViewSpec machinery');

  -- ---- income-tax provision detail (/tax/provisions/[id]) ------------------
  -- Three runs: an IAS 12 draft (post button + differences), an ASC 740
  -- draft with NO differences (italic empty-note branch), and a posted run
  -- (button hidden). GUARDs before inserts: the one-draft-per-year partial
  -- unique index is on (org_id, fiscal_year), not the id, and finalized
  -- runs are trigger-immutable — ON CONFLICT (id) alone cannot own
  -- idempotence here.
  insert into tax_provision_runs
    (id, org_id, fiscal_year, period_from, period_to, status, version,
     snapshot_hash, payload)
  select '00000000-0000-7000-9000-000000006901', v_org, 2026,
         '2026-01-01', '2026-12-31', 'draft', 1, repeat('d', 64),
         jsonb_build_object(
           'fiscalYear', 2026, 'framework', 'ias12',
           'pretaxBookIncome', '500000.00', 'enactedRatePercent', '21',
           'taxableIncome', '480000.00', 'currentTax', '100800.00',
           'deferredExpense', '4200.00', 'totalExpense', '105000.00',
           'balances', jsonb_build_object(
             'dtaGross', '35000.00', 'dtlGross', '30000.00',
             'valuationAllowance', '9000.00'),
           'rateReconciliation', jsonb_build_array(
             jsonb_build_object('key', 'statutory', 'label', 'Statutory tax', 'amount', '105000.00', 'percent', '21'),
             jsonb_build_object('key', 'credits', 'label', 'Tax credits', 'amount', '-8000.00', 'percent', '-1.6'),
             jsonb_build_object('key', 'va', 'label', 'Recognition adjustment', 'amount', '9000.00', 'percent', '1.8'),
             jsonb_build_object('key', 'other', 'label', 'Other', 'amount', '-1000.00', 'percent', null),
             jsonb_build_object('key', 'total', 'label', 'Total income tax expense', 'amount', '105000.00', 'percent', '21')))
   where not exists (select 1 from tax_provision_runs
                      where org_id = v_org and fiscal_year = 2026 and version = 1);

  insert into tax_provision_runs
    (id, org_id, fiscal_year, period_from, period_to, status, version,
     snapshot_hash, payload)
  select '00000000-0000-7000-9000-000000006902', v_org, 2025,
         '2025-01-01', '2025-12-31', 'draft', 1, repeat('e', 64),
         jsonb_build_object(
           'fiscalYear', 2025, 'framework', 'asc740',
           'pretaxBookIncome', '200000.00', 'enactedRatePercent', '21',
           'taxableIncome', '200000.00', 'currentTax', '42000.00',
           'deferredExpense', '0.00', 'totalExpense', '42000.00',
           'balances', jsonb_build_object(
             'dtaGross', '0.00', 'dtlGross', '0.00',
             'valuationAllowance', '0.00'),
           'rateReconciliation', jsonb_build_array(
             jsonb_build_object('key', 'statutory', 'label', 'Statutory tax', 'amount', '42000.00', 'percent', '21'),
             jsonb_build_object('key', 'other', 'label', 'Other', 'amount', '0.00', 'percent', null),
             jsonb_build_object('key', 'total', 'label', 'Total income tax expense', 'amount', '42000.00', 'percent', '21')))
   where not exists (select 1 from tax_provision_runs
                      where org_id = v_org and fiscal_year = 2025 and version = 1);

  insert into tax_provision_runs
    (id, org_id, fiscal_year, period_from, period_to, status, version,
     snapshot_hash, payload, journal_entry_id, posted_at, posted_by)
  select '00000000-0000-7000-9000-000000006903', v_org, 2024,
         '2024-01-01', '2024-12-31', 'posted', 1, repeat('f', 64),
         jsonb_build_object(
           'fiscalYear', 2024, 'framework', 'asc740',
           'pretaxBookIncome', '300000.00', 'enactedRatePercent', '21',
           'taxableIncome', '290000.00', 'currentTax', '60900.00',
           'deferredExpense', '2100.00', 'totalExpense', '63000.00',
           'balances', jsonb_build_object(
             'dtaGross', '12000.00', 'dtlGross', '10000.00',
             'valuationAllowance', '100.00'),
           'rateReconciliation', jsonb_build_array(
             jsonb_build_object('key', 'statutory', 'label', 'Statutory tax', 'amount', '63000.00', 'percent', '21'),
             jsonb_build_object('key', 'perm', 'label', 'Permanent differences', 'amount', '-2100.00', 'percent', '-0.7'),
             jsonb_build_object('key', 'other', 'label', 'Other', 'amount', '2100.00', 'percent', null),
             jsonb_build_object('key', 'total', 'label', 'Total income tax expense', 'amount', '63000.00', 'percent', '21'))),
         '00000000-0000-7000-9000-000000006909',
         timestamptz '2025-03-15 12:00:00+00',
         (select id from users where org_id = v_org order by created_at limit 1)
   where not exists (select 1 from tax_provision_runs
                      where org_id = v_org and fiscal_year = 2024 and version = 1);

  -- Differences for the IAS 12 draft only (3 rows: auto + manual + a
  -- null-percent sibling). The ASC 740 draft gets NONE — it is the empty-note
  -- variant. The posted run ALSO gets none: the temp-difference history
  -- trigger (`protect_temporary_difference_history`) rejects ANY insert
  -- against a non-draft run (verified: attempted insert raises
  -- 'temporary differences are immutable after provision finalization'),
  -- so a posted run with seeded differences is unseedable — the posted
  -- variant exercises the hidden post button + recon rows instead.
  -- `subsidiary_id` is left null (nullable, and the SIM org has a single
  -- subsidiary the harness user sees anyway). Guard before insert: the same
  -- trigger requires the parent run to exist with status `draft`, so the
  -- guard owns idempotence on re-runs.
  insert into temporary_differences
    (id, org_id, run_id, category, description, book_basis, tax_basis,
     difference, rate_percent, tax_effect, source)
  select v.id::uuid, v_org, '00000000-0000-7000-9000-000000006901',
         v.category, v.description, v.book_basis::numeric, v.tax_basis::numeric,
         v.difference::numeric, v.rate_percent::numeric, v.tax_effect::numeric, v.source
    from (values
      ('00000000-0000-7000-9000-000000006911', 'fixed_assets',
       'Accelerated depreciation', '120000.00', '80000.00', '40000.00', '21', '8400.00', 'auto'),
      ('00000000-0000-7000-9000-000000006912', 'provisions',
       'Warranty reserve', '15000.00', '0.00', '15000.00', '21', '3150.00', 'manual'),
      ('00000000-0000-7000-9000-000000006913', 'loss_carryforward',
       'NOL carryforward', '0.00', '42857.14', '-42857.14', '21', '-9000.00', 'manual')) as v(id, category, description, book_basis, tax_basis, difference, rate_percent, tax_effect, source)
   where (select status from tax_provision_runs
           where id = '00000000-0000-7000-9000-000000006901') = 'draft'
     and not exists (select 1 from temporary_differences
                      where id in ('00000000-0000-7000-9000-000000006911',
                                   '00000000-0000-7000-9000-000000006912',
                                   '00000000-0000-7000-9000-000000006913'));

  -- (No differences insert for the posted run: the history trigger forbids
  -- it. Its variant is recon-rows + empty-note + no post button.)

  -- ---- parallel run ----------------------------------------------------------
  --
  -- The simulator never imports a prior register, so /payroll/parallel-run
  -- renders two empty states without these: one register (2 stubs, 2
  -- amounts, one unmapped column) plus one `differences` comparison with
  -- one finding and one tolerance applied. The register pay_date matches
  -- the first sim pay run (PAY-00001, pay_date 2026-02-11), so the native
  -- period-suggestion path resolves. GUARD before insert: the unique key
  -- is (org_id, name), not the id — ON CONFLICT (id) alone would raise on
  -- a re-run, so the guard owns idempotence.
  declare
    v_reg uuid := '00000000-0000-7000-9000-000000001830';
    v_cmp uuid := '00000000-0000-7000-9000-000000001831';
    v_payrun uuid;
    v_actor uuid;
    v_emp uuid;
  begin
    select document_id into v_payrun from pay_runs
     where org_id = v_org and document_id = '00000000-0000-7000-9000-000000001811';
    select id into v_actor from users where org_id = v_org order by created_at limit 1;
    select id into v_emp from parties
     where org_id = v_org and is_active
     order by display_name limit 1;
    -- NOT `return`: a bare return in a nested block exits the WHOLE anonymous
    -- block, silently skipping every fixture appended below this one.
    if v_payrun is null or v_actor is null or v_emp is null then
      raise notice 'missing pay run/actor/party; skipping parallel-run fixtures';
    else

    insert into payroll_prior_registers
      (id, org_id, name, provider_name, period_start, period_end, pay_date,
       currency_code, source_file_name, unmapped_columns, created_by, updated_by)
    select v_reg, v_org, 'ViewSpec prior register', 'LegacyCo',
           date '2026-01-24', date '2026-02-06', date '2026-02-11',
           'USD', 'legacy-jan.csv', '[{"column": "parking", "valuedRows": 2}]'::jsonb,
           v_actor, v_actor
     where not exists (select 1 from payroll_prior_registers
                        where org_id = v_org and name = 'ViewSpec prior register');

    insert into payroll_prior_stubs
      (id, org_id, register_id, employee_party_id, employee_label,
       gross, net_pay, employer_cost, created_by, updated_by)
    select '00000000-0000-7000-9000-000000001832', v_org, v_reg, v_emp,
           'ViewSpec Employee', 5200.0000, 4000.0000, 600.0000, v_actor, v_actor
     where exists (select 1 from payroll_prior_registers where id = v_reg)
       and not exists (select 1 from payroll_prior_stubs
                        where id = '00000000-0000-7000-9000-000000001832');

    insert into payroll_prior_amounts
      (id, org_id, prior_stub_id, component_id, kind, slot, source_column,
       amount, created_by, updated_by)
    select '00000000-0000-7000-9000-000000001833', v_org,
           '00000000-0000-7000-9000-000000001832', null, 'earning',
           'code:BASE', 'Base Pay', 5200.0000, v_actor, v_actor
     where exists (select 1 from payroll_prior_stubs
                    where id = '00000000-0000-7000-9000-000000001832')
       and not exists (select 1 from payroll_prior_amounts
                        where id = '00000000-0000-7000-9000-000000001833');

    insert into payroll_parallel_tolerances
      (id, org_id, kind, slot, tolerance, reason, created_by, updated_by)
    select '00000000-0000-7000-9000-000000001834', v_org, 'total',
           'net_pay', 1.0000, 'ViewSpec: legacy rounds net to the cent', v_actor, v_actor
     where not exists (select 1 from payroll_parallel_tolerances
                        where org_id = v_org and kind = 'total' and slot = 'net_pay');

    insert into payroll_parallel_comparisons
      (id, org_id, register_id, pay_run_document_id, status,
       prior_employee_count, our_employee_count, compared_employee_count,
       prior_only_employee_count, our_only_employee_count,
       match_count, within_tolerance_count, difference_count, one_sided_count,
       prior_gross, our_gross, prior_net, our_net,
       prior_employer_cost, our_employer_cost,
       unattributed_gross, unattributed_net, unattributed_employer_cost,
       tolerances_applied, unmapped_columns, blocked_reason, created_by, updated_by)
    select v_cmp, v_org, v_reg, v_payrun, 'differences',
           1, 1, 1,
           0, 0,
           0, 1, 1, 0,
           5200.0000, 5200.0000, 4000.0000, 3999.5000,
           600.0000, 600.0000,
           0.0000, 0.0000, 0.0000,
           '[{"kind": "total", "slot": "net_pay", "tolerance": "1.0000", "reason": "ViewSpec: legacy rounds net to the cent"}]'::jsonb,
           '[{"column": "parking", "valuedRows": 2}]'::jsonb,
           null, v_actor, v_actor
     where exists (select 1 from payroll_prior_registers where id = v_reg)
       and not exists (select 1 from payroll_parallel_comparisons where id = v_cmp);

    insert into payroll_parallel_findings
      (id, org_id, comparison_id, employee_party_id, employee_name, kind,
       slot, slot_label, classification, prior_amount, our_amount,
       difference, tolerance_applied, source_column, sequence, created_by, updated_by)
    select '00000000-0000-7000-9000-000000001835', v_org, v_cmp, v_emp,
           'ViewSpec Employee', 'earning',
           'code:BASE', 'Base pay', 'difference', 5200.0000, 5199.5000,
           0.5000, 0.0000, 'Base Pay', 100, v_actor, v_actor
     where exists (select 1 from payroll_parallel_comparisons where id = v_cmp)
       and not exists (select 1 from payroll_parallel_findings
                        where id = '00000000-0000-7000-9000-000000001835');
  
    end if;
  end;

  -- ---- app library (/apps/library): marketplace listings --------------------
  -- Block …9801-9803. (Proposed as …1201-1203, which the bank-feed
  -- connection above already holds — and a collision here is a SILENT
  -- guard skip, not an error.)
  -- listListings reads app_listings (deployment-wide, not per-org), which is
  -- EMPTY in every environment — without rows the page compares two
  -- identical empty notes. Three active listings: two with descriptions
  -- (one matching "payroll", so ?q=payroll narrows 3 cards to 1) and one
  -- with a NULL description, so the `description || t('noDescription')`
  -- fallback renders real copy. GUARD before insert: app_listings has a
  -- UNIQUE on key (not just the id PK) and NO trigger or CHECK to defeat,
  -- so ON CONFLICT (id) DO NOTHING alone would raise on a re-run that
  -- re-seeds the same keys — the guard on key owns idempotence.
  -- Publisher is the SIM org (publisher_org_id is NOT NULL); manifest/files
  -- are NOT NULL so the rows carry the empty-manifest defaults.
  insert into app_listings (id, publisher_org_id, key, name, description, version, is_active)
  select '00000000-0000-7000-9000-000000009801', v_org, 'viewspec-lib-invoicing',
         'ViewSpec invoicing pack', 'Harness listing with a description', '2.3.0', true
   where not exists (select 1 from app_listings where key = 'viewspec-lib-invoicing');

  insert into app_listings (id, publisher_org_id, key, name, description, version, is_active)
  select '00000000-0000-7000-9000-000000009802', v_org, 'viewspec-lib-payroll',
         'ViewSpec payroll pack', 'Harness payroll listing', '1.0.0', true
   where not exists (select 1 from app_listings where key = 'viewspec-lib-payroll');

  insert into app_listings (id, publisher_org_id, key, name, description, version, is_active)
  select '00000000-0000-7000-9000-000000009803', v_org, 'viewspec-lib-nodesc',
         'ViewSpec nodesc listing', null, '0.9.0', true
   where not exists (select 1 from app_listings where key = 'viewspec-lib-nodesc');

  -- ---- document trash (/documents/trash) -----------------------------------
  -- The simulator never deletes cabinet rows, so /documents/trash would
  -- compare two identical empty states. One trashed folder plus one trashed
  -- file in an ACTIVE location folder (so the `inLocation` branch renders),
  -- both inactive but neither private nor system, so the harness admin sees
  -- them through listTrash's visibility predicates. Block …5811-5814.
  insert into folders (id, org_id, parent_folder_id, name, is_inactive)
  values ('00000000-0000-7000-9000-000000005811', v_org, null, 'ViewSpec Trashed Folder', true),
         ('00000000-0000-7000-9000-000000005813', v_org, null, 'ViewSpec Trash Location', false)
  on conflict (id) do nothing;

  insert into files
    (id, org_id, folder_id, name, extension, file_type, content_type,
     size_bytes, storage_kind, content_hash, is_inactive)
  values
    ('00000000-0000-7000-9000-000000005812', v_org,
     '00000000-0000-7000-9000-000000005813', 'viewspec-trashed.txt', 'txt',
     'text', 'text/plain', 42, 'db', 'viewspec-trash-file-5812', true)
  on conflict (id) do nothing;

  insert into file_versions (id, file_id, version_number, size_bytes, content_type)
  values ('00000000-0000-7000-9000-000000005814',
          '00000000-0000-7000-9000-000000005812', 1, 42, 'text/plain')
  on conflict (id) do nothing;

  -- ---- subcontracts (/subcontracts) ----------------------------------------
  -- The register table is client-fetched, but it renders whatever the tenant
  -- holds and the tenant holds nothing — so both paths would show the
  -- "No subcontracts yet" state, which is the comparison the harness refuses.
  -- One `active` subcontract (it sorts first in the register's ORDER BY CASE)
  -- with one SOV line. Block …0801-0802.
  --
  -- Project and vendor resolve LIVE by name rather than by hardcoded id: the
  -- simulator regenerates ids on every reseed, and a stale uuid here would
  -- either violate the FK or, worse, point at the wrong tenant's row.
  -- `(org_id, number)` is unique, so the guard is on `number`.
  insert into subcontracts
    (id, org_id, project_id, vendor_id, number, title, status, currency,
     original_commitment, default_retainage_percent)
  select '00000000-0000-7000-9000-000000000801', v_org, p.id, v.id,
         'VSPEC-001', 'ViewSpec conformance subcontract', 'active', 'USD',
         100000, 10
    from (select id from projects
           where org_id = v_org and is_active order by name limit 1) p,
         (select pa.id from parties pa
            join vendor_roles vr on vr.party_id = pa.id and vr.org_id = pa.org_id
           where pa.org_id = v_org and vr.is_active
           order by pa.display_name limit 1) v
   where not exists (select 1 from subcontracts where org_id = v_org and number = 'VSPEC-001');

  insert into subcontract_sov_lines
    (id, org_id, subcontract_id, description, scheduled_value, sort_order)
  select '00000000-0000-7000-9000-000000000802', v_org,
         '00000000-0000-7000-9000-000000000801', 'Conformance SOV line', 100000, 0
   where exists (select 1 from subcontracts where id = '00000000-0000-7000-9000-000000000801')
     and not exists (select 1 from subcontract_sov_lines
                      where id = '00000000-0000-7000-9000-000000000802');

  -- ---- revenue contracts ---------------------------------------------------
  --
  -- The simulator never creates revenue contracts, so /revenue is empty
  -- without these: two contracts, one active with obligations + schedules
  -- (the drawer path) and one cancelled (the ?status=cancelled branch).
  -- FK targets resolve from the tenant at seed time so the block survives a
  -- rebuild; only the seeded rows carry fixed ids (…2901-2919 claimed; grep
  -- the file — no other block holds …29xx).
  declare
    v_customer uuid;
    v_rule uuid;
    v_deferred uuid;
    v_recognized uuid;
    v_book uuid;
    v_per1 uuid;
    v_per2 uuid;
    v_per3 uuid;
    v_sub uuid;
    v_user uuid;
    v_je uuid := '00000000-0000-7000-9000-000000002911';
  begin
    select id into v_customer from parties
     where org_id = v_org and is_active order by display_name limit 1;
    -- Rule-level default accounts: any active non-summary balance-sheet and
    -- income accounts; obligation overrides stay null.
    select id into v_deferred from accounts
     where org_id = v_org and is_active and not is_summary
       and type in ('liability_current_other', 'liability_long_term')
     order by number nulls last limit 1;
    select id into v_recognized from accounts
     where org_id = v_org and is_active and not is_summary
       and type in ('income', 'income_other')
     order by number nulls last limit 1;
    select id into v_book from accounting_books
     where org_id = v_org and is_primary limit 1;
    select id into v_per1 from accounting_periods
     where org_id = v_org and name = '2026-01' limit 1;
    select id into v_per2 from accounting_periods
     where org_id = v_org and name = '2026-02' limit 1;
    select id into v_per3 from accounting_periods
     where org_id = v_org and name = '2026-03' limit 1;
    select id into v_sub from subsidiaries
     where org_id = v_org order by name limit 1;
    select id into v_user from users
     where org_id = v_org and email = 'viewspec@sim.test';
    -- NOT `return`: a bare return in a nested block exits the WHOLE anonymous
    -- block, silently skipping every fixture appended below this one.
    if v_customer is null or v_deferred is null or v_recognized is null
       or v_book is null or v_per1 is null or v_per2 is null or v_per3 is null
       or v_sub is null or v_user is null then
      raise notice 'missing revenue fixture prerequisites; skipping';
    else

    insert into recognition_rules
      (id, org_id, code, name, method, recognition_periods,
       deferred_account_id, recognized_account_id, is_active)
    values ('00000000-0000-7000-9000-000000002900', v_org, 'VS-SL-3MO',
            'ViewSpec straight-line 3mo', 'straight_line_even', 3,
            v_deferred, v_recognized, true)
    on conflict (id) do nothing;
    select id into v_rule from recognition_rules
     where org_id = v_org and code = 'VS-SL-3MO';

    insert into revenue_contracts
      (id, org_id, customer_id, contract_number, status,
       starts_on, ends_on, total_transaction_price, currency, pricing)
    values
      ('00000000-0000-7000-9000-000000002901', v_org, v_customer, 'REV-VS-1', 'active',
       '2026-01-01', '2026-03-31', 9000.0000, 'USD', '{}'::jsonb),
      ('00000000-0000-7000-9000-000000002902', v_org, v_customer, 'REV-VS-2', 'cancelled',
       '2026-01-01', '2026-01-31', 1000.0000, 'USD', '{}'::jsonb)
    on conflict (id) do nothing;

    insert into performance_obligations
      (id, org_id, contract_id, description, recognition_rule_id,
       allocated_price, recognition_starts_on, recognition_ends_on, status)
    values
      ('00000000-0000-7000-9000-000000002903', v_org,
       '00000000-0000-7000-9000-000000002901',
       'ViewSpec implementation', v_rule,
       6000.0000, '2026-01-01', '2026-03-31', 'open'),
      ('00000000-0000-7000-9000-000000002904', v_org,
       '00000000-0000-7000-9000-000000002901',
       'ViewSpec support', v_rule,
       3000.0000, '2026-01-01', '2026-03-31', 'open')
    on conflict (id) do nothing;

    insert into recognition_schedules
      (id, org_id, obligation_id, book_id, status, total_amount)
    values
      ('00000000-0000-7000-9000-000000002905', v_org,
       '00000000-0000-7000-9000-000000002903', v_book, 'in_progress', 6000.0000),
      ('00000000-0000-7000-9000-000000002906', v_org,
       '00000000-0000-7000-9000-000000002904', v_book, 'planned', 3000.0000)
    on conflict (id) do nothing;

    -- The drawer's recognized-vs-planned split needs one POSTED line: a
    -- posted entry is immutable (jl_guard), so the balance legs go in as
    -- draft first and the entry is posted afterwards — the banking block's
    -- pattern (guarded by existence, not ON CONFLICT: the guard fires even
    -- when every row would be a no-op, so a second run would fail).
    --
    -- MARCH, not January: 2026-01 and 2026-02 are closed for GL posting in
    -- this tenant, and the close guard rejects the draft→posted update. The
    -- recognized month is the LAST one rather than the first, which changes
    -- nothing the drawer asserts — one recognized line and two planned ones.
    if not exists (select 1 from journal_entries where id = v_je) then
      insert into journal_entries
        (id, org_id, book_id, entry_number, posting_date, period_id, status, subsidiary_id)
      values (v_je, v_org, v_book, 'REV-VS-1', '2026-03-31', v_per3, 'draft', v_sub);
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, amount, currency, txn_amount, subsidiary_id)
      values ('00000000-0000-7000-9000-000000002912', v_org, v_je, 1,
              v_recognized, 2000.0000, 'USD', 2000.0000, v_sub),
             ('00000000-0000-7000-9000-000000002913', v_org, v_je, 2,
              v_deferred, -2000.0000, 'USD', -2000.0000, v_sub);
      update journal_entries set status = 'posted', posted_at = now(), posted_by = v_user
       where id = v_je and status <> 'posted';
    end if;

    insert into recognition_schedule_lines
      (id, org_id, schedule_id, period_id, sequence,
       planned_amount, recognized_amount, journal_entry_id)
    values
      -- Obligation 1: Jan + Feb still planned, Mar posted (recognized).
      ('00000000-0000-7000-9000-000000002907', v_org,
       '00000000-0000-7000-9000-000000002905', v_per1, 1,
       2000.0000, null, null),
      ('00000000-0000-7000-9000-000000002908', v_org,
       '00000000-0000-7000-9000-000000002905', v_per2, 2,
       2000.0000, null, null),
      ('00000000-0000-7000-9000-000000002909', v_org,
       '00000000-0000-7000-9000-000000002905', v_per3, 3,
       2000.0000, 2000.0000, v_je),
      -- Obligation 2: nothing posted — the drawer's all-planned branch.
      ('00000000-0000-7000-9000-00000000290a', v_org,
       '00000000-0000-7000-9000-000000002906', v_per1, 1,
       1000.0000, null, null),
      ('00000000-0000-7000-9000-00000000290b', v_org,
       '00000000-0000-7000-9000-000000002906', v_per2, 2,
       1000.0000, null, null),
      ('00000000-0000-7000-9000-00000000290c', v_org,
       '00000000-0000-7000-9000-000000002906', v_per3, 3,
       1000.0000, null, null)
    on conflict (id) do nothing;
  
    end if;
  end;

  -- ---- crm leads ----------------------------------------------------------
  --
  -- The simulator never writes account profiles, so the leads list would come
  -- up empty. Two active lead profiles on active company parties with a lead
  -- lifecycle status: leadWhere requires cp.lifecycle_stage = 'lead' and
  -- cp.is_active and p.is_active, and subsidiary_id stays null so
  -- crmSharedScope passes for any grant set. The Default `lead` list view has
  -- no filters, so both fixtures render.
  declare
    v_lead_owner uuid;
    v_lead_new uuid;
    v_lead_working uuid;
  begin
    select id into v_lead_owner from users where org_id = v_org order by created_at limit 1;
    select id into v_lead_new from crm_account_statuses
     where org_id = v_org and lifecycle_stage = 'lead' and is_active order by sequence limit 1;
    select id into v_lead_working from crm_account_statuses
     where org_id = v_org and lifecycle_stage = 'lead' and is_active order by sequence desc limit 1;
    -- NOT `return`: a bare return in a nested block exits the WHOLE anonymous
    -- block, silently skipping every fixture appended below this one.
    if v_lead_owner is null or v_lead_new is null then
      raise notice 'no users or lead statuses; skipping lead fixtures';
    else

    insert into parties (id, org_id, kind, display_name, email, phone, is_active, created_by, updated_by)
    values
      ('00000000-0000-7000-a000-000000000003', v_org, 'company',
       'ViewSpec Lead Conformance A', 'leads-a@viewspec.test', '555-0101', true, v_lead_owner, v_lead_owner),
      ('00000000-0000-7000-a000-000000000004', v_org, 'company',
       'ViewSpec Lead Conformance B', 'leads-b@viewspec.test', '555-0102', true, v_lead_owner, v_lead_owner)
    on conflict (id) do nothing;

    insert into crm_account_profiles
      (id, org_id, party_id, lifecycle_stage, status_id, owner_user_id,
       qualification_score, last_activity_at, is_active, created_by, updated_by)
    values
      ('00000000-0000-7000-a000-000000000003', v_org,
       '00000000-0000-7000-a000-000000000003', 'lead', v_lead_new, v_lead_owner,
       42, current_timestamp - interval '1 day', true, v_lead_owner, v_lead_owner),
      ('00000000-0000-7000-a000-000000000004', v_org,
       '00000000-0000-7000-a000-000000000004', 'lead', v_lead_working, v_lead_owner,
       70, current_timestamp - interval '2 days', true, v_lead_owner, v_lead_owner)
    on conflict (id) do nothing;
  
    end if;
  end;

-- ---- crm prospects -------------------------------------------------------
-- The simulator never creates CRM account profiles, so /crm/prospects would
-- compare two identical empty states. Two prospect accounts on the sim org's
-- real prospect statuses (Open, Nurturing) with different owners.
-- Block …1301–1304 claimed by the prospects conversion; verified free.
  declare
  v_status_open uuid;
  v_status_nurturing uuid;
  v_owner_a uuid;
  v_owner_b uuid;
  v_party_a uuid := '00000000-0000-7000-9000-000000001301';
  v_party_b uuid := '00000000-0000-7000-9000-000000001302';
begin
  select id into v_status_open from crm_account_statuses
   where org_id = v_org and lifecycle_stage = 'prospect' and name = 'Open' and is_active
   order by sequence limit 1;
  select id into v_status_nurturing from crm_account_statuses
   where org_id = v_org and lifecycle_stage = 'prospect' and name = 'Nurturing' and is_active
   order by sequence limit 1;
  select id into v_owner_a from users where org_id = v_org and is_active order by name limit 1;
  select id into v_owner_b from users where org_id = v_org and is_active order by name limit 1 offset 1;
  -- NOT `return`: a bare return in a nested block exits the WHOLE anonymous
  -- block, silently skipping every fixture appended below this one.
  if v_status_open is null or v_owner_a is null then
    raise notice 'missing prospect status or owner; skipping prospects fixtures';
  else

  insert into parties (id, org_id, kind, display_name, email, phone, website, is_active)
  values (v_party_a, v_org, 'customer', 'ViewSpec Prospect Alpha', 'alpha@viewspec.test', '555-0101', 'https://alpha.viewspect.test', true),
         (v_party_b, v_org, 'customer', 'ViewSpec Prospect Beta', 'beta@viewspec.test', '555-0102', 'https://beta.viewspect.test', true)
  on conflict (id) do nothing;

  -- subsidiary_id stays null so crmSharedScope (null = org-wide visible)
  -- passes for any grant set, including the harness admin.
  insert into crm_account_profiles
    (id, org_id, party_id, lifecycle_stage, status_id, owner_user_id,
     industry, qualification_score, last_activity_at, is_active)
  values ('00000000-0000-7000-9000-000000001303', v_org, v_party_a, 'prospect',
          v_status_open, v_owner_a, 'Construction', 72, now() - interval '2 days', true),
         ('00000000-0000-7000-9000-000000001304', v_org, v_party_b, 'prospect',
          coalesce(v_status_nurturing, v_status_open), v_owner_b, 'Real estate', 45, now() - interval '9 days', true)
  on conflict (id) do nothing;
  end if;
  end;

  -- ---- platform sync connections + runs (/sync) ---------------------------
  -- Block …9821-9826. (Proposed as …1201-1215, which the bank-feed connection
  -- already holds — the FOURTH independent claim on that block. The
  -- allocation table at the top of this file is the record; check it AND
  -- grep before claiming.)
  --
  -- The simulator never connects an external accounting system, so the SIM
  -- org holds zero `connections` and zero `sync_runs` rows: /sync renders
  -- its "No connections yet" note and no runs table at all. One populated
  -- connection card (netsuite, token auth, mirror on) + one qbd connection
  -- (token auth, exercises the qbd heartbeat/capture/docs branch) + two
  -- finished runs (an `incremental` mirror run carrying
  -- mirror/openItems/periods stats for the result-summary path, and an
  -- `attachments` run for the attachments-summary path) give the harness
  -- the card branches AND ≥2 `table tbody tr` rows to compare. Both runs
  -- are `status = 'ok'` in the past: nothing is `running`, so the client's
  -- 2.5s live-poll loop stays off and the capture settles.
  --
  -- Cross-page impact: nil. `sync_runs` is read only by the platform API
  -- and the (currently unreferenced) `dashboardData` in web/lib/data.ts;
  -- `connections` only by the platform API + sync engine. No other
  -- converted page counts or lists either table.
  --
  -- Guarded all-or-nothing like the backup block: the UNIQUE key is
  -- (org_id, display_name), not the id — ON CONFLICT (id) alone would
  -- raise on a re-run that collides on name, so the guard owns
  -- idempotence. `posted_change_policy` stays 'review_required' (the
  -- CHECK requires authorized_by/at to be NULL in that case — the
  -- fixtures set neither). Secrets are a sealed-blob-shaped placeholder:
  -- never unsealed by the list path (`toClient` returns only
  -- `hasSecrets`), and the fixture sets no real credential.
  declare
    v_conn_ns uuid := '00000000-0000-7000-9000-000000009821';
  begin
    if not exists (select 1 from connections where org_id = v_org and display_name = 'ViewSpec NetSuite') then
      insert into connections
        (id, org_id, source, display_name, auth_kind, status, config,
         secrets, mirror_enabled, mirror_schedule, cursor, last_run_at,
         last_error, posted_change_policy)
      values
        -- Token-auth connection with mirror on: exercises the source +
        -- status + mirror badges, the lastRun/cursor line, the mirror-health
        -- line, and the netsuite-only project-financials/attachments
        -- actions + attachment-health line.
        (v_conn_ns, v_org, 'netsuite', 'ViewSpec NetSuite', 'token',
         'active', '{"account": "1234567", "baseCurrency": "USD"}',
         'sealed:viewspec-fixture', true, 'daily',
         timestamptz '2026-08-28 06:00:00+00',
         timestamptz '2026-08-28 06:04:11+00',
         null, 'review_required'),
        -- Second connection on the qbd branch: heartbeat + capture status
        -- + docs link (qbdStatus comes from qbd_sessions/qbd_captures,
        -- seeded below). No secrets: shows the unconfigured-status path.
        ('00000000-0000-7000-9000-000000009822', v_org, 'qbd',
         'ViewSpec QuickBooks Desktop', 'token', 'unconfigured',
         '{"historyStartDate": "2020-01-01", "region": "US", "baseCurrency": "USD"}',
         null, false, 'daily', null, null, null, 'review_required')
      on conflict (id) do nothing;

      insert into sync_runs
        (id, org_id, connection_id, source, kind, status, started_at,
         finished_at, synced_through, stats, progress, error_message,
         triggered_by)
      values
        ('00000000-0000-7000-9000-000000009823', v_org, v_conn_ns,
         'netsuite', 'incremental', 'ok',
         timestamptz '2026-08-28 06:00:00+00',
         timestamptz '2026-08-28 06:04:11+00',
         timestamptz '2026-08-28 06:00:00+00',
         '{"docsNew": 12, "docsAmended": 3, "docsUnchanged": 140,
           "tb": {"matches": 42, "accounts": 42},
           "openItems": {"checked": 18, "matches": 18},
           "periods": {"checked": 4, "matches": 4}}',
         '{}', null, 'schedule'),
        ('00000000-0000-7000-9000-000000009824', v_org, v_conn_ns,
         'netsuite', 'attachments', 'ok',
         timestamptz '2026-08-28 07:00:00+00',
         timestamptz '2026-08-28 07:02:33+00',
         timestamptz '2026-08-28 06:00:00+00',
         '{"sourceFiles": 9, "sourceLinks": 9, "createdFiles": 9}',
         '{}', null, 'manual')
      on conflict (id) do nothing;

      -- qbd heartbeat + latest capture for the second connection (the API
      -- takes max(last_seen_at) and the latest capture row).
      insert into qbd_sessions
        (id, org_id, connection_id, status, last_seen_at, expires_at)
      values
        ('00000000-0000-7000-9000-000000009825', v_org,
         '00000000-0000-7000-9000-000000009822', 'active',
         timestamptz '2026-08-29 12:00:00+00',
         timestamptz '2026-09-05 12:00:00+00')
      on conflict (id) do nothing;

      insert into qbd_captures
        (id, org_id, connection_id, status, captured_through, progress,
         expires_at, finished_at, created_at)
      values
        ('00000000-0000-7000-9000-000000009826', v_org,
         '00000000-0000-7000-9000-000000009822', 'complete',
         timestamptz '2026-08-29 11:00:00+00',
         '{"completed": 41, "total": 41}',
         timestamptz '2026-09-05 11:00:00+00',
         timestamptz '2026-08-29 11:04:02+00',
         timestamptz '2026-08-29 11:00:00+00')
      on conflict (id) do nothing;
    end if;
  end;

  -- ---- payroll remittances -------------------------------------------------
  --
  -- The simulator never accrues remittable withholdings: the only committed
  -- sim run (…1813, PAY-00003, pay_date 2026-03-11) carries no stubs, and the
  -- fixture stubs (…1911/1912) sit on a CALCULATED run the summary query
  -- explicitly excludes. Without these, /payroll/remittances compares two
  -- identical empty states. Block …1840-1845: two user-style deduction
  -- components (null system_key, so no pack declaration can reroute them),
  -- one stub on …1813 with two committed-source lines, and one draft
  -- remittance-bill marker for the same vendor + March window, so the
  -- existing-bill badge and the create-another label render.
  -- Vendor resolves LIVE (first active vendor_roles party); the liability
  -- account is the sim org's 2260 Payroll Taxes Payable, resolved live by
  -- number. The stub's filing source is 'reconciled' with an evidence
  -- object (NOT 'unknown': assertPayrollFilingAccountKnown throws on
  -- committed unknown-source stubs) and a NULL filing id, so the group
  -- lands in the unassigned filing bucket — the single-account path.
  declare
    v_vendor uuid;
    v_acct uuid;
    v_emp uuid;
  begin
    select pa.id into v_vendor from parties pa
      join vendor_roles vr on vr.party_id = pa.id and vr.org_id = pa.org_id
     where pa.org_id = v_org and vr.is_active
     order by pa.display_name limit 1;
    select id into v_acct from accounts
     where org_id = v_org and number = '2260' limit 1;
    select id into v_emp from parties
     where org_id = v_org and display_name = 'Harborview Development LLC';
    -- NOT `return`: a bare return in a nested block exits the WHOLE anonymous
    -- block, silently skipping every fixture appended below this one.
    if v_vendor is null or v_acct is null or v_emp is null then
      raise notice 'missing vendor/account/party; skipping remittance fixtures';
    else

    insert into pay_components
      (id, org_id, code, name, kind, system_key, country, basis, taxable,
       pensionable, insurable, vacationable, non_periodic, sequence,
       is_active, liability_account_id, remittance_party_id)
    values
      ('00000000-0000-7000-9000-000000001840', v_org, 'VS-TAX',
       'ViewSpec income tax', 'deduction', null, 'CA', 'fixed_amount',
       true, true, true, true, false, 100, true, v_acct, v_vendor),
      ('00000000-0000-7000-9000-000000001841', v_org, 'VS-CPP',
       'ViewSpec CPP', 'deduction', null, 'CA', 'fixed_amount',
       true, true, true, true, false, 101, true, v_acct, v_vendor)
    on conflict (id) do nothing;

    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, currency_code, gross,
       pensionable_earnings, insurable_earnings, net_pay, employer_cost,
       vacation_accrued, country_source, filing_account_source,
       filing_account_evidence)
    values
      ('00000000-0000-7000-9000-000000001842', v_org,
       '00000000-0000-7000-9000-000000001813', v_emp, 'ON',
       26, date '2026-03-11', 2026, 'USD', 5000.00, 5000.00, 5000.00,
       -- 'unknown', not 'reconciled': `pay_stub_filing_account_guard` REJECTS
       -- any INSERT whose source is not calculation/insertion, and resolves
       -- an 'unknown' one itself from the employee profile or the country
       -- default — which is exactly what the application writer does.
       4000.00, 5200.00, 200.00, 'unknown', 'unknown', null)
    on conflict (id) do nothing;

    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, amount,
       sequence, liability_account_id, liability_account_source)
    values
      ('00000000-0000-7000-9000-000000001843', v_org,
       '00000000-0000-7000-9000-000000001842',
       '00000000-0000-7000-9000-000000001840', 'deduction',
       'ViewSpec income tax', -800.00, 1, v_acct, 'commit'),
      ('00000000-0000-7000-9000-000000001844', v_org,
       '00000000-0000-7000-9000-000000001842',
       '00000000-0000-7000-9000-000000001841', 'deduction',
       'ViewSpec CPP', -250.00, 2, v_acct, 'commit')
    on conflict (id) do nothing;

    -- Draft marker bill: a posted bill must name its accounting period, and
    -- a fixture has no business inventing one. The engine's overlap query
    -- only requires kind='vendor_bill', status<>'voided' and the custom
    -- window — draft is enough for the existing-bill branch.
    insert into documents
      (id, org_id, kind, document_number, party_id, document_date,
       currency, status, subtotal, tax_total, total, memo, custom,
       created_at, updated_at)
    select '00000000-0000-7000-9000-000000001845', v_org, 'vendor_bill',
           'BILL-VSPEC-REM-1', v_vendor, date '2026-03-12', 'USD', 'draft',
           1050.00, 0.00, 1050.00, 'ViewSpec remittance bill',
           jsonb_build_object('payrollRemittance', jsonb_build_object(
             'from', '2026-03-01', 'to', '2026-03-31',
             'filingAccountId', null)),
           now(), now()
     where not exists (select 1 from documents
                        where org_id = v_org and kind = 'vendor_bill'
                          and document_number = 'BILL-VSPEC-REM-1');
  
    end if;
  end;

  -- ---- year-end T4 population ------------------------------------------------
  --
  -- The simulator never commits payroll, so /payroll/year-end renders its
  -- empty state without these: one committed CA stub on the existing
  -- committed run …1813 (PAY-00003, committed/regular, period
  -- 2026-02-21–2026-03-06, pay date 2026-03-11) with the minimum rows the
  -- T4 chain joins against. The stub reuses a live sim party (the FK to
  -- parties holds), the ON-profile the …1901 block already seeds for that
  -- party, and the BASE component (…1901) for the earning line. One stub
  -- line carries the BASE link and one is component-free, so both
  -- taxable-income join branches render. Guard before insert: the run and
  -- party must exist, and the fixed ids must be absent — re-runs are
  -- no-ops.
  --
  -- Block …1850-1852, and a DIFFERENT employee from the remittance stub
  -- above: `pay_stubs_run_employee` is UNIQUE on (run, employee) and both
  -- fixtures land on run …1813, so sharing a party is a hard conflict that
  -- ON CONFLICT (id) cannot absorb. Two agents claimed …1840 independently;
  -- this block moved.
  declare
    v_emp uuid;
    v_ok boolean;
  begin
    select id into v_emp from parties
     where org_id = v_org and is_active
       and display_name <> 'Harborview Development LLC'
     order by display_name limit 1;
    v_ok := v_emp is not null and exists (
      select 1 from pay_runs
       where org_id = v_org
         and document_id = '00000000-0000-7000-9000-000000001813'
         and run_status = 'committed');
    -- NOT `return`: a bare return in a nested block exits the WHOLE anonymous
    -- block, silently skipping every fixture appended below this one.
    if not v_ok then
      raise notice 'missing fixture party or committed run; skipping year-end fixtures';
    else

    -- One committed CA stub on run …1813. country/filing columns cite the
    -- legacy-region branch of the evidence CHECKs (country = 'CA',
    -- country_source = 'legacy_region', filing_account_source =
    -- 'insertion'): the live sim stubs use exactly this vocabulary, and it
    -- passes both evidence assertions (no null country, no 'unknown'
    -- filing source) so t4Slips builds instead of refusing. Province ON
    -- (non-Quebec: no QPIP arm), filing_account_id null (the unassigned
    -- bucket — t4Returns groups it without a filing-accounts row).
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, federal_claim, provincial_claim,
       currency_code, gross, pensionable_earnings, insurable_earnings,
       net_pay, employer_cost, vacation_accrued, factors,
       country_source, filing_account_source)
    values
      ('00000000-0000-7000-9000-000000001850', v_org,
       '00000000-0000-7000-9000-000000001813', v_emp, 'ON',
       26, date '2026-03-11', 2026, 0, 0,
       'USD', 3400.00, 3400.00, 3400.00,
       2510.75, 3620.40, 136.00, '{"T": "441.20", "C": "186.85", "EI": "61.20"}',
       -- Same guard: arrive as 'unknown' and let the trigger stamp the
       -- account. `country` is derived from the province, as the …1911 stub
       -- above demonstrates (it sets neither and lands on 'CA').
       'unknown', 'unknown')
    on conflict (id) do nothing;

    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, hours, rate,
       amount, sequence)
    values
      ('00000000-0000-7000-9000-000000001851', v_org,
       '00000000-0000-7000-9000-000000001850',
       '00000000-0000-7000-9000-000000001901', 'earning',
       'Regular hours', 80, 42.50, 3400.00, 1),
      ('00000000-0000-7000-9000-000000001852', v_org,
       '00000000-0000-7000-9000-000000001850', null, 'deduction',
       'Income tax', null, null, -441.20, 2)
    on conflict (id) do nothing;
  
    end if;
  end;

  -- ---- WIP & prebilling (/projects/wip-billing) ------------------------------
  -- The simulator never creates worksheets, so the page would compare two
  -- identical empty states. Two worksheets on one live SIM project (resolved
  -- by name — the simulator regenerates ids on every reseed): a draft with
  -- two bill lines + one held line and an audit trail, and a review worksheet
  -- with one line, so the list table has rows and the detail drawer has
  -- metrics, lines and events. Block …2101-2199 (claimed fresh 2026-09-10;
  -- neighbors are …2001-2022 AP capture and …2801-2803 field tickets).
  -- Actor is the harness user viewspec@sim.test, resolved live by email.
  insert into wip_prebills
    (id, org_id, project_id, worksheet_number, period_start, period_end,
     status, notes, original_bill_amount, proposed_bill_amount, cost_amount,
     adjustment_amount, created_by, updated_by)
  select '00000000-0000-7000-9000-000000002101', v_org, p.id,
         'WIP-VSPEC1', date '2026-01-01', date '2026-01-31',
         'draft', 'ViewSpec conformance worksheet', 1250.0000, 1150.0000,
         800.0000, -100.0000, u.id, u.id
    from (select id from projects
           where org_id = v_org and name = 'Riverside Mall Facilities T&M'
           order by id limit 1) p,
         (select id from users where email = 'viewspec@sim.test'
           order by id limit 1) u
   where not exists (select 1 from wip_prebills
                      where id = '00000000-0000-7000-9000-000000002101');

  insert into wip_prebills
    (id, org_id, project_id, worksheet_number, period_start, period_end,
     status, notes, original_bill_amount, proposed_bill_amount, cost_amount,
     adjustment_amount, submitted_at, created_by, updated_by)
  select '00000000-0000-7000-9000-000000002102', v_org, p.id,
         'WIP-VSPEC2', date '2026-02-01', date '2026-02-28',
         'review', 'ViewSpec conformance worksheet (review)', 600.0000,
         600.0000, 400.0000, 0.0000, now() - interval '2 days', u.id, u.id
    from (select id from projects
           where org_id = v_org and name = 'Riverside Mall Facilities T&M'
           order by id limit 1) p,
         (select id from users where email = 'viewspec@sim.test'
           order by id limit 1) u
   where not exists (select 1 from wip_prebills
                      where id = '00000000-0000-7000-9000-000000002102');

  -- Lines carry no source FKs (time_entry_id / document_line_id left null —
  -- the FKs only constrain non-null values), so they render without touching
  -- ledger tables either path could disagree on.
  insert into wip_prebill_lines
    (id, org_id, prebill_id, project_id, line_number, source_type,
     source_date, description, quantity, unit, cost_amount,
     original_bill_amount, proposed_bill_amount, adjustment_amount,
     adjustment_reason, adjustment_evidence, disposition, pricing_snapshot,
     -- `wip_prebill_lines_source_shape_chk` demands a real source: a
     -- 'time_entry' line must name a time_entry_id and a 'document_line' one
     -- a document_line_id, with the other null. Resolved live below.
     time_entry_id, document_line_id)
  select '00000000-0000-7000-9000-000000002111', v_org,
         '00000000-0000-7000-9000-000000002101', p.id, 1, 'time_entry',
         date '2026-01-15', 'ViewSpec conformance line 1', 8.0000, 'hours',
         500.0000, 750.0000, 750.0000, 0.0000, null, '[]'::jsonb, 'bill',
         '{}'::jsonb, te.id, null
    from (select id from projects
           where org_id = v_org and name = 'Riverside Mall Facilities T&M'
           order by id limit 1) p,
         (select id from time_entries where org_id = v_org
           order by id limit 1) te
   where exists (select 1 from wip_prebills
                  where id = '00000000-0000-7000-9000-000000002101')
     and not exists (select 1 from wip_prebill_lines
                      where id = '00000000-0000-7000-9000-000000002111');

  insert into wip_prebill_lines
    (id, org_id, prebill_id, project_id, line_number, source_type,
     source_date, description, quantity, unit, cost_amount,
     original_bill_amount, proposed_bill_amount, adjustment_amount,
     adjustment_reason, adjustment_evidence, disposition, pricing_snapshot,
     -- `wip_prebill_lines_source_shape_chk` demands a real source: a
     -- 'time_entry' line must name a time_entry_id and a 'document_line' one
     -- a document_line_id, with the other null. Resolved live below.
     time_entry_id, document_line_id)
  select '00000000-0000-7000-9000-000000002112', v_org,
         '00000000-0000-7000-9000-000000002101', p.id, 2, 'document_line',
         date '2026-01-20', 'ViewSpec conformance line 2', 1.0000, 'each',
         300.0000, 500.0000, 400.0000, -100.0000, 'ViewSpec write-down',
         '["VSPEC-EV-1"]'::jsonb, 'bill', '{}'::jsonb, null, dl.id
    from (select id from projects
           where org_id = v_org and name = 'Riverside Mall Facilities T&M'
           order by id limit 1) p,
         (select id from document_lines where org_id = v_org
           order by id limit 1) dl
   where exists (select 1 from wip_prebills
                  where id = '00000000-0000-7000-9000-000000002101')
     and not exists (select 1 from wip_prebill_lines
                      where id = '00000000-0000-7000-9000-000000002112');

  insert into wip_prebill_lines
    (id, org_id, prebill_id, project_id, line_number, source_type,
     source_date, description, quantity, unit, cost_amount,
     original_bill_amount, proposed_bill_amount, adjustment_amount,
     adjustment_reason, adjustment_evidence, disposition, pricing_snapshot,
     -- `wip_prebill_lines_source_shape_chk` demands a real source: a
     -- 'time_entry' line must name a time_entry_id and a 'document_line' one
     -- a document_line_id, with the other null. Resolved live below.
     time_entry_id, document_line_id)
  select '00000000-0000-7000-9000-000000002113', v_org,
         '00000000-0000-7000-9000-000000002101', p.id, 3, 'document_line',
         date '2026-01-25', 'ViewSpec conformance held line', 1.0000, 'each',
         200.0000, 200.0000, 200.0000, 0.0000, null, '[]'::jsonb, 'hold',
         '{}'::jsonb, null, dl.id
    from (select id from projects
           where org_id = v_org and name = 'Riverside Mall Facilities T&M'
           order by id limit 1) p,
         (select id from document_lines where org_id = v_org
           order by id limit 1 offset 1) dl
   where exists (select 1 from wip_prebills
                  where id = '00000000-0000-7000-9000-000000002101')
     and not exists (select 1 from wip_prebill_lines
                      where id = '00000000-0000-7000-9000-000000002113');

  insert into wip_prebill_lines
    (id, org_id, prebill_id, project_id, line_number, source_type,
     source_date, description, quantity, unit, cost_amount,
     original_bill_amount, proposed_bill_amount, adjustment_amount,
     adjustment_reason, adjustment_evidence, disposition, pricing_snapshot,
     -- `wip_prebill_lines_source_shape_chk` demands a real source: a
     -- 'time_entry' line must name a time_entry_id and a 'document_line' one
     -- a document_line_id, with the other null. Resolved live below.
     time_entry_id, document_line_id)
  select '00000000-0000-7000-9000-000000002114', v_org,
         '00000000-0000-7000-9000-000000002102', p.id, 1, 'time_entry',
         date '2026-02-10', 'ViewSpec conformance review line', 4.0000,
         'hours', 400.0000, 600.0000, 600.0000, 0.0000, null, '[]'::jsonb,
         'bill', '{}'::jsonb, te.id, null
    from (select id from projects
           where org_id = v_org and name = 'Riverside Mall Facilities T&M'
           order by id limit 1) p,
         (select id from time_entries where org_id = v_org
           order by id limit 1 offset 1) te
   where exists (select 1 from wip_prebills
                  where id = '00000000-0000-7000-9000-000000002102')
     and not exists (select 1 from wip_prebill_lines
                      where id = '00000000-0000-7000-9000-000000002114');

  insert into wip_prebill_events (id, org_id, prebill_id, event_type, actor_id, details)
  select '00000000-0000-7000-9000-000000002121', v_org,
         '00000000-0000-7000-9000-000000002101', 'created', u.id,
         '{"sourceCount": 3}'::jsonb
    from (select id from users where email = 'viewspec@sim.test'
           order by id limit 1) u
   where exists (select 1 from wip_prebills
                  where id = '00000000-0000-7000-9000-000000002101')
     and not exists (select 1 from wip_prebill_events
                      where id = '00000000-0000-7000-9000-000000002121');

  insert into wip_prebill_events (id, org_id, prebill_id, event_type, actor_id, details)
  select '00000000-0000-7000-9000-000000002122', v_org,
         '00000000-0000-7000-9000-000000002101', 'line_updated', u.id,
         '{"reason": "ViewSpec write-down"}'::jsonb
    from (select id from users where email = 'viewspec@sim.test'
           order by id limit 1) u
   where exists (select 1 from wip_prebills
                  where id = '00000000-0000-7000-9000-000000002101')
     and not exists (select 1 from wip_prebill_events
                      where id = '00000000-0000-7000-9000-000000002122');

  -- ---- pdf templates (/admin/pdf-templates) --------------------------------
  -- The simulator never authors PDF templates, so the page would compare
  -- two identical starter-only tables. Three org templates: a default for
  -- customer_invoice (that starter loses its effective-default badge),
  -- an inactive one for vendor_bill (inactive-badge branch), and a plain
  -- one for quote. Claims fresh block …3101-3199 (verified unused).
  insert into pdf_templates
    (id, org_id, record_type, name, description, paper_size, orientation,
     margin_mm, header_html, footer_html, source_html, compiled_html,
     is_default, is_active, created_at, updated_at)
  select v.id, v_org, v.record_type, v.name, v.description, v.paper_size,
         v.orientation, 14, null, null,
         '<p>ViewSpec ' || v.record_type || '</p>', '<p>ViewSpec</p>',
         v.is_default, v.is_active,
         timestamptz '2026-08-20 12:00:00+00', timestamptz '2026-08-20 12:00:00+00'
    from (values
      ('00000000-0000-7000-9000-000000003101'::uuid, 'customer_invoice',
       'ViewSpec Default Invoice', 'Seeded default invoice design',
       'letter', 'portrait', true, true),
      ('00000000-0000-7000-9000-000000003102'::uuid, 'vendor_bill',
       'ViewSpec Old Bill', null,
       'a4', 'landscape', false, false),
      ('00000000-0000-7000-9000-000000003103'::uuid, 'quote',
       'ViewSpec Quote', 'Seeded quote design',
       'letter', 'portrait', false, true)
    ) as v(id, record_type, name, description, paper_size, orientation,
           is_default, is_active)
   where not exists (select 1 from pdf_templates
                      where org_id = v_org
                        and name in ('ViewSpec Default Invoice',
                                     'ViewSpec Old Bill',
                                     'ViewSpec Quote'))
  on conflict (id) do nothing;

  -- ---- payroll separations --------------------------------------------------
  --
  -- The simulator never terminates anyone and never pays a termination run,
  -- so roeCandidates(org, 2026) is empty and /payroll/separations renders
  -- the bare no-filings empty state without these — the comparison the
  -- harness refuses. One terminated CA employee (Chloe Martin, Apprentice —
  -- a sim party with an employee_roles row that no other fixture owns) with
  -- a CA profile on the biweekly fixture schedule plus one committed stub
  -- on the existing fixture run …1813 (PAY-00003, committed/regular) gives
  -- the CA ROE exactly one population row. Block …1860-1869. (Claimed as …1840-1849, which the remittance
  -- block already holds — a sixth independent collision on an unapplied
  -- claim, which is the one case the allocation table cannot arbitrate.)
  --
  -- All three candidate predicates must hold at once: (1) termination in
  -- the year OR a termination run, (2) a stub with tax_year 2026 on a
  -- COMMITTED run (calculated stubs are invisible to the join), (3) a CA
  -- payroll profile (roeCandidates inner-joins employee_payroll_profiles).
  -- Blast radius (checked before claiming): the date + profile + stub move
  -- four other readers, none of which pin the moved values. (1)
  -- /payroll/runs `finalPayCandidates` gains Chloe (profile + terminated)
  -- but that list renders ONLY inside the unopened New Run dialog — the
  -- entry pins `table tbody tr` on the runs list. (2) Parties drawer / run
  -- wizard read one employee's own dates, never Chloe's. (3) Projects
  -- equipment operators exclude terminated staff but the /projects pin is
  -- `table tbody tr` minMatches 3 over a 29-party register, and the
  -- operator list lives in an unopened drawer. (4) Financial-health
  -- headcount includes Chloe only through her final day (the pin is `main
  -- button` tab strip, minMatches 9). (5) Utilization reads
  -- time-tracking, never employment dates.
  declare
    v_chloe uuid;
    v_actor uuid;
  begin
    select id into v_chloe from parties
     where org_id = v_org and display_name = 'Chloe Martin (Apprentice)';
    select id into v_actor from users where org_id = v_org order by created_at limit 1;
    -- NOT `return`: a bare return in a nested block exits the WHOLE anonymous
    -- block, silently skipping every fixture appended below this one.
    if v_chloe is null or v_actor is null then
      raise notice 'missing Chloe/actor; skipping separations fixtures';
    else

    -- The interruption of earnings. Chloe's employee_roles row exists with
    -- terminated_on null — stamp it; the guard is the null itself, so a
    -- re-run is a no-op and the UPDATE never fights another fixture.
    update employee_roles set terminated_on = date '2026-03-31'
     where org_id = v_org and party_id = v_chloe and terminated_on is null;

    -- Chloe's CA payroll profile on the biweekly fixture schedule (…1801,
    -- frequency `biweekly` — a frequency roeRecord accepts, though only
    -- the population matters for the pin). Fixed id …1841; the guard is
    -- (org_id, employee_party_id) so a re-run is a no-op even though
    -- profiles carry no unique key on the employee.
    insert into employee_payroll_profiles
      (id, org_id, employee_party_id, pay_schedule_id, province, pay_basis,
       country, stub_delivery, payment_method, is_active)
    select '00000000-0000-7000-9000-000000001861', v_org, v_chloe,
           '00000000-0000-7000-9000-000000001801', 'ON', 'hourly',
           'CA', 'email', 'eft', true
     where not exists (select 1 from employee_payroll_profiles
                        where org_id = v_org and employee_party_id = v_chloe);

    -- The committed stub that makes her a candidate. Run …1813 is the
    -- existing committed fixture run (pay_date 2026-03-11); the stub is a
    -- second employee on that run, so no run header changes. (org_id,
    -- employee_party_id) is not unique but (pay_run_document_id,
    -- employee_party_id) is — the guard names THAT, so re-runs stay
    -- silent. country/'unknown' + filing_account/'unknown' satisfy the
    -- evidence CHECKs with the unknown-source branch (no pack is installed
    -- in the sim tenant, exactly like the wizard-stub block); net_pay >= 0
    -- holds; no cheque_number so that CHECK is vacuous.
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, federal_claim, provincial_claim,
       currency_code, gross, pensionable_earnings, insurable_earnings,
       net_pay, employer_cost, vacation_accrued, factors,
       country_source, filing_account_source)
    select '00000000-0000-7000-9000-000000001860', v_org,
           '00000000-0000-7000-9000-000000001813', v_chloe, 'ON',
           26, date '2026-03-11', 2026, 0, 0,
           'USD', 2800.00, 2800.00, 2800.00,
           2100.00, 2960.00, 112.00, '{"T": "355.00", "C": "150.00", "EI": "48.00"}',
           'unknown', 'unknown'
     where not exists (select 1 from pay_stubs
                        where pay_run_document_id = '00000000-0000-7000-9000-000000001813'
                          and employee_party_id = v_chloe);
  
    end if;
  end;

  -- ---- admin sandboxes (…1501-1599; verified free in fixtures + proposals) ------
  -- The simulator never clones sandboxes, so the page would compare two
  -- identical empty states. Two rows: one ready/masked with no error (pins
  -- the success badge, the masked badge, the tier badge, the
  -- never-refreshed line), one failed/unmasked with a lastError and a
  -- daily schedule (pins the destructive badge, the error line, the
  -- refreshed line, the auto-refresh suffix). The harness session runs in
  -- production, so the manager branch renders on both paths.
  --
  -- Cross-page note: each sandbox needs its own org row (orgs.id FK). The
  -- fixture orgs are env_kind='sandbox' children of the SIM org via
  -- sandbox_of, so the platform-organizations page keeps comparing: its
  -- default sort is name asc and its entry asserts minMatches 2 on the
  -- first page, which the SIM production org + fixtures still satisfy.
  -- The SIM org's own sandboxCount becomes 2 on both renders (same
  -- loader), so that cell agrees too.
  declare
    v_sbx_org_a uuid := '00000000-0000-7000-9000-000000001501';
    v_sbx_org_b uuid := '00000000-0000-7000-9000-000000001502';
  begin
    insert into orgs (id, name, base_currency, country, env_kind, sandbox_of)
    values (v_sbx_org_a, 'ViewSpec Sandbox Alpha', 'USD', 'US', 'sandbox', v_org),
           (v_sbx_org_b, 'ViewSpec Sandbox Beta', 'USD', 'US', 'sandbox', v_org)
    on conflict (id) do nothing;

    insert into sandboxes
      (id, org_id, production_org_id, name, tier, masked, status,
       last_error, last_refresh_at, refresh_schedule, storage_rows, created_at)
    values ('00000000-0000-7000-9000-000000001511', v_sbx_org_a, v_org,
            'ViewSpec QA', 'masked', true, 'ready',
            null, null, null, 123456,
            '2026-02-10T15:00:00Z'),
           ('00000000-0000-7000-9000-000000001512', v_sbx_org_b, v_org,
            'ViewSpec UAT', 'full', false, 'failed',
            'Clone failed: disk full', '2026-02-09T09:30:00Z', 'daily', 789,
            '2026-02-08T12:00:00Z')
    on conflict (id) do nothing;
  end;

  -- ---- book depreciation setup (/admin/setup/depreciation) -----------------
  --
  -- One method + one book/category policy, so the methods tab lists one row
  -- and the books tab lists one row. Fresh 40xx block (no existing fixture
  -- uses it — the …0401-0499 banking ids are …000403-…000413, so …004001+
  -- is unclaimed). GUARD before insert: the natural keys are
  -- (org_id, code) / (org_id, book_id, category_id), not the ids — ON
  -- CONFLICT (id) alone would raise on a re-run with changed keys, so each
  -- guard owns its idempotence. Book/category resolve live from the sim org
  -- (the org-guard trigger only fires on a non-null
  -- depreciation_method_id, left NULL here); the run is skipped if none
  -- exist.
  insert into depreciation_methods (id, org_id, code, name, formula, end_of_life, is_active)
  select '00000000-0000-7000-9000-000000004001', v_org, 'VS_SL',
         'ViewSpec straight line', '(OC-RV)/AL', 'fully_depreciate', true
   where not exists (select 1 from depreciation_methods where org_id = v_org and code = 'VS_SL');

  insert into depreciation_book_policies (id, org_id, book_id, category_id, method, life_months, convention)
  select '00000000-0000-7000-9000-000000004002', v_org, b.id, c.id,
         'straight_line', 60, 'full_month'
    from (select id from accounting_books where org_id = v_org and is_primary limit 1) b,
         (select id from asset_categories where org_id = v_org and name = 'ViewSpec machinery' limit 1) c
   where b.id is not null and c.id is not null
     and not exists (select 1 from depreciation_book_policies p where p.org_id = v_org and p.book_id = b.id and p.category_id = c.id);

  -- ---- opening balances ----------------------------------------------------
  --
  -- The simulator never adopts mid-year, so /payroll/opening-balances
  -- compares two identical empty states without these: no statutory
  -- carry-ins (0 rows), no entitlement plans (the banks section renders
  -- its no-plans branch — no table at all), and no capped components
  -- (no component column). Block …1870–1879. Live parties resolve by
  -- display name; other ids are fixed. Guard-before-insert throughout:
  -- the UNIQUEs here are all bare `ON CONFLICT (id)`-compatible
  -- (payroll_opening_balances_employee_year,
  -- entitlement_ledger_opening, entitlement_plans_org_code,
  -- entitlement_plans_org_system) — EXCEPT the re-run shape of the
  -- ledger guard: see the WARNING below.
  declare
    v_harbor uuid;
    v_ade uuid;
    v_chloe uuid;
    v_ok boolean;
  begin
    select id into v_harbor from parties
     where org_id = v_org and display_name = 'Harborview Development LLC';
    select id into v_ade from parties
     where org_id = v_org and display_name = 'Ade Balogun (Apprentice)';
    select id into v_chloe from parties
     where org_id = v_org and display_name = 'Chloe Martin (Apprentice)';
    -- Two committed 2026 stubs already exist on run …1813 for Harborview
    -- (…1842, remittance fixture) and Ade (…1850, year-end fixture); the
    -- third employee (Chloe) carries the live sim stub …1860 on the same
    -- run. All three lock their 2026 rows, which is the point.
    -- NOT `return`: a bare return in a nested block exits the WHOLE
    -- anonymous block, silently skipping every fixture below this one.
    v_ok := v_harbor is not null and v_ade is not null and v_chloe is not null
      and exists (
        select 1 from pay_runs
         where org_id = v_org
           and document_id = '00000000-0000-7000-9000-000000001813'
           and run_status = 'committed');
    if not v_ok then
      raise notice 'missing fixture parties or committed run; skipping opening-balances fixtures';
    else

    -- Two entitlement plans. MANUAL method needs no accrual_value (the
    -- accrual_value CHECK only fires for non-manual methods). `VAC`
    -- carries system_key 'vacation' — the legacy-banner join key — and
    -- there is exactly one such plan org-wide (org_system UNIQUE).
    insert into entitlement_plans
      (id, org_id, code, name, system_key, unit, direction, accrual_method,
       cap_behavior, is_active)
    values
      ('00000000-0000-7000-9000-000000001873', v_org, 'VAC',
       'Vacation', 'vacation', 'hours', 'accrue', 'manual', 'warn', true),
      ('00000000-0000-7000-9000-000000001874', v_org, 'BANK',
       'Banked time', null, 'hours', 'accrue', 'manual', 'warn', true)
    on conflict (id) do nothing;

    -- One capped component. NULL system_key (no pack declaration can
    -- reroute it), kind + basis satisfy their CHECKs, the annual cap is
    -- non-negative. The sim's own BASE/BONUS/VS-TAX/VS-CPP components
    -- are all uncapped, so this is the only component column.
    insert into pay_components
      (id, org_id, code, name, kind, system_key, country, basis, taxable,
       pensionable, insurable, vacationable, non_periodic, sequence,
       is_active, basis_cap_amount_per_year)
    values
      ('00000000-0000-7000-9000-000000001875', v_org, 'VS-401K',
       'ViewSpec 401(k)', 'deduction', null, 'CA', 'fixed_amount',
       true, false, false, false, false, 102, true, 23000.0000)
    on conflict (id) do nothing;

    -- Two 2026 statutory carry-ins + one 2025 legacy-only row. The
    -- (org, employee, year) UNIQUE owns re-run idempotence alongside
    -- ON CONFLICT (id). Chloe's 2025 row carries ONLY vacation_balance:
    -- every statutory column is 0 (the trimZeros blank branch) and the
    -- unmigrated legacy banner fires (no VAC opening exists for her).
    insert into payroll_opening_balances
      (id, org_id, employee_party_id, tax_year,
       pensionable_ytd, insurable_ytd, cpp_ytd, cpp2_ytd, ei_ytd, qpip_ytd,
       taxable_ytd, tax_ytd, non_periodic_ytd, vacation_balance)
    values
      ('00000000-0000-7000-9000-000000001870', v_org, v_harbor, 2026,
       45000.0000, 42000.0000, 2380.5000, 0.0000, 1045.2500, 0.0000,
       46000.0000, 6200.0000, 5000.0000, 0.0000),
      ('00000000-0000-7000-9000-000000001871', v_org, v_ade, 2026,
       30000.0000, 30000.0000, 1580.0000, 0.0000, 750.0000, 0.0000,
       31000.0000, 4100.0000, 0.0000, 0.0000),
      ('00000000-0000-7000-9000-000000001872', v_org, v_chloe, 2025,
       0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000,
       0.0000, 0.0000, 0.0000, 80.0000)
    on conflict (id) do nothing;

    -- Harborview's component opening: the (opening_balance_id,
    -- component_id) UNIQUE owns re-run safety; the non-negative CHECK
    -- passes (5000 > 0).
    insert into payroll_opening_balance_components
      (id, org_id, opening_balance_id, component_id, ytd_amount)
    values
      ('00000000-0000-7000-9000-000000001876', v_org,
       '00000000-0000-7000-9000-000000001870',
       '00000000-0000-7000-9000-000000001875', 5000.0000)
    on conflict (id) do nothing;

    -- Harborview's vacation bank opening. The (org, plan, employee)
    -- partial-unique (kind = 'opening') owns re-run safety; kind 'opening'
    -- has no sign CHECK; the append-only trigger guards UPDATE/DELETE,
    -- not INSERT, so re-applying the identical row is a silent skip.
    insert into entitlement_ledger
      (id, org_id, plan_id, employee_party_id, movement_date, amount,
       hours, kind, note)
    values
      ('00000000-0000-7000-9000-000000001877', v_org,
       '00000000-0000-7000-9000-000000001873', v_harbor,
       date '2026-01-05', 40.0000, 40.0000, 'opening',
       'ViewSpec fixture: vacation carry-in')
    on conflict (id) do nothing;

    end if;
  end;

  -- Tax-setup guide: one state-level jurisdiction + one nexus registration
  -- for the /admin/setup/tax-setup conversion. Exercises the JURISDICTION:
  -- installed-code path (California's card renders installed) and the
  -- nonzero step-2 / step-3 stats. Id …0014–…0017 are unclaimed (verified by
  -- grep over the whole file).
  insert into tax_jurisdictions
    (id, org_id, code, name, country, region, level, tax_type, is_active)
  values
    ('00000000-0000-7000-9000-000000000014', v_org, 'US-CA', 'California',
     'US', 'CA', 'state', 'sales_use', true)
  on conflict (id) do nothing;

  insert into tax_registrations
    (id, org_id, jurisdiction_id, registration_number, filing_frequency,
     return_form_code, is_active)
  values
    ('00000000-0000-7000-9000-000000000015', v_org,
     '00000000-0000-7000-9000-000000000014', 'CA-SELLERS-PERMIT-VIEWSPEC',
     'quarterly', 'US_CA_CDTFA401', true)
  on conflict (id) do nothing;

end $$;
