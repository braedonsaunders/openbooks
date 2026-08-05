import { sql } from "drizzle-orm";
import type { FinancialProfile } from "@openbooks/schema";
import { db } from "./db.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEASURES = new Set([
  "invoiced_to_date",
  "revenue_posted",
  "actual_cost",
  "labor_cost",
  "overhead",
  "committed_cost",
  "billable_value",
  "unbilled_billable",
  "cost_budget",
  "total_price",
  "could_be_invoiced",
  "total_cost",
  "gross_profit",
  "margin_pct",
  "remaining_budget",
]);
const TOTAL_COST_COMPONENTS = new Set([
  "actual_cost",
  "committed_cost",
  "labor_cost",
  "overhead",
]);

function object(value: unknown, name: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, any>;
}

function oneOf(value: unknown, allowed: readonly string[], name: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${name} is invalid`);
  }
}

function strings(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((entry) => typeof entry !== "string" || !entry || entry.length > 100)
  ) {
    throw new Error(`${name} must be an array of valid identifiers`);
  }
  return value;
}

function optionalNonnegativeNumber(value: unknown, name: string): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0)
  ) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
}

/** Runtime boundary validation for tenant-authored financial policy. */
export function assertValidProjectFinancialProfile(
  value: unknown,
): asserts value is FinancialProfile {
  const profile = object(value, "financialProfile");
  const invoiced = object(profile.invoicedToDate, "invoicedToDate");
  strings(invoiced.docKinds, "invoicedToDate.docKinds");
  strings(invoiced.creditKinds, "invoicedToDate.creditKinds");

  const actual = object(profile.actualCost, "actualCost");
  oneOf(actual.source, ["account_types", "account_group", "none"], "actualCost.source");
  if (actual.accountTypes !== undefined) strings(actual.accountTypes, "actualCost.accountTypes");
  if (actual.groupKeys !== undefined) strings(actual.groupKeys, "actualCost.groupKeys");
  if (actual.dimension !== undefined && (typeof actual.dimension !== "string" || !actual.dimension)) {
    throw new Error("actualCost.dimension is invalid");
  }

  const labor = object(profile.laborCost, "laborCost");
  oneOf(
    labor.source,
    [
      "in_actual_cost",
      "time_rate",
      "estimated_time_rate",
      "payroll_je",
      "account_group",
      "none",
    ],
    "laborCost.source",
  );
  if (labor.groupKeys !== undefined) strings(labor.groupKeys, "laborCost.groupKeys");

  const overhead = object(profile.overhead, "overhead");
  oneOf(
    overhead.method,
    ["none", "percent_of_labor", "per_labor_hour", "rate_engine", "posted_gl_account_group"],
    "overhead.method",
  );
  optionalNonnegativeNumber(overhead.ratePercent, "overhead.ratePercent");
  optionalNonnegativeNumber(overhead.ratePerHour, "overhead.ratePerHour");
  if (overhead.method === "percent_of_labor" && overhead.ratePercent === undefined) {
    throw new Error("overhead.ratePercent is required");
  }
  if (overhead.method === "per_labor_hour" && overhead.ratePerHour === undefined) {
    throw new Error("overhead.ratePerHour is required");
  }
  if (overhead.method === "rate_engine") {
    const rateEngine = object(overhead.rateEngine, "overhead.rateEngine");
    oneOf(rateEngine.rateSource, ["live", "standard"], "overhead.rateEngine.rateSource");
    oneOf(
      rateEngine.hoursBasis,
      ["billed_hours", "actual_hours", "total_hours"],
      "overhead.rateEngine.hoursBasis",
    );
    oneOf(rateEngine.scope, ["flat", "department", "class"], "overhead.rateEngine.scope");
    if (typeof rateEngine.dimension !== "string" || !rateEngine.dimension) {
      throw new Error("overhead.rateEngine.dimension is required");
    }
  }
  if (overhead.method === "posted_gl_account_group") {
    const accountGroup = object(overhead.accountGroup, "overhead.accountGroup");
    if (typeof accountGroup.dimension !== "string" || !accountGroup.dimension) {
      throw new Error("overhead.accountGroup.dimension is required");
    }
    if (accountGroup.groupKeys !== undefined) {
      strings(accountGroup.groupKeys, "overhead.accountGroup.groupKeys");
    }
  }

  const committed = object(profile.committedCost, "committedCost");
  strings(committed.docKinds, "committedCost.docKinds");
  if (committed.statuses !== undefined) {
    const statuses = strings(committed.statuses, "committedCost.statuses");
    if (
      statuses.some(
        (status) =>
          !["pending_approval", "approved", "rejected"].includes(status),
      )
    ) {
      throw new Error(
        "committedCost.statuses contains an unsupported lifecycle",
      );
    }
  }
  const billable = object(profile.billableValue, "billableValue");
  if (
    typeof billable.includeUnbilledTime !== "boolean" ||
    typeof billable.includeUnbilledCostLines !== "boolean"
  ) {
    throw new Error("billableValue inclusion flags must be boolean");
  }
  oneOf(billable.timeRate, ["bill_rate", "cost_times_markup"], "billableValue.timeRate");
  if (billable.costSourceKinds !== undefined) {
    strings(billable.costSourceKinds, "billableValue.costSourceKinds");
  }
  if (billable.costSourceStatuses !== undefined) {
    const statuses = strings(
      billable.costSourceStatuses,
      "billableValue.costSourceStatuses",
    );
    if (
      statuses.some(
        (status) =>
          !["pending_approval", "approved", "posted", "rejected"].includes(
            status,
          ),
      )
    ) {
      throw new Error(
        "billableValue.costSourceStatuses contains an unsupported lifecycle",
      );
    }
  }
  oneOf(object(profile.costBudget, "costBudget").source, ["wbs_estimates", "none"], "costBudget.source");

  const price = object(profile.totalPrice, "totalPrice");
  oneOf(
    price.method,
    ["contract_field", "billable_value", "not_to_exceed", "cost_plus"],
    "totalPrice.method",
  );
  optionalNonnegativeNumber(price.defaultMarkupPercent, "totalPrice.defaultMarkupPercent");
  oneOf(
    object(profile.couldBeInvoiced, "couldBeInvoiced").formula,
    ["price_minus_invoiced", "unbilled_billable"],
    "couldBeInvoiced.formula",
  );

  const components = strings(
    object(profile.totalCost, "totalCost").components,
    "totalCost.components",
  );
  if (!components.length || components.some((entry) => !TOTAL_COST_COMPONENTS.has(entry))) {
    throw new Error("totalCost.components contains an unsupported measure");
  }
  if (new Set(components).size !== components.length) {
    throw new Error("totalCost.components cannot contain duplicates");
  }

  if (!Array.isArray(profile.layout) || !profile.layout.length || profile.layout.length > 100) {
    throw new Error("layout must contain between 1 and 100 lines");
  }
  for (const [index, raw] of profile.layout.entries()) {
    const line = object(raw, `layout[${index}]`);
    if (!MEASURES.has(line.measure)) throw new Error(`layout[${index}].measure is invalid`);
    oneOf(line.variant, ["line", "subtotal", "total"], `layout[${index}].variant`);
    if (line.label !== undefined && (typeof line.label !== "string" || line.label.length > 200)) {
      throw new Error(`layout[${index}].label is invalid`);
    }
    if (line.hideWhenZero !== undefined && typeof line.hideWhenZero !== "boolean") {
      throw new Error(`layout[${index}].hideWhenZero must be boolean`);
    }
  }
}

export interface PublishProjectFinancialProfileInput {
  orgId: string;
  projectTypeId: string;
  effectiveFrom: string;
  financialProfile: FinancialProfile;
  reason: string;
  actorId: string | null;
}

type TransactionExecutor = {
  execute: (query: any) => Promise<any>;
};

export interface CorrectProjectFinancialProfileInput {
  orgId: string;
  versionId: string;
  expectedFinancialProfile: FinancialProfile;
  correctedFinancialProfile: FinancialProfile;
  reason: string;
  actorId: string;
}

/**
 * Correct a published policy without altering its valid-time identity.
 *
 * This is intentionally distinct from normal publication. It requires an
 * optimistic before-image, an attributable actor, a meaningful reason, and
 * writes complete before/after evidence atomically. Dates and row identity
 * remain immutable.
 */
export async function correctProjectFinancialProfile(
  input: CorrectProjectFinancialProfileInput,
): Promise<{ id: string; effectiveFrom: string; effectiveTo: string | null }> {
  const reason = input.reason.trim();
  if (reason.length < 8) throw new Error("a meaningful correction reason is required");
  if (!/^[0-9a-f-]{36}$/i.test(input.actorId)) {
    throw new Error("an attributable correction actor is required");
  }
  assertValidProjectFinancialProfile(input.expectedFinancialProfile);
  assertValidProjectFinancialProfile(input.correctedFinancialProfile);

  return db.transaction(async (tx) => {
    const current = (await tx.execute(sql`
      select id, effective_from::text as effective_from,
             effective_to::text as effective_to, financial_profile,
             financial_profile = ${JSON.stringify(input.expectedFinancialProfile)}::jsonb
               as matches_expected,
             financial_profile = ${JSON.stringify(input.correctedFinancialProfile)}::jsonb
               as matches_corrected
        from project_financial_profile_versions
       where id = ${input.versionId} and org_id = ${input.orgId}
       for update
    `)) as unknown as {
      rows: Array<{
        id: string;
        effective_from: string;
        effective_to: string | null;
        financial_profile: FinancialProfile;
        matches_expected: boolean;
        matches_corrected: boolean;
      }>;
    };
    const row = current.rows[0];
    if (!row) throw new Error("project financial profile version not found");
    const expected = JSON.stringify(input.expectedFinancialProfile);
    if (!row.matches_expected) {
      throw new Error("project financial profile changed after the correction was planned");
    }
    if (row.matches_corrected) {
      return {
        id: row.id,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
      };
    }

    await tx.execute(
      sql`select set_config('openbooks.correct_project_profile', 'on', true)`,
    );
    await tx.execute(
      sql`select set_config('openbooks.project_profile_correction_reason', ${reason}, true)`,
    );
    const updated = await tx.execute(sql`
      update project_financial_profile_versions
         set financial_profile = ${JSON.stringify(input.correctedFinancialProfile)}::jsonb,
             updated_at = now(), updated_by = ${input.actorId}
       where id = ${row.id} and org_id = ${input.orgId}
         and financial_profile = ${expected}::jsonb
      returning id
    `);
    if (updated.rows.length !== 1) {
      throw new Error("project financial profile changed during correction");
    }
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${input.orgId}, 'project_financial_profile_versions', ${row.id},
        'update',
        ${JSON.stringify({
          mode: "controlled_historical_correction",
          reason,
          before: {
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
            financialProfile: row.financial_profile,
          },
          after: {
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
            financialProfile: input.correctedFinancialProfile,
          },
        })}::jsonb,
        ${input.actorId}
      )
    `);
    return {
      id: row.id,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    };
  });
}

