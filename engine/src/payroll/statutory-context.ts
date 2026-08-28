import type { db } from "../db.ts";
import type { ResolvedCertificate, StoredCertificate } from "./certificates.ts";
import type { PayrollAssessedOn } from "./packs.ts";

/** One line in the stub set `calculateStub` builds before the statutory pass. */
export interface StubLine {
  componentId: string | null;
  kind: "earning" | "deduction" | "employer_contribution";
  description: string;
  hours?: string;
  rate?: string;
  amount: string;
  projectId?: string | null;
  departmentId?: string | null;
  timeTypeId?: string | null;
  sequence: number;
  taxable?: boolean;
  pensionable?: boolean;
  insurable?: boolean;
  vacationable?: boolean;
  nonPeriodic?: boolean;
  taxTreatment?: string;
  accrualOnly?: boolean;
  assessedOn?: PayrollAssessedOn;
  classification?: string;
  protectionBase?: string;
  protectionMaxPercent?: string | null;
  protectionPriority?: number;
  includeInDisposableEarnings?: boolean;
}

export interface StatutoryAllocation {
  amount: string;
  projectId?: string | null;
  departmentId?: string | null;
}

export type PushStatutoryFn = (
  systemKey: string,
  kind: "deduction" | "employer_contribution",
  description: string,
  amount: string,
  sequence: number,
  options?: { allocations?: readonly StatutoryAllocation[] },
) => void;

/** Phase-8 employer levy factors consumed by the pack's statutory pass. */
export interface PayrollEmployerLevyFactors {
  wcbAmount: string;
  wcbAssessable: string;
  ehtAmount: string;
  ehtEarnings: string;
}

export const EMPTY_EMPLOYER_LEVY_FACTORS: PayrollEmployerLevyFactors = {
  wcbAmount: "0",
  wcbAssessable: "0",
  ehtAmount: "0",
  ehtEarnings: "0",
};

/** Phase 8 — pack-declared earnings-assessed employer levies (WCB/EHT for CA). */
export interface PayrollEmployerLevyContext {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  documentId: string;
  employeePartyId: string;
  employeeName: string;
  taxYear: number;
  region: string;
  lines: readonly StubLine[];
  pushStatutory: PushStatutoryFn;
}

/** Phase 9 — one re-runnable statutory pass over the current line set. */
export interface PayrollStatutoryComputeContext {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  documentId: string;
  employeePartyId: string;
  employeeName: string;
  taxYear: number;
  country: string;
  region: string;
  run: Record<string, string>;
  emp: Record<string, string | null>;
  filingAccountId: string | null;
  periodsPerYear: number;
  /** Employee headcount of the paying employer, isolated to its legal entity. */
  employerEmployeeCount?: number;
  income: string;
  nonPeriodic: string;
  pensionable: string;
  insurable: string;
  deduction: (treatment: string) => string;
  pushStatutory: PushStatutoryFn;
  storedCertificates: readonly StoredCertificate[];
  certificateFor: (key: string) => ResolvedCertificate | null;
  bool: (value: string | null | undefined) => boolean;
  /** Bound by `calculateStub` — the pack refuses unsupported regions itself. */
  assertRegionSupported: (region: string) => void;
  employerLevies: PayrollEmployerLevyFactors;
}
