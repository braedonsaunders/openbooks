import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import {
  allocateLargestRemainder,
  apportion,
  formatMoney,
  fromUnits,
  roundDiv,
  toCents,
  toUnits,
} from "../money/money.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";

export type PromotionKind = "percent" | "amount" | "free_shipping" | "buy_x_get_y";
export type PromotionStatus = "draft" | "active" | "archived";

export type PromotionRefusalCode =
  | "feature_disabled"
  | "not_found"
  | "invalid_input"
  | "wrong_status"
  | "not_started"
  | "expired"
  | "limit_reached"
  | "wrong_channel"
  | "no_discountable_lines"
  | "below_threshold"
  | "already_applied"
  | "fully_discounted"
  | "discount_account_missing"
  | "free_shipping_unsupported"
  | "currency_mismatch"
  | "changed_concurrently";

/** A promotion lifecycle refusal with the stable detail returned by API routes. */
export class PromotionRefusal extends Error {
  readonly name = "PromotionRefusal";

  constructor(
    message: string,
    readonly code: PromotionRefusalCode,
    readonly status: 404 | 409 | 422,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

const FEATURE = "promotions";
const FEATURE_REMEDY = "Turn on Promotions on Company Settings → Features";
const PROMOTION_KINDS: readonly string[] = ["percent", "amount", "free_shipping", "buy_x_get_y"];
const APPLIABLE_KINDS: readonly string[] = ["quote", "sales_order", "customer_invoice"];

export type Promotion = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: PromotionKind;
  status: PromotionStatus;
  percentValue: string | null;
  amountMinor: bigint | null;
  currency: string | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  startsAt: string | null;
  endsAt: string | null;
  /** Resolved against the database clock while the row is locked. */
  startsInFuture: boolean;
  ended: boolean;
  channelScopeId: string | null;
  usageLimit: number | null;
  usageCount: number;
  discountAccountId: string | null;
};

export type PromotionInput = {
  code: string;
  name: string;
  description?: string | null;
  kind: PromotionKind;
  percentValue?: string | null;
  amountMinor?: bigint | number | string | null;
  currency?: string | null;
  buyQuantity?: number | null;
  getQuantity?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  channelScopeId?: string | null;
  usageLimit?: number | null;
  discountAccountId?: string | null;
};

function refusal(message: string, code: PromotionRefusalCode, status: 404 | 409 | 422, remedy?: string): PromotionRefusal {
  return new PromotionRefusal(message, code, status, remedy);
}

async function assertPromotionsFeature(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(runner, orgId, FEATURE))) {
    throw refusal("Promotions is turned off for this organization", "feature_disabled", 409, FEATURE_REMEDY);
  }
}

function parseCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim() : "";
  if (!code || code.length > 64) {
    throw refusal("A promotion code is required", "invalid_input", 422, "Enter the code customers type at checkout");
  }
  return code;
}

function parsePercent(value: unknown): string {
  const percent = canonicalDecimal(value, 4);
  if (percent === null) {
    throw refusal(`Promotion percent ${String(value)} is not a usable rate`, "invalid_input", 422, "Enter a percent above zero up to 100");
  }
  // Percent units are ten-thousandths: 10.0000 reads as 100000. Compared as
  // integers, never floats.
  const units = toUnits(percent);
  if (units <= 0n || units > 100_0000n) {
    throw refusal(`Promotion percent ${String(value)} is not a usable rate`, "invalid_input", 422, "Enter a percent above zero up to 100");
  }
  return percent;
}

function parseMinor(value: unknown, label: string): bigint {
  // Storage minors arrive as bigint, safe-integer JSON numbers, or plain
  // decimal text judged by the shared scale-zero grammar. Fractions and
  // unsafe numbers are refused, never truncated: truncating 1.5 stored 1,
  // a discount nobody typed.
  const text = typeof value === "bigint"
    ? value.toString()
    : typeof value === "number"
      ? (Number.isSafeInteger(value) ? String(value) : "")
      : typeof value === "string"
        ? value.trim()
        : "";
  const exact = text === "" ? null : canonicalDecimal(text, 0);
  if (exact === null || !/^-?\d+$/.test(exact)) {
    throw refusal(`${label} must be a whole number of minor units`, "invalid_input", 422, `Enter ${label.toLowerCase()} as whole minor units`);
  }
  const minor = BigInt(exact);
  if (minor <= 0n) {
    throw refusal(`${label} must be greater than zero`, "invalid_input", 422, `Enter a positive ${label.toLowerCase()}`);
  }
  return minor;
}

