import { sql, type SQL } from "drizzle-orm";
import { USAGE_AGGREGATIONS, USAGE_RECORD_SOURCES, type usageMeters, type usageRecords } from "@openbooks/schema";
import { cmp, neg, wholeDigits } from "../../money/money.ts";
import { parseQuantity } from "../../money/brands.ts";
import { assertPeriodModulesOpen, CloseError } from "../../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../../periods/period-resolution.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows, subsidiaryVisibleFilter } from "../../organization/subsidiary-scope.ts";
import { db, withOrg } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import { UsageBillingError } from "./errors.ts";

export type UsageAggregation = (typeof USAGE_AGGREGATIONS)[number];
export type UsageRecordSource = (typeof USAGE_RECORD_SOURCES)[number];
export type UsageMeter = typeof usageMeters.$inferSelect;
export type UsageRecord = typeof usageRecords.$inferSelect;
export type UsageSubsidiaryScope = ReadonlySet<string> | null;

export interface CreateUsageMeterInput {
  key: string;
  name: string;
  unit: string;
  aggregation: UsageAggregation;
  itemId?: string | null;
}

export interface UpdateUsageMeterInput {
  key?: string;
  name?: string;
  unit?: string;
  aggregation?: UsageAggregation;
  itemId?: string | null;
}

export interface IngestUsageRecordInput {
  meterKey: string;
  customerId: string;
  subscriptionId?: string | null;
  occurredOn: string;
  quantity: unknown;
  distinctKey?: string | null;
  source: UsageRecordSource;
  sourceRef?: string | null;
  idempotencyKey: string;
}

const FEATURE_REMEDY = "Enable Usage Billing in Company Settings → Features.";
const METER_CHANGE_REMEDY = "Create a new meter and deactivate this one.";

const METER_COLUMNS = sql`
  id, org_id as "orgId", key, name, unit, aggregation, item_id as "itemId",
  is_active as "isActive", created_at as "createdAt", created_by as "createdBy",
  updated_at as "updatedAt", updated_by as "updatedBy"`;

const RECORD_COLUMNS = sql`
  id, org_id as "orgId", meter_id as "meterId", customer_id as "customerId",
  subscription_id as "subscriptionId", occurred_on::text as "occurredOn", quantity::text as quantity,
  distinct_key as "distinctKey", source, source_ref as "sourceRef",
  idempotency_key as "idempotencyKey", reverses_id as "reversesId",
  reversal_reason as "reversalReason", created_by as "createdBy", created_at as "createdAt"`;

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
    refuse("usage_input_required", `${field} is required.`, `Provide a non-empty ${field}.`, field);
  }
  return value.trim();
}

function uuidText(value: unknown, field: string): string {
  const candidate = requiredText(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) {
    refuse("usage_uuid_invalid", `${field} must be a UUID.`, `Provide a valid ${field} from this organization.`, field);
  }
  return candidate;
}

function dateText(value: unknown, field = "occurred_on"): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    refuse("usage_date_invalid", `${field} must be a real calendar date in YYYY-MM-DD form.`, `Provide a valid ${field} in YYYY-MM-DD form.`, field);
  }
  return value;
}

function normalizeQuantity(value: unknown): string {
  let quantity: string;
  try {
    quantity = parseQuantity(value);
  } catch {
    refuse(
      "usage_quantity_invalid",
      "Usage quantity must be an exact positive decimal with no more than 8 decimal places.",
      "Send a positive decimal quantity with no more than 8 decimal places.",
      "quantity",
    );
  }
  if (cmp(quantity, "0") <= 0) {
    refuse(
      "usage_quantity_invalid",
      "Usage quantity must be greater than zero.",
      "Send a positive decimal quantity with no more than 8 decimal places.",
      "quantity",
    );
  }
  if (wholeDigits(quantity) > 20) {
    refuse(
      "usage_quantity_invalid",
      "Usage quantity exceeds the supported numeric(28,8) range.",
      "Send a positive decimal that fits numeric(28,8) with no more than 8 decimal places.",
      "quantity",
    );
  }
  return quantity;
}

