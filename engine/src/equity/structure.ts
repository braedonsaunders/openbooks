/**
 * The capital structure of a legal entity: share classes and their
 * amendments, stock splits, equity plans and their reserve changes, and
 * financing rounds.
 *
 * Every command runs in one tenant transaction behind the feature fence,
 * checks the actor's live authority for the legal entity, takes the
 * entity's equity lock, re-reads the entity's history and validates against
 * it, writes one retained row, and audits it with the actor, the before and
 * after state and the reason. Every command is the equity.manage duty;
 * amending a class, changing a plan reserve and recording a split are
 * governed actions an Equity action Flow may require approval for (see
 * governance.ts).
 *
 * A preferred class names the common class it converts into and whether its
 * conversion price adjusts for that class's splits. A split of a common
 * class therefore adjusts every preferred class that converts into it under
 * adjusting terms; the split refuses while a preferred class has not named
 * its conversion class, so no conversion price is left to guesswork, and it
 * must postdate the adjusted classes' activity as well as its own class's.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  authorizedShares,
  buildCapTable,
  classCommitted,
  conversionClassOf,
  conversionPrice,
  planPool,
} from "./cap-table.ts";
import { equityError, fig } from "./errors.ts";
import type { EquityTermName } from "./refusals/terms.ts";
import { spotRate } from "./fx.ts";
import { governEquityAction, type GovernedStatus } from "./governance.ts";
import {
  assertEquityFeature,
  currencyExponent,
  loadLegalEntity,
  lockEquityEntity,
  requireEquityAuthority,
  REASON_LENGTH,
  requireReason,
  writeEquityAudit,
  type EquityPermission,
} from "./internal.ts";
import {
  compareRational,
  divideRational,
  formatMoney,
  formatPrice,
  multiplyRational,
  parseDecimal,
  parsePrice,
  parseShares,
  PERCENT_SCALE,
  PRICE_SCALE,
  formatUnits,
  quantize,
  rational,
  subtractRational,
  type Rational,
} from "./quantities.ts";
import { bookBeforeRound } from "./round-conversion.ts";
import { restatePrice, validateSplitRatio } from "./splits.ts";
import { syncPositionLedger } from "./positions.ts";
import { loadEquityBook } from "./store.ts";
import {
  LIQUIDATION_PREFERENCE_BASES,
  type AntiDilution,
  type EquityBook,
  type LiquidationPreferenceBasis,
  type Participation,
  type FinancingRoundRecord,
  type ShareClassKind,
  type ShareClassRecord,
} from "./types.ts";

export interface EquityCommand {
  orgId: string;
  actorId: string;
}

/** A civil date input; anything else refuses naming the field by its form label. */
export function requireDate(value: unknown, field: string, label: EquityTermName): string {
  if (typeof value !== "string" || !isIsoCalendarDate(value))
    throw equityError("dateInvalid", { label: fig.term(label) }, { field });
  return value;
}

function requireText(value: unknown, field: string, label: EquityTermName, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 1 || text.length > max)
    throw equityError("textInvalid", { label: fig.term(label), max: fig.count(max) }, { field });
  return text;
}

/** Run one equity command for a legal entity: fence, authority, entity lock, then the work against a fresh book. */
export async function inEquityCommand<T>(
  input: EquityCommand & { subsidiaryId: string },
  permission: EquityPermission,
  work: (context: { currency: string; entityName: string; book: EquityBook }) => Promise<T>,
): Promise<T> {
  return withOrgTransaction(input.orgId, async () => {
    await assertEquityFeature(db, input.orgId);
    const entity = await loadLegalEntity(db, input.orgId, input.subsidiaryId);
    await requireEquityAuthority(db, input.orgId, input.actorId, input.subsidiaryId, permission);
    await lockEquityEntity(db, input.orgId, input.subsidiaryId);
    const book = await loadEquityBook(db, input.orgId, input.subsidiaryId);
    const result = await work({ currency: entity.currency, entityName: entity.name, book });
    // Every equity write leaves the position ledger reconciled to the replayed history.
    await syncPositionLedger(db, input.orgId, input.subsidiaryId);
    return result;
  });
}

/** Dates on which a class's committed shares or authorized count can change, from `from` onward. */
function classCheckDates(book: EquityBook, shareClassId: string, from: string): string[] {
  const dates = new Set<string>([from]);
  for (const security of book.securities)
    if (security.shareClassId === shareClassId && security.issueDate >= from)
      dates.add(security.issueDate);
  for (const event of book.events) if (event.effectiveOn >= from) dates.add(event.effectiveOn);
  for (const change of book.reserveChanges)
    if (change.effectiveOn >= from) dates.add(change.effectiveOn);
  for (const plan of book.plans)
    if (plan.shareClassId === shareClassId && plan.effectiveOn >= from) dates.add(plan.effectiveOn);
  for (const amendment of book.amendments)
    if (amendment.shareClassId === shareClassId && amendment.effectiveOn >= from)
      dates.add(amendment.effectiveOn);
  for (const split of book.splits)
    if (split.shareClassId === shareClassId && split.effectiveOn >= from)
      dates.add(split.effectiveOn);
  return [...dates].sort();
}

/** What a commitment check guards, so its refusal names the remedy that fits the action. */
export type CommitmentPurpose =
  "issue" | "authorized_amendment" | "reserve_increase" | "plan" | "reversal";

/**
 * Refuse when the class's outstanding shares, outstanding awards and
 * unallocated pools would exceed its authorized shares on any date from
 * `from` onward.
 */
export function assertWithinAuthorized(
  book: EquityBook,
  shareClassId: string,
  from: string,
  purpose: CommitmentPurpose = "issue",
  room: bigint = 0n,
): void {
  const shareClass = book.classes.find((row) => row.id === shareClassId);
  if (!shareClass) throw equityError("classUnknown", {}, { field: "shareClassId" });
  for (const date of classCheckDates(book, shareClassId, from)) {
    if (date < shareClass.effectiveOn) continue;
    const committed = classCommitted(book, shareClassId, date);
    const authorized = authorizedShares(book, shareClass, date);
    if (committed > authorized) {
      throw equityError(
        "authorizedExceeded",
        {
          shareClass: fig.text(shareClass.code),
          committed: fig.shares(committed),
          authorized: fig.shares(authorized),
          excess: fig.shares(committed - authorized),
          room: fig.shares(room),
          date: fig.date(date),
          purpose: fig.choice(purpose),
        },
        { field: purpose === "authorized_amendment" ? "authorizedShares" : undefined },
      );
    }
  }
}

