import { canonicalNonNegativeDecimal } from "../../money/exact-decimal.ts";
import { cmp, normalizeMoney, sum } from "../../money/money.ts";
import { isUuid } from "../../platform/uuid.ts";
import { parseIsoDate } from "../../platform/civil-date.ts";
import { PayrollError } from "../error.ts";
import { RATES_2026_JAN } from "./rates.ts";
import type { OriginalOpeningSourceChildren } from "../opening-levy-source-reader.ts";

const PROVINCES = new Set([
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
  "ZZ",
]);
const QUEBEC_COLUMNS = new Set([
  "qpip_ytd",
  "qpip_employer_ytd",
  "qc_tax_ytd",
  "qc_csb_ytd",
  "ca_avg_qpip",
  "ca_avg_bonus_qpip",
]);

/** Catalogues come from native opening-field, component, program and account reads. */
export type CanadianOpeningReportingCatalogue = {
  annualFields: readonly { column: string; packs: readonly string[] }[];
  components: readonly { id: string; country: string | null }[];
  programs: readonly { programKey: string; country: string; provinces?: readonly string[] }[];
  filingAccounts: readonly {
    id: string;
    orgId: string;
    subsidiaryId: string | null;
    country: string;
    programType: string;
    name?: string;
    accountNumber?: string;
  }[];
};

export type CanadianOpeningReportingOriginal = {
  orgId: string;
  subsidiaryId: string;
  originalCountry: string;
  originalCurrency: string;
  coverageStart: string;
  coverageEnd: string;
  annualAmounts: Readonly<Record<string, string>>;
  children: OriginalOpeningSourceChildren;
};

/** Explicit zeros distinguish a complete original allocation from missing history. */
export type CanadianOpeningReportingAllocation = {
  sourceOrdinal: number;
  firstCoveredPayDate: string;
  filingAccountId: string;
  province: string;
  annualAmounts: Record<string, string>;
  /** Original reported capped bases, retained per RP/province rather than inferred from group order. */
  reportableBases: { ei: string; cpp: string; qpip: string };
  children: OriginalOpeningSourceChildren;
};

/** Allocation inputs carry economic identities and amounts; sealed source rows retain their storage and audit metadata. */
export function openingReportingAllocationChildren(
  source: OriginalOpeningSourceChildren,
): OriginalOpeningSourceChildren {
  return {
    components: source.components.map(({ component_id, ytd_amount }) => ({
      component_id,
      ytd_amount,
    })),
    programBases: source.programBases.map(({ program_key, insurable_ytd }) => ({
      program_key,
      insurable_ytd,
    })),
    accountBases: source.accountBases.map(
      ({ program_key, filing_account_id, region, insurable_ytd }) => ({
        program_key,
        filing_account_id,
        region,
        insurable_ytd,
      }),
    ),
    suiStates: source.suiStates.map(({ state, insurable_ytd }) => ({ state, insurable_ytd })),
  };
}

function refuse(message: string): never {
  throw new PayrollError(
    `${message}. Review the retained original report in Payroll → Opening balances → Reporting source`,
  );
}

function amount(value: unknown, label: string): string {
  if (canonicalNonNegativeDecimal(value, 4) === null) {
    refuse(
      `${label} requires an explicit non-negative exact decimal with at most four decimal places`,
    );
  }
  return normalizeMoney(value as string);
}