function uniqueViolationFor(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === constraint;
}

async function validateMeterItem(orgId: string, itemId: string | null | undefined): Promise<void> {
  if (itemId == null) return;
  const safeItemId = uuidText(itemId, "item_id");
  const item = (await db.execute<{ id: string }>(sql`
    select id from items where org_id = ${orgId} and id = ${safeItemId}`)).rows[0];
  if (!item) {
    refuse(
      "usage_meter_item_unavailable",
      "The selected billing item does not belong to this organization.",
      "Choose an item from this organization or leave the meter unassigned until it bills.",
      "item_id",
    );
  }
}

export async function createUsageMeter(
  orgId: string,
  actor: string,
  input: CreateUsageMeterInput,
): Promise<UsageMeter> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const key = requiredText(input.key, "key");
    const name = requiredText(input.name, "name");
    const unit = requiredText(input.unit, "unit");
    if (!USAGE_AGGREGATIONS.includes(input.aggregation)) {
      refuse("usage_aggregation_invalid", "The usage aggregation is not supported.", "Choose a supported meter aggregation.", "aggregation");
    }
    await validateMeterItem(orgId, input.itemId);

    // A key collision is an expected unique-index outcome; turn the no-row insert into a named refusal.
    const inserted = await db.execute<UsageMeter>(sql`
      insert into usage_meters
        (org_id, key, name, unit, aggregation, item_id, is_active, created_by, updated_by)
      values
        (${orgId}, ${key}, ${name}, ${unit}, ${input.aggregation}, ${input.itemId ?? null}, true, ${actor}, ${actor})
      on conflict (org_id, key) do nothing
      returning ${METER_COLUMNS}`);
    if (inserted.rows.length === 1) return inserted.rows[0]!;
    if (inserted.rows.length !== 0) {
      throw new Error("usage meter insert returned an unexpected number of rows");
    }
    refuse(
      "usage_meter_key_in_use",
      `A usage meter with key ${key} already exists in this organization.`,
      "Choose a different meter key.",
      "key",
      409,
    );
  });
}

export async function updateUsageMeter(
  orgId: string,
  actor: string,
  meterId: string,
  input: UpdateUsageMeterInput,
): Promise<UsageMeter> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const safeMeterId = uuidText(meterId, "meter_id");
    const current = (await db.execute<UsageMeter>(sql`
      select ${METER_COLUMNS} from usage_meters
       where org_id = ${orgId} and id = ${safeMeterId}
       for update`)).rows[0];
    if (!current) {
      refuse("usage_meter_not_found", "The usage meter does not exist in this organization.", "Choose a usage meter from this organization.", "meter_id");
    }

    const changes: SQL[] = [];
    const key = input.key === undefined ? undefined : requiredText(input.key, "key");
    const name = input.name === undefined ? undefined : requiredText(input.name, "name");
    const unit = input.unit === undefined ? undefined : requiredText(input.unit, "unit");
    if (input.aggregation !== undefined && !USAGE_AGGREGATIONS.includes(input.aggregation)) {
      refuse("usage_aggregation_invalid", "The usage aggregation is not supported.", "Choose a supported meter aggregation.", "aggregation");
    }
    const keyChanged = key !== undefined && key !== current.key;
    const aggregationChanged = input.aggregation !== undefined && input.aggregation !== current.aggregation;
    if (keyChanged || aggregationChanged) {
      const priorRecord = (await db.execute<{ id: string }>(sql`
        select id from usage_records where org_id = ${orgId} and meter_id = ${safeMeterId} limit 1`)).rows[0];
      if (priorRecord) {
        refuse(
          "usage_meter_identity_locked",
          "A meter key or aggregation cannot change after usage evidence exists.",
          METER_CHANGE_REMEDY,
          keyChanged ? "key" : "aggregation",
          409,
        );
      }
    }

    if (key !== undefined) changes.push(sql`key = ${key}`);
    if (name !== undefined) changes.push(sql`name = ${name}`);
    if (unit !== undefined) changes.push(sql`unit = ${unit}`);
    if (input.aggregation !== undefined) changes.push(sql`aggregation = ${input.aggregation}`);
    if (input.itemId !== undefined) {
      await validateMeterItem(orgId, input.itemId);
      changes.push(sql`item_id = ${input.itemId}`);
    }
    if (changes.length === 0) {
      refuse("usage_meter_update_empty", "No meter changes were supplied.", "Change at least one meter field.");
    }
    changes.push(sql`updated_at = now()`, sql`updated_by = ${actor}`);

    try {
      const updated = await db.execute<UsageMeter>(sql`
        update usage_meters set ${sql.join(changes, sql`, `)}
         where org_id = ${orgId} and id = ${safeMeterId}
        returning ${METER_COLUMNS}`);
      if (updated.rows.length !== 1) {
        refuse("usage_meter_not_found", "The usage meter could not be updated.", "Choose a usage meter from this organization.", "meter_id");
      }
      return updated.rows[0]!;
    } catch (error) {
      if (error instanceof UsageBillingError) throw error;
      if (uniqueViolationFor(error, "usage_meters_org_key_unique")) {
        refuse("usage_meter_key_in_use", `A usage meter with key ${key} already exists in this organization.`, "Choose a different meter key.", "key", 409);
      }
      throw error;
    }
  });
}

