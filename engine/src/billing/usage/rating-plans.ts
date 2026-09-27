import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  USAGE_BAND_KINDS,
  USAGE_COMMIT_PERIODS,
  USAGE_PACKAGE_ROUNDINGS,
  type subscriptionUsageLinks,
  type usageRatingBands,
  type usageRatingPlanVersions,
  type usageRatingPlans,
} from "@openbooks/schema";
import { cmp } from "../../money/money.ts";
import { parseMoney, parseQuantity } from "../../money/brands.ts";
import { compareDecimal } from "../../money/exact-decimal.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../../organization/org-feature-lock.ts";
import { db, withOrg } from "../../platform/db.ts";
import { UsageBillingError } from "./errors.ts";

export type UsageRatingPlan = typeof usageRatingPlans.$inferSelect;
export type UsageRatingPlanVersion = typeof usageRatingPlanVersions.$inferSelect;
export type UsageRatingBand = typeof usageRatingBands.$inferSelect;
export type SubscriptionUsageLink = typeof subscriptionUsageLinks.$inferSelect;
export type UsageBandKind = (typeof USAGE_BAND_KINDS)[number];
export type UsagePackageRounding = (typeof USAGE_PACKAGE_ROUNDINGS)[number];
export type UsageCommitPeriod = (typeof USAGE_COMMIT_PERIODS)[number];

const FEATURE_REMEDY = "Enable Usage Billing in Company Settings → Features.";
const PLAN_VERSION_REMEDY = "Publish a new version. Subscription links pin published versions and preserve historical pricing.";

export interface CreateUsageRatingPlanInput {
  name: string;
  currency: string;
}

export interface CreateUsageRatingPlanVersionInput {
  planId: string;
  effectiveFrom: string;
}

export interface UsageRatingBandInput {
  meterId: string;
  kind: UsageBandKind;
  seq: number;
  upToQty: unknown | null;
  unitPrice: unknown;
  flatAmount?: unknown;
  includedQty?: unknown;
  packageSize?: unknown | null;
  packageRounding?: UsagePackageRounding | null;
}

export interface CreateSubscriptionUsageLinkInput {
  subscriptionId: string;
  customerId: string;
  planVersionId: string;
  meterIds: readonly string[];
  effectiveFrom: string;
  effectiveTo?: string | null;
  commitAmount?: unknown | null;
  commitPeriod?: UsageCommitPeriod | null;
  allowOverage?: boolean;
}

const PLAN_COLUMNS = sql`
  id, org_id as "orgId", name, currency_code as currency, status,
  created_at as "createdAt", created_by as "createdBy",
  updated_at as "updatedAt", updated_by as "updatedBy"`;

const VERSION_COLUMNS = sql`
  id, org_id as "orgId", plan_id as "planId", version_no as "versionNo", status,
  effective_from::text as "effectiveFrom", spec_hash as "specHash",
  created_at as "createdAt", created_by as "createdBy",
  updated_at as "updatedAt", updated_by as "updatedBy"`;

const BAND_COLUMNS = sql`
  id, org_id as "orgId", plan_version_id as "planVersionId", meter_id as "meterId",
  kind, seq, up_to_qty::text as "upToQty", unit_price::text as "unitPrice",
  flat_amount::text as "flatAmount", included_qty::text as "includedQty",
  package_size::text as "packageSize", package_rounding as "packageRounding",
  created_at as "createdAt", created_by as "createdBy",
  updated_at as "updatedAt", updated_by as "updatedBy"`;

const LINK_COLUMNS = sql`
  id, org_id as "orgId", subscription_id as "subscriptionId", customer_id as "customerId",
  plan_version_id as "planVersionId", meter_ids as "meterIds",
  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
  commit_amount::text as "commitAmount", commit_period as "commitPeriod",
  allow_overage as "allowOverage", created_at as "createdAt", created_by as "createdBy",
  updated_at as "updatedAt", updated_by as "updatedBy"`;

function refuse(
  code: string,
  message: string,
  remedy: string,
  field: string | null = null,
  status: 422 | 409 = 422,
): never {
  throw new UsageBillingError(code, message, remedy, { field, status });
}

function featureOff(): never {
  return refuse("feature_off", "Usage billing is turned off for this organization.", FEATURE_REMEDY);
}

