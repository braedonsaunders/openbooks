/**
 * Localizable sentence templates for Sentinel ledger forensics.
 *
 * Same pattern as the other analytics bundles: `englishSentinelStrings` is
 * the exact legacy English copy (direct callers — unit tests, assistant
 * tools — keep byte-identical output); `sentinelStrings(t)` builds the
 * catalog-backed bundle from `getTranslations('analytics')` in the request
 * locale. Entity names, document numbers and trap digits travel verbatim as
 * ICU string params (they are data); counts travel as numbers into ICU
 * plurals. Benford conformity itself is a stable CODE
 * (excellent/acceptable/marginal/nonConforming) in every language — the
 * request-scoped dashboard maps codes to words, so forensic payloads never
 * compare against translated text.
 */

import type { CatalogMessageFn } from "./catalog-strings";

export type ConformityCode = "excellent" | "acceptable" | "marginal" | "nonConforming";

export interface SentinelRiskArea {
  area: string;
  message: string;
}

export interface SentinelStrings {
  locale: string;
  /** Map the SQL `coalesce(…, 'Unknown')` sentinel (or blank) to the request language. */
  displayPartyName(name: string | null): string;
  benfordInsufficient(total: number): string;
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
   * One-line audit-trail summary (F-t09-006): who did what to which record.
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
 * Assemble the locale-free arguments for an audit-trail summary (F-t09-006).
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

/**
 * Exact English sentences, byte-identical to the `en` catalog rendering for
 * every input (ICU `one`/`other` plurals included). Direct callers — the
 * data loader default, unit tests, assistant tools — keep stable output
 * without a request locale; the parity test below pins this.
 */
export const englishSentinelStrings: SentinelStrings = {
  locale: "en",
  displayPartyName: (name) => (name === null || name === "" || name === "Unknown" ? "Unknown" : name),
  benfordInsufficient: (total) => `Insufficient data (${total} transaction${total === 1 ? "" : "s"}). Need at least 50.`,
  benfordClose: "Transaction amounts closely follow Benford's Law — low manipulation risk.",
  benfordReasonable: "Transaction amounts reasonably follow Benford's Law.",
  benfordSomeDeviation: "Some deviation detected — warrants review.",
  benfordSignificant: "Significant deviation — possible manipulation.",
  trapReason: (trap) => `Amount ends in ${trap} (potential threshold avoidance)`,
  weekendReason: (sunday) => `Dated on ${sunday ? "Sunday" : "Saturday"}`,
  rsfReason: (multiple, vendor, currency) => `${multiple}× larger than ${vendor}'s historical 2nd largest (${currency})`,
  zscoreReason: (z, vendor, currency, baseline) =>
    `Z-score ${z} vs ${vendor} ${currency} average (${baseline} transaction${baseline === 1 ? "" : "s"})`,
  sequentialReason: (count, first, last, days, high, currency) =>
    `${count} gap-free sequential ${currency} invoice${count === 1 ? "" : "s"} (${first}–${last}) over ${days} day${days === 1 ? "" : "s"}${high ? " — possible shell company / sole customer" : ""}`,
  ghostBoth: (vendor, employee) => `Vendor "${vendor}" matches employee "${employee}" by BOTH name and street address`,
  ghostAddress: (vendor, employee) => `Vendor "${vendor}" shares a street address with employee "${employee}"`,
  ghostName: (vendor, employee) => `Vendor "${vendor}" matches employee name "${employee}"`,
  duplicateGroupReason: ({ count, currency, amount, sharedReference, daysSpan, others }) =>
    `${count} matching document${count === 1 ? "" : "s"} — same vendor, kind, amount (${currency} ${amount})${sharedReference ? `, shared reference ${sharedReference}` : ""} (${daysSpan} day${daysSpan === 1 ? "" : "s"} span): ${others}`,
  auditEvent: ({ verb, action, actor, table, row, fields }) =>
    `${actor} ${verb === "other" ? action : verb === "created" ? "created" : verb === "updated" ? "updated" : "deleted"} ${table} ${row}${fields ? ` (${fields})` : ""}`,
  riskGhosts: (count) => ({ area: "Ghost Vendors", message: `${count} vendor${count === 1 ? "" : "s"} match employee names` }),
  riskSequential: (count) => ({ area: "Sequential Invoices", message: `${count} vendor${count === 1 ? "" : "s"} with gap-free invoice runs` }),
  riskDuplicates: (count) => ({ area: "Duplicate Payments", message: `${count} duplicate group${count === 1 ? "" : "s"} (one finding per group)` }),
  riskTraps: (count) => ({ area: "Approval Limit Avoidance", message: `${count} amount${count === 1 ? "" : "s"} ending 99/999/9999` }),
  riskBenford: () => ({ area: "Benford Deviation", message: "First-digit distribution deviates significantly" }),
};

/** Catalog-backed bundle: every sentence renders in the request locale. */
export function sentinelStrings(t: CatalogMessageFn, locale: string): SentinelStrings {
  return {
    locale,
    displayPartyName: (name) =>
      name === null || name === "" || name === "Unknown" ? t("sentinel.forensics.unknownParty") : name,
    benfordInsufficient: (total) => t("sentinel.forensics.benfordInsufficient", { total }),
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
