import type { PayrollFilingFile } from "./filing-registry.ts";

/**
 * Labor-compliance files and construction carve-outs — pack declarations
 * consumed generically (HR-13, payroll-lane conditions thr_umg5eqccin).
 *
 * Doctrine: packs DECLARE, the generic layer branches on NOTHING. These
 * are statutory FILES, sibling to filings downloads and bank files — not
 * "reports" (the report engine is the only report), so the field is
 * `laborComplianceFiles` and builders return PayrollFilingFile
 * ({ filename, contentType, body }). No country-code inference anywhere:
 * the generic layer lists whatever the pack declares and REFUSES BY NAME
 * when it declares none. Absent === empty === refuse-by-name, documented
 * here the way reciprocity documents its own absence: a pack with no
 * labor-compliance concept declares nothing, and "declares nothing" is a
 * statement the generic layer honors, never a gap it fills.
 *
 * A SECOND, SEPARATELY NAMED refusal covers a missing feature context
 * (the HRM construction feature off): pack-has-none and feature-off are
 * never collapsed into one message.
 *
 * Every figure transcribed from a statute carries its `citation` on the
 * rule it belongs to — nothing here is a policy choice, a default, or a
 * convenience. Present implies non-empty: a present declaration with zero
 * entries describes nothing and fails the conformance test in
 * ./labor-compliance.test.ts.
 *
 * Year dimension: the figures below are STANDING LAW with no tax-year
 * dimension. A future change is expressed as a NEW effective-dated entry
 * in the same list — never an edit in place — so a prior-period
 * correction resolves the entry that stood on its date.
 *
 * Type-only import from ./filing-registry.ts (erased at runtime): that
 * module value-imports ./packs.ts, so a value import here would close a
 * module-evaluation cycle. The builders below likewise import TYPES ONLY
 * from the pack interface.
 */
export class LaborComplianceBuildError extends Error {}

/** One frozen worker/classification/day row the generic layer resolved. */
export interface LaborComplianceReportRow {
  employmentId: string;
  displayName: string;
  classificationCode: string;
  classificationName: string;
  /** Worked day, YYYY-MM-DD. */
  day: string;
  hours: string;
  baseRate: string;
  fringeCash: string;
  fringeCredit: string;
  deductions: string;
  net: string;
  /** Where the rate came from — prevailing, union, org, home_local, jobsite_local, higher_of. */
  rateSource: string;
}

/**
 * The typed context a builder receives. Deterministic and pure: no DB
 * handle, no clock, no environment — the generic layer passes everything
 * the file needs, including the generation instant, so the same context
 * always builds the same bytes. Money travels as canonical decimal
 * strings (money.ts on the generic side); builders never parse floats.
 */
export interface LaborComplianceReportContext {
  orgName: string;
  projectName: string | null;
  projectReference: string | null;
  /** Week ending, YYYY-MM-DD. */
  weekEnding: string;
  /** Generation instant, ISO — supplied by the caller, never read from a clock inside. */
  generatedAt: string;
  rows: readonly LaborComplianceReportRow[];
}

/**
 * One pack-declared labor-compliance file. The pack's own vocabulary
 * lives in `label` (a federal weekly form name, a state XML name); the
 * shared interface stays neutral so the packs with no such concept carry
 * no foreign words. Form keys live once, here.
 */
export interface LaborComplianceFileFormat {
  /** Stable per-pack key, stored on the run row. */
  key: string;
  /** Pack-vocabulary label shown to the operator. */
  label: string;
  /**
   * Render the frozen payload. THROWS LaborComplianceBuildError naming
   * the person or field AND a remedy that exists when a truthful file
   * cannot be produced — a file the authority silently rejects is worse
   * than a refusal, so partial files are never returned and no hour or
   * rate is silently dropped.
   */
  build: (ctx: LaborComplianceReportContext) => PayrollFilingFile;
}

/** Closed construction carve-out shapes — one field per concept, citation required. */
export type PackConstructionRule =
  | {
      kind: "vacation_pay_in_lieu";
      region: string;
      /** Decimal percent string, e.g. "4". */
      percent: string;
      citation: string;
      /** Standing-law entry start, YYYY-MM-DD; supersede by adding, never editing. */
      effectiveFrom: string;
    }
  | {
      kind: "holiday_pay_in_lieu";
      region: string;
      percent: string;
      citation: string;
      effectiveFrom: string;
    }
  | {
      kind: "termination_notice_exemption";
      region: string;
      sector: string;
      citation: string;
      effectiveFrom: string;
    }
  | {
      kind: "overtime_threshold";
      region: string;
      sector: string;
      dailyHours: number;
      weeklyHours: number;
      citation: string;
      effectiveFrom: string;
    }
  | {
      kind: "premium_class";
      region: string;
      classCode: string;
      className: string;
      ratePer100: string | null;
      citation: string;
      effectiveFrom: string;
    }
  | {
      kind: "remittance_component";
      componentKey: string;
      purpose: string;
      citation: string;
      effectiveFrom: string;
    }
  | {
      kind: "interruption_insurable_hours";
      includes: readonly ("paid_vacation" | "stat_holiday" | "sick")[];
      citation: string;
      effectiveFrom: string;
    };

/** A pack's construction carve-outs: statute/carve-out DATA only, non-empty when present. */
export interface PayrollPackConstruction {
  rules: readonly PackConstructionRule[];
}

/** Generic reader: the construction rules of a pack declaration, optionally narrowed to a region. */
export function constructionRulesFor(
  construction: PayrollPackConstruction | undefined,
  region?: string,
): readonly PackConstructionRule[] {
  if (!construction) return [];
  if (!region) return construction.rules;
  return construction.rules.filter(
    (rule) => !("region" in rule) || rule.region === region,
  );
}

/**
 * Generic reader: the files a pack declaration offers. LAZY like
 * filings/certificates (the builders sit beside the pack's engine
 * modules, so the declaration must not be dereferenced at
 * module-evaluation time) — absent === empty, and the generic layer
 * refuses generation by name in both cases.
 */
export function laborComplianceFilesFor(declaration: {
  laborComplianceFiles?: () => readonly LaborComplianceFileFormat[];
}): readonly LaborComplianceFileFormat[] {
  return declaration.laborComplianceFiles?.() ?? [];
}