async function lockAndRequireUsageBilling(orgId: string): Promise<void> {
  await acquireOrgFeatureGateLock(db, orgId);
  if (!(await lockAndCheckOrgFeature(db, orgId, "usageBilling"))) featureOff();
}

async function requireUsageBillingRead(orgId: string): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, "usageBilling"))) featureOff();
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    refuse("usage_plan_input_required", `${field} is required.`, `Provide a non-empty ${field}.`, field);
  }
  return value.trim();
}

function uuidText(value: unknown, field: string): string {
  const candidate = requiredText(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) {
    refuse("usage_plan_uuid_invalid", `${field} must be a UUID.`, `Provide a valid ${field} from this organization.`, field);
  }
  return candidate;
}

function dateText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    refuse("usage_plan_date_invalid", `${field} must be a real calendar date in YYYY-MM-DD form.`, `Provide a valid ${field} in YYYY-MM-DD form.`, field);
  }
  return value;
}

function quantityText(value: unknown, field: string): string {
  let quantity: string;
  try {
    quantity = parseQuantity(value);
  } catch {
    if (field.endsWith("unit_price")) {
      refuse(
        "usage_band_price_precision_invalid",
        "A usage band unit price cannot have more than 8 decimal places.",
        "Round the unit price to 8 decimal places, the precision supported by invoice lines.",
        field,
      );
    }
    refuse("usage_band_quantity_invalid", `${field} must be an exact decimal with no more than 8 decimal places.`, `Provide a non-negative ${field} with no more than 8 decimal places.`, field);
  }
  const wholeDigits = quantity.split(".", 1)[0]!.replace(/^0+/, "");
  if (wholeDigits.length > 20) {
    refuse("usage_band_quantity_invalid", `${field} exceeds the supported numeric(28,8) range.`, `Provide a ${field} that fits numeric(28,8).`, field);
  }
  if (compareDecimal(quantity, "0") < 0) {
    refuse("usage_band_quantity_invalid", `${field} cannot be negative.`, `Provide a non-negative ${field}.`, field);
  }
  return quantity;
}

function moneyText(value: unknown, field: string): string {
  let money: string;
  try {
    money = parseMoney(value);
  } catch {
    refuse("usage_plan_money_invalid", `${field} must be an exact money amount with no more than 4 decimal places.`, `Provide ${field} as a decimal string with no more than 4 decimal places.`, field);
  }
  if (money.split(".", 1)[0]!.replace(/^0+/, "").length > 15) {
    refuse("usage_plan_money_out_of_range", `${field} exceeds the supported numeric(19,4) range.`, `Provide ${field} with no more than 15 whole digits.`, field);
  }
  return money;
}

function uniqueViolationFor(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === constraint;
}

export function assertUsagePlanVersionMutable(status: string): void {
  if (status !== "draft") {
    refuse(
      "usage_plan_version_immutable",
      "Published usage rating plan versions are immutable.",
      PLAN_VERSION_REMEDY,
      "plan_version_id",
      409,
    );
  }
}

export async function createUsageRatingPlan(
  orgId: string,
  actor: string,
  input: CreateUsageRatingPlanInput,
): Promise<UsageRatingPlan> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const name = requiredText(input.name, "name");
    const currency = requiredText(input.currency, "currency");
    if (!/^[A-Z]{3}$/.test(currency)) {
      refuse("usage_plan_currency_invalid", "The rating plan currency must be an uppercase ISO currency code.", "Choose a supported uppercase currency code for this plan.", "currency");
    }
    const currencyExists = (await db.execute<{ code: string }>(sql`
      select code from currencies where code = ${currency}`)).rows[0];
    if (!currencyExists) {
      refuse("usage_plan_currency_invalid", `Currency ${currency} is not configured in the ISO currency registry.`, "Choose a supported currency code from the organization currency registry.", "currency");
    }
    try {
      const inserted = await db.execute<UsageRatingPlan>(sql`
        insert into usage_rating_plans (org_id, name, currency_code, status, created_by, updated_by)
        values (${orgId}, ${name}, ${currency}, 'active', ${actor}, ${actor})
        returning ${PLAN_COLUMNS}`);
      if (inserted.rows.length !== 1) throw new Error("usage rating plan insert returned an unexpected row count");
      return inserted.rows[0]!;
    } catch (error) {
      if (uniqueViolationFor(error, "usage_rating_plans_org_name_unique")) {
        refuse("usage_plan_name_in_use", `A usage rating plan named ${name} already exists in this organization.`, "Choose a different rating plan name.", "name", 409);
      }
      throw error;
    }
  });
}

