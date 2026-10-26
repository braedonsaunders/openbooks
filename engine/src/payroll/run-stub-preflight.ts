import { db } from "../platform/db.ts";
import { packRates, PayrollPackError, type EmployeePayrollContext } from "./packs.ts";
import { assertConfiguredStatutoryRates, type StatutoryRateResolution } from "./statutory-rates.ts";
import {
  payrollCertificate,
  resolveCertificate,
  revalidateStoredCertificates,
  type ResolvedCertificate,
} from "./certificates.ts";
import type { installablePackOrThrow } from "./run-stub-records.ts";

/**
 * Stub preflight: the statutory rates a pack requires must be configured before
 * any money is computed, and each stub resolves its declared certificates once.
 */

type StubPack = ReturnType<typeof installablePackOrThrow>;

export async function assertPackStatutoryRatesConfigured(args: {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  pack: StubPack;
  country: string;
  taxYear: number;
  province: string;
  jurisdiction: EmployeePayrollContext;
  run: Record<string, string>;
  employeePartyId: string;
  displayName: string;
  statutoryRatesFor: (country: string, taxYear: number) => Promise<StatutoryRateResolution>;
}): Promise<void> {
  const {
    tx,
    orgId,
    pack,
    country,
    taxYear,
    province,
    jurisdiction,
    run,
    employeePartyId,
    displayName,
  } = args;
  const { statutoryRatesFor } = args;
  // ---- Live-but-unconfigured `refuse` slots stop the employee BY NAME -----
  // BEFORE any money is computed: a misconfiguration (rates on file, none
  // resolving for this employee's region and assigned filing account) must be
  // loud, because a silent zero still balances. The sentence is the readiness
  // detector's own — the run and the warning cannot disagree. Packs with no
  // rate declaration, or none declaring `refuse`, cost no query here.
  let packRefuses = false;
  try {
    packRefuses = packRates(country).slots.some((slot) => slot.whenUnconfigured === "refuse");
  } catch (error) {
    if (!(error instanceof PayrollPackError)) throw error;
  }
  if (packRefuses) {
    const resolution = await statutoryRatesFor(country, taxYear);
    // A pack-recorded waiver stands its slots down from the requirement (US
    // SUI for a recorded non-contributory account, which prices no SUI).
    // Nothing recorded waives nothing, so every other scope point keeps
    // today's gate byte-for-byte.
    const waived = pack.waivedRateSlots
      ? await pack.waivedRateSlots(tx, {
          orgId,
          region: province,
          filingAccountId: jurisdiction.filingAccountId,
          payDate: run.pay_date!,
          employeePartyId,
          subsidiaryId: run.doc_subsidiary_id ?? null,
        })
      : [];
    assertConfiguredStatutoryRates(
      waived.length === 0
        ? resolution
        : { ...resolution, slots: resolution.slots.filter((slot) => !waived.includes(slot.key)) },
      { region: province, filingAccountId: jurisdiction.filingAccountId },
      displayName,
    );
  }
}

/**
 * Resolves each declared certificate for one stub against the filings stored for
 * the employee, the employee's profile and the pay date.
 */
export function createStubCertificateResolver(args: {
  country: string;
  storedCertificates: ReturnType<typeof revalidateStoredCertificates>["valid"];
  emp: Record<string, unknown>;
  payDate: string | undefined;
}): (key: string) => ResolvedCertificate | null {
  const { country, storedCertificates, emp } = args;
  const payDate = args.payDate;
  return (key: string): ResolvedCertificate | null => {
    let declared;
    try {
      declared = payrollCertificate(country, key);
    } catch {
      return null;
    }
    return resolveCertificate({
      certificate: declared,
      stored: storedCertificates,
      profile: emp,
      asOf: payDate,
    });
  };
}
