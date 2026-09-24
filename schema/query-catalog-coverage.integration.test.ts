// Derived governed-catalog coverage: every org_id table is either queryable
// through the governed console (safe_relations or a curated
// openbooks_query view) or covered by a reviewed exclusion below. An org_id
// table missing from both fails closed (invisible, never a leak), but
// reports built on it silently omit rows — so a new table that lands in
// neither set fails this test until a reviewer catalogs it or excludes it
// with a reason. Exclusions are structural (name prefixes), never a hand
// list, plus named entries only where a table differs from its category.
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../engine/src/platform/db.ts";

type Category = { prefixes: string[]; reason: string };

const EXCLUDED_CATEGORIES: Category[] = [
  {
    prefixes: ["hrm_", "worker_employment", "employment_", "position", "work_"],
    reason:
      "HR, employment and worker records carry PII and compensation-confidential data; governed reporting flows through aggregates, not row detail (0184 rationale style).",
  },
  {
    prefixes: [
      "payroll_filing_",
      "payroll_parallel_",
      "payroll_prior_",
      "payroll_retro_",
      "payroll_anomaly_",
    ],
    reason:
      "filing submissions carry taxpayer PII; parallel, prior, retro and anomaly tables are computation runs or import staging, not books of record.",
  },
  {
    prefixes: ["time_clock_", "time_kiosks", "worker_clock_", "crew_"],
    reason:
      "clock, kiosk, pin and crew rows are field-time operational detail; labor reporting flows through timesheet_weeks and labor_cost_rates.",
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
    ],
    reason: "operational and audit logs, not reporting.",
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
    prefixes: ["ap_capture_"],
    reason: "AP capture runtime: candidate field values before they post.",
  },
  {
    prefixes: ["anomaly_"],
    reason: "anomaly detection baselines, not reporting.",
  },
];

const EXCLUDED_TABLES: Record<string, string> = {
  number_sequences: "sequence counters for document numbering.",
  employee_tax_certificates: "tax certificate PII.",
  time_approval_stages: "time approval workflow configuration.",
  source_deletion_resolutions: "sync conflict-resolution runtime.",
  posting_effects: "posting pipeline internals.",
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
  const def = await db.execute<{ def: string }>(sql`
    select pg_get_functiondef(oid) as def from pg_proc
     where proname = 'openbooks_refresh_query_catalog'`);
  const body = def.rows[0]?.def ?? "";
  const array = /safe_relations constant text\[\] := array\[([\s\S]*?)\n  \];/.exec(body)?.[1] ?? "";
  const names = new Set(
    [...array.matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((match) => match[1]),
  );
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
  assert.deepEqual(
    uncovered,
    [],
    `org_id tables outside the governed console and the reviewed exclusions: ${uncovered.join(", ")}`,
  );
});

test("the coverage derivation is not vacuous", async () => {
  // A probe table with org_id that is neither governed nor excluded must
  // fail the derivation: if the probe passes, the query sees nothing.
  const probe = `g12_probe_${Date.now().toString(36)}`;
  await db.execute(sql.raw(`create table public.${probe} (id uuid primary key, org_id uuid not null)`));
  try {
    assert.ok(
      (await uncoveredTables()).includes(probe),
      "a fresh unreviewed org_id table must be uncovered",
    );
  } finally {
    await db.execute(sql.raw(`drop table public.${probe}`));
  }
});