export async function retireUsageRatingPlan(orgId: string, actor: string, planId: string): Promise<UsageRatingPlan> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const safePlanId = uuidText(planId, "plan_id");
    const updated = await db.execute<UsageRatingPlan>(sql`
      update usage_rating_plans
         set status = 'retired', updated_at = now(), updated_by = ${actor}
       where org_id = ${orgId} and id = ${safePlanId} and status = 'active'
      returning ${PLAN_COLUMNS}`);
    if (updated.rows.length !== 1) {
      const existing = (await db.execute<{ status: string }>(sql`
        select status from usage_rating_plans where org_id = ${orgId} and id = ${safePlanId}`)).rows[0];
      if (!existing) refuse("usage_plan_not_found", "The usage rating plan does not exist in this organization.", "Choose a rating plan from this organization.", "plan_id");
      refuse("usage_plan_already_retired", "The usage rating plan is already retired.", "Choose an active rating plan when opening new subscription links.", "plan_id", 409);
    }
    return updated.rows[0]!;
  });
}

export async function createUsageRatingPlanVersion(
  orgId: string,
  actor: string,
  input: CreateUsageRatingPlanVersionInput,
): Promise<UsageRatingPlanVersion> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const planId = uuidText(input.planId, "plan_id");
    const effectiveFrom = dateText(input.effectiveFrom, "effective_from");
    const plan = (await db.execute<{ status: string }>(sql`
      select status from usage_rating_plans where org_id = ${orgId} and id = ${planId} for update`)).rows[0];
    if (!plan) refuse("usage_plan_not_found", "The usage rating plan does not exist in this organization.", "Choose a rating plan from this organization.", "plan_id");
    if (plan.status !== "active") {
      refuse("usage_plan_retired", "A retired usage rating plan cannot receive a new version.", "Create a new active rating plan before defining future prices.", "plan_id", 409);
    }
    const latest = (await db.execute<{ versionNo: number | null }>(sql`
      select max(version_no)::int as "versionNo"
        from usage_rating_plan_versions where org_id = ${orgId} and plan_id = ${planId}`)).rows[0];
    const versionNo = (latest?.versionNo ?? 0) + 1;
    const inserted = await db.execute<UsageRatingPlanVersion>(sql`
      insert into usage_rating_plan_versions
        (org_id, plan_id, version_no, status, effective_from, created_by, updated_by)
      values (${orgId}, ${planId}, ${versionNo}, 'draft', ${effectiveFrom}, ${actor}, ${actor})
      returning ${VERSION_COLUMNS}`);
    if (inserted.rows.length !== 1) throw new Error("usage rating plan version insert returned an unexpected row count");
    return inserted.rows[0]!;
  });
}

interface PreparedBand {
  meterId: string;
  kind: UsageBandKind;
  seq: number;
  upToQty: string | null;
  unitPrice: string;
  flatAmount: string;
  includedQty: string;
  packageSize: string | null;
  packageRounding: UsagePackageRounding | null;
}

function prepareBand(input: UsageRatingBandInput, index: number): PreparedBand {
  const meterId = uuidText(input.meterId, `bands[${index}].meter_id`);
  if (!USAGE_BAND_KINDS.includes(input.kind)) {
    refuse("usage_band_kind_invalid", `Band seq ${input.seq} has an unsupported rating kind.`, "Choose a supported usage band kind.", "kind");
  }
  if (!Number.isSafeInteger(input.seq) || input.seq < 1) {
    refuse("usage_band_sequence_invalid", `Band seq ${String(input.seq)} must be a positive integer.`, "Use consecutive band seq values starting at 1.", "seq");
  }
  const upToQty = input.upToQty === null ? null : quantityText(input.upToQty, `bands[${index}].up_to_qty`);
  const unitPrice = quantityText(input.unitPrice, `bands[${index}].unit_price`);
  const flatAmount = moneyText(input.flatAmount ?? "0", `bands[${index}].flat_amount`);
  const includedQty = quantityText(input.includedQty ?? "0", `bands[${index}].included_qty`);
  const packageSize = input.packageSize == null ? null : quantityText(input.packageSize, `bands[${index}].package_size`);
  const packageRounding = input.packageRounding ?? null;
  if (input.kind === "package") {
    if (packageSize === null || compareDecimal(packageSize, "0") <= 0 || !packageRounding || !USAGE_PACKAGE_ROUNDINGS.includes(packageRounding)) {
      refuse("usage_band_package_shape_invalid", `Package band seq ${input.seq} requires a positive package size and package rounding mode.`, "Set both package_size and package_rounding to up or down for this package band.", "package_size");
    }
  } else if (packageSize !== null || packageRounding !== null) {
    refuse("usage_band_package_shape_invalid", `Non-package band seq ${input.seq} cannot carry package terms.`, "Clear package_size and package_rounding, or change the band kind to package.", "kind");
  }
  return { meterId, kind: input.kind, seq: input.seq, upToQty, unitPrice, flatAmount, includedQty, packageSize, packageRounding };
}

