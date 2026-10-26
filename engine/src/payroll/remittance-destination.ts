import { isIsoCalendarDate } from "../platform/business-date.ts";
import {
  PAYROLL_COUNTRY_PACKS,
  statutoryRemittanceDeclaration,
  type StatutoryRemittanceDeclaration,
} from "./packs.ts";

/** Remittance destination resolution: who an accrual remits to, shared by summary and bill creation. */

/**
 * The narrow row shape destination resolution reads — shared by the summary
 * (which folds grouped rows) and bill creation (which resolves individual
 * accrual lines for coverage), so the two can never disagree about who an
 * accrual remits to.
 */
export interface RemittanceResolvableRow {
  /** The stub line's commit-time destination snapshot (migration 0296). */
  snapshotPartyId: string | null;
  /**
   * The component's CURRENT remittance vendor. Runs committed before a
   * vendor was assigned carry a null snapshot; their unremitted liabilities
   * resolve against this live assignment instead of surfacing unassigned.
   */
  componentPartyId: string | null;
  /**
   * The live (non-voided) remittance bill that consumed this line, or null
   * while the liability is unremitted. A consumed line keeps its bill's
   * vendor as history even when the component is reassigned afterwards;
   * voiding the bill frees the line back to live resolution.
   */
  coveredPartyId: string | null;
  systemKey: string | null;
  country: string | null;
  province: string;
}

/**
 * Destination resolution over commit-time snapshots, extracted so the summary
 * and the bill creator share one implementation. Country-first pack lookup
 * (two packs may give the same withholding the same system key, so the
 * country stamped on the component row picks the pack), exactly as the
 * summary always resolved.
 */
export function makeRemittanceDestinationResolver(payrollSettings: Record<string, unknown>): {
  resolveDestination: (row: RemittanceResolvableRow) => {
    partyId: string | null;
    vendorKey: string | null;
  };
  isInternalAccrual: (row: Pick<RemittanceResolvableRow, "systemKey" | "country">) => boolean;
} {
  const declarations = new Map<string, StatutoryRemittanceDeclaration | null>();
  const declarationFor = (country: string | null): StatutoryRemittanceDeclaration | null => {
    if (!country) return null;
    const hit = declarations.get(country);
    if (hit !== undefined) return hit;
    const found = PAYROLL_COUNTRY_PACKS[country] ? statutoryRemittanceDeclaration(country) : null;
    declarations.set(country, found);
    return found;
  };
  const settingsVendor = (settingsKey: string): string | null => {
    const vendor = payrollSettings[settingsKey];
    return typeof vendor === "string" && vendor ? vendor : null;
  };
  return {
    resolveDestination: (row) => {
      const packDeclaration = row.systemKey ? declarationFor(row.country) : null;
      const regionalKey = row.systemKey
        ? packDeclaration?.regionalVendorSettingsKeyBySystemKey.get(row.systemKey)?.[row.province]
        : undefined;
      // The regional key is provenance even when the org has not configured
      // the vendor yet: an unconfigured RQ destination is still an RQ
      // destination — it surfaces unassigned under the RQ schedule, never
      // under the CRA one.
      if (regionalKey) return { partyId: settingsVendor(regionalKey), vendorKey: regionalKey };
      // The SNAPSHOT, never the live component: a vendor stamped at commit
      // cannot be re-pointed by editing the component afterwards.
      if (row.snapshotPartyId) return { partyId: row.snapshotPartyId, vendorKey: null };
      // A line an issued remittance bill consumed keeps that bill's vendor
      // as its history, even when the component was assigned (or reassigned)
      // after the bill. Unremitted lines never reach this branch.
      if (row.coveredPartyId) return { partyId: row.coveredPartyId, vendorKey: null };
      const vendorKey = row.systemKey
        ? packDeclaration?.vendorSettingsKeyBySystemKey.get(row.systemKey)
        : undefined;
      if (!vendorKey) {
        // No pack declaration for this component: unremitted liabilities
        // resolve against the component's current vendor (runs committed
        // before the assignment carry a null snapshot); genuinely
        // vendorless rows stay unassigned for setup.
        if (row.componentPartyId) return { partyId: row.componentPartyId, vendorKey: null };
        return { partyId: null, vendorKey: null };
      }
      const configured = settingsVendor(vendorKey);
      if (configured) return { partyId: configured, vendorKey };
      // The pack declares the destination but the org never configured its
      // vendor: the component's own vendor answers instead, keeping the pack
      // key as schedule provenance so the declared timetable still dates
      // the bill. Without a component vendor the row stays unassigned under
      // the pack key, exactly as before.
      if (row.componentPartyId) return { partyId: row.componentPartyId, vendorKey };
      return { partyId: null, vendorKey };
    },
    isInternalAccrual: (row) =>
      row.systemKey != null &&
      (declarationFor(row.country)?.internalAccrualSystemKeys.includes(row.systemKey) ?? false),
  };
}

/**
 * The period's own validity, before any row is read. Shape alone admits
 * impossible dates ('2026-02-30', month 13) that PostgreSQL then refuses
 * with a driver error instead of a named refusal — so the range is proven a
 * real calendar date pair first, at every entry point that accepts one.
 * Pure, so the rule is verifiable without a database.
 */
export function remittancePeriodProblem(from: unknown, to: unknown): string | null {
  if (!isIsoCalendarDate(from)) {
    return `invalid from (YYYY-MM-DD calendar date required) — got ${JSON.stringify(from) ?? "nothing"}`;
  }
  if (!isIsoCalendarDate(to)) {
    return `invalid to (YYYY-MM-DD calendar date required) — got ${JSON.stringify(to) ?? "nothing"}`;
  }
  if (to < from) {
    return `from "${from}" is after to "${to}" — the period must start on or before it ends`;
  }
  return null;
}