function parseCurrency(value: unknown): string {
  const currency = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw refusal(`Currency ${String(value)} is not an ISO code`, "invalid_input", 422, "Enter the three-letter currency code, for example USD");
  }
  return currency;
}

function parseCount(value: unknown, label: string): number {
  const count = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : NaN;
  if (!Number.isInteger(count) || count <= 0) {
    throw refusal(`${label} must be a positive whole number`, "invalid_input", 422, `Enter a positive whole ${label.toLowerCase()}`);
  }
  return count;
}

/**
 * Pure field validation shared by the engine writers and the setup write
 * hook, so the form and the API refuse the same shapes with the same words.
 */
export function validatePromotionFields(input: PromotionInput): void {
  parseCode(input.code);
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw refusal("A promotion name is required", "invalid_input", 422, "Name the campaign operators see in lists");
  }
  if (!PROMOTION_KINDS.includes(input.kind)) {
    throw refusal(`Promotion kind ${String(input.kind)} is unknown`, "invalid_input", 422, "Choose percent, amount, free shipping or buy X get Y");
  }
  if (input.kind === "percent") parsePercent(input.percentValue);
  if (input.kind === "amount") {
    parseMinor(input.amountMinor, "Discount amount");
    parseCurrency(input.currency);
  }
  if (input.kind === "buy_x_get_y") {
    parseCount(input.buyQuantity, "Buy quantity");
    parseCount(input.getQuantity, "Free quantity");
  }
  if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
    throw refusal("The promotion ends before it starts", "invalid_input", 422, "Set the end after the start of the active window");
  }
  if (input.usageLimit !== undefined && input.usageLimit !== null) parseCount(input.usageLimit, "Usage limit");
}

type PromotionRow = Record<string, unknown> & {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: string;
  status: string;
  percent_value: string | null;
  amount_minor: string | null;
  currency: string | null;
  buy_quantity: number | null;
  get_quantity: number | null;
  starts_at: string | null;
  ends_at: string | null;
  starts_in_future: boolean | null;
  ended: boolean | null;
  channel_scope_id: string | null;
  usage_limit: number | null;
  usage_count: number | string;
  discount_account_id: string | null;
};

function toPromotion(row: PromotionRow): Promotion {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind as PromotionKind,
    status: row.status as PromotionStatus,
    percentValue: row.percent_value,
    amountMinor: row.amount_minor === null ? null : BigInt(row.amount_minor),
    currency: row.currency,
    buyQuantity: row.buy_quantity,
    getQuantity: row.get_quantity,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    startsInFuture: row.starts_in_future ?? false,
    ended: row.ended ?? false,
    channelScopeId: row.channel_scope_id,
    usageLimit: row.usage_limit,
    usageCount: typeof row.usage_count === "number" ? row.usage_count : Number(row.usage_count),
    discountAccountId: row.discount_account_id,
  };
}

const PROMOTION_COLUMNS = sql`
  id, code, name, description, kind, status, percent_value::text,
  amount_minor::text, currency, buy_quantity, get_quantity,
  starts_at::text as starts_at, ends_at::text as ends_at,
  (starts_at is not null and starts_at > now()) as starts_in_future,
  (ends_at is not null and ends_at <= now()) as ended,
  channel_scope_id, usage_limit, usage_count, discount_account_id`;

async function readPromotion(runner: SqlExecutor, orgId: string, id: string): Promise<Promotion> {
  const row = (await runner.execute<PromotionRow>(sql`
    select ${PROMOTION_COLUMNS} from promotions where org_id = ${orgId} and id = ${id}`)).rows[0];
  if (!row) throw refusal("Promotion not found", "not_found", 404);
  return toPromotion(row);
}

/** Create a draft promotion. Codes read back exactly as written. */
export async function createPromotion(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  input: PromotionInput,
): Promise<Promotion> {
  await assertPromotionsFeature(runner, orgId);
  validatePromotionFields(input);
  const id = await insertPromotion(runner, orgId, actorId, input);
  return readPromotion(runner, orgId, id);
}

