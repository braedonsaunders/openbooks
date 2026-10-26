import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import { add, cmp } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { assertAssetAccess } from "./asset-access.ts";
import { notifyAssetOperators, orgsWithAssetFeature } from "./asset-alerts.ts";
import { refuse } from "./asset-refusal.ts";
import {
  assertCoveragePeriod,
  insuredValueStanding,
  reachedRenewalLeads,
  type InsuranceStanding,
} from "./insurance-math.ts";

/**
 * Asset insurance: policies with an insurer, policy number, coverage period,
 * premium and deductible, each covering one or more assets of one legal
 * entity at a stated insured (and optional replacement) value. Nothing here
 * posts; premiums are paid and amortized through the native bill and
 * prepaid paths. Renewal alerts notify maintainers ahead of expiry.
 */

export interface InsurancePolicyInput {
  subsidiaryId: string;
  insurerPartyId: string;
  policyNumber: string;
  description?: string | null;
  coverageStartsOn: string;
  coverageEndsOn: string;
  premium?: string | null;
  deductible?: string | null;
  renewalLeadDays?: number | null;
}

function exactNonNegative(value: string | null | undefined, label: string): string {
  const parsed = canonicalDecimal(
    value === null || value === undefined || value === "" ? "0" : value,
    4,
  );
  if (parsed === null || cmp(parsed, "0") < 0)
    refuse("amount_invalid", `${label} must be a non-negative exact amount`);
  return parsed;
}

function normalizePolicy(input: InsurancePolicyInput) {
  const policyNumber = input.policyNumber.trim();
  if (!policyNumber) refuse("policy_number_required", "enter the policy number");
  if (policyNumber.length > 120)
    refuse("policy_number_invalid", "policy numbers are limited to 120 characters");
  for (const [label, value] of [
    ["coverage start", input.coverageStartsOn],
    ["coverage end", input.coverageEndsOn],
  ] as const) {
    if (!isIsoCalendarDate(value))
      refuse("date_invalid", `the ${label} must be a calendar date (YYYY-MM-DD)`);
  }
  assertCoveragePeriod(input.coverageStartsOn, input.coverageEndsOn);
  const renewalLeadDays = input.renewalLeadDays ?? 30;
  if (!Number.isInteger(renewalLeadDays) || renewalLeadDays < 0 || renewalLeadDays > 365) {
    refuse("lead_days_invalid", "renewal lead days must be a whole number from 0 to 365");
  }
  return {
    policyNumber,
    description: input.description?.trim() || null,
    coverageStartsOn: input.coverageStartsOn,
    coverageEndsOn: input.coverageEndsOn,
    premium: exactNonNegative(input.premium, "the premium"),
    deductible: exactNonNegative(input.deductible, "the deductible"),
    renewalLeadDays,
  };
}

async function assertInsurer(tx: SqlExecutor, orgId: string, partyId: string): Promise<void> {
  const party = (
    await tx.execute(
      sql`select 1 from parties where org_id = ${orgId} and id = ${partyId}`,
      "objects",
    )
  )[0];
  if (!party) refuse("insurer_invalid", "the insurer does not exist in this organization");
}

async function lockPolicy(
  tx: SqlExecutor,
  orgId: string,
  policyId: string,
  allowed: readonly string[] | null | undefined,
): Promise<
  Record<string, unknown> & {
    id: string;
    subsidiary_id: string;
    status: string;
    policy_number: string;
    updated_at: string;
  }
> {
  const row = (
    await tx.execute<
      Record<string, unknown> & {
        id: string;
        subsidiary_id: string;
        status: string;
        policy_number: string;
        updated_at: string;
      }
    >(
      sql`
    select *, updated_at::text as updated_at, coverage_starts_on::text as coverage_starts_on,
           coverage_ends_on::text as coverage_ends_on from asset_insurance_policies
     where org_id = ${orgId} and id = ${policyId}
       ${allowed ? sql`and subsidiary_id = any(${uuidArray([...allowed])}::uuid[])` : sql``}
     for update`,
      "objects",
    )
  )[0];
  if (!row) refuse("policy_not_found", "insurance policy not found", { status: 404 });
  return row;
}