/** Refuse when a plan's unallocated pool would fall below zero on any date from `from` onward. */
export function assertPoolsCovered(
  book: EquityBook,
  planId: string,
  from: string,
  options: { reduction?: { maximum: bigint } } = {},
): void {
  const plan = book.plans.find((row) => row.id === planId);
  if (!plan) throw equityError("planUnknown", {}, { field: "planId" });
  for (const date of classCheckDates(book, plan.shareClassId, from)) {
    if (date < plan.effectiveOn) continue;
    const pool = planPool(book, plan, date);
    if (pool.available < 0n) {
      const reduction = options.reduction;
      throw equityError(
        "poolExhausted",
        {
          plan: fig.text(plan.code),
          available: fig.shares(pool.available),
          date: fig.date(date),
          from: fig.date(from),
          maximum: fig.shares(reduction?.maximum ?? 0n),
          shortfall: fig.shares(-pool.available),
          action: fig.choice(reduction ? (reduction.maximum > 0n ? "reduce" : "empty") : "grant"),
        },
        { field: reduction ? "shareDelta" : undefined },
      );
    }
  }
}

/** The smallest unallocated pool of a plan on any date from `from` onward: how much of its reserve can be removed then. */
export function poolHeadroom(book: EquityBook, planId: string, from: string): bigint {
  const plan = book.plans.find((row) => row.id === planId)!;
  let minimum: bigint | null = null;
  for (const date of classCheckDates(book, plan.shareClassId, from)) {
    if (date < plan.effectiveOn) continue;
    const available = planPool(book, plan, date).available;
    if (minimum === null || available < minimum) minimum = available;
  }
  return minimum !== null && minimum > 0n ? minimum : 0n;
}

/** Shares a class can still commit on every date from `from` onward: its smallest authorized headroom. */
export function authorizedHeadroom(book: EquityBook, shareClassId: string, from: string): bigint {
  const shareClass = book.classes.find((row) => row.id === shareClassId)!;
  let minimum: bigint | null = null;
  for (const date of classCheckDates(book, shareClassId, from)) {
    if (date < shareClass.effectiveOn) continue;
    const room =
      authorizedShares(book, shareClass, date) - classCommitted(book, shareClassId, date);
    if (minimum === null || room < minimum) minimum = room;
  }
  return minimum !== null && minimum > 0n ? minimum : 0n;
}

/**
 * The latest date of the class's own recorded activity, which a split must
 * postdate so no recorded quantity is reinterpreted: its securities' issue
 * dates and events, its amendments, splits, plans and their reserve changes.
 */
function latestClassActivity(book: EquityBook, shareClassId: string): string | null {
  const own = new Set(
    book.securities.filter((row) => row.shareClassId === shareClassId).map((row) => row.id),
  );
  const plans = new Set(
    book.plans.filter((row) => row.shareClassId === shareClassId).map((row) => row.id),
  );
  const shareClass = book.classes.find((row) => row.id === shareClassId);
  const dates: string[] = shareClass ? [shareClass.effectiveOn] : [];
  for (const security of book.securities) if (own.has(security.id)) dates.push(security.issueDate);
  for (const event of book.events) if (own.has(event.securityId)) dates.push(event.effectiveOn);
  for (const plan of book.plans) if (plans.has(plan.id)) dates.push(plan.effectiveOn);
  for (const change of book.reserveChanges)
    if (plans.has(change.planId)) dates.push(change.effectiveOn);
  for (const amendment of book.amendments)
    if (amendment.shareClassId === shareClassId) dates.push(amendment.effectiveOn);
  for (const split of book.splits)
    if (split.shareClassId === shareClassId) dates.push(split.effectiveOn);
  return dates.sort().at(-1) ?? null;
}

export interface CreateShareClassInput extends EquityCommand {
  subsidiaryId: string;
  code: string;
  name: string;
  kind: ShareClassKind;
  effectiveOn: string;
  authorizedShares: string;
  parValue: string;
  originalIssuePrice?: string | null;
  conversionPrice?: string | null;
  liquidationMultiple?: string | null;
  /** What a preferred class's liquidation preference is measured on (default: the amount paid for each certificate). */
  liquidationPreferenceBasis?: LiquidationPreferenceBasis | null;
  participation?: Participation;
  participationCapMultiple?: string | null;
  seniority?: number;
  antiDilution?: AntiDilution;
  /** The common class a preferred class converts into. */
  conversionShareClassId?: string | null;
  /** Whether the conversion price adjusts for splits of the conversion class (default: yes). */
  conversionAdjustsForSplits?: boolean;
}

