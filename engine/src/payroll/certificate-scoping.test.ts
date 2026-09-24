import assert from "node:assert/strict";
import test from "node:test";
import {
  packCertificates, regionWithholdingCertificate, revalidateStoredCertificates,
  type StoredCertificate,
} from "./certificates.ts";
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

/**
 * A jurisdiction's claim-identity rule lives in the pack, not in a
 * `country === "CA" && region === "QC"` literal in a shared route. These pin
 * the declaration the profile API branches on, and the invariant that an
 * amount jurisdiction declares no claim-code field the engine never reads.
 */
test("Québec declares an amount claim; the other provinces declare a code", () => {
  assert.equal(regionWithholdingCertificate("CA", "QC")?.claimIdentity, "amount");
  assert.equal(regionWithholdingCertificate("CA", "ON")?.claimIdentity, "code");
  assert.equal(regionWithholdingCertificate("CA", "QC")?.form, "TP-1015.3-V");
});

test("an amount jurisdiction declares no claim-code column field", () => {
  const offenders: string[] = [];
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    for (const certificate of packCertificates(country).certificates) {
      if (certificate.claimIdentity !== "amount") continue;
      for (const field of certificate.fields) {
        if (field.storage?.kind === "column" && field.storage.column === "provincial_claim_code") {
          offenders.push(`${certificate.key}.${field.key}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], "an amount jurisdiction offered a claim-code field");
});

/* --------------------------------------------------------------------- */
/* Read-path scope revalidation (C-19)                                    */
/* --------------------------------------------------------------------- */

const stored = (over: Partial<StoredCertificate> & { certificateKey: string }): StoredCertificate => ({
  answers: { resident_state: "PA" },
  effectiveFrom: "2026-01-01",
  ...over,
});

test("a certificate filed for the employee's own region stays valid", () => {
  // NJ-165 is scoped to NJ; the employee works in NJ and resides in PA.
  const { valid, mismatched } = revalidateStoredCertificates({
    stored: [stored({ certificateKey: "us_nj_nj165", region: "NJ" })],
    country: "US", workRegion: "NJ", residenceRegion: "PA",
  });
  assert.deepEqual(mismatched, []);
  assert.equal(valid.length, 1);
});

test("a legacy mis-scoped certificate is ignored AND named", () => {
  // Filed before the POST route's profile check: an IT-2104 row stamped for
  // California. Key membership alone would let it drive New York's table.
  const { valid, mismatched } = revalidateStoredCertificates({
    stored: [stored({ certificateKey: "us_ny_it2104", region: "CA" })],
    country: "US", workRegion: "CA", residenceRegion: "CA",
  });
  assert.deepEqual(valid, []);
  assert.equal(mismatched.length, 1);
  assert.match(mismatched[0]!.message, /IT-2104/);
  assert.match(mismatched[0]!.message, /ignored/);
});

test("a certificate for the old region after a move is not honoured", () => {
  // REV-419 is scoped to PA. The employee moved to Ohio since filing (now
  // works in OH, resides in NJ): the form no longer matches either side, so
  // it cannot relieve Ohio — and the gap says to correct the profile or file
  // the new region's form.
  const { valid, mismatched } = revalidateStoredCertificates({
    stored: [stored({ certificateKey: "us_pa_rev419", region: "PA" })],
    country: "US", workRegion: "OH", residenceRegion: "NJ",
  });
  assert.deepEqual(valid, []);
  assert.equal(mismatched.length, 1);
  assert.match(mismatched[0]!.message, /REV-419/);
  assert.match(mismatched[0]!.message, /now works in OH and resides in NJ/);
});

test("a row for a certificate the pack never declared is ignored AND named", () => {
  const { valid, mismatched } = revalidateStoredCertificates({
    stored: [stored({ certificateKey: "us_no_such_form", region: "PA" })],
    country: "US", workRegion: "PA", residenceRegion: "NJ",
  });
  assert.deepEqual(valid, []);
  assert.equal(mismatched.length, 1);
  assert.match(mismatched[0]!.message, /us_no_such_form/);
});

test("an unscoped legacy row on a scoped certificate is not honoured", () => {
  // Rows predate the jurisdiction point: a null region on a region-scoped
  // form proves nothing about where it was filed, so it fails closed.
  const { valid, mismatched } = revalidateStoredCertificates({
    stored: [stored({ certificateKey: "us_nj_nj165", region: null })],
    country: "US", workRegion: "NJ", residenceRegion: "PA",
  });
  assert.deepEqual(valid, []);
  assert.equal(mismatched.length, 1);
  assert.match(mismatched[0]!.message, /NJ-165/);
});
