import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  USAGE_AGGREGATIONS,
  USAGE_BAND_KINDS,
  type usageRatingRuns,
} from "@openbooks/schema";
import { createSubscriptionInvoice, type InvoiceSpec } from "../subscription-billing.ts";
import type { AdvancedBillingLine } from "../advanced-subscriptions.ts";
import { SYSTEM_ACTOR_ID } from "../../banking/banking.ts";
import { deleteDocument } from "../../ledger/document-delete.ts";
import { requestDocumentVoid } from "../../ledger/document-void.ts";
import { assertPeriodModulesOpen, CloseError } from "../../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../../periods/period-resolution.ts";
import { isIsoCalendarDate } from "../../platform/business-date.ts";
import { add, cmp, mulDecimalFactors } from "../../money/money.ts";
import { parseMoney, parseQuantity, parseRate, subMoney, type Money, type Quantity, type Rate } from "../../money/brands.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows, subsidiaryVisibleFilter } from "../../organization/subsidiary-scope.ts";
import { db, withOrg } from "../../platform/db.ts";
import { prepaidRecognitionAdjustment } from '../../revenue/prepaid-breakage.ts';
import { recordRecognitionEvent } from "../../revenue/recognition-events.ts";
import { recordPrepaidDraw, reversePrepaidDraw, prepaidBalance } from "./prepaid.ts";
import { listUsageRecordsForWindow, type UsageRecord } from "./records.ts";
import {
  aggregateUsage,
  applyPrepaid,
  commitShortfall,
  rateUsage,
  type RatingBand,
  type RatingBandKind,
  type RateLine,
  type UsageAggregation,
} from "./rating.ts";
import type { UsageCommitPeriod, UsageRatingBand, SubscriptionUsageLink } from "./rating-plans.ts";
import { commitWindowForRun } from "./true-ups.ts";
import { UsageBillingError } from "./errors.ts";

type SchemaAggregation = (typeof USAGE_AGGREGATIONS)[number];
type SchemaBandKind = (typeof USAGE_BAND_KINDS)[number];
type Assert<T extends true> = T;
export type UsageRatingVocabularyAssertions = {
  schemaAggregationsAreKernel: Assert<Exclude<SchemaAggregation, UsageAggregation> extends never ? true : false>;
  kernelAggregationsAreSchema: Assert<Exclude<UsageAggregation, SchemaAggregation> extends never ? true : false>;
  schemaBandKindsAreKernel: Assert<Exclude<SchemaBandKind, RatingBandKind> extends never ? true : false>;
  kernelBandKindsAreSchema: Assert<Exclude<RatingBandKind, SchemaBandKind> extends never ? true : false>;
};

export type UsageRatingRun = typeof usageRatingRuns.$inferSelect;
export type UsageSubsidiaryScope = ReadonlySet<string> | null;

export interface RatedUsageLine extends RateLine {
  meterId: string;
  meterKey: string;
  meterName: string;
  recordsHash: string;
}

export interface PrepaidRunDraw {
  grantId: string;
  obligationId: string;
  balance: Money;
  amount: Money;
}

export interface RateRunPreview {
  linkId: string;
  subscriptionId: string;
  customerId: string;
  planVersionId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  inputHash: string;
  outputHash: string;
  ratedLines: RatedUsageLine[];
  invoiceLines: Array<RatedUsageLine & { quantity: Quantity; amount: Money }>;
  totalRated: Money;
  prepaidDrawn: Money;
  billableTotal: Money;
  commitShortfall: Money;
  commitRatedTotal: Money;
  draws: PrepaidRunDraw[];
}

export interface RateRunResult {
  run: UsageRatingRun;
  invoiceId: string | null;
  documentNumber: string | null;
  preview: RateRunPreview;
}

export interface PendingVoidResult {
  status: "pending_void";
  runId: string;
  invoiceId: string;
  pendingRequestId: string;
}

type LinkContext = SubscriptionUsageLink & {
  currency: string;
  versionStatus: string;
  versionEffectiveFrom: string;
  specHash: string;
};

type SubscriptionRow = {
  customerId: string;
  subscriptionCurrency: string | null;
  customerSubsidiaryId: string | null;
  trustedSubsidiaryId: string | null;
  rootSubsidiaryId: string | null;
};

type SubscriptionContext = SubscriptionRow & {
  subsidiaryId: string | null;
};

type MeterContext = {
  id: string;
  key: string;
  name: string;
  aggregation: UsageAggregation;
  itemId: string | null;
  itemName: string | null;
  incomeAccountId: string | null;
  taxCodeId: string | null;
  recognitionRuleId: string | null;
  itemActive: boolean;
};

interface GrantContext {
  id: string;
  obligationId: string;
  balance: Money;
}

interface RateRunContext {
  link: LinkContext;
  subscription: SubscriptionContext;
  meters: MeterContext[];
  bands: Map<string, UsageRatingBand[]>;
  bookId: string;
}

interface WindowRates {
  lines: RatedUsageLine[];
  recordFacts: unknown[];
  recordsHash: string;
  total: Money;
}

const FEATURE_REMEDY = "Enable Usage Billing in Company Settings → Features.";
const RERATE_REMEDY = "Run voidAndRebillRateRun for this rating run, then wait for any requested void to complete.";
const RUN_COLUMNS = sql`
  id, org_id as "orgId", link_id as "linkId", plan_version_id as "planVersionId",
  period_start::text as "periodStart", period_end::text as "periodEnd",
  input_hash as "inputHash", output_hash as "outputHash", status,
  supersedes_run_id as "supersedesRunId", invoice_id as "invoiceId",
  created_by as "createdBy", created_at as "createdAt"`;

function refuse(
  code: string,
  message: string,
  remedy: string,
  field: string | null = null,
  status: 422 | 409 = 422,
): never {
  throw new UsageBillingError(code, message, remedy, { field, status });
}