async function insertPromotion(runner: SqlExecutor, orgId: string, actorId: string, input: PromotionInput): Promise<string> {
  let id: string;
  try {
    const inserted = (await runner.execute<{ id: string }>(sql`
      insert into promotions (org_id, code, name, description, kind, status, percent_value, amount_minor,
                              currency, buy_quantity, get_quantity, starts_at, ends_at, channel_scope_id,
                              usage_limit, discount_account_id, created_by, updated_by)
      values (${orgId}, ${parseCode(input.code)}, ${input.name.trim()}, ${input.description ?? null}, ${input.kind}, 'draft',
              ${input.kind === "percent" ? parsePercent(input.percentValue) : null},
              ${input.kind === "amount" ? parseMinor(input.amountMinor, "Discount amount").toString() : null},
              ${input.kind === "amount" ? parseCurrency(input.currency) : null},
              ${input.kind === "buy_x_get_y" ? parseCount(input.buyQuantity, "Buy quantity") : null},
              ${input.kind === "buy_x_get_y" ? parseCount(input.getQuantity, "Free quantity") : null},
              ${input.startsAt ?? null}, ${input.endsAt ?? null}, ${input.channelScopeId ?? null},
              ${input.usageLimit ?? null}, ${input.discountAccountId ?? null}, ${actorId}, ${actorId})
      returning id`)).rows[0];
    if (!inserted) throw refusal("The promotion was not saved", "changed_concurrently", 409, "Try saving the promotion again");
    id = inserted.id;
  } catch (error) {
    if (error instanceof PromotionRefusal) throw error;
    if (isUniqueViolation(error)) {
      throw refusal(`Promotion code ${parseCode(input.code)} is already in use`, "invalid_input", 422, "Choose a different code or open the existing promotion");
    }
    throw error;
  }
  await writePromotionAudit(runner, orgId, actorId, id, "insert", { mode: "promotion_created", after: { code: parseCode(input.code), kind: input.kind } });
  return id;
}

/**
 * Pure lifecycle rule shared by the engine transition and the setup form, so
 * the drawer refuses the same moves with the same words. Null means allowed.
 */
export function promotionStatusTransition(from: PromotionStatus, to: PromotionStatus): string | null {
  if (to !== "active" && to !== "archived") return "Activate a draft or archive a promotion that is done";
  if (from === "draft" && (to === "active" || to === "archived")) return null;
  if (from === "active" && to === "archived") return null;
  // Archived promotions keep their history and can never return: reopening
  // would reinterpret the redemptions counted under the old window.
  if (from === "archived") return "Create a new promotion for the next campaign";
  return "Archive the promotion when the campaign is done";
}

/**
 * Move a promotion through draft → active → archived. Archived promotions
 * keep their history and can never return: reopening would reinterpret the
 * redemptions counted under the old window.
 */
export async function setPromotionStatus(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  id: string,
  status: PromotionStatus,
): Promise<Promotion> {
  await assertPromotionsFeature(runner, orgId);
  if (status !== "active" && status !== "archived") {
    throw refusal(`Promotion status ${status} is not a transition`, "invalid_input", 422, "Activate a draft or archive a promotion that is done");
  }
  const current = (await runner.execute<{ status: string; code: string }>(sql`
    select status, code from promotions where org_id = ${orgId} and id = ${id} for update`)).rows[0];
  if (!current) throw refusal("Promotion not found", "not_found", 404);
  const remedy = promotionStatusTransition(current.status as PromotionStatus, status);
  if (remedy !== null) {
    throw refusal(
      `Promotion ${current.code} is ${current.status} and cannot become ${status}`,
      "wrong_status",
      409,
      remedy,
    );
  }
  const updated = await runner.execute(sql`
    update promotions set status = ${status}, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and id = ${id} and status = ${current.status}`);
  if (updated.rowCount !== 1) throw refusal(`Promotion ${current.code} changed during the update`, "changed_concurrently", 409, "Reload the promotion and try again");
  await writePromotionAudit(runner, orgId, actorId, id, "update", { mode: "promotion_status", before: { status: current.status }, after: { status } });
  return readPromotion(runner, orgId, id);
}