export async function replaceUsageRatingBands(
  orgId: string,
  actor: string,
  versionId: string,
  bands: readonly UsageRatingBandInput[],
): Promise<UsageRatingBand[]> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const safeVersionId = uuidText(versionId, "plan_version_id");
    const version = (await db.execute<{ status: string }>(sql`
      select status from usage_rating_plan_versions
       where org_id = ${orgId} and id = ${safeVersionId} for update`)).rows[0];
    if (!version) refuse("usage_plan_version_not_found", "The usage rating plan version does not exist in this organization.", "Choose a plan version from this organization.", "plan_version_id");
    assertUsagePlanVersionMutable(version.status);

    const prepared = bands.map(prepareBand);
    const identityKeys = new Set<string>();
    for (const band of prepared) {
      const key = `${band.meterId}:${band.seq}`;
      if (identityKeys.has(key)) {
        refuse("usage_band_sequence_duplicate", `Meter ${band.meterId} has more than one band with seq ${band.seq}.`, "Give each band for this meter a unique consecutive seq value.", "seq", 409);
      }
      identityKeys.add(key);
    }
    const meterIds = [...new Set(prepared.map((band) => band.meterId))];
    if (meterIds.length > 0) {
      const meterRows = (await db.execute<{ id: string }>(sql`
        select id from usage_meters where org_id = ${orgId}
          and id in (${sql.join(meterIds.map((id) => sql`${id}`), sql`, `)})`)).rows;
      if (meterRows.length !== meterIds.length) {
        refuse("usage_band_meter_unavailable", "A rating band references a meter outside this organization.", "Choose meters that belong to this organization.", "meter_id");
      }
    }

    const existingBandCount = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from usage_rating_bands
       where org_id = ${orgId} and plan_version_id = ${safeVersionId}`)).rows[0]?.count ?? 0;
    if (existingBandCount > 0) {
      const deleted = await db.execute(sql`
        delete from usage_rating_bands where org_id = ${orgId} and plan_version_id = ${safeVersionId}`);
      if (deleted.rowCount !== existingBandCount) {
        refuse("usage_band_edit_conflict", "The draft bands changed while the replacement was being saved.", "Reload the draft and apply the complete band set again.", "plan_version_id", 409);
      }
    }
    const inserted: UsageRatingBand[] = [];
    for (const band of prepared) {
      const result = await db.execute<UsageRatingBand>(sql`
        insert into usage_rating_bands
          (org_id, plan_version_id, meter_id, kind, seq, up_to_qty, unit_price, flat_amount,
           included_qty, package_size, package_rounding, created_by, updated_by)
        values
          (${orgId}, ${safeVersionId}, ${band.meterId}, ${band.kind}, ${band.seq}, ${band.upToQty},
           ${band.unitPrice}, ${band.flatAmount}, ${band.includedQty}, ${band.packageSize},
           ${band.packageRounding}, ${actor}, ${actor})
        returning ${BAND_COLUMNS}`);
      if (result.rows.length !== 1) throw new Error("usage rating band insert returned an unexpected row count");
      inserted.push(result.rows[0]!);
    }
    return inserted;
  });
}

function validateBandCoverage(bands: readonly UsageRatingBand[]): void {
  if (bands.length === 0) {
    refuse("usage_band_coverage_missing", "A rating plan version cannot publish without rating bands.", "Add bands that cover each meter from zero through an unbounded final band.", "bands");
  }
  const byMeter = new Map<string, UsageRatingBand[]>();
  for (const band of bands) {
    const group = byMeter.get(band.meterId) ?? [];
    group.push(band);
    byMeter.set(band.meterId, group);
  }
  for (const [meterId, group] of byMeter) {
    group.sort((left, right) => left.seq - right.seq);
    let previousUpper: string | null = null;
    let infinityCount = 0;
    for (let i = 0; i < group.length; i += 1) {
      const band = group[i]!;
      const expectedSeq = i + 1;
      if (band.seq !== expectedSeq) {
        refuse(
          "usage_band_coverage_gap",
          `Meter ${meterId} has a gap before band seq ${band.seq}; rating bands must be consecutively numbered from seq 1.`,
            `Change band seq ${band.seq} to seq ${expectedSeq} so the meter's complete quantity range is ordered without gaps.`,
          "seq",
        );
      }
      if (band.upToQty === null) {
        infinityCount += 1;
        if (i !== group.length - 1 || infinityCount > 1) {
          refuse(
            "usage_band_coverage_overlap",
            `Meter ${meterId} band seq ${band.seq} is unbounded before the final band.`,
            `Move the unbounded upper limit to the final band seq for this meter.`,
            "seq",
          );
        }
      } else {
        if (i === 0 && compareDecimal(band.upToQty, "0") <= 0) {
          refuse(
            "usage_band_coverage_gap",
            `Meter ${meterId} band seq ${band.seq} does not cover quantities above zero.`,
            `Increase the upper quantity limit on band seq ${band.seq} above zero so coverage starts at zero.`,
            "up_to_qty",
          );
        }
        if (previousUpper !== null && compareDecimal(band.upToQty, previousUpper) <= 0) {
          refuse(
            "usage_band_coverage_overlap",
            `Meter ${meterId} band seq ${band.seq} overlaps the preceding quantity boundary.`,
            `Increase the named band seq ${band.seq} upper limit so each band follows the preceding band without overlap.`,
            "up_to_qty",
          );
        }
        previousUpper = band.upToQty;
      }
    }
    if (infinityCount !== 1) {
      const seq = group[group.length - 1]!.seq;
      refuse(
        "usage_band_coverage_gap",
        `Meter ${meterId} band seq ${seq} leaves the upper quantity range uncovered.`,
        `Set up_to_qty to null on the final band seq ${seq} so this meter is covered through infinity.`,
        "up_to_qty",
      );
    }
  }
}

