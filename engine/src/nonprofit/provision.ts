import { sql } from "drizzle-orm";
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { fundFeatureOff, NonprofitError } from "./errors.ts";
import type { BudgetaryControl, FundKind } from "./funds.ts";

const FUND_KINDS: readonly FundKind[] = ["operating", "restricted", "endowment", "plant", "board_designated"];
const CONTROL_MODES: readonly BudgetaryControl[] = ["off", "advisory", "hard"];

export interface FundClassification {
  kind: FundKind;
  restrictionClass: string;
  budgetaryControl?: BudgetaryControl;
}

export interface ProvisionFundAccountingInput {
  orgId: string;
  defaultFund: { code: string; name: string };
  /** Every existing segment value must have a classification keyed by its code. */
  classifications: Readonly<Record<string, FundClassification>>;
  actorId?: string | null;
}

export interface HistoricalFundImbalance {
  fundId: string;
  code: string;
  name: string;
  unbalancedEntries: number;
}

export interface ProvisionFundAccountingResult {
  segmentId: string;
  defaultFundId: string;
  historicalUnbalancedEntryCount: number;
  unassignedUnbalancedEntryCount: number;
  historicalUnbalancedByFund: HistoricalFundImbalance[];
}

interface SegmentRow {
  id: string;
  sourceKind: string;
  isHierarchical: boolean;
  allowAccountRequirement: boolean;
  isBalancing: boolean;
  defaultValueId: string | null;
  featureKey: string | null;
}

interface SegmentValueRow {
  id: string;
  code: string | null;
  name: string;
  isActive: boolean;
}

interface FundRow {
  id: string;
  kind: FundKind;
  restrictionClass: string;
  budgetaryControl: BudgetaryControl;
}

function refusal(message: string, code: string, remedy: string, status: 409 | 422 = 422, field?: string): NonprofitError {
  return new NonprofitError({ message, code, remedy, status, ...(field ? { field } : {}) });
}

function classificationFor(
  classifications: Readonly<Record<string, FundClassification>>,
  code: string,
): FundClassification | undefined {
  return Object.hasOwn(classifications, code) ? classifications[code] : undefined;
}

function validateClassification(code: string, value: FundClassification | undefined): FundClassification {
  if (
    !value ||
    !FUND_KINDS.includes(value.kind) ||
    typeof value.restrictionClass !== "string" ||
    value.restrictionClass.trim() === "" ||
    (value.budgetaryControl !== undefined && !CONTROL_MODES.includes(value.budgetaryControl))
  ) {
    throw refusal(
      `Fund code "${code}" needs a valid kind, restriction class, and budgetary-control mode.`,
      "fund_classification_required",
      "Supply a complete classification for each fund code in the provisioning request.",
      422,
      "classifications",
    );
  }
  return value;
}

async function assertFundAccountingEnabled(orgId: string): Promise<void> {
  await acquireOrgFeatureGateLock(db, orgId);
  if (!(await orgFeatureEnabled(orgId, "fundAccounting", db))) throw fundFeatureOff();
  if (!(await lockAndCheckOrgFeature(db, orgId, "fundAccounting"))) throw fundFeatureOff();
}