export async function listPromotions(runner: SqlExecutor, orgId: string, activeOnly: boolean): Promise<Promotion[]> {
  const rows = (await runner.execute<PromotionRow>(sql`
    select ${PROMOTION_COLUMNS}
      from promotions where org_id = ${orgId} ${activeOnly ? sql`and status = 'active'` : sql``}
     order by code`)).rows;
  return rows.map(toPromotion);
}

type LockedDocument = {
  id: string;
  kind: string;
  status: string;
  document_number: string;
  currency: string;
  subsidiary_id: string | null;
  max_line: number | null;
};

type EligibleLine = {
  line_id: string;
  line_number: number;
  amount_units: bigint;
  quantity_units: bigint;
  unit_price_units: bigint;
};

export type AppliedPromotionLine = {
  lineId: string;
  lineNumber: number;
  amountMinor: string;
};

export type ApplyPromotionResult = {
  promotionId: string;
  code: string;
  discountMinor: string;
  currency: string;
  lines: AppliedPromotionLine[];
};

/**
 * Apply a promotion code to a draft sales document: resolve the promotion,
 * compute the discount in minor units, insert one discount line per
 * benefiting document line, and count the redemption under the promotion's
 * row lock so concurrent checkouts cannot overspend a usage limit. A
 * promotion applies to a document once, and stacked promotions together
 * never discount more than the document's discountable lines.
 */
