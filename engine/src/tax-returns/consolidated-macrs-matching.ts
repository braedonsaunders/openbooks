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
import { add, formatMoney, fromUnits, neg, toUnits } from "../money/money.ts";
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
      `consolidated-group membership ${membership.effectiveOn}–${membership.throughOn} does not cover ${from}–${args.yearEnd}; reverse the applied tax basis workpaper and re-propose membership through that year — an applied source cannot take a second workpaper`,
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
  allocatedDeferredOpening?: string | null;
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
    allocatedDeferredOpening: args.allocatedDeferredOpening,
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
  "workpaperId",
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
  workpaperId: "receiving workpaper",
  workpaperChangeId: "workpaper change",
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

/** Posted-row lookup. Vintage keys are source/date/transfer/parent within one
 *  receiving paper — two assets placed and transferred on the same dates share
 *  that key and must not share a matching row. */
export function matchingPeriodRowIdentity(args: {
  workpaperId: string;
  vintageKey: string;
  taxYearWindowId: string;
}): { workpaperId: string; vintageKey: string; taxYearWindowId: string } {
  if (!args.workpaperId) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching periods identify the receiving tax basis workpaper; reverse and re-propose it — do not persist matching without that paper",
    );
  }
  if (!args.vintageKey) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching periods identify the vintage by source, placed-in-service date, transfer date and parent vintage — do not persist a year without that key",
    );
  }
  if (!args.taxYearWindowId) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching periods cite a registered tax year; run the year from tax-year setup — do not persist matching against an inferred book calendar",
    );
  }
  return {
    workpaperId: args.workpaperId,
    vintageKey: args.vintageKey,
    taxYearWindowId: args.taxYearWindowId,
  };
}

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
  workpaperId: string;
  workpaperChangeId: string;
  parentKey?: string | null;
}): ConsolidatedMatchingPeriodFacts {
  const row = matchingPeriodRowIdentity({
    workpaperId: input.workpaperId,
    vintageKey: input.matched.vintageKey ?? "",
    taxYearWindowId: input.matched.taxYearWindowId ?? "",
  });
  if (!input.workpaperChangeId) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching periods cite the applied tax basis workpaper; reverse and re-propose it — do not persist matching without that change",
    );
  }
  return {
    workpaperId: row.workpaperId,
    workpaperChangeId: input.workpaperChangeId,
    vintageKey: row.vintageKey,
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

/** Historical posted matching cited by a replacement-paper replay.
 *  Deductions are evidence; the deferred opening is not reused. */
export type HistoricalMatchingPeriodEvidence = {
  id: string;
  workpaperId: string;
  vintageKey: string;
  parentKey: string | null;
  taxYearWindowId: string;
  yearStart: string;
  yearEnd: string;
  actualDeduction: string;
  recomputedDeduction: string;
  /** Frozen intercompany transfer date from the cited paper. Membership
   *  covers max(yearStart, transferOn)..yearEnd — not the calendar year
   *  start when the transfer is later. */
  transferOn?: string | null;
};

export type MatchingPeriodReplay = ConsolidatedMatchingPeriodFacts & {
  priorMatchingPeriodId: string;
  taxYearWindowId: string;
};

/** Earlier matching years cannot be restated once a later pool result exists.
 *  Those years are replayed onto the replacement paper; the latest computed
 *  year stays for the allowed pool re-run. */
export function historicalMatchingYearsToReplay(
  historical: readonly HistoricalMatchingPeriodEvidence[],
  latestPoolYearStart: string | null,
): HistoricalMatchingPeriodEvidence[] {
  if (!latestPoolYearStart) return [];
  return historical.filter((row) => row.yearEnd < latestPoolYearStart);
}

/** Append-only replay: new rows cite historical IDs and walk the replacement
 *  opening through those cited deductions. Old amounts are not overwritten
 *  and an uncited historical opening is not borrowed. */
export function replayMatchingPeriodsFromCitedHistory(args: {
  replacementWorkpaperId: string;
  replacementWorkpaperChangeId: string;
  replacementOpening: string;
  replacementMembership: ConsolidatedMembershipFact;
  historical: readonly HistoricalMatchingPeriodEvidence[];
  /** Frozen transfer date for this paper. Required when membership begins
   *  on the transfer date and the cited year starts earlier. */
  transferOn?: string | null;
}): MatchingPeriodReplay[] {
  if (args.historical.length === 0) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching replay requires the cited historical matching rows from the reversed workpaper — do not invent earlier years or borrow an uncited opening",
    );
  }
  if (!args.replacementWorkpaperId || !args.replacementWorkpaperChangeId) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching replay cites the replacement tax basis workpaper; apply that paper — do not persist replay onto the reversed paper",
    );
  }
  const ordered = [...args.historical].sort((left, right) =>
    left.yearStart.localeCompare(right.yearStart) || left.yearEnd.localeCompare(right.yearEnd),
  );
  const vintageKey = ordered[0]!.vintageKey;
  const seenIds = new Set<string>();
  const seenWindows = new Set<string>();
  let previousEnd: string | null = null;
  for (const row of ordered) {
    if (!row.id) {
      throw new ConsolidatedTaxMatchingError(
        "1.1502-13 matching replay must cite each historical row by id — do not borrow an opening from an unidentified year",
      );
    }
    if (seenIds.has(row.id)) {
      throw new ConsolidatedTaxMatchingError(
        `1.1502-13 matching replay cites historical row ${row.id} twice; supply each posted year once`,
      );
    }
    seenIds.add(row.id);
    if (row.workpaperId === args.replacementWorkpaperId) {
      throw new ConsolidatedTaxMatchingError(
        "1.1502-13 matching replay requires a replacement workpaper; an applied source cannot take a second row on the same paper",
      );
    }
    if (row.vintageKey !== vintageKey) {
      throw new ConsolidatedTaxMatchingError(
        "1.1502-13 matching replay walks one vintage at a time; do not mix another asset or parent lineage into this chain",
      );
    }
    if (!row.taxYearWindowId) {
      throw new ConsolidatedTaxMatchingError(
        `prior matching year ${row.yearStart}–${row.yearEnd} must cite a registered tax year; use the posted historical row — do not walk an unidentified window`,
      );
    }
    if (seenWindows.has(row.taxYearWindowId)) {
      throw new ConsolidatedTaxMatchingError(
        `prior matching year ${row.yearStart}–${row.yearEnd} is a duplicate and repeats tax year ${row.taxYearWindowId}; supply each posted window once — do not match the same year twice`,
      );
    }
    seenWindows.add(row.taxYearWindowId);
    if (previousEnd && row.yearStart <= previousEnd) {
      throw new ConsolidatedTaxMatchingError(
        `prior matching years ${row.yearStart}–${row.yearEnd} overlap an earlier window ending ${previousEnd}; supply distinct posted windows — do not match overlapping years`,
      );
    }
    previousEnd = row.yearEnd;
    assertMembershipCoversPeriod(args.replacementMembership, {
      yearStart: row.yearStart,
      yearEnd: row.yearEnd,
      transferOn: args.transferOn ?? row.transferOn,
    });
  }
  let opening = exactMoney(args.replacementOpening, "replacementOpening");
  const replayed: MatchingPeriodReplay[] = [];
  for (const row of ordered) {
    const matched = matchConsolidatedDepreciation({
      deferredOpening: opening,
      actualDeduction: row.actualDeduction,
      recomputedDeduction: row.recomputedDeduction,
    });
    replayed.push({
      ...matchingPeriodPersistFacts({
        matched: {
          ...matched,
          membership: args.replacementMembership,
          actualDeduction: row.actualDeduction,
          recomputedDeduction: row.recomputedDeduction,
          yearStart: row.yearStart,
          yearEnd: row.yearEnd,
          taxYearWindowId: row.taxYearWindowId,
          vintageKey: row.vintageKey,
        },
        workpaperId: args.replacementWorkpaperId,
        workpaperChangeId: args.replacementWorkpaperChangeId,
        parentKey: row.parentKey,
      }),
      priorMatchingPeriodId: row.id,
      taxYearWindowId: row.taxYearWindowId,
    });
    opening = matched.deferredClosing;
  }
  return replayed;
}