function canonicalBandHash(bands: readonly UsageRatingBand[]): string {
  const canonical = [...bands]
    .sort((left, right) => left.meterId.localeCompare(right.meterId) || left.seq - right.seq)
    .map((band) => [
      band.meterId,
      band.kind,
      band.seq,
      band.upToQty === null ? null : quantityText(band.upToQty, "up_to_qty"),
      quantityText(band.unitPrice, "unit_price"),
      moneyText(band.flatAmount, "flat_amount"),
      quantityText(band.includedQty, "included_qty"),
      band.packageSize === null ? null : quantityText(band.packageSize, "package_size"),
      band.packageRounding,
    ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function publishUsagePlanVersion(
  orgId: string,
  actor: string,
  versionId: string,
): Promise<UsageRatingPlanVersion> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const safeVersionId = uuidText(versionId, "plan_version_id");
    const version = (await db.execute<{ status: string }>(sql`
      select status from usage_rating_plan_versions
       where org_id = ${orgId} and id = ${safeVersionId} for update`)).rows[0];
    if (!version) refuse("usage_plan_version_not_found", "The usage rating plan version does not exist in this organization.", "Choose a plan version from this organization.", "plan_version_id");
    assertUsagePlanVersionMutable(version.status);
    const bands = (await db.execute<UsageRatingBand>(sql`
      select ${BAND_COLUMNS} from usage_rating_bands
       where org_id = ${orgId} and plan_version_id = ${safeVersionId}
       order by meter_id, seq`)).rows;
    validateBandCoverage(bands);
    const hash = canonicalBandHash(bands);
    const updated = await db.execute<UsageRatingPlanVersion>(sql`
      update usage_rating_plan_versions
         set status = 'published', spec_hash = ${hash}, updated_at = now(), updated_by = ${actor}
       where org_id = ${orgId} and id = ${safeVersionId} and status = 'draft'
      returning ${VERSION_COLUMNS}`);
    if (updated.rows.length !== 1) {
      refuse("usage_plan_version_publish_conflict", "The usage rating plan version changed before publication completed.", "Reload the draft and publish it again after resolving concurrent edits.", "plan_version_id", 409);
    }
    return updated.rows[0]!;
  });
}