/** Provision the fund segment and its default operating fund without rewriting existing values. */
export async function provisionFundAccounting(
  input: ProvisionFundAccountingInput,
): Promise<ProvisionFundAccountingResult> {
  if (!input.defaultFund.code.trim() || !input.defaultFund.name.trim()) {
    throw refusal(
      "The default operating fund needs a code and name.",
      "default_fund_required",
      "Enter a code and name for the default operating fund.",
      422,
      "defaultFund",
    );
  }

  return withOrgTransaction(input.orgId, async () => {
    await assertFundAccountingEnabled(input.orgId);

    // A concurrent provisioner may have inserted this key; the row is always
    // re-read and checked before any segment value is adopted.
    await db.execute(sql`
      insert into segment_definitions
        (org_id, key, name, plural_name, source_kind, is_hierarchical,
         allow_account_requirement, is_balancing, feature_key, created_by, updated_by)
      values (
        ${input.orgId}, 'fund', 'Fund', 'Funds', 'custom', true,
        true, true, 'fundAccounting', ${input.actorId ?? null}, ${input.actorId ?? null}
      )
      on conflict (org_id, key) do nothing
    `);

    const segmentResult = await db.execute<SegmentRow>(sql`
      select id, source_kind as "sourceKind", is_hierarchical as "isHierarchical",
             allow_account_requirement as "allowAccountRequirement",
             is_balancing as "isBalancing", default_value_id as "defaultValueId",
             feature_key as "featureKey"
        from segment_definitions
       where org_id = ${input.orgId} and key = 'fund'
       for update
    `);
    const segment = segmentResult.rows[0];
    if (!segment) {
      throw refusal(
        "The fund segment was not created or could not be read back.",
        "fund_segment_write_missing",
        "Retry fund accounting setup after checking the segment configuration.",
        409,
      );
    }
    if (segment.sourceKind !== "custom") {
      throw refusal(
        "The fund key is already used by a built-in segment.",
        "fund_segment_conflict",
        "Choose a different custom segment key before provisioning fund accounting.",
        409,
        "fund",
      );
    }

    const valuesResult = await db.execute<SegmentValueRow>(sql`
      select id, code, name, is_active as "isActive"
        from segment_values
       where org_id = ${input.orgId} and segment_id = ${segment.id}
       order by code, id
       for update
    `);
    const existingValues = valuesResult.rows;
    const existingCodes = new Set(existingValues.flatMap((value) => value.code ? [value.code] : []));
    const unclassified = existingValues
      .filter((value) => !value.code || !Object.hasOwn(input.classifications, value.code))
      .map((value) => value.code ? `"${value.code}"` : `"${value.name}" (missing code)`);
    if (unclassified.length > 0) {
      throw refusal(
        `The existing fund segment has unclassified values: ${unclassified.join(", ")}.`,
        "fund_values_unclassified",
        "Add a classification for every listed fund code in the provisioning request, then retry.",
        422,
        "classifications",
      );
    }

    const defaultClassification = validateClassification(
      input.defaultFund.code,
      classificationFor(input.classifications, input.defaultFund.code),
    );
    if (defaultClassification.kind !== "operating") {
      throw refusal(
        `Default fund "${input.defaultFund.code}" must have kind operating.`,
        "default_fund_kind_invalid",
        "Classify the default fund as operating in the provisioning request.",
        422,
        "classifications",
      );
    }

    const knownCodes = new Set([...existingCodes, input.defaultFund.code]);
    const unknownCodes = Object.keys(input.classifications).filter((code) => !knownCodes.has(code));
    if (unknownCodes.length > 0) {
      throw refusal(
        `The provisioning request classifies fund codes that are not present: ${unknownCodes.join(", ")}.`,
        "fund_classification_unknown_code",
        "Use codes already present in the fund segment or the configured default fund code.",
        422,
        "classifications",
      );
    }
    for (const value of existingValues) validateClassification(value.code!, classificationFor(input.classifications, value.code!));

    let defaultValue = existingValues.find((value) => value.code === input.defaultFund.code);
    if (!defaultValue) {
      // The unique segment-code index makes this retry-safe; on a concurrent
      // code collision the row is re-read and its identity is verified below.
      const inserted = await db.execute<{ id: string }>(sql`
        insert into segment_values
          (org_id, segment_id, code, name, is_active, created_by, updated_by)
        values (
          ${input.orgId}, ${segment.id}, ${input.defaultFund.code}, ${input.defaultFund.name},
          true, ${input.actorId ?? null}, ${input.actorId ?? null}
        )
        on conflict do nothing
        returning id
      `);
      if (inserted.rows[0]?.id) {
        defaultValue = {
          id: inserted.rows[0].id,
          code: input.defaultFund.code,
          name: input.defaultFund.name,
          isActive: true,
        };
      } else {
        const existing = await db.execute<SegmentValueRow>(sql`
          select id, code, name, is_active as "isActive"
            from segment_values
           where org_id = ${input.orgId} and segment_id = ${segment.id}
             and code is not null and lower(code) = lower(${input.defaultFund.code})
           for update
        `);
        defaultValue = existing.rows[0];
      }
    }
    if (!defaultValue || defaultValue.code !== input.defaultFund.code) {
      throw refusal(
        `Default fund code "${input.defaultFund.code}" could not be created or read back.`,
        "default_fund_write_missing",
        "Resolve the fund-code conflict and retry fund accounting setup.",
        409,
        "defaultFund.code",
      );
    }
    if (!defaultValue.isActive) {
      throw refusal(
        `Default fund "${input.defaultFund.code}" is inactive.`,
        "default_fund_inactive",
        "Activate the default fund before provisioning fund accounting.",
        409,
        "defaultFund.code",
      );
    }

    const values = [...existingValues.filter((value) => value.id !== defaultValue!.id), defaultValue];
    const existingFundsResult = await db.execute<FundRow>(sql`
      select id, kind, restriction_class as "restrictionClass",
             budgetary_control as "budgetaryControl"
        from funds where org_id = ${input.orgId}
       for update
    `);
    const existingFunds = new Map(existingFundsResult.rows.map((fund) => [fund.id, fund]));

    for (const value of values) {
      const classification = validateClassification(
        value.code!,
        classificationFor(input.classifications, value.code!),
      );
      const desired: FundRow = {
        id: value.id,
        kind: classification.kind,
        restrictionClass: classification.restrictionClass,
        budgetaryControl: classification.budgetaryControl ?? "off",
      };
      const existing = existingFunds.get(value.id);
      if (existing) {
        if (
          existing.kind !== desired.kind ||
          existing.restrictionClass !== desired.restrictionClass ||
          existing.budgetaryControl !== desired.budgetaryControl
        ) {
          throw refusal(
            `Fund "${value.code}" already has a different accounting classification.`,
            "fund_classification_conflict",
            "Keep its recorded classification, or create a successor fund and post the approved transfer.",
            409,
          );
        }
        continue;
      }

      // A concurrent idempotent provision may win this insert. Its row is
      // re-read below and must match the classification supplied here.
      const inserted = await db.execute<{ id: string }>(sql`
        insert into funds
          (id, org_id, kind, restriction_class, budgetary_control, created_by, updated_by)
        values (
          ${value.id}, ${input.orgId}, ${desired.kind}, ${desired.restrictionClass},
          ${desired.budgetaryControl}, ${input.actorId ?? null}, ${input.actorId ?? null}
        )
        on conflict (org_id, id) do nothing
        returning id
      `);
      if (inserted.rows.length === 1) continue;
      const observed = await db.execute<FundRow>(sql`
        select id, kind, restriction_class as "restrictionClass",
               budgetary_control as "budgetaryControl"
          from funds where org_id = ${input.orgId} and id = ${value.id}
      `);
      const row = observed.rows[0];
      if (
        !row || row.kind !== desired.kind || row.restrictionClass !== desired.restrictionClass ||
        row.budgetaryControl !== desired.budgetaryControl
      ) {
        throw refusal(
          `Fund "${value.code}" did not receive the requested accounting classification.`,
          "fund_classification_write_missing",
          "Resolve the fund classification conflict and retry setup.",
          409,
        );
      }
    }

    if (segment.defaultValueId && segment.defaultValueId !== defaultValue.id) {
      throw refusal(
        `The fund segment already defaults to "${existingValues.find((value) => value.id === segment.defaultValueId)?.code ?? "another value"}".`,
        "fund_default_conflict",
        "Use the recorded default fund or resolve the segment default before provisioning.",
        409,
      );
    }
    const segmentNeedsUpdate =
      !segment.isHierarchical || !segment.allowAccountRequirement || !segment.isBalancing ||
      segment.defaultValueId !== defaultValue.id || segment.featureKey !== "fundAccounting";
    if (segmentNeedsUpdate) {
      const updated = await db.execute<{ id: string }>(sql`
        update segment_definitions
           set is_hierarchical = true,
               allow_account_requirement = true,
               is_balancing = true,
               default_value_id = ${defaultValue.id},
               feature_key = 'fundAccounting',
               updated_at = now(),
               updated_by = ${input.actorId ?? null}
         where org_id = ${input.orgId} and id = ${segment.id}
        returning id
      `);
      if (updated.rows.length !== 1 || updated.rows[0]?.id !== segment.id) {
        throw refusal(
          "The fund segment settings were not saved.",
          "fund_segment_update_missing",
          "Retry fund accounting setup after checking the segment configuration.",
          409,
        );
      }
    }

    const imbalanceRows = await db.execute<HistoricalFundImbalance>(sql`
      with unbalanced as (
        select e.id as entry_id, l.extra_dims->>'fund' as fund_id
          from journal_entries e
          join journal_lines l on l.org_id = e.org_id and l.entry_id = e.id
         where e.org_id = ${input.orgId} and e.status is distinct from 'draft'
         group by e.id, l.extra_dims->>'fund'
        having sum(l.amount) <> 0
      )
      select f.id as "fundId", sv.code, sv.name,
             count(u.entry_id)::int as "unbalancedEntries"
        from funds f
        join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
        left join unbalanced u on u.fund_id = f.id::text
       where f.org_id = ${input.orgId}
       group by f.id, sv.code, sv.name
       order by sv.code, f.id
    `);
    const totalImbalances = await db.execute<{ count: number; unassigned: number }>(sql`
      with unbalanced as (
        select e.id as entry_id, l.extra_dims->>'fund' as fund_id
          from journal_entries e
          join journal_lines l on l.org_id = e.org_id and l.entry_id = e.id
         where e.org_id = ${input.orgId} and e.status is distinct from 'draft'
         group by e.id, l.extra_dims->>'fund'
        having sum(l.amount) <> 0
      )
      select count(distinct entry_id)::int as count,
             count(distinct entry_id) filter (where fund_id is null)::int as unassigned
        from unbalanced
    `);

    return {
      segmentId: segment.id,
      defaultFundId: defaultValue.id,
      historicalUnbalancedEntryCount: totalImbalances.rows[0]?.count ?? 0,
      unassignedUnbalancedEntryCount: totalImbalances.rows[0]?.unassigned ?? 0,
      historicalUnbalancedByFund: imbalanceRows.rows,
    };
  });
}
