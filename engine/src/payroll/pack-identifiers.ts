/** Pack employee-identifier validation. Split from packs.ts (ARCH-FILE-SPLIT; pure moves only). */
import { type EmployeeIdentifierVerdict } from "./pack-types"
import { PAYROLL_COUNTRY_PACKS, payrollPack } from "./pack-registry"

/**
 * Judge one raw identifier value against one country's pack declaration.
 *
 * The value is validated AS GIVEN: outer whitespace is trimmed and Latin
 * letters uppercased (presentation, not identity — `2a` and `2A` are the
 * same Corsican department), then tested whole against the pack's pattern.
 * Nothing is ever stripped first: an input that would become valid only
 * after stripping (a dashed NINO for the US, a de-lettered NIR for France)
 * is refused, not silently transformed.
 *
 * Empty (absent, null, or blank) always clears — or keeps, when the key is
 * omitted — and never refuses: whether the pack REQUIRES one is enforced by
 * the year-end and run-readiness warnings (`packWarnsOnMissingIdentifier`),
 * not by refusing the save, so onboarding is never blocked behind an
 * identifier the operator does not have yet. The refusal message names the
 * pack's own label and shape, so a format 422 is worth showing wherever it
 * surfaces.
 */
export function validatePackEmployeeIdentifier(
  country: string,
  raw: unknown,
): EmployeeIdentifierVerdict {
  const pack = payrollPack(country);
  const declaration = pack.employeeIdentifier;
  const canonical = raw === null || raw === undefined ? "" : String(raw).trim().toUpperCase();
  if (canonical === "") {
    return { valid: true, saved: null, message: null };
  }
  let expression: RegExp;
  try {
    expression = new RegExp(`^(?:${declaration.pattern})$`);
  } catch {
    return {
      valid: false,
      saved: null,
      message: `${pack.country} payroll pack declares an invalid identifier pattern`,
    };
  }
  if (!expression.test(canonical)) {
    return {
      valid: false,
      saved: null,
      message: `Invalid ${declaration.label}: expected ${declaration.formatHelp} (e.g. ${declaration.example})`,
    };
  }
  if (declaration.validator && !declaration.validator.validate(canonical)) {
    return {
      valid: false,
      saved: null,
      message: `Invalid ${declaration.label}: ${declaration.validator.refusalReason}`,
    };
  }
  return { valid: true, saved: canonical, message: null };
}

/**
 * Whether the missing-identifier warnings (the year-end agent finding and
 * the run-readiness `employee.noSin`) fire for a country's employees: only
 * when the pack declares the identifier REQUIRED and names a filing that
 * needs it. A pack with no filing to feed, or with a voluntary identifier,
 * warns about nothing — including for a filing the pack otherwise refuses,
 * where the identifier is still needed. Unknown countries warn about
 * nothing: an undeclared pack cannot need an identifier.
 */
export function packWarnsOnMissingIdentifier(country: string): boolean {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) return false;
  const declaration = pack.employeeIdentifier;
  return declaration.requiredForPayroll && declaration.neededFor !== null;
}