function intersect(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

export async function createSubscriptionUsageLink(
  orgId: string,
  actor: string,
  input: CreateSubscriptionUsageLinkInput,
): Promise<SubscriptionUsageLink> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const subscriptionId = uuidText(input.subscriptionId, "subscription_id");
    const customerId = uuidText(input.customerId, "customer_id");
    const planVersionId = uuidText(input.planVersionId, "plan_version_id");
    const meterIds = input.meterIds.map((meterId) => uuidText(meterId, "meter_id"));
    if (meterIds.length === 0) {
      refuse("usage_link_meter_set_required", "A subscription usage link must include at least one meter.", "Select the meters this published plan version will rate.", "meter_ids");
    }
    const uniqueMeters = [...new Set(meterIds)];
    if (uniqueMeters.length !== meterIds.length) {
      refuse("usage_link_meter_duplicate", "A subscription usage link cannot repeat a meter.", "Include each meter once in the link's meter set.", "meter_ids");
    }
    const effectiveFrom = dateText(input.effectiveFrom, "effective_from");
    const effectiveTo = input.effectiveTo == null ? null : dateText(input.effectiveTo, "effective_to");
    if (effectiveTo !== null && effectiveTo < effectiveFrom) {
      refuse("usage_link_window_invalid", "The subscription usage link ends before it begins.", "Set effective_to on or after effective_from.", "effective_to");
    }
    let commitAmount: string | null = null;
    if (input.commitAmount != null) commitAmount = moneyText(input.commitAmount, "commit_amount");
    const commitPeriod = input.commitPeriod ?? null;
    if ((commitAmount === null) !== (commitPeriod === null)) {
      refuse("usage_link_commit_pair_invalid", "A minimum commit requires both an amount and a period.", "Provide both commit_amount and commit_period, or clear both.", commitAmount === null ? "commit_amount" : "commit_period");
    }
    if (commitAmount !== null && (cmp(commitAmount, "0") <= 0 || !USAGE_COMMIT_PERIODS.includes(commitPeriod!))) {
      refuse("usage_link_commit_invalid", "The minimum commit amount or period is invalid.", "Provide a positive commit_amount and choose monthly or annual.", "commit_amount");
    }

    const subscription = (await db.execute<{
      customerId: string;
      planCurrency: string | null;
    }>(sql`
      select s.customer_id as "customerId", sp.currency_code as "planCurrency"
        from subscriptions s
        join subscription_plans sp on sp.org_id = s.org_id and sp.id = s.plan_id
       where s.org_id = ${orgId} and s.id = ${subscriptionId}
       for update of s`)).rows[0];
    if (!subscription) {
      refuse("usage_link_subscription_not_found", "The subscription does not exist in this organization.", "Choose a subscription from this organization.", "subscription_id");
    }
    if (subscription.customerId !== customerId) {
      refuse("usage_link_customer_mismatch", "The link customer does not match the subscription's customer.", "Link the subscription's own customer to this usage plan.", "customer_id");
    }

    const planVersion = (await db.execute<{
      status: string;
      effectiveFrom: string;
      planId: string;
      planCurrency: string;
      planStatus: string;
    }>(sql`
      select v.status, v.effective_from::text as "effectiveFrom", v.plan_id as "planId",
             p.currency_code as "planCurrency", p.status as "planStatus"
       from usage_rating_plan_versions v
        join usage_rating_plans p on p.org_id = v.org_id and p.id = v.plan_id
       where v.org_id = ${orgId} and v.id = ${planVersionId}
       for share of v, p`)).rows[0];
    if (!planVersion) {
      refuse("usage_link_plan_version_not_found", "The usage rating plan version does not exist in this organization.", "Choose a published rating plan version from this organization.", "plan_version_id");
    }
    if (planVersion.status !== "published") {
      refuse("usage_link_version_unpublished", "A subscription usage link must pin a published rating plan version.", "Publish the rating plan version before opening a subscription link.", "plan_version_id");
    }
    if (planVersion.planStatus !== "active") {
      refuse("usage_link_plan_retired", "A retired usage rating plan cannot receive a new subscription link.", "Choose an active rating plan or create a new one for future links.", "plan_version_id", 409);
    }
    if (effectiveFrom < planVersion.effectiveFrom) {
      refuse("usage_link_precedes_version", "The subscription link begins before its rating plan version is effective.", "Set effective_from on or after the plan version's effective_from date.", "effective_from");
    }
    if (!subscription.planCurrency || planVersion.planCurrency !== subscription.planCurrency) {
      refuse(
        "usage_link_currency_mismatch",
        `The usage rating plan currency ${planVersion.planCurrency} does not match the subscription plan currency ${subscription.planCurrency ?? "(unset)"}.`,
        "Link a rating plan whose currency matches the subscription's own plan currency.",
        "plan_version_id",
      );
    }

    const lifecycle = (await db.execute<{ termStartsOn: string; termEndsOn: string | null }>(sql`
      select term_starts_on::text as "termStartsOn", term_ends_on::text as "termEndsOn"
        from subscription_lifecycles
       where org_id = ${orgId} and subscription_id = ${subscriptionId}`)).rows[0];
    if (lifecycle) {
      if (
        effectiveFrom < lifecycle.termStartsOn ||
        (lifecycle.termEndsOn !== null && (effectiveTo === null || effectiveTo > lifecycle.termEndsOn))
      ) {
        refuse(
          "usage_link_lifecycle_window_invalid",
          "The subscription usage link extends outside the subscription's active lifecycle term.",
          lifecycle.termEndsOn === null
            ? `Set effective_from on or after ${lifecycle.termStartsOn}.`
            : `Set the link window inside ${lifecycle.termStartsOn} through ${lifecycle.termEndsOn}.`,
          "effective_from",
        );
      }
    }

    const meterRows = (await db.execute<{ id: string; itemId: string | null; isActive: boolean }>(sql`
      select id, item_id as "itemId", is_active as "isActive"
        from usage_meters where org_id = ${orgId}
          and id in (${sql.join(uniqueMeters.map((id) => sql`${id}`), sql`, `)})
       for share`)).rows;
    if (meterRows.length !== uniqueMeters.length) {
      refuse("usage_link_meter_unavailable", "The link includes a meter outside this organization.", "Select meters that belong to this organization.", "meter_ids");
    }
    const missingItem = meterRows.find((meter) => meter.itemId === null);
    if (missingItem) {
      refuse("usage_link_meter_item_required", `Meter ${missingItem.id} has no billing item.`, "Set the meter's item before linking it to a subscription usage plan.", "meter_ids");
    }
    const inactiveMeter = meterRows.find((meter) => !meter.isActive);
    if (inactiveMeter) {
      refuse("usage_link_meter_inactive", `Meter ${inactiveMeter.id} is inactive.`, "Reactivate the meter before opening a new subscription usage link.", "meter_ids", 409);
    }
    const pricedMeters = (await db.execute<{ meterId: string }>(sql`
      select distinct meter_id as "meterId" from usage_rating_bands
       where org_id = ${orgId} and plan_version_id = ${planVersionId}
         and meter_id in (${sql.join(uniqueMeters.map((id) => sql`${id}`), sql`, `)})`)).rows;
    if (pricedMeters.length !== uniqueMeters.length) {
      const priced = new Set(pricedMeters.map((row) => row.meterId));
      const missing = uniqueMeters.find((meterId) => !priced.has(meterId))!;
      refuse("usage_link_meter_unpriced", `The published version has no rating bands for meter ${missing}.`, "Add and publish bands for every meter selected on the subscription link.", "meter_ids");
    }

    const existingLinks = (await db.execute<{
      id: string;
      meterIds: string[];
      effectiveFrom: string;
      effectiveTo: string | null;
    }>(sql`
      select id, meter_ids as "meterIds", effective_from::text as "effectiveFrom",
             effective_to::text as "effectiveTo"
        from subscription_usage_links
       where org_id = ${orgId} and subscription_id = ${subscriptionId}`)).rows;
    const collision = existingLinks.find((link) =>
      intersect(link.meterIds, uniqueMeters) &&
      (effectiveTo === null || link.effectiveFrom <= effectiveTo) &&
      (link.effectiveTo === null || link.effectiveTo >= effectiveFrom));
    if (collision) {
      refuse("usage_link_window_overlap", `The requested window overlaps usage link ${collision.id} for one or more selected meters.`, "Close the existing link or choose a non-overlapping effective window for these meters.", "effective_from", 409);
    }

    const inserted = await db.execute<SubscriptionUsageLink>(sql`
      insert into subscription_usage_links
        (org_id, subscription_id, customer_id, plan_version_id, meter_ids,
         effective_from, effective_to, commit_amount, commit_period, allow_overage,
         created_by, updated_by)
      values
        (${orgId}, ${subscriptionId}, ${customerId}, ${planVersionId}, array[${sql.join(uniqueMeters.map((id) => sql`${id}`), sql`, `)}]::uuid[],
         ${effectiveFrom}, ${effectiveTo}, ${commitAmount}, ${commitPeriod}, ${input.allowOverage ?? true},
         ${actor}, ${actor})
      returning ${LINK_COLUMNS}`);
    if (inserted.rows.length !== 1) throw new Error("subscription usage link insert returned an unexpected row count");
    return inserted.rows[0]!;
  });
}