async function setMeterActive(
  orgId: string,
  actor: string,
  meterId: string,
  isActive: boolean,
): Promise<UsageMeter> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const safeMeterId = uuidText(meterId, "meter_id");
    const changed = await db.execute<UsageMeter>(sql`
      update usage_meters
         set is_active = ${isActive}, updated_at = now(), updated_by = ${actor}
       where org_id = ${orgId} and id = ${safeMeterId}
      returning ${METER_COLUMNS}`);
    if (changed.rows.length !== 1) {
      refuse("usage_meter_not_found", "The usage meter does not exist in this organization.", "Choose a usage meter from this organization.", "meter_id");
    }
    return changed.rows[0]!;
  });
}

export function deactivateUsageMeter(orgId: string, actor: string, meterId: string): Promise<UsageMeter> {
  return setMeterActive(orgId, actor, meterId, false);
}

export function reactivateUsageMeter(orgId: string, actor: string, meterId: string): Promise<UsageMeter> {
  return setMeterActive(orgId, actor, meterId, true);
}

async function requireOpenArPeriod(
  orgId: string,
  customerSubsidiaryId: string | null,
  occurredOn: string,
): Promise<void> {
  const period = await resolveCoveringPeriod(db, orgId, occurredOn);
  if (!period) {
    refuse(
      "usage_period_missing",
      `No active accounting period covers ${occurredOn}.`,
      "Date the usage correction in an open AR period.",
      "occurred_on",
    );
  }
  const books = (await db.execute<{ id: string }>(sql`
    select id from accounting_books
     where org_id = ${orgId} and is_active and is_primary and posts_gl
     order by id limit 2`)).rows;
  if (books.length !== 1) {
    refuse(
      "usage_primary_book_unavailable",
      "Usage cannot be checked because this organization does not have exactly one active primary accounting book.",
      "Configure one active primary accounting book, then retry the usage correction.",
    );
  }
  try {
    await assertPeriodModulesOpen(db, {
      orgId,
      periodId: period.id,
      bookId: books[0]!.id,
      subsidiaryIds: customerSubsidiaryId ? [customerSubsidiaryId] : [],
      modules: ["ar"],
    });
  } catch (error) {
    if (!(error instanceof CloseError)) throw error;
    refuse(
      "usage_period_closed",
      `Usage dated ${occurredOn} falls in a closed AR period.`,
      "Date the correction in an open AR period.",
      "occurred_on",
    );
  }
}

