/**
 * Native 1.1502-13 consumer for US MACRS. Arithmetic stays in
 * consolidated-tax-matching.ts. This module is the membership / deferred-gain
 * contract the workpaper freezes and the pool run consumes.
 *
 * Three facts stay separate (26 CFR 1.1502-13(c)(7)(ii)(D) Example 4):
 *   1. period-specific seller+buyer+group membership
 *   2. recognition / deferred intercompany gain (amount realized − seller
 *      adjusted basis of the slice)
 *   3. §168(i)(7) carryover + excess depreciation treatment
 *
 * Example 4 applies §168(i)(7) to a SALE (amount realized 130): carryover
 * equals seller adjusted basis and excess is newly placed. A carryover
 * depreciation checkpoint is not a zero intercompany gain. Do not infer
 * membership from relatedPerson, intercompany_transfer, tax_groups (those
 * are sales-tax codes), or section168i7Kind.
 */
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { add, formatMoney, neg } from "../money/money.ts";
import {
  ConsolidatedTaxMatchingError,
  matchConsolidatedDepreciation,
  matchConsolidatedTaxItems,
  type ConsolidatedTaxMatchingResult,
} from "./consolidated-tax-matching.ts";

export const CONSOLIDATED_MEMBERSHIP_IDENTITY = "us_macrs.consolidated_group.membership";

export const CONSOLIDATED_GROUP_MEMBERSHIP_KEYS = [
  "groupKey",
  "sellerSubsidiaryId",
  "buyerSubsidiaryId",
  "effectiveOn",
  "throughOn",
] as const;

const SUBSIDIARY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Operator-declared membership. Complete object or omitted — never partial. */
export type ConsolidatedGroupMembershipInput = {
  groupKey: string;
  sellerSubsidiaryId: string;
  buyerSubsidiaryId: string;
  effectiveOn: string;
  throughOn: string;
};

export type ConsolidatedMembershipFact = ConsolidatedGroupMembershipInput & {
  identity: typeof CONSOLIDATED_MEMBERSHIP_IDENTITY;
};

export type FrozenUsConsolidatedMatching = {
  consolidatedMembership: ConsolidatedMembershipFact;
  consolidatedMatching: ConsolidatedTaxMatchingResult & {
    actualCorrespondingItems: [];
    recomputedCorrespondingItems: [];
  };
};

export type ConsolidatedMacrsYearDeductions = {
  yearStart: string;
  yearEnd: string;
  taxYearWindowId?: string | null;
  actualDeduction: string;
  recomputedDeduction: string;
};

export type ConsolidatedMacrsYearMatching = ConsolidatedTaxMatchingResult & {
  membership: ConsolidatedMembershipFact;
  actualDeduction: string;
  recomputedDeduction: string;
  yearStart: string;
  yearEnd: string;
  taxYearWindowId: string | null;
  vintageKey: string | null;
};

function calendarDay(value: unknown, name: string): string {
  if (typeof value !== "string" || !CALENDAR_DAY.test(value)) {
    throw new ConsolidatedTaxMatchingError(
      `${name} must be a calendar date (YYYY-MM-DD); declare the membership period — do not infer it from the transfer date`,
    );
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ConsolidatedTaxMatchingError(
      `${name} must be a real calendar date (YYYY-MM-DD)`,
    );
  }
  return value;
}

function subsidiaryId(value: unknown, name: string): string {
  if (typeof value !== "string" || !SUBSIDIARY_ID.test(value)) {
    throw new ConsolidatedTaxMatchingError(
      `${name} must be the legal-entity UUID; pick the member subsidiary — do not type a name or use tax_groups`,
    );
  }
  return value;
}

function groupKey(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new ConsolidatedTaxMatchingError(
      "consolidatedGroupMembership.groupKey must identify the income-tax consolidated group; do not reuse a sales-tax tax_groups code or leave it blank",
    );
  }
  return value;
}

function exactMoney(value: unknown, name: string): string {
  const exact = typeof value === "string" ? canonicalDecimal(value, 4) : null;
  if (exact === null) {
    throw new ConsolidatedTaxMatchingError(
      `${name} must be an exact decimal string with at most four decimal places; supply the approved tax amount — do not invent it from remaining carryover or book cost`,
    );
  }
  return exact;
}