export async function closeSubscriptionUsageLink(
  orgId: string,
  actor: string,
  linkId: string,
  effectiveToInput: string,
): Promise<SubscriptionUsageLink> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const safeLinkId = uuidText(linkId, "link_id");
    const effectiveTo = dateText(effectiveToInput, "effective_to");
    const link = (await db.execute<{ subscriptionId: string; effectiveFrom: string; effectiveTo: string | null }>(sql`
      select subscription_id as "subscriptionId", effective_from::text as "effectiveFrom",
             effective_to::text as "effectiveTo"
        from subscription_usage_links where org_id = ${orgId} and id = ${safeLinkId}`)).rows[0];
    if (!link) refuse("usage_link_not_found", "The subscription usage link does not exist in this organization.", "Choose a usage link from this organization.", "link_id");
  if (link.effectiveTo !== null) {
    refuse("usage_link_already_closed", "The subscription usage link already has an effective_to date.", "Open a new usage link for a later pricing window.", "link_id", 409);
  }
  if (effectiveTo < link.effectiveFrom) {
    refuse("usage_link_window_invalid", "The subscription usage link ends before it begins.", "Set effective_to on or after effective_from.", "effective_to");
  }
  await db.execute(sql`
    select id from subscriptions
     where org_id = ${orgId} and id = ${link.subscriptionId} for update`);
  const lifecycle = (await db.execute<{ termStartsOn: string; termEndsOn: string | null }>(sql`
    select term_starts_on::text as "termStartsOn", term_ends_on::text as "termEndsOn"
      from subscription_lifecycles
     where org_id = ${orgId} and subscription_id = ${link.subscriptionId}`)).rows[0];
  if (
    lifecycle &&
    (link.effectiveFrom < lifecycle.termStartsOn ||
      (lifecycle.termEndsOn !== null && effectiveTo > lifecycle.termEndsOn))
  ) {
    refuse(
      "usage_link_lifecycle_window_invalid",
      "The subscription usage link window falls outside the subscription's active lifecycle term.",
      lifecycle.termEndsOn === null
        ? `Set the link window on or after ${lifecycle.termStartsOn}.`
        : `Set the link window inside ${lifecycle.termStartsOn} through ${lifecycle.termEndsOn}.`,
      "effective_to",
    );
  }
  const updated = await db.execute<SubscriptionUsageLink>(sql`
      update subscription_usage_links
         set effective_to = ${effectiveTo}, updated_at = now(), updated_by = ${actor}
       where org_id = ${orgId} and id = ${safeLinkId} and effective_to is null
      returning ${LINK_COLUMNS}`);
    if (updated.rows.length !== 1) {
      refuse("usage_link_close_conflict", "The subscription usage link changed before it could be closed.", "Reload the current link and retry with the intended effective_to date.", "link_id", 409);
    }
    return updated.rows[0]!;
  });
}

export async function getSubscriptionUsageLinks(orgId: string, subscriptionId: string): Promise<SubscriptionUsageLink[]> {
  return withOrg(orgId, async () => {
    await requireUsageBillingRead(orgId);
    const safeSubscriptionId = uuidText(subscriptionId, "subscription_id");
    return (await db.execute<SubscriptionUsageLink>(sql`
      select ${LINK_COLUMNS} from subscription_usage_links
       where org_id = ${orgId} and subscription_id = ${safeSubscriptionId}
       order by effective_from, id`)).rows;
  });
}
