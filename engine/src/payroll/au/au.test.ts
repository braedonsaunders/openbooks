/**
 * AU payroll skeleton pack: the pack exists, names its slots, lists its
 * regions, declares its certificates, and refuses every untranscribed year
 * by name.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollPackError } from "../packs.ts";
import { computeAuStatutory } from "./compute-statutory.ts";
import { auPackFilings } from "./filings.ts";
import { AU_CERTIFICATES, AU_KNOWN_REGIONS, AU_WITHHOLDING } from "./jurisdictions.ts";
import { AU_PAYROLL_PACK } from "./pack.ts";
import { AU_PACK_RATES, AU_TAX_YEARS } from "./rates.ts";

test("AU pack exists and is a non-installable skeleton", () => {
  assert.equal(AU_PAYROLL_PACK.country, "AU");
  assert.equal(AU_PAYROLL_PACK.installable, false);
  assert.equal(AU_PAYROLL_PACK.statutoryCurrency, "AUD");
  assert.deepEqual(AU_PAYROLL_PACK.taxYear, {
    basis: "fiscal",
    startMonth: 7,
    startDay: 1,
    namedBy: "closing_year",
  });
  assert.equal(AU_PAYROLL_PACK.statutoryEngineLabel, "PAYG withholding");
  assert.equal(AU_PAYROLL_PACK.remittanceVendorSettingsKey, "atoRemittancePartyId");
});

test("AU statutory slots name PAYG withholding, super and workers comp", () => {
  const keys = AU_PAYROLL_PACK.statutorySlots.map((slot) => slot.key);
  assert.deepEqual(keys, ["payg", "super", "wcb"]);
  const byKey = new Map(AU_PAYROLL_PACK.statutorySlots.map((slot) => [slot.key, slot]));
  const payg = byKey.get("payg")?.components[0];
  assert.equal(payg?.code, "PAYG");
  assert.equal(payg?.assessedOn, "taxable_income");
  assert.equal(payg?.remittance, "tax_authority");
  const sg = byKey.get("super")?.components[0];
  assert.equal(sg?.code, "SG");
  assert.equal(sg?.kind, "employer_contribution");
  assert.equal(sg?.remittance, "external");
});

test("AU regions list every state and territory and refuse each by name", () => {
  assert.deepEqual([...AU_KNOWN_REGIONS], [
    "NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT",
  ]);
  assert.deepEqual(AU_PAYROLL_PACK.regions.known, AU_KNOWN_REGIONS);
  assert.deepEqual(AU_PAYROLL_PACK.regions.supported, []);
  assert.match(
    AU_PAYROLL_PACK.regions.unsupportedReason.replace("{region}", "NSW"),
    /PAYG withholding for NSW is not implemented/,
  );
});

test("AU certificates declare the TFN declaration, not a W-4 clone", () => {
  assert.equal(AU_CERTIFICATES.country, "AU");
  assert.equal(AU_CERTIFICATES.certificates.length, 1);
  const [tfn] = AU_CERTIFICATES.certificates;
  assert.equal(tfn?.form, "TFN declaration");
  assert.notEqual(tfn?.form, "W-4");
  assert.notEqual(tfn?.form, "TD1");
  assert.match(tfn?.citation ?? "", /NAT 3092/);
  const fields = new Map((tfn?.fields ?? []).map((field) => [field.key, field]));
  assert.equal(fields.get("tax_free_threshold")?.kind, "flag");
  assert.equal(fields.get("stsl_debt")?.kind, "flag");
  assert.equal(fields.get("residency")?.kind, "choice");
  assert.equal(AU_PAYROLL_PACK.certificates(), AU_CERTIFICATES);
});

test("AU withholding refuses every region and levies no state income tax", () => {
  assert.equal(AU_WITHHOLDING.country, "AU");
  assert.deepEqual(
    AU_WITHHOLDING.regions.map((region) => region.region),
    AU_KNOWN_REGIONS,
  );
  for (const region of AU_WITHHOLDING.regions) {
    assert.equal(region.implemented, false);
    assert.match(region.unimplementedReason ?? "", /Schedule 1/);
    assert.equal(region.residentWithholding, "none");
  }
  assert.equal(AU_PAYROLL_PACK.withholding(), AU_WITHHOLDING);
});

test("AU tax years refuse 2025–26 and 2026–27 by name as drafts", () => {
  assert.equal(AU_TAX_YEARS.country, "AU");
  const byYear = new Map(AU_TAX_YEARS.editions.map((edition) => [edition.year, edition]));
  assert.equal(byYear.get(2026)?.status, "draft");
  assert.equal(byYear.get(2027)?.status, "draft");
  assert.equal(byYear.get(2026)?.effectiveFrom, "2025-07-01");
  assert.equal(AU_PAYROLL_PACK.taxYears, AU_TAX_YEARS);
  assert.equal(AU_PACK_RATES.country, "AU");
  assert.equal(AU_PAYROLL_PACK.statutoryRates, AU_PACK_RATES);
});

test("AU statutory engine refuses the requested year by name", async () => {
  await assert.rejects(
    () =>
      computeAuStatutory({
        taxYear: 2027,
      } as Parameters<typeof computeAuStatutory>[0]),
    (error: unknown) => {
      assert.ok(error instanceof PayrollPackError);
      assert.match((error as Error).message, /tax year 2027 has not been transcribed/);
      return true;
    },
  );
});

test("AU filings declare STP with an annual finalisation", async () => {
  const filings = auPackFilings();
  assert.equal(filings.country, "AU");
  assert.deepEqual(
    filings.programTypes.map((program) => program.key),
    ["ato_stp"],
  );
  assert.equal(filings.yearEnd.length, 1);
  assert.equal(filings.yearEnd[0]?.cadence, "annual");
  await assert.rejects(() => filings.yearEnd[0]?.population("org", 2026), PayrollPackError);
  const packFilings = AU_PAYROLL_PACK.filings();
  assert.equal(packFilings.country, "AU");
  assert.deepEqual(
    packFilings.yearEnd.map((filing) => filing.key),
    ["stp_finalisation"],
  );
});
