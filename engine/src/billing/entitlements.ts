import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { parseQuantity } from "../money/brands.ts";
import { compareDecimal } from "../money/exact-decimal.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { businessToday } from "../platform/business-date.ts";
import { db, withOrg } from "../platform/db.ts";
import { emitEntitlementChanged } from "../webhooks/emit.ts";
import { UsageBillingError } from "./usage/errors.ts";
import { ingestUsageRecords, reverseUsageRecord } from "./usage/records.ts";
import { listSubscriptionUsageLinks } from "./usage/rating-plans.ts";

/**
 * SaaS plan entitlements — the priced capabilities a subscription grants,
 * without a billing-provider dependency. One resolver answers every read;
 * writers store effective-dated rows and refresh the cached snapshot, so
 * the public API serves the fast path and historical queries resolve live.
 *
 * Precedence per feature: an open subscription override wins field by
 * field over the plan-version row; a lifecycle that pins an older plan
 * version keeps that version's values (grandfathering) while new
 * subscriptions resolve the latest published version. Every writer closes
 * the open row it supersedes instead of rewriting it, so changing a rule
 * never reinterprets history.
 */

export type SaasFeatureType = "boolean" | "quantity" | "metered" | "custom";
export type EntitlementOveragePolicy = "block" | "allow_and_bill" | "alert";
export type EntitlementSource = "plan" | "override";

const FEATURE_TYPES: readonly string[] = ["boolean", "quantity", "metered", "custom"];
const OVERAGE_POLICIES: readonly string[] = ["block", "allow_and_bill", "alert"];

/** Database numerics arrive scale-padded (`100.00000000`); callers and the API speak canonical decimals (`100`). */
function canonQty(value: string | null): string | null {
  if (value === null) return null;
  return parseQuantity(value);
}

export class EntitlementError extends Error {
  readonly code: string;
  readonly remedy: string;
  readonly field: string | null;
  readonly status: 422 | 409 | 404;

  constructor(
    code: string,
    message: string,
    remedy: string,
    options?: { field?: string | null; status?: 422 | 409 | 404 },
  ) {
    super(message);
    this.name = "EntitlementError";
    this.code = code;
    this.remedy = remedy;
    this.field = options?.field ?? null;
    this.status = options?.status ?? 422;
  }
}

function refuse(
  code: string,
  message: string,
  remedy: string,
  field: string | null = null,
  status: 422 | 409 | 404 = 422,
): never {
  throw new EntitlementError(code, message, remedy, { field, status });
}

const FEATURE_REMEDY = "Enable Advanced Subscriptions in Company Settings → Features.";
const CATALOG_REMEDY = "Add the feature to the catalog in Setup → Subscription Features.";

function featureOff(): never {
  return refuse("entitlement_feature_off", "Plan entitlements are turned off for this organization.", FEATURE_REMEDY);
}

async function lockAndRequireEntitlements(orgId: string): Promise<void> {
  await acquireOrgFeatureGateLock(db, orgId);
  if (!(await lockAndCheckOrgFeature(db, orgId, "advancedSubscriptions"))) featureOff();
}

async function requireEntitlementsRead(orgId: string): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, "advancedSubscriptions"))) featureOff();
}

function requiredText(value: unknown, field: string, code: string): string {
  if (typeof value !== "string" || !value.trim()) {
    refuse(code, `${field} is required.`, `Provide a non-empty ${field}.`, field);
  }
  return (value as string).trim();
}

function uuidText(value: unknown, field: string): string {
  const candidate = requiredText(value, field, "entitlement_input_required");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) {
    refuse("entitlement_uuid_invalid", `${field} must be a UUID.`, `Provide a valid ${field} from this organization.`, field);
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
    refuse("entitlement_date_invalid", `${field} must be a real calendar date in YYYY-MM-DD form.`, `Provide a valid ${field} in YYYY-MM-DD form.`, field);
  }
  return value;
}

function quantityText(value: unknown, field: string): string {
  let quantity: string;
  try {
    quantity = parseQuantity(value);
  } catch {
    refuse("entitlement_quantity_invalid", `${field} must be an exact decimal with no more than 8 decimal places.`, `Provide a non-negative ${field} with no more than 8 decimal places.`, field);
  }
  if (compareDecimal(quantity, "0") < 0) {
    refuse("entitlement_quantity_invalid", `${field} cannot be negative.`, `Provide a non-negative ${field}.`, field);
  }
  return quantity;
}

function featureKeyText(value: unknown, field: string): string {
  const key = requiredText(value, field, "entitlement_key_required").toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
    refuse(
      "entitlement_key_invalid",
      "A feature key starts with a letter and holds letters, digits and underscores.",
      "Choose a feature key like seats_included or api_calls.",
      field,
    );
  }
  return key;
}

export type SaasFeature = {
  id: string;
  orgId: string;
  key: string;
  name: string;
  description: string | null;
  featureType: SaasFeatureType;
  unit: string | null;
  meterId: string | null;
  meterKey: string | null;
  isActive: boolean;
};

const FEATURE_COLUMNS = sql`
  f.id, f.org_id as "orgId", f.key, f.name, f.description,
  f.feature_type as "featureType", f.unit,
  f.meter_id as "meterId", m.key as "meterKey",
  f.is_active as "isActive"`;

export interface CreateSaasFeatureInput {
  key: string;
  name: string;
  description?: string | null;
  type: SaasFeatureType;
  unit?: string | null;
  meterKey?: string | null;
  isActive?: boolean;
}

export interface UpdateSaasFeatureInput {
  name?: string;
  description?: string | null;
  unit?: string | null;
  meterKey?: string | null;
  isActive?: boolean;
}

async function resolveMeterKey(orgId: string, meterKey: string, field: string): Promise<string> {
  const key = requiredText(meterKey, field, "entitlement_key_required");
  const meter = (await db.execute<{ id: string; isActive: boolean }>(sql`
    select id, is_active as "isActive" from usage_meters
     where org_id = ${orgId} and key = ${key}`)).rows[0];
  if (!meter) {
    refuse("entitlement_meter_unknown", `No usage meter has key ${key}.`, "Create the meter in Setup → Usage, or correct the meter key.", field);
  }
  if (!meter.isActive) {
    refuse("entitlement_meter_inactive", `Usage meter ${key} is inactive.`, "Reactivate the meter or link its replacement.", field, 409);
  }
  return meter.id;
}