function duplicatePolicy(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`
      : String(error);
  return text.includes("asset_insurance_policies_identity");
}

export async function createInsurancePolicy(
  orgId: string,
  input: InsurancePolicyInput & { renewsPolicyId?: string | null },
  options: { actorId: string; allowedSubsidiaryIds?: readonly string[] | null },
): Promise<{ id: string }> {
  const policy = normalizePolicy(input);
  if (options.allowedSubsidiaryIds && !options.allowedSubsidiaryIds.includes(input.subsidiaryId)) {
    refuse("subsidiary_scope", "this legal entity is outside your authorization", { status: 404 });
  }
  try {
    return await withOrgTransaction(orgId, async () => {
      const tx: SqlExecutor = db;
      await assertAssetAccess(tx, {
        orgId,
        actorId: options.actorId,
        permission: "assets.maintain",
        feature: "assetInsurance",
        subsidiaryIds: [input.subsidiaryId],
      });
      const subsidiary = (
        await tx.execute<{ base_currency: string }>(
          sql`
        select base_currency from subsidiaries where org_id = ${orgId} and id = ${input.subsidiaryId} and is_active and not is_elimination`,
          "objects",
        )
      )[0];
      if (!subsidiary) refuse("subsidiary_invalid", "choose an active legal entity");
      await assertInsurer(tx, orgId, input.insurerPartyId);
      const row = (
        await tx.execute<{ id: string }>(
          sql`
        insert into asset_insurance_policies
          (org_id, subsidiary_id, insurer_party_id, policy_number, description, coverage_starts_on, coverage_ends_on,
           premium, deductible, currency, renewal_lead_days, renews_policy_id, created_by, updated_by)
        values
          (${orgId}, ${input.subsidiaryId}, ${input.insurerPartyId}, ${policy.policyNumber}, ${policy.description},
           ${policy.coverageStartsOn}, ${policy.coverageEndsOn}, ${policy.premium}, ${policy.deductible},
           ${subsidiary.base_currency}, ${policy.renewalLeadDays}, ${input.renewsPolicyId ?? null}, ${options.actorId}, ${options.actorId})
        returning id`,
          "objects",
        )
      )[0];
      if (!row) throw new Error("the insurance policy was not stored");
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'asset_insurance_policies', ${row.id}, 'insert',
                ${JSON.stringify({ before: null, after: { ...policy, subsidiaryId: input.subsidiaryId, insurerPartyId: input.insurerPartyId } })}::jsonb, ${options.actorId})`);
      return { id: row.id };
    });
  } catch (error) {
    if (duplicatePolicy(error)) {
      refuse(
        "policy_duplicate",
        "this insurer already has a policy with that number starting on that date",
        { status: 409 },
      );
    }
    throw error;
  }
}

