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
import { authorizedShares, buildCapTable, classCommitted, conversionClassOf, conversionPrice, planPool } from "./cap-table.ts";
import { EquityError } from "./errors.ts";
import { spotRate } from "./fx.ts";
import { governEquityAction, type GovernedStatus } from "./governance.ts";
import {
  assertEquityFeature,
  currencyExponent,
  loadLegalEntity,
  lockEquityEntity,
  requireEquityAuthority,
  requireReason,
  writeEquityAudit,
  type EquityPermission,
} from "./internal.ts";
import { compareRational, divideRational, formatMoney, formatPrice, multiplyRational, parseDecimal, parsePrice, parseShares, PERCENT_SCALE, formatUnits, quantize, rational, subtractRational, type Rational } from "./quantities.ts";
import { validateSplitRatio } from "./splits.ts";
import { syncPositionLedger } from "./positions.ts";
import { loadEquityBook } from "./store.ts";
import { LIQUIDATION_PREFERENCE_BASES, type AntiDilution, type EquityBook, type LiquidationPreferenceBasis, type Participation, type ShareClassKind } from "./types.ts";

export interface EquityCommand {
  orgId: string;
  actorId: string;
}

export function requireDate(value: unknown, field: string, label: string): string {
  if (typeof value !== "string" || !isIsoCalendarDate(value)) {
    throw new EquityError(`${label} must be a valid YYYY-MM-DD date.`, { code: "equity_date_invalid", remedy: `Enter ${label} as YYYY-MM-DD.`, field });
  }
  return value;
}

function requireText(value: unknown, field: string, label: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 1 || text.length > max) {
    throw new EquityError(`${label} is required (at most ${max} characters).`, { code: "equity_text_invalid", remedy: `Enter ${label}.`, field });
  }
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
  for (const security of book.securities) if (security.shareClassId === shareClassId && security.issueDate >= from) dates.add(security.issueDate);
  for (const event of book.events) if (event.effectiveOn >= from) dates.add(event.effectiveOn);
  for (const change of book.reserveChanges) if (change.effectiveOn >= from) dates.add(change.effectiveOn);
  for (const plan of book.plans) if (plan.shareClassId === shareClassId && plan.effectiveOn >= from) dates.add(plan.effectiveOn);
  for (const amendment of book.amendments) if (amendment.shareClassId === shareClassId && amendment.effectiveOn >= from) dates.add(amendment.effectiveOn);
  for (const split of book.splits) if (split.shareClassId === shareClassId && split.effectiveOn >= from) dates.add(split.effectiveOn);
  return [...dates].sort();
}

/** What a commitment check guards, so its refusal names the remedy that fits the action. */
export type CommitmentPurpose = "issue" | "authorized_amendment" | "reserve_increase" | "plan" | "reversal";

/**
 * Refuse when the class's outstanding shares, outstanding awards and
 * unallocated pools would exceed its authorized shares on any date from
 * `from` onward.
 */
export function assertWithinAuthorized(book: EquityBook, shareClassId: string, from: string, purpose: CommitmentPurpose = "issue", room: bigint = 0n): void {
  const shareClass = book.classes.find((row) => row.id === shareClassId);
  if (!shareClass) throw new EquityError("The share class does not exist for this legal entity.", { status: 404, code: "equity_class_unknown", remedy: "Choose a share class of the legal entity.", field: "shareClassId" });
  for (const date of classCheckDates(book, shareClassId, from)) {
    if (date < shareClass.effectiveOn) continue;
    const committed = classCommitted(book, shareClassId, date);
    const authorized = authorizedShares(book, shareClass, date);
    if (committed > authorized) {
      const remedy = {
        issue: `Record an authorized-share amendment raising class ${shareClass.code} to at least {committed} shares, or issue {excess} fewer shares.`,
        authorized_amendment: `Authorize at least {committed} shares of class ${shareClass.code}: its outstanding shares, outstanding awards and unallocated plan pools need them on ${date}.`,
        reserve_increase: `Add no more than {room} shares to the reserve, or first record an authorized-share amendment raising class ${shareClass.code} to at least {committed} shares.`,
        plan: `Reserve no more than {room} shares, or first record an authorized-share amendment raising class ${shareClass.code} to at least {committed} shares.`,
        reversal: `Record an authorized-share amendment raising class ${shareClass.code} to at least {committed} shares before reversing the event.`,
      }[purpose];
      const excess = committed - authorized;
      throw new EquityError(`Class ${shareClass.code} would commit {committed} shares on ${date} but authorizes {authorized}.`, {
        status: 409,
        code: "equity_authorized_exceeded",
        remedy,
        field: purpose === "authorized_amendment" ? "authorizedShares" : undefined,
        values: {
          committed: { kind: "shares", value: committed },
          authorized: { kind: "shares", value: authorized },
          excess: { kind: "shares", value: excess },
          room: { kind: "shares", value: room },
        },
      });
    }
  }
}

