// Every org_id table must be governed through safe_relations/openbooks_query or have a reviewed exclusion; unclassified tables silently disappear from reports.
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { deletionOrder, loadCatalog } from "@openbooks/engine/testing/sandbox/catalog";
import { TENANT_TABLE_POLICIES } from "@openbooks/engine/testing/sandbox/tenant-table-policies";

type Category = { prefixes: string[]; reason: string };

const EXCLUDED_CATEGORIES: Category[] = [
  {
    prefixes: [
      "hrm_",
      "worker_employment",
      "employment_",
      "position",
      "work_",
      "payroll_work_location_",
    ],
    reason:
      "HR, employment and worker records carry PII and compensation-confidential data; governed reporting flows through aggregates, not row detail (0184 rationale style).",
  },
  {
    prefixes: [
      "payroll_filing_",
      "payroll_us_filing_account_employer_lineage",
      "payroll_parallel_",
      "payroll_prior_",
      "payroll_retro_",
      "payroll_anomaly_",
      "payroll_roe_",
      "it_addizionali_",
    ],
    reason:
      "filing submissions, ROE filing inputs and addizionali opening carry-ins carry taxpayer and employee PII; parallel, prior, retro, anomaly, ROE and carry-in tables are computation runs, import staging or filing policy, not books of record.",
  },
  {
    prefixes: [
      "payroll_compensation_",
      "payroll_holiday_",
      "payroll_opening_employer_",
      "payroll_period_openings",
      "payroll_service_credits",
      "payroll_vacation_terms",
      "payroll_employee_employer_assignments",
      "pay_run_benefit_allocations",
    ],
    reason:
      "compensation definitions and calculations, holiday and vacation entitlements, service credits, employer assignments, opening carry-ins and benefit payroll allocations are compensation-confidential employee records; payroll reporting flows through pay stubs.",
  },
  {
    prefixes: ["time_clock_", "time_kiosks", "worker_clock_", "crew_"],
    reason:
      "clock, kiosk, pin and crew rows are field-time operational detail; labor reporting flows through timesheet_weeks and labor_cost_rates.",
  },
  {
    prefixes: [
      "schedule_attendance_batches",
      "schedule_attendance_events",
      "schedule_attendance_event_claims",
      "schedule_attendance_observation_events",
      "schedule_attendance_watermarks",
    ],
    reason:
      "attendance device batches, raw check-in events, their claims and capture watermarks are capture evidence; attendance reporting flows through schedule_attendance_observations.",
  },
  {
    prefixes: ["ai_"],
    reason:
      "agent runs, conversations and decisions may carry prompt content; AI workbench internals, not reporting.",
  },
  {
    prefixes: [
      "app_",
      "apps",
      "application_",
      "approval_",
      "automation",
      "flow",
      "sandbox",
      "extension_",
    ],
    reason: "platform, automation and flow runtime state, not reporting.",
  },
  {
    prefixes: ["user", "role_assignments", "resource_grants"],
    reason: "identity, preferences and access grants; never a reporting surface.",
  },
  {
    prefixes: [
      "api_",
      "sftp_",
      "bank_feed_",
      "connection",
      "qbd_",
      "tax_rate_",
      "fx_provider_",
      "psp_provider_",
    ],
    reason: "credentials, tokens and provider interaction state.",
  },
  {
    prefixes: [
      "audit_",
      "email_",
      "notification",
      "scheduler_",
      "sync_",
      "import_",
      "change_set",
      "script_",
      "backup_",
      "storage_cleanup_",
      "data_transfer_",
    ],
    reason: "operational runtimes, outboxes and audit logs, not reporting.",
  },
  {
    prefixes: ["file", "folder", "masking_"],
    reason: "content storage and data-masking internals.",
  },
  {
    prefixes: [
      "saved_",
      "insight_",
      "list_view",
      "org_nav_",
      "page_spec",
      "role_dashboard_",
      "report_",
      "nl_report_",
      "statement_layout",
      "pdf_template",
      "custom_",
      "form_",
    ],
    reason: "UI personalization, report authoring and presentation config.",
  },
  {
    prefixes: [
      "payment_attempt",
      "payment_bank_",
      "payment_card",
      "payment_file",
      "payment_format",
      "payment_instruction",
      "payment_link",
      "payment_mandate",
      "pay_run_bank_",
      "pay_run_holiday_",
      "psp_settlement_",
    ],
    reason:
      "payment rail interaction records and sensitive instruments; settlement reporting flows through payment_settlements.",
  },
  {
    prefixes: ["close_automation_", "close_blueprint", "close_polic"],
    reason: "close configuration templates, not close activity.",
  },
  {
    prefixes: ["asset_transfer_", "asset_basis_"],
    reason: "asset transfer measurement detail.",
  },
  {
    prefixes: ["information_return_"],
    reason: "tax filing PII.",
  },
  {
    prefixes: ["dunning_polic", "dunning_stages"],
    reason: "dunning configuration; dunning activity flows through dunning_log.",
  },
  {
    prefixes: ["field_ticket_polic", "field_ticket_signature"],
    reason:
      "field ticket configuration and signer identity; ticket activity flows through field_tickets.",
  },
  {
    prefixes: ["service_visit_signature_requests", "service_customer_notices"],
    reason:
      "visit signing-link digests and customer notice delivery plumbing; service activity flows through service_visits and service_visit_signatures.",
  },
  {
    prefixes: ["ap_capture_"],
    reason: "AP capture runtime: candidate field values before they post.",
  },
  {
    prefixes: ["anomaly_"],
    reason: "anomaly detection baselines, not reporting.",
  },
];