export async function createShareClass(input: CreateShareClassInput): Promise<{ id: string }> {
  const code = requireText(input.code, "code", "code", 40);
  const name = requireText(input.name, "name", "name", 200);
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "effectiveOn");
  const authorized = parseShares(input.authorizedShares, "authorizedShares");
  if (authorized <= 0n)
    throw equityError(
      "authorizedSharesNotPositive",
      { field: fig.term("authorizedShares") },
      { field: "authorizedShares" },
    );
  const par = parsePrice(input.parValue, "parValue");
  if (par.numerator < 0n)
    throw equityError("parValueNegative", { field: fig.term("parValue") }, { field: "parValue" });
  const kind = input.kind;
  if (kind !== "common" && kind !== "preferred")
    throw equityError("classKindInvalid", { field: fig.term("classKind") }, { field: "kind" });
  const participation: Participation =
    kind === "preferred" ? (input.participation ?? "none") : "none";
  const antiDilution: AntiDilution = kind === "preferred" ? (input.antiDilution ?? "none") : "none";
  const seniority = input.seniority ?? 0;
  if (!Number.isInteger(seniority) || seniority < 0 || seniority > 1000)
    throw equityError(
      "classSeniorityInvalid",
      { field: fig.term("seniority"), min: fig.count(0), max: fig.count(1000) },
      { field: "seniority" },
    );
  let originalIssuePrice: string | null = null;
  let conversionPrice: string | null = null;
  let multiple: string | null = null;
  let cap: string | null = null;
  if (kind === "preferred") {
    const issue = parsePrice(input.originalIssuePrice ?? "", "originalIssuePrice");
    const conversion = input.conversionPrice
      ? parsePrice(input.conversionPrice, "conversionPrice")
      : issue;
    const liquidation = parseDecimal(
      input.liquidationMultiple ?? "1",
      "liquidationMultiple",
      PERCENT_SCALE,
    );
    if (issue.numerator <= 0n || conversion.numerator <= 0n)
      throw equityError(
        "preferredPricesNotPositive",
        { issue: fig.term("originalIssuePrice"), conversion: fig.term("conversionPrice") },
        { field: "originalIssuePrice" },
      );
    if (liquidation.numerator < 0n)
      throw equityError(
        "liquidationMultipleNegative",
        { field: fig.term("liquidationMultiple"), example: fig.multiple("1") },
        { field: "liquidationMultiple" },
      );
    originalIssuePrice = input.originalIssuePrice!.trim();
    conversionPrice = (input.conversionPrice ?? input.originalIssuePrice)!.trim();
    multiple = (input.liquidationMultiple ?? "1").trim();
    if (participation === "capped") {
      const capMultiple = parseDecimal(
        input.participationCapMultiple ?? "",
        "participationCapMultiple",
        PERCENT_SCALE,
      );
      if (compareRational(capMultiple, liquidation) <= 0) {
        throw equityError(
          "participationCapNotAboveMultiple",
          {
            field: fig.term("participationCapMultiple"),
            cap: fig.multiple(input.participationCapMultiple!.trim()),
            multiple: fig.multiple(multiple),
          },
          { field: "participationCapMultiple" },
        );
      }
      cap = input.participationCapMultiple!.trim();
    }
  }
  const adjustsForSplits = kind === "preferred" ? input.conversionAdjustsForSplits !== false : true;
  const preferenceBasis: LiquidationPreferenceBasis =
    input.liquidationPreferenceBasis ?? "amount_paid";
  if (!LIQUIDATION_PREFERENCE_BASES.includes(preferenceBasis)) {
    throw equityError(
      "liquidationPreferenceBasisInvalid",
      { field: fig.term("liquidationPreferenceBasis") },
      { field: "liquidationPreferenceBasis" },
    );
  }
  return inEquityCommand(input, "equity.manage", async ({ book }) => {
    if (book.classes.some((row) => row.code.toLowerCase() === code.toLowerCase())) {
      throw equityError("classCodeTaken", { code: fig.text(code) }, { field: "code" });
    }
    let conversionClassId: string | null = null;
    if (kind === "preferred") {
      const target = book.classes.find((row) => row.id === input.conversionShareClassId);
      if (!target || target.kind !== "common") {
        throw equityError(
          "conversionClassRequired",
          { field: fig.term("conversionClass") },
          { field: "conversionShareClassId" },
        );
      }
      if (target.effectiveOn > effectiveOn) {
        throw equityError(
          "conversionClassNotYetEffective",
          { target: fig.text(target.code), date: fig.date(target.effectiveOn) },
          { field: "conversionShareClassId" },
        );
      }
      conversionClassId = target.id;
    } else if (input.conversionShareClassId) {
      throw equityError(
        "conversionClassOnCommon",
        { field: fig.term("conversionClass") },
        { field: "conversionShareClassId" },
      );
    }
    const row = (
      await db.execute<{ id: string }>(
        sql`
      insert into equity_share_classes (org_id, subsidiary_id, code, name, kind, effective_on, initial_authorized_shares, par_value,
        original_issue_price, initial_conversion_price, liquidation_multiple, liquidation_preference_basis, participation, participation_cap_multiple, seniority,
        anti_dilution, conversion_share_class_id, conversion_adjusts_for_splits, created_by)
      values (${input.orgId}, ${input.subsidiaryId}, ${code}, ${name}, ${kind}, ${effectiveOn}::date, ${authorized.toString()}::bigint,
        ${input.parValue.trim()}::numeric, ${originalIssuePrice}::numeric, ${conversionPrice}::numeric, ${multiple}::numeric, ${preferenceBasis},
        ${participation}, ${cap}::numeric, ${seniority}, ${antiDilution}, ${conversionClassId}, ${adjustsForSplits}, ${input.actorId})
      returning id`,
        "objects",
      )
    )[0];
    if (!row) throw equityError("notSaved", { record: fig.choice("shareClass") });
    await writeEquityAudit(db, {
      orgId: input.orgId,
      table: "equity_share_classes",
      rowId: row.id,
      action: "equity.class.create",
      actorId: input.actorId,
      changes: {
        before: null,
        after: {
          code,
          name,
          kind,
          effectiveOn,
          authorizedShares: authorized,
          parValue: input.parValue,
          originalIssuePrice,
          conversionPrice,
          liquidationMultiple: multiple,
          liquidationPreferenceBasis: kind === "preferred" ? preferenceBasis : null,
          participation,
          participationCapMultiple: cap,
          seniority,
          antiDilution,
          conversionShareClassId: conversionClassId,
          conversionAdjustsForSplits: adjustsForSplits,
        },
      },
    });
    return { id: row.id };
  });
}

/** Load a share class with its legal entity; unknown classes refuse with a 404. */
async function classEntity(orgId: string, shareClassId: string): Promise<string> {
  return (await classOwner(orgId, shareClassId)).subsidiaryId;
}

async function classOwner(
  orgId: string,
  shareClassId: string,
): Promise<{ subsidiaryId: string; code: string }> {
  if (!isUuid(shareClassId)) throw equityError("classIdUnknown");
  const row = await withOrgTransaction(
    orgId,
    async () =>
      (
        await db.execute<{ subsidiary_id: string; code: string }>(
          sql`
    select subsidiary_id, code from equity_share_classes where org_id = ${orgId} and id = ${shareClassId}`,
          "objects",
        )
      )[0],
  );
  if (!row) throw equityError("classIdUnknown");
  return { subsidiaryId: row.subsidiary_id, code: row.code };
}