/** Refuse when a plan's unallocated pool would fall below zero on any date from `from` onward. */
export function assertPoolsCovered(book: EquityBook, planId: string, from: string, options: { reduction?: { maximum: bigint } } = {}): void {
  const plan = book.plans.find((row) => row.id === planId);
  if (!plan) throw new EquityError("The plan does not exist for this legal entity.", { status: 404, code: "equity_plan_unknown", remedy: "Choose a plan of the legal entity.", field: "planId" });
  for (const date of classCheckDates(book, plan.shareClassId, from)) {
    if (date < plan.effectiveOn) continue;
    const pool = planPool(book, plan, date);
    if (pool.available < 0n) {
      const reduction = options.reduction;
      throw new EquityError(`Plan ${plan.code} would have {available} shares available on ${date}.`, {
        status: 409,
        code: "equity_pool_exhausted",
        remedy: reduction
          ? reduction.maximum > 0n
            ? `Remove no more than {maximum} shares from plan ${plan.code}'s reserve from ${from}; the rest is granted to awards.`
            : `Plan ${plan.code} has no unallocated shares to remove on or after ${from}; forfeit or cancel awards first.`
          : `Grant {shortfall} fewer units, or first increase plan ${plan.code}'s reserve.`,
        field: reduction ? "shareDelta" : undefined,
        values: {
          available: { kind: "shares", value: pool.available },
          maximum: { kind: "shares", value: reduction?.maximum ?? 0n },
          shortfall: { kind: "shares", value: -pool.available },
        },
      });
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
    const room = authorizedShares(book, shareClass, date) - classCommitted(book, shareClassId, date);
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
  const own = new Set(book.securities.filter((row) => row.shareClassId === shareClassId).map((row) => row.id));
  const plans = new Set(book.plans.filter((row) => row.shareClassId === shareClassId).map((row) => row.id));
  const shareClass = book.classes.find((row) => row.id === shareClassId);
  const dates: string[] = shareClass ? [shareClass.effectiveOn] : [];
  for (const security of book.securities) if (own.has(security.id)) dates.push(security.issueDate);
  for (const event of book.events) if (own.has(event.securityId)) dates.push(event.effectiveOn);
  for (const plan of book.plans) if (plans.has(plan.id)) dates.push(plan.effectiveOn);
  for (const change of book.reserveChanges) if (plans.has(change.planId)) dates.push(change.effectiveOn);
  for (const amendment of book.amendments) if (amendment.shareClassId === shareClassId) dates.push(amendment.effectiveOn);
  for (const split of book.splits) if (split.shareClassId === shareClassId) dates.push(split.effectiveOn);
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
  const code = requireText(input.code, "code", "The class code", 40);
  const name = requireText(input.name, "name", "The class name", 200);
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The effective date");
  const authorized = parseShares(input.authorizedShares, "the authorized shares");
  if (authorized <= 0n) throw new EquityError("Authorize at least one share.", { code: "equity_shares_invalid", remedy: "Enter the authorized shares.", field: "authorizedShares" });
  const par = parsePrice(input.parValue, "the par value");
  if (par.numerator < 0n) throw new EquityError("The par value cannot be negative.", { code: "equity_decimal_invalid", remedy: "Enter the par value per share (zero for no-par stock).", field: "parValue" });
  const kind = input.kind;
  if (kind !== "common" && kind !== "preferred") throw new EquityError("Choose common or preferred.", { code: "equity_class_kind_invalid", remedy: "Choose the class kind.", field: "kind" });
  const participation: Participation = kind === "preferred" ? input.participation ?? "none" : "none";
  const antiDilution: AntiDilution = kind === "preferred" ? input.antiDilution ?? "none" : "none";
  const seniority = input.seniority ?? 0;
  if (!Number.isInteger(seniority) || seniority < 0 || seniority > 1000) throw new EquityError("Seniority must be a whole number from 0 to 1000.", { code: "equity_class_terms_invalid", remedy: "Enter the class's seniority (higher is paid first).", field: "seniority" });
  let originalIssuePrice: string | null = null;
  let conversionPrice: string | null = null;
  let multiple: string | null = null;
  let cap: string | null = null;
  if (kind === "preferred") {
    const issue = parsePrice(input.originalIssuePrice ?? "", "the original issue price");
    const conversion = input.conversionPrice ? parsePrice(input.conversionPrice, "the conversion price") : issue;
    const liquidation = parseDecimal(input.liquidationMultiple ?? "1", "the liquidation multiple", PERCENT_SCALE);
    if (issue.numerator <= 0n || conversion.numerator <= 0n) throw new EquityError("Preferred stock needs a positive original issue price and conversion price.", { code: "equity_class_terms_invalid", remedy: "Enter the price the class was sold at.", field: "originalIssuePrice" });
    if (liquidation.numerator < 0n) throw new EquityError("The liquidation multiple cannot be negative.", { code: "equity_class_terms_invalid", remedy: "Enter the liquidation multiple, such as 1.", field: "liquidationMultiple" });
    originalIssuePrice = input.originalIssuePrice!.trim();
    conversionPrice = (input.conversionPrice ?? input.originalIssuePrice)!.trim();
    multiple = (input.liquidationMultiple ?? "1").trim();
    if (participation === "capped") {
      const capMultiple = parseDecimal(input.participationCapMultiple ?? "", "the participation cap", PERCENT_SCALE);
      if (compareRational(capMultiple, liquidation) <= 0) throw new EquityError("The participation cap must exceed the liquidation multiple.", { code: "equity_class_terms_invalid", remedy: "Enter a cap multiple above the liquidation multiple, such as 3.", field: "participationCapMultiple" });
      cap = input.participationCapMultiple!.trim();
    }
  }
  const adjustsForSplits = kind === "preferred" ? input.conversionAdjustsForSplits !== false : true;
  const preferenceBasis: LiquidationPreferenceBasis = input.liquidationPreferenceBasis ?? "amount_paid";
  if (!LIQUIDATION_PREFERENCE_BASES.includes(preferenceBasis)) {
    throw new EquityError("Choose what the liquidation preference is measured on.", { code: "equity_class_terms_invalid", remedy: "Choose the amount paid for each certificate or the class's original issue price.", field: "liquidationPreferenceBasis" });
  }
  return inEquityCommand(input, "equity.manage", async ({ book }) => {
    if (book.classes.some((row) => row.code.toLowerCase() === code.toLowerCase())) {
      throw new EquityError(`Class code ${code} is already used by this legal entity.`, { status: 409, code: "equity_class_code_taken", remedy: "Choose a different class code.", field: "code" });
    }
    let conversionClassId: string | null = null;
    if (kind === "preferred") {
      const target = book.classes.find((row) => row.id === input.conversionShareClassId);
      if (!target || target.kind !== "common") {
        throw new EquityError("Choose the common class the preferred shares convert into.", { code: "equity_class_terms_invalid", remedy: "Choose a common class of the legal entity (record it first if needed).", field: "conversionShareClassId" });
      }
      if (target.effectiveOn > effectiveOn) {
        throw new EquityError(`Class ${target.code} is not effective until ${target.effectiveOn}.`, { code: "equity_date_invalid", remedy: `Date the class on or after ${target.effectiveOn}, or choose another conversion class.`, field: "conversionShareClassId" });
      }
      conversionClassId = target.id;
    } else if (input.conversionShareClassId) {
      throw new EquityError("Only a preferred class converts into another class.", { code: "equity_class_terms_invalid", remedy: "Clear the conversion class.", field: "conversionShareClassId" });
    }
    const row = (await db.execute<{ id: string }>(sql`
      insert into equity_share_classes (org_id, subsidiary_id, code, name, kind, effective_on, initial_authorized_shares, par_value,
        original_issue_price, initial_conversion_price, liquidation_multiple, liquidation_preference_basis, participation, participation_cap_multiple, seniority,
        anti_dilution, conversion_share_class_id, conversion_adjusts_for_splits, created_by)
      values (${input.orgId}, ${input.subsidiaryId}, ${code}, ${name}, ${kind}, ${effectiveOn}::date, ${authorized.toString()}::bigint,
        ${input.parValue.trim()}::numeric, ${originalIssuePrice}::numeric, ${conversionPrice}::numeric, ${multiple}::numeric, ${preferenceBasis},
        ${participation}, ${cap}::numeric, ${seniority}, ${antiDilution}, ${conversionClassId}, ${adjustsForSplits}, ${input.actorId})
      returning id`)).rows[0];
    if (!row) throw new EquityError("The share class was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_share_classes", rowId: row.id, action: "equity.class.create", actorId: input.actorId,
      changes: { before: null, after: { code, name, kind, effectiveOn, authorizedShares: authorized, parValue: input.parValue, originalIssuePrice, conversionPrice, liquidationMultiple: multiple, liquidationPreferenceBasis: kind === "preferred" ? preferenceBasis : null, participation, participationCapMultiple: cap, seniority, antiDilution, conversionShareClassId: conversionClassId, conversionAdjustsForSplits: adjustsForSplits } },
    });
    return { id: row.id };
  });
}

/** Load a share class with its legal entity; unknown classes refuse with a 404. */
async function classEntity(orgId: string, shareClassId: string): Promise<string> {
  return (await classOwner(orgId, shareClassId)).subsidiaryId;
}

async function classOwner(orgId: string, shareClassId: string): Promise<{ subsidiaryId: string; code: string }> {
  if (!isUuid(shareClassId)) throw new EquityError("The share class does not exist.", { status: 404, code: "equity_class_unknown", remedy: "Choose a share class." });
  const row = (await withOrgTransaction(orgId, async () => (await db.execute<{ subsidiary_id: string; code: string }>(sql`
    select subsidiary_id, code from equity_share_classes where org_id = ${orgId} and id = ${shareClassId}`)).rows[0]));
  if (!row) throw new EquityError("The share class does not exist.", { status: 404, code: "equity_class_unknown", remedy: "Choose a share class." });
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
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The effective date");
  const reason = requireReason(input.reason, "the class amendment");
  const owner = await classOwner(input.orgId, input.shareClassId);
  const outcome = await governEquityAction({
    orgId: input.orgId, actorId: input.actorId, subsidiaryId: owner.subsidiaryId, action: "class_amendment",
    subjectId: input.shareClassId, subjectLabel: `Class ${owner.code}`, effectiveOn, reason,
    summary: { shareClassCode: owner.code, quantity: input.authorizedShares ?? null, amount: input.conversionPrice ?? null },
    payload: payloadOf(input), idempotencyKey: null,
  }, (actorId) => applyShareClassAmendment({ ...input, actorId }));
  return { id: outcome.result?.id ?? null, status: outcome.status, requestId: outcome.requestId };
}

/** Apply a class amendment: the command its approval releases. */
export async function applyShareClassAmendment(input: AmendShareClassInput): Promise<{ id: string }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The effective date");
  const reason = requireReason(input.reason, "the class amendment");
  const subsidiaryId = await classEntity(input.orgId, input.shareClassId);
  return inEquityCommand({ ...input, subsidiaryId }, "equity.manage", async ({ book }) => {
    const shareClass = book.classes.find((row) => row.id === input.shareClassId)!;
    if (effectiveOn < shareClass.effectiveOn) {
      throw new EquityError("An amendment cannot precede the class's effective date.", { code: "equity_date_invalid", remedy: `Date the amendment on or after ${shareClass.effectiveOn}.`, field: "effectiveOn" });
    }
    let authorized: bigint | null = null;
    let conversion: string | null = null;
    let conversionClassId: string | null = null;
    let before: Record<string, unknown>;
    if (input.kind === "authorized_shares") {
      authorized = parseShares(input.authorizedShares ?? "", "the authorized shares");
      if (authorized <= 0n) throw new EquityError("Authorize at least one share.", { code: "equity_shares_invalid", remedy: "Enter the authorized shares.", field: "authorizedShares" });
      before = { authorizedShares: authorizedShares(book, shareClass, effectiveOn) };
    } else if (input.kind === "conversion_price") {
      if (shareClass.kind !== "preferred") throw new EquityError("Only a preferred class has a conversion price.", { code: "equity_class_terms_invalid", remedy: "Amend the authorized shares instead.", field: "kind" });
      const price = parsePrice(input.conversionPrice ?? "", "the conversion price");
      if (price.numerator <= 0n) throw new EquityError("The conversion price must be greater than zero.", { code: "equity_class_terms_invalid", remedy: "Enter the new conversion price.", field: "conversionPrice" });
      conversion = input.conversionPrice!.trim();
      const current = conversionPrice(book, shareClass, effectiveOn);
      before = { conversionPrice: current ? formatPrice(current) : null };
    } else if (input.kind === "conversion_class") {
      if (shareClass.kind !== "preferred") throw new EquityError("Only a preferred class converts into another class.", { code: "equity_class_terms_invalid", remedy: "Amend the authorized shares instead.", field: "kind" });
      const target = book.classes.find((row) => row.id === input.conversionShareClassId);
      if (!target || target.kind !== "common") throw new EquityError("Choose the common class the preferred shares convert into.", { code: "equity_class_terms_invalid", remedy: "Choose a common class of the legal entity.", field: "conversionShareClassId" });
      if (target.effectiveOn > effectiveOn) throw new EquityError(`Class ${target.code} is not effective until ${target.effectiveOn}.`, { code: "equity_date_invalid", remedy: `Date the amendment on or after ${target.effectiveOn}.`, field: "effectiveOn" });
      const current = conversionClassOf(book, shareClass, effectiveOn);
      if (current === target.id) throw new EquityError(`Class ${shareClass.code} already converts into ${target.code}.`, { status: 409, code: "equity_amendment_unchanged", remedy: "Choose a different conversion class.", field: "conversionShareClassId" });
      const laterSplit = book.splits.find((split) => split.effectiveOn >= effectiveOn && (split.shareClassId === target.id || split.shareClassId === current));
      if (laterSplit) {
        throw new EquityError(`A split of the conversion class is recorded on ${laterSplit.effectiveOn}; changing the conversion class before it would reinterpret it.`, { status: 409, code: "equity_amendment_backdated", remedy: `Date the amendment after ${laterSplit.effectiveOn}.`, field: "effectiveOn" });
      }
      conversionClassId = target.id;
      before = { conversionShareClassId: current };
    } else {
      throw new EquityError("Choose what the amendment changes.", { code: "equity_amendment_invalid", remedy: "Amend the authorized shares, the conversion price or the conversion class.", field: "kind" });
    }
    const amended: EquityBook = {
      ...book,
      amendments: [...book.amendments, { id: "pending", shareClassId: shareClass.id, kind: input.kind, effectiveOn, authorizedShares: authorized, conversionPrice: conversion, conversionShareClassId: conversionClassId, reason }],
    };
    if (input.kind === "authorized_shares") assertWithinAuthorized(amended, shareClass.id, effectiveOn, "authorized_amendment");
    const row = (await db.execute<{ id: string }>(sql`
      insert into equity_class_amendments (org_id, subsidiary_id, share_class_id, kind, effective_on, authorized_shares, conversion_price,
        conversion_share_class_id, reason, created_by)
      values (${input.orgId}, ${subsidiaryId}, ${shareClass.id}, ${input.kind}, ${effectiveOn}::date, ${authorized?.toString() ?? null}::bigint,
        ${conversion}::numeric, ${conversionClassId}, ${reason}, ${input.actorId})
      returning id`)).rows[0];
    if (!row) throw new EquityError("The amendment was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
    const after = input.kind === "authorized_shares" ? { authorizedShares: authorized } : input.kind === "conversion_price" ? { conversionPrice: conversion } : { conversionShareClassId: conversionClassId };
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_share_classes", rowId: shareClass.id, action: "equity.class.amend", actorId: input.actorId,
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
  adjustedClasses: { shareClassId: string; code: string; conversionPriceBefore: string | null; conversionPriceAfter: string | null }[];
}

export async function recordSplit(input: RecordSplitInput): Promise<Omit<SplitResult, "id"> & GovernedRecord> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The effective date");
  const reason = requireReason(input.reason, "the split");
  const owner = await classOwner(input.orgId, input.shareClassId);
  const outcome = await governEquityAction({
    orgId: input.orgId, actorId: input.actorId, subsidiaryId: owner.subsidiaryId, action: "split",
    subjectId: input.shareClassId, subjectLabel: `Class ${owner.code} ${input.ratioNumerator}:${input.ratioDenominator}`, effectiveOn, reason,
    summary: { shareClassCode: owner.code, quantity: null, amount: null },
    payload: payloadOf(input), idempotencyKey: null,
  }, (actorId) => applySplit({ ...input, actorId }));
  return { id: outcome.result?.id ?? null, adjustedClasses: outcome.result?.adjustedClasses ?? [], status: outcome.status, requestId: outcome.requestId };
}

/** Apply a stock split: the command its approval releases. */
export async function applySplit(input: RecordSplitInput): Promise<SplitResult> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The effective date");
  const reason = requireReason(input.reason, "the split");
  const numerator = parseShares(input.ratioNumerator, "the new share count");
  const denominator = parseShares(input.ratioDenominator, "the old share count");
  validateSplitRatio(numerator, denominator);
  const subsidiaryId = await classEntity(input.orgId, input.shareClassId);
  return inEquityCommand({ ...input, subsidiaryId }, "equity.manage", async ({ book }) => {
    const shareClass = book.classes.find((row) => row.id === input.shareClassId)!;
    const latest = latestClassActivity(book, shareClass.id);
    if (latest !== null && effectiveOn <= latest) {
      throw new EquityError(`Class ${shareClass.code} has activity recorded through ${latest}; a split must be dated after it.`, {
        status: 409,
        code: "equity_split_backdated",
        remedy: `Date the split after ${latest}.`,
        field: "effectiveOn",
      });
    }
    // A common split adjusts the conversion price of every preferred class converting into it under adjusting terms.
    const adjusted: { id: string; code: string; before: string | null; after: string | null }[] = [];
    if (shareClass.kind === "common") {
      const preferred = book.classes.filter((row) => row.kind === "preferred" && row.effectiveOn <= effectiveOn);
      const unnamed = preferred.filter((row) => conversionClassOf(book, row, effectiveOn) === null);
      if (unnamed.length > 0) {
        throw new EquityError(`Preferred ${unnamed.map((row) => row.code).join(", ")} ${unnamed.length === 1 ? "does" : "do"} not name the common class ${unnamed.length === 1 ? "it converts" : "they convert"} into, so the split's effect on ${unnamed.length === 1 ? "its" : "their"} conversion price is unknown.`, {
          status: 409,
          code: "equity_conversion_class_missing",
          remedy: "Record each preferred class's conversion class (Cap table → Amend → Conversion class), then record the split.",
        });
      }
      const pendingSplit: EquityBook = { ...book, splits: [...book.splits, { id: "pending", shareClassId: shareClass.id, effectiveOn, ratioNumerator: numerator, ratioDenominator: denominator }] };
      for (const row of preferred) {
        if (!row.conversionAdjustsForSplits || conversionClassOf(book, row, effectiveOn) !== shareClass.id) continue;
        const activity = latestClassActivity(book, row.id);
        if (activity !== null && effectiveOn <= activity) {
          throw new EquityError(`Class ${row.code} converts into ${shareClass.code} and has activity recorded through ${activity}; the split adjusts its conversion price, so it must be dated after that.`, {
            status: 409,
            code: "equity_split_backdated",
            remedy: `Date the split after ${activity}.`,
            field: "effectiveOn",
          });
        }
        const beforePrice = conversionPrice(book, row, effectiveOn);
        const afterPrice = conversionPrice(pendingSplit, row, effectiveOn);
        adjusted.push({ id: row.id, code: row.code, before: beforePrice ? formatPrice(beforePrice) : null, after: afterPrice ? formatPrice(afterPrice) : null });
      }
    }
    const row = (await db.execute<{ id: string }>(sql`
      insert into equity_splits (org_id, subsidiary_id, share_class_id, effective_on, ratio_numerator, ratio_denominator, reason, created_by)
      values (${input.orgId}, ${subsidiaryId}, ${shareClass.id}, ${effectiveOn}::date, ${numerator.toString()}::bigint,
        ${denominator.toString()}::bigint, ${reason}, ${input.actorId})
      returning id`)).rows[0];
    if (!row) throw new EquityError("The split was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_splits", rowId: row.id, action: "equity.split.record", actorId: input.actorId,
      changes: { before: null, after: { shareClassId: shareClass.id, effectiveOn, ratio: `${numerator}:${denominator}` }, adjustedConversionPrices: adjusted, reason },
    });
    for (const entry of adjusted) {
      await writeEquityAudit(db, {
        orgId: input.orgId, table: "equity_share_classes", rowId: entry.id, action: "equity.class.split_adjustment", actorId: input.actorId,
        changes: { splitId: row.id, splitClassId: shareClass.id, effectiveOn, before: { conversionPrice: entry.before }, after: { conversionPrice: entry.after }, reason },
      });
    }
    return { id: row.id, adjustedClasses: adjusted.map((entry) => ({ shareClassId: entry.id, code: entry.code, conversionPriceBefore: entry.before, conversionPriceAfter: entry.after })) };
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
  const code = requireText(input.code, "code", "The plan code", 40);
  const name = requireText(input.name, "name", "The plan name", 200);
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The effective date");
  const reserved = parseShares(input.reservedShares, "the reserved shares");
  if (reserved <= 0n) throw new EquityError("Reserve at least one share.", { code: "equity_shares_invalid", remedy: "Enter the shares reserved for the plan.", field: "reservedShares" });
  return inEquityCommand(input, "equity.manage", async ({ book }) => {
    const shareClass = book.classes.find((row) => row.id === input.shareClassId);
    if (!shareClass) throw new EquityError("The share class does not exist for this legal entity.", { status: 404, code: "equity_class_unknown", remedy: "Choose a share class of the legal entity.", field: "shareClassId" });
    if (effectiveOn < shareClass.effectiveOn) throw new EquityError("A plan cannot precede its share class.", { code: "equity_date_invalid", remedy: `Date the plan on or after ${shareClass.effectiveOn}.`, field: "effectiveOn" });
    if (book.plans.some((row) => row.code.toLowerCase() === code.toLowerCase())) {
      throw new EquityError(`Plan code ${code} is already used by this legal entity.`, { status: 409, code: "equity_plan_code_taken", remedy: "Choose a different plan code.", field: "code" });
    }
    const pending: EquityBook = {
      ...book,
      plans: [...book.plans, { id: "pending", code, name, shareClassId: shareClass.id, effectiveOn, initialReservedShares: reserved, recycleForfeited: input.recycleForfeited, recycleExpired: input.recycleExpired, recycleRepurchased: input.recycleRepurchased }],
    };
    assertWithinAuthorized(pending, shareClass.id, effectiveOn, "plan", authorizedHeadroom(book, shareClass.id, effectiveOn));
    const row = (await db.execute<{ id: string }>(sql`
      insert into equity_plans (org_id, subsidiary_id, code, name, share_class_id, effective_on, initial_reserved_shares,
        recycle_forfeited, recycle_expired, recycle_repurchased, created_by)
      values (${input.orgId}, ${input.subsidiaryId}, ${code}, ${name}, ${shareClass.id}, ${effectiveOn}::date, ${reserved.toString()}::bigint,
        ${input.recycleForfeited}, ${input.recycleExpired}, ${input.recycleRepurchased}, ${input.actorId})
      returning id`)).rows[0];
    if (!row) throw new EquityError("The plan was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_plans", rowId: row.id, action: "equity.plan.create", actorId: input.actorId,
      changes: { before: null, after: { code, name, shareClassId: shareClass.id, effectiveOn, reservedShares: reserved, recycleForfeited: input.recycleForfeited, recycleExpired: input.recycleExpired, recycleRepurchased: input.recycleRepurchased } },
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
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The effective date");
  const reason = requireReason(input.reason, "the reserve change");
  if (!isUuid(input.planId)) throw new EquityError("The plan does not exist.", { status: 404, code: "equity_plan_unknown", remedy: "Choose a plan." });
  const plan = await withOrgTransaction(input.orgId, async () => (await db.execute<{ subsidiary_id: string; code: string }>(sql`
    select subsidiary_id, code from equity_plans where org_id = ${input.orgId} and id = ${input.planId}`)).rows[0]);
  if (!plan) throw new EquityError("The plan does not exist.", { status: 404, code: "equity_plan_unknown", remedy: "Choose a plan." });
  const outcome = await governEquityAction({
    orgId: input.orgId, actorId: input.actorId, subsidiaryId: plan.subsidiary_id, action: "reserve_change",
    subjectId: input.planId, subjectLabel: `Plan ${plan.code}`, effectiveOn, reason,
    summary: { quantity: typeof input.shareDelta === "string" ? input.shareDelta.trim() : null, amount: null },
    payload: payloadOf(input), idempotencyKey: null,
  }, (actorId) => applyReserveChange({ ...input, actorId }));
  return { id: outcome.result?.id ?? null, status: outcome.status, requestId: outcome.requestId };
}

/** Apply a plan reserve change: the command its approval releases. */
export async function applyReserveChange(input: ChangePlanReserveInput): Promise<{ id: string }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The effective date");
  const reason = requireReason(input.reason, "the reserve change");
  const text = typeof input.shareDelta === "string" ? input.shareDelta.trim() : "";
  if (!/^-?\d+$/.test(text) || BigInt(text) === 0n) {
    throw new EquityError("The reserve change must be a nonzero whole number of shares.", { code: "equity_shares_invalid", remedy: "Enter the shares to add (or a negative number to remove).", field: "shareDelta" });
  }
  const delta = BigInt(text);
  if (!isUuid(input.planId)) throw new EquityError("The plan does not exist.", { status: 404, code: "equity_plan_unknown", remedy: "Choose a plan." });
  const plan = await withOrgTransaction(input.orgId, async () => (await db.execute<{ subsidiary_id: string }>(sql`
    select subsidiary_id from equity_plans where org_id = ${input.orgId} and id = ${input.planId}`)).rows[0]);
  if (!plan) throw new EquityError("The plan does not exist.", { status: 404, code: "equity_plan_unknown", remedy: "Choose a plan." });
  return inEquityCommand({ ...input, subsidiaryId: plan.subsidiary_id }, "equity.manage", async ({ book }) => {
    const record = book.plans.find((row) => row.id === input.planId)!;
    if (effectiveOn < record.effectiveOn) throw new EquityError("A reserve change cannot precede the plan.", { code: "equity_date_invalid", remedy: `Date the change on or after ${record.effectiveOn}.`, field: "effectiveOn" });
    const before = planPool(book, record, effectiveOn);
    const pending: EquityBook = { ...book, reserveChanges: [...book.reserveChanges, { id: "pending", planId: record.id, effectiveOn, shareDelta: delta }] };
    if (delta < 0n) assertPoolsCovered(pending, record.id, effectiveOn, { reduction: { maximum: poolHeadroom(book, record.id, effectiveOn) } });
    else assertWithinAuthorized(pending, record.shareClassId, effectiveOn, "reserve_increase", authorizedHeadroom(book, record.shareClassId, effectiveOn));
    const row = (await db.execute<{ id: string }>(sql`
      insert into equity_plan_reserve_changes (org_id, subsidiary_id, plan_id, effective_on, share_delta, reason, created_by)
      values (${input.orgId}, ${plan.subsidiary_id}, ${record.id}, ${effectiveOn}::date, ${delta.toString()}::bigint, ${reason}, ${input.actorId})
      returning id`)).rows[0];
    if (!row) throw new EquityError("The reserve change was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_plans", rowId: record.id, action: "equity.plan.reserve", actorId: input.actorId,
      changes: { changeId: row.id, effectiveOn, before: { reserved: before.reserved, available: before.available }, after: { reserved: before.reserved + delta, available: before.available + delta }, shareDelta: delta, reason },
    });
    return { id: row.id };
  });
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

/** A price rounded half up to four places, as a decimal string. */
const fourPlaces = (value: Rational): string => formatUnits(quantize(value, 4, "half_up"), 4);

/** A four-place round price carries this much rounding per share. */
const PRE_MONEY_TOLERANCE = rational(1n, 20000n);

/**
 * A round's pre-money valuation must equal its price times the fully
 * diluted shares before the round, within the rounding of a four-place
 * price. A valuation stated on another basis is accepted with the reason
 * recorded; without one it refuses with the figures that would agree.
 */
export function assertPreMoneyConsistent(
  before: EquityBook,
  input: { closedOn: string; price: Rational; preMoney: Rational; currency: string; basisReason: string | null },
): void {
  const fullyDiluted = BigInt(buildCapTable(before, input.closedOn).totals.fullyDiluted);
  const implied = multiplyRational(input.price, rational(fullyDiluted));
  if (fullyDiluted > 0n) {
    const gap = subtractRational(divideRational(input.preMoney, rational(fullyDiluted)), input.price);
    const magnitude = gap.numerator < 0n ? rational(-gap.numerator, gap.denominator) : gap;
    if (compareRational(magnitude, PRE_MONEY_TOLERANCE) <= 0) return;
  }
  if (input.basisReason) return;
  throw new EquityError("A pre-money valuation of {preMoney} does not match the round price of {price} times the {fullyDiluted} fully diluted shares before the round ({implied}).", {
    code: "equity_round_pre_money_inconsistent",
    remedy: fullyDiluted > 0n
      ? "Enter a pre-money valuation of {implied}, or a price per share of {impliedPrice}; if the valuation is stated on another basis (a pool increase or conversions counted in it), record that basis in the reason."
      : "No shares are outstanding before the round, so the valuation cannot be checked against the price; record the basis of the valuation in the reason.",
    field: "preMoneyValuation",
    values: {
      preMoney: { kind: "money", value: formatMoney(input.preMoney), currency: input.currency },
      price: { kind: "decimal", value: formatPrice(input.price) },
      fullyDiluted: { kind: "shares", value: fullyDiluted },
      implied: { kind: "money", value: formatMoney(implied), currency: input.currency },
      impliedPrice: { kind: "decimal", value: fullyDiluted > 0n ? fourPlaces(divideRational(input.preMoney, rational(fullyDiluted))) : "0" },
    },
  });
}

/** An optional basis reason: blank is none; a written one needs five characters. */
export function optionalBasisReason(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return requireReason(value, "the pre-money basis");
}

/** Every round name the legal entity has used, voided rounds and amended names included. */
export async function usedRoundNames(orgId: string, subsidiaryId: string): Promise<{ roundId: string; name: string }[]> {
  return (await db.execute<{ round_id: string; name: string }>(sql`
    select id as round_id, name from equity_financing_rounds where org_id = ${orgId} and subsidiary_id = ${subsidiaryId}
    union all
    select round_id, name from equity_round_amendments where org_id = ${orgId} and subsidiary_id = ${subsidiaryId} and name is not null`)).rows
    .map((row) => ({ roundId: row.round_id, name: row.name }));
}

/** Record a closed financing round; its shares are then issued against it. */
export async function createRound(input: CreateRoundInput): Promise<{ id: string }> {
  const name = requireText(input.name, "name", "The round name", 200);
  const closedOn = requireDate(input.closedOn, "closedOn", "The closing date");
  const price = parsePrice(input.pricePerShare, "the price per share");
  const pre = parseDecimal(input.preMoneyValuation, "the pre-money valuation", 4);
  const basisReason = optionalBasisReason(input.preMoneyBasisReason);
  if (price.numerator <= 0n) throw new EquityError("The price per share must be greater than zero.", { code: "equity_round_terms_invalid", remedy: "Enter the round price per share.", field: "pricePerShare" });
  if (compareRational(pre, rational(0n)) <= 0) throw new EquityError("The pre-money valuation must be greater than zero.", { code: "equity_round_terms_invalid", remedy: "Enter the pre-money valuation.", field: "preMoneyValuation" });
  return inEquityCommand(input, "equity.manage", async ({ book, currency: functional }) => {
    const requested = typeof input.currency === "string" && input.currency.trim() !== "" ? input.currency.trim().toUpperCase() : null;
    if (requested && !/^[A-Z]{3}$/.test(requested)) throw new EquityError("Choose the currency the round is priced in.", { code: "equity_currency_unknown", remedy: "Enter a three-letter ISO currency code.", field: "currency" });
    const currency = requested ?? functional;
    await currencyExponent(db, currency);
    if (currency !== functional) await spotRate(db, input.orgId, currency, functional, closedOn, functional);
    const shareClass = book.classes.find((row) => row.id === input.shareClassId);
    if (!shareClass) throw new EquityError("The share class does not exist for this legal entity.", { status: 404, code: "equity_class_unknown", remedy: "Choose a share class of the legal entity.", field: "shareClassId" });
    if (closedOn < shareClass.effectiveOn) throw new EquityError("A round cannot close before its share class is effective.", { code: "equity_date_invalid", remedy: `Date the round on or after ${shareClass.effectiveOn}.`, field: "closedOn" });
    if ((await usedRoundNames(input.orgId, input.subsidiaryId)).some((row) => row.name.toLowerCase() === name.toLowerCase())) {
      throw new EquityError(`A round named ${name} already exists for this legal entity, or did before it was renamed or voided.`, { status: 409, code: "equity_round_name_taken", remedy: "Choose a different round name.", field: "name" });
    }
    assertPreMoneyConsistent(book, { closedOn, price, preMoney: pre, currency, basisReason });
    const row = (await db.execute<{ id: string }>(sql`
      insert into equity_financing_rounds (org_id, subsidiary_id, name, share_class_id, closed_on, price_per_share, pre_money_valuation, currency, pre_money_basis_reason, created_by)
      values (${input.orgId}, ${input.subsidiaryId}, ${name}, ${shareClass.id}, ${closedOn}::date, ${input.pricePerShare.trim()}::numeric,
        ${input.preMoneyValuation.trim()}::numeric, ${currency}, ${basisReason}, ${input.actorId})
      returning id`)).rows[0];
    if (!row) throw new EquityError("The round was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_financing_rounds", rowId: row.id, action: "equity.round.create", actorId: input.actorId,
      changes: { before: null, after: { name, shareClassId: shareClass.id, closedOn, pricePerShare: input.pricePerShare, preMoneyValuation: input.preMoneyValuation, currency, preMoneyBasisReason: basisReason } },
    });
    return { id: row.id };
  });
}