async function customerSubsidiary(
  orgId: string,
  customerId: string,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<string | null> {
  const customer = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select id, subsidiary_id from parties p where org_id = ${orgId} and id = ${customerId}
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
      for share`)).rows[0];
  if (!customer || !subsidiaryScopeAllows(allowedSubsidiaryIds, customer.subsidiary_id, { orgWideNull: true })) throw new ScopeNotFoundError();
  return customer.subsidiary_id;
}

async function validateSubscriptionCustomer(
  orgId: string,
  subscriptionId: string | null | undefined,
  customerId: string,
): Promise<void> {
  if (subscriptionId == null) return;
  const subscription = (await db.execute<{ id: string }>(sql`
    select id from subscriptions
     where org_id = ${orgId} and id = ${subscriptionId} and customer_id = ${customerId}`)).rows[0];
  if (!subscription) {
    refuse(
      "usage_subscription_customer_mismatch",
      "The selected subscription does not belong to the selected customer in this organization.",
      "Choose a subscription owned by this customer or omit the subscription reference.",
      "subscription_id",
    );
  }
}

function validateDistinctKey(aggregation: UsageAggregation, value: string | null | undefined): string | null {
  const supplied = value !== null && value !== undefined;
  if (aggregation === "unique_count") {
    if (typeof value !== "string" || !value.trim()) {
      refuse(
        "usage_distinct_key_required",
        "A unique_count meter requires a distinct_key on every usage record.",
        "Provide the end-user or entity identifier in distinct_key for this unique_count meter.",
        "distinct_key",
      );
    }
    return value;
  }
  if (supplied) {
    refuse(
      "usage_distinct_key_unexpected",
      `A ${aggregation} meter does not accept distinct_key.`,
      `Remove distinct_key because this meter uses ${aggregation} aggregation.`,
      "distinct_key",
    );
  }
  return null;
}

export async function ingestUsageRecords(
  orgId: string,
  actor: string,
  records: readonly IngestUsageRecordInput[],
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<UsageRecord[]> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const insertedRecords: UsageRecord[] = [];
    for (const input of records) {
      const meterKey = requiredText(input.meterKey, "meter_key");
      const idempotencyKey = requiredText(input.idempotencyKey, "idempotency_key");
      const customerId = uuidText(input.customerId, "customer_id");
      const subsidiaryId = await customerSubsidiary(orgId, customerId, allowedSubsidiaryIds);
      const meter = (await db.execute<{
        id: string;
        aggregation: UsageAggregation;
        is_active: boolean;
      }>(sql`
        select id, aggregation, is_active from usage_meters
         where org_id = ${orgId} and key = ${meterKey}
         for share`)).rows[0];
      if (!meter) {
        refuse(
          "usage_meter_unknown",
          `No usage meter has key ${meterKey}.`,
          "Create the meter or correct the sender's meter key.",
          "meter_key",
        );
      }

      const replay = (await db.execute<UsageRecord>(sql`
        select ${RECORD_COLUMNS} from usage_records
         where org_id = ${orgId} and meter_id = ${meter.id} and idempotency_key = ${idempotencyKey}
           and exists (select 1 from parties c where c.org_id = usage_records.org_id and c.id = usage_records.customer_id
             ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })})`)).rows[0];
      if (replay) {
        insertedRecords.push(replay);
        continue;
      }
      if (!meter.is_active) {
        refuse(
          "usage_meter_inactive",
          `Usage meter ${meterKey} is inactive.`,
          "Reactivate the meter or send usage to its replacement.",
          "meter_key",
        );
      }

      const occurredOn = dateText(input.occurredOn);
      const quantity = normalizeQuantity(input.quantity);
      const distinctKey = validateDistinctKey(meter.aggregation, input.distinctKey);
      if (!USAGE_RECORD_SOURCES.includes(input.source)) {
        refuse("usage_source_invalid", "The usage record source is not supported.", "Choose a supported usage record source.", "source");
      }
      const sourceRef = input.sourceRef ?? null;
      const subscriptionId = input.subscriptionId == null ? null : uuidText(input.subscriptionId, "subscription_id");
      await validateSubscriptionCustomer(orgId, subscriptionId, customerId);
      await requireOpenArPeriod(orgId, subsidiaryId, occurredOn);

      // The unique key makes simultaneous sender retries converge on one immutable evidence row.
      const inserted = await db.execute<UsageRecord>(sql`
        insert into usage_records
          (org_id, meter_id, customer_id, subscription_id, occurred_on, quantity,
           distinct_key, source, source_ref, idempotency_key, created_by)
        values
          (${orgId}, ${meter.id}, ${customerId}, ${subscriptionId}, ${occurredOn}, ${quantity},
           ${distinctKey}, ${input.source}, ${sourceRef}, ${idempotencyKey}, ${actor})
        on conflict (org_id, meter_id, idempotency_key) do nothing
        returning ${RECORD_COLUMNS}`);
      if (inserted.rows.length === 1) {
        insertedRecords.push(inserted.rows[0]!);
        continue;
      }
      if (inserted.rows.length !== 0) {
        throw new Error("usage record insert returned an unexpected number of rows");
      }
      const racedReplay = (await db.execute<UsageRecord>(sql`
        select ${RECORD_COLUMNS} from usage_records
         where org_id = ${orgId} and meter_id = ${meter.id} and idempotency_key = ${idempotencyKey}
           and exists (select 1 from parties c where c.org_id = usage_records.org_id and c.id = usage_records.customer_id
             ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })})`)).rows[0];
      if (!racedReplay) {
        refuse(
          "usage_idempotency_result_missing",
          "The usage idempotency key conflicted but its stored record could not be read.",
          "Retry the same request with the same idempotency key.",
          "idempotency_key",
          409,
        );
      }
      insertedRecords.push(racedReplay);
    }
    return insertedRecords;
  });
}

export async function reverseUsageRecord(
  orgId: string,
  actor: string,
  recordId: string,
  reason: string,
  occurredOn?: string,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<UsageRecord> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const safeRecordId = uuidText(recordId, "record_id");
    const original = (await db.execute<{
      id: string;
      meter_id: string;
      customer_id: string;
      subscription_id: string | null;
      occurred_on: string;
      quantity: string;
      distinct_key: string | null;
      reverses_id: string | null;
      subsidiary_id: string | null;
    }>(sql`
      select r.id, r.meter_id, r.customer_id, r.subscription_id, r.occurred_on::text as occurred_on,
             r.quantity::text as quantity, r.distinct_key, r.reverses_id, c.subsidiary_id
        from usage_records r join parties c on c.org_id = r.org_id and c.id = r.customer_id
       where r.org_id = ${orgId} and r.id = ${safeRecordId}
         ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       for update of r, c`)).rows[0];
    if (!original || !subsidiaryScopeAllows(allowedSubsidiaryIds, original.subsidiary_id, { orgWideNull: true })) throw new ScopeNotFoundError();
    if (original.reverses_id !== null) {
      refuse(
        "usage_reversal_not_reversible",
        "A reversal record cannot itself be reversed.",
        "Reverse the original usage record; reversing a reversal is not supported.",
        "record_id",
        409,
      );
    }
    const priorReversal = (await db.execute<{ id: string }>(sql`
      select id from usage_records where org_id = ${orgId} and reverses_id = ${safeRecordId} limit 1`)).rows[0];
    if (priorReversal) {
      refuse(
        "usage_record_already_reversed",
        "This usage record already has a reversal.",
        "Use the existing reversal record; an original usage record can be reversed only once.",
        "record_id",
        409,
      );
    }
    const reversalReason = requiredText(reason, "reason");
    const reversalDate = dateText(occurredOn ?? (await businessToday(orgId)));
    await requireOpenArPeriod(orgId, original.subsidiary_id, reversalDate);
    const reversedQuantity = neg(parseQuantity(original.quantity));

    const inserted = await db.execute<UsageRecord>(sql`
      insert into usage_records
        (org_id, meter_id, customer_id, subscription_id, occurred_on, quantity,
         distinct_key, source, idempotency_key, reverses_id, reversal_reason, created_by)
      values
        (${orgId}, ${original.meter_id}, ${original.customer_id}, ${original.subscription_id},
         ${reversalDate}, ${reversedQuantity}, ${original.distinct_key}, 'manual',
         ${`reversal:${safeRecordId}`}, ${safeRecordId}, ${reversalReason}, ${actor})
      returning ${RECORD_COLUMNS}`);
    if (inserted.rows.length !== 1) {
      refuse(
        "usage_reversal_insert_missing",
        "The reversal was not saved.",
        "Retry the reversal after confirming the original usage record is still available.",
        "record_id",
      );
    }
    return inserted.rows[0]!;
  });
}

export async function listUsageRecordsForWindow(
  orgId: string,
  meterId: string,
  customerId: string,
  from: string,
  to: string,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<UsageRecord[]> {
  return withOrg(orgId, async () => {
    await requireUsageBillingRead(orgId);
    const safeMeterId = uuidText(meterId, "meter_id");
    const safeCustomerId = uuidText(customerId, "customer_id");
    const fromDate = dateText(from, "from");
    const toDate = dateText(to, "to");
    if (fromDate > toDate) {
      refuse("usage_window_invalid", "The usage window start must not be after its end.", "Choose a window with from on or before to.");
    }
    await customerSubsidiary(orgId, safeCustomerId, allowedSubsidiaryIds);
    const rows = await db.execute<UsageRecord>(sql`
      select ${RECORD_COLUMNS} from usage_records
       where org_id = ${orgId} and meter_id = ${safeMeterId} and customer_id = ${safeCustomerId}
         and occurred_on >= ${fromDate} and occurred_on <= ${toDate}
         and exists (select 1 from parties c where c.org_id = usage_records.org_id and c.id = usage_records.customer_id
           ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })})
       order by occurred_on, id`);
    return rows.rows;
  });
}

export async function listUsageMeters(orgId: string): Promise<UsageMeter[]> {
  return withOrg(orgId, async () => {
    await requireUsageBillingRead(orgId);
    return (await db.execute<UsageMeter>(sql`
      select ${METER_COLUMNS} from usage_meters where org_id = ${orgId} order by key, id`)).rows;
  });
}

export async function listUsageRecords(orgId: string, filters: {
  from: string;
  to: string;
  meterId?: string;
  customerId?: string;
  limit?: number;
  offset?: number;
}, allowedSubsidiaryIds: UsageSubsidiaryScope = null): Promise<UsageRecord[]> {
  return withOrg(orgId, async () => {
    await requireUsageBillingRead(orgId);
    const from = dateText(filters.from, "from");
    const to = dateText(filters.to, "to");
    if (from > to) refuse("usage_window_invalid", "The usage window start must not be after its end.", "Choose a window with from on or before to.");
    const meterId = filters.meterId === undefined ? null : uuidText(filters.meterId, "meter_id");
    const customerId = filters.customerId === undefined ? null : uuidText(filters.customerId, "customer_id");
    if (customerId !== null) await customerSubsidiary(orgId, customerId, allowedSubsidiaryIds);
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    return (await db.execute<UsageRecord>(sql`
      select ${RECORD_COLUMNS} from usage_records
       where org_id = ${orgId} and occurred_on >= ${from} and occurred_on <= ${to}
         and (${meterId}::uuid is null or meter_id = ${meterId})
         and (${customerId}::uuid is null or customer_id = ${customerId})
         and exists (select 1 from parties c where c.org_id = usage_records.org_id and c.id = usage_records.customer_id
           ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })})
       order by occurred_on desc, id limit ${limit} offset ${offset}`)).rows;
  });
}