const EXCLUDED_TABLES: Record<string, string> = {
  fx_revaluation_rate_evidence:
    "recorded closing rates bind exact close positions with operator source and reason; native close readers own access.",
  field_ticket_source_certifications:
    "human-reviewed source identity bindings retain operator attestation and retained-file provenance; native certification readers own access.",
  historical_translation_contributions:
    "approved financial source assessments contain protected Cabinet provenance; native authorized source readers own access.",
  historical_translation_layers:
    "immutable contribution layers retain protected Cabinet source references; translation reporting consumes approved native evidence rather than generic row access.",
  payroll_opening_levy_source_authorities:
    "qualified statutory opening evidence retains protected Cabinet provenance; native payroll source readers enforce access.",
  payroll_opening_levy_source_allocations:
    "employee opening levy allocations are compensation-confidential source evidence; native payroll calculations own scoped consumption.",
  payroll_ca_opening_reporting_authorities:
    "original Canadian reporting certificates retain protected Cabinet provenance and employee compensation snapshots; native payroll reporting readers enforce scoped access.",
  payroll_ca_opening_reporting_allocations:
    "original RP and province reporting slices retain compensation-confidential annual and child history; native payroll reporting owns their scoped consumption.",
  number_sequences: "sequence counters for document numbering.",
  connector_replay_authorizations:
    "operational authorization evidence for closed-period replay; not a reporting entity.",
  expense_receipt_captures:
    "receipt capture runtime: candidate readings before review; confirmed expenses report through documents.",
  einvoice_documents:
    "issued e-invoice files retained as legal originals; invoice facts report through documents.",
  employee_tax_certificates: "tax certificate PII.",
  source_deletion_resolutions: "sync conflict-resolution runtime.",
  posting_effects: "posting pipeline internals.",
  payroll_employer_facts:
    "employee statutory facts that drive payroll calculations, not a generic reporting surface.",
  payroll_opening_program_bases:
    "employee opening YTD bases for statutory wage limits, not a generic reporting surface.",
  payroll_opening_sui_wages:
    "employee opening SUI wage bases for statutory wage limits, not a generic reporting surface.",
  payroll_opening_account_bases:
    "employee opening wage bases scoped by filing account for statutory wage limits, not a generic reporting surface.",
  pay_component_earning_classifications:
    "payroll earning policy inputs are controlled setup data, not a generic reporting surface.",
  project_geofences: "project operations config.",
  recurring_occurrence_documents: "recurring scheduler runtime.",
  reporting_relationships: "reporting graph config.",
};

async function orgTables(): Promise<string[]> {
  const rows = await db.execute<{ relname: string }>(sql`
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
       and a.attname = 'org_id'
       and not a.attisdropped
     where n.nspname = 'public'
       and c.relkind = 'r'
     group by 1`);
  return rows.rows.map((row) => row.relname);
}

async function governedTables(): Promise<Set<string>> {
  // The governed set lives in the registry table (0418), not in the refresh
  // function body: module packs add rows, so parsing the body would miss
  // every module's relations.
  const registered = await db.execute<{ relation: string }>(sql`
    select relation from public.openbooks_query_catalog_relations`);
  const names = new Set(registered.rows.map((row) => row.relation));
  const views = await db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.views
     where table_schema = 'openbooks_query'`);
  for (const row of views.rows) names.add(row.table_name);
  return names;
}

function exclusionReason(table: string): string | null {
  for (const category of EXCLUDED_CATEGORIES) {
    if (category.prefixes.some((prefix) => table.startsWith(prefix))) {
      return category.reason;
    }
  }
  return EXCLUDED_TABLES[table] ?? null;
}

async function uncoveredTables(): Promise<string[]> {
  const [tables, governed] = await Promise.all([orgTables(), governedTables()]);
  return tables.filter((table) => !governed.has(table) && !exclusionReason(table));
}

test("every org_id table is governed or reviewed", async () => {
  const uncovered = await uncoveredTables();
  const catalog = await loadCatalog();
  const cloneable = catalog.rebaseSet.has("pay_component_earning_classifications");
  const teardownOrder = deletionOrder({ ...catalog, tables: catalog.tenantTables });
  const allocationIndex = teardownOrder.indexOf("payroll_ca_opening_reporting_allocations");
  const reportingIndex = teardownOrder.indexOf("payroll_ca_opening_reporting_authorities");
  const levyIndex = teardownOrder.indexOf("payroll_opening_levy_source_authorities");
  assert.ok(
    allocationIndex >= 0 && reportingIndex > allocationIndex && levyIndex > reportingIndex,
    "native tenant teardown must remove Canadian reporting slices before their reporting certificate and levy parent",
  );
  assert.deepEqual(
    [uncovered, cloneable, TENANT_TABLE_POLICIES.pay_component_earning_classifications],
    [[], true, "clone:catalog-uuid-rebase"],
    `org_id tables outside the governed console and the reviewed exclusions: ${uncovered.join(", ")}`,
  );
});

test("the coverage derivation is not vacuous", async () => {
  // A probe table with org_id that is neither governed nor excluded must
  // fail the derivation: if the probe passes, the query sees nothing.
  const probe = `g12_probe_${Date.now().toString(36)}`;
  await db.execute(
    sql.raw(`create table public.${probe} (id uuid primary key, org_id uuid not null)`),
  );
  try {
    assert.ok(
      (await uncoveredTables()).includes(probe),
      "a fresh unreviewed org_id table must be uncovered",
    );
  } finally {
    await db.execute(sql.raw(`drop table public.${probe}`));
  }
});