/** Null when membership is omitted. A partial object is a refusal. */
export function parseConsolidatedGroupMembership(value: unknown): ConsolidatedGroupMembershipInput | null {
  if (value == null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConsolidatedTaxMatchingError(
      "consolidatedGroupMembership must be one membership object; omit it when the transfer is not intra-group for 1.1502-13 — do not infer membership from relatedPerson or §168(i)(7)",
    );
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    (key) => !(CONSOLIDATED_GROUP_MEMBERSHIP_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new ConsolidatedTaxMatchingError(
      `unknown consolidatedGroupMembership field(s): ${unknown.sort().join(", ")}`,
    );
  }
  const missing = CONSOLIDATED_GROUP_MEMBERSHIP_KEYS.filter((key) => raw[key] == null || raw[key] === "");
  if (missing.length > 0) {
    throw new ConsolidatedTaxMatchingError(
      `consolidatedGroupMembership is missing ${missing.join(", ")}; declare the complete seller, buyer, group and period — do not match from a partial fact`,
    );
  }
  const membership = {
    groupKey: groupKey(raw.groupKey),
    sellerSubsidiaryId: subsidiaryId(raw.sellerSubsidiaryId, "consolidatedGroupMembership.sellerSubsidiaryId"),
    buyerSubsidiaryId: subsidiaryId(raw.buyerSubsidiaryId, "consolidatedGroupMembership.buyerSubsidiaryId"),
    effectiveOn: calendarDay(raw.effectiveOn, "consolidatedGroupMembership.effectiveOn"),
    throughOn: calendarDay(raw.throughOn, "consolidatedGroupMembership.throughOn"),
  };
  if (membership.sellerSubsidiaryId === membership.buyerSubsidiaryId) {
    throw new ConsolidatedTaxMatchingError(
      "consolidatedGroupMembership seller and buyer must be different legal entities; a book transfer inside one subsidiary is not an intercompany matching event",
    );
  }
  if (membership.effectiveOn > membership.throughOn) {
    throw new ConsolidatedTaxMatchingError(
      `consolidatedGroupMembership.effectiveOn ${membership.effectiveOn} is after throughOn ${membership.throughOn}; declare the period this evidence covers`,
    );
  }
  return membership;
}

export function freezeConsolidatedMembership(
  input: ConsolidatedGroupMembershipInput,
): ConsolidatedMembershipFact {
  return { identity: CONSOLIDATED_MEMBERSHIP_IDENTITY, ...input };
}

export function signedDeferredOpening(amountRealized: string, sellerAdjustedBasis: string): string {
  return formatMoney(add(amountRealized, neg(sellerAdjustedBasis)), 4);
}

/** Freeze membership + the helper opening. §168(i)(7) and recognition are
 *  not arguments — a carryover checkpoint is not a zero deferred gain. */
export function freezeUsConsolidatedMatching(input: {
  membership: unknown;
  amountRealized: string | null | undefined;
  sellerAdjustedBasis: string | null | undefined;
}): FrozenUsConsolidatedMatching | null {
  const membership = parseConsolidatedGroupMembership(input.membership);
  if (!membership) return null;
  if (input.amountRealized == null || input.amountRealized === "") {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 deferred opening requires amount realized on the intercompany sale; a §168(i)(7) carryover is not a zero intercompany gain — declare Pub 544 amount realized (Example 4 sale) or omit membership",
    );
  }
  if (input.sellerAdjustedBasis == null || input.sellerAdjustedBasis === "") {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 deferred opening requires sellerAdjustedBasis of the transferred slice; do not substitute remaining carryover, book carrying value or unadjusted basis",
    );
  }
  const opening = signedDeferredOpening(
    exactMoney(input.amountRealized, "amountRealized"),
    exactMoney(input.sellerAdjustedBasis, "sellerAdjustedBasis"),
  );
  const matching = matchConsolidatedTaxItems({
    deferredOpening: opening,
    actualCorrespondingItems: [],
    recomputedCorrespondingItems: [],
  });
  return {
    consolidatedMembership: freezeConsolidatedMembership(membership),
    consolidatedMatching: {
      ...matching,
      actualCorrespondingItems: [],
      recomputedCorrespondingItems: [],
    },
  };
}