/** A governed structure change's outcome: its record once applied, null while it awaits approval. */
export interface GovernedRecord {
  id: string | null;
  status: GovernedStatus;
  requestId: string;
}

const payloadOf = <T extends EquityCommand>(input: T): Omit<T, "orgId" | "actorId"> => {
  const { orgId: _org, actorId: _actor, ...rest } = input;
  return rest;
};

export interface AmendShareClassInput extends EquityCommand {
  shareClassId: string;
  kind: "authorized_shares" | "conversion_price" | "conversion_class";
  effectiveOn: string;
  authorizedShares?: string | null;
  conversionPrice?: string | null;
  /** The common class a preferred class converts into from the date. */
  conversionShareClassId?: string | null;
  reason: string;
}

/**
 * Amend a class's authorized shares, conversion price or conversion class
 * from a date (a governed action: an Equity action Flow may require approval).
 */
export async function amendShareClass(input: AmendShareClassInput): Promise<GovernedRecord> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "effectiveOn");
  const reason = requireReason(input.reason, "classAmendment");
  const owner = await classOwner(input.orgId, input.shareClassId);
  const outcome = await governEquityAction(
    {
      orgId: input.orgId,
      actorId: input.actorId,
      subsidiaryId: owner.subsidiaryId,
      action: "class_amendment",
      subjectId: input.shareClassId,
      subjectLabel: `Class ${owner.code}`,
      effectiveOn,
      reason,
      summary: {
        shareClassCode: owner.code,
        quantity: input.authorizedShares ?? null,
        amount: input.conversionPrice ?? null,
      },
      payload: payloadOf(input),
      idempotencyKey: null,
    },
    (actorId) => applyShareClassAmendment({ ...input, actorId }),
  );
  return { id: outcome.result?.id ?? null, status: outcome.status, requestId: outcome.requestId };
}

/** Apply a class amendment: the command its approval releases. */
export async function applyShareClassAmendment(
  input: AmendShareClassInput,
): Promise<{ id: string }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "effectiveOn");
  const reason = requireReason(input.reason, "classAmendment");
  const subsidiaryId = await classEntity(input.orgId, input.shareClassId);
  return inEquityCommand({ ...input, subsidiaryId }, "equity.manage", async ({ book }) => {
    const shareClass = book.classes.find((row) => row.id === input.shareClassId)!;
    if (effectiveOn < shareClass.effectiveOn) {
      throw equityError(
        "classAmendmentBeforeClass",
        { shareClass: fig.text(shareClass.code), date: fig.date(shareClass.effectiveOn) },
        { field: "effectiveOn" },
      );
    }
    let authorized: bigint | null = null;
    let conversion: string | null = null;
    let conversionClassId: string | null = null;
    let before: Record<string, unknown>;
    if (input.kind === "authorized_shares") {
      authorized = parseShares(input.authorizedShares ?? "", "authorizedShares");
      if (authorized <= 0n)
        throw equityError(
          "authorizedSharesNotPositive",
          { field: fig.term("authorizedShares") },
          { field: "authorizedShares" },
        );
      before = { authorizedShares: authorizedShares(book, shareClass, effectiveOn) };
    } else if (input.kind === "conversion_price") {
      if (shareClass.kind !== "preferred")
        throw equityError("conversionPriceAmendmentOnCommon", {}, { field: "kind" });
      const price = parsePrice(input.conversionPrice ?? "", "conversionPrice");
      if (price.numerator <= 0n)
        throw equityError(
          "conversionPriceNotPositive",
          { field: fig.term("conversionPrice") },
          { field: "conversionPrice" },
        );
      conversion = input.conversionPrice!.trim();
      const current = conversionPrice(book, shareClass, effectiveOn);
      before = { conversionPrice: current ? formatPrice(current) : null };
    } else if (input.kind === "conversion_class") {
      if (shareClass.kind !== "preferred")
        throw equityError("conversionClassAmendmentOnCommon", {}, { field: "kind" });
      const target = book.classes.find((row) => row.id === input.conversionShareClassId);
      if (!target || target.kind !== "common")
        throw equityError(
          "conversionClassRequired",
          { field: fig.term("conversionClass") },
          { field: "conversionShareClassId" },
        );
      if (target.effectiveOn > effectiveOn)
        throw equityError(
          "conversionClassNotEffectiveForAmendment",
          { target: fig.text(target.code), date: fig.date(target.effectiveOn) },
          { field: "effectiveOn" },
        );
      const current = conversionClassOf(book, shareClass, effectiveOn);
      if (current === target.id)
        throw equityError(
          "conversionClassUnchanged",
          { shareClass: fig.text(shareClass.code), target: fig.text(target.code) },
          { field: "conversionShareClassId" },
        );
      const laterSplit = book.splits.find(
        (split) =>
          split.effectiveOn >= effectiveOn &&
          (split.shareClassId === target.id || split.shareClassId === current),
      );
      if (laterSplit) {
        throw equityError(
          "conversionClassSplitRecorded",
          { date: fig.date(laterSplit.effectiveOn) },
          { field: "effectiveOn" },
        );
      }
      conversionClassId = target.id;
      before = { conversionShareClassId: current };
    } else {
      throw equityError("classAmendmentKindInvalid", {}, { field: "kind" });
    }
    const amended: EquityBook = {
      ...book,
      amendments: [
        ...book.amendments,
        {
          id: "pending",
          shareClassId: shareClass.id,
          kind: input.kind,
          effectiveOn,
          authorizedShares: authorized,
          conversionPrice: conversion,
          conversionShareClassId: conversionClassId,
          reason,
        },
      ],
    };
    if (input.kind === "authorized_shares")
      assertWithinAuthorized(amended, shareClass.id, effectiveOn, "authorized_amendment");
    const row = (
      await db.execute<{ id: string }>(
        sql`
      insert into equity_class_amendments (org_id, subsidiary_id, share_class_id, kind, effective_on, authorized_shares, conversion_price,
        conversion_share_class_id, reason, created_by)
      values (${input.orgId}, ${subsidiaryId}, ${shareClass.id}, ${input.kind}, ${effectiveOn}::date, ${authorized?.toString() ?? null}::bigint,
        ${conversion}::numeric, ${conversionClassId}, ${reason}, ${input.actorId})
      returning id`,
        "objects",
      )
    )[0];
    if (!row) throw equityError("notSaved", { record: fig.choice("classAmendment") });
    const after =
      input.kind === "authorized_shares"
        ? { authorizedShares: authorized }
        : input.kind === "conversion_price"
          ? { conversionPrice: conversion }
          : { conversionShareClassId: conversionClassId };
    await writeEquityAudit(db, {
      orgId: input.orgId,
      table: "equity_share_classes",
      rowId: shareClass.id,
      action: "equity.class.amend",
      actorId: input.actorId,
      changes: { amendmentId: row.id, kind: input.kind, effectiveOn, before, after, reason },
    });
    return { id: row.id };
  });
}