export async function applyPromotion(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  input: {
    documentId: string;
    code?: string;
    promotionId?: string;
    /** The sale's channel. Documents carry no channel yet, so callers pass
     *  null; a channel-scoped promotion then refuses by name. */
    channelId?: string | null;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
): Promise<ApplyPromotionResult> {
  await assertPromotionsFeature(runner, orgId);
  const document = await lockDocument(runner, orgId, input.documentId, input.allowedSubsidiaryIds);
  const promotion = await lockPromotion(runner, orgId, input);
  // Checked while the document row is locked, so two concurrent applications
  // of one code to one document serialize and the second sees the first.
  await refuseRepeatApplication(runner, orgId, document, promotion);
  checkPromotionUsable(promotion, input.channelId ?? null);
  const discountAccountId = promotion.discountAccountId;
  if (!discountAccountId) {
    throw refusal(
      `Promotion ${promotion.code} has no discount account`,
      "discount_account_missing",
      422,
      "Set the discount account on the promotion in Setup → Sales → Promotions",
    );
  }
  const { lines, eligibleUnits, offsetUnits } = await loadEligibleLines(runner, orgId, document.id);
  if (lines.length === 0) {
    throw refusal(
      `Document ${document.document_number} has no lines a promotion can discount`,
      "no_discountable_lines",
      422,
      "Add a positively priced line before applying the promotion",
    );
  }
  // What is left to discount, in whole minor units, rounded down so the
  // stacked discounts can never take the discountable lines below zero.
  const remainingMinor = (eligibleUnits - offsetUnits) / 100n;
  if (remainingMinor <= 0n) {
    throw refusal(
      `Document ${document.document_number} is already fully discounted: its discount and credit lines offset all ${formatMoney(fromUnits(eligibleUnits))} ${document.currency} of discountable lines`,
      "fully_discounted",
      409,
      "Remove a discount line from the draft (Remove line in the line grid) and save before applying another promotion",
    );
  }
  const computed = computeDiscountShares(promotion, lines, document);
  if (computed.every((share) => share === 0n)) {
    throw refusal(`Promotion ${promotion.code} gives no discount on this document`, "below_threshold", 422, "Check the promotion value against the document lines");
  }
  const computedMinor = computed.reduce((sum, share) => sum + share, 0n);
  // A stacked promotion is capped at the remaining undiscounted amount and
  // re-dealt across the same lines in proportion, summing exactly.
  const shares = computedMinor > remainingMinor ? apportion(remainingMinor, computed) : computed;
  const inserted = await insertDiscountLines(runner, orgId, actorId, document, promotion, lines, shares, discountAccountId);
  await countRedemption(runner, orgId, promotion);
  const total = shares.reduce((sum, share) => sum + share, 0n);
  await writeDocumentAudit(runner, orgId, actorId, document.id, {
    event: "promotion_applied",
    promotionId: promotion.id,
    code: promotion.code,
    discountMinor: total.toString(),
    ...(total < computedMinor ? { cappedFromMinor: computedMinor.toString() } : {}),
    currency: document.currency,
    lineIds: inserted.map((line) => line.lineId),
  });
  return {
    promotionId: promotion.id,
    code: promotion.code,
    discountMinor: total.toString(),
    currency: document.currency,
    lines: inserted,
  };
}

async function lockDocument(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
  scope: ReadonlySet<string> | null,
): Promise<LockedDocument> {
  const row = (await runner.execute<LockedDocument>(sql`
    select d.id, d.kind, d.status, d.document_number, d.currency, d.subsidiary_id,
           (select max(line_number) from document_lines where org_id = ${orgId} and document_id = d.id) as max_line
      from documents d where d.org_id = ${orgId} and d.id = ${documentId} for update of d`)).rows[0];
  if (!row || !subsidiaryScopeAllows(scope, row.subsidiary_id)) {
    throw refusal("Sales document not found", "not_found", 404);
  }
  if (!APPLIABLE_KINDS.includes(row.kind)) {
    throw refusal(
      `Promotions apply to estimates, sales orders and invoices, not ${row.kind}`,
      "invalid_input",
      422,
      "Open an estimate, a sales order or an invoice to apply the promotion",
    );
  }
  if (row.status !== "draft") {
    throw refusal(`${row.document_number} is ${row.status}; promotions apply to drafts`, "wrong_status", 409, "Reopen the document to a draft before applying the promotion");
  }
  return row;
}

async function lockPromotion(
  runner: SqlExecutor,
  orgId: string,
  input: { code?: string; promotionId?: string },
): Promise<Promotion> {
  if (!input.promotionId && !input.code) {
    throw refusal("A promotion code is required", "invalid_input", 422, "Enter the code or pick an active promotion from the list");
  }
  const row = input.promotionId
    ? (await runner.execute<PromotionRow>(sql`
        select ${PROMOTION_COLUMNS}
          from promotions where org_id = ${orgId} and id = ${input.promotionId} for update`)).rows[0]
    : (await runner.execute<PromotionRow>(sql`
        select ${PROMOTION_COLUMNS}
          from promotions where org_id = ${orgId} and lower(code) = lower(${parseCode(input.code)}) for update`)).rows[0];
  if (!row) {
    throw refusal(
      input.promotionId ? "Promotion not found" : `Promotion code ${String(input.code)} does not exist`,
      "not_found",
      404,
      "Check the code spelling or pick an active promotion from the list",
    );
  }
  return toPromotion(row);
}

function checkPromotionUsable(promotion: Promotion, channelId: string | null): void {
  if (promotion.status !== "active") {
    throw refusal(
      `Promotion ${promotion.code} is ${promotion.status}`,
      "wrong_status",
      409,
      promotion.status === "draft" ? "Activate the promotion in Setup → Sales → Promotions" : "Create a new promotion for the next campaign",
    );
  }
  if (promotion.startsInFuture) {
    throw refusal(`Promotion ${promotion.code} starts on ${promotion.startsAt}`, "not_started", 409, `Wait until ${promotion.startsAt} or change the promotion window`);
  }
  if (promotion.ended) {
    throw refusal(`Promotion ${promotion.code} ended on ${promotion.endsAt}`, "expired", 409, "Extend the promotion window or create a new promotion");
  }
  if (promotion.channelScopeId && promotion.channelScopeId !== channelId) {
    throw refusal(
      `Promotion ${promotion.code} is scoped to another channel`,
      "wrong_channel",
      409,
      "Apply the promotion from its scoped channel or remove the channel scope on the promotion",
    );
  }
  if (promotion.usageLimit !== null && promotion.usageCount >= promotion.usageLimit) {
    throw refusal(
      `Promotion ${promotion.code} has reached its usage limit of ${promotion.usageLimit}`,
      "limit_reached",
      409,
      "Raise the usage limit on the promotion or create a new promotion",
    );
  }
}

async function refuseRepeatApplication(
  runner: SqlExecutor,
  orgId: string,
  document: LockedDocument,
  promotion: Promotion,
): Promise<void> {
  const applied = (await runner.execute<{ applied: boolean }>(sql`
    select exists (select 1 from document_lines
                    where org_id = ${orgId} and document_id = ${document.id}
                      and promotion_id = ${promotion.id}) as applied`)).rows[0];
  if (applied?.applied) {
    throw refusal(
      `Promotion ${promotion.code} is already applied to ${document.document_number}`,
      "already_applied",
      409,
      `Remove the ${promotion.code} discount lines from the draft (Remove line in the line grid) and save before applying it again`,
    );
  }
}

async function loadEligibleLines(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<{ lines: EligibleLine[]; eligibleUnits: bigint; offsetUnits: bigint }> {
  // Only positively priced, promotion-free lines can be discounted: existing
  // discount and credit lines are never discounted twice. Every negative
  // line, tagged with a promotion or not, already reduces what is left to
  // discount, so it is summed as an offset. All lines are locked so the
  // offsets cannot move while the new discount is sized.
  const rows = (await runner.execute<{ line_id: string; line_number: number; amount: string; quantity: string; unit_price: string; promotion_id: string | null }>(sql`
    select id as line_id, line_number, amount::text, quantity::text, unit_price::text, promotion_id
      from document_lines
     where org_id = ${orgId} and document_id = ${documentId}
     order by line_number for update`)).rows;
  const lines: EligibleLine[] = [];
  let eligibleUnits = 0n;
  let offsetUnits = 0n;
  for (const row of rows) {
    const amountUnits = toUnits(row.amount);
    if (amountUnits < 0n) offsetUnits -= amountUnits;
    if (row.promotion_id !== null || amountUnits <= 0n) continue;
    eligibleUnits += amountUnits;
    lines.push({
      line_id: row.line_id,
      line_number: row.line_number,
      amount_units: amountUnits,
      quantity_units: toUnits(row.quantity),
      unit_price_units: toUnits(row.unit_price),
    });
  }
  return { lines, eligibleUnits, offsetUnits };
}

const MICRO_PER_UNIT = 1_000_000n;

/** Per-line discount shares in minor units, summing exactly to the promotion value. */
function computeDiscountShares(promotion: Promotion, lines: EligibleLine[], document: LockedDocument): bigint[] {
  switch (promotion.kind) {
    case "percent": {
      // Exact 4dp shares, then largest-remainder dealing to the cent so the
      // inserted lines sum to the penny the operator was promised.
      const exact = lines.map((line) =>
        fromUnits(roundDiv(line.amount_units * toUnits(promotion.percentValue!), MICRO_PER_UNIT)),
      );
      return allocateLargestRemainder(exact, 2).map(toCents);
    }
    case "amount": {
      if (promotion.currency !== document.currency) {
        throw refusal(
          `Promotion ${promotion.code} is priced in ${promotion.currency} but the document is in ${document.currency}`,
          "currency_mismatch",
          422,
          "Price the promotion in the document currency or invoice in the promotion currency",
        );
      }
      const base = lines.map((line) => toCents(fromUnits(line.amount_units)));
      const total = promotion.amountMinor! < base.reduce((sum, minor) => sum + minor, 0n)
        ? promotion.amountMinor!
        : base.reduce((sum, minor) => sum + minor, 0n);
      if (total <= 0n) return lines.map(() => 0n);
      return apportion(total, base);
    }
    case "buy_x_get_y": {
      return buyXGetYShares(promotion, lines);
    }
    case "free_shipping": {
      // Documents carry no shipping charges in this release, so there is
      // nothing to discount; the code stays catalogued for the storefront,
      // which prices shipping itself.
      throw refusal(
        `Promotion ${promotion.code} covers shipping, which sales documents do not charge`,
        "free_shipping_unsupported",
        422,
        "Apply a percent or amount promotion to the document instead",
      );
    }
  }
}

function buyXGetYShares(promotion: Promotion, lines: EligibleLine[]): bigint[] {
  const buy = promotion.buyQuantity!;
  const get = promotion.getQuantity!;
  const wholeUnits = lines.map((line) => line.quantity_units / 10_000n);
  const totalUnits = wholeUnits.reduce((sum, units) => sum + units, 0n);
  // Each free unit is earned by units the customer pays for, so a complete
  // group is buy + get units: buy 1 get 1 frees one of two units, never the
  // single unit that qualified for the offer.
  const groupSize = buy + get;
  const freeUnits = (totalUnits / BigInt(groupSize)) * BigInt(get);
  if (freeUnits <= 0n) {
    throw refusal(
      `Promotion ${promotion.code} needs at least ${groupSize} units on the document (buy ${buy}, get ${get} free)`,
      "below_threshold",
      422,
      `Add units until the document has ${groupSize} or more before applying the promotion`,
    );
  }
  // Cheapest whole units go free first: deterministic across postings.
  const order = lines
    .map((line, index) => index)
    .sort((a, b) => {
      const diff = lines[a]!.unit_price_units - lines[b]!.unit_price_units;
      return diff < 0n ? -1 : diff > 0n ? 1 : a - b;
    });
  const shares = lines.map(() => 0n);
  let remaining = freeUnits;
  for (const index of order) {
    if (remaining <= 0n) break;
    const take = wholeUnits[index]! < remaining ? wholeUnits[index]! : remaining;
    // Whole units times 4dp unit-price units, rounded once to the minor unit.
    shares[index] = roundDiv(take * lines[index]!.unit_price_units, 100n);
    remaining -= take;
  }
  return shares;
}

async function insertDiscountLines(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  document: LockedDocument,
  promotion: Promotion,
  lines: EligibleLine[],
  shares: bigint[],
  discountAccountId: string,
): Promise<AppliedPromotionLine[]> {
  const inserted: AppliedPromotionLine[] = [];
  let lineNumber = (document.max_line ?? 0) + 1;
  for (let index = 0; index < lines.length; index++) {
    const share = shares[index]!;
    if (share <= 0n) continue;
    // Money columns carry four decimals; a cent share scales up exactly.
    const amount = fromUnits(-share * 100n);
    const row = (await runner.execute<{ id: string }>(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, description, quantity,
                                  unit_price, amount, tax_amount, tax_overridden, is_billable,
                                  quantity_fulfilled, quantity_billed, promotion_id, custom,
                                  created_by, updated_by)
      values (${orgId}, ${document.id}, ${lineNumber}, ${discountAccountId},
              ${`Promotion ${promotion.code} — ${promotion.name}`}, '1', ${amount}, ${amount},
              '0', false, false, '0', '0', ${promotion.id}, '{}'::jsonb, ${actorId}, ${actorId})
      returning id`)).rows[0];
    if (!row) throw refusal(`Promotion ${promotion.code} could not add its discount line`, "changed_concurrently", 409, "Reload the document and apply the promotion again");
    inserted.push({ lineId: row.id, lineNumber, amountMinor: share.toString() });
    lineNumber += 1;
  }
  if (inserted.length === 0) {
    throw refusal(`Promotion ${promotion.code} gives no discount on this document`, "below_threshold", 422, "Check the promotion value against the document lines");
  }
  return inserted;
}

async function countRedemption(runner: SqlExecutor, orgId: string, promotion: Promotion): Promise<void> {
  // The promotion row is already locked by lockPromotion, so the count and
  // the limit check serialize against concurrent checkouts.
  const updated = await runner.execute(sql`
    update promotions set usage_count = usage_count + 1, updated_at = now()
     where org_id = ${orgId} and id = ${promotion.id} and usage_count = ${promotion.usageCount}`);
  if (updated.rowCount !== 1) {
    throw refusal(`Promotion ${promotion.code} changed while applying`, "changed_concurrently", 409, "Reload the document and apply the promotion again");
  }
}

async function writePromotionAudit(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  promotionId: string,
  action: "insert" | "update",
  changes: Record<string, unknown>,
): Promise<void> {
  const result = await runner.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'promotions', ${promotionId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`);
  if (result.rows.length !== 1) throw new Error("promotion change was not audited");
}

async function writeDocumentAudit(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  documentId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const result = await runner.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'documents', ${documentId}, 'update', ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`);
  if (result.rows.length !== 1) throw new Error("promotion application was not audited");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "23505";
}
