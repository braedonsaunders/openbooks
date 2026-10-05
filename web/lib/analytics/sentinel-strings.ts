/**
 * Localizable sentence templates for Sentinel ledger forensics.
 *
 * `sentinelStrings(t)` builds the bundle from `getTranslations('analytics')`
 * in the request locale. Entity names, document numbers and trap digits travel verbatim as
 * ICU string params (they are data); counts travel as numbers into ICU
 * plurals. Benford conformity itself is a stable CODE
 * (excellent/acceptable/marginal/nonConforming) in every language — the
 * request-scoped dashboard maps codes to words, so forensic payloads never
 * compare against translated text.
 */

import type { CatalogMessageFn } from "./catalog-strings";

export type ConformityCode = "excellent" | "acceptable" | "marginal" | "nonConforming" | "insufficient";

export interface SentinelRiskArea {
  area: string;
  message: string;
}

export interface SentinelStrings {
  locale: string;
  /** Map the SQL `coalesce(…, 'Unknown')` sentinel (or blank) to the request language. */
  displayPartyName(name: string | null): string;
  benfordInsufficient(total: number, minimum: number): string;
  /** Threshold-trap refusal when no Flows amount condition exists. */
  trapUnavailable: string;
  /** Duplicate-detector refusal when the duplicate floor is not configured. */
  duplicateFloorUnset: string;
  /** Relative-size refusal when its noise floor is not configured. */
  rsfFloorUnset: string;
  /** Z-score refusal when its noise floor is not configured. */
  zscoreFloorUnset: string;
  /** Translated names of detectors the score had to skip, for the exclusion note. */
  detectorDuplicate: string;
  detectorTrap: string;
  detectorRsf: string;
  detectorZscore: string;
  /** "Amount tiers" as a skipped scoring source when any tier is unset. */
  detectorAmountTiers: string;
  benfordClose: string;
  benfordReasonable: string;
  benfordSomeDeviation: string;
  benfordSignificant: string;
  /** `trap` is the digit pattern from the ledger (999/9999 — data). */
  trapReason(trap: string): string;
  weekendReason(sunday: boolean): string;
  /** `multiple` is pre-rendered (legacy toFixed(1)); `vendor`/`currency` are data. */
  rsfReason(multiple: string, vendor: string, currency: string): string;
  /** `z` is pre-rendered (legacy toFixed(2) of |z|); `vendor`/`currency` are data. */
  zscoreReason(z: string, vendor: string, currency: string, baseline: number): string;
  sequentialReason(count: number, first: string, last: string, days: number, high: boolean, currency: string): string;
  ghostBoth(vendor: string, employee: string): string;
  ghostAddress(vendor: string, employee: string): string;
  ghostName(vendor: string, employee: string): string;
  /**
   * One finding per natural-key duplicate group. `amount` is pre-rendered
   * (legacy String(number)); `others` is the comma-joined peer list (data).
   */
  duplicateGroupReason(args: {
    count: number;
    currency: string;
    amount: string;
    sharedReference: string | null;
    daysSpan: number;
    others: string;
  }): string;
  /**
   * One-line audit-trail summary: who did what to which record.
   * `verb` is a stable code the bundle maps to words; `action` is the raw
   * audit_log action, used verbatim only for `other`. `actor`, `table`,
   * `row` and `fields` are ledger data (short ids, field names) and travel
   * verbatim in every language.
   */
  auditEvent(args: {
    verb: "created" | "updated" | "deleted" | "other";
    action: string;
    actor: string;
    table: string;
    row: string;
    fields: string;
  }): string;
  riskGhosts(count: number): SentinelRiskArea;
  riskSequential(count: number): SentinelRiskArea;
  riskDuplicates(count: number): SentinelRiskArea;
  riskTraps(count: number): SentinelRiskArea;
  riskBenford(): SentinelRiskArea;
}

/** Stable verb codes for audit-trail summaries; the bundle maps them to words. */
export type AuditVerb = "created" | "updated" | "deleted" | "other";

export interface AuditEventArgs {
  verb: AuditVerb;
  action: string;
  actor: string;
  table: string;
  row: string;
  fields: string;
}

/**
 * Assemble the locale-free arguments for an audit-trail summary.
 * Pure data shaping, no display copy: the action maps to a stable verb
 * code, actor/row collapse to short ledger identifiers (a missing actor is
 * the system), and the changed-field list comes from the changes envelope
 * (unparseable — e.g. truncated — envelopes simply name no fields). All
 * literals are lowercase codes, never sentences.
 */
