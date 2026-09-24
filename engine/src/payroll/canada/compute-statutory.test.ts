import assert from "node:assert/strict";
import test from "node:test";
import { cmp } from "../../money/money.ts";
import {
  certificateAnswersProblem, payrollCertificate, resolveCertificate, type StoredCertificate,
} from "../certificates.ts";
import "../packs.ts";
import { computeCaStatutory } from "./compute-statutory.ts";

const certificate = payrollCertificate("CA", "ca_td1_ON");

function certificateRow(answers: Record<string, string>): StoredCertificate {
  return {
    certificateKey: certificate.key,
    region: "ON",
    subRegion: null,
    answers,
    effectiveFrom: "2026-01-01",
    supersededOn: null,
  };
}

async function ontarioIncomeTax(row?: StoredCertificate): Promise<{ incomeTax: string; factors: Record<string, string> }> {
  const resolved = resolveCertificate({
    certificate,
    stored: row ? [row] : [],
    profile: { federal_claim_code: "1", provincial_claim_code: "1" },
    asOf: "2026-02-13",
  });
  let incomeTax = "";
  const factors = await computeCaStatutory({
    tx: {
      execute: async () => ({
        rows: [{
          pensionable: "0", insurable: "0", cpp: "0", cpp2: "0", ei: "0", qpip: "0",
          qpip_employer: "0", non_periodic: "0", f5b: "0", qc_csb: "0",
        }],
      }),
    } as never,
    orgId: "org",
    documentId: "run",
    employeePartyId: "employee",
    employeeName: "Test Employee",
    taxYear: 2026,
    country: "CA",
    region: "ON",
    run: { pay_date: "2026-02-13" },
    emp: { federal_claim_code: "1", provincial_claim_code: "1" },
    filingAccountId: null,
    periodsPerYear: 26,
    income: "1100.0000",
    nonPeriodic: "0.0000",
    pensionable: "1100.0000",
    insurable: "1100.0000",
    deduction: () => "0.0000",
    pushStatutory: (slot: string, _kind: string, _label: string, amount: string) => {
      if (slot === "income_tax") incomeTax = amount;
    },
    storedCertificates: row ? [row] : [],
    certificateFor: (key: string) => key === certificate.key ? resolved : null,
    bool: () => false,
    assertRegionSupported: () => undefined,
    employerLevies: {
      wcbAmount: "0", wcbAssessable: "0", ehtAmount: "0", ehtEarnings: "0",
      hsfAmount: "0", hsfEarnings: "0",
    },
  } as never);
  assert.notEqual(incomeTax, "", "the statutory pass emits Ontario income tax");
  return { incomeTax, factors };
}

test("Ontario withholding uses effective TD1ON dependant claims from its certificate row", async () => {
  assert.equal(certificate.storage, "certificate_rows");
  const baseline = await ontarioIncomeTax();
  const withDependant = await ontarioIncomeTax(certificateRow({
    disabled_dependants: "0",
    dependants_under_19: "1",
  }));
  assert.equal(certificateAnswersProblem(certificate, {
    disabled_dependants: "0", dependants_under_19: "1",
  }), null);
  assert.match(certificateAnswersProblem(certificate, { dependants_under_19: "-1" }) ?? "", /whole count/);
  assert.ok(
    cmp(withDependant.incomeTax, baseline.incomeTax) < 0,
    `one eligible dependant lowers Ontario withholding (${withDependant.incomeTax} vs ${baseline.incomeTax}; factor S ${withDependant.factors.S} vs ${baseline.factors.S})`,
  );
});
