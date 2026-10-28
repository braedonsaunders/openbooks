import { sql } from "drizzle-orm";
import { db, orgContext, withMaintenanceTransaction } from "../platform/db.ts";
import {
  assertUuid,
  insertionOrder,
  loadCatalog,
  PARENT_FILTER,
  type TableInfo,
} from "./catalog.ts";
import { loadMaskingPolicies, maskExpr, type MaskTransform } from "./masking.ts";
import { rebaseClonedJsonReferences } from "./json-references.ts";
import { createClonePacer, readClonePacing } from "./clone-pacing.ts";
import {
  canSuspendTriggers,
  readCloneBulkLoadSetting,
  resumeTriggersForTransaction,
  suspendTriggersForTransaction,
  verifyBulkLoadedClone,
  writeTriggerMaintainedRows,
} from "./clone-bulk-load.ts";
import {
  copyS3Blob,
  deleteS3Blobs,
  fileCabinetObjectKey,
  MASKED_STORAGE_KIND,
} from "../platform/file-storage.ts";
import { enqueueStorageCleanupStandalone } from "../platform/storage-cleanup.ts";
import { canonicalNonNegativeDecimal } from "../money/exact-decimal.ts";
import { toUnits } from "../money/money.ts";
import { canonicalPeriodLabel } from "../periods/period-policy.ts";

/**
 * The deterministic UUID-rebase clone engine. Copies one org's rows into a
 * sandbox org by rewriting every PK and FK through ob_rebase(id, seed): because
 * the same seed rebases both sides of every reference, the copied graph stays
 * internally consistent with no mapping table. Runs as a single deferred-
 * constraint transaction with the kernel-migration GUC set so already-posted
 * ledger rows can be inserted.
 */

export type SandboxTier = "dev" | "masked" | "full" | "as_of";

export function validateSandboxTier(value: unknown): SandboxTier {
  if (value === "dev" || value === "masked" || value === "full" || value === "as_of") return value;
  throw new Error(
    `invalid sandbox tier ${JSON.stringify(value)}; choose dev, masked, full, or as_of`,
  );
}

export interface CloneOptions {
  productionOrgId: string;
  sandboxOrgId: string;
  seed: string;
  tier: SandboxTier;
  masked: boolean;
  /** for tier='as_of': the selected cutoff period id. Only the id crosses the
   * transaction boundary: the period's calendar and end date are resolved
   * INSIDE the clone's snapshot transaction (see resolveAsOfCutoff), so a
   * concurrent fiscal-period derivation can never strand the copy filter on
   * a stale ordinal while the copied period rows carry new labels. */
  asOfPeriodId?: string | null;
  /** Create-only: overwrite the (already inserted) sandbox org row with the
   * production org configuration captured inside the clone snapshot. Refresh
   * preserves the sandbox's own org row and omits this. */
  initializeOrg?: boolean;
  /**
   * Create-only: caller-owned settings keys merged over the captured source
   * configuration (and over the provisional row), so ownership/provenance the
   * caller needs for crash recovery survives the authoritative overwrite.
   * Refresh never carries one.
   */
  settingsOverlay?: Record<string, unknown>;
  /** Restrict the copy to these tables (used by refresh to skip the preserved
   * customization layer). Undefined = copy the tier's full set. */
  onlyTables?: Set<string>;
}

/**
 * An as-of cutoff resolved inside the clone snapshot: the selected period's
 * end date is the cutoff instant, qualified by its calendar for display.
 *
 * Policy: an entry is included iff its posting_date is on or before the
 * cutoff end date, whatever calendar its period belongs to. Posting date —
 * not the period ordinal — is what every other as-of feature cuts on (trial
 * balance, aging, open items and statements all read `posting_date <= asOf`),
 * so the sandbox's books equal production's books-as-of that date exactly.
 * The period's only role is to supply the cutoff instant and the
 * date-and-calendar label the UI and the refusal carry.
 */
export interface AsOfCutoff {
  periodId: string;
  /** Canonical fiscal label of the cutoff period (`P07 FY2026`). */
  periodName: string;
  endsOn: string;
  fiscalYear: number;
  periodNumber: number;
  calendarId: string;
  calendarName: string;
}

export interface CloneResult {
  tablesCopied: number;
  rowsCopied: number;
  perTable: { table: string; rows: number }[];
  /** The cutoff used, when tier='as_of'. */
  asOfCutoff: Pick<AsOfCutoff, "periodId" | "periodName" | "endsOn" | "calendarName"> | null;
  /** Production org settings captured inside the clone snapshot (SBOX2: the
   * same snapshot the tenant rows came from). Null unless initializeOrg. */
  sourceSettings: Record<string, unknown> | null;
}

/** A cutoff end date comes out of our own snapshot as an ISO civil date. */
function assertCutoffDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`as-of cutoff end date is not a civil date: ${value}`);
  }
  return value;
}

/**
 * Resolve the selected cutoff period inside the caller's snapshot
 * transaction: first statement of the clone unit, so the identity (calendar
 * + end date) the preflight and the copy filter share is the snapshot's,
 * never an outer lookup's. Scoped to the production org — a foreign or
 * missing period id is a refusal, not an empty cutoff.
 */
export async function resolveAsOfCutoff(
  productionOrgId: string,
  periodId: string,
): Promise<AsOfCutoff> {
  const res = await db.execute<{
    id: string;
    ends_on: string;
    fiscal_year: number;
    period_number: number;
    is_adjustment: boolean;
    calendar_id: string;
    calendar_name: string;
  }>(
    sql`
    select p.id, p.ends_on::text as ends_on,
           p.fiscal_year, p.period_number, p.is_adjustment,
           p.fiscal_calendar_id as calendar_id, fc.name as calendar_name
      from accounting_periods p
      join fiscal_calendars fc
        on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
     where p.id = ${periodId} and p.org_id = ${productionOrgId}`,
    "objects",
  );
  const row = res[0];
  if (!row) throw new Error("as-of cutoff period must belong to the production organization");
  return {
    periodId: row.id,
    periodName: canonicalPeriodLabel({
      fiscalYear: row.fiscal_year,
      periodNumber: row.period_number,
      adjustment: row.is_adjustment,
    }),
    endsOn: assertCutoffDate(row.ends_on),
    fiscalYear: row.fiscal_year,
    periodNumber: row.period_number,
    calendarId: row.calendar_id,
    calendarName: row.calendar_name,
  };
}

interface SourceOrgConfig {
  legalName: string | null;
  baseCurrency: string;
  country: string;
  taxIds: unknown;
  settings: Record<string, unknown>;
}

/** Read the production org configuration inside the clone snapshot. A
 * zero-row read is a failure: the caller named a source org that is gone. */
async function readSourceOrgConfig(productionOrgId: string): Promise<SourceOrgConfig> {
  const res = await db.execute<{
    legal_name: string | null;
    base_currency: string;
    country: string;
    tax_ids: unknown;
    settings: Record<string, unknown> | null;
  }>(
    sql`
    select legal_name, base_currency, country, tax_ids, settings
      from orgs where id = ${productionOrgId}`,
    "objects",
  );
  const row = res[0];
  if (!row) throw new Error(`production org not found: ${productionOrgId}`);
  return {
    legalName: row.legal_name,
    baseCurrency: row.base_currency,
    country: row.country,
    taxIds: row.tax_ids ?? {},
    settings: row.settings ?? {},
  };
}

/**
 * Overwrite the sandbox org row with the in-snapshot source configuration. A
 * zero-row write is a failure: the sandbox row must already exist (create
 * inserts it before the clone; refresh never sets initializeOrg). `name` is
 * deliberately NOT captured: it is the sandbox's own display name
 * (create inserts the user's sandbox name), not source configuration.
 */
async function applySandboxOrgConfig(
  sandboxOrgId: string,
  source: SourceOrgConfig,
  masked: boolean,
  settingsOverlay: Record<string, unknown> = {},
): Promise<void> {
  const updated = await db.execute<never>(sql`
    update orgs
       set legal_name = ${source.legalName},
           base_currency = ${source.baseCurrency},
           country = ${source.country},
           tax_ids = ${JSON.stringify(masked ? {} : (source.taxIds ?? {}))}::jsonb,
           settings = (${JSON.stringify(source.settings)}::jsonb || ${JSON.stringify(settingsOverlay)}::jsonb),
           updated_at = now()
     where id = ${sandboxOrgId}`);
  if ((updated.rowCount ?? 0) !== 1) {
    throw new Error(`sandbox org row not found: ${sandboxOrgId}`);
  }
}

