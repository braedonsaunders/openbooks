/**
 * ie-payroll shard: the Ireland skeleton pack declares its slots, region,
 * RPN certificate and named 2026 refusals — and nothing else.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IE_PAYROLL_PACK } from "./pack.ts";

describe("IE payroll skeleton pack", () => {
  it("exists, is Irish, and is not installable", () => {
    assert.equal(IE_PAYROLL_PACK.country, "IE");
    assert.equal(IE_PAYROLL_PACK.installable, false);
    assert.equal(IE_PAYROLL_PACK.statutoryCurrency, "EUR");
    assert.equal(IE_PAYROLL_PACK.statutoryEngineLabel, "PAYE");
  });

  it("runs on the calendar tax year", () => {
    assert.deepEqual(IE_PAYROLL_PACK.taxYear, {
      basis: "calendar",
      startMonth: 1,
      startDay: 1,
      namedBy: "opening_year",
    });
  });

  it("declares the PAYE, PRSI and USC slots", () => {
    const keys = IE_PAYROLL_PACK.statutorySlots.map((slot) => slot.key);
    assert.deepEqual(keys, ["paye", "prsi", "usc"]);
    const systems = IE_PAYROLL_PACK.statutorySlots.flatMap((slot) =>
      slot.components.map((component) => component.systemKey),
    );
    assert.deepEqual(systems, ["paye", "prsi", "prsi", "usc"]);
    assert.ok(
      IE_PAYROLL_PACK.statutorySlots.every((slot) =>
        slot.components.every((component) => component.remittance === "tax_authority"),
      ),
      "every IE component remits to the Revenue vendor",
    );
    assert.equal(IE_PAYROLL_PACK.remittanceVendorSettingsKey, "revenueRemittancePartyId");
  });

  it("lists the national region and refuses it by name", () => {
    assert.ok(IE_PAYROLL_PACK.regions.known.includes("IE"));
    assert.deepEqual([...IE_PAYROLL_PACK.regions.supported], []);
    assert.match(
      IE_PAYROLL_PACK.regions.unsupportedReason,
      /not implemented by the IE payroll pack/,
    );
  });

  it("declares the RPN certificate, not a W-4 clone", () => {
    const declared = IE_PAYROLL_PACK.certificates();
    assert.equal(declared.country, "IE");
    assert.equal(declared.certificates.length, 1);
    const [rpn] = declared.certificates;
    assert.ok(rpn, "RPN certificate declared");
    assert.equal(rpn.form, "RPN");
    assert.equal(rpn.key, "ie_rpn");
    assert.equal(rpn.storage, "certificate_rows");
    const fields = new Set(rpn.fields.map((field) => field.key));
    for (const key of [
      "tax_credits_total",
      "rate_band_total",
      "pay_basis",
      "usc_cutoff_total",
      "usc_exempt",
    ]) {
      assert.ok(fields.has(key), `RPN declares ${key}`);
    }
  });

  it("declares the withholding region as unimplemented", () => {
    const declared = IE_PAYROLL_PACK.withholding();
    assert.equal(declared.country, "IE");
    assert.equal(declared.regions.length, 1);
    const [region] = declared.regions;
    assert.ok(region, "IE withholding region declared");
    assert.equal(region.region, "IE");
    assert.equal(region.implemented, false);
    assert.match(region.unimplementedReason ?? "", /2026/);
  });

  it("refuses the untranscribed 2026 tax year by name", () => {
    assert.deepEqual([...IE_PAYROLL_PACK.taxYears.editions], []);
    assert.equal(IE_PAYROLL_PACK.taxYears.ratesModule, "engine/src/payroll/ie/rates.ts");
    assert.ok(IE_PAYROLL_PACK.taxYears.scaffold.steps.length > 0);
  });

  it("declares a Revenue filing program and no annual return", () => {
    const filings = IE_PAYROLL_PACK.filings();
    assert.equal(filings.country, "IE");
    const [program] = filings.programTypes;
    assert.ok(program, "IE filing program declared");
    assert.equal(program.key, "ie_paye");
    assert.deepEqual([...filings.yearEnd], []);
  });

  it("declares the ten public holidays with a cited s.21 edition", () => {
    const [jurisdiction] = IE_PAYROLL_PACK.jurisdictions;
    assert.ok(jurisdiction, "IE jurisdiction declared");
    assert.equal(jurisdiction.key, "IE");
    assert.equal(jurisdiction.scope, "employment");
    assert.equal(jurisdiction.holidays.length, 10);
    assert.ok(jurisdiction.holidayPay !== null && jurisdiction.holidayPay.length === 1);
  });

  it("refuses any statutory computation by name", async () => {
    await assert.rejects(
      IE_PAYROLL_PACK.computeStatutory({} as never),
      /no transcribed statutory tables/,
    );
  });
});