export type MatchingVintageWeight = {
  vintageKey: string;
  amount: string;
};

export type MatchingSellerVintageAllocation = {
  sellerVintageKey: string;
  disposedUnadjustedBasis: string;
};

export type MatchingReceiverVintageIdentity = {
  vintageKey: string;
  parentKey: string;
  unadjustedBasis: string;
};

/** Join seller vintageAllocations to receiving buyerVintages by parentKey.
 *  Historical matching rows are keyed by the receiver carryover identity.
 *  Seller source keys are not interchangeable with those rows, and two
 *  vintages that share a placed-in-service date are not the same vintage. */
export function matchingReplayVintageWeights(args: {
  allocations: readonly MatchingSellerVintageAllocation[];
  receivers: readonly MatchingReceiverVintageIdentity[];
}): MatchingVintageWeight[] {
  if (args.allocations.length === 0 || args.receivers.length === 0) return [];
  const sellers = new Map<string, MatchingSellerVintageAllocation>();
  for (const row of args.allocations) {
    if (!row.sellerVintageKey) {
      throw new ConsolidatedTaxMatchingError(
        "1.1502-13 matching replay vintageAllocations must identify the disposed seller vintage; reverse and re-propose the workpaper — do not match a receiving vintage by placed-in-service date",
      );
    }
    if (sellers.has(row.sellerVintageKey)) {
      throw new ConsolidatedTaxMatchingError(
        `1.1502-13 matching replay vintageAllocations declare ${row.sellerVintageKey} more than once; reverse and re-propose the workpaper — do not match a receiving vintage by placed-in-service date`,
      );
    }
    sellers.set(row.sellerVintageKey, row);
  }
  const seenReceivers = new Set<string>();
  const usedSellers = new Set<string>();
  const weights: MatchingVintageWeight[] = [];
  for (const row of args.receivers) {
    if (!row.vintageKey || !row.parentKey) {
      throw new ConsolidatedTaxMatchingError(
        "1.1502-13 matching replay buyerVintages must identify the receiving vintage and its disposed parentKey; reverse and re-propose the workpaper — do not match a vintage by placed-in-service date",
      );
    }
    if (seenReceivers.has(row.vintageKey)) {
      throw new ConsolidatedTaxMatchingError(
        `1.1502-13 matching replay buyerVintages declare receiving vintage ${row.vintageKey} more than once; reverse and re-propose the workpaper`,
      );
    }
    seenReceivers.add(row.vintageKey);
    const allocation = sellers.get(row.parentKey);
    if (!allocation) {
      throw new ConsolidatedTaxMatchingError(
        `1.1502-13 matching replay receiving vintage ${row.vintageKey} parentKey ${row.parentKey} is not a vintageAllocations seller identity; reverse and re-propose the workpaper — do not match those vintages by placed-in-service date`,
      );
    }
    usedSellers.add(row.parentKey);
    weights.push({
      vintageKey: row.vintageKey,
      amount: formatMoney(exactMoney(row.unadjustedBasis, "buyerVintages.unadjustedBasis"), 4),
    });
  }
  for (const row of args.allocations) {
    const disposed = exactMoney(row.disposedUnadjustedBasis, "vintageAllocations.disposedUnadjustedBasis");
    if (toUnits(disposed) > 0n && !usedSellers.has(row.sellerVintageKey)) {
      throw new ConsolidatedTaxMatchingError(
        `1.1502-13 matching replay vintageAllocations ${row.sellerVintageKey} has no receiving buyerVintages parentKey; reverse and re-propose the workpaper — do not match those vintages by placed-in-service date`,
      );
    }
  }
  return weights;
}