/** The user-built customization layer, preserved across a "keep customizations" refresh / diffed on
 * promotion. Names not present in the schema are skipped harmlessly. */
export const CUSTOMIZATION_LAYER = new Set([
  "user_scripts",
  "custom_field_defs",
  "custom_record_types",
  "form_layouts",
  "user_form_preferences",
  "list_views",
  "user_list_preferences",
  "statement_layouts",
  "segment_definitions",
  "segment_values",
  "fx_provider_configs",
  "saved_reports",
  "report_definitions",
  "report_schedules",
  "saved_views",
  "app_roles",
  "role_assignments",
  "user_permission_overrides",
  "user_dashboard_layouts",
  "role_dashboard_layouts",
  "account_groups",
  "account_group_members",
  "users",
]);

/** Validate original coordinates against proven bills of the same subcontract.
 * Legacy null evidence stays null; financial strings are never rewritten. */
export function validateVendorRetainageSourceAllocations(
  value: unknown,
  releaseAmount: string,
  billIds: ReadonlySet<string>,
  label: string,
): void {
  if (value === null) return;
  function refuse(reason: string): never {
    throw new Error(
      `sandbox clone: ${label}: ${reason}; correct the original retainage allocations and include their bills in the document copy before retrying`,
    );
  }
  if (!Array.isArray(value) || value.length === 0)
    refuse("source allocations must be a nonempty array");
  const exact = (raw: unknown): bigint => {
    const canonical = canonicalNonNegativeDecimal(raw, 4);
    if (canonical === null) refuse("source coordinates must be exact nonnegative decimal strings");
    return toUnits(canonical);
  };
  let allocated = 0n;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      refuse("source allocation must be an object");
    const allocation = entry as Record<string, unknown>;
    if (Object.keys(allocation).sort().join(",") !== "amount,documentId,held,previousAmount")
      refuse("source allocation fields are invalid");
    if (typeof allocation.documentId !== "string") refuse("source bill identity is invalid");
    let documentId: string;
    try {
      documentId = assertUuid(allocation.documentId).toLowerCase();
    } catch {
      refuse("source bill identity is invalid");
    }
    if (!billIds.has(documentId)) refuse("source bill has no scoped counterpart in the sandbox");
    if (seen.has(documentId)) refuse("source bill is allocated more than once");
    seen.add(documentId);
    const held = exact(allocation.held),
      previous = exact(allocation.previousAmount),
      amount = exact(allocation.amount);
    if (amount <= 0n || previous + amount > held)
      refuse("source coordinates exceed the original retained amount");
    allocated += amount;
  }
  if (allocated !== exact(releaseAmount)) refuse("source amounts do not equal the release amount");
}

/** Run after documents have been copied, inside the same clone snapshot.
 * Original bill status may have changed since release; its ownership does not. */
async function validateVendorRetainageSourcesForClone(opts: CloneOptions): Promise<void> {
  const releases = await db.execute<{
    id: string;
    subcontract_id: string;
    amount: string;
    source_bill_allocations: unknown;
  }>(
    sql`
    select id, subcontract_id, amount::text as amount, source_bill_allocations
      from vendor_retainage_releases where org_id = ${opts.productionOrgId}`,
    "objects",
  );
  if (!releases.some((row) => row.source_bill_allocations !== null)) return;
  const bills = await db.execute<{ subcontract_id: string; document_id: string }>(
    sql`
    select application.subcontract_id, original.id as document_id
      from vendor_pay_applications application
      join documents original on original.org_id = application.org_id and original.id = application.vendor_bill_document_id
      join documents copied on copied.org_id = ${opts.sandboxOrgId}
        and copied.id = ob_rebase(original.id, ${opts.seed}::uuid)
     where application.org_id = ${opts.productionOrgId}`,
    "objects",
  );
  const ids = new Map<string, Set<string>>();
  for (const bill of bills) {
    const scoped = ids.get(bill.subcontract_id) ?? new Set<string>();
    scoped.add(bill.document_id);
    ids.set(bill.subcontract_id, scoped);
  }
  for (const release of releases)
    validateVendorRetainageSourceAllocations(
      release.source_bill_allocations,
      release.amount,
      ids.get(release.subcontract_id) ?? new Set(),
      `retainage release ${release.id}`,
    );
}

/** Generate the INSERT..SELECT that copies one table, or null to skip it.
 * `retainedTenantTables` = tenant-owned tables the clone deliberately does not
 * copy (the catalog EXCLUDE set): a real FK into one of them can never be
 * copied verbatim — the value would be a pointer at PRODUCTION's row. */
/** Segment tables copied before every dimension-carrying table, in this order. */
const EARLY_SEGMENT_TABLES = ["segment_definitions", "segment_values"];

/**
 * SEGMENT_DEFAULTS_RESTORE: each copied segment definition regains its
 * source default, rebased, once its values exist in the sandbox.
 */
export function segmentDefaultsRestoreSql(
  opts: Pick<CloneOptions, "seed" | "sandboxOrgId" | "productionOrgId">,
): string {
  const seed = assertUuid(opts.seed);
  const sbx = assertUuid(opts.sandboxOrgId);
  const prod = assertUuid(opts.productionOrgId);
  return `update segment_definitions target set default_value_id = ob_rebase(source.default_value_id, '${seed}'::uuid)
    from segment_definitions source
   where source.org_id = '${prod}'::uuid and source.default_value_id is not null
     and target.org_id = '${sbx}'::uuid and target.id = ob_rebase(source.id, '${seed}'::uuid)`;
}