export function assertMembershipCoversPeriod(
  membership: ConsolidatedMembershipFact,
  args: { yearStart: string; yearEnd: string; transferOn?: string | null },
): void {
  const from = args.transferOn && args.transferOn > args.yearStart ? args.transferOn : args.yearStart;
  if (membership.effectiveOn > from || membership.throughOn < args.yearEnd) {
    throw new ConsolidatedTaxMatchingError(
      `consolidated-group membership ${membership.effectiveOn}–${membership.throughOn} does not cover ${from}–${args.yearEnd}; declare membership for that period — do not extend a transfer-year fact`,
    );
  }
}

function parseFrozenMembership(value: unknown): ConsolidatedMembershipFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConsolidatedTaxMatchingError(
      "frozen consolidatedMembership must be the approved membership object; reverse and re-propose the workpaper — do not invent group membership from relatedPerson, §168(i)(7) or tax_groups",
    );
  }
  const row = value as Record<string, unknown>;
  if (row.identity !== CONSOLIDATED_MEMBERSHIP_IDENTITY) {
    throw new ConsolidatedTaxMatchingError(
      `frozen consolidatedMembership.identity must be ${CONSOLIDATED_MEMBERSHIP_IDENTITY}; reverse and re-propose the workpaper — do not relabel §168(i)(7) or a sales-tax group as income-tax consolidation`,
    );
  }
  const membership = parseConsolidatedGroupMembership({
    groupKey: row.groupKey,
    sellerSubsidiaryId: row.sellerSubsidiaryId,
    buyerSubsidiaryId: row.buyerSubsidiaryId,
    effectiveOn: row.effectiveOn,
    throughOn: row.throughOn,
  });
  if (!membership) {
    throw new ConsolidatedTaxMatchingError(
      "frozen consolidatedMembership is missing its period-specific seller, buyer and group; reverse and re-propose the workpaper",
    );
  }
  return freezeConsolidatedMembership(membership);
}

export function resolveFrozenUsConsolidatedMatching(computed: unknown): FrozenUsConsolidatedMatching {
  if (!computed || typeof computed !== "object" || Array.isArray(computed)) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching requires the applied US MACRS computed outcome; reverse and re-propose the workpaper — do not invent group membership or a deferred opening",
    );
  }
  const row = computed as Record<string, unknown>;
  if (row.consolidatedMembership == null && row.consolidatedMatching == null) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching requires frozen consolidatedGroupMembership on the applied workpaper; reverse and re-propose it — do not infer membership from relatedPerson, intercompany_transfer, §168(i)(7) or tax_groups",
    );
  }
  const membership = parseFrozenMembership(row.consolidatedMembership);
  if (!row.consolidatedMatching || typeof row.consolidatedMatching !== "object" || Array.isArray(row.consolidatedMatching)) {
    throw new ConsolidatedTaxMatchingError(
      "frozen consolidatedMatching must accompany consolidatedMembership; reverse and re-propose the workpaper — do not persist membership without its deferred opening",
    );
  }
  const opening = exactMoney(
    (row.consolidatedMatching as Record<string, unknown>).deferredOpening,
    "consolidatedMatching.deferredOpening",
  );
  const reconstructed = matchConsolidatedTaxItems({
    deferredOpening: opening,
    actualCorrespondingItems: [],
    recomputedCorrespondingItems: [],
  });
  return {
    consolidatedMembership: membership,
    consolidatedMatching: {
      ...reconstructed,
      actualCorrespondingItems: [],
      recomputedCorrespondingItems: [],
    },
  };
}

/** Native pool-run entry. Null when the paper has no membership nest.
 *  Buyer role only: the corresponding item is the receiving schedule.
 *  Identify the paper by vintage parentKey — not asset+transfer date. */