/** One receiving-vintage weight universe for initial pool years and replay.
 *  Carryover rows join seller allocations to buyer vintages by parentKey.
 *  Excess and taxable-cost vintages are newly placed receivers — they are
 *  not seller allocation keys and are not matched by placed-in-service date. */
export function receivingMatchingVintageWeights(args: {
  allocations?: readonly MatchingSellerVintageAllocation[];
  receivers?: readonly MatchingReceiverVintageIdentity[];
  newlyPlaced?: readonly MatchingVintageWeight[];
}): MatchingVintageWeight[] {
  const allocations = args.allocations ?? [];
  const receivers = args.receivers ?? [];
  const carryover = allocations.length > 0 && receivers.length > 0
    ? matchingReplayVintageWeights({ allocations, receivers })
    : receivers.map((row) => ({
      vintageKey: row.vintageKey,
      amount: formatMoney(exactMoney(row.unadjustedBasis, "receiving vintage unadjustedBasis"), 4),
    }));
  const seen = new Set(carryover.map((row) => row.vintageKey));
  const extras: MatchingVintageWeight[] = [];
  for (const row of args.newlyPlaced ?? []) {
    if (!row.vintageKey) {
      throw new ConsolidatedTaxMatchingError(
        "1.1502-13 matching must identify each newly placed receiving vintage; reverse and re-propose the workpaper — do not match a vintage by placed-in-service date",
      );
    }
    if (seen.has(row.vintageKey)) continue;
    seen.add(row.vintageKey);
    extras.push({
      vintageKey: row.vintageKey,
      amount: formatMoney(exactMoney(row.amount, `receiving vintage ${row.vintageKey}`), 4),
    });
  }
  return [...carryover, ...extras];
}