export interface RecordSplitInput extends EquityCommand {
  shareClassId: string;
  effectiveOn: string;
  ratioNumerator: string;
  ratioDenominator: string;
  reason: string;
}

/**
 * Record a stock split (a governed action). It must postdate every recorded
 * activity of the class, so quantities already recorded keep the terms they
 * were stated in.
 */
export interface SplitResult {
  id: string;
  adjustedClasses: {
    shareClassId: string;
    code: string;
    conversionPriceBefore: string | null;
    conversionPriceAfter: string | null;
  }[];
}

export async function recordSplit(
  input: RecordSplitInput,
): Promise<Omit<SplitResult, "id"> & GovernedRecord> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "effectiveOn");
  const reason = requireReason(input.reason, "split");
  const owner = await classOwner(input.orgId, input.shareClassId);
  const outcome = await governEquityAction(
    {
      orgId: input.orgId,
      actorId: input.actorId,
      subsidiaryId: owner.subsidiaryId,
      action: "split",
      subjectId: input.shareClassId,
      subjectLabel: `Class ${owner.code} ${input.ratioNumerator}:${input.ratioDenominator}`,
      effectiveOn,
      reason,
      summary: { shareClassCode: owner.code, quantity: null, amount: null },
      payload: payloadOf(input),
      idempotencyKey: null,
    },
    (actorId) => applySplit({ ...input, actorId }),
  );
  return {
    id: outcome.result?.id ?? null,
    adjustedClasses: outcome.result?.adjustedClasses ?? [],
    status: outcome.status,
    requestId: outcome.requestId,
  };
}

/** Apply a stock split: the command its approval releases. */
export async function applySplit(input: RecordSplitInput): Promise<SplitResult> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "effectiveOn");
  const reason = requireReason(input.reason, "split");
  const numerator = parseShares(input.ratioNumerator, "splitNew");
  const denominator = parseShares(input.ratioDenominator, "splitOld");
  validateSplitRatio(numerator, denominator);
  const subsidiaryId = await classEntity(input.orgId, input.shareClassId);
  return inEquityCommand({ ...input, subsidiaryId }, "equity.manage", async ({ book }) => {
    const shareClass = book.classes.find((row) => row.id === input.shareClassId)!;
    const latest = latestClassActivity(book, shareClass.id);
    if (latest !== null && effectiveOn <= latest) {
      throw equityError(
        "splitBackdated",
        { shareClass: fig.text(shareClass.code), date: fig.date(latest) },
        { field: "effectiveOn" },
      );
    }
    // A common split adjusts the conversion price of every preferred class converting into it under adjusting terms.
    const adjusted: { id: string; code: string; before: string | null; after: string | null }[] =
      [];
    if (shareClass.kind === "common") {
      const preferred = book.classes.filter(
        (row) => row.kind === "preferred" && row.effectiveOn <= effectiveOn,
      );
      const unnamed = preferred.filter((row) => conversionClassOf(book, row, effectiveOn) === null);
      if (unnamed.length > 0) {
        throw equityError("splitConversionClassMissing", {
          codes: fig.list(unnamed.map((row) => row.code)),
          classes: fig.count(unnamed.length),
          field: fig.term("conversionClass"),
        });
      }
      const pendingSplit: EquityBook = {
        ...book,
        splits: [
          ...book.splits,
          {
            id: "pending",
            shareClassId: shareClass.id,
            effectiveOn,
            ratioNumerator: numerator,
            ratioDenominator: denominator,
          },
        ],
      };
      for (const row of preferred) {
        if (
          !row.conversionAdjustsForSplits ||
          conversionClassOf(book, row, effectiveOn) !== shareClass.id
        )
          continue;
        const activity = latestClassActivity(book, row.id);
        if (activity !== null && effectiveOn <= activity) {
          throw equityError(
            "splitBackdatedByConversion",
            {
              shareClass: fig.text(row.code),
              splitClass: fig.text(shareClass.code),
              date: fig.date(activity),
            },
            { field: "effectiveOn" },
          );
        }
        const beforePrice = conversionPrice(book, row, effectiveOn);
        const afterPrice = conversionPrice(pendingSplit, row, effectiveOn);
        adjusted.push({
          id: row.id,
          code: row.code,
          before: beforePrice ? formatPrice(beforePrice) : null,
          after: afterPrice ? formatPrice(afterPrice) : null,
        });
      }
    }
    const row = (
      await db.execute<{ id: string }>(
        sql`
      insert into equity_splits (org_id, subsidiary_id, share_class_id, effective_on, ratio_numerator, ratio_denominator, reason, created_by)
      values (${input.orgId}, ${subsidiaryId}, ${shareClass.id}, ${effectiveOn}::date, ${numerator.toString()}::bigint,
        ${denominator.toString()}::bigint, ${reason}, ${input.actorId})
      returning id`,
        "objects",
      )
    )[0];
    if (!row) throw equityError("notSaved", { record: fig.choice("split") });
    await writeEquityAudit(db, {
      orgId: input.orgId,
      table: "equity_splits",
      rowId: row.id,
      action: "equity.split.record",
      actorId: input.actorId,
      changes: {
        before: null,
        after: { shareClassId: shareClass.id, effectiveOn, ratio: `${numerator}:${denominator}` },
        adjustedConversionPrices: adjusted,
        reason,
      },
    });
    for (const entry of adjusted) {
      await writeEquityAudit(db, {
        orgId: input.orgId,
        table: "equity_share_classes",
        rowId: entry.id,
        action: "equity.class.split_adjustment",
        actorId: input.actorId,
        changes: {
          splitId: row.id,
          splitClassId: shareClass.id,
          effectiveOn,
          before: { conversionPrice: entry.before },
          after: { conversionPrice: entry.after },
          reason,
        },
      });
    }
    return {
      id: row.id,
      adjustedClasses: adjusted.map((entry) => ({
        shareClassId: entry.id,
        code: entry.code,
        conversionPriceBefore: entry.before,
        conversionPriceAfter: entry.after,
      })),
    };
  });
}