function object<T>(value: T): value is T & Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys<T>(
  value: T,
  keys: readonly string[],
  label: string,
): asserts value is T & Record<string, unknown> {
  if (
    !object(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    refuse(
      `${label} must contain every original field, including explicit zeros, and no additional fields`,
    );
  }
}

function accountKey(row: OriginalOpeningSourceChildren["accountBases"][number]): string {
  return JSON.stringify([row.program_key, row.filing_account_id, row.region]);
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function indexed<T>(rows: readonly T[], key: (row: T) => string, label: string): Map<string, T> {
  if (!Array.isArray(rows)) refuse(`${label} is unavailable`);
  const result = new Map<string, T>();
  for (const row of rows) {
    if (!object(row)) refuse(`${label} contains an invalid original identity`);
    const identity = key(row);
    if (result.has(identity)) refuse(`${label} contains a duplicate original identity`);
    result.set(identity, row);
  }
  return result;
}

function reconcile<T>(
  originals: readonly T[],
  allocations: readonly (readonly T[])[],
  key: (row: T) => string,
  read: (row: T) => string,
  label: string,
): void {
  const original = indexed(originals, key, label);
  const partitions = allocations.map((rows) => indexed(rows, key, label));
  if (
    partitions.some(
      (rows) =>
        rows.size !== original.size || [...rows.keys()].some((identity) => !original.has(identity)),
    )
  ) {
    refuse(`${label} must allocate every original identity exactly, including explicit zeros`);
  }
  for (const [identity, row] of original) {
    if (
      cmp(
        amount(read(row), `${label} original`),
        sum(partitions.map((rows) => read(rows.get(identity)!))),
      ) !== 0
    ) {
      refuse(`${label} allocations do not equal the exact original amount for ${identity}`);
    }
  }
}

/**
 * Preserve the entire original opening across source-declared RP/province slices.
 * The caller supplies an authenticated original source and native catalogues;
 * this function never consults an employee profile or chooses an allocation.
 */
export function canonicalCanadianOpeningReportingAllocations(
  original: CanadianOpeningReportingOriginal,
  input: readonly CanadianOpeningReportingAllocation[],
  catalogue: CanadianOpeningReportingCatalogue,
): CanadianOpeningReportingAllocation[] {
  if (
    !isUuid(original.orgId) ||
    !isUuid(original.subsidiaryId) ||
    original.originalCountry !== "CA" ||
    original.originalCurrency !== "CAD"
  ) {
    refuse("Resolve the source-qualified original Canadian legal employer and currency");
  }
  if (!Array.isArray(input) || input.length === 0)
    refuse("Declare every original Canadian RP and province allocation");
  try {
    parseIsoDate(original.coverageStart);
    parseIsoDate(original.coverageEnd);
  } catch {
    refuse("The original reporting coverage requires valid calendar dates");
  }
  if (original.coverageEnd < original.coverageStart)
    refuse("The original reporting coverage is reversed");
  const fields = indexed(
    catalogue.annualFields,
    (row) => row.column,
    "Native annual field catalogue",
  );
  if (fields.size === 0) refuse("The native original annual field catalogue is unavailable");
  const fieldKeys = [...fields.keys()].sort();
  exactKeys(original.annualAmounts, fieldKeys, "Original annual amounts");
  for (const [column, field] of fields) {
    const value = amount(original.annualAmounts[column], `Original ${column}`);
    if (!field.packs.includes("CA") && cmp(value, "0") !== 0)
      refuse(`Original ${column} belongs to another statutory country`);
  }
  exactKeys(
    original.children,
    ["components", "programBases", "accountBases", "suiStates"],
    "Original opening children",
  );
  const components = indexed(catalogue.components, (row) => row.id, "Native component catalogue");
  const programs = indexed(catalogue.programs, (row) => row.programKey, "Native program catalogue");
  const accounts = indexed(
    catalogue.filingAccounts,
    (row) => row.id,
    "Native filing account catalogue",
  );
  const seen = new Set<string>();
  const ordinals = new Set<number>();
  const result = input.map((raw) => {
    exactKeys(
      raw,
      [
        "sourceOrdinal",
        "firstCoveredPayDate",
        "filingAccountId",
        "province",
        "annualAmounts",
        "reportableBases",
        "children",
      ],
      "Reporting allocation",
    );
    if (
      !Number.isSafeInteger(raw.sourceOrdinal) ||
      raw.sourceOrdinal < 1 ||
      raw.sourceOrdinal > 2147483647 ||
      ordinals.has(raw.sourceOrdinal)
    )
      refuse("Every original reporting allocation requires a unique positive source ordinal");
    ordinals.add(raw.sourceOrdinal);
    try {
      parseIsoDate(raw.firstCoveredPayDate);
    } catch {
      refuse(
        "Every original reporting allocation requires its source-attested first covered pay date",
      );
    }
    if (
      raw.firstCoveredPayDate < original.coverageStart ||
      raw.firstCoveredPayDate > original.coverageEnd
    ) {
      refuse("The original first covered pay date must be inside the certified original coverage");
    }
    if (!isUuid(raw.filingAccountId) || !PROVINCES.has(raw.province))
      refuse("Declare the original native RP account and province");
    const account = accounts.get(raw.filingAccountId);
    if (
      !account ||
      account.orgId !== original.orgId ||
      account.country !== "CA" ||
      account.programType !== "ca_rp" ||
      account.subsidiaryId !== original.subsidiaryId
    ) {
      refuse(
        "Bind the original Canadian RP to its source-qualified legal employer in Payroll Setup → Filing accounts",
      );
    }
    const identity = JSON.stringify([raw.filingAccountId, raw.province]);
    if (seen.has(identity))
      refuse("Each original RP and province requires one reporting allocation");
    seen.add(identity);
    exactKeys(raw.annualAmounts, fieldKeys, "Allocated annual amounts");
    const annualAmounts: Record<string, string> = {};
    for (const column of fieldKeys) {
      annualAmounts[column] = amount(raw.annualAmounts[column], `Allocated ${column}`);
      if (
        raw.province !== "QC" &&
        QUEBEC_COLUMNS.has(column) &&
        cmp(annualAmounts[column]!, "0") !== 0
      ) {
        refuse(`${column} requires original Québec employment`);
      }
    }
    exactKeys(
      raw.children,
      ["components", "programBases", "accountBases", "suiStates"],
      "Allocated opening children",
    );
    const canonicalRows = <T>(
      rows: readonly T[],
      key: (row: T) => string,
      canonical: (row: T) => T,
      label: string,
    ): T[] =>
      [...indexed(rows, key, label).values()]
        .map(canonical)
        .sort((a, b) => compareKeys(key(a), key(b)));
    const programAmount = (key: string, value: unknown, label: string): string => {
      const program = programs.get(key);
      if (!program || program.country !== "CA")
        refuse(`${label} has an unknown or foreign original statutory program`);
      const normalized = amount(value, label);
      if (
        program.provinces &&
        !program.provinces.includes(raw.province) &&
        cmp(normalized, "0") !== 0
      ) {
        refuse(`${label} requires its original program jurisdiction`);
      }
      return normalized;
    };
    const children: OriginalOpeningSourceChildren = {
      components: canonicalRows(
        raw.children.components,
        (row) => row.component_id,
        (row) => {
          exactKeys(row, ["component_id", "ytd_amount"], "Allocated component");
          const component = components.get(row.component_id);
          if (
            !isUuid(row.component_id) ||
            !component ||
            (component.country !== null && component.country !== "CA")
          ) {
            refuse(
              "The original component must resolve to a native Canadian or common payroll component",
            );
          }
          return {
            component_id: row.component_id,
            ytd_amount: amount(row.ytd_amount, "Allocated component amount"),
          };
        },
        "Component allocations",
      ),
      programBases: canonicalRows(
        raw.children.programBases,
        (row) => row.program_key,
        (row) => {
          exactKeys(row, ["program_key", "insurable_ytd"], "Allocated program base");
          return {
            program_key: row.program_key,
            insurable_ytd: programAmount(
              row.program_key,
              row.insurable_ytd,
              "Allocated program base",
            ),
          };
        },
        "Program base allocations",
      ),
      accountBases: canonicalRows(
        raw.children.accountBases,
        accountKey,
        (row) => {
          exactKeys(
            row,
            ["program_key", "filing_account_id", "region", "insurable_ytd"],
            "Allocated account base",
          );
          const value = programAmount(row.program_key, row.insurable_ytd, "Allocated account base");
          const originalAccount = accounts.get(row.filing_account_id);
          if (
            !isUuid(row.filing_account_id) ||
            !originalAccount ||
            originalAccount.orgId !== original.orgId ||
            originalAccount.subsidiaryId !== original.subsidiaryId ||
            originalAccount.country !== "CA" ||
            originalAccount.programType !== "ca_rp" ||
            (row.region !== null && !PROVINCES.has(row.region))
          ) {
            refuse("The original account base requires a native RP and original province");
          }
          if (
            cmp(value, "0") !== 0 &&
            (row.filing_account_id !== raw.filingAccountId ||
              (row.region !== null && row.region !== raw.province))
          ) {
            refuse(
              "An account-specific original base cannot be reassigned to another RP or province",
            );
          }
          return {
            program_key: row.program_key,
            filing_account_id: row.filing_account_id,
            region: row.region,
            insurable_ytd: value,
          };
        },
        "Account base allocations",
      ),
      suiStates: canonicalRows(
        raw.children.suiStates,
        (row) => row.state,
        (row) => {
          exactKeys(row, ["state", "insurable_ytd"], "Allocated state unemployment base");
          const value = amount(row.insurable_ytd, "Allocated state unemployment base");
          if (cmp(value, "0") !== 0)
            refuse("A Canadian original source cannot contain US state unemployment wages");
          return { state: row.state, insurable_ytd: value };
        },
        "State unemployment allocations",
      ),
    };
    exactKeys(raw.reportableBases, ["ei", "cpp", "qpip"], "Original reportable bases");
    const reportableBases = {
      ei: amount(raw.reportableBases.ei, "Original reportable EI base"),
      cpp: amount(raw.reportableBases.cpp, "Original reportable CPP/QPP base"),
      qpip: amount(raw.reportableBases.qpip, "Original reportable QPIP base"),
    };
    const rawBases = {
      ei: annualAmounts.insurable_ytd ?? "0",
      cpp: annualAmounts.pensionable_ytd ?? "0",
      qpip: sum(
        children.programBases
          .filter((row) => row.program_key === "qpip")
          .map((row) => row.insurable_ytd),
      ),
    };
    for (const key of ["ei", "cpp", "qpip"] as const) {
      if (cmp(reportableBases[key], rawBases[key]) > 0)
        refuse(`Original reported ${key} base exceeds its exact allocated earnings`);
    }
    if (raw.province !== "QC" && cmp(reportableBases.qpip, "0") !== 0)
      refuse("Original reported QPIP requires Québec employment");
    return {
      reportableBases,
      sourceOrdinal: raw.sourceOrdinal,
      firstCoveredPayDate: raw.firstCoveredPayDate,
      filingAccountId: raw.filingAccountId,
      province: raw.province,
      annualAmounts,
      children,
    };
  });
  for (const column of fieldKeys) {
    if (
      cmp(sum(result.map((row) => row.annualAmounts[column]!)), original.annualAmounts[column]!) !==
      0
    ) {
      refuse(`Reporting allocations do not equal the exact original ${column}`);
    }
  }
  reconcile(
    original.children.components,
    result.map((row) => row.children.components),
    (row) => row.component_id,
    (row) => row.ytd_amount,
    "Component",
  );
  reconcile(
    original.children.programBases,
    result.map((row) => row.children.programBases),
    (row) => row.program_key,
    (row) => row.insurable_ytd,
    "Program base",
  );
  reconcile(
    original.children.accountBases,
    result.map((row) => row.children.accountBases),
    accountKey,
    (row) => row.insurable_ytd,
    "Account base",
  );
  reconcile(
    original.children.suiStates,
    result.map((row) => row.children.suiStates),
    (row) => row.state,
    (row) => row.insurable_ytd,
    "State unemployment",
  );
  result.sort((a, b) => a.sourceOrdinal - b.sourceOrdinal);
  if (
    result.some(
      (row, index) => index > 0 && row.firstCoveredPayDate < result[index - 1]!.firstCoveredPayDate,
    )
  ) {
    refuse("The original source ordinal must preserve first covered pay date chronology");
  }
  const year = Number(original.coverageStart.slice(0, 4));
  if (year !== 2026) refuse("The original reporting year has no declared Canadian annual maxima");
  const originalBases = {
    ei: original.annualAmounts.insurable_ytd ?? "0",
    cpp: original.annualAmounts.pensionable_ytd ?? "0",
    qpip: sum(
      original.children.programBases
        .filter((row) => row.program_key === "qpip")
        .map((row) => row.insurable_ytd),
    ),
  };
  const caps = {
    ei: RATES_2026_JAN.ei.mie,
    cpp: RATES_2026_JAN.cpp.yampe,
    qpip: RATES_2026_JAN.qpip.mie,
  };
  for (const key of ["ei", "cpp", "qpip"] as const) {
    const expected = cmp(originalBases[key], caps[key]) > 0 ? caps[key] : originalBases[key];
    if (cmp(sum(result.map((row) => row.reportableBases[key])), expected) !== 0) {
      refuse(
        `Original reported ${key} bases must reconcile exactly to the declared annual maximum and original earnings`,
      );
    }
  }
  return result;
}
