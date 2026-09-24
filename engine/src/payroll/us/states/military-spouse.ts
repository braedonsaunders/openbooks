/** Shared statutory eligibility guard for state military-spouse withholding exemptions. */
import { PayrollError } from "../../error.ts";
import { certificateFlag, type ResolvedCertificate } from "../../certificates.ts";

export interface MilitarySpouseEligibilityFact {
  /** The state certificate field that records this attestation or document. */
  key: string;
  /** Human-readable statutory fact or supporting record required by the form. */
  description: string;
}

/**
 * Apply a state military-spouse exemption only to a filed certificate that
 * affirmatively records each eligibility fact required by that state's form.
 * State forms have different evidence requirements, so callers provide the
 * form-specific facts while this guard owns the fail-closed behavior.
 */
export function requireMilitarySpouseEligibility(
  certificate: ResolvedCertificate,
  jurisdiction: string,
  facts: readonly MilitarySpouseEligibilityFact[],
): void {
  if (!certificate.onFile) {
    throw new PayrollError(
      `${jurisdiction} military-spouse withholding exemption requires the filed state exemption certificate`,
    );
  }
  const unmet = facts.filter((fact) => !certificateFlag(certificate, fact.key));
  if (unmet.length > 0) {
    throw new PayrollError(
      `${jurisdiction} military-spouse withholding exemption requires proof that `
      + unmet.map((fact) => fact.description).join("; "),
    );
  }
}