/**
 * Publish an append-only, effective-dated project financial policy.
 *
 * The prior range is closed and the new row is inserted in one transaction.
 * Existing published JSON is never edited; a database guard permits only the
 * controlled effective-to adjustment performed here.
 */
export async function publishProjectFinancialProfile(
  input: PublishProjectFinancialProfileInput,
): Promise<{ id: string; effectiveFrom: string; effectiveTo: string | null }> {
  if (!DATE.test(input.effectiveFrom)) {
    throw new Error("effectiveFrom must be YYYY-MM-DD");
  }
  const reason = input.reason.trim();
  if (reason.length < 8) {
    throw new Error("a meaningful reason is required");
  }

  return db.transaction((tx) =>
    publishProjectFinancialProfileInTransaction(tx, {
      ...input,
      reason,
    }),
  );
}

export async function publishProjectFinancialProfileInTransaction(
  tx: TransactionExecutor,
  input: PublishProjectFinancialProfileInput,
): Promise<{ id: string; effectiveFrom: string; effectiveTo: string | null }> {
  const reason = input.reason.trim();
  if (!DATE.test(input.effectiveFrom)) {
    throw new Error("effectiveFrom must be YYYY-MM-DD");
  }
  if (reason.length < 8) {
    throw new Error("a meaningful reason is required");
  }
  assertValidProjectFinancialProfile(input.financialProfile);

  await tx.execute(
    sql`select set_config('openbooks.publish_project_profile', 'on', true)`,
  );
  const type = (await tx.execute(sql`
    select pt.id,
           (
             current_timestamp at time zone coalesce(
               (
                 select fc.time_zone
                   from fiscal_calendars fc
                  where fc.org_id = pt.org_id
                    and fc.is_active
                  order by fc.is_default desc, fc.created_at
                  limit 1
               ),
               o.settings ->> 'timeZone',
               'UTC'
             )
           )::date::text as accounting_today
      from project_types pt
      join orgs o on o.id = pt.org_id
     where pt.id = ${input.projectTypeId} and pt.org_id = ${input.orgId}
     for update of pt
  `)) as unknown as { rows: { id: string; accounting_today: string }[] };
  if (!type.rows[0]) throw new Error("project type not found");
  if (input.effectiveFrom < type.rows[0].accounting_today) {
    throw new Error(
      "financial profile versions cannot be backdated through ordinary setup; use a controlled historical correction workflow",
    );
  }

  const sameDate = (await tx.execute(sql`
    select id from project_financial_profile_versions
     where org_id = ${input.orgId}
       and project_type_id = ${input.projectTypeId}
       and effective_from = ${input.effectiveFrom}
     limit 1
  `)) as unknown as { rows: { id: string }[] };
  if (sameDate.rows.length) {
    throw new Error(
      `a financial profile version already starts on ${input.effectiveFrom}`,
    );
  }

  const next = (await tx.execute(sql`
    select effective_from::text as effective_from
      from project_financial_profile_versions
     where org_id = ${input.orgId}
       and project_type_id = ${input.projectTypeId}
       and effective_from > ${input.effectiveFrom}
     order by effective_from
     limit 1
  `)) as unknown as { rows: { effective_from: string }[] };
  const effectiveTo = next.rows[0]
    ? (
        (await tx.execute(sql`
          select (${next.rows[0].effective_from}::date - 1)::text as d
        `)) as unknown as { rows: { d: string }[] }
      ).rows[0]!.d
    : null;

  await tx.execute(sql`
    with prior as materialized (
      select id, effective_to
        from project_financial_profile_versions
       where org_id = ${input.orgId}
         and project_type_id = ${input.projectTypeId}
         and effective_from < ${input.effectiveFrom}
         and (
           effective_to is null
           or effective_to >= ${input.effectiveFrom}
         )
    ),
    closed as (
      update project_financial_profile_versions version
         set effective_to = (${input.effectiveFrom}::date - 1),
             updated_at = now(),
             updated_by = ${input.actorId}
        from prior
       where version.id = prior.id
      returning version.id, prior.effective_to as prior_effective_to,
                version.effective_to
    )
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id)
    select ${input.orgId}, 'project_financial_profile_versions', id, 'update',
           jsonb_build_object(
             'before', jsonb_build_object('effectiveTo', prior_effective_to),
             'after', jsonb_build_object('effectiveTo', effective_to),
             'reason', ${reason}::text,
             'closedByEffectiveFrom', ${input.effectiveFrom}::text
           ),
           ${input.actorId}
      from closed
  `);

  const inserted = (await tx.execute(sql`
    insert into project_financial_profile_versions (
      org_id, project_type_id, effective_from, effective_to,
      financial_profile, reason, created_by, updated_by
    )
    values (
      ${input.orgId}, ${input.projectTypeId}, ${input.effectiveFrom},
      ${effectiveTo}, ${JSON.stringify(input.financialProfile)}::jsonb,
      ${reason}, ${input.actorId}, ${input.actorId}
    )
    returning id, effective_from::text as effective_from,
              effective_to::text as effective_to
  `)) as unknown as {
    rows: {
      id: string;
      effective_from: string;
      effective_to: string | null;
    }[];
  };
  const version = inserted.rows[0]!;
  await tx.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id)
    values (
      ${input.orgId}, 'project_financial_profile_versions', ${version.id},
      'insert',
      ${JSON.stringify({
        after: {
          projectTypeId: input.projectTypeId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo,
          financialProfile: input.financialProfile,
          reason,
        },
      })}::jsonb,
      ${input.actorId}
    )
  `);
  return {
    id: version.id,
    effectiveFrom: version.effective_from,
    effectiveTo: version.effective_to,
  };
}
