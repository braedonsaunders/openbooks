/**
 * ie-payroll-live shard: the Ireland pack transcribes 2026 (PAYE credits and
 * bands, Class A PRSI, standard USC), computes through compute.ts, and keeps
 * its named refusals for everything outside the transcribed scope.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IE_PAYROLL_PACK } from "./pack.ts";
import {
  jurisdictionKey,
  payrollJurisdictionDeclared,
} from "../packs.ts";
import { undeclaredJurisdictionHolidayConflict } from "../holidays.ts";

describe("IE payroll pack", () => {
  it("exists, is Irish, and is installable for 2026", () => {
    assert.equal(IE_PAYROLL_PACK.country, "IE");
    assert.equal(IE_PAYROLL_PACK.installable, true);
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
    // The PAYE component is Ireland-qualified (ie_paye): pay_components is
    // unique on (org, code) and (org, system key, kind), so the bare
    // PAYE/paye identity the GB pack seeds would swallow the IE row in an
    // org running both packs.
    assert.deepEqual(systems, ["ie_paye", "prsi", "prsi", "usc"]);
    const codes = IE_PAYROLL_PACK.statutorySlots.flatMap((slot) =>
      slot.components.map((component) => component.code),
    );
    assert.deepEqual(codes, ["IEPAYE", "PRSI", "PRSI-ER", "USC"]);
    assert.ok(
      IE_PAYROLL_PACK.statutorySlots.every((slot) =>
        slot.components.every((component) => component.remittance === "tax_authority"),
      ),
      "every IE component remits to the Revenue vendor",
    );
    assert.equal(IE_PAYROLL_PACK.remittanceVendorSettingsKey, "revenueRemittancePartyId");
  });

  it("supports the single national region end to end", () => {
    assert.ok(IE_PAYROLL_PACK.regions.known.includes("IE"));
    assert.deepEqual([...IE_PAYROLL_PACK.regions.supported], ["IE"]);
    assert.match(
      IE_PAYROLL_PACK.regions.unsupportedReason,
      /single national payroll region/,
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
      "prior_cumulative_pay",
      "prior_cumulative_usc",
      "prior_cumulative_tax",
    ]) {
      assert.ok(fields.has(key), `RPN declares ${key}`);
    }
  });

  it("declares the withholding region as implemented", () => {
    const declared = IE_PAYROLL_PACK.withholding();
    assert.equal(declared.country, "IE");
    assert.equal(declared.regions.length, 1);
    const [region] = declared.regions;
    assert.ok(region, "IE withholding region declared");
    assert.equal(region.region, "IE");
    assert.equal(region.implemented, true);
  });

  it("declares two published 2026 editions (January + October PRSI step)", () => {
    const editions = [...IE_PAYROLL_PACK.taxYears.editions];
    assert.equal(editions.length, 2);
    assert.ok(editions.every((edition) => edition.year === 2026));
    assert.ok(editions.every((edition) => edition.status === "published"));
    assert.deepEqual(
      editions.map((edition) => edition.effectiveFrom),
      ["2026-01-01", "2026-10-01"],
    );
    assert.equal(IE_PAYROLL_PACK.taxYears.ratesModule, "engine/src/payroll/ie/rates.ts");
    assert.ok(IE_PAYROLL_PACK.taxYears.scaffold.steps.length > 0);
  });

  it("declares a Revenue filing program and the reconciliation, not a return", () => {
    const filings = IE_PAYROLL_PACK.filings();
    assert.equal(filings.country, "IE");
    const [program] = filings.programTypes;
    assert.ok(program, "IE filing program declared");
    assert.equal(program.key, "ie_paye");
    // One filing: the annual reconciliation. No employer slip exists to
    // declare (P60 abolished 1 January 2019), so the declaration carries no
    // slip — the absence states the abolition (see ./filings.ts).
    assert.equal(filings.yearEnd.length, 1);
    const [filing] = filings.yearEnd;
    assert.ok(filing, "IE reconciliation filing declared");
    assert.equal(filing.key, "paye-reconciliation");
    assert.equal(filing.cadence, "annual");
    assert.equal(filing.slip, undefined);
    assert.equal(typeof filing.population, "function");
    assert.equal(typeof filing.parseRowId, "function");
    assert.ok((filing.downloadRefusal ?? "").length > 0, "no file without a named reason");
    assert.equal(filing.amendment.supported, false);
  });

  it("declares the ten public holidays with a cited s.21 edition", () => {
    const [jurisdiction] = IE_PAYROLL_PACK.jurisdictions;
    assert.ok(jurisdiction, "IE jurisdiction declared");
    assert.equal(jurisdiction.key, "IE-IE");
    assert.equal(jurisdiction.scope, "employment");
    assert.equal(jurisdiction.holidays.length, 10);
    assert.ok(jurisdiction.holidayPay !== null && jurisdiction.holidayPay.length === 1);
  });

  it("profile jurisdiction resolves to a declared employment calendar", () => {
    // The profile always names the single national region, so the engine
    // resolves jurisdictionKey("IE", "IE") = "IE-IE". A bare "IE" key
    // declares a calendar no employee reaches, and the undeclared-jurisdiction
    // gate then refuses every period containing a mandatory holiday (proven:
    // a January 2026 run refused over New Year's Day before the key fix).
    assert.equal(jurisdictionKey("IE", "IE"), "IE-IE");
    assert.equal(payrollJurisdictionDeclared("IE-IE"), true);
    assert.equal(
      undeclaredJurisdictionHolidayConflict({
        country: "IE",
        jurisdiction: "IE-IE",
        from: "2026-01-01",
        to: "2026-01-31",
      }),
      null,
    );
  });

  it("refuses a run with no pay date, and emergency basis with no RPN", async () => {
    const stub = (overrides: Record<string, unknown>) =>
      ({
        tx: {
          execute: async () => ({ rows: [{ tax: "0", usc: "0", taxbase: "0", gross: "0" }] }),
        },
        orgId: "org",
        documentId: "doc",
        employeePartyId: "emp",
        taxYear: 2026,
        region: "IE",
        run: {},
        emp: {},
        periodsPerYear: 52,
        income: "850.00",
        nonPeriodic: "0",
        pensionable: "850.00",
        insurable: "850.00",
        deduction: () => "0",
        pushStatutory: () => undefined,
        certificateFor: () => null,
        assertRegionSupported: () => undefined,
        ...overrides,
      }) as never;
    await assert.rejects(IE_PAYROLL_PACK.computeStatutory(stub({})), /no pay date/);
    await assert.rejects(
      IE_PAYROLL_PACK.computeStatutory(stub({ run: { pay_date: "2026-03-15" } })),
      /Emergency Tax/,
    );
  });
});