function requireDate(value: string, field: string): string {
  if (!isIsoCalendarDate(value)) {
    refuse("usage_rate_run_date_invalid", `${field} must be a real calendar date in YYYY-MM-DD form.`, `Provide a valid ${field} in YYYY-MM-DD form.`, field);
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function sumAmounts(lines: readonly { amount: string }[]): Money {
  let total = "0.0000";
  for (const line of lines) total = add(total, line.amount);
  return parseMoney(total);
}

function quantityText(units: bigint): string {
  const whole = (units / 100_000_000n).toString();
  const fraction = (units % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Find a quantity no greater than the rated quantity that reproduces an exact billable amount. */
function quantityForAmount(unitPrice: Rate, maximum: Quantity, amount: Money): Quantity {
  const [whole = "0", fraction = ""] = maximum.split(".");
  const highLimit = BigInt(whole) * 100_000_000n + BigInt((fraction + "00000000").slice(0, 8));
  let low = 0n;
  let high = highLimit;
  while (low < high) {
    const middle = (low + high) / 2n;
    const candidate = mulDecimalFactors("1", [unitPrice, quantityText(middle)]);
    if (cmp(candidate, amount) < 0) low = middle + 1n;
    else high = middle;
  }
  const quantity = parseQuantity(quantityText(low));
  if (cmp(mulDecimalFactors("1", [unitPrice, quantity]), amount) !== 0) {
    refuse(
      "usage_prepaid_split_not_representable",
      `The prepaid remainder ${amount} cannot be represented at the rated unit price ${unitPrice} with the supported quantity precision.`,
      "Top up prepaid to cover the full rated line, or leave that line billable by adjusting the available grant balance before rating.",
      "amount",
    );
  }
  return quantity;
}

async function requireUsageBilling(orgId: string, lock: boolean): Promise<void> {
  if (lock) {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "usageBilling"))) {
      refuse("feature_off", "Usage billing is turned off for this organization.", FEATURE_REMEDY);
    }
    return;
  }
  if (!(await orgFeatureEnabled(orgId, "usageBilling"))) {
    refuse("feature_off", "Usage billing is turned off for this organization.", FEATURE_REMEDY);
  }
}

async function loadContext(orgId: string, linkId: string, allowedSubsidiaryIds: UsageSubsidiaryScope = null): Promise<RateRunContext> {
  const link = (await db.execute<LinkContext>(sql`
    select l.id, l.org_id as "orgId", l.subscription_id as "subscriptionId",
           l.customer_id as "customerId", l.plan_version_id as "planVersionId",
           l.meter_ids as "meterIds", l.effective_from::text as "effectiveFrom",
           l.effective_to::text as "effectiveTo", l.commit_amount::text as "commitAmount",
           l.commit_period as "commitPeriod", l.allow_overage as "allowOverage",
           l.created_at as "createdAt", l.created_by as "createdBy",
           l.updated_at as "updatedAt", l.updated_by as "updatedBy",
           p.currency_code as currency, v.status as "versionStatus",
           v.effective_from::text as "versionEffectiveFrom", v.spec_hash as "specHash"
      from subscription_usage_links l
      join usage_rating_plan_versions v on v.org_id = l.org_id and v.id = l.plan_version_id
      join usage_rating_plans p on p.org_id = v.org_id and p.id = v.plan_id
      join parties link_customer on link_customer.org_id = l.org_id and link_customer.id = l.customer_id
     where l.org_id = ${orgId} and l.id = ${linkId}
       ${subsidiaryVisibleFilter(sql`link_customer.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}`)).rows[0];
  if (!link) throw new ScopeNotFoundError();
  if (link.versionStatus !== "published" || !link.specHash) {
    refuse("usage_rate_run_plan_unpublished", "The usage link does not point to a published rating plan version.", "Publish a rating plan version and link the subscription to it.", "plan_version_id");
  }

  const subscription = (await db.execute<SubscriptionRow>(sql`
    select s.customer_id as "customerId", coalesce(v.currency_code, p.currency_code) as "subscriptionCurrency",
           c.subsidiary_id as "customerSubsidiaryId",
           (select active.id from subsidiaries active
             where active.id = c.subsidiary_id and active.org_id = s.org_id and active.is_active) as "trustedSubsidiaryId",
           (select root.id from subsidiaries root
             where root.org_id = s.org_id and root.parent_id is null and root.is_active
             order by root.id limit 1) as "rootSubsidiaryId"
      from subscriptions s
      join subscription_plans p on p.org_id = s.org_id and p.id = s.plan_id
      join parties c on c.org_id = s.org_id and c.id = s.customer_id
      left join subscription_lifecycles l on l.org_id = s.org_id and l.subscription_id = s.id
      left join subscription_plan_versions v on v.org_id = l.org_id and v.id = l.plan_version_id
     where s.org_id = ${orgId} and s.id = ${link.subscriptionId}
       ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}`)).rows[0];
  if (!subscription || subscription.customerId !== link.customerId) {
    if (!subscription) throw new ScopeNotFoundError();
    refuse("usage_rate_run_subscription_mismatch", "The usage link's subscription no longer belongs to its recorded customer.", "Correct the subscription usage link so its customer matches the subscription.", "link_id");
  }
  if (!subsidiaryScopeAllows(allowedSubsidiaryIds, subscription.customerSubsidiaryId, { orgWideNull: true })) throw new ScopeNotFoundError();
  if (subscription.subscriptionCurrency !== link.currency) {
    refuse("usage_rate_run_currency_mismatch", `The usage plan currency ${link.currency} does not match the linked subscription currency ${subscription.subscriptionCurrency ?? "(missing)"}.`, "Create or link a usage plan in the subscription's currency.", "plan_version_id");
  }
  if (subscription.customerSubsidiaryId !== null && subscription.trustedSubsidiaryId === null) {
    refuse("usage_rate_run_customer_subsidiary_invalid", "The usage customer is assigned to a subsidiary that is not active in this organization.", "Reassign the customer to an active subsidiary, or clear the assignment for an organization-wide customer.", "customer_id");
  }
  const subscriptionContext: SubscriptionContext = {
    ...subscription,
    subsidiaryId: subscription.trustedSubsidiaryId ?? subscription.rootSubsidiaryId,
  };

  const bookRows = (await db.execute<{ id: string }>(sql`
    select id from accounting_books
     where org_id = ${orgId} and is_active and is_primary and posts_gl
     order by id limit 2`)).rows;
  if (bookRows.length !== 1) {
    refuse("usage_rate_run_primary_book_unavailable", "Usage cannot be rated because this organization does not have exactly one active primary accounting book.", "Configure one active primary accounting book, then retry the usage rating.");
  }

  const meters: MeterContext[] = [];
  const bands = new Map<string, UsageRatingBand[]>();
  for (const meterId of link.meterIds) {
    const meter = (await db.execute<MeterContext>(sql`
      select m.id, m.key, m.name, m.aggregation, m.item_id as "itemId",
             i.name as "itemName", i.income_account_id as "incomeAccountId",
             i.tax_code_id as "taxCodeId", i.recognition_rule_id as "recognitionRuleId",
             coalesce(i.is_active, false) as "itemActive"
        from usage_meters m
        left join items i on i.org_id = m.org_id and i.id = m.item_id
       where m.org_id = ${orgId} and m.id = ${meterId}`)).rows[0];
    if (!meter) {
      refuse("usage_rate_run_meter_missing", `Meter ${meterId} on this usage link no longer exists.`, "Update the usage link to include an active meter in its published plan.", "meter_ids");
    }
    meters.push(meter);
    const meterBands = (await db.execute<UsageRatingBand>(sql`
      select id, org_id as "orgId", plan_version_id as "planVersionId", meter_id as "meterId",
             kind, seq, up_to_qty::text as "upToQty", unit_price::text as "unitPrice",
             flat_amount::text as "flatAmount", included_qty::text as "includedQty",
             package_size::text as "packageSize", package_rounding as "packageRounding",
             created_at as "createdAt", created_by as "createdBy",
             updated_at as "updatedAt", updated_by as "updatedBy"
        from usage_rating_bands
       where org_id = ${orgId} and plan_version_id = ${link.planVersionId} and meter_id = ${meterId}
       order by seq`)).rows;
    if (meterBands.length === 0) {
      refuse("usage_rate_run_bands_missing", `Meter ${meter.key} has no rating bands in the linked published version.`, "Add complete rating bands for this meter and publish a new plan version.", "plan_version_id");
    }
    bands.set(meterId, meterBands);
  }
  return { link, subscription: subscriptionContext, meters, bands, bookId: bookRows[0]!.id };
}

function kernelBand(band: UsageRatingBand): RatingBand {
  return {
    kind: band.kind as RatingBandKind,
    seq: band.seq,
    upToQty: band.upToQty === null ? null : parseQuantity(band.upToQty),
    unitPrice: parseRate(band.unitPrice),
    flatAmount: parseMoney(band.flatAmount),
    includedQty: parseQuantity(band.includedQty),
    packageSize: band.packageSize === null ? null : parseQuantity(band.packageSize),
    packageRounding: band.packageRounding,
  };
}

async function rateWindow(
  orgId: string,
  context: RateRunContext,
  periodStart: string,
  periodEnd: string,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<WindowRates> {
  const lines: RatedUsageLine[] = [];
  const recordFacts: unknown[] = [];
  for (const meter of context.meters) {
    const records: UsageRecord[] = await listUsageRecordsForWindow(
      orgId,
      meter.id,
      context.link.customerId,
      periodStart,
      periodEnd,
      allowedSubsidiaryIds,
    );
    const wrongSubscription = records.find(
      (record) => record.subscriptionId !== null && record.subscriptionId !== context.link.subscriptionId,
    );
    if (wrongSubscription) {
      refuse("usage_rate_run_record_subscription_mismatch", `Usage record ${wrongSubscription.id} belongs to a different subscription.`, "Correct the usage record's subscription assignment before rating this customer window.", "subscription_id");
    }
    const recordInputs = records.map((record) => ({
      id: record.id,
      occurredOn: record.occurredOn,
      quantity: parseQuantity(record.quantity),
      distinctKey: record.distinctKey,
      reversesId: record.reversesId,
    }));
    const recordsHash = hash(recordInputs.map((record) => ({
      id: record.id,
      occurredOn: record.occurredOn,
      quantity: record.quantity,
      distinctKey: record.distinctKey,
      reversesId: record.reversesId,
    })));
    recordFacts.push({ meterId: meter.id, records: recordInputs });
    const quantity = aggregateUsage(meter.aggregation, recordInputs);
    const rated = rateUsage({ quantity, bands: context.bands.get(meter.id)!.map(kernelBand) });
    for (const line of rated) {
      lines.push({ ...line, meterId: meter.id, meterKey: meter.key, meterName: meter.name, recordsHash });
    }
  }
  return {
    lines,
    recordFacts,
    recordsHash: hash(recordFacts),
    total: sumAmounts(lines),
  };
}

async function loadGrants(
  orgId: string,
  context: RateRunContext,
  periodEnd: string,
  addBackRunId: string | null,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<GrantContext[]> {
  const rows = (await db.execute<{
    id: string;
    obligationId: string | null;
  }>(sql`
    select g.id, o.id as "obligationId"
      from usage_prepaid_grants g
      join document_lines source_line
        on source_line.org_id = g.org_id and source_line.id = g.source_document_line_id
      join documents source_document
        on source_document.org_id = source_line.org_id and source_document.id = source_line.document_id
      join items source_item
        on source_item.org_id = source_line.org_id and source_item.id = source_line.item_id
      join recognition_rules r
        on r.org_id = source_item.org_id and r.id = source_item.recognition_rule_id
      left join performance_obligations o
        on o.org_id = source_line.org_id and o.document_line_id = source_line.id
       and o.recognition_rule_id = r.id and o.status <> 'cancelled'
     where g.org_id = ${orgId} and g.customer_id = ${context.link.customerId}
       and g.currency_code = ${context.link.currency}
       and (g.expires_on is null or g.expires_on >= ${periodEnd})
       and source_document.kind = 'customer_invoice' and source_document.status = 'posted'
       and r.method = 'usage'
     order by g.created_at, g.id`)).rows;
  const addBack = new Map<string, Money>();
  if (addBackRunId !== null) {
    const draws = (await db.execute<{ grantId: string; amount: string }>(sql`
      select grant_id as "grantId", amount::text as amount
        from usage_prepaid_draws
       where org_id = ${orgId} and run_id = ${addBackRunId}
       order by grant_id`)).rows;
    for (const draw of draws) {
      addBack.set(draw.grantId, parseMoney(add(addBack.get(draw.grantId) ?? "0.0000", draw.amount)));
    }
  }
  const grants: GrantContext[] = [];
  for (const row of rows) {
    if (!row.obligationId) {
      refuse("usage_prepaid_obligation_missing", `Prepaid grant ${row.id} has no live recognition obligation.`, "Restore the source invoice's usage obligation through the revenue recognition workflow before drawing the grant.", "grant_id");
    }
    const balance = parseMoney(await prepaidBalance(orgId, row.id, periodEnd, allowedSubsidiaryIds));
    grants.push({
      id: row.id,
      obligationId: row.obligationId,
      balance: parseMoney(add(balance, addBack.get(row.id) ?? "0.0000")),
    });
  }
  return grants;
}

function allocatePrepaid(
  ratedLines: readonly RatedUsageLine[],
  grants: readonly GrantContext[],
  allowOverage: boolean,
): { invoiceLines: RateRunPreview["invoiceLines"]; draws: PrepaidRunDraw[]; drawn: Money; billable: Money } {
  const ratedTotal = sumAmounts(ratedLines);
  let totalBalance = "0.0000";
  for (const grant of grants) totalBalance = add(totalBalance, grant.balance);
  const overall = applyPrepaid({ rated: ratedTotal, balance: parseMoney(totalBalance), allowOverage });
  const balances = new Map(grants.map((grant) => [grant.id, grant.balance]));
  const drawTotals = new Map<string, Money>();
  const invoiceLines: RateRunPreview["invoiceLines"] = [];

  for (const line of ratedLines) {
    let billable = line.amount;
    for (const grant of grants) {
      if (cmp(billable, "0") <= 0) break;
      const split = applyPrepaid({ rated: billable, balance: balances.get(grant.id)!, allowOverage: true });
      if (cmp(split.drawn, "0") > 0) {
        balances.set(grant.id, parseMoney(subMoney(balances.get(grant.id)!, split.drawn)));
        drawTotals.set(grant.id, parseMoney(add(drawTotals.get(grant.id) ?? "0.0000", split.drawn)));
        billable = split.billable;
      }
    }
    if (cmp(billable, "0") > 0) {
      const quantity = cmp(billable, line.amount) === 0
        ? line.quantity
        : quantityForAmount(line.unitPrice, line.quantity, billable);
      invoiceLines.push({ ...line, quantity, amount: billable });
    }
  }

  const draws = grants.flatMap((grant) => {
    const amount = drawTotals.get(grant.id);
    return amount && cmp(amount, "0") > 0 ? [{ grantId: grant.id, obligationId: grant.obligationId, balance: grant.balance, amount }] : [];
  });
  const drawn = draws.reduce((total, draw) => parseMoney(add(total, draw.amount)), parseMoney("0"));
  const billable = sumAmounts(invoiceLines);
  if (cmp(drawn, overall.drawn) !== 0 || cmp(billable, overall.billable) !== 0) {
    throw new Error("prepaid line allocation does not tie to the rating kernel split");
  }
  return { invoiceLines, draws, drawn, billable };
}

async function buildPreview(
  orgId: string,
  linkId: string,
  periodStartValue: string,
  periodEndValue: string,
  addBackRunId: string | null,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<{ context: RateRunContext; preview: RateRunPreview }> {
  const periodStart = requireDate(periodStartValue, "period_start");
  const periodEnd = requireDate(periodEndValue, "period_end");
  if (periodStart > periodEnd) {
    refuse("usage_rate_run_window_invalid", "The rating window starts after it ends.", "Choose period_start on or before period_end.", "period_start");
  }
  const context = await loadContext(orgId, linkId, allowedSubsidiaryIds);
  if (context.link.customerId.length === 0 || context.link.meterIds.length === 0) {
    refuse("usage_rate_run_link_incomplete", "The usage link has no customer or meters to rate.", "Update the subscription usage link with its customer and at least one meter.", "link_id");
  }
  if (periodStart < context.link.effectiveFrom || (context.link.effectiveTo !== null && periodEnd > context.link.effectiveTo)) {
    refuse("usage_rate_run_outside_link_window", `The rating window ${periodStart} through ${periodEnd} is outside the usage link's effective dates.`, "Open a usage link covering the complete rating window.", "period_start");
  }
  if (periodStart < context.link.versionEffectiveFrom) {
    refuse("usage_rate_run_plan_not_effective", `The linked plan version is not effective until ${context.link.versionEffectiveFrom}.`, "Link a plan version effective on or before the rating window.", "plan_version_id");
  }

  const rated = await rateWindow(orgId, context, periodStart, periodEnd, allowedSubsidiaryIds);
  const grants = await loadGrants(orgId, context, periodEnd, addBackRunId, allowedSubsidiaryIds);
  const allocation = allocatePrepaid(rated.lines, grants, context.link.allowOverage);
  const commitWindow = commitWindowForRun(periodStart, periodEnd, context.link.commitPeriod as UsageCommitPeriod | null);
  let shortfall = parseMoney("0");
  let commitRatedTotal = rated.total;
  let commitRecordsHash = rated.recordsHash;
  if (commitWindow !== null && context.link.commitAmount !== null) {
    if (context.link.commitPeriod === "annual") {
      const annual = await rateWindow(orgId, context, commitWindow.start, commitWindow.end, allowedSubsidiaryIds);
      commitRatedTotal = annual.total;
      commitRecordsHash = annual.recordsHash;
    }
    shortfall = commitShortfall({
      commitAmount: parseMoney(context.link.commitAmount),
      ratedInWindow: commitRatedTotal,
    });
  }

  const invoiceLines = [...allocation.invoiceLines];
  if (cmp(shortfall, "0") > 0 && commitWindow !== null) {
    invoiceLines.push({
      meterId: "",
      meterKey: "commit",
      meterName: "Minimum commitment",
      recordsHash: commitRecordsHash,
      kind: "commit_shortfall",
      bandSeq: 0,
      quantity: parseQuantity("1"),
      unitPrice: parseRate(shortfall),
      amount: shortfall,
    });
  }

  const availablePrepaid = grants.map((grant) => ({ id: grant.id, balance: grant.balance }));
  const inputHash = hash({
    orgId,
    linkId: context.link.id,
    subscriptionId: context.link.subscriptionId,
    customerId: context.link.customerId,
    planVersionId: context.link.planVersionId,
    specHash: context.link.specHash,
    periodStart,
    periodEnd,
    meters: context.meters.map((meter) => ({
      id: meter.id,
      key: meter.key,
      name: meter.name,
      aggregation: meter.aggregation,
      itemId: meter.itemId,
      itemName: meter.itemName,
      itemActive: meter.itemActive,
      incomeAccountId: meter.incomeAccountId,
      taxCodeId: meter.taxCodeId,
      recognitionRuleId: meter.recognitionRuleId,
      bands: context.bands.get(meter.id),
    })),
    records: rated.recordFacts,
    commitWindow,
    commitAmount: context.link.commitAmount,
    commitPeriod: context.link.commitPeriod,
    commitRecordsHash,
    availablePrepaid,
    allowOverage: context.link.allowOverage,
  });
  const outputHash = hash({
    ratedLines: rated.lines,
    invoiceLines,
    totalRated: rated.total,
    prepaidDrawn: allocation.drawn,
    billableTotal: allocation.billable,
    commitShortfall: shortfall,
    draws: allocation.draws.map(({ grantId, amount }) => ({ grantId, amount })),
  });
  return {
    context,
    preview: {
      linkId: context.link.id,
      subscriptionId: context.link.subscriptionId,
      customerId: context.link.customerId,
      planVersionId: context.link.planVersionId,
      periodStart,
      periodEnd,
      currency: context.link.currency,
      inputHash,
      outputHash,
      ratedLines: rated.lines,
      invoiceLines,
      totalRated: rated.total,
      prepaidDrawn: allocation.drawn,
      billableTotal: allocation.billable,
      commitShortfall: shortfall,
      commitRatedTotal,
      draws: allocation.draws,
    },
  };
}

