/**
 * Shared harness for the state withholding CONFORMANCE goldens.
 *
 * Every conformance file asserts figures transcribed from an agency's own
 * worked example, and every file used to re-declare the same two helpers to
 * do it: the numeric(19,4) canonicalizer the engines' results are asserted
 * against, and a certificate resolved from stored answers exactly as the
 * run-time path builds one. Thirty-odd private copies of load-bearing test
 * arithmetic are drift waiting to happen — a change to one copy silently
 * changes what every golden in that file asserts. Both helpers live here,
 * once.
 */
import {
  resolveCertificate,
  type PayrollCertificate,
  type ResolvedCertificate,
} from "../../certificates.ts";

/** numeric(19,4) canonical form, as the engines return. */
export function money(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
}

/**
 * A certificate resolved from STORED answers, exactly as the run-time path
 * builds it.
 */
export function resolvedCertificate(
  certificate: PayrollCertificate,
  answers: Record<string, string> = {},
): ResolvedCertificate {
  return resolveCertificate({
    certificate,
    stored: [{ certificateKey: certificate.key, answers, effectiveFrom: null }],
  });
}