/** Frozen financial result of a cited replay year. Approval and evidence
 *  render these amounts; the UI does not recompute them. */
export type MatchingReplayPeriodEvidence = {
  yearStart: string;
  yearEnd: string;
  taxYearWindowId: string;
  vintageKey: string;
  priorMatchingPeriodId: string;
  deferredOpening: string;
  actualDeduction: string;
  recomputedDeduction: string;
  actualCorrespondingAmount: string;
  recomputedCorrespondingAmount: string;
  sellerMatchingAmount: string;
  deferredClosing: string;
};

export function matchingReplayPeriodEvidence(
  row: MatchingPeriodReplay,
): MatchingReplayPeriodEvidence {
  // A replayed year is CITED evidence: approval renders these amounts and the
  // UI never recomputes them. The facts row allows a null year boundary or
  // vintage, which a replay year cannot have -- rendering "null" as a period
  // in an approval packet is worse than refusing to produce one.
  const required = { yearStart: row.yearStart, yearEnd: row.yearEnd, vintageKey: row.vintageKey };
  for (const [field, value] of Object.entries(required)) {
    if (value === null || value === undefined) {
      throw new Error(
        `matching replay period ${row.priorMatchingPeriodId} has no ${field}; a cited replay year cannot be evidenced without it`,
      );
    }
  }
  return {
    yearStart: required.yearStart!,
    yearEnd: required.yearEnd!,
    taxYearWindowId: row.taxYearWindowId,
    vintageKey: required.vintageKey!,
    priorMatchingPeriodId: row.priorMatchingPeriodId,
    deferredOpening: row.deferredOpening,
    actualDeduction: row.actualDeduction,
    recomputedDeduction: row.recomputedDeduction,
    actualCorrespondingAmount: row.actualCorrespondingAmount,
    recomputedCorrespondingAmount: row.recomputedCorrespondingAmount,
    sellerMatchingAmount: row.sellerMatchingAmount,
    deferredClosing: row.deferredClosing,
  };
}