export function matchConsolidatedMacrsFromWorkpaper(args: {
  role: "seller" | "buyer";
  computed: Record<string, unknown> | null;
  originalUnadjustedBasis: string | null;
  actualDeduction: string;
  recomputedDeduction: string;
  yearStart: string;
  yearEnd: string;
  taxYearWindowId?: string | null;
  vintageKey?: string | null;
  transferOn?: string | null;
  sellerSubsidiaryId?: string | null;
  buyerSubsidiaryId?: string | null;
  priorYears?: readonly ConsolidatedMacrsYearDeductions[];
  postedDeferredOpening?: string | null;
}): ConsolidatedMacrsYearMatching | null {
  if (args.role !== "buyer" || !args.computed) return null;
  if (args.computed.consolidatedMembership == null && args.computed.consolidatedMatching == null) {
    return null;
  }
  if (!args.originalUnadjustedBasis) {
    throw new ConsolidatedTaxMatchingError(
      `1.1502-13 matching for the transfer${args.transferOn ? ` on ${args.transferOn}` : ""} requires originalUnadjustedBasis on the applied workpaper so the recomputed corresponding item can be walked as if the seller still held the slice; reverse and re-propose that workpaper — do not recompute from remaining carryover or book cost`,
    );
  }
  const live = matchLiveConsolidatedMacrsYear({
    computed: args.computed,
    actualDeduction: args.actualDeduction,
    recomputedDeduction: args.recomputedDeduction,
    yearStart: args.yearStart,
    yearEnd: args.yearEnd,
    taxYearWindowId: args.taxYearWindowId,
    vintageKey: args.vintageKey,
    transferOn: args.transferOn,
    priorYears: args.priorYears,
    postedDeferredOpening: args.postedDeferredOpening,
  });
  if (args.sellerSubsidiaryId && live.membership.sellerSubsidiaryId !== args.sellerSubsidiaryId) {
    throw new ConsolidatedTaxMatchingError(
      `frozen membership sellerSubsidiaryId ${live.membership.sellerSubsidiaryId} is not the transferor subsidiary ${args.sellerSubsidiaryId}; reverse and re-propose the workpaper — do not match another legal entity's item`,
    );
  }
  if (args.buyerSubsidiaryId && live.membership.buyerSubsidiaryId !== args.buyerSubsidiaryId) {
    throw new ConsolidatedTaxMatchingError(
      `frozen membership buyerSubsidiaryId ${live.membership.buyerSubsidiaryId} is not the receiving subsidiary ${args.buyerSubsidiaryId}; reverse and re-propose the workpaper — do not match another legal entity's item`,
    );
  }
  return live;
}

export function assertConsolidatedMembershipMatchesSource(
  membership: ConsolidatedGroupMembershipInput,
  source: {
    sellerSubsidiaryId: string;
    buyerSubsidiaryId: string | null;
    sourceOperation: "partial_disposal" | "intercompany_transfer";
  },
): void {
  if (source.sourceOperation === "partial_disposal" || source.buyerSubsidiaryId == null) {
    throw new ConsolidatedTaxMatchingError(
      "consolidated-group membership belongs on an intercompany transfer; a customer disposal is not a 1.1502-13 matching event — omit membership or select the intra-group transfer",
    );
  }
  if (membership.sellerSubsidiaryId !== source.sellerSubsidiaryId) {
    throw new ConsolidatedTaxMatchingError(
      "consolidated-group membership seller must be the source transferor legal entity; pick that member from the selected source — do not type a UUID or match another subsidiary",
    );
  }
  if (membership.buyerSubsidiaryId !== source.buyerSubsidiaryId) {
    throw new ConsolidatedTaxMatchingError(
      "consolidated-group membership buyer must be the source receiving legal entity; pick that member from the selected source — do not type a UUID or match another subsidiary",
    );
  }
}

export const CONSOLIDATED_MATCHING_PERIOD_AMOUNT_KEYS = [
  "deferredOpening",
  "actualDeduction",
  "recomputedDeduction",
  "actualCorrespondingAmount",
  "recomputedCorrespondingAmount",
  "sellerMatchingAmount",
  "deferredClosing",
] as const;

export type ConsolidatedMatchingPeriodAmounts = {
  [K in (typeof CONSOLIDATED_MATCHING_PERIOD_AMOUNT_KEYS)[number]]: string;
};

const MATCHING_PERIOD_AMOUNT_LABELS: Record<
  (typeof CONSOLIDATED_MATCHING_PERIOD_AMOUNT_KEYS)[number],
  string
> = {
  deferredOpening: "deferred opening",
  actualDeduction: "actual deduction",
  recomputedDeduction: "recomputed deduction",
  actualCorrespondingAmount: "actual corresponding amount",
  recomputedCorrespondingAmount: "recomputed corresponding amount",
  sellerMatchingAmount: "seller matching amount",
  deferredClosing: "deferred closing",
};