export interface CreatePlanInput extends EquityCommand {
  subsidiaryId: string;
  code: string;
  name: string;
  shareClassId: string;
  effectiveOn: string;
  reservedShares: string;
  recycleForfeited: boolean;
  recycleExpired: boolean;
  recycleRepurchased: boolean;
}

export async function createPlan(input: CreatePlanInput): Promise<{ id: string }> {
  const code = requireText(input.code, "code", "code", 40);
  const name = requireText(input.name, "name", "name", 200);
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "effectiveOn");
  const reserved = parseShares(input.reservedShares, "reservedShares");
  if (reserved <= 0n)
    throw equityError(
      "planReserveNotPositive",
      { field: fig.term("reservedShares") },
      { field: "reservedShares" },
    );
  return inEquityCommand(input, "equity.manage", async ({ book }) => {
    const shareClass = book.classes.find((row) => row.id === input.shareClassId);
    if (!shareClass) throw equityError("classUnknown", {}, { field: "shareClassId" });
    if (effectiveOn < shareClass.effectiveOn)
      throw equityError(
        "planBeforeClass",
        { date: fig.date(shareClass.effectiveOn) },
        { field: "effectiveOn" },
      );
    if (book.plans.some((row) => row.code.toLowerCase() === code.toLowerCase())) {
      throw equityError("planCodeTaken", { code: fig.text(code) }, { field: "code" });
    }
    const pending: EquityBook = {
      ...book,
      plans: [
        ...book.plans,
        {
          id: "pending",
          code,
          name,
          shareClassId: shareClass.id,
          effectiveOn,
          initialReservedShares: reserved,
          recycleForfeited: input.recycleForfeited,
          recycleExpired: input.recycleExpired,
          recycleRepurchased: input.recycleRepurchased,
        },
      ],
    };
    assertWithinAuthorized(
      pending,
      shareClass.id,
      effectiveOn,
      "plan",
      authorizedHeadroom(book, shareClass.id, effectiveOn),
    );
    const row = (
      await db.execute<{ id: string }>(
        sql`
      insert into equity_plans (org_id, subsidiary_id, code, name, share_class_id, effective_on, initial_reserved_shares,
        recycle_forfeited, recycle_expired, recycle_repurchased, created_by)
      values (${input.orgId}, ${input.subsidiaryId}, ${code}, ${name}, ${shareClass.id}, ${effectiveOn}::date, ${reserved.toString()}::bigint,
        ${input.recycleForfeited}, ${input.recycleExpired}, ${input.recycleRepurchased}, ${input.actorId})
      returning id`,
        "objects",
      )
    )[0];
    if (!row) throw equityError("notSaved", { record: fig.choice("plan") });
    await writeEquityAudit(db, {
      orgId: input.orgId,
      table: "equity_plans",
      rowId: row.id,
      action: "equity.plan.create",
      actorId: input.actorId,
      changes: {
        before: null,
        after: {
          code,
          name,
          shareClassId: shareClass.id,
          effectiveOn,
          reservedShares: reserved,
          recycleForfeited: input.recycleForfeited,
          recycleExpired: input.recycleExpired,
          recycleRepurchased: input.recycleRepurchased,
        },
      },
    });
    return { id: row.id };
  });
}

export interface ChangePlanReserveInput extends EquityCommand {
  planId: string;
  effectiveOn: string;
  shareDelta: string;
  reason: string;
}

/** Increase or reduce a plan's reserve from a date (a governed action). */
export async function changePlanReserve(input: ChangePlanReserveInput): Promise<GovernedRecord> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "effectiveOn");
  const reason = requireReason(input.reason, "reserveChange");
  if (!isUuid(input.planId)) throw equityError("planIdUnknown");
  const plan = await withOrgTransaction(
    input.orgId,
    async () =>
      (
        await db.execute<{ subsidiary_id: string; code: string }>(
          sql`
    select subsidiary_id, code from equity_plans where org_id = ${input.orgId} and id = ${input.planId}`,
          "objects",
        )
      )[0],
  );
  if (!plan) throw equityError("planIdUnknown");
  const outcome = await governEquityAction(
    {
      orgId: input.orgId,
      actorId: input.actorId,
      subsidiaryId: plan.subsidiary_id,
      action: "reserve_change",
      subjectId: input.planId,
      subjectLabel: `Plan ${plan.code}`,
      effectiveOn,
      reason,
      summary: {
        quantity: typeof input.shareDelta === "string" ? input.shareDelta.trim() : null,
        amount: null,
      },
      payload: payloadOf(input),
      idempotencyKey: null,
    },
    (actorId) => applyReserveChange({ ...input, actorId }),
  );
  return { id: outcome.result?.id ?? null, status: outcome.status, requestId: outcome.requestId };
}