/** Change a policy's terms or cancel it, under optimistic concurrency. */
export async function updateInsurancePolicy(
  orgId: string,
  policyId: string,
  input: Omit<InsurancePolicyInput, "subsidiaryId"> & {
    status: "active" | "cancelled";
    expectedUpdatedAt: string;
  },
  options: { actorId: string; allowedSubsidiaryIds?: readonly string[] | null },
): Promise<{ id: string }> {
  const policy = normalizePolicy({ ...input, subsidiaryId: "" });
  if (input.status !== "active" && input.status !== "cancelled")
    refuse("status_invalid", "a policy is active or cancelled");
  try {
    return await withOrgTransaction(orgId, async () => {
      const tx: SqlExecutor = db;
      const before = await lockPolicy(tx, orgId, policyId, options.allowedSubsidiaryIds);
      await assertAssetAccess(tx, {
        orgId,
        actorId: options.actorId,
        permission: "assets.maintain",
        feature: "assetInsurance",
        subsidiaryIds: [before.subsidiary_id],
      });
      if (before.updated_at !== input.expectedUpdatedAt)
        refuse("stale_revision", "the policy changed since you opened it", {
          status: 409,
          remedy: "Reload the policy and apply your change again.",
        });
      await assertInsurer(tx, orgId, input.insurerPartyId);
      const after = (
        await tx.execute<Record<string, unknown>>(
          sql`
        update asset_insurance_policies
           set insurer_party_id = ${input.insurerPartyId}, policy_number = ${policy.policyNumber}, description = ${policy.description},
               coverage_starts_on = ${policy.coverageStartsOn}, coverage_ends_on = ${policy.coverageEndsOn},
               premium = ${policy.premium}, deductible = ${policy.deductible}, renewal_lead_days = ${policy.renewalLeadDays},
               status = ${input.status}, updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
               updated_by = ${options.actorId}
         where org_id = ${orgId} and id = ${policyId}
         returning *, updated_at::text as updated_at, coverage_starts_on::text as coverage_starts_on,
                   coverage_ends_on::text as coverage_ends_on`,
          "objects",
        )
      )[0];
      if (!after) throw new Error("the insurance policy was not updated; no row changed");
      if (
        before.coverage_ends_on !== after.coverage_ends_on ||
        before.renewal_lead_days !== after.renewal_lead_days
      ) {
        // A new expiry or lead time is a new renewal ladder.
        await tx.execute(
          sql`delete from asset_insurance_alerts where org_id = ${orgId} and policy_id = ${policyId}`,
        );
      }
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'asset_insurance_policies', ${policyId}, 'update', ${JSON.stringify({ before, after })}::jsonb, ${options.actorId})`);
      return { id: policyId };
    });
  } catch (error) {
    if (duplicatePolicy(error)) {
      refuse(
        "policy_duplicate",
        "this insurer already has a policy with that number starting on that date",
        { status: 409 },
      );
    }
    throw error;
  }
}

/**
 * Renew a policy into a new coverage period: a new policy that names the one
 * it renews and covers the same assets at the same values. The expiring
 * policy keeps its record; its renewal alerts stop once the renewal exists.
 */
export async function renewInsurancePolicy(
  orgId: string,
  args: {
    policyId: string;
    policyNumber?: string | null;
    coverageStartsOn: string;
    coverageEndsOn: string;
    premium?: string | null;
    deductible?: string | null;
    actorId: string;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<{ id: string }> {
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const source = await lockPolicy(tx, orgId, args.policyId, args.allowedSubsidiaryIds);
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.maintain",
      feature: "assetInsurance",
      subsidiaryIds: [source.subsidiary_id],
    });
    const existing = (
      await tx.execute(
        sql`
      select 1 from asset_insurance_policies where org_id = ${orgId} and renews_policy_id = ${args.policyId} and status = 'active' limit 1`,
        "objects",
      )
    )[0];
    if (existing)
      refuse(
        "policy_already_renewed",
        `policy ${source.policy_number} already has an active renewal`,
        { status: 409 },
      );
    const created = await createInsurancePolicy(
      orgId,
      {
        subsidiaryId: source.subsidiary_id,
        insurerPartyId: String(source.insurer_party_id),
        policyNumber: args.policyNumber?.trim() || source.policy_number,
        description: (source.description as string | null) ?? null,
        coverageStartsOn: args.coverageStartsOn,
        coverageEndsOn: args.coverageEndsOn,
        premium: args.premium ?? String(source.premium),
        deductible: args.deductible ?? String(source.deductible),
        renewalLeadDays: Number(source.renewal_lead_days),
        renewsPolicyId: source.id,
      },
      { actorId: args.actorId, allowedSubsidiaryIds: args.allowedSubsidiaryIds },
    );
    await tx.execute(sql`
      insert into asset_insurance_coverages (org_id, policy_id, asset_id, insured_value, replacement_value, created_by, updated_by)
      select org_id, ${created.id}, asset_id, insured_value, replacement_value, ${args.actorId}, ${args.actorId}
        from asset_insurance_coverages c
       where c.org_id = ${orgId} and c.policy_id = ${source.id}
         and exists (select 1 from fixed_assets a where a.org_id = c.org_id and a.id = c.asset_id and a.status not in ('disposed', 'written_off'))`);
    return created;
  });
}

/** Add an asset to a policy, or change its insured and replacement values. */
export async function setInsuranceCoverage(
  orgId: string,
  args: {
    policyId: string;
    assetId: string;
    insuredValue: string;
    replacementValue?: string | null;
    actorId: string;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<{ id: string }> {
  const insuredValue = exactNonNegative(args.insuredValue, "the insured value");
  const replacementValue =
    args.replacementValue === null ||
    args.replacementValue === undefined ||
    args.replacementValue === ""
      ? null
      : exactNonNegative(args.replacementValue, "the replacement value");
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const policy = await lockPolicy(tx, orgId, args.policyId, args.allowedSubsidiaryIds);
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.maintain",
      feature: "assetInsurance",
      subsidiaryIds: [policy.subsidiary_id],
    });
    if (policy.status !== "active")
      refuse("policy_cancelled", `policy ${policy.policy_number} is cancelled`);
    const asset = (
      await tx.execute<{ asset_number: string; subsidiary_id: string; status: string }>(
        sql`
      select asset_number, subsidiary_id, status from fixed_assets where org_id = ${orgId} and id = ${args.assetId} for share`,
        "objects",
      )
    )[0];
    if (!asset) refuse("asset_not_found", "asset not found", { status: 404 });
    if (asset.subsidiary_id !== policy.subsidiary_id) {
      refuse(
        "coverage_cross_subsidiary",
        `asset ${asset.asset_number} belongs to a different legal entity than the policy`,
      );
    }
    if (asset.status === "disposed" || asset.status === "written_off")
      refuse("asset_not_live", `asset ${asset.asset_number} is ${asset.status}`);
    const before =
      (
        await tx.execute<Record<string, unknown>>(
          sql`
      select * from asset_insurance_coverages where org_id = ${orgId} and policy_id = ${args.policyId} and asset_id = ${args.assetId} for update`,
          "objects",
        )
      )[0] ?? null;
    const row = before
      ? (
          await tx.execute<{ id: string }>(
            sql`
          update asset_insurance_coverages
             set insured_value = ${insuredValue}, replacement_value = ${replacementValue},
                 updated_at = clock_timestamp(), updated_by = ${args.actorId}
           where org_id = ${orgId} and id = ${String(before.id)}
           returning id`,
            "objects",
          )
        )[0]
      : (
          await tx.execute<{ id: string }>(
            sql`
          insert into asset_insurance_coverages (org_id, policy_id, asset_id, insured_value, replacement_value, created_by, updated_by)
          values (${orgId}, ${args.policyId}, ${args.assetId}, ${insuredValue}, ${replacementValue}, ${args.actorId}, ${args.actorId})
          returning id`,
            "objects",
          )
        )[0];
    if (!row) throw new Error("the coverage was not stored; no row changed");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'asset_insurance_coverages', ${row.id}, ${before ? "update" : "insert"},
              ${JSON.stringify({ before, after: { policyId: args.policyId, assetId: args.assetId, insuredValue, replacementValue } })}::jsonb, ${args.actorId})`);
    return { id: row.id };
  });
}