/** Allocate a signed paper-level opening by nonnegative vintage weights.
 *  Weights are proportions, not a take/keep pool — gain may exceed basis.
 *  Floor each exact share, then assign remaining 0.0001 units by largest
 *  remainder (ties use the vintage key) so the signed total is conserved. */
function allocateSignedOpeningByVintage(
  opening: string,
  parts: readonly { key: string; amount: string }[],
): Map<string, string> {
  const signed = exactMoney(opening, "paperOpening");
  const signedUnits = toUnits(signed);
  const take = signedUnits < 0n ? -signedUnits : signedUnits;
  const rows = parts.map((part) => {
    const weight = exactMoney(part.amount, `vintage weight ${part.key}`);
    if (toUnits(weight) < 0n) {
      throw new ConsolidatedTaxMatchingError(
        `1.1502-13 matching vintage weight ${part.key} must not be negative; reverse and re-propose the workpaper — do not apply the paper opening to every vintage`,
      );
    }
    return { key: part.key, weight: toUnits(weight), take: 0n, remainder: 0n };
  });
  const total = rows.reduce((sum, row) => sum + row.weight, 0n);
  if (total === 0n) {
    if (take === 0n) {
      return new Map(rows.map((row) => [row.key, formatMoney("0", 4)]));
    }
    throw new ConsolidatedTaxMatchingError(
      `1.1502-13 matching could not allocate the paper deferred opening ${formatMoney(signed, 4)} across zero vintage weights; reverse and re-propose the workpaper — do not apply the paper opening to every vintage`,
    );
  }
  let unitsLeft = take;
  for (const row of rows) {
    const product = take * row.weight;
    row.take = product / total;
    row.remainder = product % total;
    unitsLeft -= row.take;
  }
  const ranked = [...rows].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
  for (const row of ranked) {
    if (unitsLeft === 0n) break;
    row.take += 1n;
    unitsLeft -= 1n;
  }
  if (unitsLeft !== 0n) {
    throw new ConsolidatedTaxMatchingError(
      `1.1502-13 matching could not conserve the paper deferred opening ${formatMoney(signed, 4)} across vintages; reverse and re-propose the workpaper — do not apply the paper opening to every vintage`,
    );
  }
  return new Map(
    rows.map((row) => [
      row.key,
      formatMoney(fromUnits(signedUnits < 0n ? -row.take : row.take), 4),
    ]),
  );
}

/** Allocate a paper-level deferred opening once across vintages. Pool-run
 *  initial years and replacement replay share this grain — passing the paper
 *  opening to every vintage would multiply the gain. */