/** Apply a plan reserve change: the command its approval releases. */
export async function applyReserveChange(input: ChangePlanReserveInput): Promise<{ id: string }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "effectiveOn");
  const reason = requireReason(input.reason, "reserveChange");
  const text = typeof input.shareDelta === "string" ? input.shareDelta.trim() : "";
  if (!/^-?\d+$/.test(text) || BigInt(text) === 0n) {
    throw equityError(
      "reserveChangeInvalid",
      { field: fig.term("shareDelta") },
      { field: "shareDelta" },
    );
  }
  const delta = BigInt(text);
  if (!isUuid(input.planId)) throw equityError("planIdUnknown");
  const plan = await withOrgTransaction(
    input.orgId,
    async () =>
      (
        await db.execute<{ subsidiary_id: string }>(
          sql`
    select subsidiary_id from equity_plans where org_id = ${input.orgId} and id = ${input.planId}`,
          "objects",
        )
      )[0],
  );
  if (!plan) throw equityError("planIdUnknown");
  return inEquityCommand(
    { ...input, subsidiaryId: plan.subsidiary_id },
    "equity.manage",
    async ({ book }) => {
      const record = book.plans.find((row) => row.id === input.planId)!;
      if (effectiveOn < record.effectiveOn)
        throw equityError(
          "reserveChangeBeforePlan",
          { plan: fig.text(record.code), date: fig.date(record.effectiveOn) },
          { field: "effectiveOn" },
        );
      const before = planPool(book, record, effectiveOn);
      const pending: EquityBook = {
        ...book,
        reserveChanges: [
          ...book.reserveChanges,
          { id: "pending", planId: record.id, effectiveOn, shareDelta: delta },
        ],
      };
      if (delta < 0n)
        assertPoolsCovered(pending, record.id, effectiveOn, {
          reduction: { maximum: poolHeadroom(book, record.id, effectiveOn) },
        });
      else
        assertWithinAuthorized(
          pending,
          record.shareClassId,
          effectiveOn,
          "reserve_increase",
          authorizedHeadroom(book, record.shareClassId, effectiveOn),
        );
      const row = (
        await db.execute<{ id: string }>(
          sql`
      insert into equity_plan_reserve_changes (org_id, subsidiary_id, plan_id, effective_on, share_delta, reason, created_by)
      values (${input.orgId}, ${plan.subsidiary_id}, ${record.id}, ${effectiveOn}::date, ${delta.toString()}::bigint, ${reason}, ${input.actorId})
      returning id`,
          "objects",
        )
      )[0];
      if (!row) throw equityError("notSaved", { record: fig.choice("reserveChange") });
      await writeEquityAudit(db, {
        orgId: input.orgId,
        table: "equity_plans",
        rowId: record.id,
        action: "equity.plan.reserve",
        actorId: input.actorId,
        changes: {
          changeId: row.id,
          effectiveOn,
          before: { reserved: before.reserved, available: before.available },
          after: { reserved: before.reserved + delta, available: before.available + delta },
          shareDelta: delta,
          reason,
        },
      });
      return { id: row.id };
    },
  );
}

export interface CreateRoundInput extends EquityCommand {
  subsidiaryId: string;
  name: string;
  shareClassId: string;
  closedOn: string;
  pricePerShare: string;
  preMoneyValuation: string;
  /** The currency the round is priced in (default: the legal entity's functional currency). */
  currency?: string | null;
  /**
   * Why the pre-money valuation is stated on another basis than the price
   * times the fully diluted shares before the round (a pool increase or
   * conversions counted in it, say). Required only when they disagree.
   */
  preMoneyBasisReason?: string | null;
}

/** A price rounded half up to `scale` places, as a decimal string. */
const pricePlaces = (value: Rational, scale: number): string =>
  formatUnits(quantize(value, scale, "half_up"), scale);

/** A four-place round price carries this much rounding per share. */
const PRE_MONEY_TOLERANCE = rational(1n, 20000n);

/**
 * A round's pre-money valuation measured against its price times the fully
 * diluted shares before it on its closing date: consistent within the
 * rounding of a four-place price. With no shares before the round there is
 * nothing to measure against, and the valuation reads as inconsistent so
 * its basis is recorded.
 */
export function preMoneyCheck(
  before: EquityBook,
  input: { closedOn: string; price: Rational; preMoney: Rational },
): { fullyDiluted: bigint; implied: Rational; consistent: boolean } {
  const fullyDiluted = BigInt(buildCapTable(before, input.closedOn).totals.fullyDiluted);
  const implied = multiplyRational(input.price, rational(fullyDiluted));
  if (fullyDiluted <= 0n) return { fullyDiluted, implied, consistent: false };
  const gap = subtractRational(divideRational(input.preMoney, rational(fullyDiluted)), input.price);
  const magnitude = gap.numerator < 0n ? rational(-gap.numerator, gap.denominator) : gap;
  return {
    fullyDiluted,
    implied,
    consistent: compareRational(magnitude, PRE_MONEY_TOLERANCE) <= 0,
  };
}

/**
 * A recorded round whose pre-money valuation no longer agrees with its
 * price times the fully diluted shares before it, as the book now reads
 * (activity recorded later and dated before the round changes that count),
 * and which records no basis for the difference. Null when it agrees.
 */
export function roundPreMoneyDrift(
  book: EquityBook,
  round: FinancingRoundRecord,
): { fullyDilutedBefore: string; impliedPreMoney: string } | null {
  if (round.preMoneyBasisReason) return null;
  const check = preMoneyCheck(bookBeforeRound(book, round.id), {
    closedOn: round.closedOn,
    price: parsePrice(round.pricePerShare, "roundPrice"),
    preMoney: parseDecimal(round.preMoneyValuation, "preMoneyValuation", 4),
  });
  return check.consistent
    ? null
    : {
        fullyDilutedBefore: check.fullyDiluted.toString(),
        impliedPreMoney: formatMoney(check.implied),
      };
}

/**
 * The price per share consistent with a pre-money valuation, offered only
 * where it could be recorded: four places where that is not zero, else the
 * full price precision, and never below the class's par value (shares cannot
 * be issued below par) or at zero.
 */
function consistentPrice(
  preMoney: Rational,
  fullyDiluted: bigint,
  parValue: Rational,
): string | null {
  const exact = divideRational(preMoney, rational(fullyDiluted));
  for (const scale of [4, PRICE_SCALE]) {
    const units = quantize(exact, scale, "half_up");
    if (units <= 0n) continue;
    const price = rational(units, 10n ** BigInt(scale));
    return compareRational(price, parValue) >= 0 ? pricePlaces(exact, scale) : null;
  }
  return null;
}

/**
 * A round's pre-money valuation must equal its price times the fully
 * diluted shares before the round, within the rounding of a four-place
 * price. A valuation stated on another basis is accepted with the basis
 * recorded; without one it refuses with the figures that would agree, and
 * proposes only changes the round can take: a price is not proposed while
 * live securities stand at the round's price, nor one below par or at zero.
 */