export function auditEventArgs(
  action: string,
  actorId: string | null,
  tableName: string,
  rowId: string | null,
  changesText: string | null,
): AuditEventArgs {
  const lower = (action ?? "").toLowerCase();
  const verb: AuditVerb =
    lower === "insert" ? "created" : lower === "update" ? "updated" : lower === "delete" ? "deleted" : "other";
  let fields = "";
  try {
    const parsed: unknown = JSON.parse(changesText ?? "");
    const keys = parsed !== null && typeof parsed === "object" ? Object.keys(parsed) : [];
    fields = keys.slice(0, 3).join(", ") + (keys.length > 3 ? ", …" : "");
  } catch {
    fields = "";
  }
  return {
    verb,
    action: lower || action,
    actor: actorId ? actorId.slice(0, 8) : "system",
    table: tableName,
    row: (rowId ?? "").slice(0, 8),
    fields,
  };
}

/** Catalog-backed bundle: every sentence renders in the request locale. */
export function sentinelStrings(t: CatalogMessageFn, locale: string): SentinelStrings {
  return {
    locale,
    displayPartyName: (name) =>
      name === null || name === "" || name === "Unknown" ? t("sentinel.forensics.unknownParty") : name,
    benfordInsufficient: (total, minimum) => t("sentinel.forensics.benfordInsufficient", { total, minimum }),
    trapUnavailable: t("sentinel.forensics.trapUnavailable"),
    duplicateFloorUnset: t("sentinel.forensics.duplicateFloorUnset"),
    rsfFloorUnset: t("sentinel.forensics.rsfFloorUnset"),
    zscoreFloorUnset: t("sentinel.forensics.zscoreFloorUnset"),
    detectorDuplicate: t("sentinel.detectors.duplicates"),
    detectorTrap: t("sentinel.detectors.trap"),
    detectorRsf: t("sentinel.detectors.rsf"),
    detectorZscore: t("sentinel.detectors.zscore"),
    detectorAmountTiers: t("sentinel.detectors.amountTiers"),
    benfordClose: t("sentinel.forensics.benfordClose"),
    benfordReasonable: t("sentinel.forensics.benfordReasonable"),
    benfordSomeDeviation: t("sentinel.forensics.benfordSomeDeviation"),
    benfordSignificant: t("sentinel.forensics.benfordSignificant"),
    trapReason: (trap) => t("sentinel.forensics.trap", { trap }),
    weekendReason: (sunday) => t(sunday ? "sentinel.forensics.weekendSunday" : "sentinel.forensics.weekendSaturday"),
    rsfReason: (multiple, vendor, currency) => t("sentinel.forensics.rsf", { multiple, vendor, currency }),
    zscoreReason: (z, vendor, currency, baseline) =>
      t("sentinel.forensics.zscore", { z, vendor, currency, n: baseline }),
    sequentialReason: (count, first, last, days, high, currency) =>
      t("sentinel.forensics.sequential", {
        count,
        first,
        last,
        days,
        currency,
        shell: high ? t("sentinel.forensics.sequentialShell") : "",
      }),
    ghostBoth: (vendor, employee) => t("sentinel.forensics.ghostBoth", { vendor, employee }),
    ghostAddress: (vendor, employee) => t("sentinel.forensics.ghostAddress", { vendor, employee }),
    ghostName: (vendor, employee) => t("sentinel.forensics.ghostName", { vendor, employee }),
    duplicateGroupReason: ({ count, currency, amount, sharedReference, daysSpan, others }) =>
      t("sentinel.forensics.duplicateGroup", {
        count,
        currency,
        amount,
        sharedRef: sharedReference
          ? t("sentinel.forensics.duplicateSharedRef", { reference: sharedReference })
          : "",
        daysSpan,
        others,
      }),
    auditEvent: ({ verb, action, actor, table, row, fields }) =>
      t("sentinel.forensics.auditEvent", {
        actor,
        verb: verb === "other" ? action : t(`sentinel.forensics.auditVerb.${verb}`),
        table,
        row,
        fieldsFrag: fields ? t("sentinel.forensics.auditFields", { fields }) : "",
      }),
    riskGhosts: (count) => ({
      area: t("sentinel.forensics.riskGhosts.area"),
      message: t("sentinel.forensics.riskGhosts.message", { count }),
    }),
    riskSequential: (count) => ({
      area: t("sentinel.forensics.riskSequential.area"),
      message: t("sentinel.forensics.riskSequential.message", { count }),
    }),
    riskDuplicates: (count) => ({
      area: t("sentinel.forensics.riskDuplicates.area"),
      message: t("sentinel.forensics.riskDuplicates.message", { count }),
    }),
    riskTraps: (count) => ({
      area: t("sentinel.forensics.riskTraps.area"),
      message: t("sentinel.forensics.riskTraps.message", { count }),
    }),
    riskBenford: () => ({
      area: t("sentinel.forensics.riskBenford.area"),
      message: t("sentinel.forensics.riskBenford.message"),
    }),
  };
}