export const CONSOLIDATED_MATCHING_PERIOD_IDENTITY_KEYS = [
  "workpaperChangeId",
  "vintageKey",
  "parentKey",
  "groupKey",
  "sellerSubsidiaryId",
  "buyerSubsidiaryId",
  "membershipEffectiveOn",
  "membershipThroughOn",
  "yearStart",
  "yearEnd",
] as const;

const MATCHING_PERIOD_IDENTITY_LABELS: Record<
  (typeof CONSOLIDATED_MATCHING_PERIOD_IDENTITY_KEYS)[number],
  string
> = {
  workpaperChangeId: "workpaper",
  vintageKey: "vintage",
  parentKey: "parent vintage",
  groupKey: "consolidated group",
  sellerSubsidiaryId: "seller legal entity",
  buyerSubsidiaryId: "buyer legal entity",
  membershipEffectiveOn: "membership start",
  membershipThroughOn: "membership end",
  yearStart: "tax year start",
  yearEnd: "tax year end",
};

export type ConsolidatedMatchingPeriodIdentity = {
  [K in (typeof CONSOLIDATED_MATCHING_PERIOD_IDENTITY_KEYS)[number]]: string | null;
};

export type ConsolidatedMatchingPeriodFacts =
  ConsolidatedMatchingPeriodAmounts & ConsolidatedMatchingPeriodIdentity;

function matchingPeriodMoney(value: unknown, name: string): string {
  return formatMoney(exactMoney(value, name), 4);
}

export function matchingPeriodPersistFacts(input: {
  matched: ConsolidatedMacrsYearMatching;
  workpaperChangeId: string;
  parentKey?: string | null;
}): ConsolidatedMatchingPeriodFacts {
  if (!input.matched.vintageKey) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching periods identify the vintage by source, placed-in-service date, transfer date and parent vintage — do not persist a year without that key",
    );
  }
  if (!input.matched.taxYearWindowId) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching periods cite a registered tax year; run the year from tax-year setup — do not persist matching against an inferred book calendar",
    );
  }
  if (!input.workpaperChangeId) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching periods cite the applied tax basis workpaper; reverse and re-propose it — do not persist matching without that change",
    );
  }
  return {
    workpaperChangeId: input.workpaperChangeId,
    vintageKey: input.matched.vintageKey,
    parentKey: input.parentKey ?? null,
    groupKey: input.matched.membership.groupKey,
    sellerSubsidiaryId: input.matched.membership.sellerSubsidiaryId,
    buyerSubsidiaryId: input.matched.membership.buyerSubsidiaryId,
    membershipEffectiveOn: input.matched.membership.effectiveOn,
    membershipThroughOn: input.matched.membership.throughOn,
    yearStart: input.matched.yearStart,
    yearEnd: input.matched.yearEnd,
    deferredOpening: matchingPeriodMoney(input.matched.deferredOpening, "deferredOpening"),
    actualDeduction: matchingPeriodMoney(input.matched.actualDeduction, "actualDeduction"),
    recomputedDeduction: matchingPeriodMoney(input.matched.recomputedDeduction, "recomputedDeduction"),
    actualCorrespondingAmount: matchingPeriodMoney(
      input.matched.actualCorrespondingAmount,
      "actualCorrespondingAmount",
    ),
    recomputedCorrespondingAmount: matchingPeriodMoney(
      input.matched.recomputedCorrespondingAmount,
      "recomputedCorrespondingAmount",
    ),
    sellerMatchingAmount: matchingPeriodMoney(
      input.matched.sellerMatchingAmount,
      "sellerMatchingAmount",
    ),
    deferredClosing: matchingPeriodMoney(input.matched.deferredClosing, "deferredClosing"),
  };
}

/** Idempotent re-run reproduces the posted row. A different amount or identity
 *  is a refusal — posted matching that can be overwritten is not evidence. */