export function allocatedDeferredOpeningsByVintage(args: {
  paperOpening: string;
  vintageKeys: readonly string[];
  vintageWeights: readonly MatchingVintageWeight[];
}): Map<string, string> {
  const opening = formatMoney(exactMoney(args.paperOpening, "paperOpening"), 4);
  const requested = new Set<string>();
  for (const vintageKey of args.vintageKeys) {
    if (!vintageKey) {
      throw new ConsolidatedTaxMatchingError(
        "1.1502-13 matching must identify each vintage that receives a share of the paper deferred opening; reverse and re-propose the workpaper — do not apply the paper opening to every vintage",
      );
    }
    if (requested.has(vintageKey)) {
      throw new ConsolidatedTaxMatchingError(
        `1.1502-13 matching allocates vintage ${vintageKey} more than once; reverse and re-propose the workpaper — do not apply the paper opening to every vintage`,
      );
    }
    requested.add(vintageKey);
  }
  if (args.vintageKeys.length === 1 && args.vintageWeights.length === 0) {
    return new Map([[args.vintageKeys[0]!, opening]]);
  }
  if (args.vintageWeights.length === 0) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching must allocate the paper deferred opening across each vintage from the receiving unadjusted basis; reverse and re-propose the workpaper — do not apply the paper opening to every vintage",
    );
  }
  const seen = new Set<string>();
  const parts = args.vintageWeights.map((row, index) => {
    if (!row.vintageKey) {
      throw new ConsolidatedTaxMatchingError(
        `1.1502-13 matching vintage allocation ${index} must identify the vintage; reverse and re-propose the workpaper — do not apply the paper opening to every vintage`,
      );
    }
    if (seen.has(row.vintageKey)) {
      throw new ConsolidatedTaxMatchingError(
        `1.1502-13 matching allocates vintage ${row.vintageKey} more than once; reverse and re-propose the workpaper — do not apply the paper opening to every vintage`,
      );
    }
    if (!requested.has(row.vintageKey)) {
      throw new ConsolidatedTaxMatchingError(
        `1.1502-13 matching vintage weight ${row.vintageKey} is not a requested receiving vintage; reverse and re-propose the workpaper — do not apply the paper opening to a vintage replay will not emit`,
      );
    }
    seen.add(row.vintageKey);
    return { key: row.vintageKey, amount: row.amount };
  });
  for (const vintageKey of args.vintageKeys) {
    if (!seen.has(vintageKey)) {
      throw new ConsolidatedTaxMatchingError(
        `1.1502-13 matching must allocate the paper deferred opening from the receiving unadjusted basis for vintage ${vintageKey}; reverse and re-propose the workpaper — do not apply the paper opening to every vintage`,
      );
    }
  }
  return allocateSignedOpeningByVintage(opening, parts);
}

/** Paper-level replay: the replacement deferred opening is allocated once
 *  across vintages, then each vintage walks its share through cited years.
 *  Passing the paper opening to every vintage would multiply the gain. */
