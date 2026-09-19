import assert from "node:assert/strict";
import test from "node:test";
import { packCertificates } from "./certificates.ts";
import { PAYROLL_COUNTRY_PACKS } from "./packs.ts";

/**
 * A profile renders only its own pack's withholding certificates.
 *
 * Observed: a French payroll profile rendering German ELStAM fields in its
 * certificates section. The render paths (EmployeesPanel's
 * `applicableCertificates`, PackCertificateForms' `declarations[country]`)
 * are pack-scoped — this pins the registry side of that contract: no two
 * packs declare the same certificate key, so one pack's form can never be
 * another pack's.
 */
test("no certificate key is declared by two country packs", () => {
  const owners = new Map<string, string>();
  const collisions: string[] = [];
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    for (const certificate of packCertificates(country).certificates) {
      const owner = owners.get(certificate.key);
      if (owner !== undefined && owner !== country) {
        collisions.push(`${certificate.key} declared by ${owner} and ${country}`);
      } else {
        owners.set(certificate.key, country);
      }
    }
  }
  assert.deepEqual(collisions, [], "certificates shared across packs");
});

test("the French pack declares no German ELStAM certificate", () => {
  const keys = packCertificates("FR").certificates.map((certificate) => certificate.key);
  assert.ok(!keys.some((key) => key.startsWith("de_")), `FR declares ${keys.join(", ")}`);
});