async function recordConfigAudit(
  orgId: string,
  table: string,
  rowId: string,
  action: "create" | "update",
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  actor: string,
): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${table}, ${rowId}::uuid, ${action},
            ${JSON.stringify({ before, after })}::jsonb, ${actor}::uuid)`);
}

export async function createSaasFeature(
  orgId: string,
  actor: string,
  input: CreateSaasFeatureInput,
): Promise<SaasFeature> {
  return withOrg(orgId, async () => {
    await lockAndRequireEntitlements(orgId);
    const key = featureKeyText(input.key, "key");
    const name = requiredText(input.name, "name", "entitlement_input_required");
    if (!FEATURE_TYPES.includes(input.type)) {
      refuse("entitlement_type_invalid", "The feature type must be boolean, quantity, metered or custom.", "Choose one of the four feature types.", "type");
    }
    const type = input.type;
    const unit = input.unit == null || input.unit === "" ? null : requiredText(input.unit, "unit", "entitlement_input_required");
    if (unit !== null && type !== "quantity" && type !== "metered") {
      refuse("entitlement_unit_scope_invalid", "Only quantity and metered features carry a unit.", "Clear the unit or choose a quantity or metered type.", "unit");
    }
    let meterId: string | null = null;
    if (input.meterKey != null && input.meterKey !== "") {
      if (type !== "metered") {
        refuse("entitlement_meter_scope_invalid", "Only metered features link a usage meter.", "Clear the meter or choose the metered type.", "meter_key");
      }
      meterId = await resolveMeterKey(orgId, input.meterKey, "meter_key");
    }
    try {
      const inserted = (await db.execute<SaasFeature>(sql`
        insert into saas_features (org_id, key, name, description, feature_type, unit, meter_id, is_active, created_by, updated_by)
        values (${orgId}, ${key}, ${name}, ${input.description ?? null}, ${type}, ${unit}, ${meterId},
                ${input.isActive ?? true}, ${actor}::uuid, ${actor}::uuid)
        returning id, org_id as "orgId", key, name, description,
                  feature_type as "featureType", unit,
                  meter_id as "meterId", null as "meterKey",
                  is_active as "isActive"`)).rows[0];
      if (!inserted) throw new Error("feature insert returned no row");
      await recordConfigAudit(orgId, "saas_features", inserted.id, "create", null, {
        key, name, type, unit, meterId, isActive: inserted.isActive,
      }, actor);
      return inserted;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        refuse("entitlement_key_in_use", `A feature with key ${key} already exists in this organization.`, "Choose a different feature key.", "key", 409);
      }
      throw error;
    }
  });
}

export async function listSaasFeatures(orgId: string, activeOnly = false): Promise<SaasFeature[]> {
  return withOrg(orgId, async () => {
    await requireEntitlementsRead(orgId);
    return (await db.execute<SaasFeature>(sql`
      select ${FEATURE_COLUMNS} from saas_features f
        left join usage_meters m on m.org_id = f.org_id and m.id = f.meter_id
       where f.org_id = ${orgId} and (${activeOnly}::boolean = false or f.is_active)
       order by f.key`)).rows;
  });
}

export async function updateSaasFeature(
  orgId: string,
  actor: string,
  featureId: string,
  input: UpdateSaasFeatureInput,
): Promise<SaasFeature> {
  return withOrg(orgId, async () => {
    await lockAndRequireEntitlements(orgId);
    const safeId = uuidText(featureId, "feature_id");
    const current = (await db.execute<SaasFeature>(sql`
      select ${FEATURE_COLUMNS} from saas_features f
        left join usage_meters m on m.org_id = f.org_id and m.id = f.meter_id
       where f.org_id = ${orgId} and f.id = ${safeId}::uuid for update of f`)).rows[0];
    if (!current) {
      refuse("entitlement_feature_not_found", "The feature does not exist in this organization.", CATALOG_REMEDY, "feature_id", 404);
    }
    const name = input.name === undefined ? current.name : requiredText(input.name, "name", "entitlement_input_required");
    const description = input.description === undefined ? current.description : input.description;
    const unit = input.unit === undefined ? current.unit : (input.unit === "" ? null : input.unit);
    if (unit !== null && current.featureType !== "quantity" && current.featureType !== "metered") {
      refuse("entitlement_unit_scope_invalid", "Only quantity and metered features carry a unit.", "Clear the unit.", "unit");
    }
    let meterId = current.meterId;
    if (input.meterKey !== undefined) {
      if (input.meterKey === "" || input.meterKey === null) {
        meterId = null;
      } else {
        if (current.featureType !== "metered") {
          refuse("entitlement_meter_scope_invalid", "Only metered features link a usage meter.", "Clear the meter.", "meter_key");
        }
        meterId = await resolveMeterKey(orgId, input.meterKey, "meter_key");
      }
    }
    if (meterId !== null && current.featureType !== "metered") {
      refuse("entitlement_meter_scope_invalid", "Only metered features link a usage meter.", "Clear the meter.", "meter_key");
    }
    const isActive = input.isActive ?? current.isActive;
    const updated = (await db.execute<SaasFeature>(sql`
      update saas_features
         set name = ${name}, description = ${description}, unit = ${unit}, meter_id = ${meterId},
             is_active = ${isActive}, updated_at = now(), updated_by = ${actor}::uuid
       where org_id = ${orgId} and id = ${safeId}::uuid
      returning id, org_id as "orgId", key, name, description,
                feature_type as "featureType", unit,
                meter_id as "meterId", null as "meterKey",
                is_active as "isActive"`)).rows[0];
    if (!updated) throw new Error("feature update matched no row after locking it");
    await recordConfigAudit(orgId, "saas_features", updated.id, "update", {
      name: current.name, description: current.description, unit: current.unit,
      meterId: current.meterId, isActive: current.isActive,
    }, {
      name: updated.name, description: updated.description, unit: updated.unit,
      meterId: updated.meterId, isActive: updated.isActive,
    }, actor);
    return updated;
  });
}

export type PlanVersionEntitlement = {
  id: string;
  orgId: string;
  planVersionId: string;
  featureId: string;
  featureKey: string;
  featureType: SaasFeatureType;
  enabled: boolean;
  limitQty: string | null;
  customValue: string | null;
  overagePolicy: EntitlementOveragePolicy;
  meterId: string | null;
  meterKey: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
};

const VERSION_ENTITLEMENT_COLUMNS = sql`
  e.id, e.org_id as "orgId", e.plan_version_id as "planVersionId",
  e.feature_id as "featureId", f.key as "featureKey", f.feature_type as "featureType",
  e.enabled, e.limit_qty::text as "limitQty", e.custom_value as "customValue",
  e.overage_policy as "overagePolicy", e.meter_id as "meterId", m.key as "meterKey",
  e.effective_from::text as "effectiveFrom", e.effective_to::text as "effectiveTo"`;

export interface SavePlanVersionEntitlementInput {
  featureKey: string;
  enabled?: boolean;
  limit?: unknown;
  customValue?: string | null;
  overagePolicy?: EntitlementOveragePolicy;
  meterKey?: string | null;
}

export interface SavePlanVersionEntitlementsInput {
  planVersionId: string;
  effectiveFrom?: string;
  rows: readonly SavePlanVersionEntitlementInput[];
}

type VersionHead = {
  id: string;
  planId: string;
  status: string;
  effectiveFrom: string;
};

async function loadVersionHead(orgId: string, versionId: string): Promise<VersionHead> {
  const safeId = uuidText(versionId, "plan_version_id");
  const version = (await db.execute<VersionHead>(sql`
    select id, plan_id as "planId", status, effective_from::text as "effectiveFrom"
      from subscription_plan_versions
     where org_id = ${orgId} and id = ${safeId}::uuid`)).rows[0];
  if (!version) {
    refuse("entitlement_plan_version_not_found", "The plan version does not exist in this organization.", "Choose a plan version from this organization.", "plan_version_id", 404);
  }
  return version;
}

async function loadActiveFeature(orgId: string, featureKey: string): Promise<SaasFeature> {
  const key = featureKeyText(featureKey, "feature_key");
  const feature = (await db.execute<SaasFeature>(sql`
    select ${FEATURE_COLUMNS} from saas_features f
      left join usage_meters m on m.org_id = f.org_id and m.id = f.meter_id
     where f.org_id = ${orgId} and f.key = ${key}`)).rows[0];
  if (!feature) {
    refuse("entitlement_feature_not_found", `No feature has key ${key} in this organization.`, CATALOG_REMEDY, "feature_key", 404);
  }
  if (!feature.isActive) {
    refuse("entitlement_feature_inactive", `Feature ${key} is deactivated in the catalog.`, "Reactivate the feature in Setup → Subscription Features before granting it.", "feature_key", 409);
  }
  return feature;
}

type ValidatedEntitlementValue = {
  enabled: boolean;
  limitQty: string | null;
  customValue: string | null;
  overagePolicy: EntitlementOveragePolicy;
  meterId: string | null;
};

async function validateEntitlementValue(
  orgId: string,
  feature: SaasFeature,
  input: SavePlanVersionEntitlementInput,
): Promise<ValidatedEntitlementValue> {
  if (input.overagePolicy !== undefined && !OVERAGE_POLICIES.includes(input.overagePolicy)) {
    refuse("entitlement_overage_invalid", "The overage policy must be block, allow_and_bill or alert.", "Choose one of the three overage policies.", "overage_policy");
  }
  const policy = input.overagePolicy ?? "block";
  if (feature.featureType === "boolean") {
    if (input.limit !== undefined && input.limit !== null) {
      refuse("entitlement_limit_scope_invalid", `Boolean feature ${feature.key} carries no limit.`, "Grant it with enabled only.", "limit", 422);
    }
    if (input.customValue !== undefined && input.customValue !== null) {
      refuse("entitlement_custom_scope_invalid", `Boolean feature ${feature.key} carries no custom value.`, "Grant it with enabled only.", "custom_value", 422);
    }
    if (policy !== "block") {
      refuse("entitlement_overage_scope_invalid", `Boolean feature ${feature.key} has no usage to handle over.`, "Keep the block policy for boolean features.", "overage_policy", 422);
    }
    return { enabled: input.enabled ?? true, limitQty: null, customValue: null, overagePolicy: "block", meterId: null };
  }
  if (feature.featureType === "custom") {
    const customValue = input.customValue === undefined || input.customValue === null
      ? null
      : requiredText(input.customValue, "custom_value", "entitlement_input_required");
    if (customValue === null) {
      refuse("entitlement_custom_required", `Custom feature ${feature.key} needs its value on every grant.`, "Provide the custom value this plan version grants.", "custom_value");
    }
    if (input.limit !== undefined && input.limit !== null) {
      refuse("entitlement_limit_scope_invalid", `Custom feature ${feature.key} carries no numeric limit.`, "Grant it with a custom value only.", "limit", 422);
    }
    if (policy !== "block") {
      refuse("entitlement_overage_scope_invalid", `Custom feature ${feature.key} has no usage to handle over.`, "Keep the block policy for custom features.", "overage_policy", 422);
    }
    return { enabled: input.enabled ?? true, limitQty: null, customValue, overagePolicy: "block", meterId: null };
  }
  if (input.limit === undefined || input.limit === null) {
    refuse("entitlement_limit_required", `${feature.featureType} feature ${feature.key} needs its included limit on every grant.`, "Provide the included quantity this plan version grants.", "limit");
  }
  const limitQty = quantityText(input.limit, "limit");
  let meterId: string | null = null;
  if (feature.featureType === "metered") {
    const meterKey = input.meterKey ?? feature.meterKey;
    if (meterKey === null || meterKey === undefined || meterKey === "") {
      refuse("entitlement_meter_required", `Metered feature ${feature.key} resolves usage through a meter, and none is linked.`, "Link a usage meter on the feature or on this grant.", "meter_key");
    }
    meterId = await resolveMeterKey(orgId, meterKey, "meter_key");
  } else if (input.meterKey !== undefined && input.meterKey !== null && input.meterKey !== "") {
    refuse("entitlement_meter_scope_invalid", `Quantity feature ${feature.key} is counted by the caller, not by a meter.`, "Clear the meter link.", "meter_key");
  }
  return { enabled: input.enabled ?? true, limitQty, customValue: null, overagePolicy: policy, meterId };
}

/** Close the open row a new effective-dated row supersedes. Zero closed rows means no prior grant — the first grant, not a failure. */
async function closeSupersededRow(
  table: "subscription_plan_version_entitlements" | "subscription_entitlement_overrides",
  orgId: string,
  scope: { planVersionId: string; featureId: string } | { subscriptionId: string; featureId: string },
  effectiveFrom: string,
  actor: string,
): Promise<void> {
  const scopeFilter = "planVersionId" in scope
    ? sql`plan_version_id = ${scope.planVersionId}::uuid`
    : sql`subscription_id = ${scope.subscriptionId}::uuid`;
  const overlapping = (await db.execute<{ id: string }>(sql`
    select id from ${sql.raw(table)}
     where org_id = ${orgId} and ${scopeFilter} and feature_id = ${scope.featureId}::uuid
       and effective_to is null and effective_from > ${effectiveFrom}::date limit 1`)).rows[0];
  if (overlapping) {
    refuse(
      "entitlement_window_overlap",
      "The new grant starts before the open grant and would overlap it.",
      "Close the open grant first by setting its effective_to, or start the new grant on or after the open grant's start.",
      "effective_from",
      409,
    );
  }
  await db.execute(sql`
    update ${sql.raw(table)}
       set effective_to = ${effectiveFrom}::date, updated_at = now(), updated_by = ${actor}::uuid
     where org_id = ${orgId} and ${scopeFilter} and feature_id = ${scope.featureId}::uuid
       and effective_to is null and effective_from <= ${effectiveFrom}::date`);
}

async function refreshSnapshotsForPlan(orgId: string, planId: string, actor: string): Promise<string[]> {
  const subs = (await db.execute<{ id: string }>(sql`
    select id from subscriptions where org_id = ${orgId} and plan_id = ${planId}::uuid and status <> 'canceled'`)).rows;
  for (const sub of subs) {
    await refreshEntitlementSnapshot(orgId, sub.id, actor);
  }
  return subs.map((sub) => sub.id);
}

export async function savePlanVersionEntitlements(
  orgId: string,
  actor: string,
  input: SavePlanVersionEntitlementsInput,
): Promise<PlanVersionEntitlement[]> {
  return withOrg(orgId, async () => {
    await lockAndRequireEntitlements(orgId);
    if (input.rows.length === 0) {
      refuse("entitlement_rows_required", "Saving entitlements needs at least one feature row.", "Add a feature row before saving.", "rows");
    }
    const version = await loadVersionHead(orgId, input.planVersionId);
    const today = await businessToday(orgId);
    const effectiveFrom = input.effectiveFrom === undefined ? today : dateText(input.effectiveFrom, "effective_from");
    if (version.status !== "draft" && effectiveFrom < today) {
      refuse(
        "entitlement_published_version_backdate",
        "A published plan version keeps its history: new grants start today or later.",
        "Start the grant today or later, or draft a new plan version for a backdated change.",
        "effective_from",
        409,
      );
    }
    const saved: PlanVersionEntitlement[] = [];
    const seen = new Set<string>();
    for (const row of input.rows) {
      const feature = await loadActiveFeature(orgId, row.featureKey);
      if (seen.has(feature.id)) {
        refuse("entitlement_feature_duplicate", `Feature ${feature.key} appears twice in one save.`, "Grant each feature once per save.", "feature_key", 409);
      }
      seen.add(feature.id);
      const value = await validateEntitlementValue(orgId, feature, row);
      await closeSupersededRow(
        "subscription_plan_version_entitlements",
        orgId,
        { planVersionId: version.id, featureId: feature.id },
        effectiveFrom,
        actor,
      );
      const inserted = (await db.execute<PlanVersionEntitlement>(sql`
        insert into subscription_plan_version_entitlements
          (org_id, plan_version_id, feature_id, enabled, limit_qty, custom_value, overage_policy, meter_id,
           effective_from, created_by, updated_by)
        values (${orgId}, ${version.id}::uuid, ${feature.id}::uuid, ${value.enabled},
                ${value.limitQty}, ${value.customValue}, ${value.overagePolicy}, ${value.meterId},
                ${effectiveFrom}::date, ${actor}::uuid, ${actor}::uuid)
        returning id, org_id as "orgId", plan_version_id as "planVersionId",
                  feature_id as "featureId", ${feature.key} as "featureKey", ${feature.featureType} as "featureType",
                  enabled, limit_qty::text as "limitQty", custom_value as "customValue",
                  overage_policy as "overagePolicy", meter_id as "meterId", null as "meterKey",
                  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"`)).rows[0];
      if (!inserted) throw new Error("plan version entitlement insert returned no row");
      inserted.limitQty = canonQty(inserted.limitQty);
      await recordConfigAudit(orgId, "subscription_plan_version_entitlements", inserted.id, "create", null, {
        planVersionId: version.id, featureKey: feature.key, enabled: value.enabled,
        limitQty: value.limitQty, customValue: value.customValue,
        overagePolicy: value.overagePolicy, meterId: value.meterId, effectiveFrom,
      }, actor);
      saved.push(inserted);
    }
    // Announce per subscription, not per plan: subscribers track what each
    // subscription may do, and the plan row itself names no subscriber.
    // Canceled subscriptions keep their last snapshot and hear nothing.
    const affected = await refreshSnapshotsForPlan(orgId, version.planId, actor);
    for (const row of saved) {
      for (const subscriptionId of affected) {
        await emitEntitlementChanged(db, orgId, {
          subscriptionId,
          featureKey: row.featureKey,
          change: `plan version grant saved (effective ${effectiveFrom})`,
          dedupeKey: `plan-version:${row.id}:${subscriptionId}`,
        });
      }
    }
    return saved;
  });
}