export function replayMatchingPaperFromCitedHistory(args: {
  replacementWorkpaperId: string;
  replacementWorkpaperChangeId: string;
  replacementOpening: string;
  replacementMembership: ConsolidatedMembershipFact;
  historical: readonly HistoricalMatchingPeriodEvidence[];
  vintageWeights?: readonly MatchingVintageWeight[];
  transferOn?: string | null;
}): MatchingPeriodReplay[] {
  if (args.historical.length === 0) {
    throw new ConsolidatedTaxMatchingError(
      "1.1502-13 matching replay requires the cited historical matching rows from the reversed workpaper — do not invent earlier years or borrow an uncited opening",
    );
  }
  const byVintage = new Map<string, HistoricalMatchingPeriodEvidence[]>();
  for (const row of args.historical) {
    const group = byVintage.get(row.vintageKey) ?? [];
    group.push(row);
    byVintage.set(row.vintageKey, group);
  }
  const vintageKeys = [...byVintage.keys()].sort();
  const openings = allocatedDeferredOpeningsByVintage({
    paperOpening: args.replacementOpening,
    vintageKeys,
    vintageWeights: args.vintageWeights ?? [],
  });
  const replayed: MatchingPeriodReplay[] = [];
  for (const vintageKey of vintageKeys) {
    const opening = openings.get(vintageKey);
    if (opening == null) {
      throw new ConsolidatedTaxMatchingError(
        `1.1502-13 matching must allocate the paper deferred opening from the receiving unadjusted basis for vintage ${vintageKey}; reverse and re-propose the workpaper — do not apply the paper opening to every vintage`,
      );
    }
    replayed.push(
      ...replayMatchingPeriodsFromCitedHistory({
        replacementWorkpaperId: args.replacementWorkpaperId,
        replacementWorkpaperChangeId: args.replacementWorkpaperChangeId,
        replacementOpening: opening,
        replacementMembership: args.replacementMembership,
        historical: byVintage.get(vintageKey)!,
        transferOn: args.transferOn,
      }),
    );
  }
  return replayed;
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
      `posted 1.1502-13 matching for receiving workpaper ${proposed.workpaperId} vintage ${proposed.vintageKey} ${proposed.yearStart}–${proposed.yearEnd} already records a different ${MATCHING_PERIOD_IDENTITY_LABELS[identity]}; approve a replacement tax basis workpaper so earlier years can be replayed from the cited historical row — there is no reversal of a computed tax year and posted matching cannot be overwritten`,
    );
  }
  const amount = CONSOLIDATED_MATCHING_PERIOD_AMOUNT_KEYS.find(
    (key) => existing[key] !== proposed[key],
  );
  if (amount) {
    throw new ConsolidatedTaxMatchingError(
      `posted 1.1502-13 matching for receiving workpaper ${proposed.workpaperId} vintage ${proposed.vintageKey} ${proposed.yearStart}–${proposed.yearEnd} already records ${MATCHING_PERIOD_AMOUNT_LABELS[amount]} ${existing[amount]}, not ${proposed[amount]}; approve a replacement tax basis workpaper so earlier years can be replayed from the cited historical row — there is no reversal of a computed tax year and posted matching cannot be overwritten`,
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
  /** First-year share of the paper opening. Required when vintageKey is set
   *  and no posted closing or live prior years are supplied. */
  allocatedDeferredOpening?: string | null;
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
    if (input.allocatedDeferredOpening != null && input.allocatedDeferredOpening !== "") {
      throw new ConsolidatedTaxMatchingError(
        "posted matching opening and an allocated paper opening cannot both be supplied; use the posted closing — do not begin this vintage at the whole paper deferred opening",
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
  if (input.allocatedDeferredOpening != null && input.allocatedDeferredOpening !== "") {
    if ((input.priorYears ?? []).length > 0) {
      throw new ConsolidatedTaxMatchingError(
        "an allocated paper opening and live prior years cannot both be supplied; use the allocated share or the posted closing — do not walk the whole paper opening on every vintage",
      );
    }
    const matched = matchConsolidatedDepreciation({
      deferredOpening: exactMoney(input.allocatedDeferredOpening, "allocatedDeferredOpening"),
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
  if (input.vintageKey && prior.length === 0) {
    throw new ConsolidatedTaxMatchingError(
      `1.1502-13 matching for vintage ${input.vintageKey} must receive that vintage's allocated share of the paper deferred opening; allocate the opening once across vintages — do not begin each vintage at the whole paper deferred opening`,
    );
  }
  const seenWindows = new Set<string>();
  let previousEnd: string | null = null;
  let opening = frozen.consolidatedMatching.deferredOpening;
  for (const year of prior) {
    if (!year.taxYearWindowId) {
      throw new ConsolidatedTaxMatchingError(
        `prior matching year ${year.yearStart}–${year.yearEnd} must cite a registered tax year; use the posted closing — do not walk an unidentified window`,
      );
    }
    if (seenWindows.has(year.taxYearWindowId)) {
      throw new ConsolidatedTaxMatchingError(
        `prior matching year ${year.yearStart}–${year.yearEnd} is a duplicate and repeats tax year ${year.taxYearWindowId}; supply each posted window once — do not match the same year twice`,
      );
    }
    seenWindows.add(year.taxYearWindowId);
    if (year.yearEnd >= input.yearStart) {
      throw new ConsolidatedTaxMatchingError(
        `prior matching year ${year.yearStart}–${year.yearEnd} is not before ${input.yearStart}–${input.yearEnd}; supply only earlier windows — do not match the current year twice`,
      );
    }
    if (previousEnd && year.yearStart <= previousEnd) {
      throw new ConsolidatedTaxMatchingError(
        `prior matching years ${year.yearStart}–${year.yearEnd} overlap an earlier window ending ${previousEnd}; supply distinct posted windows — do not match overlapping years`,
      );
    }
    previousEnd = year.yearEnd;
    assertMembershipCoversPeriod(frozen.consolidatedMembership, {
      yearStart: year.yearStart,
      yearEnd: year.yearEnd,
      transferOn: input.transferOn,
    });
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