export function assertWriteOnceMatchingPeriod(
  existing: ConsolidatedMatchingPeriodFacts,
  proposed: ConsolidatedMatchingPeriodFacts,
): void {
  const identity = CONSOLIDATED_MATCHING_PERIOD_IDENTITY_KEYS.find(
    (key) => (existing[key] ?? null) !== (proposed[key] ?? null),
  );
  if (identity) {
    throw new ConsolidatedTaxMatchingError(
      `posted 1.1502-13 matching for vintage ${proposed.vintageKey} ${proposed.yearStart}–${proposed.yearEnd} already records a different ${MATCHING_PERIOD_IDENTITY_LABELS[identity]}; reverse that tax year and re-run — do not overwrite posted matching`,
    );
  }
  const amount = CONSOLIDATED_MATCHING_PERIOD_AMOUNT_KEYS.find(
    (key) => existing[key] !== proposed[key],
  );
  if (amount) {
    throw new ConsolidatedTaxMatchingError(
      `posted 1.1502-13 matching for vintage ${proposed.vintageKey} ${proposed.yearStart}–${proposed.yearEnd} already records ${MATCHING_PERIOD_AMOUNT_LABELS[amount]} ${existing[amount]}, not ${proposed[amount]}; reverse that tax year and re-run — do not overwrite posted matching`,
    );
  }
}

export function matchLiveConsolidatedMacrsYear(input: {
  computed: unknown;
  actualDeduction: string;
  recomputedDeduction: string;
  yearStart: string;
  yearEnd: string;
  taxYearWindowId?: string | null;
  vintageKey?: string | null;
  transferOn?: string | null;
  priorYears?: readonly ConsolidatedMacrsYearDeductions[];
  /** Posted prior-year closing. Replaces a live walk of earlier windows. */
  postedDeferredOpening?: string | null;
}): ConsolidatedMacrsYearMatching {
  const frozen = resolveFrozenUsConsolidatedMatching(input.computed);
  assertMembershipCoversPeriod(frozen.consolidatedMembership, {
    yearStart: input.yearStart,
    yearEnd: input.yearEnd,
    transferOn: input.transferOn,
  });
  if (input.postedDeferredOpening != null && input.postedDeferredOpening !== "") {
    if ((input.priorYears ?? []).length > 0) {
      throw new ConsolidatedTaxMatchingError(
        "posted matching opening and live prior years cannot both be supplied; use the posted closing — do not recompute a posted opening from a live walk",
      );
    }
    const matched = matchConsolidatedDepreciation({
      deferredOpening: exactMoney(input.postedDeferredOpening, "postedDeferredOpening"),
      actualDeduction: input.actualDeduction,
      recomputedDeduction: input.recomputedDeduction,
    });
    return {
      ...matched,
      membership: frozen.consolidatedMembership,
      actualDeduction: input.actualDeduction,
      recomputedDeduction: input.recomputedDeduction,
      yearStart: input.yearStart,
      yearEnd: input.yearEnd,
      taxYearWindowId: input.taxYearWindowId ?? null,
      vintageKey: input.vintageKey ?? null,
    };
  }
  const prior = [...(input.priorYears ?? [])].sort((left, right) =>
    left.yearStart.localeCompare(right.yearStart) || left.yearEnd.localeCompare(right.yearEnd),
  );
  let opening = frozen.consolidatedMatching.deferredOpening;
  for (const year of prior) {
    if (year.yearEnd >= input.yearStart) {
      throw new ConsolidatedTaxMatchingError(
        `prior matching year ${year.yearStart}–${year.yearEnd} is not before ${input.yearStart}–${input.yearEnd}; supply only earlier windows — do not match the current year twice`,
      );
    }
    opening = matchConsolidatedDepreciation({
      deferredOpening: opening,
      actualDeduction: year.actualDeduction,
      recomputedDeduction: year.recomputedDeduction,
    }).deferredClosing;
  }
  const matched = matchConsolidatedDepreciation({
    deferredOpening: opening,
    actualDeduction: input.actualDeduction,
    recomputedDeduction: input.recomputedDeduction,
  });
  return {
    ...matched,
    membership: frozen.consolidatedMembership,
    actualDeduction: input.actualDeduction,
    recomputedDeduction: input.recomputedDeduction,
    yearStart: input.yearStart,
    yearEnd: input.yearEnd,
    taxYearWindowId: input.taxYearWindowId ?? null,
    vintageKey: input.vintageKey ?? null,
  };
}