export function assertPreMoneyConsistent(
  before: EquityBook,
  input: {
    closedOn: string;
    price: Rational;
    preMoney: Rational;
    currency: string;
    basisReason: string | null;
    parValue: Rational;
    priceLocked: boolean;
  },
): void {
  const { fullyDiluted, implied, consistent } = preMoneyCheck(before, input);
  if (consistent || input.basisReason) return;
  const options = { field: "preMoneyValuation" };
  const field = fig.term("preMoneyBasisReason");
  const preMoney = fig.money(formatMoney(input.preMoney), input.currency);
  const price = fig.price(formatPrice(input.price), input.currency);
  if (fullyDiluted <= 0n)
    throw equityError("preMoneyUnmeasurable", { preMoney, price, field }, options);
  const figures = {
    preMoney,
    price,
    field,
    fullyDiluted: fig.shares(fullyDiluted),
    implied: fig.money(formatMoney(implied), input.currency),
  };
  const impliedPrice = input.priceLocked
    ? null
    : consistentPrice(input.preMoney, fullyDiluted, input.parValue);
  if (impliedPrice)
    throw equityError(
      "preMoneyInconsistent",
      { ...figures, impliedPrice: fig.price(impliedPrice, input.currency) },
      options,
    );
  if (input.priceLocked) throw equityError("preMoneyInconsistentPriceLocked", figures, options);
  throw equityError("preMoneyInconsistentValuationOnly", figures, options);
}

/** A share class's par value per share on a date, restated for its splits. */
export function parValueOn(book: EquityBook, shareClass: ShareClassRecord, on: string): Rational {
  return restatePrice(
    book.splits,
    shareClass.id,
    parsePrice(shareClass.parValue, "parValue"),
    shareClass.effectiveOn,
    on,
  );
}

/** An optional pre-money basis: blank is none; a written one holds a reason's length. */
export function optionalBasisReason(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  if (text.length < REASON_LENGTH.min || text.length > REASON_LENGTH.max) {
    throw equityError(
      "preMoneyBasisTooShort",
      {
        field: fig.term("preMoneyBasisReason"),
        min: fig.count(REASON_LENGTH.min),
        max: fig.count(REASON_LENGTH.max),
      },
      { field: "preMoneyBasisReason" },
    );
  }
  return text;
}

/** Every round name the legal entity has used, voided rounds and amended names included. */
export async function usedRoundNames(
  orgId: string,
  subsidiaryId: string,
): Promise<{ roundId: string; name: string }[]> {
  return (
    await db.execute<{ round_id: string; name: string }>(
      sql`
    select id as round_id, name from equity_financing_rounds where org_id = ${orgId} and subsidiary_id = ${subsidiaryId}
    union all
    select round_id, name from equity_round_amendments where org_id = ${orgId} and subsidiary_id = ${subsidiaryId} and name is not null`,
      "objects",
    )
  ).map((row) => ({ roundId: row.round_id, name: row.name }));
}

/** Record a closed financing round; its shares are then issued against it. */
export async function createRound(input: CreateRoundInput): Promise<{ id: string }> {
  const name = requireText(input.name, "name", "name", 200);
  const closedOn = requireDate(input.closedOn, "closedOn", "closedOn");
  const price = parsePrice(input.pricePerShare, "pricePerShare");
  const pre = parseDecimal(input.preMoneyValuation, "preMoneyValuation", 4);
  const basisReason = optionalBasisReason(input.preMoneyBasisReason);
  if (price.numerator <= 0n)
    throw equityError(
      "roundPricePerShareNotPositive",
      { field: fig.term("pricePerShare") },
      { field: "pricePerShare" },
    );
  if (compareRational(pre, rational(0n)) <= 0)
    throw equityError(
      "roundPreMoneyValuationNotPositive",
      { field: fig.term("preMoneyValuation") },
      { field: "preMoneyValuation" },
    );
  return inEquityCommand(input, "equity.manage", async ({ book, currency: functional }) => {
    const requested =
      typeof input.currency === "string" && input.currency.trim() !== ""
        ? input.currency.trim().toUpperCase()
        : null;
    if (requested && !/^[A-Z]{3}$/.test(requested))
      throw equityError("currencyCodeInvalid", {}, { field: "currency" });
    const currency = requested ?? functional;
    await currencyExponent(db, currency);
    if (currency !== functional)
      await spotRate(db, input.orgId, currency, functional, closedOn, functional);
    const shareClass = book.classes.find((row) => row.id === input.shareClassId);
    if (!shareClass) throw equityError("classUnknown", {}, { field: "shareClassId" });
    if (closedOn < shareClass.effectiveOn)
      throw equityError(
        "roundBeforeClass",
        { date: fig.date(shareClass.effectiveOn) },
        { field: "closedOn" },
      );
    if (
      (await usedRoundNames(input.orgId, input.subsidiaryId)).some(
        (row) => row.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw equityError("roundNameTaken", { name: fig.text(name) }, { field: "name" });
    }
    assertPreMoneyConsistent(book, {
      closedOn,
      price,
      preMoney: pre,
      currency,
      basisReason,
      parValue: parValueOn(book, shareClass, closedOn),
      priceLocked: false,
    });
    const row = (
      await db.execute<{ id: string }>(
        sql`
      insert into equity_financing_rounds (org_id, subsidiary_id, name, share_class_id, closed_on, price_per_share, pre_money_valuation, currency, pre_money_basis_reason, created_by)
      values (${input.orgId}, ${input.subsidiaryId}, ${name}, ${shareClass.id}, ${closedOn}::date, ${input.pricePerShare.trim()}::numeric,
        ${input.preMoneyValuation.trim()}::numeric, ${currency}, ${basisReason}, ${input.actorId})
      returning id`,
        "objects",
      )
    )[0];
    if (!row) throw equityError("notSaved", { record: fig.choice("round") });
    await writeEquityAudit(db, {
      orgId: input.orgId,
      table: "equity_financing_rounds",
      rowId: row.id,
      action: "equity.round.create",
      actorId: input.actorId,
      changes: {
        before: null,
        after: {
          name,
          shareClassId: shareClass.id,
          closedOn,
          pricePerShare: input.pricePerShare,
          preMoneyValuation: input.preMoneyValuation,
          currency,
          preMoneyBasisReason: basisReason,
        },
      },
    });
    return { id: row.id };
  });
}