export async function listPlanVersionEntitlements(
  orgId: string,
  planVersionId: string,
  at?: string,
): Promise<PlanVersionEntitlement[]> {
  return withOrg(orgId, async () => {
    await requireEntitlementsRead(orgId);
    const version = await loadVersionHead(orgId, planVersionId);
    const asOf = at === undefined ? await businessToday(orgId) : dateText(at, "at");
    const rows = (await db.execute<PlanVersionEntitlement>(sql`
      select ${VERSION_ENTITLEMENT_COLUMNS}
        from subscription_plan_version_entitlements e
        join saas_features f on f.org_id = e.org_id and f.id = e.feature_id
        left join usage_meters m on m.org_id = e.org_id and m.id = e.meter_id
       where e.org_id = ${orgId} and e.plan_version_id = ${version.id}::uuid
         and e.effective_from <= ${asOf}::date and (e.effective_to is null or e.effective_to > ${asOf}::date)
       order by f.key`)).rows;
    return rows.map((row) => ({ ...row, limitQty: canonQty(row.limitQty) }));
  });
}

export type SubscriptionEntitlementOverride = {
  id: string;
  orgId: string;
  subscriptionId: string;
  featureId: string;
  featureKey: string;
  enabled: boolean | null;
  limitQty: string | null;
  customValue: string | null;
  overagePolicy: EntitlementOveragePolicy | null;
  reason: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

const OVERRIDE_COLUMNS = sql`
  o.id, o.org_id as "orgId", o.subscription_id as "subscriptionId",
  o.feature_id as "featureId", f.key as "featureKey",
  o.enabled, o.limit_qty::text as "limitQty", o.custom_value as "customValue",
  o.overage_policy as "overagePolicy", o.reason,
  o.effective_from::text as "effectiveFrom", o.effective_to::text as "effectiveTo"`;

export interface SaveSubscriptionOverrideInput {
  subscriptionId: string;
  featureKey: string;
  enabled?: boolean | null;
  limit?: unknown;
  customValue?: string | null;
  overagePolicy?: EntitlementOveragePolicy | null;
  reason: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

type SubscriptionHead = {
  id: string;
  customerId: string;
  planId: string;
  status: string;
};

async function loadSubscriptionHead(orgId: string, subscriptionId: string): Promise<SubscriptionHead> {
  const safeId = uuidText(subscriptionId, "subscription_id");
  const sub = (await db.execute<SubscriptionHead>(sql`
    select id, customer_id as "customerId", plan_id as "planId", status
      from subscriptions where org_id = ${orgId} and id = ${safeId}::uuid`)).rows[0];
  if (!sub) {
    refuse("entitlement_subscription_not_found", "The subscription does not exist in this organization.", "Choose a subscription from this organization.", "subscription_id", 404);
  }
  return sub;
}

export async function saveSubscriptionOverride(
  orgId: string,
  actor: string,
  input: SaveSubscriptionOverrideInput,
): Promise<SubscriptionEntitlementOverride> {
  return withOrg(orgId, async () => {
    await lockAndRequireEntitlements(orgId);
    const sub = await loadSubscriptionHead(orgId, input.subscriptionId);
    const feature = await loadActiveFeature(orgId, input.featureKey);
    const enabled = input.enabled ?? null;
    const limitQty = input.limit === undefined || input.limit === null ? null : quantityText(input.limit, "limit");
    const customValue = input.customValue === undefined || input.customValue === null
      ? null
      : requiredText(input.customValue, "custom_value", "entitlement_input_required");
    if (input.overagePolicy !== undefined && input.overagePolicy !== null && !OVERAGE_POLICIES.includes(input.overagePolicy)) {
      refuse("entitlement_overage_invalid", "The overage policy must be block, allow_and_bill or alert.", "Choose one of the three overage policies.", "overage_policy");
    }
    const overagePolicy = input.overagePolicy ?? null;
    if (enabled === null && limitQty === null && customValue === null && overagePolicy === null) {
      refuse(
        "entitlement_override_empty",
        "An override must change at least one field.",
        "Set enabled, limit, custom value or overage policy — or leave the plan grant alone.",
        "feature_key",
      );
    }
    if (feature.featureType === "boolean" && (limitQty !== null || customValue !== null)) {
      refuse("entitlement_override_scope_invalid", `Boolean feature ${feature.key} carries no limit or custom value.`, "Override enabled only.", "feature_key");
    }
    if (feature.featureType === "custom" && limitQty !== null) {
      refuse("entitlement_override_scope_invalid", `Custom feature ${feature.key} carries no numeric limit.`, "Override the custom value only.", "limit");
    }
    if ((feature.featureType === "boolean" || feature.featureType === "custom") && overagePolicy !== null && overagePolicy !== "block") {
      refuse("entitlement_override_scope_invalid", `Feature ${feature.key} has no usage to handle over.`, "Keep the block policy for this feature.", "overage_policy");
    }
    const reason = requiredText(input.reason, "reason", "entitlement_input_required");
    const today = await businessToday(orgId);
    const effectiveFrom = input.effectiveFrom === undefined ? today : dateText(input.effectiveFrom, "effective_from");
    const effectiveTo = input.effectiveTo == null ? null : dateText(input.effectiveTo, "effective_to");
    if (effectiveTo !== null && effectiveTo < effectiveFrom) {
      refuse("entitlement_window_invalid", "The override ends before it begins.", "Set effective_to on or after effective_from.", "effective_to");
    }
    await closeSupersededRow(
      "subscription_entitlement_overrides",
      orgId,
      { subscriptionId: sub.id, featureId: feature.id },
      effectiveFrom,
      actor,
    );
    const inserted = (await db.execute<SubscriptionEntitlementOverride>(sql`
      insert into subscription_entitlement_overrides
        (org_id, subscription_id, feature_id, enabled, limit_qty, custom_value, overage_policy,
         reason, effective_from, effective_to, created_by, updated_by)
      values (${orgId}, ${sub.id}::uuid, ${feature.id}::uuid, ${enabled},
              ${limitQty}, ${customValue}, ${overagePolicy},
              ${reason}, ${effectiveFrom}::date, ${effectiveTo}, ${actor}::uuid, ${actor}::uuid)
      returning id, org_id as "orgId", subscription_id as "subscriptionId",
                feature_id as "featureId", ${feature.key} as "featureKey",
                enabled, limit_qty::text as "limitQty", custom_value as "customValue",
                overage_policy as "overagePolicy", reason,
                effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"`)).rows[0];
    if (!inserted) throw new Error("entitlement override insert returned no row");
    inserted.limitQty = canonQty(inserted.limitQty);
    await recordConfigAudit(orgId, "subscription_entitlement_overrides", inserted.id, "create", null, {
      subscriptionId: sub.id, featureKey: feature.key, enabled, limitQty,
      customValue, overagePolicy, reason, effectiveFrom, effectiveTo,
    }, actor);
    await emitEntitlementChanged(db, orgId, {
      subscriptionId: sub.id,
      featureKey: feature.key,
      change: `override saved: ${reason}`,
      dedupeKey: `override:${inserted.id}`,
    });
    await refreshEntitlementSnapshot(orgId, sub.id, actor);
    return inserted;
  });
}

export async function expireSubscriptionOverride(
  orgId: string,
  actor: string,
  input: { subscriptionId: string; featureKey: string; effectiveTo?: string },
): Promise<SubscriptionEntitlementOverride> {
  return withOrg(orgId, async () => {
    await lockAndRequireEntitlements(orgId);
    const sub = await loadSubscriptionHead(orgId, input.subscriptionId);
    const key = featureKeyText(input.featureKey, "feature_key");
    const today = await businessToday(orgId);
    const effectiveTo = input.effectiveTo === undefined ? today : dateText(input.effectiveTo, "effective_to");
    const open = (await db.execute<SubscriptionEntitlementOverride & { featureActive: boolean }>(sql`
      select ${OVERRIDE_COLUMNS}
        from subscription_entitlement_overrides o
        join saas_features f on f.org_id = o.org_id and f.id = o.feature_id
       where o.org_id = ${orgId} and o.subscription_id = ${sub.id}::uuid and f.key = ${key}
         and o.effective_to is null for update of o`)).rows[0];
    if (!open) {
      refuse(
        "entitlement_override_not_found",
        `Subscription has no open override for feature ${key}.`,
        "Save an override first, or check the feature key.",
        "feature_key",
        404,
      );
    }
    if (effectiveTo < open.effectiveFrom) {
      refuse("entitlement_window_invalid", "The override cannot end before it begins.", "Set effective_to on or after the override's start.", "effective_to");
    }
    const closed = (await db.execute<SubscriptionEntitlementOverride>(sql`
      update subscription_entitlement_overrides
         set effective_to = ${effectiveTo}::date, updated_at = now(), updated_by = ${actor}::uuid
       where org_id = ${orgId} and id = ${open.id}::uuid and effective_to is null
      returning id, org_id as "orgId", subscription_id as "subscriptionId",
                feature_id as "featureId", ${open.featureKey} as "featureKey",
                enabled, limit_qty::text as "limitQty", custom_value as "customValue",
                overage_policy as "overagePolicy", reason,
                effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"`)).rows[0];
    // The locked read above held the row: zero updated rows means a
    // concurrent writer closed it first, which is the same end state under
    // a different actor — report the conflict, never silent success.
    if (!closed) {
      refuse(
        "entitlement_override_close_conflict",
        "The override changed before expiry completed.",
        "Reload the subscription's overrides and expire the current row.",
        "feature_key",
        409,
      );
    }
    closed.limitQty = canonQty(closed.limitQty);
    await recordConfigAudit(orgId, "subscription_entitlement_overrides", closed.id, "update", {
      effectiveTo: null,
    }, {
      effectiveTo,
    }, actor);
    await emitEntitlementChanged(db, orgId, {
      subscriptionId: sub.id,
      featureKey: closed.featureKey,
      change: `override expired (effective ${effectiveTo})`,
      dedupeKey: `override-expire:${closed.id}:${effectiveTo}`,
    });
    await refreshEntitlementSnapshot(orgId, sub.id, actor);
    return closed;
  });
}

export async function listSubscriptionOverrides(
  orgId: string,
  subscriptionId: string,
  at?: string,
): Promise<SubscriptionEntitlementOverride[]> {
  return withOrg(orgId, async () => {
    await requireEntitlementsRead(orgId);
    const sub = await loadSubscriptionHead(orgId, subscriptionId);
    const asOf = at === undefined ? await businessToday(orgId) : dateText(at, "at");
    const rows = (await db.execute<SubscriptionEntitlementOverride>(sql`
      select ${OVERRIDE_COLUMNS}
        from subscription_entitlement_overrides o
        join saas_features f on f.org_id = o.org_id and f.id = o.feature_id
       where o.org_id = ${orgId} and o.subscription_id = ${sub.id}::uuid
         and o.effective_from <= ${asOf}::date and (o.effective_to is null or o.effective_to > ${asOf}::date)
       order by f.key`)).rows;
    return rows.map((row) => ({ ...row, limitQty: canonQty(row.limitQty) }));
  });
}

export interface ResolvedEntitlement {
  featureId: string;
  featureKey: string;
  featureType: SaasFeatureType;
  unit: string | null;
  meterKey: string | null;
  enabled: boolean;
  limit: string | null;
  customValue: string | null;
  overagePolicy: EntitlementOveragePolicy;
  source: EntitlementSource;
  planVersionId: string | null;
}

export interface ResolvedSubscriptionEntitlements {
  subscriptionId: string;
  customerId: string;
  status: string;
  planId: string;
  planVersionId: string | null;
  planVersionNumber: number | null;
  grandfathered: boolean;
  features: ResolvedEntitlement[];
}

type PlanRow = {
  featureId: string;
  enabled: boolean;
  limitQty: string | null;
  customValue: string | null;
  overagePolicy: EntitlementOveragePolicy;
  meterKey: string | null;
};

type OverrideRow = {
  featureId: string;
  enabled: boolean | null;
  limitQty: string | null;
  customValue: string | null;
  overagePolicy: EntitlementOveragePolicy | null;
};

async function latestPublishedVersionId(orgId: string, planId: string, asOf: string): Promise<VersionHead | null> {
  const row = (await db.execute<VersionHead>(sql`
    select id, plan_id as "planId", status, effective_from::text as "effectiveFrom"
      from subscription_plan_versions
     where org_id = ${orgId} and plan_id = ${planId}::uuid and status = 'published'
       and effective_from <= ${asOf}::date and (effective_to is null or effective_to >= ${asOf}::date)
     order by effective_from desc, version_number desc limit 1`)).rows[0];
  return row ?? null;
}

function hashResolution(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * The one resolver. A lifecycle pins its plan version — publishing a newer
 * version never moves it, so existing subscriptions keep the older grant
 * (grandfathering). Subscriptions without a lifecycle follow the latest
 * published version effective at `at`. Status never changes the grant:
 * the grant is configuration truth, and callers see the status beside it.
 */
async function resolveSubscription(
  orgId: string,
  sub: SubscriptionHead,
  asOf: string,
): Promise<{ resolved: ResolvedSubscriptionEntitlements; sourceHash: string }> {
  const lifecycle = (await db.execute<{ planVersionId: string }>(sql`
    select plan_version_id as "planVersionId" from subscription_lifecycles
     where org_id = ${orgId} and subscription_id = ${sub.id}::uuid limit 1`)).rows[0];
  let version: { id: string; versionNumber: number | null } | null = null;
  const latest = await latestPublishedVersionId(orgId, sub.planId, asOf);
  if (lifecycle) {
    const pinned = (await db.execute<{ id: string; versionNumber: number | null }>(sql`
      select id, version_number as "versionNumber" from subscription_plan_versions
       where org_id = ${orgId} and id = ${lifecycle.planVersionId}::uuid limit 1`)).rows[0];
    if (!pinned) throw new Error("the subscription lifecycle names a plan version that is gone — data repair is required before entitlements can resolve");
    version = pinned;
  } else {
    version = latest ? { id: latest.id, versionNumber: null } : null;
    if (version && latest) {
      const numbered = (await db.execute<{ versionNumber: number }>(sql`
        select version_number as "versionNumber" from subscription_plan_versions
         where org_id = ${orgId} and id = ${latest.id}::uuid limit 1`)).rows[0];
      version.versionNumber = numbered?.versionNumber ?? null;
    }
  }
  const grandfathered = lifecycle ? (latest?.id ?? null) !== lifecycle.planVersionId : false;
  const features = (await db.execute<SaasFeature>(sql`
    select ${FEATURE_COLUMNS} from saas_features f
      left join usage_meters m on m.org_id = f.org_id and m.id = f.meter_id
     where f.org_id = ${orgId} and f.is_active order by f.key`)).rows;
  const rawPlanRows = version
    ? (await db.execute<PlanRow & { featureId: string }>(sql`
      select e.feature_id as "featureId", e.enabled,
             e.limit_qty::text as "limitQty", e.custom_value as "customValue",
             e.overage_policy as "overagePolicy", m.key as "meterKey"
        from subscription_plan_version_entitlements e
        left join usage_meters m on m.org_id = e.org_id and m.id = e.meter_id
       where e.org_id = ${orgId} and e.plan_version_id = ${version.id}::uuid
         and e.effective_from <= ${asOf}::date and (e.effective_to is null or e.effective_to > ${asOf}::date)`)).rows
    : [];
  const planRows = rawPlanRows.map((row) => ({ ...row, limitQty: canonQty(row.limitQty) }));
  const rawOverrideRows = (await db.execute<OverrideRow & { featureId: string }>(sql`
    select o.feature_id as "featureId", o.enabled,
           o.limit_qty::text as "limitQty", o.custom_value as "customValue",
           o.overage_policy as "overagePolicy"
      from subscription_entitlement_overrides o
     where o.org_id = ${orgId} and o.subscription_id = ${sub.id}::uuid
       and o.effective_from <= ${asOf}::date and (o.effective_to is null or o.effective_to > ${asOf}::date)`)).rows;
  const overrideRows = rawOverrideRows.map((row) => ({ ...row, limitQty: canonQty(row.limitQty) }));
  const planByFeature = new Map(planRows.map((row) => [row.featureId, row]));
  const overrideByFeature = new Map(overrideRows.map((row) => [row.featureId, row]));
  const resolvedFeatures: ResolvedEntitlement[] = features.map((feature) => {
    const plan = planByFeature.get(feature.id);
    const override = overrideByFeature.get(feature.id);
    return {
      featureId: feature.id,
      featureKey: feature.key,
      featureType: feature.featureType,
      unit: feature.unit,
      meterKey: plan?.meterKey ?? feature.meterKey,
      enabled: override?.enabled ?? plan?.enabled ?? false,
      limit: override?.limitQty ?? plan?.limitQty ?? null,
      customValue: override?.customValue ?? plan?.customValue ?? null,
      overagePolicy: override?.overagePolicy ?? plan?.overagePolicy ?? "block",
      source: override ? "override" : "plan",
      planVersionId: version?.id ?? null,
    };
  });
  const resolved: ResolvedSubscriptionEntitlements = {
    subscriptionId: sub.id,
    customerId: sub.customerId,
    status: sub.status,
    planId: sub.planId,
    planVersionId: version?.id ?? null,
    planVersionNumber: version?.versionNumber ?? null,
    grandfathered,
    features: resolvedFeatures,
  };
  const sourceHash = hashResolution({
    sub: { planId: sub.planId, status: sub.status },
    versionId: version?.id ?? null,
    plan: [...planByFeature.values()],
    overrides: [...overrideByFeature.values()],
    features: features.map((feature) => feature.id),
  });
  return { resolved, sourceHash };
}

export async function resolveEntitlements(
  orgId: string,
  subject: { subscriptionId: string } | { customerId: string },
  at?: string,
): Promise<ResolvedSubscriptionEntitlements[]> {
  return withOrg(orgId, async () => {
    await requireEntitlementsRead(orgId);
    const asOf = at === undefined ? await businessToday(orgId) : dateText(at, "at");
    let subs: SubscriptionHead[];
    if ("subscriptionId" in subject) {
      subs = [await loadSubscriptionHead(orgId, subject.subscriptionId)];
    } else {
      const customerId = uuidText(subject.customerId, "customer_id");
      const customer = (await db.execute<{ id: string }>(sql`
        select id from parties where org_id = ${orgId} and id = ${customerId}::uuid`)).rows[0];
      if (!customer) throw new ScopeNotFoundError();
      subs = (await db.execute<SubscriptionHead>(sql`
        select id, customer_id as "customerId", plan_id as "planId", status
          from subscriptions where org_id = ${orgId} and customer_id = ${customerId}::uuid order by id`)).rows;
    }
    const out: ResolvedSubscriptionEntitlements[] = [];
    for (const sub of subs) {
      out.push((await resolveSubscription(orgId, sub, asOf)).resolved);
    }
    return out;
  });
}

export interface EntitlementSnapshot {
  subscriptionId: string;
  planVersionId: string | null;
  planVersionNumber: number | null;
  grandfathered: boolean;
  features: ResolvedEntitlement[];
  sourceHash: string;
  resolvedAt: string;
}

/** Refresh the cached snapshot after any input change. The caller holds the feature lock; the snapshot commits with the change or rolls back with it. */
export async function refreshEntitlementSnapshot(
  orgId: string,
  subscriptionId: string,
  actor: string | null,
): Promise<EntitlementSnapshot> {
  return withOrg(orgId, async () => {
    await requireEntitlementsRead(orgId);
    const sub = await loadSubscriptionHead(orgId, subscriptionId);
    const asOf = await businessToday(orgId);
    const { resolved, sourceHash } = await resolveSubscription(orgId, sub, asOf);
    const stored = (await db.execute<{ snapshot: ResolvedEntitlement[]; sourceHash: string; resolvedAt: string }>(sql`
      insert into subscription_entitlement_snapshots
        (org_id, subscription_id, snapshot, source_hash, resolved_at, created_by, updated_by)
      values (${orgId}, ${sub.id}::uuid, ${JSON.stringify(resolved.features)}::jsonb,
              ${sourceHash}, now(), ${actor}::uuid, ${actor}::uuid)
      on conflict (org_id, subscription_id) do update
         set snapshot = excluded.snapshot, source_hash = excluded.source_hash,
             resolved_at = now(), updated_at = now(), updated_by = excluded.updated_by
      returning snapshot as "snapshot", source_hash as "sourceHash",
                resolved_at::text as "resolvedAt"`)).rows[0];
    if (!stored) throw new Error("entitlement snapshot upsert returned no row");
    return {
      subscriptionId: sub.id,
      planVersionId: resolved.planVersionId,
      planVersionNumber: resolved.planVersionNumber,
      grandfathered: resolved.grandfathered,
      features: stored.snapshot,
      sourceHash: stored.sourceHash,
      resolvedAt: stored.resolvedAt,
    };
  });
}

/** Fast path: serve the snapshot, recomputing only when its inputs changed underneath it. Historical queries bypass the cache and resolve live. */
export async function getEntitlementSnapshot(
  orgId: string,
  subscriptionId: string,
  at?: string,
): Promise<EntitlementSnapshot> {
  return withOrg(orgId, async () => {
    await requireEntitlementsRead(orgId);
    const sub = await loadSubscriptionHead(orgId, subscriptionId);
    if (at !== undefined) {
      const asOf = dateText(at, "at");
      const { resolved, sourceHash } = await resolveSubscription(orgId, sub, asOf);
      return {
        subscriptionId: sub.id,
        planVersionId: resolved.planVersionId,
        planVersionNumber: resolved.planVersionNumber,
        grandfathered: resolved.grandfathered,
        features: resolved.features,
        sourceHash,
        resolvedAt: new Date().toISOString(),
      };
    }
    const asOf = await businessToday(orgId);
    const { resolved, sourceHash } = await resolveSubscription(orgId, sub, asOf);
    const cached = (await db.execute<{ snapshot: ResolvedEntitlement[]; sourceHash: string; resolvedAt: string }>(sql`
      select snapshot as "snapshot", source_hash as "sourceHash", resolved_at::text as "resolvedAt"
        from subscription_entitlement_snapshots
       where org_id = ${orgId} and subscription_id = ${sub.id}::uuid limit 1`)).rows[0];
    if (cached && cached.sourceHash === sourceHash) {
      return {
        subscriptionId: sub.id,
        planVersionId: resolved.planVersionId,
        planVersionNumber: resolved.planVersionNumber,
        grandfathered: resolved.grandfathered,
        features: cached.snapshot,
        sourceHash: cached.sourceHash,
        resolvedAt: cached.resolvedAt,
      };
    }
    return refreshEntitlementSnapshot(orgId, sub.id, null);
  });
}

export interface CheckEntitlementInput {
  subscriptionId: string;
  featureKey: string;
  used?: unknown;
  occurredOn?: string;
}

export interface EntitlementVerdict {
  subscriptionId: string;
  featureKey: string;
  featureType: SaasFeatureType;
  allowed: boolean;
  enabled: boolean;
  limit: string | null;
  used: string | null;
  overage: string | null;
  overagePolicy: EntitlementOveragePolicy;
  source: EntitlementSource;
  usageRecordId: string | null;
  replayed: boolean;
}

const OVERAGE_NOTICE_KIND = "entitlement-overage";

/**
 * Overage alert recipients: whoever can act on it — active super-admins
 * plus active holders of a role directly granting ar.create (the
 * subscription write surface). A notice target is not an authz decision,
 * so wildcard grants stay out of scope here.
 */
async function notifyEntitlementOverage(
  orgId: string,
  actor: string,
  input: {
    subscriptionId: string;
    customerLabel: string;
    featureKey: string;
    used: string;
    limit: string;
    overage: string;
  },
): Promise<number> {
  const href = `/collections?subscription=${input.subscriptionId}&feature=${input.featureKey}`;
  const recipients = (await db.execute<{ id: string }>(sql`
    select distinct u.id::text as id
      from users u
      left join role_assignments a on a.user_id = u.id and a.org_id = u.org_id
      left join app_roles r on r.id = a.role_id and r.org_id = a.org_id
     where u.org_id = ${orgId} and u.is_active
       and (u.is_super_admin or (r.permissions ? 'ar.create'))`)).rows;
  const title = `${input.customerLabel} is over its ${input.featureKey} limit (${input.used} of ${input.limit} used)`;
  const body =
    `Subscription ${input.subscriptionId} used ${input.used} against an included limit of ${input.limit} ` +
    `for feature ${input.featureKey} (over by ${input.overage}). ` +
    `Raise the included limit with a subscription override, or move the subscription to a larger plan version.`;
  let written = 0;
  for (const recipient of recipients) {
    const existing = (await db.execute<{ one: number }>(sql`
      select 1 as one from notifications
       where org_id = ${orgId} and user_id = ${recipient.id}::uuid
         and kind = ${OVERAGE_NOTICE_KIND} and href = ${href} and read_at is null
       limit 1`)).rows[0];
    if (existing) continue;
    // Same columns as the shared writeNotification path (kind, title,
    // body, href, org + user scope) — see engine/src/inbox/adapters/
    // notification.ts: the row surfaces in /notifications and as an inbox
    // item with zero extra plumbing. Inlined (not imported) so the billing
    // module gains no inbox edge; sftp and hrm alerts use the same
    // convention.
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into notifications (org_id, user_id, kind, title, body, href, created_by, updated_by)
      values (${orgId}, ${recipient.id}::uuid, ${OVERAGE_NOTICE_KIND}, ${title}, ${body}, ${href},
              ${actor}::uuid, ${actor}::uuid)
      returning id`)).rows[0]?.id;
    if (!inserted) throw new Error("the overage notice was not stored — no row was written; retry the action");
    written += 1;
  }
  return written;
}

type OverageBilling = { usageRecordId: string; replayed: boolean };

async function billEntitlementOverage(
  orgId: string,
  actor: string,
  input: {
    sub: SubscriptionHead;
    featureKey: string;
    meterKey: string;
    occurredOn: string;
    overage: string;
  },
): Promise<OverageBilling> {
  await acquireOrgFeatureGateLock(db, orgId);
  if (!(await lockAndCheckOrgFeature(db, orgId, "usageBilling"))) {
    refuse(
      "entitlement_usage_billing_off",
      `Feature ${input.featureKey} bills its overage, but usage billing is turned off.`,
      "Enable Usage Billing in Company Settings → Features before rating overage.",
      "overage_policy",
    );
  }
  const meterId = await resolveMeterKey(orgId, input.meterKey, "meter_key");
  const links = await listSubscriptionUsageLinks(orgId, { subscriptionId: input.sub.id });
  const covering = links.some((link) => {
    const meters: readonly string[] = link.meterIds as readonly string[];
    if (!meters.includes(meterId)) return false;
    if (link.effectiveFrom > input.occurredOn) return false;
    if (link.effectiveTo !== null && link.effectiveTo < input.occurredOn) return false;
    return true;
  });
  if (!covering) {
    refuse(
      "entitlement_overage_unlinked",
      `Meter ${input.meterKey} has no usage link for this subscription, so the overage cannot reach rating.`,
      "Create a subscription usage link covering this meter for the subscription, then re-check.",
      "meter_key",
    );
  }
  const period = input.occurredOn.slice(0, 7);
  const base = `entitlement-overage:${input.sub.id}:${input.featureKey}:${period}`;
  const live = (await db.execute<{ id: string; quantity: string }>(sql`
    select r.id, r.quantity::text as quantity
      from usage_records r
     where r.org_id = ${orgId} and r.meter_id = ${meterId}::uuid
       and r.subscription_id = ${input.sub.id}::uuid and r.source = 'api' and r.source_ref = ${base}
       and r.reverses_id is null
       and not exists (select 1 from usage_records v where v.org_id = r.org_id and v.reverses_id = r.id)
     order by r.occurred_on desc, r.created_at desc limit 1`)).rows[0];
  if (live && compareDecimal(live.quantity, input.overage) === 0) {
    return { usageRecordId: live.id, replayed: true };
  }
  if (live) {
    try {
      await reverseUsageRecord(
        orgId,
        actor,
        live.id,
        `Superseded by a newer entitlement overage reading for ${input.featureKey}.`,
        input.occurredOn,
      );
    } catch (error) {
      // A concurrent check already replaced this reading: serve its row
      // instead of failing the replay.
      if (error instanceof UsageBillingError && error.code === "usage_record_already_reversed") {
        const current = (await db.execute<{ id: string }>(sql`
          select r.id from usage_records r
           where r.org_id = ${orgId} and r.meter_id = ${meterId}::uuid
             and r.subscription_id = ${input.sub.id}::uuid and r.source = 'api' and r.source_ref = ${base}
             and r.reverses_id is null
             and not exists (select 1 from usage_records v where v.org_id = r.org_id and v.reverses_id = r.id)
           order by r.occurred_on desc, r.created_at desc limit 1`)).rows[0];
        if (current) return { usageRecordId: current.id, replayed: true };
      }
      throw error;
    }
  }
  const prior = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from usage_records
     where org_id = ${orgId} and meter_id = ${meterId}::uuid and source_ref = ${base}`)).rows[0]?.n ?? 0;
  const inserted = await ingestUsageRecords(orgId, actor, [{
    meterKey: input.meterKey,
    customerId: input.sub.customerId,
    subscriptionId: input.sub.id,
    occurredOn: input.occurredOn,
    quantity: input.overage,
    source: "api",
    sourceRef: base,
    idempotencyKey: `${base}:v${prior + 1}`,
  }]);
  const record = inserted[0];
  if (!record) throw new Error("overage usage insert returned no row");
  return { usageRecordId: record.id, replayed: false };
}

/**
 * Evaluate one feature against reported usage. Pure checks (boolean,
 * within-limit, block) write nothing; allow_and_bill records the overage
 * as a usage record so the next rating run bills it; alert notifies the
 * billing operators once per subscription and feature while unread.
 */
export async function checkEntitlement(
  orgId: string,
  actor: string,
  input: CheckEntitlementInput,
): Promise<EntitlementVerdict> {
  return withOrg(orgId, async () => {
    await requireEntitlementsRead(orgId);
    const sub = await loadSubscriptionHead(orgId, input.subscriptionId);
    const occurredOn = input.occurredOn === undefined ? await businessToday(orgId) : dateText(input.occurredOn, "occurred_on");
    const { resolved } = await resolveSubscription(orgId, sub, occurredOn);
    const key = featureKeyText(input.featureKey, "feature_key");
    const feature = resolved.features.find((entry) => entry.featureKey === key);
    if (!feature) {
      refuse("entitlement_feature_not_found", `No feature has key ${key} in this organization.`, CATALOG_REMEDY, "feature_key", 404);
    }
    const base = {
      subscriptionId: sub.id,
      featureKey: feature.featureKey,
      featureType: feature.featureType,
      enabled: feature.enabled,
      limit: feature.limit,
      used: null as string | null,
      overage: null as string | null,
      overagePolicy: feature.overagePolicy,
      source: feature.source,
      usageRecordId: null as string | null,
      replayed: false,
    };
    if (feature.featureType === "boolean" || feature.featureType === "custom") {
      return { ...base, allowed: feature.enabled };
    }
    if (input.used === undefined) {
      refuse("entitlement_used_required", `Checking ${key} needs the consumed quantity.`, "Provide the consumed quantity in used.", "used");
    }
    const used = quantityText(input.used, "used");
    if (!feature.enabled) {
      return { ...base, allowed: false, used, overage: used };
    }
    if (feature.limit === null) {
      refuse(
        "entitlement_limit_missing",
        `Feature ${key} is enabled with no included limit — the grant is incomplete.`,
        "Re-save the plan grant or override with an included limit.",
        "limit",
      );
    }
    if (compareDecimal(used, feature.limit) <= 0) {
      return { ...base, allowed: true, used, overage: "0" };
    }
    const rawOverage = (await db.execute<{ overage: string }>(sql`
      select (${used}::numeric - ${feature.limit}::numeric)::text as overage`)).rows[0]?.overage;
    const overage = rawOverage == null ? null : canonQty(rawOverage);
    if (!overage) throw new Error("overage subtraction returned no row");
    if (feature.overagePolicy === "block") {
      return { ...base, allowed: false, used, overage };
    }
    if (feature.overagePolicy === "alert") {
      const customer = (await db.execute<{ label: string | null }>(sql`
        select display_name as label from parties
         where org_id = ${orgId} and id = ${sub.customerId}::uuid`)).rows[0];
      await notifyEntitlementOverage(orgId, actor, {
        subscriptionId: sub.id,
        customerLabel: customer?.label ?? "A subscription",
        featureKey: key,
        used,
        limit: feature.limit,
        overage,
      });
      return { ...base, allowed: true, used, overage };
    }
    if (feature.meterKey === null) {
      refuse("entitlement_meter_required", `Metered feature ${key} resolves usage through a meter, and none is linked.`, "Link a usage meter on the feature or on its grant.", "meter_key");
    }
    const billed = await billEntitlementOverage(orgId, actor, {
      sub,
      featureKey: key,
      meterKey: feature.meterKey,
      occurredOn,
      overage,
    });
    return { ...base, allowed: true, used, overage, usageRecordId: billed.usageRecordId, replayed: billed.replayed };
  });
}
