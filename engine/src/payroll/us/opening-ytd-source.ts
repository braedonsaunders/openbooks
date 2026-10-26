import { PayrollError } from "../error.ts";
import { normalizeMoney } from "../../money/money.ts";
import type { readEmployeeOpeningLevySources } from "../opening-levy-source-reader.ts";
import { US_FICA_WAGES_ACCOUNT_BASE, US_FICA_WITHHELD_ACCOUNT_BASE } from "./opening-ytd.ts";

type OriginalOpening = Awaited<ReturnType<typeof readEmployeeOpeningLevySources>>;

function isUsOriginal(source: OriginalOpening): boolean {
  if (
    source.hasOpening &&
    source.hasMaterialHistory &&
    (!source.facts || !source.authority || !source.openingSnapshot || !source.openingChildren)
  ) {
    throw new PayrollError(
      "US opening amounts require the exact original country, legal employer and source report — qualify the original opening before calculating",
    );
  }
  return source.hasOpening && source.facts?.originalCountry === "US";
}

/** Only the explicitly named original EIN may consume an aggregate opening amount. */
export function usOpeningFieldForEin(
  source: OriginalOpening,
  federalAccountId: string | null,
  field: "pensionable_ytd" | "non_periodic_ytd" | "fica_withheld_ytd",
): string {
  if (!isUsOriginal(source)) return "0";
  const raw = source.openingSnapshot?.[field];
  if (typeof raw !== "string")
    throw new PayrollError(
      `The original ${field} opening is not an exact decimal — qualify its original source before calculating`,
    );
  const amount = normalizeMoney(raw);
  if (amount === "0.0000") return amount;
  const sameBase =
    field === "pensionable_ytd"
      ? US_FICA_WAGES_ACCOUNT_BASE
      : field === "fica_withheld_ytd"
        ? US_FICA_WITHHELD_ACCOUNT_BASE
        : null;
  if (
    sameBase &&
    source.openingChildren?.accountBases.some(
      (row) => row.program_key === sameBase && normalizeMoney(row.insurable_ytd) !== "0.0000",
    )
  ) {
    throw new PayrollError(
      "The original opening declares both aggregate and EIN-specific FICA amounts — retain one authoritative carry-in basis before calculating",
    );
  }
  const eins = [
    ...new Set(
      source.allocations
        .filter((row) => row.programKey === "us_futa")
        .map((row) => row.federalAccountId),
    ),
  ];
  if (eins.length !== 1 || !eins[0]) {
    throw new PayrollError(
      "An aggregate US opening amount has no unique original EIN. Retain its original report and qualify EIN-specific carry-in amounts before calculating",
    );
  }
  return eins[0] === federalAccountId ? amount : "0";
}

/** Per-EIN sources are read from the sealed original children, not mutable current account rows. */
export function usOpeningAccountBaseForEin(
  source: OriginalOpening,
  federalAccountId: string | null,
  programKey: typeof US_FICA_WAGES_ACCOUNT_BASE | typeof US_FICA_WITHHELD_ACCOUNT_BASE,
): string {
  if (!isUsOriginal(source)) return "0";
  const rows =
    source.openingChildren?.accountBases.filter(
      (row) =>
        row.program_key === programKey &&
        row.filing_account_id === federalAccountId &&
        row.region === null,
    ) ?? [];
  if (rows.length > 1)
    throw new PayrollError(
      "The original US per-EIN opening account source is ambiguous — reconcile the source before calculating",
    );
  return rows.length ? normalizeMoney(rows[0]!.insurable_ytd) : "0";
}

/** W-2 opening-only slips require a qualified original US legal employer. */
export function requireUsW2OpeningSource(
  source: OriginalOpening,
): asserts source is OriginalOpening & {
  facts: NonNullable<OriginalOpening["facts"]>;
  authority: NonNullable<OriginalOpening["authority"]>;
} {
  if (!source.facts || source.facts.originalCountry !== "US" || !source.authority) {
    throw new PayrollError(
      "The original W-2 opening country and legal employer are unknown — qualify the original opening source before preparing slips",
    );
  }
}