export function generateCopySql(
  t: TableInfo,
  opts: CloneOptions,
  rebaseSet: Set<string>,
  retainedTenantTables: Set<string>,
  masking: Map<string, Map<string, MaskTransform>>,
  cutoff: AsOfCutoff | null,
  idRange?: CopyIdRange,
): string | null {
  const seed = assertUuid(opts.seed);
  const sbx = assertUuid(opts.sandboxOrgId);
  const prod = assertUuid(opts.productionOrgId);
  const tableMask = opts.masked ? masking.get(t.name) : undefined;

  // A masked sandbox never receives production file bytes: the blob table is
  // not copied at all, and version/file rows carry the tombstone storage
  // kind instead of 'db'/'s3'. Every download path refuses the tombstone by
  // name (see MASKED_STORAGE_KIND); metadata (names, sizes, hashes) stays so
  // the cabinet remains browsable test data.
  if (opts.masked && t.name === "file_blobs") return null;

  const auditScope = `public.financial_history_clone_scope("scope_key", '${seed}'::uuid)`;
  const cols: string[] = [];
  const exprs: string[] = [];
  for (const c of t.columns) {
    cols.push(`"${c.name}"`);
    const nativeProductionEvidence =
      (t.name === "operating_profile_scopes" && c.name === "profile_ids") ||
      (t.name === "operating_profile_versions" && c.name === "definition") ||
      (t.name === "inventory_inspection_plans" && c.name === "measures") ||
      (t.name === "inventory_inspections" &&
        ["plan_snapshot", "disposition_result"].includes(c.name)) ||
      (t.name === "mfg_wo_operations" &&
        ["inspection_plan_snapshot", "standard_labor_burden", "overhead_snapshot"].includes(
          c.name,
        )) ||
      ([
        "mfg_subcontracts",
        "mfg_subcontract_returns",
        "mfg_subcontract_material_returns",
        "mfg_subcontract_shipments",
      ].includes(t.name) &&
        c.name === "request_snapshot") ||
      (t.name === "mfg_subcontract_service_bills" && c.name === "expense_snapshot") ||
      (t.name === "mfg_mrp_runs" && c.name === "parameters") ||
      (t.name === "mfg_planned_orders" && c.name === "demand_ref");
    if (nativeProductionEvidence && tableMask?.has(c.name))
      throw new Error(
        `Native production evidence ${t.name}.${c.name} cannot use a whole-column masking transform. Remove that policy; masked copies redact its prose while retaining required quantities, criteria and rebased identity.`,
      );

    if (t.name === "gl_audit_number_assignments" && c.name === "scope_key") {
      exprs.push(auditScope);
      continue;
    }
    if (t.name === "gl_audit_number_assignments" && c.name === "audit_number") {
      exprs.push(
        `(select p.prefix from gl_audit_number_policies p where p.org_id='${prod}'::uuid and p.id="gl_audit_number_assignments".policy_id) || '-' || replace(${auditScope}, ':', '-') || '-' || lpad("ordinal"::text, greatest(6,length("ordinal"::text)), '0')`,
      );
      continue;
    }
    if (
      [
        "fx_rate_types",
        "account_translation_policies",
        "subsidiary_accounting_preferences",
        "segment_balancing_policies",
        "gl_audit_number_policies",
        "project_loss_policies",
        "expense_fx_policies",
        "payroll_us_filing_account_employer_lineage",
      ].includes(t.name) &&
      c.isUuid &&
      ["created_by", "updated_by"].includes(c.name)
    ) {
      exprs.push(
        `(case when "${c.name}" is null then null else ob_rebase("${c.name}", '${seed}'::uuid) end)`,
      );
      continue;
    }
    if (t.name === "documents" && c.name === "payment_terms_snapshot") {
      if (tableMask?.has(c.name))
        throw new Error(
          "Retained payment terms require native identity rebasing; remove their whole-column masking policy.",
        );
      exprs.push(
        `public.document_payment_terms_snapshot_for_clone("payment_terms_snapshot", '${prod}'::uuid, "party_id", '${seed}'::uuid)`,
      );
      continue;
    }
    // Recorded exchange rate evidence is copied through the same native
    // projection the insert guard and source matching compare against: exact
    // rate, currencies and date, the rebased legal entity, and in a masked
    // copy a redacted source and reason.
    if (t.name === "documents" && c.name === "document_fx_rate_evidence") {
      if (tableMask?.has(c.name))
        throw new Error(
          "Recorded exchange rate evidence requires native identity rebasing; remove its whole-column masking policy.",
        );
      if (!rebaseSet.has("subsidiaries")) {
        throw new Error(
          "sandbox clone: recorded exchange rate evidence requires subsidiaries in the copy plan; include subsidiaries before retrying",
        );
      }
      exprs.push(
        `public.document_fx_rate_evidence_for_clone("document_fx_rate_evidence", '${seed}'::uuid, ${opts.masked ? "true" : "false"})`,
      );
      continue;
    }
    // An expense line's exchange-rate evidence names the rate observation it
    // read: the copy points at the rebased observation, and a masked copy
    // redacts an operator's reason for an explicit rate.
    if (t.name === "document_lines" && c.name === "original_fx_evidence") {
      if (tableMask?.has(c.name))
        throw new Error(
          "Expense line exchange rate evidence requires native identity rebasing; remove its whole-column masking policy.",
        );
      const observation = `case when "original_fx_evidence"->>'observationId' is null then null else ob_rebase(("original_fx_evidence"->>'observationId')::uuid, '${seed}'::uuid)::text end`;
      const reason = opts.masked
        ? ` || case when "original_fx_evidence"->>'reason' is null then '{}'::jsonb else jsonb_build_object('reason', 'REDACTED') end`
        : "";
      exprs.push(
        `(case when "original_fx_evidence" is null then null else "original_fx_evidence" || jsonb_build_object('observationId', ${observation})${reason} end)`,
      );
      continue;
    }
    if (
      (t.name === "performance_obligations" && c.name === "allocation_basis") ||
      (t.name === "recognition_control_events" &&
        ["before_state", "after_state"].includes(c.name)) ||
      (t.name === "rebate_cost_attestations" && c.name === "line_basis") ||
      (t.name === "rebate_accruals" && c.name === "basis") ||
      (t.name === "rebate_claims" && ["basis", "settlement_basis"].includes(c.name))
    ) {
      if (tableMask?.has(c.name))
        throw new Error(
          `Retained financial evidence ${t.name}.${c.name} requires native identity rebasing; remove its whole-column masking policy.`,
        );
      exprs.push(
        `public.production_clone_safe_evidence("${c.name}", '${seed}'::uuid, '${c.name}', '${sbx}'::uuid, ${opts.masked ? "true" : "false"})`,
      );
      continue;
    }
    if (
      opts.masked &&
      t.name === "payroll_us_filing_account_employer_lineage" &&
      ["source_reference", "change_reason"].includes(c.name)
    ) {
      exprs.push("'REDACTED'::text");
      continue;
    }
    // Closing rate quotes copy so the copied ledger keeps its pricing
    // evidence; a masked copy redacts the authored source and reason while
    // the clone guard admits only the source row's exact projection.
    if (
      opts.masked &&
      t.name === "fx_revaluation_rate_evidence" &&
      ["source", "reason"].includes(c.name)
    ) {
      exprs.push("'REDACTED'::text");
      continue;
    }
    // Field Ticket source certifications copy so the copied ticket keeps
    // its governed source binding; their retained evidence rebases native
    // identities through the native projection (source identities and
    // hashes stay original), and a masked copy redacts the operator's
    // attestation and reason while the clone guard admits only the exact
    // projection.
    if (
      t.name === "field_ticket_source_certifications" &&
      ["source_row_snapshot", "reference_map", "native_point_in_time"].includes(c.name)
    ) {
      if (tableMask?.has(c.name))
        throw new Error(
          "Field Ticket source certification evidence requires native identity rebasing; remove its whole-column masking policy.",
        );
      exprs.push(
        `public.field_ticket_source_certification_clone_evidence("${c.name}", '${seed}'::uuid, '${c.name}', '${sbx}'::uuid, ${opts.masked ? "true" : "false"})`,
      );
      continue;
    }
    if (
      opts.masked &&
      t.name === "field_ticket_source_certifications" &&
      ["attestation", "reason"].includes(c.name)
    ) {
      exprs.push("'REDACTED'::text");
      continue;
    }
    if (
      opts.masked &&
      [
        "fx_rate_types",
        "account_translation_policies",
        "subsidiary_accounting_preferences",
        "segment_balancing_policies",
        "gl_audit_number_policies",
        "project_loss_policies",
        "expense_fx_policies",
        "rebate_agreements",
        "rebate_cost_attestations",
        "rebate_claims",
        "rebate_settlement_reversals",
        "recognition_control_events",
        "journal_lines",
      ].includes(t.name) &&
      ["name", "reason", "memo", "evidence"].includes(c.name)
    ) {
      const redacted =
        t.name === "rebate_cost_attestations" && c.name === "evidence"
          ? "REDACTED FINANCIAL EVIDENCE"
          : "REDACTED";
      exprs.push(`(case when "${c.name}" is null then null else '${redacted}' end)`);
      continue;
    }
    // Scope membership is canonical JSON identity data and must be rebased before its ownership trigger runs.
    if (t.name === "operating_profile_scopes" && c.name === "profile_ids") {
      if (
        !rebaseSet.has("operating_profiles") ||
        (opts.onlyTables && !opts.onlyTables.has("operating_profiles"))
      ) {
        throw new Error("Workflow scopes require operating profiles in the sandbox copy plan.");
      }
      exprs.push(`(select jsonb_agg(to_jsonb(ob_rebase(value::uuid,'${seed}'::uuid)::text) order by ord)
        from jsonb_array_elements_text("profile_ids") with ordinality member(value,ord))`);
      continue;
    }
    // Custom-segment assignments name segment values by id; each value copies
    // under its rebased identity, so every assignment of a source value is
    // rebased with it (codes and other scalars carry over unchanged).
    if (c.name === "extra_dims" && c.udtName === "jsonb" && t.name !== "segment_values") {
      if (tableMask?.has(c.name))
        throw new Error(
          `Custom-segment assignments ${t.name}.extra_dims require native identity rebasing; remove the whole-column masking policy.`,
        );
      exprs.push(`(case when "extra_dims" is null then null else coalesce((select jsonb_object_agg(dim.key, case
          when jsonb_typeof(dim.value) = 'string' and exists (select 1 from segment_values value_row
            where value_row.org_id = '${prod}'::uuid and value_row.id::text = dim.value #>> '{}')
          then to_jsonb(ob_rebase((dim.value #>> '{}')::uuid, '${seed}'::uuid)::text) else dim.value end)
        from jsonb_each("extra_dims") dim), '{}'::jsonb) end)`);
      continue;
    }
    // A segment's default value is one of its own values, which copy after it;
    // the default is restored once the values exist (see SEGMENT_DEFAULTS_RESTORE).
    if (t.name === "segment_definitions" && c.name === "default_value_id") {
      exprs.push("null::uuid");
      continue;
    }
    // Automatic delivery never follows copied people or activates in a new environment.
    if (t.name === "schedule_boards" && c.name === "automatic_delivery_policy") {
      exprs.push("null::jsonb");
      continue;
    }

    if (
      opts.masked &&
      (t.name === "files" || t.name === "file_versions") &&
      c.name === "storage_kind"
    ) {
      exprs.push(`'${MASKED_STORAGE_KIND}'`);
      continue;
    }
    // Value rules may contain customer names or booking details; masked
    // copies retain board behavior without carrying those match values.
    if (opts.masked && t.name === "schedule_boards" && c.name === "cell_color_rules") {
      exprs.push("'[]'::jsonb");
      continue;
    }
    if (t.name === "vendor_retainage_releases" && c.name === "source_bill_allocations") {
      if (!rebaseSet.has("documents") || (opts.onlyTables && !opts.onlyTables.has("documents"))) {
        throw new Error(
          "sandbox clone: retainage source allocations require documents in the copy plan; include documents before retrying",
        );
      }
      exprs.push(`(case when "source_bill_allocations" is null then null else (
        select jsonb_agg(jsonb_set(a.value, '{documentId}',
          to_jsonb(ob_rebase((a.value->>'documentId')::uuid, '${seed}'::uuid)::text)) order by a.ord)
        from jsonb_array_elements("source_bill_allocations") with ordinality as a(value, ord)
      ) end)`);
      continue;
    }
    if (t.name === "handling_unit_moves" && ["request", "movements"].includes(c.name)) {
      if (tableMask?.has(c.name)) {
        throw new Error(
          `Warehouse movement evidence ${c.name} requires native structured masking; remove the whole-column policy before copying.`,
        );
      }
      exprs.push(
        opts.masked
          ? `public.warehouse_execution_mask_json("${c.name}", '${seed}'::uuid, '${c.name}')`
          : `public.warehouse_execution_clone_json("${c.name}", '${seed}'::uuid)`,
      );
      continue;
    }
    const fkTarget = t.fks[c.name];
    if (c.name === "id" && t.hasId) {
      exprs.push(`ob_rebase("id", '${seed}')`);
    } else if (c.name === "org_id") {
      exprs.push(`'${sbx}'::uuid`);
    } else if (
      c.isUuid &&
      [
        "hrm_benefit_enrollments",
        "hrm_benefit_enrollment_terms",
        "hrm_benefit_payroll_inputs",
      ].includes(t.name)
    ) {
      // Historical creator/elector fields can predate their tenant FKs.
      // Keep the complete election graph, including its actor identities,
      // on the same deterministic sandbox mapping as the guarded source row.
      exprs.push(
        `(case when "${c.name}" is null then null else ob_rebase("${c.name}", '${seed}') end)`,
      );
    } else if (
      c.isUuid &&
      [
        "inventory_movements",
        "stock_counts",
        "stock_count_lines",
        "journal_entries",
        "mfg_work_orders",
        "mfg_wo_operations",
        "mfg_wo_materials",
        "mfg_scrap_events",
        "mfg_routings",
        "mfg_routing_operations",
        "mfg_work_centers",
        "mfg_work_center_rates",
        "mfg_mrp_runs",
        "mfg_planned_orders",
        "mfg_subcontracts",
        "mfg_subcontract_returns",
        "mfg_subcontract_material_returns",
        "mfg_subcontract_shipments",
        "mfg_subcontract_service_bills",
        "inventory_inspection_plans",
        "inventory_inspections",
        "operating_profiles",
        "operating_profile_versions",
        "operating_profile_scopes",
      ].includes(t.name) &&
      [
        "created_by",
        "updated_by",
        "posted_by",
        "inspected_by",
        "disposed_by",
        "published_by",
      ].includes(c.name)
    ) {
      // Historical creator/elector fields can predate their tenant FKs.
      // Keep the complete election graph, including its actor identities,
      // on the same deterministic sandbox mapping as the guarded source row.
      exprs.push(
        `(case when "${c.name}" is null then null else ob_rebase("${c.name}", '${seed}') end)`,
      );
    } else if (
      c.isUuid &&
      ["flow_runs", "flow_gates"].includes(t.name) &&
      ["created_by", "updated_by", "decided_by"].includes(c.name) &&
      !fkTarget &&
      !t.forceRebase.has(c.name)
    ) {
      exprs.push(
        `(case when "subject_kind"='hrm_benefit_enrollment' and "${c.name}" is not null ` +
          `then ob_rebase("${c.name}", '${seed}') else "${c.name}" end)`,
      );
    } else if (c.isUuid && fkTarget && retainedTenantTables.has(fkTarget)) {
      if (!c.isNullable) {
        throw new Error(
          `sandbox clone: ${t.name}.${c.name} is NOT NULL and references ${fkTarget}, which is never copied into a sandbox`,
        );
      }
      exprs.push("null");
    } else if (c.isUuid && ((fkTarget && rebaseSet.has(fkTarget)) || t.forceRebase.has(c.name))) {
      // Historical creator/elector fields can predate their tenant FKs.
      // Keep the complete election graph, including its actor identities,
      // on the same deterministic sandbox mapping as the guarded source row.
      exprs.push(
        `(case when "${c.name}" is null then null else ob_rebase("${c.name}", '${seed}') end)`,
      );
    } else if (t.name === "hrm_employment_change_requests" && c.name === "decision_snapshot") {
      // OM-13c: the decision snapshot binds flow_run_id BY VALUE (storage
      // CHECK ..._snapshot_binding), but the copy rebases flow_run_id to the
      // sandbox run while a verbatim snapshot still names the source run —
      // the INSERT dies on the binding CHECK before any post-copy fixup can
      // run. Rebind the snapshot's flow_run_id to the rebased run at copy
      // time. Every other bound key (payload digest, schema version,
      // expected revision) is rebase-invariant, and rows without a snapshot
      // (drafts) or without a run pass through untouched.
      exprs.push(
        `(case when "decision_snapshot" is null or "flow_run_id" is null then "decision_snapshot" ` +
          `else jsonb_set("decision_snapshot", '{flow_run_id}', to_jsonb(ob_rebase("flow_run_id", '${seed}')::text)) end)`,
      );
    } else if (t.name === "flow_runs" && c.name === "occurrence_key") {
      // OM-13-CLONE: occurrence_key sits in a global partial unique with no
      // org_id, so a verbatim copy collides with the source's own row (PG
      // 23505) and hands the sandbox production's dedup claim. The run rows
      // stay — gates and effects reference them by NOT NULL run_id — but the
      // key is cleared: a sandbox never adopts the source's dedup slot, and
      // retried attempts mint their own keys.
      exprs.push("null");
    } else if (t.name === "journal_entries" && c.name === "custom") {
      const rebased = `public.production_clone_journal_evidence("custom", '${seed}'::uuid, '${sbx}'::uuid, ${opts.masked ? "true" : "false"})`;
      exprs.push(
        `(case when "origin"='manufacturing' then ${rebased} else ${opts.masked ? maskExpr(c.name, tableMask?.get(c.name) ?? "null_out", "id", c) : '"custom"'} end)`,
      );
    } else if (t.name === "journal_lines" && c.name === "custom") {
      // Equity lines name the security whose instrument balance they carry
      // (an early-exercise deposit, accrued note interest). The security is
      // copied with a rebased id, so the line's identity is rebased with it;
      // a masked copy keeps only that identity, which holds no personal data.
      const tagged = `("custom"->>'equitySecurityId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;
      const identity = `jsonb_build_object('equitySecurityId', ob_rebase(("custom"->>'equitySecurityId')::uuid, '${seed}'::uuid)::text, 'equityRole', "custom"->'equityRole')`;
      const otherwise = opts.masked
        ? maskExpr(c.name, tableMask?.get(c.name) ?? "null_out", "id", { ...c, tableName: t.name })
        : `"custom"`;
      exprs.push(
        `(case when ${tagged} then ${opts.masked ? identity : `"custom" || ${identity}`} else ${otherwise} end)`,
      );
    } else if (
      t.name === "mfg_wo_operations" &&
      ["standard_labor_burden", "overhead_snapshot"].includes(c.name)
    ) {
      exprs.push(
        `public.production_clone_safe_evidence("${c.name}",'${seed}'::uuid,'${c.name}','${sbx}'::uuid,${opts.masked ? "true" : "false"})`,
      );
    } else if (
      t.name === "mfg_wo_operations" &&
      ["standard_labor_burden_hash", "overhead_snapshot_hash"].includes(c.name)
    ) {
      const document =
        c.name === "standard_labor_burden_hash" ? "standard_labor_burden" : "overhead_snapshot";
      exprs.push(
        `(case when "${document}" is null then null else 'sha256:'||encode(digest(convert_to(public.production_canonical_json(public.production_clone_safe_evidence("${document}",'${seed}'::uuid,'${document}','${sbx}'::uuid,${opts.masked ? "true" : "false"})),'UTF8'),'sha256'),'hex') end)`,
      );
    } else if (tableMask?.has(c.name)) {
      exprs.push(`${maskExpr(c.name, tableMask.get(c.name)!, "id", { ...c, tableName: t.name })} `);
    } else if (
      (t.name === "operating_profile_scopes" && c.name === "profile_ids") ||
      ([
        "mfg_subcontracts",
        "mfg_subcontract_returns",
        "mfg_subcontract_material_returns",
        "mfg_subcontract_shipments",
      ].includes(t.name) &&
        c.name === "request_snapshot") ||
      (t.name === "mfg_subcontract_service_bills" && c.name === "expense_snapshot") ||
      (t.name === "inventory_inspections" &&
        ["plan_snapshot", "disposition_result"].includes(c.name)) ||
      (t.name === "mfg_wo_operations" && c.name === "inspection_plan_snapshot") ||
      (t.name === "inventory_inspection_plans" && c.name === "measures") ||
      (t.name === "operating_profile_versions" && c.name === "definition") ||
      (t.name === "mfg_mrp_runs" && c.name === "parameters") ||
      (t.name === "mfg_planned_orders" && c.name === "demand_ref")
    ) {
      exprs.push(
        `public.production_clone_safe_evidence("${c.name}", '${seed}'::uuid, '${c.name}', '${sbx}'::uuid,${opts.masked ? "true" : "false"})`,
      );
    } else if (
      (t.name === "payroll_holiday_obligations" && c.name === "evidence") ||
      (t.name === "pay_run_holiday_allocations" && c.name === "source_snapshot")
    ) {
      exprs.push(`public.holiday_clone_json("${c.name}", '${c.name}', '${seed}'::uuid)`);
    } else if (
      t.name === "financial_changes" &&
      ["payload", "before_state", "result"].includes(c.name)
    ) {
      // Only this native event has the declared holiday identity contract.
      // Other accounting events retain their existing copy composition.
      const holidayEvidence = opts.masked
        ? `(case when "${c.name}" is null then null else '{}'::jsonb end)`
        : `public.holiday_clone_json("${c.name}", '${c.name}', '${seed}'::uuid)`;
      exprs.push(
        `(case when "domain"='payroll' and "operation"='adjudicated_holiday_hours' ` +
          `then ${holidayEvidence} when "domain"='manufacturing' then public.production_clone_safe_evidence("${c.name}", '${seed}'::uuid, '${c.name}', '${sbx}'::uuid,${opts.masked ? "true" : "false"}) else "${c.name}" end)`,
      );
    } else if (t.name === "financial_changes" && c.name === "idempotency_key") {
      const rebound = `(public.production_clone_safe_evidence(to_jsonb("idempotency_key"),'${seed}'::uuid,'requestKey','${sbx}'::uuid,${opts.masked ? "true" : "false"})#>>'{}')`;
      exprs.push(
        `(case when "domain"='manufacturing' then ${rebound} ${opts.masked ? `when "domain"='payroll' and "operation"='adjudicated_holiday_hours' then ('holiday-'||ob_rebase("id",'${seed}'::uuid)::text)` : ""} else ${tableMask?.has(c.name) ? maskExpr(c.name, tableMask.get(c.name)!, "id", c) : '"idempotency_key"'} end)`,
      );
    } else if (opts.masked && t.name === "financial_changes" && c.name === "reason") {
      const removed =
        c.name === "reason"
          ? "'REDACTED'"
          : `('holiday-' || ob_rebase("id", '${seed}'::uuid)::text)`;
      exprs.push(
        `(case when ("domain"='payroll' and "operation"='adjudicated_holiday_hours' or "domain"='manufacturing') then ${removed} else "${c.name}" end)`,
      );
    } else if (t.name === "hrm_benefit_enrollments" && c.name === "submission_snapshot") {
      exprs.push(
        `public.benefit_clone_submission_evidence("submission_snapshot", '${seed}'::uuid)`,
      );
    } else if (t.name === "hrm_benefit_enrollments" && c.name === "decision_snapshot") {
      exprs.push(`public.benefit_clone_decision_evidence("decision_snapshot", '${seed}'::uuid)`);
    } else if (
      (t.name === "flow_submissions" && ["policy", "context", "graphs"].includes(c.name)) ||
      (t.name === "flow_runs" && c.name === "context") ||
      (t.name === "flows" && c.name === "graph") ||
      c.name === "submission_policy"
    ) {
      // Frozen routing keeps its graph structure and decision history, with
      // tenant references rebased by the same seed as the copied records.
      const evidence = `public.flow_clone_evidence("${c.name}", '${seed}'::uuid, '${c.name}', '${sbx}'::uuid)`;
      exprs.push(opts.masked ? `public.production_mask_evidence(${evidence})` : evidence);
    } else if (
      opts.masked &&
      (c.udtName === "jsonb" || c.udtName === "json") &&
      c.name === "custom"
    ) {
      // Custom fields are arbitrary tenant-authored JSON and may contain PII
      // without a schema-level column for a masking policy to name. A masked
      // environment must not carry that payload by default; an explicit
      // table/column policy can opt into a narrower transform when safe.
      exprs.push(`${maskExpr(c.name, "null_out", "id", c)} `);
    } else {
      exprs.push(`"${c.name}"`);
    }
  }

  // Source-row filter.
  let where: string;
  if (t.hasOrgId) {
    where = `org_id = '${prod}'`;
  } else if (PARENT_FILTER[t.name]) {
    where = PARENT_FILTER[t.name]!(prod);
  } else {
    return null; // org-less, no known parent filter — skip
  }

  // as_of: trim the general ledger to entries posted on or before the cutoff
  // end date, whatever calendar their period belongs to. The date is the
  // in-snapshot cutoff resolved by runClone and asserted to ISO shape there,
  // so this interpolation is provably a value, not a statement.
  if (opts.tier === "as_of" && cutoff) {
    const endsOn = cutoff.endsOn;
    if (t.name === "journal_entries") {
      where += ` and posting_date <= '${endsOn}'`;
    } else if (t.name === "journal_lines") {
      where += ` and entry_id in (select je.id from journal_entries je where je.org_id = '${prod}' and je.posting_date <= '${endsOn}')`;
    }
  }

  const parentColumn = lineageParentColumn(t.name);
  const tree = parentColumn
    ? `with recursive source_tree as (
    select id, 0 as depth from "${t.name}" where org_id = '${prod}' and "${parentColumn}" is null
    union all
    select child.id, parent.depth + 1 from "${t.name}" child
      join source_tree parent on parent.id = child."${parentColumn}" where child.org_id = '${prod}'
  ) `
    : "";
  const order =
    t.name === "gl_audit_number_assignments"
      ? " order by book_id, subsidiary_id, scope_key, ordinal"
      : parentColumn
        ? ` order by (select depth from source_tree where source_tree.id = "${t.name}".id), id`
        : "";
  // Component insertion creates an empty one-to-one classification row.
  // Its expected conflict must copy every source classification, rather than
  // duplicate the row or retain the empty defaults in the sandbox.
  const conflict =
    t.name === "pay_component_earning_classifications"
      ? ` on conflict (org_id, pay_component_id) do update set ${t.columns
          .filter((c) => c.name !== "org_id" && c.name !== "pay_component_id")
          .map((c) => `"${c.name}" = excluded."${c.name}"`)
          .join(", ")}`
      : t.name === "fx_rate_types"
        ? // Organization insertion seeds these three logical keys. Only those expected
          // collisions update; custom definitions and unexpected collisions still refuse.
          ` on conflict (org_id, key) do update set ${t.columns
            .filter((c) => c.name !== "org_id" && c.name !== "key")
            .map((c) => `"${c.name}" = excluded."${c.name}"`)
            .join(
              ", ",
            )} where public.financial_history_seeded_rate_clone_conflict(to_jsonb("fx_rate_types"),to_jsonb(excluded))`
        : "";
  if (idRange) {
    if (tree || order || conflict) {
      throw new Error(`sandbox clone: ${t.name} must be copied in a single statement`);
    }
    const key = sliceKeyColumn(t.name);
    if (idRange.after !== null) where += ` and "${key}" > '${assertUuid(idRange.after)}'`;
    if (idRange.through !== null) where += ` and "${key}" <= '${assertUuid(idRange.through)}'`;
  }
  return `${tree}insert into "${t.name}" (${cols.join(", ")}) select ${exprs.join(", ")} from "${t.name}" where ${where}${order}${conflict}`;
}

/**
 * Tables whose INSERT triggers validate a group of rows once per statement.
 * Each slice must hold whole groups, so these slice by the grouping key rather
 * than the primary key: a journal entry's lines are checked for balance at the
 * end of the statement that inserts them.
 */
export const STATEMENT_GROUP_SLICE_KEYS: Readonly<Record<string, string>> = {
  journal_lines: "entry_id",
};

function sliceKeyColumn(table: string): string {
  return STATEMENT_GROUP_SLICE_KEYS[table] ?? "id";
}

/** A half-open slice of a table's source rows by its slice key: `after < key <= through`. */
export interface CopyIdRange {
  after: string | null;
  through: string | null;
}

/** Immediate ownership and reversal guards require ancestors to exist already.
 * Heap/index order and UUID chronology cannot determine retained lineage, so
 * these tables copy in one statement ordered by lineage depth. */
function lineageParentColumn(table: string): string | null {
  if (table === "subsidiaries" || table === "segment_values") return "parent_id";
  if (table === "fx_revaluation_rate_evidence") return "supersedes_id";
  if (["project_financial_adjustments", "project_overhead_adjustments"].includes(table)) {
    return "reverses_adjustment_id";
  }
  return null;
}

/** Whether a table's copy can be split into primary-key slices. Tables whose
 * copy depends on a whole-table order or an expected-conflict clause cannot. */
export function copyIsSliceable(t: TableInfo): boolean {
  const key = sliceKeyColumn(t.name);
  return (
    t.hasOrgId &&
    t.columns.some((c) => c.name === key && c.isUuid && !c.isNullable) &&
    lineageParentColumn(t.name) === null &&
    ![
      "gl_audit_number_assignments",
      "pay_component_earning_classifications",
      "fx_rate_types",
    ].includes(t.name)
  );
}

/**
 * The clone plan's table set: the tier's full set, restricted to onlyTables
 * when given. verify-rls derives its proof from this same selector, so the
 * isolation proof always covers exactly the tables the clone actually
 * copied — a dev-tier proof over ledger tables would be vacuous (dev never
 * copies them) while production counts kept the total positive.
 */
export function selectCloneTables(
  tables: TableInfo[],
  tier: SandboxTier,
  onlyTables?: Set<string>,
): TableInfo[] {
  tier = validateSandboxTier(tier);
  // Copied roles need legal entities; pinned account classifications need
  // their chart of accounts. These are definitions, not posted balances.
  // Keep them outside CUSTOMIZATION_LAYER so refresh updates reference data
  // without treating source account definitions as promotable customizations.
  let selected =
    tier === "dev"
      ? tables.filter(
          (t) =>
            CUSTOMIZATION_LAYER.has(t.name) || t.name === "subsidiaries" || t.name === "accounts",
        )
      : tables;
  if (onlyTables) selected = selected.filter((t) => onlyTables.has(t.name));
  return selected;
}

/** Primary-key slices of one table's source rows, each at most `chunkRows` long.
 * The boundaries come from the clone's own snapshot, so the slices cover
 * exactly the rows a single statement would have copied. */
async function sourceIdRanges(
  t: TableInfo,
  productionOrgId: string,
  chunkRows: number,
): Promise<CopyIdRange[]> {
  const key = sql.identifier(sliceKeyColumn(t.name));
  const bounds = await db.execute<{ id: string }>(
    sql`
    select key::text as id from (
      select ${key} as key, row_number() over (order by ${key}) as position
        from ${sql.identifier(t.name)} where org_id = ${productionOrgId}
    ) source where position % ${chunkRows} = 0 group by key order by key`,
    "objects",
  );
  const ranges: CopyIdRange[] = [];
  let after: string | null = null;
  for (const { id } of bounds) {
    ranges.push({ after, through: id });
    after = id;
  }
  ranges.push({ after, through: null });
  return ranges;
}

/** The write-ahead-log position is readable by default; a role without it is
 * still paced by duty cycle. Checked without raising, inside the clone's
 * transaction, so a refusal cannot abort the copy. */
async function canReadWalPosition(): Promise<boolean> {
  const rows = await db.execute<{ allowed: boolean }>(
    sql`select has_function_privilege('pg_current_wal_lsn()', 'execute') as allowed`,
    "objects",
  );
  return rows[0]?.allowed === true;
}

function walPositionReader(allowed: boolean): () => Promise<bigint | null> {
  return async () => {
    if (!allowed) return null;
    const rows = await db.execute<{ position: string }>(
      sql`select pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint::text as position`,
      "objects",
    );
    return rows[0] ? BigInt(rows[0].position) : null;
  };
}

/** Tables smaller than this keep usable estimates without a refresh. */
const STATISTICS_REFRESH_MIN_ROWS = 1000;

/**
 * Refresh planner statistics for the tables a clone copied substantially,
 * through the owner-run clone statistics function. Returns false when the
 * function is not available to this role, so the caller can plan defensively.
 */
async function refreshCopiedStatistics(
  perTable: readonly { table: string; rows: number }[],
): Promise<boolean> {
  const available = await db.execute<{ allowed: boolean }>(
    sql`select case when to_regprocedure('public.openbooks_clone_analyze(text[])') is null then false
                else has_function_privilege('public.openbooks_clone_analyze(text[])', 'execute') end as allowed`,
    "objects",
  );
  if (available[0]?.allowed !== true) return false;
  const tables = perTable
    .filter((row) => row.rows >= STATISTICS_REFRESH_MIN_ROWS)
    .map((row) => row.table);
  if (tables.length > 0) {
    await db.execute(
      sql`select public.openbooks_clone_analyze(string_to_array(${tables.join(",")}, ','))`,
    );
  }
  return true;
}

/** Elapsed time per clone phase, for the operator log. */
function clonePhaseTimer() {
  const started = Date.now();
  let last = started;
  const marks: string[] = [];
  return {
    mark(phase: string) {
      const now = Date.now();
      marks.push(`${phase} ${((now - last) / 1000).toFixed(1)}s`);
      last = now;
    },
    summary: () => `${marks.join(", ")}; total ${((Date.now() - started) / 1000).toFixed(1)}s`,
  };
}

export async function runClone(opts: CloneOptions): Promise<CloneResult> {
  validateSandboxTier(opts.tier);
  const pacing = readClonePacing();
  const bulkLoadPermitted = readCloneBulkLoadSetting();
  const phases = clonePhaseTimer();
  const cat = await loadCatalog();
  const { tables, rebaseSet } = cat;
  const retainedTenantTables = new Set(
    cat.tenantTables.map((t) => t.name).filter((name) => !rebaseSet.has(name)),
  );
  const masking = opts.masked
    ? await loadMaskingPolicies(opts.productionOrgId)
    : new Map<string, Map<string, MaskTransform>>();

  let selected = selectCloneTables(tables, opts.tier, opts.onlyTables);
  // Copy parents before children: 152 FKs are non-deferrable, so `set constraints
  // all deferred` alone can't guarantee a valid order.
  const insOrder = insertionOrder(cat);
  const rank = new Map(insOrder.map((n, i) => [n, i]));
  selected = [...selected].sort((a, b) => (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9));
  // Custom-segment definitions and values copy right after the legal entities:
  // every row carrying an extra dimension (documents, lines, journal lines,
  // budgets, encumbrances, funds) is validated against them on INSERT, while
  // their own deferrable references (authors) resolve at commit.
  const earlySegments = selected.filter((t) => EARLY_SEGMENT_TABLES.includes(t.name));
  if (earlySegments.length) {
    const rest = selected.filter((t) => !EARLY_SEGMENT_TABLES.includes(t.name));
    const after = rest.findIndex((t) => t.name === "subsidiaries");
    selected = [
      ...rest.slice(0, after + 1),
      ...earlySegments.sort(
        (a, b) => EARLY_SEGMENT_TABLES.indexOf(a.name) - EARLY_SEGMENT_TABLES.indexOf(b.name),
      ),
      ...rest.slice(after + 1),
    ];
  }

  const perTable: { table: string; rows: number }[] = [];
  let rowsCopied = 0;

  // One transaction, unscoped (RLS bypass) since we span production→sandbox.
  // Repeatable read pins a single snapshot of production for every table
  // copy: under read committed, a post landing mid-clone is visible to some
  // copies and invisible to others, and the torn set dies at commit on a
  // deferred FK (or worse, commits FK-consistent but incomplete). The clone
  // only writes sandbox rows, so the pinned snapshot cannot conflict with
  // concurrent production writers. A refresh already runs inside
  // inRefreshTransaction's own REPEATABLE READ unit: re-requesting the level
  // on reuse is refused by name (it cannot apply mid-transaction), so the
  // level is requested only when opening the outermost transaction here and
  // the outer unit's snapshot stands otherwise.
  const joinsOuterSnapshot = !!orgContext.getStore()?.txDb;
  const { cutoff, sourceSettings } = await withMaintenanceTransaction(
    null,
    async () => {
      let cutoff: AsOfCutoff | null = null;
      let sourceSettings: Record<string, unknown> | null = null;
      // Resolve the as-of cutoff FIRST: under runClone's own REPEATABLE READ
      // transaction this statement pins the snapshot; under a refresh reuse it
      // joins the outer unit's snapshot. Either way the calendar and end date
      // the preflight and the copy filter share are the snapshot's own — a
      // concurrent period relabel can neither strand the filter on a stale
      // ordinal nor slip between the refusal check and the copy.
      if (opts.tier === "as_of") {
        if (!opts.asOfPeriodId) throw new Error("as-of sandbox requires a cutoff period");
        cutoff = await resolveAsOfCutoff(opts.productionOrgId, opts.asOfPeriodId);
      }
      // Capture settings in the same snapshot as copied rows. Refresh uses this
      // captured value to rebase JSON control-account references, avoiding a
      // live read after the clone commits that could pair snapshot rows with a
      // newer production control map.
      const source = await readSourceOrgConfig(opts.productionOrgId);
      sourceSettings = source.settings;
      // Create additionally applies that snapshot to its new org row; refresh
      // preserves the sandbox org row but still consumes sourceSettings below.
      if (opts.initializeOrg) {
        await applySandboxOrgConfig(
          opts.sandboxOrgId,
          source,
          opts.masked,
          opts.settingsOverlay ?? {},
        );
      }
      // As-of trims journal entries past the cutoff but copies every document,
      // so a post-cutoff posted entry would leave its documents pointing at an
      // entry that was never copied — a deferred-FK failure at commit. Refuse up
      // front with an actionable error instead. The predicate mirrors the copy
      // filter exactly: posted/reversed entries with posting_date past the
      // cutoff end date are precisely the posted entries the copy drops
      // (posting_date is NOT NULL, so there is no null edge to diverge on).
      if (opts.tier === "as_of" && cutoff) {
        const beyond = (
          await db.execute<{ count: string }>(
            sql`
        select count(*)::text as count
          from journal_entries je
         where je.org_id = ${opts.productionOrgId}
           and je.status in ('posted', 'reversed')
           and je.posting_date > ${cutoff.endsOn}`,
            "objects",
          )
        )[0]?.count;
        if (beyond !== "0") {
          throw new Error(
            `as-of sandbox to period ${cutoff.periodName} ending ${cutoff.endsOn} ` +
              `(calendar "${cutoff.calendarName}") excludes ${beyond ?? "?"} posted entries ` +
              `dated after ${cutoff.endsOn}; ` +
              `their documents would reference entries that were never copied — ` +
              `choose a cutoff ending on or after the latest posted date, or use a full tier`,
          );
        }
      }
      await db.execute(sql`set constraints all deferred`);
      // Trusted bulk copy: the deterministic rebase guarantees integrity, so the
      // kernel guards (account-postability via 'migration', posted-immutability
      // via 'amend') must stand down while we insert already-posted rows.
      await db.execute(sql`select set_config('openbooks.migration', 'on', true)`);
      await db.execute(sql`select set_config('openbooks.amend', 'on', true)`);
      // Clone authority (OM-13): replaying posted history into target periods
      // that are already closed there is refused by the closed-period guards
      // even under the flags above. This transaction-local flag — set ONLY
      // here, inside runClone's own maintenance transaction — lets those
      // guards admit INSERTs of posted/reversed rows (see
      // openbooks_clone_authority()). UPDATE and DELETE of posted history stay
      // blocked, and the flag is inert outside this transaction: the authority
      // also requires the migration/amend flags above plus RLS bypass, which a
      // tenant transaction never holds.
      await db.execute(sql`select set_config('openbooks.clone', 'on', true)`);
      // The clone authority is asserted under RLS bypass. This unit runs on the
      // bypass pool, and its transaction starts with the bypass flag pinned off,
      // so the clone declares it transaction-locally beside the flags above.
      await db.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
      const pacer = await createClonePacer(pacing, walPositionReader(await canReadWalPosition()));
      // A bulk load copies with row and foreign-key triggers suspended for this
      // transaction and proves the result set-wise before it can commit (see
      // clone-bulk-load.ts). Otherwise every row is admitted through its guards.
      const bulkLoad = bulkLoadPermitted && (await canSuspendTriggers());
      if (bulkLoad) {
        await suspendTriggersForTransaction();
      } else {
        // Clone admissions prove each copied row equals its rebased source row.
        // The rebase is one-way, so they look the source up through this
        // transaction-local record of which source row each copied row came
        // from; without it they rehash every source row for each copied row.
        // A temporary table writes no write-ahead log.
        await db.execute(sql`
          create temporary table if not exists openbooks_clone_source_map (
            relation regclass not null,
            target_id uuid not null,
            source_id uuid not null,
            primary key (relation, target_id)
          ) on commit drop`);
      }
      for (const t of selected) {
        const stmt = generateCopySql(t, opts, rebaseSet, retainedTenantTables, masking, cutoff);
        if (!stmt) continue;
        if (
          t.name === "vendor_retainage_releases" &&
          t.columns.some((c) => c.name === "source_bill_allocations")
        ) {
          if (!perTable.some((row) => row.table === "documents")) {
            throw new Error(
              "sandbox clone: retainage source allocations require the documents copy to finish first; include documents before retrying",
            );
          }
          await validateVendorRetainageSourcesForClone(opts);
        }
        if (!bulkLoad && t.hasOrgId && t.columns.some((c) => c.name === "id" && c.isUuid)) {
          await db.execute(sql`
            insert into pg_temp.openbooks_clone_source_map (relation, target_id, source_id)
            select ${`public.${t.name}`}::regclass, ob_rebase(id, ${opts.seed}::uuid), id
              from ${sql.identifier(t.name)}
             where org_id = ${opts.productionOrgId}`);
        }
        let n = 0;
        if (copyIsSliceable(t)) {
          for (const range of await sourceIdRanges(t, opts.productionOrgId, pacing.chunkRows)) {
            const slice = generateCopySql(
              t,
              opts,
              rebaseSet,
              retainedTenantTables,
              masking,
              cutoff,
              range,
            )!;
            n += (await db.execute<Record<string, unknown>>(sql.raw(slice))).rowCount ?? 0;
            await pacer.afterStatement();
          }
        } else {
          n = (await db.execute<Record<string, unknown>>(sql.raw(stmt))).rowCount ?? 0;
          await pacer.afterStatement();
        }
        perTable.push({ table: t.name, rows: n });
        rowsCopied += n;
      }
      if (
        perTable.some((row) => row.table === "segment_definitions") &&
        perTable.some((row) => row.table === "segment_values")
      ) {
        await db.execute(sql.raw(segmentDefaultsRestoreSql(opts)));
      }
      phases.mark("copy");
      // The copied rows are invisible to the planner's statistics until the
      // tables are analyzed, so the verification and rebuild statements below
      // would be planned for an empty organization and rescan the whole copy
      // for every row. ANALYZE counts this transaction's own rows; the clone
      // refreshes every table that received a substantial copy. Where that is
      // unavailable, the set-wide rewrites and rebuilds avoid nested loops.
      const statisticsRefreshed = await refreshCopiedStatistics(perTable);
      phases.mark("statistics");
      const preferSetJoins = (on: boolean) =>
        statisticsRefreshed
          ? Promise.resolve()
          : db.execute(sql`select set_config('enable_nestloop', ${on ? "off" : "on"}, true)`);
      await preferSetJoins(true);
      await rebaseClonedJsonReferences({
        ...opts,
        copiedTables: new Set(perTable.map((row) => row.table)),
      });
      await pacer.afterStatement();
      phases.mark("references");
      if (bulkLoad) {
        // Foreign-key verification probes indexes row by row, which a nested
        // loop does best; it runs with the planner's default joins.
        await preferSetJoins(false);
        await writeTriggerMaintainedRows(opts.sandboxOrgId);
        await resumeTriggersForTransaction();
        const copied = new Set(perTable.map((row) => row.table));
        await verifyBulkLoadedClone({
          sandboxOrgId: opts.sandboxOrgId,
          tables: [
            ...selected.filter((t) => copied.has(t.name)),
            { name: "hrm_benefit_catalog", hasOrgId: true },
          ].map((t) => ({ name: t.name, hasOrgId: t.hasOrgId })),
          parentFilter: PARENT_FILTER,
        });
        phases.mark("verification");
        await preferSetJoins(true);
      }
      // These rollups are intentionally excluded from the clone catalog because
      // they are maintained projections, not source evidence. Rebuild them after
      // every copy: application rows can be inserted before their journal-line
      // endpoints (composite tenant FKs are deferred), so their row trigger may
      // legitimately have no effect during the bulk load. A rebuild also clears
      // stale values left by a refresh before applying the new source snapshot.
      await db.execute(sql`select openbooks_gl_activity_rebuild(${opts.sandboxOrgId})`);
      await pacer.afterStatement();
      await db.execute(sql`select openbooks_party_payment_stats_rebuild(${opts.sandboxOrgId})`);
      await pacer.afterStatement();
      await db.execute(sql`select openbooks_open_item_balances_rebuild(${opts.sandboxOrgId})`);
      await pacer.afterStatement();
      // The search-index rebuild derives each document's terms and amounts
      // from its own lines. Keep the normal planner available for those
      // per-document lookups; the hash-join override above is for the
      // organization-wide projection rebuilds.
      await preferSetJoins(false);
      await db.execute(sql`select openbooks_search_index_rebuild(${opts.sandboxOrgId})`);
      await pacer.afterStatement();
      phases.mark("rebuilds");
      // Evidence for the clone authority asserted above (OM-13): one audit row
      // in the target org recording the provenance and scope of this copy, so
      // closed-period history carried under openbooks.clone is attributable.
      // audit_log is never copied (catalog EXCLUDE), so this insert cannot
      // collide with the bulk copy; it commits or rolls back with the clone.
      await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${opts.sandboxOrgId}, 'orgs', ${opts.sandboxOrgId}, 'insert',
        ${JSON.stringify({
          mode: "sandbox_clone_authority",
          productionOrgId: opts.productionOrgId,
          tier: opts.tier,
          masked: opts.masked,
          tablesCopied: perTable.length,
          rowsCopied,
          authority: "openbooks.clone",
          scope:
            "INSERT of posted/reversed history into closed periods only; UPDATE and DELETE of posted history stay blocked",
        })}::jsonb, null)`);
      console.info(
        `[sandbox] clone of ${opts.productionOrgId} into ${opts.sandboxOrgId}: ${rowsCopied} rows, ${
          bulkLoad ? "bulk load" : "row by row"
        }; ${phases.summary()}`,
      );
      return { cutoff, sourceSettings };
    },
    joinsOuterSnapshot ? {} : { isolationLevel: "REPEATABLE READ" },
  );

  return {
    tablesCopied: perTable.length,
    rowsCopied,
    perTable,
    asOfCutoff: cutoff
      ? {
          periodId: cutoff.periodId,
          periodName: cutoff.periodName,
          endsOn: cutoff.endsOn,
          calendarName: cutoff.calendarName,
        }
      : null,
    sourceSettings,
  };
}

/**
 * S3 object keys are `file-cabinet/<versionId>`, so a row copy that rebases
 * file_versions.id orphans every S3-backed attachment: the sandbox row points
 * at a key that was never written. Copy each production object onto its
 * rebased key (server-side — bytes never transit the clone worker).
 *
 * Masked clones are excluded by construction: their version rows carry the
 * MASKED_STORAGE_KIND tombstone instead of 's3', so the pair query below
 * matches nothing. Tiers that skip files (dev) likewise match nothing via
 * the sandbox-side existence check, and a restricted `onlyTables` copy
 * without file_versions returns early.
 *
 * Runs AFTER the row-copy transaction commits — object storage cannot roll
 * back with it. On failure the objects already copied are deleted and the
 * error rethrown, so the caller marks the sandbox failed instead of
 * publishing a clone whose cabinet 404s.
 */
export async function copyClonedFileObjects(opts: {
  productionOrgId: string;
  sandboxOrgId: string;
  seed: string;
  onlyTables?: Set<string>;
}): Promise<{ objectsCopied: number }> {
  if (opts.onlyTables && !opts.onlyTables.has("file_versions")) return { objectsCopied: 0 };
  // assertUuid at this boundary: both ids travel as bound parameters below,
  // so they must provably be values, not statements.
  const seed = assertUuid(opts.seed);
  const prod = assertUuid(opts.productionOrgId);
  const pairs = await db.execute<{ prodVersionId: string; sandboxVersionId: string }>(
    sql`
    select fv.id as "prodVersionId", ob_rebase(fv.id, ${seed}) as "sandboxVersionId"
      from file_versions fv
      join files f on f.id = fv.file_id
     where f.org_id = ${prod}
       and fv.storage_kind = 's3'
       and exists (
         select 1 from file_versions sv
          where sv.id = ob_rebase(fv.id, ${seed}) and sv.storage_kind = 's3'
       )
  `,
    "objects",
  );
  const copied: string[] = [];
  try {
    for (const pair of pairs) {
      await copyS3Blob(pair.prodVersionId, pair.sandboxVersionId);
      copied.push(pair.sandboxVersionId);
    }
  } catch (err) {
    // Compensating cleanup during unwind: best-effort on purpose — a cleanup
    // failure here must never mask the original copy error being rethrown.
    // Durable intents first so the worker retries what the
    // inline delete below cannot confirm; the inline attempt stays.
    for (const sandboxVersionId of copied) {
      await enqueueStorageCleanupStandalone({
        orgId: opts.sandboxOrgId,
        objectKey: fileCabinetObjectKey(sandboxVersionId),
        ownerKind: "file_version_copy",
        ownerId: sandboxVersionId,
      });
    }
    await deleteS3Blobs(copied).catch(() => undefined);
    throw err;
  }
  return { objectsCopied: copied.length };
}

/**
 * S3 version ids currently referenced by a sandbox's cabinet. Collected
 * BEFORE a wipe so delete/refresh can remove the sandbox's objects after
 * its rows are gone (objects cannot roll back with the row transaction, so
 * they are deleted after the row commit, never before).
 */
export async function listSandboxS3VersionIds(sandboxOrgId: string): Promise<string[]> {
  const org = assertUuid(sandboxOrgId);
  const rows = await db.execute<{ id: string }>(
    sql`
    select fv.id as id
      from file_versions fv
      join files f on f.id = fv.file_id
     where f.org_id = ${org} and fv.storage_kind = 's3'
  `,
    "objects",
  );
  return rows.map((row) => row.id);
}
