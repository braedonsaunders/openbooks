import assert from "node:assert/strict";
import test from "node:test";
import {
  PAYROLL_COUNTRY_PACKS,
  packWarnsOnMissingIdentifier,
  validatePackEmployeeIdentifier,
} from "./packs.ts";

/**
 * The employee identifier each country pack declares, proven opener-first:
 * the profile API used to strip every non-digit and demand exactly nine,
 * which mangled every alphanumeric identifier and refused every non-9-digit
 * one. Every pack below answers with its authority's own length and
 * character shape, and the generic validator judges the value AS GIVEN.
 */

const accepted: Readonly<Record<string, readonly string[]>> = {
  // The four that stored by accident of being nine digits — the regression.
  CA: ["046454286"],
  US: ["123456789", "123-45-6789"],
  NL: ["111222333"],
  AU: ["123456782"],
  // The ten the old validator refused.
  GB: ["QQ123456C", "QQ 12 34 56 C"],
  IE: ["1234567T", "1234567TW"],
  DE: ["12345678901"],
  FR: ["254022A03300522", "185022B03300522"],
  ES: ["12345678Z", "X1234567L"],
  IT: ["RSSMRA85T10A562S"],
  SG: ["S1234567D", "M1234567K"],
  JP: ["123456789012"],
  PL: ["44051401359"],
  BR: ["12345678909", "123.456.789-09"],
};

test("every pack accepts its real identifier formats", () => {
  for (const [country, values] of Object.entries(accepted)) {
    for (const value of values) {
      const verdict = validatePackEmployeeIdentifier(country, value);
      assert.equal(verdict.valid, true, `${country} must accept ${value}: ${verdict.message}`);
    }
  }
});

test("a Corsican NIR validates with its 2A/2B department intact", () => {
  const north = validatePackEmployeeIdentifier("FR", "254022A03300522");
  assert.equal(north.valid, true, `2A NIR must validate: ${north.message}`);
  assert.equal(north.saved, "254022A03300522");
  const south = validatePackEmployeeIdentifier("FR", "185022B03300522");
  assert.equal(south.valid, true, `2B NIR must validate: ${south.message}`);
  // Lowercase is presentation, not identity.
  const lower = validatePackEmployeeIdentifier("FR", "254022a03300522");
  assert.equal(lower.valid, true, `lowercase 2a NIR must validate: ${lower.message}`);
  assert.equal(lower.saved, "254022A03300522");
});

test("a value that is valid only after stripping is refused, not transformed", () => {
  // Each of these becomes valid under the OLD strip-then-judge validator
  // (or under the pack's own pattern once separators are removed) and must
  // be refused as given. The French case is the corruption: the stripped
  // form is not merely invalid, it is a DIFFERENT number from the Corsican
  // NIR it came from.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["US", "12345 6789"],
    ["CA", "046-454-286"],
    ["GB", "QQ-123456-C"],
    ["FR", "25402203300522"],
    ["US", "QQ123456C"],
    ["DE", "1234567890A"],
  ];
  for (const [country, value] of cases) {
    const verdict = validatePackEmployeeIdentifier(country, value);
    assert.equal(verdict.valid, false, `${country} must refuse ${value} as given`);
    assert.ok(
      verdict.message?.includes(PAYROLL_COUNTRY_PACKS[country]!.employeeIdentifier.label),
      `${country} refusal must name the pack's own label: ${verdict.message}`,
    );
  }
  // The corruption, pinned: stripping the valid Corsican NIR yields a
  // 14-digit value that is refused AND differs from the stored form.
  const intact = validatePackEmployeeIdentifier("FR", "254022A03300522");
  const stripped = "254022A03300522".replace(/\D/g, "");
  assert.equal(intact.valid, true);
  assert.notEqual(stripped, intact.saved);
  assert.equal(validatePackEmployeeIdentifier("FR", stripped).valid, false);
});

test("an empty value clears and never refuses, whatever the pack requires", () => {
  // Saves never block onboarding behind an identifier the operator does not
  // have yet: required-ness is enforced by the year-end and run-readiness
  // warnings, not by the save. Every pack clears on empty.
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    for (const empty of ["", "   ", null]) {
      const verdict = validatePackEmployeeIdentifier(country, empty);
      assert.equal(verdict.valid, true, `${country} must accept an empty identifier`);
      assert.equal(verdict.saved, null, `${country} empty must clear`);
    }
  }
});

test("every registered pack declares a usable identifier", () => {
  const countries = Object.keys(PAYROLL_COUNTRY_PACKS);
  assert.ok(countries.length >= 14, `expected at least 14 packs, saw ${countries.length}`);
  for (const country of countries) {
    const declaration = PAYROLL_COUNTRY_PACKS[country]!.employeeIdentifier;
    for (const field of ["label", "pattern", "formatHelp", "example", "citation"] as const) {
      assert.ok(
        typeof declaration[field] === "string" && declaration[field].length > 0,
        `${country} identifier must declare a non-empty ${field}`,
      );
    }
    let expression: RegExp;
    try {
      expression = new RegExp(`^(?:${declaration.pattern})$`);
    } catch {
      assert.fail(`${country} identifier pattern does not compile: ${declaration.pattern}`);
    }
    assert.match(
      declaration.example.toUpperCase(),
      expression!,
      `${country} example must satisfy its own pattern`,
    );
  }
});

test("the missing-identifier warning gate follows the declaration", () => {
  // Packs that require the identifier AND name a filing that needs it warn.
  for (const country of ["CA", "US", "GB", "DE", "FR", "ES", "IT", "NL", "SG", "JP", "PL", "BR"]) {
    assert.equal(packWarnsOnMissingIdentifier(country), true, `${country} must warn`);
  }
  // No filing to feed: silent. Voluntary identifier: silent. Unknown: silent.
  assert.equal(packWarnsOnMissingIdentifier("IE"), false, "IE declares no filing that needs one");
  assert.equal(packWarnsOnMissingIdentifier("AU"), false, "AU quoting is voluntary");
  assert.equal(packWarnsOnMissingIdentifier("XX"), false, "unknown countries warn about nothing");
});