export async function removeInsuranceCoverage(
  orgId: string,
  args: {
    policyId: string;
    assetId: string;
    reason: string;
    actorId: string;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<void> {
  const reason = args.reason.trim();
  if (!reason) refuse("reason_required", "state why the asset leaves the policy");
  await withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const policy = await lockPolicy(tx, orgId, args.policyId, args.allowedSubsidiaryIds);
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.maintain",
      feature: "assetInsurance",
      subsidiaryIds: [policy.subsidiary_id],
    });
    const removed = (
      await tx.execute<Record<string, unknown>>(
        sql`
      delete from asset_insurance_coverages where org_id = ${orgId} and policy_id = ${args.policyId} and asset_id = ${args.assetId}
      returning *`,
        "objects",
      )
    )[0];
    if (!removed) refuse("coverage_not_found", "the asset is not on this policy", { status: 404 });
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'asset_insurance_coverages', ${String(removed.id)}, 'delete',
              ${JSON.stringify({ before: removed, after: null, reason })}::jsonb, ${args.actorId})`);
  });
}

export interface InsuredValueRow {
  policyId: string;
  policyNumber: string;
  currency: string;
  assetId: string;
  assetNumber: string;
  assetName: string;
  insuredValue: string;
  replacementValue: string | null;
  netBookValue: string;
  gap: string;
  standing: InsuranceStanding;
}

/** Insured value against primary-book net book value for every covered live asset. */
export async function insuredValueComparison(
  orgId: string,
  args: { allowedSubsidiaryIds?: readonly string[] | null; policyId?: string | null; asOf: string },
): Promise<InsuredValueRow[]> {
  const rows = await db.execute<{
    policy_id: string;
    policy_number: string;
    currency: string;
    asset_id: string;
    asset_number: string;
    asset_name: string;
    insured_value: string;
    replacement_value: string | null;
    carrying_value: string | null;
  }>(
    sql`
    select p.id as policy_id, p.policy_number, p.currency, a.id as asset_id, a.asset_number, a.name as asset_name,
           c.insured_value::text as insured_value, c.replacement_value::text as replacement_value,
           v.carrying_value::text as carrying_value
      from asset_insurance_coverages c
      join asset_insurance_policies p on p.org_id = c.org_id and p.id = c.policy_id
      join fixed_assets a on a.org_id = c.org_id and a.id = c.asset_id
      left join accounting_books b on b.org_id = c.org_id and b.is_primary and b.is_active and b.posts_gl
      left join asset_book_carrying_values v on v.org_id = c.org_id and v.asset_id = a.id and v.book_id = b.id
     where c.org_id = ${orgId} and p.status = 'active'
       and p.coverage_starts_on <= ${args.asOf} and p.coverage_ends_on >= ${args.asOf}
       ${args.policyId ? sql`and p.id = ${args.policyId}` : sql``}
       ${args.allowedSubsidiaryIds ? sql`and p.subsidiary_id = any(${uuidArray([...args.allowedSubsidiaryIds])}::uuid[])` : sql``}
     order by p.policy_number, a.asset_number`,
    "objects",
  );
  return rows.map((row) => {
    const nbv = add(row.carrying_value ?? "0", "0");
    const comparison = insuredValueStanding(row.insured_value, nbv);
    return {
      policyId: row.policy_id,
      policyNumber: row.policy_number,
      currency: row.currency,
      assetId: row.asset_id,
      assetNumber: row.asset_number,
      assetName: row.asset_name,
      insuredValue: add(row.insured_value, "0"),
      replacementValue: row.replacement_value === null ? null : add(row.replacement_value, "0"),
      netBookValue: nbv,
      gap: comparison.gap,
      standing: comparison.standing,
    };
  });
}

/**
 * Daily renewal scan: each active, unrenewed policy notifies once per rung
 * of its renewal ladder (its lead time, one week, expiry day). A missed run
 * catches up and sends only the most urgent reached rung.
 */
export async function runInsuranceRenewalScan(
  _now: Date,
): Promise<{ orgId: string; notified: number }[]> {
  const results: { orgId: string; notified: number }[] = [];
  for (const orgId of await orgsWithAssetFeature("assetInsurance")) {
    const notified = await withOrgTransaction(orgId, async () => {
      const tx: SqlExecutor = db;
      if (!(await lockAndCheckOrgFeature(tx, orgId, "assetInsurance"))) return 0;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"asset-insurance-alerts:" + orgId}, 0))`,
      );
      const today = await businessToday(orgId);
      const policies = await tx.execute<{
        id: string;
        subsidiary_id: string;
        policy_number: string;
        coverage_ends_on: string;
        renewal_lead_days: number;
        insurer: string | null;
      }>(
        sql`
        select p.id, p.subsidiary_id, p.policy_number, p.coverage_ends_on::text as coverage_ends_on, p.renewal_lead_days,
               party.display_name as insurer
          from asset_insurance_policies p
          left join parties party on party.org_id = p.org_id and party.id = p.insurer_party_id
         where p.org_id = ${orgId} and p.status = 'active' and p.coverage_ends_on >= ${today}::date - 1
           and not exists (select 1 from asset_insurance_policies r
                            where r.org_id = p.org_id and r.renews_policy_id = p.id and r.status = 'active')
         order by p.coverage_ends_on, p.id`,
        "objects",
      );
      let count = 0;
      for (const policy of policies) {
        const reached = reachedRenewalLeads(
          today,
          policy.coverage_ends_on,
          policy.renewal_lead_days,
        );
        if (reached.length === 0) continue;
        let fresh = false;
        for (const lead of reached) {
          const inserted = (
            await tx.execute<{ id: string }>(
              sql`
            insert into asset_insurance_alerts (org_id, policy_id, lead_days) values (${orgId}, ${policy.id}, ${lead})
            -- Each rung notifies once; a repeat scan finds the row and stays quiet.
            on conflict (org_id, policy_id, lead_days) do nothing
            returning id`,
              "objects",
            )
          )[0];
          if (inserted) fresh = true;
        }
        if (!fresh) continue;
        count += await notifyAssetOperators(tx, {
          orgId,
          subsidiaryId: policy.subsidiary_id,
          permission: "assets.maintain",
          kind: "asset_insurance_renewal",
          title: `Policy ${policy.policy_number} expires ${policy.coverage_ends_on}`,
          body: `${policy.insurer ?? "Insurer"} policy ${policy.policy_number} ends ${policy.coverage_ends_on}. Renew it or record its replacement.`,
          href: `/assets/insurance?policy=${policy.id}`,
        });
      }
      return count;
    });
    results.push({ orgId, notified });
  }
  return results;
}