export async function previewRateRun(
  orgId: string,
  linkId: string,
  periodStart: string,
  periodEnd: string,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<RateRunPreview> {
  return withOrg(orgId, async () => {
    await requireUsageBilling(orgId, false);
    const periodStartDate = requireDate(periodStart, "period_start");
    const periodEndDate = requireDate(periodEnd, "period_end");
    const existing = await activeRun(orgId, linkId, periodStartDate, periodEndDate, allowedSubsidiaryIds);
    return (await buildPreview(orgId, linkId, periodStartDate, periodEndDate, existing?.id ?? null, allowedSubsidiaryIds)).preview;
  });
}

async function assertCommitReady(orgId: string, context: RateRunContext, periodEnd: string): Promise<void> {
  for (const meter of context.meters) {
    if (!meter.itemId || !meter.itemName || !meter.itemActive) {
      refuse("usage_rate_run_item_unavailable", `Meter ${meter.key} has no active catalog item.`, "Assign an active service item to the meter before rating usage.", "item_id");
    }
    if (meter.recognitionRuleId !== null) {
      refuse(
        "usage_rate_run_item_recognition_rule",
        `Meter ${meter.key}'s item carries a revenue recognition rule, so arrears usage would remain deferred.`,
        "Remove the rule from the meter's item, or sell the usage as prepaid.",
        "item_id",
      );
    }
    if (!meter.incomeAccountId) {
      refuse("usage_rate_run_income_account_missing", `Meter ${meter.key}'s item has no income account.`, "Configure an active income account on the meter's item before rating usage.", "item_id");
    }
  }
  const period = await resolveCoveringPeriod(db, orgId, periodEnd);
  if (!period) {
    refuse("usage_rate_run_period_missing", `No active accounting period covers ${periodEnd}.`, "Date the rating window in an open AR period.", "period_end");
  }
  try {
    await assertPeriodModulesOpen(db, {
      orgId,
      periodId: period.id,
      bookId: context.bookId,
      subsidiaryIds: context.subscription.subsidiaryId ? [context.subscription.subsidiaryId] : [],
      modules: ["ar"],
    });
  } catch (error) {
    if (!(error instanceof CloseError)) throw error;
    refuse(
      "usage_rate_run_period_closed",
      `The rating window ends ${periodEnd}, which falls in a period closed for AR.`,
      "Rate while the period is open, or reopen it through the close flow.",
      "period_end",
    );
  }
}

async function activeRun(
  orgId: string,
  linkId: string,
  periodStart: string,
  periodEnd: string,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<UsageRatingRun | null> {
  return (await db.execute<UsageRatingRun>(sql`
    select ${RUN_COLUMNS} from usage_rating_runs
     where org_id = ${orgId} and link_id = ${linkId}
       and exists (select 1 from subscription_usage_links l join parties c on c.org_id = l.org_id and c.id = l.customer_id
         where l.org_id = usage_rating_runs.org_id and l.id = usage_rating_runs.link_id
         ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })})
       and period_start = ${periodStart} and period_end = ${periodEnd}
       and status = 'active'
     for update`)).rows[0] ?? null;
}

export async function getRateRun(orgId: string, runId: string, allowedSubsidiaryIds: UsageSubsidiaryScope = null): Promise<UsageRatingRun> {
  return withOrg(orgId, async () => {
    await requireUsageBilling(orgId, false);
    const row = (await db.execute<UsageRatingRun>(sql`
      select ${RUN_COLUMNS} from usage_rating_runs
       where org_id = ${orgId} and id = ${runId}
         and exists (select 1 from subscription_usage_links l join parties c on c.org_id = l.org_id and c.id = l.customer_id
           where l.org_id = usage_rating_runs.org_id and l.id = usage_rating_runs.link_id
           ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })})`)).rows[0];
    if (!row) throw new ScopeNotFoundError();
    return row;
  });
}

export async function listRateRuns(orgId: string, filters: {
  customerId?: string;
  linkId?: string;
  limit?: number;
  offset?: number;
}, allowedSubsidiaryIds: UsageSubsidiaryScope = null): Promise<UsageRatingRun[]> {
  return withOrg(orgId, async () => {
    await requireUsageBilling(orgId, false);
    const customerId = filters.customerId ?? null;
    if (customerId !== null) {
      const customer = (await db.execute<{ subsidiaryId: string | null }>(sql`
        select subsidiary_id as "subsidiaryId" from parties
         where org_id = ${orgId} and id = ${customerId}
           ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}`)).rows[0];
      if (!customer || !subsidiaryScopeAllows(allowedSubsidiaryIds, customer.subsidiaryId, { orgWideNull: true })) throw new ScopeNotFoundError();
    }
    const linkId = filters.linkId ?? null;
    if (linkId !== null) {
      const link = (await db.execute<{ id: string }>(sql`
        select l.id from subscription_usage_links l
        join parties c on c.org_id = l.org_id and c.id = l.customer_id
        where l.org_id = ${orgId} and l.id = ${linkId}
          ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}`)).rows[0];
      if (!link) throw new ScopeNotFoundError();
    }
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    return (await db.execute<UsageRatingRun>(sql`
      select ${RUN_COLUMNS} from usage_rating_runs
       where org_id = ${orgId} and (${linkId}::uuid is null or link_id = ${linkId})
         and (${customerId}::uuid is null or exists (
           select 1 from subscription_usage_links l where l.org_id = usage_rating_runs.org_id
             and l.id = usage_rating_runs.link_id and l.customer_id = ${customerId}))
         and exists (select 1 from subscription_usage_links l join parties c on c.org_id = l.org_id and c.id = l.customer_id
           where l.org_id = usage_rating_runs.org_id and l.id = usage_rating_runs.link_id
           ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })})
       order by created_at desc, id limit ${limit} offset ${offset}`)).rows;
  });
}

async function pendingVoidRequestId(orgId: string, invoiceId: string): Promise<string | null> {
  return (await db.execute<{ id: string }>(sql`
    select run.id::text as id from flow_runs run
    join flow_gates gate on gate.org_id = run.org_id and gate.run_id = run.id
   where run.org_id = ${orgId} and run.subject_kind = 'customer_invoice' and run.subject_id = ${invoiceId}
     and run.status = 'waiting' and gate.status = 'pending'
   order by run.started_at desc limit 1`)).rows[0]?.id ?? null;
}

async function refusePendingOrVoidedRun(orgId: string, run: UsageRatingRun): Promise<void> {
  if (!run.invoiceId) return;
  const invoice = (await db.execute<{
    status: string;
    documentNumber: string;
    voidRequestedAt: string | null;
  }>(sql`
    select status, document_number as "documentNumber", void_requested_at::text as "voidRequestedAt"
      from documents where org_id = ${orgId} and id = ${run.invoiceId}`)).rows[0];
  if (!invoice) {
    refuse("usage_rate_run_invoice_missing", `Rating run ${run.id} points to a missing invoice.`, "Restore the usage invoice record before committing this rating window again.", "invoice_id", 409);
  }
  if (invoice.status === "draft") return;
  if (invoice.voidRequestedAt !== null) {
    const requestId = await pendingVoidRequestId(orgId, run.invoiceId);
    if (!requestId) {
      refuse("usage_rate_run_void_request_missing", `Invoice ${invoice.documentNumber} has a pending void marker but no pending approval request could be found.`, "Review the invoice's approval history, complete or cancel its void request, then retry voidAndRebillRateRun.", "invoice_id", 409);
    }
    refuse(
      "usage_rate_run_void_pending",
      `Invoice ${invoice.documentNumber} has pending void request ${requestId}; the rating run cannot be replaced until that request completes.`,
      "Complete the pending document void approval, then run voidAndRebillRateRun again.",
      "invoice_id",
      409,
    );
  }
  if (invoice.status === "voided" || invoice.status === "cancelled") {
    refuse("usage_rate_run_invoice_already_voided", `Invoice ${invoice.documentNumber} is already ${invoice.status}, but its rating run is still active.`, RERATE_REMEDY, "invoice_id", 409);
  }
}

async function insertRun(
  orgId: string,
  actorId: string | null,
  runId: string,
  linkId: string,
  preview: RateRunPreview,
  invoiceId: string | null,
  supersedesRunId: string | null,
): Promise<UsageRatingRun> {
  const inserted = await db.execute<UsageRatingRun>(sql`
    insert into usage_rating_runs
      (id, org_id, link_id, plan_version_id, period_start, period_end, input_hash, output_hash,
       status, supersedes_run_id, invoice_id, created_by)
    values (${runId}, ${orgId}, ${linkId}, ${preview.planVersionId}, ${preview.periodStart}, ${preview.periodEnd},
            ${preview.inputHash}, ${preview.outputHash}, 'active', ${supersedesRunId}, ${invoiceId}, ${actorId})
    returning ${RUN_COLUMNS}`);
  if (inserted.rows.length !== 1) throw new Error("rating run insert returned an unexpected row count");
  return inserted.rows[0]!;
}

async function generateInvoice(
  orgId: string,
  actorId: string | null,
  runId: string,
  context: RateRunContext,
  preview: RateRunPreview,
): Promise<{ invoiceId: string; documentNumber: string } | null> {
  if (preview.invoiceLines.length === 0) return null;
  const meterById = new Map(context.meters.map((meter) => [meter.id, meter]));
  const lines: AdvancedBillingLine[] = preview.invoiceLines.map((line) => {
    const meter = meterById.get(line.meterId);
    if (!meter && line.kind !== "commit_shortfall") {
      refuse("usage_rate_run_trace_meter_missing", "A rated invoice line has no meter to identify in its trace.", "Rebuild the usage run from a complete published meter link.", "meter_id");
    }
    const rating = {
      meterId: meter?.id ?? null,
      meterKey: meter?.key ?? "commit",
      planVersionId: preview.planVersionId,
      runId,
      recordsHash: line.recordsHash,
      kind: line.kind,
      bandSeq: line.bandSeq,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      periodStart: preview.periodStart,
      periodEnd: preview.periodEnd,
      ...(line.kind === "commit_shortfall" ? {
        commitWindowStart: commitWindowForRun(preview.periodStart, preview.periodEnd, context.link.commitPeriod as UsageCommitPeriod | null)?.start,
        commitWindowEnd: preview.periodEnd,
        ratedTotal: preview.commitRatedTotal,
      } : {}),
    };
    if (!rating.runId || !rating.recordsHash) {
      refuse("usage_rate_run_trace_incomplete", "A usage invoice line cannot be created without its rating trace.", "Rebuild the usage run from its persisted records and published plan.", "rating");
    }
    return {
      description: line.kind === "commit_shortfall"
        ? `Usage minimum commitment ${preview.periodStart} through ${preview.periodEnd}`
        : `${line.meterName} usage ${preview.periodStart} through ${preview.periodEnd} (band ${line.bandSeq})`,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
      incomeAccountId: meter?.incomeAccountId ?? context.meters[0]!.incomeAccountId,
      itemId: meter?.itemId ?? context.meters[0]!.itemId,
      taxCodeId: meter?.taxCodeId ?? context.meters[0]!.taxCodeId,
      custom: { rating },
    };
  });
  const invoiceSpec: InvoiceSpec = {
    orgId,
    actorId,
    customerId: context.link.customerId,
    subsidiaryId: context.subscription.subsidiaryId,
    currency: preview.currency,
    incomeAccountId: context.meters[0]!.incomeAccountId,
    itemId: context.meters[0]!.itemId,
    taxCodeId: null,
    description: `Usage ${preview.periodStart} through ${preview.periodEnd}`,
    quantity: "1",
    unitPrice: "0",
    memo: `Usage ${preview.periodStart} through ${preview.periodEnd}`,
    invoiceDate: preview.periodEnd,
    autoPost: false,
    lines,
    custom: { subscriptionId: context.link.subscriptionId, usageRunId: runId },
  };
  const created = await createSubscriptionInvoice(invoiceSpec);
  return { invoiceId: created.invoiceId, documentNumber: created.documentNumber };
}

async function persistPrepaidDraws(
  orgId: string,
  actorId: string | null,
  runId: string,
  preview: RateRunPreview,
  allowedSubsidiaryIds: UsageSubsidiaryScope,
): Promise<void> {
  const periodMonth = firstOfMonth(preview.periodEnd);
  for (const draw of preview.draws) {
    await recordPrepaidDraw(orgId, {
      grantId: draw.grantId,
      runId,
      periodMonth,
      amount: draw.amount,
    }, allowedSubsidiaryIds);
    await recordRecognitionEvent({
      obligationId: draw.obligationId,
      orgId,
      actorId,
      periodMonth,
      amount: await prepaidRecognitionAdjustment(orgId,draw.grantId),
      description: `Usage draw for rating run ${runId}`,
      sourceReference: `usage-run:${runId}:grant:${draw.grantId}`,
    });
  }
}

async function reverseRunPrepaidDraws(
  orgId: string,
  actorId: string | null,
  runId: string,
  draws: readonly { id: string; grantId: string; amount: string; periodMonth: string; obligationId: string | null }[],
  allowedSubsidiaryIds: UsageSubsidiaryScope,
): Promise<void> {
  for (const draw of draws) {
    if (!draw.obligationId) {
      refuse(
        "usage_prepaid_obligation_missing",
        `Prepaid draw ${draw.id} has no live recognition obligation to correct.`,
        "Restore the source invoice's usage obligation through the revenue recognition workflow before replacing this rating run.",
        "grant_id",
      );
    }
    await reversePrepaidDraw(orgId, draw.id, allowedSubsidiaryIds);
    await recordRecognitionEvent({
      obligationId: draw.obligationId,
      orgId,
      actorId,
      periodMonth: draw.periodMonth,
      amount: await prepaidRecognitionAdjustment(orgId,draw.grantId),
      description: `Usage draw reversal for rating run ${runId}`,
      sourceReference: `usage-run:${runId}:grant:${draw.grantId}:reversal`,
    });
  }
}

async function commitRateRunInTransaction(
  orgId: string,
  actorId: string | null,
  linkId: string,
  periodStartValue: string,
  periodEndValue: string,
  supersedesRunId: string | null,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<RateRunResult> {
  const periodStart = requireDate(periodStartValue, "period_start");
  const periodEnd = requireDate(periodEndValue, "period_end");
  const key = `${orgId}:${linkId}:${periodStart}:${periodEnd}`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  const existing = await activeRun(orgId, linkId, periodStart, periodEnd, allowedSubsidiaryIds);
  if (existing) await refusePendingOrVoidedRun(orgId, existing);

  const built = await buildPreview(orgId, linkId, periodStart, periodEnd, existing?.id ?? null, allowedSubsidiaryIds);
  if (existing) {
    if (existing.inputHash === built.preview.inputHash && existing.outputHash === built.preview.outputHash) {
      const documentNumber = existing.invoiceId === null ? null : (await db.execute<{ documentNumber: string }>(sql`
        select document_number as "documentNumber" from documents
         where org_id = ${orgId} and id = ${existing.invoiceId}`)).rows[0]?.documentNumber ?? null;
      return { run: existing, invoiceId: existing.invoiceId, documentNumber, preview: built.preview };
    }
    refuse(
      "usage_rate_run_inputs_changed",
      `The records, plan, or prepaid balance for ${periodStart} through ${periodEnd} changed after rating run ${existing.id}.`,
      `Call voidAndRebillRateRun for rating run ${existing.id} to replace its invoice and rate the changed inputs.`,
      "period_start",
      409,
    );
  }

  await assertCommitReady(orgId, built.context, periodEnd);
  const runId = randomUUID();
  const invoice = await generateInvoice(orgId, actorId, runId, built.context, built.preview);
  const run = await insertRun(
    orgId,
    actorId,
    runId,
    linkId,
    built.preview,
    invoice?.invoiceId ?? null,
    supersedesRunId,
  );
  await persistPrepaidDraws(orgId, actorId, runId, built.preview, allowedSubsidiaryIds);
  return {
    run,
    invoiceId: invoice?.invoiceId ?? null,
    documentNumber: invoice?.documentNumber ?? null,
    preview: built.preview,
  };
}

export async function commitRateRun(
  orgId: string,
  actorId: string | null,
  linkId: string,
  periodStart: string,
  periodEnd: string,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<RateRunResult> {
  return withOrg(orgId, async () => {
    await requireUsageBilling(orgId, true);
    return commitRateRunInTransaction(orgId, actorId, linkId, periodStart, periodEnd, null, allowedSubsidiaryIds);
  });
}

export async function voidAndRebillRateRun(
  orgId: string,
  actorId: string | null,
  runId: string,
  reason = "Usage rating inputs changed",
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<RateRunResult | PendingVoidResult> {
  return withOrg(orgId, async () => {
    await requireUsageBilling(orgId, true);
    const oldRun = (await db.execute<UsageRatingRun>(sql`
      select ${RUN_COLUMNS} from usage_rating_runs
       where org_id = ${orgId} and id = ${runId}
         and exists (select 1 from subscription_usage_links l join parties c on c.org_id = l.org_id and c.id = l.customer_id
           where l.org_id = usage_rating_runs.org_id and l.id = usage_rating_runs.link_id
           ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })})
       for update`)).rows[0];
    if (!oldRun) throw new ScopeNotFoundError();
    if (oldRun.status !== "active") {
      refuse("usage_rate_run_not_active", "The rating run is already superseded.", "Choose the active rating run for this usage link and period.", "run_id", 409);
    }
    const oldDraws = (await db.execute<{
      id: string;
      grantId: string;
      amount: string;
      periodMonth: string;
      obligationId: string | null;
    }>(sql`
      select d.id, d.grant_id as "grantId", d.amount::text as amount,
             d.period_month::text as "periodMonth", o.id as "obligationId"
        from usage_prepaid_draws d
        join usage_prepaid_grants g on g.org_id = d.org_id and g.id = d.grant_id
        join document_lines source_line
          on source_line.org_id = g.org_id and source_line.id = g.source_document_line_id
        left join items source_item
          on source_item.org_id = source_line.org_id and source_item.id = source_line.item_id
        left join recognition_rules r
          on r.org_id = source_item.org_id and r.id = source_item.recognition_rule_id
        left join performance_obligations o
          on o.org_id = source_line.org_id and o.document_line_id = source_line.id
         and o.recognition_rule_id = r.id and o.status <> 'cancelled'
       where d.org_id = ${orgId} and d.run_id = ${oldRun.id}
         and d.reverses_draw_id is null
       order by d.grant_id, d.id`)).rows;

    let invoiceStatus: string | null = null;
    let documentNumber: string | null = null;
    let voidRequestedAt: string | null = null;
    if (oldRun.invoiceId !== null) {
      const invoice = (await db.execute<{
        status: string;
        documentNumber: string;
        voidRequestedAt: string | null;
      }>(sql`
        select status, document_number as "documentNumber", void_requested_at::text as "voidRequestedAt"
          from documents where org_id = ${orgId} and id = ${oldRun.invoiceId}
          for update`)).rows[0];
      if (!invoice) {
        refuse("usage_rate_run_invoice_missing", `Rating run ${oldRun.id} points to a missing invoice.`, "Restore the usage invoice record before superseding this rating run.", "invoice_id", 409);
      }
      invoiceStatus = invoice.status;
      documentNumber = invoice.documentNumber;
      voidRequestedAt = invoice.voidRequestedAt;
      if (voidRequestedAt !== null) {
        const requestId = await pendingVoidRequestId(orgId, oldRun.invoiceId);
        if (!requestId) {
          refuse(
            "usage_rate_run_void_request_missing",
            `Invoice ${invoice.documentNumber} has a pending void marker but no pending approval request could be found.`,
            "Review the invoice's approval history, complete or cancel its void request, then retry voidAndRebillRateRun.",
            "invoice_id",
            409,
          );
        }
        refuse(
          "usage_rate_run_void_pending",
          `Invoice ${invoice.documentNumber} has pending void request ${requestId}; replacement must wait for its approval to complete.`,
          "Complete the pending document void approval, then run voidAndRebillRateRun again.",
          "invoice_id",
          409,
        );
      }
    }

    const effectiveActor = actorId ?? SYSTEM_ACTOR_ID;
    if (oldRun.invoiceId !== null && invoiceStatus === "draft") {
      const superseded = await db.execute(sql`
        update usage_rating_runs set status = 'superseded', invoice_id = null
         where org_id = ${orgId} and id = ${oldRun.id} and status = 'active'
        returning id`);
      if (superseded.rows.length !== 1) {
        refuse("usage_rate_run_supersede_conflict", `Rating run ${oldRun.id} changed before it could be superseded.`, "Reload the active run and retry voidAndRebillRateRun.", "run_id", 409);
      }
      await deleteDocument(oldRun.invoiceId, actorId, orgId, {
        allowedSubsidiaryIds,
        source: "usage_rate_run",
        reason,
      });
    } else if (oldRun.invoiceId !== null && invoiceStatus !== "voided" && invoiceStatus !== "cancelled") {
      const result = await requestDocumentVoid({
        documentId: oldRun.invoiceId,
        orgId,
        actorId: effectiveActor,
        reason,
        source: "api",
      });
      if (result.status === "pending_approval") {
        if (!result.runId) {
          refuse(
            "usage_rate_run_void_request_missing",
            `Invoice ${documentNumber ?? oldRun.invoiceId} entered pending approval without a workflow request id.`,
            "Review the invoice's approval history and resolve its void approval before rating a replacement window.",
            "invoice_id",
            409,
          );
        }
        return {
          status: "pending_void",
          runId: oldRun.id,
          invoiceId: oldRun.invoiceId,
          pendingRequestId: result.runId,
        };
      }
      const superseded = await db.execute(sql`
        update usage_rating_runs set status = 'superseded'
         where org_id = ${orgId} and id = ${oldRun.id} and status = 'active'
        returning id`);
      if (superseded.rows.length !== 1) {
        refuse("usage_rate_run_supersede_conflict", `Rating run ${oldRun.id} changed after its invoice was voided.`, "Reload the active run and retry voidAndRebillRateRun.", "run_id", 409);
      }
    } else {
      const superseded = await db.execute(sql`
        update usage_rating_runs set status = 'superseded'
         where org_id = ${orgId} and id = ${oldRun.id} and status = 'active'
        returning id`);
      if (superseded.rows.length !== 1) {
        refuse("usage_rate_run_supersede_conflict", `Rating run ${oldRun.id} changed before it could be superseded.`, "Reload the active run and retry voidAndRebillRateRun.", "run_id", 409);
      }
    }

    await reverseRunPrepaidDraws(orgId, actorId, oldRun.id, oldDraws, allowedSubsidiaryIds);

    const replaced = await commitRateRunInTransaction(
      orgId,
      actorId,
      oldRun.linkId,
      oldRun.periodStart,
      oldRun.periodEnd,
      oldRun.id,
      allowedSubsidiaryIds,
    );
    return { ...replaced, documentNumber: replaced.documentNumber ?? documentNumber };
  });
}
